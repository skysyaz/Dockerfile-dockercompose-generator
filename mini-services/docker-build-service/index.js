import { createServer } from "http";
import { spawn } from "child_process";
import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import { Server } from "socket.io";

const PORT = Number(process.env.BUILD_SERVICE_PORT || 5173);

function parseGithubUrl(url) {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  const repo = m[2].replace(/\.git$/, "").replace(/\/$/, "");
  if (!repo) return null;
  return { owner: m[1], repo };
}

async function fetchRepoTarball(repoUrl, dest, githubToken) {
  const parsed = parseGithubUrl(repoUrl);
  if (!parsed) throw new Error("Invalid GitHub URL");
  const { owner, repo } = parsed;
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball`;
  const headers = {
    "User-Agent": "DockGen/1.0",
    Accept: "application/vnd.github+json",
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(tarballUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
    await fs.mkdir(dest, { recursive: true });
    const nodeStream = Readable.fromWeb(res.body);
    await pipeline(nodeStream, createGunzip(), tar.x({ cwd: dest, strip: 1 }));
  } finally {
    clearTimeout(timer);
  }
}

function emitLog(io, socket, stream, text) {
  socket.emit("log", { t: Date.now(), stream, text });
}

function runCommand(cmd, args, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutSec * 1000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? null : code, killed });
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, killed: false });
    });

    return child;
  });
}

const httpServer = createServer();
const io = new Server(httpServer, {
  path: "/",
  cors: { origin: "*" },
});

io.on("connection", (socket) => {
  socket.on("build", async (payload) => {
    const {
      repoUrl,
      githubToken,
      files = [],
      timeoutSec = 120,
      cloneRepo = true,
    } = payload ?? {};

    const maxTimeout = Math.min(Math.max(timeoutSec, 30), 300);
    let workDir = "";

    const log = (stream, text) => emitLog(io, socket, stream, text);

    try {
      const dockerCheck = spawn("docker", ["--version"]);
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
          await fetchRepoTarball(repoUrl, workDir, githubToken);
          log("system", "[fetch] done");
        } catch (error) {
          log("stderr", error instanceof Error ? error.message : String(error));
          socket.emit("done", { success: false, reason: "fetch-failed", exitCode: null });
          return;
        }
      }

      for (const file of files) {
        const target = path.join(workDir, file.name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, file.content, "utf-8");
        log("system", `[write] ${file.name} (${file.content.length} bytes)`);
      }

      const compose = spawn("docker", ["compose", "up", "--build", "--abort-on-container-exit"], {
        cwd: workDir,
      });

      const onData = (stream) => (chunk) => {
        chunk
          .toString()
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) => log(stream, line));
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

      socket.emit("done", {
        success: result.code === 0,
        exitCode: result.code,
        reason: result.killed ? "timeout" : undefined,
      });
    } catch (error) {
      log("stderr", error instanceof Error ? error.message : String(error));
      socket.emit("done", { success: false, exitCode: null });
    } finally {
      if (workDir) {
        spawn("docker", ["compose", "down", "--volumes", "--remove-orphans"], {
          cwd: workDir,
        });
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
        log("system", "[cleanup] work directory removed");
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[dockgen] docker-build-service listening on :${PORT}`);
});
