import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs/promises";
import * as path from "path";
import * as tar from "tar";
import type {
  AnalysisResult,
  Customizations,
  DetectedService,
  Framework,
  GeneratedFiles,
  Language,
} from "./types";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "bin",
  "obj",
  ".nuxt",
  ".cache",
  "coverage",
]);

const BACKEND_MARKERS = [
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "manage.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "artisan",
];

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  dir: string;
  analysis: AnalysisResult;
  expiresAt: number;
}

const cloneCache = new Map<string, CacheEntry>();

function cacheKey(repoUrl: string, token?: string): string {
  return `${repoUrl}::${token ?? ""}`;
}

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/, "").replace(/\/$/, "");
  if (!repo) return null;
  return { owner: m[1], repo };
}

export function redactSecrets(message: string): string {
  return message.replace(/(https?:\/\/)[^@]+@/g, "$1");
}

export function classifyCloneError(
  rawMessage: string,
): { status: 404 | 401 | 504 | 429; message: string } | null {
  const message = redactSecrets(rawMessage);
  if (
    /fatal: repository ['"].*['"] does not exist|Repository not found/i.test(message)
  ) {
    return {
      status: 404,
      message:
        "Repository not found. Check the URL, or if it is private, provide a GitHub personal access token with repo scope.",
    };
  }
  if (
    /could not read Username|could not read Password|Authentication failed|Permission denied|requires authentication/i.test(
      message,
    )
  ) {
    return {
      status: 401,
      message:
        "Could not access the repository. If it is private, provide a valid GitHub personal access token with repo scope.",
    };
  }
  if (/rate limit/i.test(message)) {
    return { status: 429, message };
  }
  if (
    /timed out|timeout|ETIMEDOUT|early EOF|RPC failed|fetch-pack: unexpected disconnect|aborted/i.test(
      message,
    )
  ) {
    return {
      status: 504,
      message:
        "Cloning timed out or was interrupted. The repository may be too large — try again or use a smaller repo.",
    };
  }
  return null;
}

export async function cloneRepo(
  repoUrl: string,
  dest: string,
  githubToken?: string,
): Promise<void> {
  const parsed = parseGithubUrl(repoUrl);
  if (!parsed) throw new Error("Invalid GitHub repository URL");
  const { owner, repo } = parsed;
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball`;
  const headers: Record<string, string> = {
    "User-Agent": "DockGen/1.0",
    Accept: "application/vnd.github+json",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(tarballUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`fatal: repository '${owner}/${repo}' does not exist`);
      }
      if (res.status === 401 || res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        if (remaining === "0" && reset) {
          const mins = Math.max(
            1,
            Math.ceil((parseInt(reset, 10) * 1000 - Date.now()) / 60_000),
          );
          throw new Error(
            `GitHub API rate limit exceeded. Try again in ${mins} minute(s), or provide a GitHub token to increase your limit.`,
          );
        }
        throw new Error(
          `fatal: Authentication failed for https://github.com/${owner}/${repo}. If the repo is private, provide a valid GitHub token with repo scope.`,
        );
      }
      throw new Error(`GitHub API returned ${res.status}`);
    }
    await fs.mkdir(dest, { recursive: true });
    const nodeStream = Readable.fromWeb(res.body as never);
    await pipeline(nodeStream, createGunzip(), tar.x({ cwd: dest, strip: 1 }));
  } finally {
    clearTimeout(timer);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function findBackendSubdir(root: string, depth = 0): Promise<string> {
  if (depth > 3) return "";
  const hasRootPackage = await fileExists(path.join(root, "package.json"));
  const hasRootBackend = await hasBackendMarkers(root);
  if (hasRootPackage && !hasRootBackend) {
    const sub = await findBackendInChildren(root, depth);
    if (sub) return sub;
  }
  return "";
}

async function hasBackendMarkers(dir: string): Promise<boolean> {
  for (const marker of BACKEND_MARKERS) {
    if (marker.endsWith(".csproj")) {
      const files = await globFiles(dir, "*.csproj", 0);
      if (files.length) return true;
    } else if (await fileExists(path.join(dir, marker))) {
      return true;
    }
  }
  return false;
}

async function findBackendInChildren(
  root: string,
  depth: number,
): Promise<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const subPath = path.join(root, entry.name);
    if (await hasBackendMarkers(subPath)) {
      return entry.name;
    }
    const nested = await findBackendInChildren(subPath, depth + 1);
    if (nested) return path.join(entry.name, nested);
  }
  return "";
}

