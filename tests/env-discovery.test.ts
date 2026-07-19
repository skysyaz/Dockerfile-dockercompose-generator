import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  buildEffectiveEnvVars,
  discoverEnvVars,
  formatEnvFile,
  resolveComposeServices,
} from "../src/lib/env-discovery.ts";
import type { AnalysisResult } from "../src/lib/types.ts";

const postgresService = {
  name: "postgres" as const,
  image: "postgres:16-alpine",
  env: {
    POSTGRES_USER: "app",
    POSTGRES_PASSWORD: "app",
    POSTGRES_DB: "app",
  },
  ports: ["5432:5432"],
  volumes: ["postgres_data:/var/lib/postgresql/data"],
};

describe("discoverEnvVars", () => {
  it("reads repository .env.example files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-env-"));
    try {
      await fs.writeFile(
        path.join(root, ".env.example"),
        "DB_HOST=legacy-host\nJWT_SECRET=from-repo\n",
      );
      const vars = await discoverEnvVars(root, {
        framework: "laravel",
        services: [postgresService],
        repoName: "shop",
        port: 8000,
      });
      assert.ok(vars.some((variable) => variable.key === "DB_HOST"));
      assert.ok(vars.some((variable) => variable.key === "JWT_SECRET"));
      assert.ok(vars.some((variable) => variable.key === "DB_PASSWORD"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("extracts .NET connection strings from appsettings.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-env-"));
    try {
      await fs.writeFile(
        path.join(root, "appsettings.json"),
        JSON.stringify({
          ConnectionStrings: {
            DefaultConnection: "Host=localhost;Database=app;",
          },
        }),
      );
      const vars = await discoverEnvVars(root, {
        framework: "dotnet",
        services: [postgresService],
        repoName: "DataUtility",
        port: 8080,
      });
      assert.ok(
        vars.some((variable) => variable.key === "ConnectionStrings__DefaultConnection"),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("finds env references in source files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-env-"));
    try {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "index.ts"),
        'const secret = process.env.JWT_SECRET;\nconst db = process.env.DATABASE_URL;\n',
      );
      const vars = await discoverEnvVars(root, {
        framework: "express",
        services: [postgresService],
        repoName: "api",
        port: 3000,
      });
      assert.ok(vars.some((variable) => variable.key === "JWT_SECRET"));
      assert.ok(vars.some((variable) => variable.key === "DATABASE_URL"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildEffectiveEnvVars", () => {
  const analysis: AnalysisResult = {
    repoUrl: "https://github.com/user/app",
    repoName: "app",
    repoProvider: "github",
    language: "csharp",
    framework: "dotnet",
    packageManager: "nuget",
    buildTool: "nuget",
    entrypoint: "App.dll",
    port: 8080,
    services: [postgresService],
    dependencies: ["npgsql"],
    notes: [],
    backendSubdir: "",
    dotnetProject: "src/App/App.csproj",
    dotnetSolution: "App.sln",
    dotnetSdkVersion: "8.0",
    envVars: [
      {
        key: "ConnectionStrings__DefaultConnection",
        suggestedValue: "Host=localhost;Database=legacy;",
        category: "database",
        source: "appsettings",
        required: true,
      },
    ],
    existingFiles: [],
  };

  it("switches database hosts to external mode", () => {
    const bundled = buildEffectiveEnvVars(analysis, { databaseMode: "bundled" });
    const external = buildEffectiveEnvVars(analysis, { databaseMode: "external" });
    const bundledConn = bundled.find(
      (variable) => variable.key === "ConnectionStrings__DefaultConnection",
    );
    const externalConn = external.find(
      (variable) => variable.key === "ConnectionStrings__DefaultConnection",
    );
    assert.match(bundledConn?.suggestedValue ?? "", /Host=postgres/);
    assert.match(externalConn?.suggestedValue ?? "", /your-db-host/);
  });

  it("preserves repository .env.example database values", () => {
    const withEnvExample: AnalysisResult = {
      ...analysis,
      envVars: [
        {
          key: "DB_HOST",
          suggestedValue: "legacy-host",
          category: "database",
          source: "env-example",
          required: true,
        },
        ...analysis.envVars,
      ],
    };
    const effective = buildEffectiveEnvVars(withEnvExample, { databaseMode: "bundled" });
    const dbHost = effective.find((variable) => variable.key === "DB_HOST");
    assert.equal(dbHost?.suggestedValue, "legacy-host");
  });
});

describe("resolveComposeServices", () => {
  it("excludes database services in external mode", () => {
    const services = resolveComposeServices(
      [postgresService, { name: "redis", image: "redis:7-alpine", ports: ["6379:6379"] }],
      new Set(["postgres", "redis"]),
      "external",
    );
    assert.deepEqual(
      services.map((service) => service.name),
      ["redis"],
    );
  });
});

describe("formatEnvFile", () => {
  it("groups variables by category", () => {
    const content = formatEnvFile(
      [
        {
          key: "DATABASE_URL",
          suggestedValue: "postgresql://app:app@postgres:5432/app",
          category: "database",
          source: "dependency-inference",
          required: true,
        },
        {
          key: "NODE_ENV",
          suggestedValue: "production",
          category: "framework",
          source: "framework-default",
          required: true,
        },
      ],
      {},
      true,
    );
    assert.match(content, /# Database/);
    assert.match(content, /DATABASE_URL=/);
    assert.match(content, /NODE_ENV=production/);
  });
});
