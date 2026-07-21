import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  analyzeDirectory,
  generateDockerfile,
  generateDockerignore,
  generateDockerCompose,
} from "../src/lib/analyzer.ts";
import { redactSecrets } from "../src/lib/analyzer-errors.ts";
import { auditExistingFiles } from "../src/lib/docker-audit.ts";
import { formatEnvValue, formatEnvFile } from "../src/lib/env-discovery.ts";
import { installCmd } from "../src/lib/node-docker.ts";
import type { AnalysisResult, DiscoveredEnvVar } from "../src/lib/types.ts";

const base: AnalysisResult = {
  repoUrl: "https://github.com/user/app",
  repoName: "my-app",
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

async function withFixture(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-bugs-"));
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

describe("hidden bug fixes", () => {
  it("routes Maven Spring Boot to the Maven Dockerfile", async () => {
    await withFixture(
      {
        "pom.xml":
          '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
        "src/main/java/App.java": "class App {}",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/petclinic", dir);
        assert.equal(analysis.framework, "spring-boot");
        assert.equal(analysis.buildTool, "maven");
        const dockerfile = generateDockerfile(analysis, {});
        assert.match(dockerfile, /mvn package/);
        assert.match(dockerfile, /COPY .*pom\.xml/);
        assert.doesNotMatch(dockerfile, /gradle /);
      },
    );
  });

  it("uses next start instead of requiring standalone output", () => {
    const dockerfile = generateDockerfile(
      {
        ...base,
        framework: "nextjs",
        language: "typescript",
        packageManager: "npm",
        buildTool: "npm",
        rootFiles: ["package.json", "package-lock.json"],
      },
      {},
    );
    assert.match(dockerfile, /npx", "next", "start/);
    assert.doesNotMatch(dockerfile, /\.next\/standalone/);
  });

  it("builds NestJS before starting dist/main", () => {
    const dockerfile = generateDockerfile(
      {
        ...base,
        framework: "nestjs",
        language: "typescript",
        packageManager: "npm",
        buildTool: "npm",
        rootFiles: ["package.json"],
      },
      {},
    );
    assert.match(dockerfile, /npm run build/);
    assert.match(dockerfile, /node", "dist\/main/);
  });

  it("escapes $uri in nginx templates", () => {
    const dockerfile = generateDockerfile(
      {
        ...base,
        framework: "vite",
        language: "typescript",
        packageManager: "npm",
        buildTool: "npm",
        rootFiles: ["package.json"],
      },
      {},
    );
    assert.match(dockerfile, /\$\$uri/);
    assert.doesNotMatch(dockerfile, /try_files \$uri /);
  });

  it("keeps Cargo.lock out of rust dockerignore", () => {
    const ignore = generateDockerignore({
      ...base,
      framework: "rust",
      language: "rust",
    });
    assert.doesNotMatch(ignore, /Cargo\.lock/);
  });

  it("does not select uv without uv.lock", async () => {
    await withFixture(
      {
        "pyproject.toml": '[tool.uv]\ndev-dependencies = []\n',
        "main.py": "print('hi')\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/py", dir);
        assert.notEqual(analysis.pythonManager, "uv");
      },
    );
  });

  it("omits elasticsearch healthcheck that needs curl", () => {
    const compose = generateDockerCompose(
      {
        ...base,
        framework: "nodejs",
        language: "javascript",
        packageManager: "npm",
        services: [
          {
            name: "elasticsearch",
            image: "docker.elastic.co/elasticsearch/elasticsearch:8.13.4",
            ports: ["9200:9200"],
          },
        ],
      },
      { enabledServices: ["elasticsearch"] },
    );
    assert.doesNotMatch(compose, /healthcheck:/);
  });

  it("redacts GitHub and GitLab tokens from errors", () => {
    assert.match(
      redactSecrets("fail ghp_abcdefghijklmnopqrstuvwxyz012345 token"),
      /ghp_\[REDACTED\]/,
    );
    assert.match(
      redactSecrets("fail github_pat_11AAAA_BBBB token"),
      /github_pat_\[REDACTED\]/,
    );
    assert.match(redactSecrets("fail glpat-xxxxYYYYZZzz token"), /glpat-\[REDACTED\]/);
  });

  it("inserts ENV after FROM when auditing Dockerfiles", () => {
    const result = auditExistingFiles(
      {
        Dockerfile: "FROM python:3.12-slim\nWORKDIR /app\nCMD [\"python\"]\n",
      },
      {
        Dockerfile: "FROM python:3.12-slim\n",
        "docker-compose.yml": "",
        ".dockerignore": "",
        ".env.example": "",
      },
      { ...base, framework: "flask", language: "python", port: 5000 },
      {},
    );
    assert.match(result.files.Dockerfile, /^FROM /m);
    assert.match(result.files.Dockerfile, /FROM python:3\.12-slim\nENV PYTHONUNBUFFERED=1/);
    assert.ok(!result.files.Dockerfile.startsWith("ENV "));
  });

  it("uses yarn --immutable for Yarn Berry", () => {
    assert.match(
      installCmd("yarn", ["yarn.lock", ".yarnrc.yml"]),
      /--immutable/,
    );
    assert.match(installCmd("yarn", ["yarn.lock"]), /--frozen-lockfile/);
  });

  it("preserves multiline env values as escaped newlines", () => {
    assert.equal(formatEnvValue("a\nb"), '"a\\nb"');
    const vars: DiscoveredEnvVar[] = [
      {
        key: "CERT",
        suggestedValue: "line1\nline2",
        category: "secret",
        source: "env-example",
        required: true,
      },
    ];
    const file = formatEnvFile(vars, {}, true);
    assert.match(file, /CERT="line1\\nline2"/);
  });

  it("prefixes monorepo COPY paths and keeps root build context", async () => {
    await withFixture(
      {
        "package.json": '{"name":"web","dependencies":{"react":"18.0.0"}}',
        "backend/requirements.txt": "fastapi\n",
        "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      },
      async (dir) => {
        const analysis = await analyzeDirectory("https://github.com/o/mono", dir);
        assert.ok(analysis.backendSubdir.includes("backend"));
        const dockerfile = generateDockerfile(analysis, {});
        const compose = generateDockerCompose(analysis, {});
        assert.match(dockerfile, /COPY backend\//);
        assert.match(compose, /build: \./);
        assert.doesNotMatch(compose, /dockerfile: \.\.\/Dockerfile/);
      },
    );
  });

  it("copies full source for pnpm workspaces before install", () => {
    const dockerfile = generateDockerfile(
      {
        ...base,
        framework: "nodejs",
        language: "typescript",
        packageManager: "pnpm",
        buildTool: "pnpm",
        rootFiles: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
      },
      {},
    );
    assert.match(dockerfile, /COPY \. \./);
  });
});
