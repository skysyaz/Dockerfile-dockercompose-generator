import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";

const execFileAsync = promisify(execFile);

export function dockerEnv() {
  const home = process.env.HOME || "/home/nextjs";
  const dockerConfig = process.env.DOCKER_CONFIG || `${home}/.docker`;
  return {
    ...process.env,
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
  };
}

let composeCommandPromise;

/**
 * Resolve a working Compose CLI. Alpine ships docker-cli-compose, but the
 * compose plugin may not load for non-root users unless DOCKER_CONFIG is set.
 * Fall back to the standalone docker-compose binary when needed.
 */
export function resolveComposeCommand() {
  if (!composeCommandPromise) {
    composeCommandPromise = detectComposeCommand();
  }
  return composeCommandPromise;
}

async function detectComposeCommand() {
  const env = dockerEnv();
  await fs.mkdir(env.DOCKER_CONFIG, { recursive: true }).catch(() => {});

  for (const candidate of [
    { cmd: "docker", prefix: ["compose"] },
    { cmd: "docker-compose", prefix: [] },
  ]) {
    try {
      await execFileAsync(candidate.cmd, [...candidate.prefix, "version"], { env });
      return (args) => [candidate.cmd, ...candidate.prefix, ...args];
    } catch {
      // try next candidate
    }
  }

  return null;
}
