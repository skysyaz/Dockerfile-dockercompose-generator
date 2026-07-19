import { createServer } from "http";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { Server } from "socket.io";
import { dockerEnv, resolveComposeCommand } from "./compose.js";
import { fetchRepoArchive, parseRepoUrl, resolveAccessToken } from "./repo-providers.js";

const PORT = Number(process.env.BUILD_SERVICE_PORT || 5173);
const BUILD_TOKEN = process.env.BUILD_SERVICE_TOKEN || "";
function normalizeOrigin(origin) {
  return origin.replace(/\/$/, "");
}

const ALLOWED_ORIGINS = (process.env.BUILD_SERVICE_ORIGINS || "")
  .split(",")
  .map((o) => normalizeOrigin(o.trim()))
  .filter(Boolean);

const BUILD_SOCKET_PATH = "/build-socket";
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 900;
const MIN_TIMEOUT_SEC = 30;

const ALLOWED_FILES = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  ".env.example",
  ".env",
]);

function redactSecrets(message) {
  return String(message)
    .replace(/ghp_[a-zA-Z0-9]+/g, "ghp_[REDACTED]")
    .replace(/github_pat_[a-zA-Z0-9_]+/g, "github_pat_[REDACTED]")
    .replace(/(https?:\/\/)[^@]+@/g, "$1");
}

function isAllowedFile(name) {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
    return false;
  }
  return ALLOWED_FILES.has(name);
}

function emitLog(socket, stream, text) {
  socket.emit("log", { t: Date.now(), stream, text: redactSecrets(text) });
}

// Recognized failure signatures → actionable hints shown after a failed build.
const FAILURE_HINTS = [
  {
    re: /gyp ERR!|Could not find any Python|node-gyp/i,
    hint:
      "Native Node modules need build tools. Re-run Analyze/Generate with the latest DockGen (it adds python3/make/g++ automatically when native modules are detected), or add to the Dockerfile install stage: RUN apk add --no-cache python3 make g++",
  },
  {
    re: /Unsupported engine|EBADENGINE/i,
    hint:
      "The repo requires a different Node version — set the base image version (e.g. 24-alpine) in Build Customization, or re-run Analyze (DockGen now reads engines.node automatically).",
  },
  {
    re: /no space left on device/i,
    hint: "The Docker host is out of disk space — run: docker system prune -af",
  },
  {
    re: /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile/i,
    hint:
      "The lockfile is out of sync with package.json — update the lockfile in the repo, or remove --frozen-lockfile from the install command.",
  },
  {
    re: /permission denied while trying to connect to the Docker daemon/i,
    hint:
      "The build service cannot reach the Docker socket — check that /var/run/docker.sock is mounted and DOCKER_GID matches the host socket group.",
  },
  {
    re: /net\/http: TLS handshake timeout|context deadline exceeded|dial tcp.*i\/o timeout/i,
    hint: "Network timeout while pulling images — check the Docker host's connectivity and retry.",
  },
];

const httpServer = createServer();
const io = new Server(httpServer, {
  path: BUILD_SOCKET_PATH,
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const normalized = normalizeOrigin(origin);
      if (
        !ALLOWED_ORIGINS.length ||
        ALLOWED_ORIGINS.some((allowed) => allowed === normalized)
      ) {
        return callback(null, true);
      }
      callback(new Error("Origin not allowed"));
    },
    methods: ["GET", "POST"],
  },
});

io.use((socket, next) => {
  if (!BUILD_TOKEN) {
    return next(new Error("Build service is disabled (BUILD_SERVICE_TOKEN not set)"));
  }
  const token = socket.handshake.auth?.token;
  if (token !== BUILD_TOKEN) {
    return next(new Error("Unauthorized"));
  }
  next();
});

