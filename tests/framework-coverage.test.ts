import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  analyzeDirectory,
  generateDockerCompose,
  generateDockerfile,
} from "../src/lib/analyzer.ts";
import { parseRepoUrl } from "../src/lib/repo-url.ts";
import type { AnalysisResult } from "../src/lib/types.ts";

async function withFixture(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-fw-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const base: AnalysisResult = {
  repoUrl: "https://github.com/user/app",
  repoName: "app",
  repoProvider: "github",
  language: "unknown",
  framework: "unknown",
  packageManager: "unknown",
  buildTool: "unknown",
  entrypoint: "",
  port: 3000,
  services: [],
  dependencies: [],
  notes: [],
  backendSubdir: "",
  dotnetProject: "",
  dotnetSolution: "",
  dotnetSdkVersion: "",
  envVars: [],
  rootFiles: [],
  existingFiles: [],
};

describe("python package manager handling", () => {
  it("uses poetry install for poetry projects instead of requirements.txt", async () => {
    await withFixture(
      {
        "pyproject.toml": '[tool.poetry]\nname = "api"\n[tool.poetry.dependencies]\nfastapi = "^0.110"\n',
        "poetry.lock": "# lock\n",
        "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/api", dir);
        assert.equal(analysis.framework, "fastapi");
        assert.equal(analysis.pythonManager, "poetry");
        assert.equal(analysis.wsgiModule, "main:app");
        const dockerfile = generateDockerfile(analysis, {});
        assert.match(dockerfile, /poetry install/);
        assert.doesNotMatch(dockerfile, /COPY requirements\.txt/);
        assert.match(dockerfile, /uvicorn", "main:app/);
      },
    );
  });

  it("detects nested FastAPI app modules", async () => {
    await withFixture(
      {
        "requirements.txt": "fastapi\nuvicorn\n",
        "app/main.py": "from fastapi import FastAPI\napi = FastAPI()\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/api", dir);
        assert.equal(analysis.wsgiModule, "app.main:api");
      },
    );
  });
});

describe("new framework detection", () => {
  it("detects sinatra and serves via rackup", async () => {
    await withFixture(
      {
        Gemfile: 'source "https://rubygems.org"\ngem "sinatra"\n',
        "config.ru": "require './app'\nrun Sinatra::Application\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/sin", dir);
        assert.equal(analysis.framework, "sinatra");
        const dockerfile = generateDockerfile(analysis, {});
        assert.match(dockerfile, /rackup/);
        assert.doesNotMatch(dockerfile, /alpine:latest/);
      },
    );
  });

  it("detects static sites and serves them with nginx", async () => {
    await withFixture(
      { "index.html": "<html><body>hi</body></html>" },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/site", dir);
        assert.equal(analysis.framework, "static");
        const dockerfile = generateDockerfile(analysis, {});
        assert.match(dockerfile, /FROM nginx:alpine/);
        assert.match(dockerfile, /try_files/);
      },
    );
  });

  it("detects dart projects", async () => {
    await withFixture(
      {
        "pubspec.yaml": "name: server\nenvironment:\n  sdk: ^3.0.0\n",
        "bin/main.dart": "void main() {}\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/dartapp", dir);
        assert.equal(analysis.framework, "dart");
        assert.match(generateDockerfile(analysis, {}), /dart compile exe/);
      },
    );
  });

  it("detects go cmd/ layouts and builds the right package", async () => {
    await withFixture(
      {
        "go.mod": "module example.com/api\n\ngo 1.22\n",
        "cmd/server/main.go": "package main\nfunc main() {}\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/api", dir);
        assert.equal(analysis.goBuildPath, "./cmd/server");
        assert.match(generateDockerfile(analysis, {}), /go build -o app .*\.\/cmd\/server/);
      },
    );
  });

  it("uses the Cargo.toml crate name for rust binaries", async () => {
    await withFixture(
      {
        "Cargo.toml": '[package]\nname = "my-server"\nversion = "0.1.0"\n',
        "src/main.rs": "fn main() {}\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/rustrepo", dir);
        assert.equal(analysis.binaryName, "my-server");
        assert.match(
          generateDockerfile(analysis, {}),
          /target\/release\/my-server/,
        );
      },
    );
  });

  it("builds SPAs as static nginx images instead of npm start", () => {
    const analysis: AnalysisResult = {
      ...base,
      language: "typescript",
      framework: "react",
      packageManager: "npm",
      rootFiles: ["package.json"],
    };
    const dockerfile = generateDockerfile(analysis, {});
    assert.match(dockerfile, /FROM nginx:alpine/);
    assert.match(dockerfile, /npm run build/);
    assert.doesNotMatch(dockerfile, /CMD \["npm", "start"\]/);
  });

  it("keeps npm start for node server frameworks like fastify", () => {
    const analysis: AnalysisResult = {
      ...base,
      language: "javascript",
      framework: "fastify",
      packageManager: "npm",
      rootFiles: ["package.json"],
    };
    assert.match(generateDockerfile(analysis, {}), /CMD \["npm", "start"\]/);
  });
});

describe("compose healthchecks", () => {
  it("emits healthchecks and healthy depends_on conditions", () => {
    const analysis: AnalysisResult = {
      ...base,
      framework: "express",
      services: [
        {
          name: "postgres",
          image: "postgres:16-alpine",
          env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "app", POSTGRES_DB: "app" },
          ports: ["5432:5432"],
          volumes: ["postgres_data:/var/lib/postgresql/data"],
          healthcheck: "pg_isready -U app -d app",
        },
      ],
    };
    const compose = generateDockerCompose(analysis, {});
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /pg_isready -U app -d app/);
    assert.match(compose, /interval: 5s/);
  });
});

describe("self-managed gitlab", () => {
  it("routes gitlab.<domain> hosts to the gitlab provider", () => {
    const parsed = parseRepoUrl("https://gitlab.mycompany.io/group/sub/project");
    assert.equal(parsed?.provider, "gitlab");
    assert.equal(parsed?.host, "gitlab.mycompany.io");
    assert.equal(parsed?.projectPath, "group/sub/project");
  });

  it("strips /-/tree paths from gitlab URLs", () => {
    const parsed = parseRepoUrl("https://gitlab.com/group/project/-/tree/main");
    assert.equal(parsed?.projectPath, "group/project");
  });
});
