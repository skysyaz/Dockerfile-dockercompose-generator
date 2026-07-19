import * as fs from "fs/promises";
import * as path from "path";
import type { DetectedService, Framework } from "./types";

export type EnvVarCategory =
  | "database"
  | "cache"
  | "secret"
  | "auth"
  | "framework"
  | "config"
  | "other";

export type EnvVarSource =
  | "env-example"
  | "appsettings"
  | "application-config"
  | "django-settings"
  | "source-scan"
  | "dependency-inference"
  | "framework-default";

export interface DiscoveredEnvVar {
  key: string;
  suggestedValue: string;
  category: EnvVarCategory;
  source: EnvVarSource;
  required: boolean;
  description?: string;
  sensitive?: boolean;
}

export type DatabaseMode = "bundled" | "external";

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
  ".idea",
  ".vscode",
]);

const DATABASE_SERVICES = new Set(["postgres", "mysql", "mongodb"]);
export const EXTERNAL_DB_HOST = "your-db-host";

const ENV_FILE_NAMES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.dist",
  ".env.local.example",
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".php",
  ".go",
  ".java",
  ".kt",
  ".cs",
  ".rs",
  ".ex",
  ".exs",
  ".swift",
  ".scala",
  ".vue",
  ".svelte",
]);

const ENV_SCAN_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/gi,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi,
  /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi,
  /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi,
  /getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi,
  /Environment\.GetEnvironmentVariable\(\s*["']([A-Z_][A-Z0-9_]*)["']/gi,
  /env\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi,
  /ENV\[['"]([A-Z_][A-Z0-9_]*)['"]\]/gi,
  /ENV\.fetch\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi,
  /Sys\.getenv\(\s*["']([A-Z_][A-Z0-9_]*)["']/gi,
];

const SECRET_KEY_HINTS =
  /secret|password|passwd|token|api[_-]?key|private|credential|auth/i;
const DATABASE_KEY_HINTS =
  /database|db_|postgres|mysql|mongo|redis|datasource|connectionstring/i;

function categorizeKey(key: string): EnvVarCategory {
  const upper = key.toUpperCase();
  if (DATABASE_KEY_HINTS.test(key)) {
    if (/redis|cache/i.test(key)) return "cache";
    if (/mongo|postgres|mysql|database|db_|datasource|connectionstring/i.test(key)) {
      return "database";
    }
  }
  if (/redis|cache/i.test(key)) return "cache";
  if (SECRET_KEY_HINTS.test(key)) return "secret";
  if (/jwt|oauth|auth|session/i.test(key)) return "auth";
  if (
    /^(NODE_ENV|PORT|HOST|APP_ENV|RAILS_ENV|ASPNETCORE_|SPRING_|DJANGO_|APP_KEY|APP_URL)/i.test(
      upper,
    )
  ) {
    return "framework";
  }
  return "config";
}

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_HINTS.test(key);
}

function isRequiredKey(key: string): boolean {
  if (SECRET_KEY_HINTS.test(key)) return true;
  if (/^DB_|DATABASE_|CONNECTIONSTRINGS__|SPRING_DATASOURCE_/i.test(key)) return true;
  if (/^(JWT_|API_KEY|SECRET_KEY|APP_KEY|RAILS_MASTER_KEY)/i.test(key)) return true;
  return false;
}

function placeholderForKey(key: string): string {
  if (/password|passwd|secret|token|api[_-]?key|private|credential/i.test(key)) {
    return "change-me-please";
  }
  if (/host|hostname|server/i.test(key) && DATABASE_KEY_HINTS.test(key)) {
    return EXTERNAL_DB_HOST;
  }
  if (/url|uri|connection/i.test(key) && DATABASE_KEY_HINTS.test(key)) {
    return "postgresql://user:password@your-db-host:5432/dbname";
  }
  if (/user(name)?$/i.test(key)) return "app";
  if (/database|dbname/i.test(key)) return "app";
  if (/port/i.test(key)) return "5432";
  return "";
}

function upsertVar(
  map: Map<string, DiscoveredEnvVar>,
  entry: DiscoveredEnvVar,
  priority: number,
  priorities: Map<string, number>,
): void {
  const current = priorities.get(entry.key) ?? -1;
  if (!map.has(entry.key) || priority >= current) {
    map.set(entry.key, entry);
    priorities.set(entry.key, priority);
  }
}

function parseEnvFile(content: string): Array<{ key: string; value: string }> {
  const vars: Array<{ key: string; value: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars.push({ key: match[1], value });
  }
  return vars;
}

function flattenJson(
  obj: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = [];
  for (const [name, value] of Object.entries(obj)) {
    const envKey = prefix ? `${prefix}__${name}` : name;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      results.push(
        ...flattenJson(value as Record<string, unknown>, envKey),
      );
    } else if (typeof value === "string" || typeof value === "number") {
      results.push({ key: envKey.replace(/\./g, "__"), value: String(value) });
    }
  }
  return results;
}

function parseProperties(content: string): Array<{ key: string; value: string }> {
  const vars: Array<{ key: string; value: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const idx = trimmed.indexOf("=");
    const colonIdx = trimmed.indexOf(":");
    const splitAt =
      idx === -1 ? colonIdx : colonIdx === -1 ? idx : Math.min(idx, colonIdx);
    if (splitAt === -1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim();
    if (!key) continue;
    vars.push({
      key: key.replace(/\./g, "_").replace(/-/g, "_").toUpperCase(),
      value,
    });
  }
  return vars;
}

function parseYamlEnvHints(content: string): Array<{ key: string; value: string }> {
  const vars: Array<{ key: string; value: string }> = [];
  const springPatterns: Array<[RegExp, string]> = [
    [/^\s*url:\s*(.+)$/im, "SPRING_DATASOURCE_URL"],
    [/^\s*username:\s*(.+)$/im, "SPRING_DATASOURCE_USERNAME"],
    [/^\s*password:\s*(.+)$/im, "SPRING_DATASOURCE_PASSWORD"],
    [/^\s*driver-class-name:\s*(.+)$/im, "SPRING_DATASOURCE_DRIVER_CLASS_NAME"],
    [/^\s*redis:\s*[\s\S]*?host:\s*(.+)$/im, "SPRING_REDIS_HOST"],
    [/^\s*redis:\s*[\s\S]*?port:\s*(\d+)/im, "SPRING_REDIS_PORT"],
  ];

  for (const [pattern, key] of springPatterns) {
    const match = content.match(pattern);
    if (match?.[1]) {
      vars.push({ key, value: match[1].trim().replace(/^['"]|['"]$/g, "") });
    }
  }

  const generic = content.matchAll(/^\s{0,4}([A-Z][A-Z0-9_]*):\s*(.+)$/gm);
  for (const match of generic) {
    vars.push({
      key: match[1],
      value: match[2].trim().replace(/^['"]|['"]$/g, ""),
    });
  }

  return vars;
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

async function findEnvExampleFiles(workDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ENV_FILE_NAMES) {
    const filePath = path.join(workDir, name);
    if (await fileExists(filePath)) found.push(filePath);
  }
  return found;
}

async function scanSourceFiles(
  dir: string,
  depth = 0,
  budget = { remaining: 250 },
): Promise<string[]> {
  if (depth > 4 || budget.remaining <= 0) return [];
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.has(ext)) {
        results.push(full);
        budget.remaining -= 1;
      }
    } else if (entry.isDirectory()) {
      results.push(...(await scanSourceFiles(full, depth + 1, budget)));
    }
  }
  return results;
}

function varsFromParsed(
  parsed: Array<{ key: string; value: string }>,
  source: EnvVarSource,
  priority: number,
  map: Map<string, DiscoveredEnvVar>,
  priorities: Map<string, number>,
): void {
  for (const { key, value } of parsed) {
    upsertVar(
      map,
      {
        key,
        suggestedValue: value || placeholderForKey(key),
        category: categorizeKey(key),
        source,
        required: isRequiredKey(key),
        sensitive: isSensitiveKey(key),
        description:
          source === "env-example"
            ? "Found in repository .env example"
            : undefined,
      },
      priority,
      priorities,
    );
  }
}

function frameworkDatabaseVars(
  framework: Framework,
  services: DetectedService[],
  databaseMode: DatabaseMode,
): DiscoveredEnvVar[] {
  const vars: DiscoveredEnvVar[] = [];
  const host = databaseMode === "external" ? EXTERNAL_DB_HOST : undefined;
  const hasPostgres = services.some((s) => s.name === "postgres");
  const hasMysql = services.some((s) => s.name === "mysql");
  const hasMongo = services.some((s) => s.name === "mongodb");
  const hasRedis = services.some((s) => s.name === "redis");

  const dbHost = host ?? "postgres";
  const mysqlHost = host ?? "mysql";
  const mongoHost = host ?? "mongodb";
  const redisHost = host ?? "redis";

  if (hasPostgres) {
    if (framework === "dotnet") {
      vars.push({
        key: "ConnectionStrings__DefaultConnection",
        suggestedValue:
          databaseMode === "external"
            ? `Host=${EXTERNAL_DB_HOST};Port=5432;Database=app;Username=app;Password=change-me-please`
            : "Host=postgres;Port=5432;Database=app;Username=app;Password=app",
        category: "database",
        source: "framework-default",
        required: true,
        description: ".NET PostgreSQL connection string",
      });
    } else if (
      framework === "spring-boot" ||
      framework === "java-maven" ||
      framework === "java-gradle" ||
      framework === "kotlin"
    ) {
      vars.push(
        {
          key: "SPRING_DATASOURCE_URL",
          suggestedValue:
            databaseMode === "external"
              ? `jdbc:postgresql://${EXTERNAL_DB_HOST}:5432/app`
              : "jdbc:postgresql://postgres:5432/app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "SPRING_DATASOURCE_USERNAME",
          suggestedValue: "app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "SPRING_DATASOURCE_PASSWORD",
          suggestedValue: databaseMode === "external" ? "change-me-please" : "app",
          category: "database",
          source: "framework-default",
          required: true,
          sensitive: true,
        },
      );
    } else if (framework === "laravel" || framework === "php") {
      vars.push(
        {
          key: "DB_CONNECTION",
          suggestedValue: "pgsql",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_HOST",
          suggestedValue: dbHost,
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_PORT",
          suggestedValue: "5432",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_DATABASE",
          suggestedValue: "app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_USERNAME",
          suggestedValue: "app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_PASSWORD",
          suggestedValue: databaseMode === "external" ? "change-me-please" : "app",
          category: "database",
          source: "framework-default",
          required: true,
          sensitive: true,
        },
      );
    } else if (framework === "rails" || framework === "ruby") {
      vars.push(
        {
          key: "DATABASE_URL",
          suggestedValue:
            databaseMode === "external"
              ? `postgresql://app:change-me-please@${EXTERNAL_DB_HOST}:5432/app`
              : "postgresql://app:app@postgres:5432/app",
          category: "database",
          source: "framework-default",
          required: true,
          sensitive: true,
        },
      );
    } else if (framework === "django") {
      vars.push(
        {
          key: "DATABASE_URL",
          suggestedValue:
            databaseMode === "external"
              ? `postgresql://app:change-me-please@${EXTERNAL_DB_HOST}:5432/app`
              : "postgresql://app:app@postgres:5432/app",
          category: "database",
          source: "framework-default",
          required: true,
          sensitive: true,
        },
      );
    } else {
      vars.push({
        key: "DATABASE_URL",
        suggestedValue:
          databaseMode === "external"
            ? `postgresql://app:change-me-please@${EXTERNAL_DB_HOST}:5432/app`
            : "postgresql://app:app@postgres:5432/app",
        category: "database",
        source: "dependency-inference",
        required: true,
        sensitive: true,
      });
    }
  }

  if (hasMysql) {
    if (framework === "laravel" || framework === "php") {
      vars.push(
        {
          key: "DB_CONNECTION",
          suggestedValue: "mysql",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_HOST",
          suggestedValue: mysqlHost,
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_PORT",
          suggestedValue: "3306",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_DATABASE",
          suggestedValue: "app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_USERNAME",
          suggestedValue: "app",
          category: "database",
          source: "framework-default",
          required: true,
        },
        {
          key: "DB_PASSWORD",
          suggestedValue: databaseMode === "external" ? "change-me-please" : "app",
          category: "database",
          source: "framework-default",
          required: true,
          sensitive: true,
        },
      );
    } else if (framework === "dotnet") {
      vars.push({
        key: "ConnectionStrings__DefaultConnection",
        suggestedValue:
          databaseMode === "external"
            ? `Server=${EXTERNAL_DB_HOST};Port=3306;Database=app;User=app;Password=change-me-please`
            : "Server=mysql;Port=3306;Database=app;User=app;Password=app",
        category: "database",
        source: "framework-default",
        required: true,
      });
    } else {
      vars.push({
        key: "DATABASE_URL",
        suggestedValue:
          databaseMode === "external"
            ? `mysql://app:change-me-please@${EXTERNAL_DB_HOST}:3306/app`
            : "mysql://app:app@mysql:3306/app",
        category: "database",
        source: "dependency-inference",
        required: true,
        sensitive: true,
      });
    }
  }

  if (hasMongo) {
    vars.push({
      key: "MONGO_URL",
      suggestedValue:
        databaseMode === "external"
          ? `mongodb://app:change-me-please@${EXTERNAL_DB_HOST}:27017/app`
          : "mongodb://app:app@mongodb:27017/app",
      category: "database",
      source: "dependency-inference",
      required: true,
      sensitive: true,
    });
  }

  if (hasRedis) {
    vars.push({
      key: "REDIS_URL",
      suggestedValue:
        databaseMode === "external"
          ? `redis://${EXTERNAL_DB_HOST}:6379`
          : "redis://redis:6379",
      category: "cache",
      source: "dependency-inference",
      required: false,
    });
  }

  return vars;
}

function frameworkDefaults(
  framework: Framework,
  port: number,
  repoName: string,
): DiscoveredEnvVar[] {
  const vars: DiscoveredEnvVar[] = [];
  const push = (entry: DiscoveredEnvVar) => vars.push(entry);

  switch (framework) {
    case "nextjs":
    case "nodejs":
    case "express":
    case "nestjs":
      push({
        key: "NODE_ENV",
        suggestedValue: "production",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "PORT",
        suggestedValue: String(port),
        category: "framework",
        source: "framework-default",
        required: true,
      });
      break;
    case "django":
      push({
        key: "DJANGO_SETTINGS_MODULE",
        suggestedValue: `${repoName}.settings`,
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "DJANGO_DEBUG",
        suggestedValue: "False",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "DJANGO_SECRET_KEY",
        suggestedValue: "change-me-please",
        category: "secret",
        source: "framework-default",
        required: true,
        sensitive: true,
      });
      break;
    case "flask":
    case "fastapi":
    case "python":
      push({
        key: "APP_ENV",
        suggestedValue: "production",
        category: "framework",
        source: "framework-default",
        required: false,
      });
      push({
        key: "PORT",
        suggestedValue: String(port),
        category: "framework",
        source: "framework-default",
        required: true,
      });
      break;
    case "rails":
      push({
        key: "RAILS_ENV",
        suggestedValue: "production",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "RAILS_LOG_TO_STDOUT",
        suggestedValue: "true",
        category: "framework",
        source: "framework-default",
        required: false,
      });
      push({
        key: "RAILS_SERVE_STATIC_FILES",
        suggestedValue: "true",
        category: "framework",
        source: "framework-default",
        required: false,
      });
      push({
        key: "RAILS_MASTER_KEY",
        suggestedValue: "change-me-please",
        category: "secret",
        source: "framework-default",
        required: true,
        sensitive: true,
      });
      break;
    case "laravel":
      push({
        key: "APP_ENV",
        suggestedValue: "production",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "APP_KEY",
        suggestedValue: "base64:change-me-please",
        category: "secret",
        source: "framework-default",
        required: true,
        sensitive: true,
      });
      push({
        key: "APP_DEBUG",
        suggestedValue: "false",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "APP_URL",
        suggestedValue: `http://localhost:${port}`,
        category: "framework",
        source: "framework-default",
        required: false,
      });
      break;
    case "spring-boot":
      push({
        key: "SPRING_PROFILES_ACTIVE",
        suggestedValue: "production",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "SERVER_PORT",
        suggestedValue: String(port),
        category: "framework",
        source: "framework-default",
        required: true,
      });
      break;
    case "dotnet":
      push({
        key: "ASPNETCORE_ENVIRONMENT",
        suggestedValue: "Production",
        category: "framework",
        source: "framework-default",
        required: true,
      });
      push({
        key: "ASPNETCORE_URLS",
        suggestedValue: `http://+:${port}`,
        category: "framework",
        source: "framework-default",
        required: true,
      });
      break;
    default:
      break;
  }

  return vars;
}

export function isDatabaseService(name: string): boolean {
  return DATABASE_SERVICES.has(name);
}

export function resolveComposeServices(
  services: DetectedService[],
  enabled: Set<string>,
  databaseMode: DatabaseMode,
): DetectedService[] {
  return services.filter((service) => {
    if (!enabled.has(service.name)) return false;
    if (databaseMode === "external" && isDatabaseService(service.name)) {
      return false;
    }
    return true;
  });
}

export function formatEnvFile(
  vars: DiscoveredEnvVar[],
  values: Record<string, string> = {},
  withComments = true,
): string {
  const lines: string[] = [];
  const push = (line: string) => lines.push(line);

  if (withComments) {
    push("# Copy this file to .env and adjust values for your environment.");
    push("# Lines beginning with # are comments. Do NOT commit the real .env file.");
    push("");
  }

  const categories: EnvVarCategory[] = [
    "database",
    "cache",
    "auth",
    "secret",
    "framework",
    "config",
    "other",
  ];

  const grouped = new Map<EnvVarCategory, DiscoveredEnvVar[]>();
  for (const variable of vars) {
    const list = grouped.get(variable.category) ?? [];
    list.push(variable);
    grouped.set(variable.category, list);
  }

  for (const category of categories) {
    const items = grouped.get(category);
    if (!items?.length) continue;
    if (withComments) {
      push(`# ${category.charAt(0).toUpperCase()}${category.slice(1)}`);
    }
    for (const variable of items) {
      if (withComments && variable.description) {
        push(`# ${variable.description}`);
      }
      const value = values[variable.key] ?? variable.suggestedValue;
      push(`${variable.key}=${value}`);
    }
    push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export async function discoverEnvVars(
  workDir: string,
  options: {
    framework: Framework;
    services: DetectedService[];
    repoName: string;
    port: number;
    databaseMode?: DatabaseMode;
  },
): Promise<DiscoveredEnvVar[]> {
  const map = new Map<string, DiscoveredEnvVar>();
  const priorities = new Map<string, number>();
  const databaseMode = options.databaseMode ?? "bundled";

  for (const envFile of await findEnvExampleFiles(workDir)) {
    const content = await readText(envFile);
    if (!content) continue;
    varsFromParsed(parseEnvFile(content), "env-example", 100, map, priorities);
  }

  const appsettings = await readText(path.join(workDir, "appsettings.json"));
  if (appsettings) {
    try {
      const parsed = JSON.parse(appsettings) as Record<string, unknown>;
      varsFromParsed(
        flattenJson(parsed),
        "appsettings",
        90,
        map,
        priorities,
      );
    } catch {
      /* ignore invalid json */
    }
  }

  const appsettingsDev = await readText(
    path.join(workDir, "appsettings.Development.json"),
  );
  if (appsettingsDev) {
    try {
      const parsed = JSON.parse(appsettingsDev) as Record<string, unknown>;
      varsFromParsed(
        flattenJson(parsed),
        "appsettings",
        85,
        map,
        priorities,
      );
    } catch {
      /* ignore */
    }
  }

  for (const name of ["application.yml", "application.yaml", "application.properties"]) {
    const content = await readText(path.join(workDir, name));
    if (!content) continue;
    const parsed =
      name.endsWith(".properties")
        ? parseProperties(content)
        : parseYamlEnvHints(content);
    varsFromParsed(parsed, "application-config", 80, map, priorities);
  }

  const djangoSettings = await readText(path.join(workDir, "settings.py"));
  if (djangoSettings) {
    const djangoVars: Array<{ key: string; value: string }> = [];
    const envRefs = djangoSettings.matchAll(/os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gi);
    for (const match of envRefs) {
      djangoVars.push({ key: match[1], value: placeholderForKey(match[1]) });
    }
    varsFromParsed(djangoVars, "django-settings", 75, map, priorities);
  }

  const sourceFiles = await scanSourceFiles(workDir);
  const sourceKeys = new Set<string>();
  for (const filePath of sourceFiles) {
    const content = await readText(filePath);
    if (!content || content.length > 200_000) continue;
    for (const pattern of ENV_SCAN_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        sourceKeys.add(match[1]);
      }
    }
  }
  varsFromParsed(
    [...sourceKeys].map((key) => ({ key, value: placeholderForKey(key) })),
    "source-scan",
    60,
    map,
    priorities,
  );

  for (const variable of frameworkDatabaseVars(
    options.framework,
    options.services,
    databaseMode,
  )) {
    upsertVar(map, variable, 50, priorities);
  }

  for (const variable of frameworkDefaults(
    options.framework,
    options.port,
    options.repoName,
  )) {
    upsertVar(map, variable, 40, priorities);
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function applyEnvValues(
  vars: DiscoveredEnvVar[],
  envValues?: Record<string, string>,
  extraEnv?: Record<string, string>,
): DiscoveredEnvVar[] {
  const mergedValues = { ...envValues, ...extraEnv };
  if (!Object.keys(mergedValues).length) return vars;
  return vars.map((variable) => ({
    ...variable,
    suggestedValue: mergedValues[variable.key] ?? variable.suggestedValue,
  }));
}

export function buildEffectiveEnvVars(
  analysis: {
    framework: Framework;
    services: DetectedService[];
    repoName: string;
    port: number;
    envVars: DiscoveredEnvVar[];
  },
  customizations: {
    port?: number;
    databaseMode?: DatabaseMode;
  } = {},
): DiscoveredEnvVar[] {
  const databaseMode = customizations.databaseMode ?? "bundled";
  const port = customizations.port ?? analysis.port;
  const map = new Map<string, DiscoveredEnvVar>();

  const envExampleKeys = new Set(
    analysis.envVars
      .filter((variable) => variable.source === "env-example")
      .map((variable) => variable.key),
  );

  for (const variable of analysis.envVars) {
    if (
      variable.source === "framework-default" ||
      variable.source === "dependency-inference"
    ) {
      continue;
    }
    map.set(variable.key, variable);
  }

  for (const variable of frameworkDatabaseVars(
    analysis.framework,
    analysis.services,
    databaseMode,
  )) {
    if (!envExampleKeys.has(variable.key)) {
      map.set(variable.key, variable);
    }
  }

  for (const variable of frameworkDefaults(
    analysis.framework,
    port,
    analysis.repoName,
  )) {
    if (!map.has(variable.key)) map.set(variable.key, variable);
  }

  for (const variable of analysis.envVars) {
    if (!map.has(variable.key)) map.set(variable.key, variable);
  }

  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}