io.on("connection", (socket) => {
  socket.on("build", async (payload) => {
    const {
      repoUrl,
      githubToken,
      files = [],
      timeoutSec = DEFAULT_TIMEOUT_SEC,
      cloneRepo = true,
      buildOnly = true,
    } = payload ?? {};

    const maxTimeout = Math.min(
      Math.max(Number(timeoutSec) || DEFAULT_TIMEOUT_SEC, MIN_TIMEOUT_SEC),
      MAX_TIMEOUT_SEC,
    );
    let workDir = "";

    const log = (stream, text) => emitLog(socket, stream, text);

    try {
      const composeCommand = await resolveComposeCommand();
      if (!composeCommand) {
        log(
          "stderr",
          "Docker Compose is not available in this container. Ensure docker-cli-compose is installed.",
        );
        socket.emit("done", { success: false, reason: "no-compose", exitCode: null });
        return;
      }

      const dockerCheck = spawn("docker", ["--version"], { env: dockerEnv() });
      const dockerOk = await new Promise((resolve) => {
        dockerCheck.on("close", (code) => resolve(code === 0));
        dockerCheck.on("error", () => resolve(false));
      });

      if (!dockerOk) {
        log(
          "stderr",
          "Docker is not installed or not accessible on the server. The Test Build feature requires Docker to be installed on the host running DockGen.",
        );
        socket.emit("done", { success: false, reason: "no-docker", exitCode: null });
        return;
      }

      workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockgen-build-"));

      if (cloneRepo !== false) {
        log("system", `[fetch] downloading tarball for ${repoUrl}`);
        try {
          const parsed = parseRepoUrl(repoUrl);
          const accessToken = resolveAccessToken(parsed?.provider, githubToken, parsed?.host);
          await fetchRepoArchive(repoUrl, workDir, accessToken);
          log("system", "[fetch] done");
        } catch (error) {
          log("stderr", error instanceof Error ? error.message : String(error));
          socket.emit("done", { success: false, reason: "fetch-failed", exitCode: null });
          return;
        }
      }

      for (const file of files) {
        if (!isAllowedFile(file.name)) {
          log("stderr", `[write] rejected unsafe filename: ${file.name}`);
          socket.emit("done", { success: false, reason: "invalid-file", exitCode: null });
          return;
        }
        const target = path.join(workDir, file.name);
        await fs.writeFile(target, file.content, "utf-8");
        log("system", `[write] ${file.name} (${file.content.length} bytes)`);
      }

      const composeArgs = composeCommand(
        buildOnly ? ["build"] : ["up", "--build", "--abort-on-container-exit"],
      );
      const [composeBin, ...composeArgv] = composeArgs;
      log(
        "system",
        `[compose] ${composeBin} ${composeArgv.join(" ")} (timeout ${maxTimeout}s${buildOnly ? ", build-only" : ""})`,
      );

      const compose = spawn(composeBin, composeArgv, {
        cwd: workDir,
        env: dockerEnv(),
      });

      const matchedHints = new Set();
      const onData = (stream) => (chunk) => {
        chunk
          .toString()
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) => {
            for (const { re, hint } of FAILURE_HINTS) {
              if (re.test(line)) matchedHints.add(hint);
            }
            log(stream, line);
          });
      };

      compose.stdout.on("data", onData("stdout"));
      compose.stderr.on("data", onData("stderr"));

      const result = await new Promise((resolve) => {
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          compose.kill("SIGKILL");
        }, maxTimeout * 1000);

        compose.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: killed ? null : code, killed });
        });
        compose.on("error", () => {
          clearTimeout(timer);
          resolve({ code: null, killed: false });
        });
      });

      if (result.code !== 0 && matchedHints.size) {
        for (const hint of matchedHints) {
          log("system", `[hint] ${hint}`);
        }
      }

      socket.emit("done", {
        success: result.code === 0,
        exitCode: result.code,
        reason: result.killed ? "timeout" : undefined,
        buildOnly,
      });
    } catch (error) {
      log("stderr", error instanceof Error ? error.message : String(error));
      socket.emit("done", { success: false, exitCode: null });
    } finally {
      if (workDir) {
        if (!buildOnly) {
          const downCommand = await resolveComposeCommand();
          if (downCommand) {
            const downArgs = downCommand(["down", "--volumes", "--remove-orphans"]);
            // Wait for teardown before deleting workDir — compose needs the
            // compose file in cwd to know what to remove.
            await new Promise((resolve) => {
              const down = spawn(downArgs[0], downArgs.slice(1), {
                cwd: workDir,
                env: dockerEnv(),
              });
              const timer = setTimeout(() => {
                down.kill("SIGKILL");
                resolve();
              }, 60_000);
              down.on("close", () => {
                clearTimeout(timer);
                resolve();
              });
              down.on("error", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
        }
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        log("system", "[cleanup] work directory removed");
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[dockgen] docker-build-service listening on :${PORT}`);
});
