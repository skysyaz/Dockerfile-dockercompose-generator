import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { auditExistingFiles } from "../src/lib/docker-audit.ts";
import {
  classifyCloneError,
  detectDotnetProject,
  detectDotnetSdkVersion,
  generateDockerfile,
  parseGithubUrl,
} from "../src/lib/analyzer.ts";
import { parseRepoUrl } from "../src/lib/repo-url.ts";
import {
  isAllowedBuildFile,
  sanitizeBaseImageVersion,
  sanitizePort,
} from "../src/lib/validation.ts";
import type { AnalysisResult } from "../src/lib/types.ts";

const baseAnalysis: AnalysisResult = {
  repoUrl: "https://github.com/user/app",
  repoName: "app",
  repoProvider: "github",
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
  dotnetProject: "",
  dotnetSolution: "",
  dotnetSdkVersion: "",
  envVars: [],
  existingFiles: [],
};

describe("parseGithubUrl", () => {
  it("parses standard and .git URLs", () => {
    assert.deepEqual(parseGithubUrl("https://github.com/o/r"), { owner: "o", repo: "r" });
    assert.deepEqual(parseGithubUrl("https://github.com/o/r.git"), { owner: "o", repo: "r" });
    assert.equal(parseGithubUrl("https://gitlab.com/o/r"), null);
    assert.equal(parseRepoUrl("https://gitlab.com/o/r")?.provider, "gitlab");
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

describe("generateDockerfile", () => {
  it("resolves boot jars from multi-module Gradle projects", () => {
    const analysis: AnalysisResult = {
      ...baseAnalysis,
      language: "java",
      framework: "spring-boot",
      packageManager: "gradle",
      buildTool: "gradle",
      entrypoint: "build.gradle",
      port: 8080,
    };
    const dockerfile = generateDockerfile(analysis, {});
    assert.match(dockerfile, /find \/app -type f -path '\*\/build\/libs\/\*\.jar'/);
    assert.match(dockerfile, /COPY --from=builder \/app\/application\.jar app\.jar/);
    assert.doesNotMatch(dockerfile, /COPY --from=builder \/app\/build\/libs\/\*\.jar/);
  });

  it("publishes nested .NET projects from the full repository context", () => {
    const analysis: AnalysisResult = {
      ...baseAnalysis,
      repoName: "DataUtility",
      language: "csharp",
      framework: "dotnet",
      packageManager: "nuget",
      buildTool: "nuget",
      entrypoint: "DataUtility.Web.dll",
      port: 8080,
      dotnetProject: "src/DataUtility.Web/DataUtility.Web.csproj",
      dotnetSolution: "DataUtility.sln",
      dotnetSdkVersion: "6.0",
    };
    const dockerfile = generateDockerfile(analysis, {});

    assert.match(dockerfile, /FROM mcr\.microsoft\.com\/dotnet\/sdk:6\.0/);
    assert.match(dockerfile, /FROM mcr\.microsoft\.com\/dotnet\/aspnet:6\.0/);

    assert.match(dockerfile, /COPY \. \./);
    assert.match(dockerfile, /dotnet restore "DataUtility\.sln"/);
    assert.match(
      dockerfile,
      /dotnet publish "src\/DataUtility\.Web\/DataUtility\.Web\.csproj"/,
    );
    assert.match(dockerfile, /ENTRYPOINT \["dotnet", "DataUtility\.Web\.dll"\]/);
    assert.doesNotMatch(dockerfile, /COPY \*\.csproj/);
  });
});

describe("detectDotnetProject", () => {
  it("prefers web SDK projects in nested solutions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-dotnet-"));
    try {
      const webDir = path.join(root, "src", "DataUtility.Web");
      const coreDir = path.join(root, "src", "DataUtility.Core");
      const testsDir = path.join(root, "DataUtility.Tests");
      await fs.mkdir(webDir, { recursive: true });
      await fs.mkdir(coreDir, { recursive: true });
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(root, "DataUtility.sln"),
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DataUtility.Web", "src\\DataUtility.Web\\DataUtility.Web.csproj", "{GUID}"\n',
      );
      await fs.writeFile(
        path.join(root, "Hangfire.sln"),
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Hangfire", "vendor\\Hangfire\\Hangfire.csproj", "{GUID}"\n',
      );
      await fs.writeFile(
        path.join(webDir, "DataUtility.Web.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      );
      await fs.writeFile(
        path.join(coreDir, "DataUtility.Core.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      );
      await fs.writeFile(
        path.join(testsDir, "DataUtility.Tests.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><OutputType>Exe</OutputType></Project>',
      );

      const detected = await detectDotnetProject(root, "DataUtility");
      assert.equal(detected.project, "src/DataUtility.Web/DataUtility.Web.csproj");
      assert.equal(detected.solution, "DataUtility.sln");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores vendored solution files like Hangfire.sln", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-dotnet-"));
    try {
      const webDir = path.join(root, "src", "DataUtility.Web");
      await fs.mkdir(webDir, { recursive: true });
      await fs.writeFile(
        path.join(root, "global.json"),
        JSON.stringify({ sdk: { version: "6.0.0" } }),
      );
      await fs.writeFile(
        path.join(root, "DataUtility.sln"),
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "DataUtility.Web", "src\\DataUtility.Web\\DataUtility.Web.csproj", "{GUID}"\n',
      );
      await fs.writeFile(
        path.join(root, "Hangfire.sln"),
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Hangfire", "vendor\\Hangfire\\Hangfire.csproj", "{GUID}"\n',
      );
      await fs.writeFile(
        path.join(webDir, "DataUtility.Web.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net6.0</TargetFramework></PropertyGroup></Project>',
      );

      const detected = await detectDotnetProject(root, "DataUtility");
      assert.equal(detected.solution, "DataUtility.sln");
      assert.equal(detected.sdkVersion, "6.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("detectDotnetSdkVersion", () => {
  it("reads SDK version from global.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-dotnet-sdk-"));
    try {
      await fs.writeFile(
        path.join(root, "global.json"),
        JSON.stringify({ sdk: { version: "6.0.0" } }),
      );
      const version = await detectDotnetSdkVersion(root, "App.csproj");
      assert.equal(version, "6.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
