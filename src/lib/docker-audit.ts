import type { AnalysisResult, Customizations } from "./types";
import { sanitizeDockerfileLockfiles } from "./node-docker";

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

function isUsableDockerfile(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length > 20 && /^\s*FROM\s+/im.test(trimmed);
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

  if (analysis.framework === "nextjs" && !/NODE_ENV\s*=/i.test(result)) {
    fixes.push("Dockerfile: added NODE_ENV=production for Next.js");
    result = `ENV NODE_ENV=production\n${result}`;
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

  const lockfileFix = sanitizeDockerfileLockfiles(result, analysis.rootFiles ?? []);
  if (lockfileFix.content !== result) {
    result = lockfileFix.content;
    fixes.push(...lockfileFix.fixes);
  }

  return { content: result, fixes };
}

function fixAppServicePorts(content: string, port: number): { content: string; changed: boolean } {
  const lines = content.split("\n");
  let inApp = false;
  let appIndent = -1;
  let changed = false;

  const updated = lines.map((line) => {
    const indent = line.search(/\S/);

    if (/^\s*app:\s*($|#)/.test(line)) {
      inApp = true;
      appIndent = indent;
      return line;
    }

    if (inApp && indent >= 0 && indent <= appIndent && /^\s+\w[\w-]*:/.test(line)) {
      inApp = false;
    }

    if (inApp && /^\s+-\s*["']?\d+:\d+["']?/.test(line)) {
      const next = line.replace(/(\d+):(\d+)/, `${port}:${port}`);
      if (next !== line) changed = true;
      return next;
    }

    return line;
  });

  return { content: updated.join("\n"), changed };
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

  if (!/^\s+app:[\s#]/m.test(result)) {
    fixes.push("docker-compose.yml: ensured app service exists");
    if (!/^\s+app:/m.test(result)) {
      result = result.replace(/services:\s*\n/, `services:\n  app:\n    build: .\n`);
    }
  }

  if (!/restart:/i.test(result)) {
    fixes.push("docker-compose.yml: added restart: unless-stopped to app service");
    result = result.replace(/(^\s+app:\s*$)/m, "$1\n    restart: unless-stopped");
  }

  const portFix = fixAppServicePorts(result, port);
  if (portFix.changed) {
    fixes.push(`docker-compose.yml: updated app port mapping to ${port}:${port}`);
    result = portFix.content;
  } else if (!/^\s+app:[\s\S]*?^\s+ports:/m.test(result)) {
    fixes.push(`docker-compose.yml: added ports ${port}:${port} to app service`);
    result = result.replace(/(^\s+app:\s*$)/m, `$1\n    ports:\n      - "${port}:${port}"`);
  }

  if (
    ["nextjs", "django", "fastapi", "flask", "rails", "laravel", "nestjs", "express"].includes(
      analysis.framework,
    ) &&
    !/^\s+app:[\s\S]*?env_file:/m.test(result)
  ) {
    fixes.push("docker-compose.yml: added env_file: .env to app service");
    result = result.replace(/(^\s+app:\s*$)/m, `$1\n    env_file:\n      - .env`);
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

  const missing = generated.split("\n").filter((l) => {
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

  if (existing.Dockerfile !== undefined) {
    const source = isUsableDockerfile(existing.Dockerfile)
      ? existing.Dockerfile
      : generated.Dockerfile;
    if (!isUsableDockerfile(existing.Dockerfile)) {
      fixes.push("Dockerfile: existing file was incomplete — merged with generated template");
    }
    const audited = fixDockerfile(source, analysis, port);
    files.Dockerfile = audited.content;
    fixes.push(...audited.fixes);
  }

  const composeExisting =
    existing["docker-compose.yml"] ?? existing["docker-compose.yaml"];
  if (composeExisting !== undefined) {
    const source =
      composeExisting.includes("services:") && composeExisting.length > 30
        ? composeExisting
        : generated["docker-compose.yml"];
    if (source === generated["docker-compose.yml"] && composeExisting) {
      fixes.push("docker-compose.yml: existing file was incomplete — merged with generated template");
    }
    const audited = fixDockerCompose(source, analysis, port);
    files["docker-compose.yml"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".dockerignore"] !== undefined) {
    const audited = fixDockerignore(existing[".dockerignore"] || generated[".dockerignore"]);
    files[".dockerignore"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".env.example"] !== undefined && generated[".env.example"]) {
    const audited = mergeEnvFile(
      existing[".env.example"] || generated[".env.example"],
      generated[".env.example"],
      ".env.example",
    );
    files[".env.example"] = audited.content;
    fixes.push(...audited.fixes);
  }

  if (existing[".env"] !== undefined && generated[".env"]) {
    const audited = mergeEnvFile(
      existing[".env"] || generated[".env"],
      generated[".env"],
      ".env",
    );
    files[".env"] = audited.content;
    fixes.push(...audited.fixes);
  }

  return { files, fixes };
}
