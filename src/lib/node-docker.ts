const LOCKFILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export function dependencyCopyLine(rootFiles: string[]): string {
  const copies = ["package*.json"];
  for (const file of LOCKFILE_NAMES) {
    if (rootFiles.includes(file)) copies.push(file);
  }
  return `COPY ${copies.join(" ")} ./`;
}

export function isDependencyCopyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!/^COPY\s+/i.test(trimmed)) return false;
  if (!/\s+\.(\/)?\s*$/.test(trimmed)) return false;
  return /package(\*\.json|\.json|-lock\.json)|pnpm-lock\.yaml|yarn\.lock|bun\.lock/i.test(
    trimmed,
  );
}

export function sanitizeDockerfileLockfiles(
  content: string,
  rootFiles: string[],
): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  const copyLine = dependencyCopyLine(rootFiles);
  const hasBunLock = rootFiles.some((file) => file === "bun.lock" || file === "bun.lockb");
  const hasPnpmLock = rootFiles.includes("pnpm-lock.yaml");
  const hasYarnLock = rootFiles.includes("yarn.lock");
  const hasNpmLock = rootFiles.includes("package-lock.json");

  const lines = content.split("\n").map((line) => {
    const trimmed = line.trim();

    if (isDependencyCopyLine(line)) {
      if (trimmed !== copyLine) {
        fixes.push("Dockerfile: fixed dependency COPY to only include existing lockfiles");
        return copyLine;
      }
      return line;
    }

    if (/^RUN\s+.*\bbun\s+install\b/i.test(trimmed) && /--frozen-lockfile/i.test(trimmed) && !hasBunLock) {
      fixes.push("Dockerfile: removed --frozen-lockfile for bun (no lockfile in repo)");
      return trimmed.replace(/\s+--frozen-lockfile\b/, "");
    }
    if (/^RUN\s+.*\bpnpm\s+install\b/i.test(trimmed) && /--frozen-lockfile/i.test(trimmed) && !hasPnpmLock) {
      fixes.push("Dockerfile: removed --frozen-lockfile for pnpm (no lockfile in repo)");
      return trimmed.replace(/\s+--frozen-lockfile\b/, "");
    }
    if (/^RUN\s+.*\byarn\s+install\b/i.test(trimmed) && /--frozen-lockfile/i.test(trimmed) && !hasYarnLock) {
      fixes.push("Dockerfile: removed --frozen-lockfile for yarn (no lockfile in repo)");
      return trimmed.replace(/\s+--frozen-lockfile\b/, "");
    }
    if (/^RUN\s+npm\s+ci\b/i.test(trimmed) && !hasNpmLock) {
      fixes.push("Dockerfile: replaced npm ci with npm install (no package-lock.json in repo)");
      return trimmed.replace(/\bnpm\s+ci\b/, "npm install");
    }

    return line;
  });

  return { content: lines.join("\n"), fixes: [...new Set(fixes)] };
}

export function installCmd(pm: string, rootFiles: string[] = []): string {
  switch (pm) {
    case "pnpm":
      return rootFiles.includes("pnpm-lock.yaml")
        ? "RUN npm i -g pnpm && pnpm install --frozen-lockfile"
        : "RUN npm i -g pnpm && pnpm install";
    case "yarn":
      return rootFiles.includes("yarn.lock")
        ? "RUN yarn install --frozen-lockfile"
        : "RUN yarn install";
    case "bun":
      return rootFiles.some((file) => file === "bun.lock" || file === "bun.lockb")
        ? "RUN npm i -g bun && bun install --frozen-lockfile"
        : "RUN npm i -g bun && bun install";
    default:
      return rootFiles.includes("package-lock.json")
        ? "RUN npm ci"
        : "RUN npm install";
  }
}

export function buildCmd(pm: string): string {
  switch (pm) {
    case "pnpm":
      return "RUN pnpm run build";
    case "yarn":
      return "RUN yarn build";
    case "bun":
      return "RUN bun run build";
    default:
      return "RUN npm run build";
  }
}