async function globFiles(
  dir: string,
  pattern: string,
  depth: number,
): Promise<string[]> {
  if (depth > 3) return [];
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (pattern === "*.csproj" && entry.name.endsWith(".csproj")) {
        results.push(full);
      }
    } else if (entry.isDirectory()) {
      results.push(...(await globFiles(full, pattern, depth + 1)));
    }
  }
  return results;
}

function detectPackageManager(root: string, files: string[]): string {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("Pipfile")) return "pipenv";
  if (files.includes("pyproject.toml")) return "pip";
  if (files.includes("requirements.txt")) return "pip";
  if (files.includes("pom.xml")) return "maven";
  if (files.includes("build.gradle") || files.includes("build.gradle.kts"))
    return "gradle";
  if (files.includes("Cargo.toml")) return "cargo";
  if (files.includes("Gemfile")) return "bundler";
  if (files.includes("composer.json")) return "composer";
  if (files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln")))
    return "nuget";
  if (files.includes("go.mod")) return "go-modules";
  if (files.includes("package.json")) return "npm";
  return "unknown";
}

async function listRootFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries;
}

async function readDependencies(
  workDir: string,
  framework: Framework,
): Promise<string[]> {
  const deps: string[] = [];
  const addFromText = (text: string) => {
    deps.push(
      ...text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
  };

  const req = await readText(path.join(workDir, "requirements.txt"));
  if (req) addFromText(req);

  const pkg = await readText(path.join(workDir, "package.json"));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      deps.push(...Object.keys(parsed.dependencies ?? {}));
      deps.push(...Object.keys(parsed.devDependencies ?? {}));
    } catch {
      /* ignore */
    }
  }

  const gem = await readText(path.join(workDir, "Gemfile"));
  if (gem) addFromText(gem);

  const composer = await readText(path.join(workDir, "composer.json"));
  if (composer) {
    try {
      const parsed = JSON.parse(composer) as {
        require?: Record<string, string>;
      };
      deps.push(...Object.keys(parsed.require ?? {}));
    } catch {
      /* ignore */
    }
  }

  const pom = await readText(path.join(workDir, "pom.xml"));
  if (pom) {
    const matches = pom.match(/<artifactId>([^<]+)<\/artifactId>/g) ?? [];
    deps.push(...matches.map((m) => m.replace(/<\/?artifactId>/g, "")));
  }

  const gradle = await readText(path.join(workDir, "build.gradle"));
  if (gradle) addFromText(gradle);

  const gomod = await readText(path.join(workDir, "go.mod"));
  if (gomod) addFromText(gomod);

  const cargo = await readText(path.join(workDir, "Cargo.toml"));
  if (cargo) addFromText(cargo);

  if (framework === "dotnet") {
    const csprojs = await globFiles(workDir, "*.csproj", 0);
    for (const csproj of csprojs) {
      addFromText(await readText(csproj));
    }
  }

  return deps.slice(0, 100);
}

