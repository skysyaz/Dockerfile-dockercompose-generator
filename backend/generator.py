import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

GITHUB_URL_PATTERN = re.compile(
    r"^https://github\.com/[\w.\-]+/[\w.\-]+(?:\.git)?/?$"
)

FRAMEWORK_FILES = {
    "django": ["manage.py"],
    "flask": ["app.py", "wsgi.py"],
    "rails": ["config.ru"],
    "laravel": ["artisan"],
    "node": ["package.json"],
    "python": ["requirements.txt", "Pipfile", "pyproject.toml"],
    "java": ["pom.xml", "build.gradle", "build.gradle.kts"],
    "ruby": ["Gemfile"],
    "php": ["composer.json"],
    "go": ["go.mod"],
    "rust": ["Cargo.toml"],
    "dotnet": [".csproj", ".sln"],
}

DOCKERFILE_TEMPLATES = {
    "node": """FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
""",
    "python": """FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "app.py"]
""",
    "django": """FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python manage.py collectstatic --noinput || true

EXPOSE 8000

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
""",
    "flask": """FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

CMD ["python", "app.py"]
""",
    "java": """FROM eclipse-temurin:17-jdk-alpine AS build

WORKDIR /app

COPY . .

RUN ./mvnw package -DskipTests || mvn package -DskipTests

FROM eclipse-temurin:17-jre-alpine

WORKDIR /app

COPY --from=build /app/target/*.jar app.jar

EXPOSE 8080

CMD ["java", "-jar", "app.jar"]
""",
    "ruby": """FROM ruby:3.3-slim

WORKDIR /app

COPY Gemfile Gemfile.lock* ./

RUN bundle install

COPY . .

EXPOSE 3000

CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
""",
    "rails": """FROM ruby:3.3-slim

WORKDIR /app

COPY Gemfile Gemfile.lock* ./

RUN bundle install

COPY . .

EXPOSE 3000

CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0"]
""",
    "php": """FROM php:8.3-apache

WORKDIR /var/www/html

COPY . .

RUN docker-php-ext-install pdo pdo_mysql

EXPOSE 80

CMD ["apache2-foreground"]
""",
    "laravel": """FROM php:8.3-cli

WORKDIR /app

COPY . .

RUN apt-get update && apt-get install -y unzip git \\
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \\
    && composer install --no-dev --optimize-autoloader

EXPOSE 8000

CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
""",
    "go": """FROM golang:1.22-alpine AS build

WORKDIR /app

COPY go.mod go.sum* ./

RUN go mod download

COPY . .

RUN go build -o /app/server .

FROM alpine:latest

WORKDIR /app

COPY --from=build /app/server .

EXPOSE 8080

CMD ["./server"]
""",
    "rust": """FROM rust:1.77-slim AS build

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./

COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=build /app/target/release/* /app/server

EXPOSE 8080

CMD ["./server"]
""",
    "dotnet": """FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build

WORKDIR /app

COPY . .

RUN dotnet restore && dotnet publish -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0

WORKDIR /app

COPY --from=build /app/publish .

EXPOSE 8080

CMD ["dotnet", "run"]
""",
}

COMPOSE_TEMPLATES = {
    "node": """services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - .:/app
    environment:
      - NODE_ENV=development
    command: npm start
""",
    "python": """services:
  app:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    command: python app.py
""",
    "django": """services:
  app:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
    depends_on:
      - db
    command: python manage.py runserver 0.0.0.0:8000

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
""",
    "flask": """services:
  app:
    build: .
    ports:
      - "5000:5000"
    volumes:
      - .:/app
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
    depends_on:
      - db
    command: python app.py

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
""",
    "java": """services:
  app:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - .:/app
    command: java -jar app.jar

  db:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: appdb
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql

volumes:
  mysql_data:
""",
    "ruby": """services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - .:/app
    command: bundle exec rails server -b 0.0.0.0
""",
    "rails": """services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - .:/app
    environment:
      - DATABASE_URL=postgres://postgres:postgres@db:5432/mydb
    depends_on:
      - db
    command: bundle exec rails server -b 0.0.0.0

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
""",
    "php": """services:
  app:
    build: .
    ports:
      - "80:80"
    volumes:
      - .:/var/www/html
""",
    "laravel": """services:
  app:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    environment:
      - DB_HOST=db
      - DB_DATABASE=laravel
      - DB_USERNAME=postgres
      - DB_PASSWORD=postgres
    depends_on:
      - db
    command: php artisan serve --host=0.0.0.0 --port=8000

  db:
    image: postgres:16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: laravel
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
""",
    "go": """services:
  app:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - .:/app
""",
    "rust": """services:
  app:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - .:/app
""",
    "dotnet": """services:
  app:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - .:/app
""",
}

