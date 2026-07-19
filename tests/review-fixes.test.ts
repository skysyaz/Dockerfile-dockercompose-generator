import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { auditExistingFiles } from "../src/lib/docker-audit.ts";
import {
  classifyCloneError,
  parseGithubUrl,
} from "../src/lib/analyzer.ts";
import {
  isAllowedBuildFile,
  sanitizeBaseImageVersion,
  sanitizePort,
} from "../src/lib/validation.ts";
import type { AnalysisResult } from "../src/lib/types.ts";

const baseAnalysis: AnalysisResult = {
  repoUrl: "https://github.com/user/app",
  repoName: "app",
  language: "python",
  framework: "fastapi",
  packageManager: "pip",
  buildTool: "pip",
  entrypoint: "main:app",
  port: 8000,
  services: [
    {
      name: "postgres",
      image: "postgres:16-alpine",
      ports: ["5432:5432"],
    },
  ],
  dependencies: ["fastapi"],
  notes: [],
  backendSubdir: "",
  existingFiles: [],
};

describe("parseGithubUrl", () => {
  it("parses standard and .git URLs", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r" });
    assert.deepEqual(parseGithubUrl("https://github.com/o/r.git"), { owner: "o", repo: "r" });
    assert.equal(parseGithubUrl("https://gitlab.com/o/r"), null);
  });
});

describe("classifyCloneError", () => {
  it("maps not found and rate limit", () => {
    assert.equal(classifyCloneError("fatal: repository 'x/y' does not exist")?.status, 404);
    assert.equal(classifyCloneError("GitHub API rate limit exceeded")?.status, 429);
  });
});

describe("validation", () => {
  it("validates ports and image versions", () => {
    assert.equal(sanitizePort(8080), 8080);
    assert.throws(() => sanitizePort(70000));
    assert.equal(sanitizeBaseImageVersion("20-alpine"), "20-alpine");
    assert.throws(() => sanitizeBaseImageVersion("evil\nRUN"));
  });

  it("rejects unsafe build filenames", () => {
    assert.equal(isAllowedBuildFile("Dockerfile"), true);
    assert.equal(isAllowedBuildFile("../Dockerfile"), false);
  });
});

describe("auditExistingFiles", () => {
  it("only rewrites app service ports in compose", () => {
    const existing = {
      "docker-compose.yml": `services:
  app:
    build: .
    ports:
      - "3000:3000"
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
`,
    };
    const generated = {
      Dockerfile: "FROM python:3.12\n",
      "docker-compose.yml": "",
      ".dockerignore": "",
      ".env.example": "",
    };

    const result = auditExistingFiles(existing, generated, baseAnalysis, { port: 8080 });
    assert.match(result.files["docker-compose.yml"], /8080:8080/);
    assert.match(result.files["docker-compose.yml"], /5432:5432/);
  });

  it("falls back to generated Dockerfile when existing is incomplete", () => {
    const existing = { Dockerfile: "RUN echo hi\n" };
    const generated = {
      Dockerfile: "FROM python:3.12-slim\nWORKDIR /app\nCMD [\"python\"]\n",
      "docker-compose.yml": "services:\n  app:\n    build: .\n",
      ".dockerignore": "node_modules\n",
      ".env.example": "PORT=8000\n",
    };

    const result = auditExistingFiles(existing, generated, baseAnalysis, {});
    assert.match(result.files.Dockerfile, /^FROM /m);
    assert.ok(result.fixes.some((f) => f.includes("incomplete")));
  });
});
