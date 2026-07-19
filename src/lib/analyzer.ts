import * as fs from "fs/promises";
import * as path from "path";
import { auditExistingFiles, type ExistingDockerFiles } from "./docker-audit";
import {
  applyEnvValues,
  buildEffectiveEnvVars,
  discoverEnvVars,
  formatEnvFile,
  resolveComposeServices,
} from "./env-discovery";
import { fetchRepoArchive } from "./repo-fetch";
import { buildCmd, dependencyCopyLine, installCmd, sanitizeDockerfileLockfiles } from "./node-docker";
import { parseGithubUrl, parseRepoUrl } from "./repo-url";
import type {
  AnalysisResult,
  Customizations,
  DetectedService,
  Framework,
  GeneratedFiles,
  Language,
  RepoProvider,
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
  "mix.exs",
  "build.sbt",
  "Package.swift",
  "stack.yaml",
  "deno.json",
  "deno.jsonc",
  "CMakeLists.txt",
  "pubspec.yaml",
  "project.clj",
  "deps.edn",
  "*.csproj",
  "*.sln",
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const GLOB_MAX_DEPTH = 8;

interface CacheEntry {
  dir: string;
  analysis: AnalysisResult;
  expiresAt: number;
}

const cloneCache = new Map<string, CacheEntry>();

function cacheKey(repoUrl: string, token?: string): string {
  return `${normalizeRepoUrl(repoUrl)}::${token ?? ""}`;
}

const MAX_CACHE_ENTRIES = 10;

function evictOldestCacheEntry(): void {
  if (cloneCache.size < MAX_CACHE_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestExpiry = Infinity;
  for (const [key, entry] of cloneCache.entries()) {
    if (entry.expiresAt < oldestExpiry) {
      oldestExpiry = entry.expiresAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = cloneCache.get(oldestKey);
    if (entry) {
      fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
    }
    cloneCache.delete(oldestKey);
  }
}

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/, "").replace(/\/$/, "");
}

export { normalizeRepoUrl, parseGithubUrl, parseRepoUrl };
export type { RepoProvider } from "./types";
export { redactSecrets, classifyCloneError } from "./analyzer-errors";

export async function cloneRepo(
  repoUrl: string,
  dest: string,
  accessToken?: string,
): Promise<void> {
  await fetchRepoArchive(repoUrl, dest, accessToken);
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

async function readExistingDockerFiles(workDir: string): Promise<ExistingDockerFiles> {
  const candidates = [
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".dockerignore",
    ".env.example",
    ".env",
  ] as const;
  const found: ExistingDockerFiles = {};
  for (const name of candidates) {
    const filePath = path.join(workDir, name);
    if (await fileExists(filePath)) {
      found[name] = await readText(filePath);
    }
  }
  return found;
}

function workDirFromClone(cloneDir: string, backendSubdir: string): string {
  return backendSubdir ? path.join(cloneDir, backendSubdir) : cloneDir;
}

export function getCachedCloneDir(
  repoUrl: string,
  githubToken?: string,
): string | null {
  const entry = cloneCache.get(cacheKey(repoUrl, githubToken));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.dir;
}

export async function buildGeneratedFiles(
  analysis: AnalysisResult,
  customizations: Customizations = {},
  cloneDir?: string,
): Promise<{ files: GeneratedFiles; auditFixes: string[] }> {
  const effectiveAnalysis = cloneDir
    ? await refreshAnalysisRootFiles(analysis, cloneDir)
    : analysis;
  const generated = generateAllFiles(effectiveAnalysis, customizations);
  if (!cloneDir) return { files: generated, auditFixes: [] };

  const workDir = workDirFromClone(cloneDir, effectiveAnalysis.backendSubdir);
  const existing = await readExistingDockerFiles(workDir);
  const existingNames = Object.keys(existing);
  let files: GeneratedFiles = generated;
  const auditFixes: string[] = [];

  if (existingNames.length) {
    const audited = auditExistingFiles(
      existing,
      { ...generated } as Record<string, string>,
      effectiveAnalysis,
      customizations,
    );
    files = audited.files as unknown as GeneratedFiles;
    auditFixes.push(
      `Found existing Docker config: ${existingNames.join(", ")}`,
      ...audited.fixes,
    );
  }

  const lockfileFix = sanitizeDockerfileLockfiles(
    files.Dockerfile,
    effectiveAnalysis.rootFiles ?? [],
  );
  if (lockfileFix.content !== files.Dockerfile) {
    files = { ...files, Dockerfile: lockfileFix.content };
    auditFixes.push(...lockfileFix.fixes);
  }

  return { files, auditFixes };
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
    if (marker.startsWith("*.")) {
      // Only check this directory itself (maxDepth 0), not nested folders.
      const files = await globFiles(dir, marker, 0, 0);
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
  if (depth > 3) return "";
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
  maxDepth = GLOB_MAX_DEPTH,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  const suffix = pattern.startsWith("*.") ? pattern.slice(1) : null;
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (suffix && entry.name.endsWith(suffix)) {
        results.push(full);
      }
    } else if (entry.isDirectory()) {
      results.push(...(await globFiles(full, pattern, depth + 1, maxDepth)));
    }
  }
  return results;
}

function toPosixRelative(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join("/");
}

function dotnetContextPath(analysis: AnalysisResult, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!analysis.backendSubdir) return normalized;
  return `${analysis.backendSubdir.replace(/\\/g, "/")}/${normalized}`;
}

async function scoreCsproj(csprojPath: string, repoName: string): Promise<number> {
  const content = await readText(csprojPath);
  const name = path.basename(csprojPath, ".csproj").toLowerCase();
  let score = 0;

  if (/Microsoft\.NET\.Sdk\.Web/i.test(content)) score += 100;
  if (/OutputType>\s*Exe/i.test(content)) score += 50;
  if (/OutputType>\s*WinExe/i.test(content)) score += 40;
  if (/\b(web|api|app|server|host)\b/i.test(name)) score += 20;
  if (name === repoName.toLowerCase()) score += 30;
  if (/\b(test|tests|spec|unit)\b/i.test(name)) score -= 80;

  return score;
}

