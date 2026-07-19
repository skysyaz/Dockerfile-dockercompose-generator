# Docker Configuration Generator

A web application that analyzes GitHub repositories and generates tailored `Dockerfile` and `docker-compose.yml` files based on the detected language and framework.

## Features

- **Repository analysis** — clones a public GitHub repository and inspects manifest files
- **Framework detection** — supports Node.js, Python, Django, Flask, Java, Ruby, Rails, PHP, Laravel, Go, Rust, and .NET
- **Dockerfile generation** — creates stack-specific build and run instructions
- **Docker Compose generation** — adds ports, volumes, environment variables, and database services when needed
- **Download support** — preview and download generated files from the browser

## Quick start

### Run with Docker (recommended)

```bash
cp .env.example .env
docker compose up --build -d
```

Open [http://localhost:5173](http://localhost:5173).

### Deploy on Dokploy

1. Create a new **Docker Compose** application in Dokploy.
2. Point it at this repository (or upload the project).
3. Set the compose file to `docker-compose.yml`.
4. Add environment variables from `.env.example`:
   - `PORT=5173`
   - `PYTHONUNBUFFERED=1`
5. In Dokploy, set the **container port** to `5173`.
6. Deploy the service.

The app runs as a single container: the React frontend is built into the image and served by FastAPI on port `5173`.

### Run locally for development

**Backend**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server proxies API requests to port 8000.

## API

### `POST /api/generate`

Request body:

```json
{
  "repo_url": "https://github.com/username/repository"
}
```

Response:

```json
{
  "framework": "node",
  "repo_name": "repository",
  "dockerfile": "...",
  "docker_compose": "..."
}
```

### `GET /api/health`

Health check endpoint.

### `GET /api/frameworks`

Returns the list of supported frameworks.

## Testing

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

## Project structure

```
.
├── backend/
│   ├── generator.py      # Core analysis and generation logic
│   ├── main.py           # FastAPI application
│   └── tests/
├── frontend/
│   └── src/              # React UI
├── Dockerfile
└── docker-compose.yml
```

## Notes

- Only public `https://github.com/...` URLs are accepted.
- Repositories are cloned into a temporary directory and removed after processing.
- Generated files are starting points — review and adjust them for your production needs.

## License

MIT
