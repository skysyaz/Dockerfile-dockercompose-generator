import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs/promises";
import * as tar from "tar";

const DEFAULT_BRANCHES = ["main", "master", "HEAD", "develop", "trunk", "release", "production"];
const EXTRACT_TIMEOUT_MS = 300_000;

export function isPrivateGitHost(host) {
  let name = String(host).toLowerCase();
  const bracketed = name.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    name = bracketed[1];
  } else {
    name = name.replace(/:\d+$/, "");
  }

  if (/^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.home\.arpa)$/.test(name)) {
    return true;
  }

  const ipv4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (name.includes(":")) {
    return (
      name === "::" ||
      name === "::1" ||
      /^(fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/.test(name)
    );
  }

  return !name.includes(".");
}

export function parseRepoUrl(url) {
  const trimmed = url.trim().replace(/\/$/, "");

  let m = trimmed.match(/^(?:https?:\/\/)?github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (m) {
    const repoName = m[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return { provider: "github", host: "github.com", projectPath: `${m[1]}/${repoName}`, repoName };
  }

  m = trimmed.match(/^(?:https?:\/\/)?((?:[^/]+\.)?gitlab\.com|gitlab\.[^/]+)\/(.+)$/i);
  if (m) {
    const projectPath = m[2]
      .replace(/[#?].*$/, "")
      .replace(/\/-\/.*$/, "")
      .replace(/\.git$/, "");
    const segments = projectPath.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    return {
      provider: "gitlab",
      host: m[1].toLowerCase(),
      projectPath,
      repoName: segments[segments.length - 1],
    };
  }

  m = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?bitbucket\.org[/:]([^/]+)\/([^/#?]+)/i);
  if (m) {
    const repoName = m[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "bitbucket",
      host: "bitbucket.org",
      projectPath: `${m[1]}/${repoName}`,
      repoName,
    };
  }

  m = trimmed.match(/^(?:https?:\/\/)?codeberg\.org[/:]([^/]+)\/([^/#?]+)/i);
  if (m) {
    const repoName = m[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "codeberg",
      host: "codeberg.org",
      projectPath: `${m[1]}/${repoName}`,
      repoName,
    };
  }

  m = trimmed.match(/^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+)/i);
  if (m) {
    const host = m[1].toLowerCase();
    if (
      host === "github.com" ||
      host === "gitlab.com" ||
      host.endsWith(".gitlab.com") ||
      host === "bitbucket.org" ||
      host === "codeberg.org"
    ) {
      return null;
    }
    const repoName = m[3].replace(/\.git$/, "");
    if (!repoName) return null;
    return { provider: "gitea", host, projectPath: `${m[2]}/${repoName}`, repoName };
  }

  return null;
}

function hostMatchesEnv(host, envHost) {
  return Boolean(envHost && host === envHost.trim().toLowerCase());
}

export function isOfficialGitlabHost(host) {
  const h = String(host).toLowerCase();
  return h === "gitlab.com" || h.endsWith(".gitlab.com");
}

export function resolveAccessToken(provider, requestToken, host) {
  const token = typeof requestToken === "string" ? requestToken.trim() : "";
  if (token) return token;
  const h = String(host ?? "").trim().toLowerCase();
  // Never fall back to another provider's token, and never send an env token
  // to a host it wasn't configured for — a parsed URL like gitlab.evil.com
  // must not receive GITLAB_TOKEN. Self-managed instances opt in explicitly
  // via GITLAB_HOST / GITEA_HOST.
  switch (provider) {
    case "github":
      return process.env.GITHUB_TOKEN || undefined;
    case "gitlab":
      if (h && (isOfficialGitlabHost(h) || hostMatchesEnv(h, process.env.GITLAB_HOST))) {
        return process.env.GITLAB_TOKEN || undefined;
      }
      return undefined;
    case "bitbucket":
      return process.env.BITBUCKET_TOKEN || undefined;
    case "codeberg":
    case "gitea":
    default:
      if (h && hostMatchesEnv(h, process.env.GITEA_HOST)) {
        return process.env.GITEA_TOKEN || undefined;
      }
      return undefined;
  }
}

async function extractTarball(response, dest) {
  if (!response.ok) {
    throw new Error(`Archive download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Archive download returned an empty body");
  }
  await fs.mkdir(dest, { recursive: true });
  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(
    nodeStream,
    createGunzip(),
    tar.x({
      cwd: dest,
      strip: 1,
      filter: (filePath) => {
        const normalized = filePath.replace(/\\/g, "/");
        return !normalized.startsWith("/") && !normalized.includes("..");
      },
    }),
    { signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS) },
  );
}

async function fetchWithTimeout(url, headers, maxRedirects = 5) {
  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    let res;
    try {
      res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      const next = new URL(location, currentUrl);
      if (isPrivateGitHost(next.hostname) && process.env.ALLOW_PRIVATE_GIT_HOSTS !== "true") {
        throw new Error(
          `Refusing to follow redirect to private host '${next.hostname}'.`,
        );
      }
      currentUrl = next.href;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

export async function fetchRepoArchive(repoUrl, dest, accessToken) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    throw new Error("Invalid repository URL");
  }

  if (parsed.provider === "github") {
    const [owner, repo] = parsed.projectPath.split("/");
    const res = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}/tarball`, {
      "User-Agent": "DockGen/1.0",
      Accept: "application/vnd.github+json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(
          accessToken
            ? `fatal: repository '${parsed.projectPath}' does not exist or your token cannot access it`
            : `fatal: repository '${parsed.projectPath}' does not exist. If the repo is private, set GITHUB_TOKEN in the server environment or paste a token in the UI.`,
        );
      }
      if (res.status === 401 || res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        if (remaining === "0" && reset) {
          const mins = Math.max(
            1,
            Math.ceil((parseInt(reset, 10) * 1000 - Date.now()) / 60_000),
          );
          throw new Error(
            `GitHub API rate limit exceeded. Try again in ${mins} minute(s), or provide a token to increase your limit.`,
          );
        }
        throw new Error(
          `fatal: Authentication failed for https://github.com/${parsed.projectPath}. If the repo is private, provide a valid GitHub token with repo scope.`,
        );
      }
      throw new Error(`GitHub API returned ${res.status}`);
    }
    await extractTarball(res, dest);
    return;
  }

  if (parsed.provider === "gitlab") {
    if (
      !isOfficialGitlabHost(parsed.host) &&
      isPrivateGitHost(parsed.host) &&
      process.env.ALLOW_PRIVATE_GIT_HOSTS !== "true"
    ) {
      throw new Error(
        `Refusing to fetch from private or internal host '${parsed.host}'. ` +
          "Set ALLOW_PRIVATE_GIT_HOSTS=true on the server to allow internal Git hosts.",
      );
    }
    const encoded = encodeURIComponent(parsed.projectPath);
    const res = await fetchWithTimeout(
      `https://${parsed.host}/api/v4/projects/${encoded}/repository/archive.tar.gz`,
      {
        "User-Agent": "DockGen/1.0",
        ...(accessToken ? { "PRIVATE-TOKEN": accessToken } : {}),
      },
    );
    if (!res.ok) throw new Error(`GitLab API returned ${res.status}`);
    await extractTarball(res, dest);
    return;
  }

  if (parsed.provider === "bitbucket") {
    const [workspace, repo] = parsed.projectPath.split("/");
    for (const branch of DEFAULT_BRANCHES) {
      const res = await fetchWithTimeout(
        `https://bitbucket.org/${workspace}/${repo}/get/${branch}.tar.gz`,
        {
          "User-Agent": "DockGen/1.0",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      );
      if (res.ok) {
        await extractTarball(res, dest);
        return;
      }
    }
    throw new Error(`Could not download Bitbucket archive for ${parsed.projectPath}`);
  }

  if (isPrivateGitHost(parsed.host) && process.env.ALLOW_PRIVATE_GIT_HOSTS !== "true") {
    throw new Error(
      `Refusing to fetch from private or internal host '${parsed.host}'. ` +
        "Set ALLOW_PRIVATE_GIT_HOSTS=true on the server to allow internal Git hosts.",
    );
  }
  const [owner, repo] = parsed.projectPath.split("/");
  for (const branch of DEFAULT_BRANCHES) {
    const res = await fetchWithTimeout(
      `https://${parsed.host}/api/v1/repos/${owner}/${repo}/archive/${branch}.tar.gz`,
      {
        "User-Agent": "DockGen/1.0",
        ...(accessToken ? { Authorization: `token ${accessToken}` } : {}),
      },
    );
    if (res.ok) {
      await extractTarball(res, dest);
      return;
    }
  }

  throw new Error(`Could not download archive for ${parsed.host}/${parsed.projectPath}`);
}