function normalizeDotnetVersion(version: string): string {
  const parts = version.trim().split(".");
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`;
  return version.trim();
}

const VENDORED_SOLUTION_HINTS =
  /hangfire|nunit|xunit|moq|serilog|newtonsoft|automapper|castle|fluentvalidation/i;

async function pickDotnetSolution(
  workDir: string,
  projectRel: string,
  repoName: string,
): Promise<string> {
  const slns = await globFiles(workDir, "*.sln", 0);
  if (!slns.length) return "";

  const projectName = path.basename(projectRel);
  const projectPathWin = projectRel.replace(/\//g, "\\");

  const scored = await Promise.all(
    slns.map(async (absPath) => {
      const rel = toPosixRelative(workDir, absPath);
      const name = path.basename(absPath);
      const content = await readText(absPath);
      const containsProject =
        content.includes(projectRel) ||
        content.includes(projectPathWin) ||
        content.includes(`"${projectName}"`) ||
        content.includes(projectName);

      let score = 0;
      if (containsProject) score += 100;
      const lower = name.toLowerCase();
      const repoLower = repoName.toLowerCase();
      if (lower.includes(repoLower)) score += 50;
      if (lower === `${repoLower}.sln`) score += 30;
      if (VENDORED_SOLUTION_HINTS.test(lower) && !lower.includes(repoLower)) {
        score -= 80;
      }
      score -= rel.split("/").length;
      return { rel, score };
    }),
  );

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.rel ?? "";
}

async function findCsprojsFromSolutions(workDir: string): Promise<string[]> {
  const slns = await globFiles(workDir, "*.sln", 0);
  const found = new Set<string>();

  for (const slnPath of slns) {
    const content = await readText(slnPath);
    for (const match of content.matchAll(/"([^"]+\.csproj)"/gi)) {
      const projectPath = match[1].replace(/\\/g, "/");
      const abs = path.resolve(path.dirname(slnPath), projectPath);
      if (await fileExists(abs)) {
        found.add(toPosixRelative(workDir, abs));
      }
    }
  }

  return [...found];
}

export async function detectDotnetSdkVersion(
  workDir: string,
  projectRel: string,
): Promise<string> {
  const globalJson = await readText(path.join(workDir, "global.json"));
  if (globalJson) {
    try {
      const parsed = JSON.parse(globalJson) as { sdk?: { version?: string } };
      if (parsed.sdk?.version) {
        return normalizeDotnetVersion(parsed.sdk.version);
      }
    } catch {
      /* ignore invalid global.json */
    }
  }

  const csprojPath = path.join(workDir, projectRel);
  const csproj = await readText(csprojPath);
  const tfmMatch =
    csproj.match(/<TargetFramework>\s*(net\d+\.\d+)/i) ??
    csproj.match(/<TargetFrameworks>\s*([^<]+)</i);
  if (tfmMatch) {
    const tfm = tfmMatch[1].split(";")[0].trim();
    const version = tfm.match(/net(\d+\.\d+)/i);
    if (version) return version[1];
  }

  return "8.0";
}

export async function detectDotnetProject(
  workDir: string,
  repoName: string,
): Promise<{ project: string; solution: string; sdkVersion: string }> {
  let csprojs = await globFiles(workDir, "*.csproj", 0);
  if (!csprojs.length) {
    const fromSolutions = await findCsprojsFromSolutions(workDir);
    csprojs = fromSolutions.map((rel) => path.join(workDir, rel));
  }

  if (!csprojs.length) {
    const fallbackProject = `${repoName}.csproj`;
    return {
      project: fallbackProject,
      solution: "",
      sdkVersion: await detectDotnetSdkVersion(workDir, fallbackProject),
    };
  }

  const ranked = await Promise.all(
    csprojs.map(async (absPath) => {
      const rel = toPosixRelative(workDir, absPath);
      const score = await scoreCsproj(absPath, repoName);
      return {
        rel,
        score: score - rel.split("/").length,
      };
    }),
  );

  ranked.sort((a, b) => b.score - a.score);
  const project = ranked[0]?.rel ?? `${repoName}.csproj`;
  const solution = await pickDotnetSolution(workDir, project, repoName);
  const sdkVersion = await detectDotnetSdkVersion(workDir, project);

  return { project, solution, sdkVersion };
}

function detectPackageManager(files: string[], packageManagerField = ""): string {
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  if (files.includes("uv.lock")) return "uv";
  if (files.includes("poetry.lock")) return "poetry";
  if (files.includes("pdm.lock")) return "pdm";
  if (files.includes("Pipfile")) return "pipenv";
  if (files.includes("pyproject.toml")) return "pip";
  if (files.includes("requirements.txt")) return "pip";
  if (files.includes("pubspec.yaml") || files.includes("pubspec.yml")) return "pub";
  if (files.includes("project.clj")) return "lein";
  if (files.includes("deps.edn")) return "clojure-cli";
  if (files.includes("pom.xml")) return "maven";
  if (files.includes("build.gradle") || files.includes("build.gradle.kts"))
    return "gradle";
  if (files.includes("Cargo.toml")) return "cargo";
  if (files.includes("Gemfile")) return "bundler";
  if (files.includes("composer.json")) return "composer";
  if (files.some((f) => f.endsWith(".csproj") || f.endsWith(".sln")))
    return "nuget";
  if (files.includes("go.mod")) return "go-modules";
  if (files.includes("package.json")) {
    if (packageManagerField.startsWith("pnpm@")) return "pnpm";
    if (packageManagerField.startsWith("yarn@")) return "yarn";
    if (packageManagerField.startsWith("bun@")) return "bun";
    if (packageManagerField.startsWith("npm@")) return "npm";
    return "npm";
  }
  return "unknown";
}

async function listRootFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function detectPythonManager(
  workDir: string,
  rootFiles: string[],
): Promise<AnalysisResult["pythonManager"]> {
  if (rootFiles.includes("uv.lock")) return "uv";
  if (rootFiles.includes("poetry.lock")) return "poetry";
  if (rootFiles.includes("pdm.lock")) return "pdm";
  if (rootFiles.includes("Pipfile")) return "pipenv";
  if (rootFiles.includes("pyproject.toml")) {
    const pyproject = await readText(path.join(workDir, "pyproject.toml"));
    if (/\[tool\.poetry\]/.test(pyproject)) return "poetry";
    if (/\[tool\.pdm\]/.test(pyproject)) return "pdm";
    if (/\[tool\.uv\]/.test(pyproject)) return "uv";
  }
  return "pip";
}

async function detectPythonAppModule(
  workDir: string,
  framework: Framework,
): Promise<string> {
  if (framework === "django") {
    const pyFiles = await globFiles(workDir, "*.py", 0, 3);
    const wsgi = pyFiles
      .filter((f) => {
        const base = path.basename(f);
        return base === "wsgi.py" || base === "asgi.py";
      })
      .map((f) => toPosixRelative(workDir, f))
      .sort(
        (a, b) =>
          a.split("/").length - b.split("/").length ||
          // Prefer wsgi.py over asgi.py at the same depth.
          (a.endsWith("wsgi.py") ? -1 : 1) - (b.endsWith("wsgi.py") ? -1 : 1),
      )[0];
    if (wsgi) {
      const mod = wsgi.replace(/\.py$/, "").split("/").join(".");
      // Interpolated into the CMD array — only allow module-path characters.
      if (/^[A-Za-z0-9_.]+$/.test(mod)) return `${mod}:application`;
    }
    return "";
  }

  if (framework === "fastapi" || framework === "flask") {
    const marker =
      framework === "fastapi"
        ? /(\w+)\s*=\s*FastAPI\s*\(/
        : /(\w+)\s*=\s*Flask\s*\(/;
    const candidates = [
      "main.py",
      "app.py",
      "application.py",
      "server.py",
      "wsgi.py",
      "app/main.py",
      "app/app.py",
      "src/main.py",
      "src/app.py",
      "api/main.py",
    ];
    for (const rel of candidates) {
      const content = await readText(path.join(workDir, rel));
      if (!content) continue;
      const match = content.match(marker);
      if (match) {
        const mod = rel.replace(/\.py$/, "").split("/").join(".");
        return `${mod}:${match[1]}`;
      }
    }
  }

  return "";
}

async function detectGoBuildPath(
  workDir: string,
  rootFiles: string[],
  repoName: string,
): Promise<string> {
  if (rootFiles.includes("main.go")) return ".";
  const goFiles = await globFiles(workDir, "*.go", 0, 3);
  const mainDirs = goFiles
    .filter((f) => path.basename(f) === "main.go")
    .map((f) => toPosixRelative(workDir, path.dirname(f)));
  if (!mainDirs.length) return "";
  const repoLower = repoName.toLowerCase().replace(/[^a-z0-9._-]/g, "");
  const preferred =
    mainDirs.find((d) => d.toLowerCase() === `cmd/${repoLower}`) ??
    mainDirs.find((d) => /^cmd\/(server|api|app|web|main)$/i.test(d)) ??
    mainDirs.find((d) => d.startsWith("cmd/")) ??
    mainDirs.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  // The path is interpolated into a RUN instruction — refuse anything that
  // isn't a plain relative path of safe characters.
  if (!preferred || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(preferred) || preferred.includes("..")) {
    return "";
  }
  return `./${preferred}`;
}

async function detectRustBinaryName(workDir: string): Promise<string> {
  const cargo = await readText(path.join(workDir, "Cargo.toml"));
  if (!cargo) return "";
  const bin = cargo.match(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/);
  const name = bin?.[1] ?? cargo.match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/)?.[1] ?? "";
  // Interpolated into a COPY instruction — only allow crate-name characters.
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : "";
}

async function refreshAnalysisRootFiles(
  analysis: AnalysisResult,
  cloneDir: string,
): Promise<AnalysisResult> {
  const workDir = workDirFromClone(cloneDir, analysis.backendSubdir);
  const rootFiles = await listRootFiles(workDir);
  if (!rootFiles.length) return analysis;
  return { ...analysis, rootFiles };
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
  let isWorkspaceRoot = false;
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        workspaces?: unknown;
      };
      deps.push(...Object.keys(parsed.dependencies ?? {}));
      deps.push(...Object.keys(parsed.devDependencies ?? {}));
      isWorkspaceRoot = Boolean(parsed.workspaces);
    } catch {
      /* ignore */
    }
  }

  // Workspace monorepos keep real dependencies (incl. native modules that
  // need build tools) in nested package.json files — scan those too.
  if (
    isWorkspaceRoot ||
    (await fileExists(path.join(workDir, "pnpm-workspace.yaml")))
  ) {
    const nestedPkgs = (await globFiles(workDir, "*.json", 0, 3)).filter(
      (f) => path.basename(f) === "package.json" && path.dirname(f) !== workDir,
    );
    for (const nested of nestedPkgs.slice(0, 50)) {
      try {
        const parsed = JSON.parse(await readText(nested)) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        deps.push(...Object.keys(parsed.dependencies ?? {}));
        deps.push(...Object.keys(parsed.devDependencies ?? {}));
      } catch {
        /* ignore */
      }
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

  return [...new Set(deps)].slice(0, 400);
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
      healthcheck: "pg_isready -U app -d app",
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
      healthcheck: "mysqladmin ping -h 127.0.0.1 -uroot -proot",
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
      healthcheck: "mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok'",
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
      healthcheck: "redis-cli ping",
    });
  }

  if (
    /\bamqplib\b|\bpika\b|\bbunny\b|php-amqplib|masstransit|rabbitmq|spring-boot-starter-amqp/.test(
      joined,
    )
  ) {
    services.push({
      name: "rabbitmq",
      image: "rabbitmq:3-management-alpine",
      env: {
        RABBITMQ_DEFAULT_USER: "app",
        RABBITMQ_DEFAULT_PASS: "app",
      },
      ports: ["5672:5672", "15672:15672"],
      volumes: ["rabbitmq_data:/var/lib/rabbitmq"],
      healthcheck: "rabbitmq-diagnostics -q ping",
    });
  }

  if (/\belasticsearch\b|@elastic\/elasticsearch|elasticsearch-py|\bopensearch\b/.test(joined)) {
    services.push({
      name: "elasticsearch",
      image: "docker.elastic.co/elasticsearch/elasticsearch:8.13.4",
      env: {
        "discovery.type": "single-node",
        "xpack.security.enabled": "false",
        ES_JAVA_OPTS: "-Xms512m -Xmx512m",
      },
      ports: ["9200:9200"],
      volumes: ["elasticsearch_data:/usr/share/elasticsearch/data"],
      healthcheck: "curl -fs http://localhost:9200/_cluster/health || exit 1",
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

  if (has("mix.exs")) {
    const mix = await read("mix.exs");
    if (/phoenix/i.test(mix)) {
      return {
        framework: "phoenix",
        language: "elixir",
        port: 4000,
        entrypoint: "mix phx.server",
        buildTool: "mix",
        notes,
      };
    }
    return {
      framework: "elixir",
      language: "elixir",
      port: 4000,
      entrypoint: "mix run",
      buildTool: "mix",
      notes,
    };
  }

  if (has("build.sbt")) {
    return {
      framework: "scala",
      language: "scala",
      port: 8080,
      entrypoint: "sbt run",
      buildTool: "sbt",
      notes,
    };
  }

  if (has("deno.json") || has("deno.jsonc")) {
    return {
      framework: "deno",
      language: "typescript",
      port: 8000,
      entrypoint: "main.ts",
      buildTool: "deno",
      notes,
    };
  }

  if (has("Package.swift")) {
    return {
      framework: "swift",
      language: "swift",
      port: 8080,
      entrypoint: "Package.swift",
      buildTool: "swiftpm",
      notes,
    };
  }

  if (has("stack.yaml") || files.some((f) => f.endsWith(".cabal"))) {
    return {
      framework: "haskell",
      language: "haskell",
      port: 8080,
      entrypoint: "main",
      buildTool: "stack",
      notes,
    };
  }

  if (has("CMakeLists.txt")) {
    return {
      framework: "cmake",
      language: "cpp",
      port: 8080,
      entrypoint: "main",
      buildTool: "cmake",
      notes: ["C/C++ project detected via CMakeLists.txt"],
    };
  }

  if (has("pubspec.yaml") || has("pubspec.yml")) {
    const pubspec = await read(has("pubspec.yaml") ? "pubspec.yaml" : "pubspec.yml");
    if (/^\s{2,}flutter:\s*$/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec)) {
      notes.push(
        "Flutter project detected — the generated Dockerfile targets Dart server apps; Flutter mobile apps are not containerizable as-is.",
      );
    }
    return {
      framework: "dart",
      language: "dart",
      port: 8080,
      entrypoint: "bin/main.dart",
      buildTool: "pub",
      notes,
    };
  }

  if (has("project.clj") || has("deps.edn")) {
    return {
      framework: "clojure",
      language: "clojure",
      port: 8080,
      entrypoint: has("project.clj") ? "project.clj" : "deps.edn",
      buildTool: has("project.clj") ? "lein" : "clojure-cli",
      notes,
    };
  }

  if (has("build.gradle.kts")) {
    const gradle = await read("build.gradle.kts");
    if (/kotlin/i.test(gradle)) {
      return {
        framework: "kotlin",
        language: "kotlin",
        port: 8080,
        entrypoint: "build.gradle.kts",
        buildTool: "gradle",
        notes,
      };
    }
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
  const slns = await globFiles(workDir, "*.sln", 0);
  if (csprojs.length || slns.length || has(".sln") || files.some((f) => f.endsWith(".sln"))) {
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
      packageManager?: string;
    } = {};
    try {
      parsed = JSON.parse(pkg);
    } catch {
      /* ignore */
    }
    const packageManagerField = parsed.packageManager ?? "";
    const allDeps = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
    };
    const depNames = Object.keys(allDeps).join(" ").toLowerCase();
    const pm = () => detectPackageManager(files, packageManagerField);

    if (allDeps.electron) {
      notes.push(
        "Electron dependency detected — the container builds/serves the web part only; the desktop app itself cannot run inside Docker.",
      );
    }

    if (allDeps.next) {
      notes.push("Detected Next.js — using standalone multi-stage Dockerfile.");
      return {
        framework: "nextjs",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "server.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.nuxt || files.includes("nuxt.config.ts") || files.includes("nuxt.config.js")) {
      return {
        framework: "nuxt",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: ".output/server/index.mjs",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps["@sveltejs/kit"] || allDeps.svelte) {
      return {
        framework: "svelte",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "build",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.astro) {
      const hasNodeAdapter = Boolean(allDeps["@astrojs/node"]);
      notes.push(
        hasNodeAdapter
          ? "Detected Astro with the Node adapter — serving SSR output."
          : "Detected Astro (static output) — serving dist/ with nginx.",
      );
      return {
        framework: "astro",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: hasNodeAdapter ? 4321 : 80,
        entrypoint: hasNodeAdapter ? "./dist/server/entry.mjs" : "dist",
        buildTool: pm(),
        notes,
      };
    }
    if (
      allDeps["@remix-run/node"] ||
      allDeps["@remix-run/react"] ||
      allDeps["@remix-run/serve"]
    ) {
      return {
        framework: "remix",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "build/server/index.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.gatsby) {
      notes.push("Detected Gatsby — serving the static public/ output with nginx.");
      return {
        framework: "gatsby",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 80,
        entrypoint: "public",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps["@nestjs/core"]) {
      return {
        framework: "nestjs",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "main.ts",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.express) {
      return {
        framework: "express",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "index.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.fastify) {
      return {
        framework: "fastify",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "index.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.koa) {
      return {
        framework: "koa",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "index.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.hono) {
      return {
        framework: "hono",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "index.js",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.vite) {
      return {
        framework: "vite",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 4173,
        entrypoint: "index.html",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.react) {
      return {
        framework: "react",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "src/index.tsx",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps.vue) {
      return {
        framework: "vue",
        language: depNames.includes("typescript") ? "typescript" : "javascript",
        port: 3000,
        entrypoint: "src/main.ts",
        buildTool: pm(),
        notes,
      };
    }
    if (allDeps["@angular/core"]) {
      return {
        framework: "angular",
        language: "typescript",
        port: 4200,
        entrypoint: "src/main.ts",
        buildTool: pm(),
        notes,
      };
    }
    return {
      framework: "nodejs",
      language: depNames.includes("typescript") ? "typescript" : "javascript",
      port: 3000,
      entrypoint: "index.js",
      buildTool: pm(),
      notes,
    };
  }

  if (has("index.html")) {
    notes.push("No build system detected but index.html found — serving as a static site with nginx.");
    return {
      framework: "static",
      language: "html",
      port: 80,
      entrypoint: "index.html",
      buildTool: "none",
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
  const parsed = parseRepoUrl(repoUrl);
  const repoName = parsed?.repoName ?? "app";
  const repoProvider = parsed?.provider ?? "github";
  const backendSubdir = await findBackendSubdir(cloneDir);
  const workDir = backendSubdir
    ? path.join(cloneDir, backendSubdir)
    : cloneDir;

  const detection = await detectFramework(workDir);
  const rootFiles = await listRootFiles(workDir);
  let packageManagerField = "";
  let nodeVersion = "";
  let hasNodeLifecycleScripts = false;
  if (rootFiles.includes("package.json")) {
    try {
      const pkg = JSON.parse(await readText(path.join(workDir, "package.json")));
      packageManagerField = String(pkg.packageManager ?? "");
      const engines = String(pkg.engines?.node ?? "");
      const major = engines.match(/(\d+)/)?.[1];
      if (major && Number(major) >= 14 && Number(major) <= 30) {
        nodeVersion = `${major}-alpine`;
        detection.notes.push(
          `Using node:${major}-alpine base image (package.json engines.node: "${engines}").`,
        );
      }
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      hasNodeLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"].some(
        (name) => typeof scripts[name] === "string" && scripts[name].length > 0,
      );
      if (hasNodeLifecycleScripts) {
        detection.notes.push(
          "package.json has install lifecycle scripts — copying full source before install so they can run.",
        );
      }
    } catch {
      /* ignore */
    }
  }
  const packageManager = detectPackageManager(rootFiles, packageManagerField);
  const dependencies = await readDependencies(workDir, detection.framework);
  const services = detectServices(dependencies);
  const existing = await readExistingDockerFiles(workDir);
  const existingFiles = Object.keys(existing);
  const dotnet =
    detection.framework === "dotnet"
      ? await detectDotnetProject(workDir, repoName)
      : { project: "", solution: "", sdkVersion: "" };

  const pythonManager =
    detection.language === "python"
      ? await detectPythonManager(workDir, rootFiles)
      : undefined;
  const wsgiModule = await detectPythonAppModule(workDir, detection.framework);
  const goBuildPath =
    detection.framework === "go"
      ? await detectGoBuildPath(workDir, rootFiles, repoName)
      : "";
  const binaryName =
    detection.framework === "rust" ? await detectRustBinaryName(workDir) : "";

  if (pythonManager && pythonManager !== "pip") {
    detection.notes.push(`Detected Python dependency manager: ${pythonManager}.`);
  }
  if (wsgiModule) {
    detection.notes.push(`Detected application entry module: ${wsgiModule}.`);
  }
  if (goBuildPath && goBuildPath !== ".") {
    detection.notes.push(`Detected Go main package at ${goBuildPath}.`);
  }
  if (binaryName && binaryName !== repoName) {
    detection.notes.push(`Detected binary name from Cargo.toml: ${binaryName}.`);
  }

  if (backendSubdir) {
    detection.notes.push(`Monorepo detected — using subdirectory: ${backendSubdir}`);
  }

  if (detection.framework === "dotnet" && dotnet.project) {
    detection.entrypoint = `${path.basename(dotnet.project, ".csproj")}.dll`;
    if (dotnet.solution) {
      detection.notes.push(
        `Detected .NET SDK ${dotnet.sdkVersion} with solution ${dotnet.solution} and entry project ${dotnet.project}.`,
      );
    } else {
      detection.notes.push(
        `Detected .NET SDK ${dotnet.sdkVersion} with entry project ${dotnet.project}.`,
      );
    }
  }

  if (existingFiles.length) {
    detection.notes.push(
      `Existing Docker files found: ${existingFiles.join(", ")} — will audit and fix on generate.`,
    );
  }

  const envVars = await discoverEnvVars(workDir, {
    framework: detection.framework,
    services,
    repoName,
    port: detection.port,
    databaseMode: "bundled",
    dotnetProject: dotnet.project,
  });

  if (envVars.length) {
    const requiredCount = envVars.filter((variable) => variable.required).length;
    detection.notes.push(
      `Discovered ${envVars.length} environment variable(s) (${requiredCount} required) from repo config, dependencies, and source scan.`,
    );
  }

  return {
    repoUrl,
    repoName,
    repoProvider,
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
    dotnetProject: dotnet.project,
    dotnetSolution: dotnet.solution,
    dotnetSdkVersion: dotnet.sdkVersion,
    envVars,
    rootFiles,
    existingFiles,
    pythonManager,
    wsgiModule,
    goBuildPath,
    binaryName,
    nodeVersion,
    hasNodeLifecycleScripts,
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

const NODE_FRAMEWORKS = new Set<Framework>([
  "nextjs",
  "nuxt",
  "svelte",
  "express",
  "nestjs",
  "nodejs",
  "react",
  "vue",
  "vite",
  "angular",
  "astro",
  "remix",
  "gatsby",
  "fastify",
  "koa",
  "hono",
]);

// npm packages that compile native code via node-gyp on install and therefore
// need python3/make/g++ in the image running the install step.
const NATIVE_NODE_MODULE_HINTS =
  /better-sqlite3|\bsqlite3\b|bcrypt(?!js)|argon2|\bcanvas\b|node-sass|serialport|leveldown|classic-level|\bre2\b|zeromq|robotjs|keytar|node-pty|cpu-features|isolated-vm|bufferutil|utf-8-validate|node-rdkafka|couchbase|oracledb|\bsnappy\b|lzma-native|node-libcurl|node-expat|deasync|microtime|\bgrpc\b/i;

function nodeGypLine(analysis: AnalysisResult, nodeImage: string): string {
  const joined = (analysis.dependencies ?? []).join(" ").toLowerCase();
  if (!NATIVE_NODE_MODULE_HINTS.test(joined)) return "";
  return nodeImage.includes("alpine")
    ? "RUN apk add --no-cache python3 make g++\n"
    : "RUN apt-get update && apt-get install -y --no-install-recommends \\\n    python3 make g++ && rm -rf /var/lib/apt/lists/*\n";
}

function pythonDepsBlock(analysis: AnalysisResult, extraPipPackages = ""): string {
  const rootFiles = analysis.rootFiles ?? [];
  const extras = extraPipPackages
    ? `\nRUN pip install --no-cache-dir ${extraPipPackages}`
    : "";

  switch (analysis.pythonManager ?? "pip") {
    case "poetry":
      return `COPY pyproject.toml poetry.lock* ./
RUN pip install --no-cache-dir poetry && \\
    poetry config virtualenvs.create false && \\
    poetry install --no-interaction --no-ansi --no-root --only main${extras}`;
    case "uv":
      return `COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && \\
    uv export --frozen --no-dev --no-emit-project -o requirements.txt && \\
    pip install --no-cache-dir -r requirements.txt${extras}`;
    case "pipenv":
      return `COPY Pipfile Pipfile.lock* ./
RUN pip install --no-cache-dir pipenv && \\
    pipenv install --system ${rootFiles.includes("Pipfile.lock") ? "--deploy" : "--skip-lock"}${extras}`;
    case "pdm":
      return `COPY pyproject.toml pdm.lock* ./
RUN pip install --no-cache-dir pdm && \\
    pdm export --prod --without-hashes -o requirements.txt && \\
    pip install --no-cache-dir -r requirements.txt${extras}`;
    default:
      if (rootFiles.length && !rootFiles.includes("requirements.txt")) {
        // pyproject-based project without a lockfile: install the package itself.
        return `COPY . .
RUN pip install --no-cache-dir .${extras}`;
      }
      return `COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt${extraPipPackages ? ` ${extraPipPackages}` : ""}`;
  }
}

const PYTHON_APT_DEPS = `RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev && rm -rf /var/lib/apt/lists/*`;

const NGINX_STATIC_FIND = `RUN set -e; \\
    OUT=$(find dist build out public -name index.html -not -path '*/node_modules/*' 2>/dev/null | head -1); \\
    test -n "$OUT" || { echo "No index.html found in dist/, build/, out/, or public/" >&2; exit 1; }; \\
    mkdir -p /static && cp -r "$(dirname "$OUT")"/. /static/`;

function nginxServeBlock(port: number): string {
  return `RUN printf 'server { listen ${port}; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' \\
    > /etc/nginx/conf.d/default.conf`;
}

const GRADLE_BOOT_JAR_BUILD = `RUN gradle bootJar --no-daemon -x test || gradle jar --no-daemon -x test
RUN set -e; \\
    BOOT_JAR=$(find /app -type f -path '*/build/libs/*.jar' ! -name '*-plain.jar' -exec du -b {} + | sort -rn | head -1 | cut -f2-); \\
    test -f "$BOOT_JAR"; \\
    cp "$BOOT_JAR" /app/application.jar`;

const GRADLE_BOOT_JAR_COPY = `COPY --from=builder /app/application.jar app.jar`;

export function generateDockerfile(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string {
  const v =
    customizations.baseImageVersion ??
    (analysis.framework === "dotnet"
      ? analysis.dotnetSdkVersion
      : NODE_FRAMEWORKS.has(analysis.framework)
        ? analysis.nodeVersion || undefined
        : undefined);
  const images = getBaseImage(analysis.framework, analysis.language, v);
  const repo = analysis.repoName;
  const copyDeps = dependencyCopyLine(analysis.rootFiles ?? []);
  const install = installCmd(analysis.packageManager, analysis.rootFiles ?? []);
  const build = buildCmd(analysis.packageManager);
  const gyp = NODE_FRAMEWORKS.has(analysis.framework)
    ? nodeGypLine(analysis, images.node)
    : "";
  // Lifecycle scripts (postinstall etc.) reference repo files, so the
  // manifest-only COPY would make the install fail — copy everything instead.
  const depsCopy = analysis.hasNodeLifecycleScripts ? "COPY . ." : copyDeps;

  switch (analysis.framework) {
    case "nextjs":
      return `# Stage 1: Dependencies
FROM ${images.node} AS deps
WORKDIR /app
${gyp}${depsCopy}
${install}

# Stage 2: Build
FROM ${images.node} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${build}

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
${PYTHON_APT_DEPS}
${pythonDepsBlock(analysis, "gunicorn")}
COPY . .
RUN python manage.py collectstatic --noinput || true
EXPOSE ${customizations.port ?? analysis.port}
CMD ["gunicorn", "--bind", "0.0.0.0:${customizations.port ?? analysis.port}", "${analysis.wsgiModule || `${repo}.wsgi:application`}"]
`;
    case "fastapi":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
${PYTHON_APT_DEPS}
${pythonDepsBlock(analysis, "uvicorn")}
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["uvicorn", "${analysis.wsgiModule || "main:app"}", "--host", "0.0.0.0", "--port", "${customizations.port ?? analysis.port}"]
`;
    case "flask":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
${pythonDepsBlock(analysis, "gunicorn")}
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["gunicorn", "--bind", "0.0.0.0:${customizations.port ?? analysis.port}", "${analysis.wsgiModule || "app:app"}"]
`;
    case "python":
      return `FROM ${images.python}
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
WORKDIR /app
${pythonDepsBlock(analysis)}
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["python", "${(analysis.rootFiles ?? []).includes("main.py") ? "main.py" : "app.py"}"]
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
${GRADLE_BOOT_JAR_BUILD}
FROM ${images.jre}
WORKDIR /app
${GRADLE_BOOT_JAR_COPY}
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
RUN CGO_ENABLED=0 GOOS=linux go build -o app -a -ldflags '-extldflags "-static"' "${analysis.goBuildPath || "."}"
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
COPY --from=builder /app/target/release/${analysis.binaryName || repo} app
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
    case "dotnet": {
      const projectPath = dotnetContextPath(
        analysis,
        analysis.dotnetProject || `${repo}.csproj`,
      );
      const restoreTarget = analysis.dotnetSolution
        ? `"${dotnetContextPath(analysis, analysis.dotnetSolution)}"`
        : `"${projectPath}"`;
      const dllName = path.posix.basename(projectPath, ".csproj");

      return `FROM ${images.dotnetSdk} AS builder
WORKDIR /app
COPY . .
RUN dotnet restore ${restoreTarget}
RUN dotnet publish "${projectPath}" -c Release -o /app/out
FROM ${images.dotnetAsp}
WORKDIR /app
COPY --from=builder /app/out .
ENV ASPNETCORE_URLS=http://+:${customizations.port ?? analysis.port}
EXPOSE ${customizations.port ?? analysis.port}
ENTRYPOINT ["dotnet", "${dllName}.dll"]
`;
    }
    case "express":
    case "nestjs":
    case "nodejs":
    case "fastify":
    case "koa":
    case "hono":
      return `FROM ${images.node} AS deps
WORKDIR /app
${gyp}${depsCopy}
${install}

FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE ${customizations.port ?? analysis.port}
CMD ["npm", "start"]
`;
    case "react":
    case "vue":
    case "vite":
    case "angular":
    case "gatsby": {
      const port = customizations.port ?? analysis.port;
      return `# Stage 1: Build static assets
FROM ${images.node} AS builder
WORKDIR /app
${gyp}${depsCopy}
${install}
COPY . .
${build}
${NGINX_STATIC_FIND}

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /static /usr/share/nginx/html
${nginxServeBlock(port)}
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
    }
    case "astro": {
      const port = customizations.port ?? analysis.port;
      if (analysis.entrypoint === "./dist/server/entry.mjs") {
        return `# Stage 1: Dependencies
FROM ${images.node} AS deps
WORKDIR /app
${gyp}${depsCopy}
${install}

# Stage 2: Build
FROM ${images.node} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${build}

# Stage 3: Runner
FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE ${port}
ENV HOST=0.0.0.0
ENV PORT=${port}
CMD ["node", "./dist/server/entry.mjs"]
`;
      }
      return `# Stage 1: Build static assets
FROM ${images.node} AS builder
WORKDIR /app
${gyp}${depsCopy}
${install}
COPY . .
${build}
${NGINX_STATIC_FIND}

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /static /usr/share/nginx/html
${nginxServeBlock(port)}
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
    }
    case "remix":
      return `FROM ${images.node} AS builder
WORKDIR /app
${gyp}${depsCopy}
${install}
COPY . .
${build}

FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE ${customizations.port ?? analysis.port}
ENV PORT=${customizations.port ?? analysis.port}
CMD ["npm", "run", "start"]
`;
    case "sinatra":
    case "ruby": {
      const port = customizations.port ?? analysis.port;
      const rootFiles = analysis.rootFiles ?? [];
      const cmd = rootFiles.includes("config.ru")
        ? `CMD ["bundle", "exec", "rackup", "--host", "0.0.0.0", "-p", "${port}"]`
        : `CMD ["bundle", "exec", "ruby", "${rootFiles.includes("main.rb") ? "main.rb" : "app.rb"}"]`;
      return `FROM ${images.ruby}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev && rm -rf /var/lib/apt/lists/*
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
EXPOSE ${port}
${cmd}
`;
    }
    case "symfony":
    case "php": {
      const port = customizations.port ?? analysis.port;
      const docRoot =
        analysis.framework === "symfony" ||
        !(analysis.rootFiles ?? []).includes("index.php")
          ? "public"
          : ".";
      return `FROM ${images.php}
WORKDIR /var/www
RUN apk add --no-cache \\
    postgresql-dev libpng-dev libzip-dev zip unzip \\
    && docker-php-ext-install pdo pdo_pgsql zip
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock* ./
RUN composer install --no-dev --optimize-autoloader --no-scripts --no-interaction
COPY . .
EXPOSE ${port}
CMD ["php", "-S", "0.0.0.0:${port}", "-t", "${docRoot}"]
`;
    }
    case "dart":
      return `FROM dart:stable AS builder
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN set -e; \\
    TARGET=$(ls bin/*.dart 2>/dev/null | head -1); \\
    test -n "$TARGET" || { echo "No entry script found in bin/" >&2; exit 1; }; \\
    dart compile exe "$TARGET" -o /app/server

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/server ./server
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./server"]
`;
    case "clojure": {
      const port = customizations.port ?? analysis.port;
      if ((analysis.rootFiles ?? []).includes("project.clj")) {
        return `FROM clojure:temurin-17-lein AS builder
WORKDIR /app
COPY project.clj ./
RUN lein deps
COPY . .
RUN lein uberjar

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/uberjar/*-standalone.jar app.jar
EXPOSE ${port}
CMD ["java", "-jar", "app.jar"]
`;
      }
      return `FROM clojure:temurin-17-tools-deps
WORKDIR /app
COPY deps.edn ./
RUN clojure -P
COPY . .
EXPOSE ${port}
# Adjust -m to your main namespace if it differs.
CMD ["clojure", "-M", "-m", "${repo}.core"]
`;
    }
    case "cmake":
      return `FROM gcc:13 AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    cmake ninja-build && rm -rf /var/lib/apt/lists/*
COPY . .
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
RUN set -e; \\
    BIN=$(find build -maxdepth 3 -type f -perm -u+x ! -name '*.so*' ! -name '*.a' ! -name 'CMake*' ! -name '*.cmake' | head -1); \\
    test -n "$BIN" || { echo "No built executable found under build/" >&2; exit 1; }; \\
    cp "$BIN" /app/server

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/server ./server
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./server"]
`;
    case "static": {
      const port = customizations.port ?? analysis.port;
      return `FROM nginx:alpine
COPY . /usr/share/nginx/html
${nginxServeBlock(port)}
EXPOSE ${port}
CMD ["nginx", "-g", "daemon off;"]
`;
    }
    case "nuxt":
      return `# Stage 1: Dependencies
FROM ${images.node} AS deps
WORKDIR /app
${gyp}${depsCopy}
${install}

# Stage 2: Build
FROM ${images.node} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${build}

# Stage 3: Runner
FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs && adduser -S nuxtjs -u 1001
COPY --from=builder /app/.output ./.output
USER nuxtjs
EXPOSE ${customizations.port ?? analysis.port}
ENV PORT=${customizations.port ?? analysis.port}
ENV HOST=0.0.0.0
CMD ["node", ".output/server/index.mjs"]
`;
    case "svelte":
      return `FROM ${images.node} AS builder
WORKDIR /app
${gyp}${depsCopy}
${install}
COPY . .
${build}

FROM ${images.node} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
EXPOSE ${customizations.port ?? analysis.port}
CMD ["npm", "start"]
`;
    case "phoenix":
    case "elixir":
      return `FROM elixir:1.16-alpine AS builder
WORKDIR /app
RUN apk add --no-cache build-base git
COPY mix.exs mix.lock* ./
RUN mix local.hex --force && mix local.rebar --force
RUN mix deps.get --only prod
COPY . .
RUN MIX_ENV=prod mix compile && mix release

FROM alpine:latest
WORKDIR /app
RUN apk add --no-cache openssl ncurses-libs libstdc++
COPY --from=builder /app/_build/prod/rel/*/ ./
EXPOSE ${customizations.port ?? analysis.port}
ENV PORT=${customizations.port ?? analysis.port}
CMD ["bin/server", "start"]
`;
    case "scala":
      return `FROM eclipse-temurin:17-jdk-alpine AS builder
WORKDIR /app
COPY build.sbt ./
COPY project ./project
RUN sbt update
COPY . .
RUN sbt stage

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/universal/stage ./
EXPOSE ${customizations.port ?? analysis.port}
CMD ["bin/main"]
`;
    case "kotlin":
      return `FROM ${images.gradle} AS builder
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts gradle.properties* ./
COPY gradle ./gradle
COPY gradlew gradlew.bat ./
RUN gradle dependencies --no-daemon || true
COPY . .
${GRADLE_BOOT_JAR_BUILD}

FROM ${images.jre}
WORKDIR /app
${GRADLE_BOOT_JAR_COPY}
EXPOSE ${customizations.port ?? analysis.port}
CMD ["java", "-jar", "app.jar"]
`;
    case "deno":
      return `FROM denoland/deno:alpine
WORKDIR /app
COPY deno.json deno.jsonc* ./
COPY . .
RUN deno cache main.ts || true
EXPOSE ${customizations.port ?? analysis.port}
CMD ["deno", "run", "--allow-net", "--allow-read", "main.ts"]
`;
    case "swift":
      return `FROM swift:5.10-jammy AS builder
WORKDIR /app
COPY Package.swift Package.resolved* ./
COPY Sources ./Sources
RUN swift build -c release

FROM ubuntu:22.04
WORKDIR /app
COPY --from=builder /app/.build/release/* /app/server
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./server"]
`;
    case "haskell":
      return `FROM haskell:9.6 AS builder
WORKDIR /app
COPY stack.yaml package.yaml ./
RUN stack update && stack build --dependencies-only || true
COPY . .
RUN stack install --local-bin-path /app/bin

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /app/bin/* /app/server
EXPOSE ${customizations.port ?? analysis.port}
CMD ["./server"]
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
  "nuxt",
  "svelte",
  "express",
  "nestjs",
  "nodejs",
  "remix",
  "astro",
  "fastify",
  "koa",
  "hono",
  "django",
  "fastapi",
  "flask",
  "python",
  "rails",
  "sinatra",
  "ruby",
  "laravel",
  "symfony",
  "php",
  "phoenix",
  "elixir",
  "spring-boot",
  "dotnet",
  "deno",
  "dart",
  "clojure",
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
  const activeServices = resolveComposeServices(
    analysis.services,
    enabled,
    customizations.databaseMode ?? "bundled",
  );
  const repo = analysis.repoName;

  // For monorepos the Dockerfile's COPY paths are relative to the backend
  // subdirectory, so the build context must point there. The Dockerfile itself
  // lives at the repo root (where generated files are written), which compose
  // supports via a context-escaping dockerfile path. .NET templates are the
  // exception: they COPY the whole repo and prefix paths with the subdir.
  const backendContext =
    analysis.framework !== "dotnet"
      ? (analysis.backendSubdir || "").replace(/\\/g, "/")
      : "";
  const buildBlock = backendContext
    ? `    build:\n      context: ./${backendContext}\n      dockerfile: ${"../".repeat(backendContext.split("/").length)}Dockerfile\n`
    : `    build: .\n`;

  let yaml = `services:\n  app:\n${buildBlock}    container_name: ${repo}-app\n    ports:\n      - "${port}:${port}"\n    restart: unless-stopped\n`;

  if (ENV_FRAMEWORKS.has(analysis.framework) || analysis.envVars.length) {
    yaml += `    env_file:\n      - .env\n`;
  }

  if (customizations.extraEnv && Object.keys(customizations.extraEnv).length) {
    yaml += `    environment:\n`;
    for (const [key, value] of Object.entries(customizations.extraEnv)) {
      // compose interpolates $ in the compose file itself; $$ emits a literal $.
      const safe = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\$/g, "$$$$");
      yaml += `      ${key}: "${safe}"\n`;
    }
  }

  if (activeServices.length) {
    yaml += `    depends_on:\n`;
    for (const svc of activeServices) {
      yaml += `      ${svc.name}:\n        condition: ${
        svc.healthcheck ? "service_healthy" : "service_started"
      }\n`;
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
    if (svc.healthcheck) {
      const test = svc.healthcheck.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      yaml += `    healthcheck:\n      test: ["CMD-SHELL", "${test}"]\n      interval: 5s\n      timeout: 5s\n      retries: 12\n`;
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

export function generateEnvExample(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string | null {
  const effectiveVars = buildEffectiveEnvVars(analysis, customizations);
  if (!effectiveVars.length) return null;
  const resolved = applyEnvValues(
    effectiveVars,
    customizations.envValues,
    customizations.extraEnv,
  );
  return formatEnvFile(resolved, customizations.envValues, true);
}

export function generateEnv(
  analysis: AnalysisResult,
  customizations: Customizations = {},
): string | null {
  const example = generateEnvExample(analysis, customizations);
  if (!example) return null;
  const effectiveVars = buildEffectiveEnvVars(analysis, customizations);
  const resolved = applyEnvValues(
    effectiveVars,
    customizations.envValues,
    customizations.extraEnv,
  );
  return formatEnvFile(resolved, customizations.envValues, false);
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
    evictOldestCacheEntry();
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
