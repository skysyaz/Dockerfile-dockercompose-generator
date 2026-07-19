import type { AnalysisResult, Customizations } from "./types";

export interface ExistingDockerFiles {
  Dockerfile?: string;
  "docker-compose.yml"?: string;
  "docker-compose.yaml"?: string;
  ".dockerignore"?: string;
  ".env.example"?: string;
  ".env"?: string;
}

export interface AuditResult {
  files: Record<string, string>;
  fixes: string[];
}

function getPort(analysis: AnalysisResult, customizations: Customizations): number {
  return customizations.port ?? analysis.port;
}

function fixDockerfile(
  content: string,
  analysis: AnalysisResult,
  port: number,
): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  let result = content;

  if (!/^\s*FROM\s+/im.test(result)) {
    fixes.push("Dockerfile: added missing FROM instruction");
    result = `FROM alpine:latest\n${result}`;
  }

  if (!/EXPOSE\s+\d+/i.test(result)) {
    fixes.push(`Dockerfile: added EXPOSE ${port}`);
    result = `${result.trimEnd()}\nEXPOSE ${port}\n`;
  } else {
    const updated = result.replace(/EXPOSE\s+\d+/gi, `EXPOSE ${port}`);
    if (updated !== result) {
      fixes.push(`Dockerfile: updated EXPOSE to ${port}`);
      result = updated;
    }
  }

  if (analysis.framework === "nextjs" && !/NODE_ENV/i.test(result)) {
    fixes.push("Dockerfile: added NODE_ENV=production for Next.js");
    result = result.replace(/(ENV\s+NODE_ENV=.*\n)?/i, "ENV NODE_ENV=production\n");
  }

  if (
    ["django", "flask", "fastapi", "python"].includes(analysis.framework) &&
    !/PYTHONUNBUFFERED/i.test(result)
  ) {
    fixes.push("Dockerfile: added PYTHONUNBUFFERED=1");
    result = `ENV PYTHONUNBUFFERED=1\n${result}`;
  }

  if (!/CMD\s+/i.test(result) && !/ENTRYPOINT\s+/i.test(result)) {
    fixes.push("Dockerfile: added default CMD");
    result = `${result.trimEnd()}\nCMD ["./start.sh"]\n`;
  }

  return { content: result, fixes };
}

function fixDockerCompose(
  content: string,
  analysis: AnalysisResult,
  port: number,
): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  let result = content;

  if (!/services:/i.test(result)) {
    fixes.push("docker-compose.yml: wrapped content in services block");
    result = `services:\n  app:\n${result
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}`;
  }

  if (!/restart:/i.test(result)) {
    fixes.push("docker-compose.yml: added restart: unless-stopped");
    result = result.replace(/(^\s+app:\s*$)/m, "$1\n    restart: unless-stopped");
  }

  const portPattern = /(["']?)(\d{2,5}):(\d{2,5})\1/g;
  if (portPattern.test(result)) {
    const updated = result.replace(portPattern, `"${port}:${port}"`);
    if (updated !== result) {
      fixes.push(`docker-compose.yml: normalized port mapping to ${port}:${port}`);
      result = updated;
    }
  } else if (!/ports:/i.test(result)) {
    fixes.push(`docker-compose.yml: added ports ${port}:${port}`);
    result = result.replace(/(^\s+app:\s*$)/m, `$1\n    ports:\n      - "${port}:${port}"`);
  }

  if (
    ["nextjs", "django", "fastapi", "flask", "rails", "laravel", "nestjs", "express"].includes(
      analysis.framework,
    ) &&
    !/env_file:/i.test(result)
  ) {
    fixes.push("docker-compose.yml: added env_file: .env");
    result = result.replace(
      /(^\s+app:\s*$)/m,
      `$1\n    env_file:\n      - .env`,
    );
  }

  return { content: result, fixes };
}

function mergeEnvFile(
  existing: string,
  generated: string,
  label: string,
): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  const existingKeys = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=")[0]?.trim())
      .filter(Boolean),
  );

  const missing = generated
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return false;
      const key = t.split("=")[0]?.trim();
      return key && !existingKeys.has(key);
    });

  if (missing.length) {
    fixes.push(`${label}: added ${missing.length} missing environment variable(s)`);
    return {
      content: `${existing.trimEnd()}\n\n# Added by DockGen audit\n${missing.join("\n")}\n`,
      fixes,
    };
  }

  fixes.push(`${label}: all required variables present`);
  return { content: existing, fixes };
}

function fixDockerignore(content: string): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  const required = [".git", "node_modules", ".env", ".env.local", "__pycache__", ".next"];
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const missing = required.filter((r) => !lines.some((l) => l === r || l.includes(r)));

  if (missing.length) {
    fixes.push(`.dockerignore: added ${missing.join(", ")}`);
    return { content: `${content.trimEnd()}\n${missing.join("\n")}\n`, fixes };
  }

  fixes.push(".dockerignore: entries look good");
  return { content, fixes };
}

export function auditExistingFiles(
  existing: ExistingDockerFiles,
  generated: Record<string, string>,
  analysis: AnalysisResult,
  customizations: Customizations = {},
): AuditResult {
  const port = getPort(analysis, customizations);
  const files: Record<string, string> = { ...generated };
  const fixes: string[] = [];

  if (existing.Dockerfile) {
    const audited = fixDockerfile(existing.Dockerfile, analysis, port);
    files.Dockerfile = audited.content;
    fixes.push(...audited.fixes);
  }

  const composeExisting =
    existing["docker-compose.yml"] ?? existing["docker-compose.yaml"];
  if (composeExisting) {
    const audited = fixDockerCompose(composeExisting, analysis, port);
    files["docker-compose.yml"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".dockerignore"]) {
    const audited = fixDockerignore(existing[".dockerignore"]);
    files[".dockerignore"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".env.example"] && generated[".env.example"]) {
    const audited = mergeEnvFile(
      existing[".env.example"],
      generated[".env.example"],
      ".env.example",
    );
    files[".env.example"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".env"] && generated[".env"]) {
    const audited = mergeEnvFile(existing[".env"], generated[".env"], ".env");
    files[".env"] = audited.content;
    fixes.push(...audited.fixes);
  }

  return { files, fixes };
}