function detectServices(deps: string[]): DetectedService[] {
  const joined = deps.join(" ").toLowerCase();
  const services: DetectedService[] = [];

  if (
    /\bpg\b|prisma|typeorm|psycopg2|asyncpg|pgx|\bpq\b|diesel|sqlx|npgsql|pdo_pgsql/.test(
      joined,
    )
  ) {
    services.push({
      name: "postgres",
      image: "postgres:16-alpine",
      env: {
        POSTGRES_USER: "app",
        POSTGRES_PASSWORD: "app",
        POSTGRES_DB: "app",
      },
      ports: ["5432:5432"],
      volumes: ["postgres_data:/var/lib/postgresql/data"],
    });
  }

  if (
    /mysql2|pymysql|mysqlclient|mysql-connector|pomelo\.entityframeworkcore|pdo_mysql/.test(
      joined,
    )
  ) {
    services.push({
      name: "mysql",
      image: "mysql:8.0",
      env: {
        MYSQL_ROOT_PASSWORD: "root",
        MYSQL_DATABASE: "app",
        MYSQL_USER: "app",
        MYSQL_PASSWORD: "app",
      },
      ports: ["3306:3306"],
      volumes: ["mysql_data:/var/lib/mysql"],
    });
  }

  if (
    /mongoose|pymongo|motor|mongo-go-driver|mongoid|mongodb\.driver/.test(joined)
  ) {
    services.push({
      name: "mongodb",
      image: "mongo:7",
      env: {
        MONGO_INITDB_ROOT_USERNAME: "app",
        MONGO_INITDB_ROOT_PASSWORD: "app",
      },
      ports: ["27017:27017"],
      volumes: ["mongo_data:/data/db"],
    });
  }

  if (
    /\bredis\b|ioredis|go-redis|redigo|stackexchange\.redis|predis/.test(joined)
  ) {
    services.push({
      name: "redis",
      image: "redis:7-alpine",
      ports: ["6379:6379"],
      volumes: ["redis_data:/data"],
    });
  }

  return services;
}