DEFAULT_DOCKERFILE = """FROM alpine:latest

WORKDIR /app

COPY . .

EXPOSE 80

CMD ["./start.sh"]
"""

DEFAULT_COMPOSE = """services:
  app:
    build: .
    ports:
      - "80:80"
    volumes:
      - .:/app
    command: ./start.sh
"""


class DockerConfigGenerator:
    def __init__(self, repo_url: str, work_dir: str | None = None):
        if not GITHUB_URL_PATTERN.match(repo_url.rstrip("/")):
            raise ValueError("Please provide a valid GitHub repository URL")
        self.repo_url = repo_url.rstrip("/")
        if self.repo_url.endswith(".git"):
            self.repo_url = self.repo_url[:-4]
        self.repo_name = self._get_repo_name()
        self.work_dir = work_dir or tempfile.mkdtemp(prefix="docker-gen-")
        self.repo_dir = os.path.join(self.work_dir, self.repo_name)

    def _get_repo_name(self) -> str:
        parsed_url = urlparse(self.repo_url)
        path_parts = parsed_url.path.strip("/").split("/")
        if len(path_parts) >= 2:
            return path_parts[1]
        return "repo"

    def clone_repository(self) -> None:
        result = subprocess.run(
            ["git", "clone", "--depth", "1", self.repo_url, self.repo_dir],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to clone repository: {result.stderr.strip()}")

    def detect_framework(self) -> str | None:
        for framework, files in FRAMEWORK_FILES.items():
            for file in files:
                if framework == "dotnet":
                    if any(Path(self.repo_dir).rglob(f"*{file}")):
                        return framework
                elif os.path.exists(os.path.join(self.repo_dir, file)):
                    if framework == "python" and os.path.exists(
                        os.path.join(self.repo_dir, "manage.py")
                    ):
                        return "django"
                    if framework == "python" and os.path.exists(
                        os.path.join(self.repo_dir, "app.py")
                    ):
                        return "flask"
                    if framework == "ruby" and os.path.exists(
                        os.path.join(self.repo_dir, "config.ru")
                    ):
                        return "rails"
                    if framework == "php" and os.path.exists(
                        os.path.join(self.repo_dir, "artisan")
                    ):
                        return "laravel"
                    return framework
        return None

    def generate_dockerfile(self, framework: str | None = None) -> str:
        framework = framework or self.detect_framework()
        content = DOCKERFILE_TEMPLATES.get(framework, DEFAULT_DOCKERFILE)
        return content

    def generate_docker_compose(self, framework: str | None = None) -> str:
        framework = framework or self.detect_framework()
        return COMPOSE_TEMPLATES.get(framework, DEFAULT_COMPOSE)

    def generate(self) -> dict:
        self.clone_repository()
        framework = self.detect_framework()
        dockerfile = self.generate_dockerfile(framework)
        compose = self.generate_docker_compose(framework)
        return {
            "framework": framework or "unknown",
            "repo_name": self.repo_name,
            "dockerfile": dockerfile,
            "docker_compose": compose,
        }

    def cleanup(self) -> None:
        if os.path.exists(self.work_dir):
            shutil.rmtree(self.work_dir, ignore_errors=True)
