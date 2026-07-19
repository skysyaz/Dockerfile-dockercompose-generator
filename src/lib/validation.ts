import type { DatabaseMode } from "./types";

const ALLOWED_BUILD_FILES = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  ".env.example",
  ".env",
]);

const BASE_IMAGE_PATTERN = /^[\w./:@-]+$/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/i;

export function isAllowedBuildFile(name: string): boolean {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return false;
  }
  return ALLOWED_BUILD_FILES.has(name);
}

export function sanitizeBaseImageVersion(version?: string): string | undefined {
  if (!version?.trim()) return undefined;
  const trimmed = version.trim();
  if (!BASE_IMAGE_PATTERN.test(trimmed) || trimmed.includes("\n")) {
    throw new Error("Invalid base image version format");
  }
  return trimmed;
}

export function sanitizeExtraEnv(
  extraEnv?: Record<string, string>,
): Record<string, string> | undefined {
  return sanitizeEnvMap(extraEnv, "environment variable");
}

export function sanitizeEnvValues(
  envValues?: Record<string, string>,
): Record<string, string> | undefined {
  return sanitizeEnvMap(envValues, "environment value");
}

function sanitizeEnvMap(
  values: Record<string, string> | undefined,
  label: string,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid ${label} name: ${key}`);
    }
    if (typeof value !== "string" || value.includes("\n")) {
      throw new Error(`Invalid ${label} for ${key}`);
    }
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length ? sanitized : undefined;
}

export function sanitizeDatabaseMode(mode?: string): DatabaseMode | undefined {
  if (!mode) return undefined;
  if (mode === "bundled" || mode === "external") return mode;
  throw new Error('databaseMode must be "bundled" or "external"');
}

export function sanitizePort(port?: number): number | undefined {
  if (port === undefined || port === null) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer between 1 and 65535");
  }
  return port;
}

export function redactToken(message: string): string {
  return message
    .replace(/ghp_[a-zA-Z0-9]+/g, "ghp_[REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]+/g, "github_pat_[REDACTED]")
    .replace(/(https?:\/\/)[^@]+@/g, "$1");
}

export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/, "").replace(/\/$/, "");
}