async function detectFramework(
  workDir: string,
): Promise<{
  framework: Framework;
  language: Language;
  port: number;
  entrypoint: string;
  buildTool: string;
  notes: string[];
}> {
  const notes: string[] = [];
  const files = await listRootFiles(workDir);

  const has = (f: string) => files.includes(f);
  const read = (f: string) => readText(path.join(workDir, f));

  if (has("manage.py")) {
    return {
      framework: "django",
      language: "python",
      port: 8000,
      entrypoint: "manage.py",
      buildTool: "pip",
      notes,
    };
  }

  if (has("artisan")) {
    return {
      framework: "laravel",
      language: "php",
      port: 8000,
      entrypoint: "artisan",
      buildTool: "composer",
      notes,
    };
  }

  if (has("config.ru")) {
    const gem = await read("Gemfile");
    if (/rails/i.test(gem)) {
      return {
        framework: "rails",
        language: "ruby",
        port: 3000,
        entrypoint: "config.ru",
        buildTool: "bundler",
        notes,
      };
    }
    if (/sinatra/i.test(gem)) {
      return {
        framework: "sinatra",
        language: "ruby",
        port: 4567,
        entrypoint: "config.ru",
        buildTool: "bundler",
        notes,
      };
    }
  }

  if (has("pom.xml")) {
    const pom = await read("pom.xml");
    const isSpring = /spring-boot-starter/i.test(pom);
    return {
      framework: isSpring ? "spring-boot" : "java-maven",
      language: "java",
      port: 8080,
      entrypoint: "pom.xml",
      buildTool: "maven",
      notes,
    };
  }

  if (has("build.gradle") || has("build.gradle.kts")) {
    const gradle = await read(has("build.gradle") ? "build.gradle" : "build.gradle.kts");
    const isSpring = /spring-boot|org\.springframework/i.test(gradle);
    return {
      framework: isSpring ? "spring-boot" : "java-gradle",
      language: "java",
      port: 8080,
      entrypoint: "build.gradle",
      buildTool: "gradle",
      notes,
    };
  }

  if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) {
    const req =
      (await read("requirements.txt")) +
      (await read("pyproject.toml")) +
      (await read("Pipfile"));
    if (/fastapi/i.test(req)) {
      return {
        framework: "fastapi",
        language: "python",
        port: 8000,
        entrypoint: "main:app",
        buildTool: "pip",
        notes,
      };
    }
    if (/flask/i.test(req)) {
      return {
        framework: "flask",
        language: "python",
        port: 5000,
        entrypoint: "app:app",
        buildTool: "pip",
        notes,
      };
    }
    return {
      framework: "python",
      language: "python",
      port: 8000,
      entrypoint: "app.py",
      buildTool: "pip",
      notes,
    };
  }

  if (has("go.mod")) {
    return {
      framework: "go",
      language: "go",
      port: 8080,
      entrypoint: "main.go",
      buildTool: "go-modules",
      notes,
    };
  }

  if (has("Cargo.toml")) {
    return {
      framework: "rust",
      language: "rust",
      port: 8080,
      entrypoint: "src/main.rs",
      buildTool: "cargo",
      notes,
    };
  }

  if (has("Gemfile")) {
    return {
      framework: "ruby",
      language: "ruby",
      port: 4567,
      entrypoint: "app.rb",
      buildTool: "bundler",
      notes,
    };
  }

  if (has("composer.json")) {
    const composer = await read("composer.json");
    if (/laravel\/framework/i.test(composer)) {
      return {
        framework: "laravel",
        language: "php",
        port: 8000,
        entrypoint: "artisan",
        buildTool: "composer",
        notes,
      };
    }
    if (/symfony/i.test(composer)) {
      return {
        framework: "symfony",
        language: "php",
        port: 8000,
        entrypoint: "public/index.php",
        buildTool: "composer",
        notes,
      };
    }
    return {
      framework: "php",
      language: "php",
      port: 8000,
      entrypoint: "index.php",
      buildTool: "composer",
      notes,
    };
  }

  const csprojs = await globFiles(workDir, "*.csproj", 0);
  if (csprojs.length || has(".sln") || files.some((f) => f.endsWith(".sln"))) {
    return {
      framework: "dotnet",
      language: "csharp",
      port: 8080,
      entrypoint: "Program.cs",
      buildTool: "nuget",
      notes,
    };
  }

  if (has("package.json") && !(await hasBackendMarkers(workDir))) {
    const pkg = await read("package.json");
    let parsed: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = {};
    try {
      parsed = JSON.parse(pkg);
    } catch {
      /* ignore */
    }
    const allDeps = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
    };
    const depNames = Object.keys(allDeps).join(" ").toLowerCase();

    if (allDeps.next) {
      notes.push("Detected Next.js — using standalone multi-stage Dockerfile.");
      return {
        framework: "nextjs",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "server.js",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps["@nestjs/core"]) {
      return {
        framework: "nestjs",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "main.ts",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps.express) {
      return {
        framework: "express",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "index.js",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps.vite) {
      return {
        framework: "vite",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 4173,
        entrypoint: "index.html",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps.react) {
      return {
        framework: "react",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "src/index.tsx",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps.vue) {
      return {
        framework: "vue",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "src/main.ts",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    if (allDeps["@angular/core"]) {
      return {
        framework: "angular",
        language: "typescript",
        port: 4200,
        entrypoint: "src/main.ts",
        buildTool: detectPackageManager(workDir, files),
        notes,
      };
    }
    return {
      framework: "nodejs",
      language: depNames.includes("typescript") ? "typescript" : "javascript",
      port: 3000,
      entrypoint: "index.js",
      buildTool: detectPackageManager(workDir, files),
      notes,
    };
  }

  notes.push("Could not confidently detect framework — using generic fallback.");
  return {
    framework: "unknown",
    language: "unknown",
    port: 80,
    entrypoint: "start.sh",
    buildTool: "unknown",
    notes,
  };
}

export async function analyzeDirectory(
  repoUrl: string,
  cloneDir: string,
): Promise<AnalysisResult> {
  const parsed = parseGithubUrl(repoUrl);
  const repoName = parsed?.repo ?? "app";
  const backendSubdir = await findBackendSubdir(cloneDir);
  const workDir = backendSubdir
    ? path.join(cloneDir, backendSubdir)
    : cloneDir;

  const detection = await detectFramework(workDir);
  const rootFiles = await listRootFiles(workDir);
  const packageManager = detectPackageManager(workDir, rootFiles);
  const dependencies = await readDependencies(workDir, detection.framework);
  const services = detectServices(dependencies);

  if (backendSubdir) {
    detection.notes.push(`Monorepo detected — using subdirectory: ${backendSubdir}`);
  }

  return {
    repoUrl,
    repoName,
    language: detection.language,
    framework: detection.framework,
    packageManager,
    buildTool: detection.buildTool,
    entrypoint: detection.entrypoint,
    port: detection.port,
    services,
    dependencies,
    notes: detection.notes,
    backendSubdir,
  };
}

function getBaseImage(
  framework: Framework,
  language: Language,
  version?: string,
): Record<string, string> {
  return {
    node: `node:${version || "20-alpine"}`,
    python: `python:${version || "3.12-slim"}`,
    maven: `maven:${version || "3.9-eclipse-temurin-17"}`,
    gradle: `gradle:${version || "8-jdk17"}`,
    go: `golang:${version || "1.22-alpine"}`,
    rust: `rust:${version || "1.80-slim"}`,
    ruby: `ruby:${version || "3.3-slim"}`,
    php: `php:${version || "8.3-fpm-alpine"}`,
    dotnetSdk: `mcr.microsoft.com/dotnet/sdk:${version || "8.0"}`,
    dotnetAsp: `mcr.microsoft.com/dotnet/aspnet:${version || "8.0"}`,
    jre: `eclipse-temurin:17-jre-alpine`,
  };
}

function installCmd(pm: string): string {
  switch (pm) {
    case "pnpm":
      return "RUN npm i -g pnpm && pnpm install --frozen-lockfile";
    case "yarn":
      return "RUN yarn install --frozen-lockfile";
    case "bun":
      return "RUN npm i -g bun && bun install --frozen-lockfile";
    default:
      return "RUN npm ci";
  }
}

function buildCmd(pm: string): string {
  switch (pm) {
    case "pnpm":
      return "RUN pnpm run build";
    case "yarn":
      return "RUN yarn build";
    case "bun":
      return "RUN bun run build";
    default:
      return "RUN npm run build";
  }

}

export function generateDockerfile(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string {
  const v = customizations.baseImageVersion;
  const images = getBaseImage(analysis.framework, analysis.language, v);
  const repo = analysis.repoName;

  switch (analysis.framework) {
    case "nextjs":
      return `# Stage 1: Dependencies
FROM ${images.node} AS deps
WORKDIR /app
COPY package*.json pnpm-lock.yaml yarn.lock bun.lock* ./
${installCmd(analysis.packageManager)}

# Stage 2: Build
FROM ${images.node} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${buildCmd(analysis.packageManager)}

# Stage 3: Runner
FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE ${customizations.port ?? analysis.port}
ENV PORT=${customizations.port ?? analysis.port}
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
`;
    case "django":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
RUN python manage.py collectstatic --noinput || true
EXPOSE ${customizations.port ?? analysis.port}
CMD ["gunicorn", "--bind", "0.0.0.0:${customizations.port ?? analysis.port}", "${repo}.wsgi:application"]
`;
    case "fastapi":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${customizations.port ?? analysis.port}"]
`;
    case "flask":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["gunicorn", "--bind", "0.0.0.0:${customizations.port ?? analysis.port}", "app:app"]
`;
    case "python":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["python", "app.py"]
`;
    case "spring-boot":
    case "java-gradle":
      return `FROM ${images.gradle} AS builder
WORKDIR /app
COPY build.gradle* settings.gradle* ./
COPY gradle ./gradle
COPY gradlew gradlew.bat ./
RUN gradle dependencies --no-daemon || true
COPY . .
RUN gradle bootJar --no-daemon -x test || gradle jar --no-daemon -x test
FROM ${images.jre}
WORKDIR /app
COPY --from=builder /app/build/libs/*.jar app.jar
EXPOSE ${customizations.port ?? analysis.port}
CMD ["java", "-jar", "app.jar"]
`;
    case "java-maven":
      return `FROM ${images.maven} AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -DskipTests -B
FROM ${images.jre}
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE ${customizations.port ?? analysis.port}
CMD ["java", "-jar", "app.jar"]
`;
    case "go":
      return `FROM ${images.go} AS builder
WORKDIR /app
RUN apk add --no-cache git
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o app -a -ldflags '-extldflags "-static"' .
FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/app .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./app"]
`;
    case "rust":
      return `FROM ${images.rust} AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release || true
COPY . .
RUN cargo build --release
FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/${repo} app
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./app"]
`;
    case "rails":
      return `FROM ${images.ruby}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev nodejs && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
RUN bundle exec rake assets:precompile || true
EXPOSE ${customizations.port ?? analysis.port}
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "${customizations.port ?? analysis.port}"]
`;
    case "laravel":
      return `FROM ${images.php}
WORKDIR /var/www
RUN apk add --no-cache \\
    postgresql-dev libpng-dev libzip-dev zip unzip \\
    && docker-php-ext-install pdo pdo_pgsql gd zip
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock* ./
RUN composer install --no-dev --optimize-autoloader --no-scripts
COPY . .
RUN chown -R www-data:www-data /var/www
EXPOSE ${customizations.port ?? analysis.port}
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=${customizations.port ?? analysis.port}"]
`;
    case "dotnet":
      return `FROM ${images.dotnetSdk} AS builder
WORKDIR /app
COPY *.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o out
FROM ${images.dotnetAsp}
WORKDIR /app
COPY --from=builder /app/out .
ENV ASPNETCORE_URLS=http://+:${customizations.port ?? analysis.port}
EXPOSE ${customizations.port ?? analysis.port}
ENTRYPOINT ["dotnet", "${repo}.dll"]
`;
    case "express":
    case "nestjs":
    case "nodejs":
    case "react":
    case "vue":
    case "vite":
    case "angular":
      return `FROM ${images.node} AS deps
WORKDIR /app
COPY package*.json pnpm-lock.yaml yarn.lock bun.lock* ./
${installCmd(analysis.packageManager)}

FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["npm", "start"]
`;
    default:
      return `FROM alpine:latest
WORKDIR /app
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./start.sh"]
`;
  }
}

const ENV_FRAMEWORKS = new Set([
  "nextjs",
  "express",
  "nestjs",
  "nodejs",
  "django",
  "fastapi",
  "flask",
  "python",
  "rails",
  "laravel",
  "spring-boot",
  "dotnet",
]);

export function generateDockerCompose(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string {
  const port = customizations.port ?? analysis.port;
  const enabled = new Set(
    customizations.enabledServices ??
      analysis.services.map((s) => s.name),
  );
  const activeServices = analysis.services.filter((s) =>
    enabled.has(s.name),
  );
  const repo = analysis.repoName;

  let yaml = `services:\n  app:\n    build: .\n    container_name: ${repo}-app\n    ports:\n      - "${port}:${port}"\n    restart: unless-stopped\n`;

  if (ENV_FRAMEWORKS.has(analysis.framework)) {
    yaml += `    env_file:\n      - .env\n`;
  }

  if (customizations.extraEnv && Object.keys(customizations.extraEnv).length) {
    yaml += `    environment:\n`;
    for (const [key, value] of Object.entries(customizations.extraEnv)) {
      yaml += `      ${key}: "${value}"\n`;
    }
  }

  if (activeServices.length) {
    yaml += `    depends_on:\n`;
    for (const svc of activeServices) {
      yaml += `      - ${svc.name}\n`;
    }
  }

  for (const svc of activeServices) {
    yaml += `\n  ${svc.name}:\n    image: ${svc.image}\n    container_name: ${repo}-${svc.name}\n    restart: unless-stopped\n`;
    if (svc.env) {
      yaml += `    environment:\n`;
      for (const [key, value] of Object.entries(svc.env)) {
        yaml += `      ${key}: ${value}\n`;
      }
    }
    if (svc.ports?.length) {
      yaml += `    ports:\n`;
      for (const p of svc.ports) {
        yaml += `      - "${p}"\n`;
      }
    }
    if (svc.volumes?.length) {
      yaml += `    volumes:\n`;
      for (const vol of svc.volumes) {
        yaml += `      - ${vol}\n`;
      }
    }
  }

  const volumeNames = activeServices
    .flatMap((s) => s.volumes ?? [])
    .map((v) => v.split(":")[0])
    .filter(Boolean);

  if (volumeNames.length) {
    yaml += `\nvolumes:\n`;
    for (const vol of volumeNames) {
      yaml += `  ${vol}:\n`;
    }
  }

  return yaml;
}

export function generateDockerignore(analysis: AnalysisResult): string {
  const common = `node_modules
npm-debug.log
.git
.gitignore
.env
.env.local
.env.*.local
dist
build
target
__pycache__
*.pyc
.venv
venv
env
.next
.nuxt
.cache
coverage
.vscode
.idea
*.md
Dockerfile
docker-compose.yml
.dockerignore
LICENSE
`;

  if (analysis.framework === "rust") {
    return `${common}target
Cargo.lock
`;
  }
  if (analysis.language === "java") {
    return `${common}target
*.class
`;
  }
  if (analysis.language === "go") {
    return `${common}*.exe
*.exe~
`;
  }
  return common;
}

function envSections(
  analysis: AnalysisResult,
  enabledServices: DetectedService[],
  extraEnv?: Record<string, string>,
  withComments = true,
): string {
  const lines: string[] = [];
  const push = (line: string) => lines.push(line);

  if (withComments) {
    push("# Copy this file to .env and adjust values for your environment.");
    push("# Lines beginning with # are comments. Do NOT commit the real .env file.");
    push("");
  }

  if (enabledServices.some((s) => s.name === "postgres")) {
    push("# PostgreSQL");
    push("DATABASE_URL=postgresql://app:app@postgres:5432/app");
    push("POSTGRES_USER=app");
    push("POSTGRES_PASSWORD=app");
    push("POSTGRES_DB=app");
    push("");
  }

  if (enabledServices.some((s) => s.name === "mysql")) {
    push("# MySQL");
    push("DATABASE_URL=mysql://app:app@mysql:3306/app");
    push("MYSQL_ROOT_PASSWORD=root");
    push("MYSQL_DATABASE=app");
    push("");
  }

  if (enabledServices.some((s) => s.name === "redis")) {
    push("# Redis");
    push("REDIS_URL=redis://redis:6379");
    push("");
  }

  if (enabledServices.some((s) => s.name === "mongodb")) {
    push("# MongoDB");
    push("MONGO_URL=mongodb://app:app@mongodb:27017/app");
    push("MONGO_INITDB_ROOT_USERNAME=app");
    push("MONGO_INITDB_ROOT_PASSWORD=app");
    push("");
  }

  switch (analysis.framework) {
    case "nextjs":
    case "nodejs":
    case "express":
    case "nestjs":
      push("# Node.js");
      push("NODE_ENV=production");
      push(`PORT=${analysis.port}`);
      push("");
      break;
    case "django":
      push("# Django");
      push(`DJANGO_SETTINGS_MODULE=${analysis.repoName}.settings`);
      push("DJANGO_DEBUG=False");
      push("DJANGO_SECRET_KEY=change-me-please");
      push("");
      break;
    case "flask":
    case "fastapi":
      push("# Python app");
      push("APP_ENV=production");
      push(`PORT=${analysis.port}`);
      push("");
      break;
    case "rails":
      push("# Rails");
      push("RAILS_ENV=production");
      push("RAILS_LOG_TO_STDOUT=true");
      push("RAILS_SERVE_STATIC_FILES=true");
      push("RAILS_MASTER_KEY=change-me-please");
      push("");
      break;
    case "laravel":
      push("# Laravel");
      push("APP_ENV=production");
      push("APP_KEY=base64:change-me-please");
      push("APP_DEBUG=false");
      push("APP_URL=http://localhost:8000");
      push("");
      break;
    case "spring-boot":
      push("# Spring Boot");
      push("SPRING_PROFILES_ACTIVE=production");
      push(`SERVER_PORT=${analysis.port}`);
      push("");
      break;
    case "dotnet":
      push("# .NET");
      push("ASPNETCORE_ENVIRONMENT=Production");
      push(`ASPNETCORE_URLS=http://+:${analysis.port}`);
      push("");
      break;
  }

  if (extraEnv && Object.keys(extraEnv).length) {
    push("# Custom environment variables");
    for (const [key, value] of Object.entries(extraEnv)) {
      push(`${key}=${value}`);
    }
    push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function generateEnvExample(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string | null {
  if (!ENV_FRAMEWORKS.has(analysis.framework) && !analysis.services.length) {
    return null;
  }
  const enabled = new Set(
    customizations.enabledServices ??
      analysis.services.map((s) => s.name),
  );
  const activeServices = analysis.services.filter((s) =>
    enabled.has(s.name),
  );
  return envSections(analysis, activeServices, customizations.extraEnv, true);
}

export function generateEnv(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string | null {
  const example = generateEnvExample(analysis, customizations);
  if (!example) return null;
  return envSections(
    analysis,
    analysis.services.filter((s) =>
      (customizations.enabledServices ?? analysis.services.map((x) => x.name)).includes(
        s.name,
      ),
    ),
    customizations.extraEnv,
    false,
  );
}

export function generateAllFiles(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): GeneratedFiles {
  const envExample = generateEnvExample(analysis, customizations);
  const env = generateEnv(analysis, customizations);
  const files: GeneratedFiles = {
    Dockerfile: generateDockerfile(analysis, customizations),
    "docker-compose.yml": generateDockerCompose(analysis, customizations),
    ".dockerignore": generateDockerignore(analysis),
    ".env.example": envExample ?? "",
  };
  if (env) files[".env"] = env;
  return files;
}

async function cleanupExpiredCache(): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of cloneCache.entries()) {
    if (entry.expiresAt <= now) {
      await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
      cloneCache.delete(key);
    }
  }
}

export async function cloneAndAnalyze(
  repoUrl: string,
  githubToken?: string,
): Promise<{ dir: string; analysis: AnalysisResult }> {
  await cleanupExpiredCache();
  const key = cacheKey(repoUrl, githubToken);
  const cached = cloneCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { dir: cached.dir, analysis: cached.analysis };
  }

  const os = await import("os");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-"));
  try {
    await cloneRepo(repoUrl, tempDir, githubToken);
    const analysis = await analyzeDirectory(repoUrl, tempDir);
    cloneCache.set(key, {
      dir: tempDir,
      analysis,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { dir: tempDir, analysis };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function getCachedAnalysis(
  repoUrl: string,
  githubToken?: string,
): AnalysisResult | null {
  const entry = cloneCache.get(cacheKey(repoUrl, githubToken));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.analysis;
}

export async function invalidateCloneCache(): Promise<void> {
  for (const [, entry] of cloneCache.entries()) {
    await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
  }
  cloneCache.clear();
}

export function generateFromCache(
  repoUrl: string,
  githubToken: string | undefined,
  customizations: Customizations,
): { analysis: AnalysisResult; files: GeneratedFiles } | null {
  const analysis = getCachedAnalysis(repoUrl, githubToken);
  if (!analysis) return null;
  return {
    analysis,
    files: generateAllFiles(analysis, customizations),
  };
}
