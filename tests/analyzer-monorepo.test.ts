import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { analyzeDirectory } from "../src/lib/analyzer.ts";

describe("monorepo backend detection", () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-test-"));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds a .NET backend under a subdirectory next to a frontend package.json", async () => {
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "frontend", dependencies: { react: "^18.0.0" } }),
    );
    const backend = path.join(dir, "backend");
    await fs.mkdir(backend, { recursive: true });
    await fs.writeFile(
      path.join(backend, "Api.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>`,
    );

    const analysis = await analyzeDirectory("https://github.com/o/api", dir);
    assert.equal(analysis.backendSubdir, "backend");
    assert.equal(analysis.framework, "dotnet");
    assert.equal(analysis.dotnetProject, "Api.csproj");
    assert.equal(analysis.dotnetSdkVersion, "8.0");
  });
});
