from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from generator import DockerConfigGenerator, GITHUB_URL_PATTERN

STATIC_DIR = Path(__file__).parent / "static"


class GenerateRequest(BaseModel):
    repo_url: str = Field(..., description="GitHub repository URL")

    @field_validator("repo_url")
    @classmethod
    def validate_repo_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        if not GITHUB_URL_PATTERN.match(normalized):
            raise ValueError("Please enter a valid GitHub repository URL")
        return normalized


class GenerateResponse(BaseModel):
    framework: str
    repo_name: str
    dockerfile: str
    docker_compose: str


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(
    title="Docker Configuration Generator",
    description="Analyze GitHub repositories and generate Docker configuration files.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.post("/api/generate", response_model=GenerateResponse)
async def generate_config(request: GenerateRequest):
    generator = DockerConfigGenerator(request.repo_url)
    try:
        result = generator.generate()
        return GenerateResponse(**result)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"An unexpected error occurred: {exc}",
        ) from exc
    finally:
        generator.cleanup()


@app.get("/api/frameworks")
async def list_frameworks():
    return {
        "frameworks": [
            "node",
            "python",
            "django",
            "flask",
            "java",
            "ruby",
            "rails",
            "php",
            "laravel",
            "go",
            "rust",
            "dotnet",
        ]
    }


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        requested = STATIC_DIR / full_path
        if requested.is_file():
            return FileResponse(requested)

        index_file = STATIC_DIR / "index.html"
        if index_file.exists():
            return FileResponse(index_file)

        raise HTTPException(status_code=404, detail="Frontend not built")
