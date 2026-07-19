export function dependencyCopyLine(rootFiles: string[]): string {
  const copies = ["package*.json"];
  for (const file of [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ]) {
    if (rootFiles.includes(file)) copies.push(file);
  }
  return `COPY ${copies.join(" ")} ./`;
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
