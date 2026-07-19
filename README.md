# DockGen — Docker Config Generator

**DockGen** is a self-hostable Next.js 16 web app that analyzes GitHub repositories and generates production-ready Docker configuration files.

## Features

- Analyze public and private GitHub repos via tarball API (no `git` binary required)
- Detect 15+ frameworks with monorepo support
- Generate `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env`, and `.env.example`
- Customize port, base image version, environment variables, and backing services
- Download individual files or a ZIP bundle
- Optional live **Test Build** via WebSocket + Docker Compose

## Quick start (self-hosting)

```bash
cp .env.example .env
docker compose up --build -d
```

Open http://localhost:5172

### One container, two ports

DockGen runs as a **single Docker container** with two processes inside:

| Port | Service |
|------|---------|
| `5172` | Next.js web UI |
| `5173` | WebSocket build service (Test Build) |

You do **not** need two containers. Both services start from `scripts/start.sh` in the same image.

The Test Build feature requires mounting `/var/run/docker.sock` (included in `docker-compose.yml`).

### Dokploy deployment

1. Create a **Docker Compose** app pointing at this repo
2. Set container ports: `5172` (web) and `5173` (WebSocket)
3. Copy env vars from `.env.example`
4. Ensure `docker.sock` volume is mounted for Test Build

## Local development

```bash
npm install
npm run dev
```

In another terminal, start the build service:

```bash
cd mini-services/docker-build-service
npm install
node index.js
```

## Tech stack

- Next.js 16 (App Router, `output: "standalone"`)
- TypeScript 5
- Tailwind CSS 4 + shadcn/ui
- sonner, react-syntax-highlighter, jszip, tar, socket.io

## API

- `POST /api/analyze` — clone + analyze repository
- `POST /api/generate` — apply customizations and return generated files

## License

MIT (generated configs are MIT-licensed)
