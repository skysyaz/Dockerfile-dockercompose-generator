import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs/promises";
import * as tar from "tar";

const DEFAULT_BRANCHES = ["main", "master", "HEAD"];

export function parseRepoUrl(url) {
  const trimmed = url.trim().replace(/\/$/, "");

  let m = trimmed.match(/^(?:https?:\/\/)?github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (m) {
    const repoName = m[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return { provider: "github", host: "github.com", projectPath: `${m[1]}/${repoName}`, repoName };
  }

  m = trimmed.match(/^(?:https?:\/\/)?((?:[^/]+\.)?gitlab\.com)\/(.+)$/i);
  if (m) {
    const projectPath = m[2].replace(/\.git$/, "");
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

async function extractTarball(response, dest) {
  if (!response.ok) {
    throw new Error(`Archive download failed with status ${response.status}`);
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
  );
}

async function fetchWithTimeout(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    return await fetch(url, { headers, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    await extractTarball(res, dest);
    return;
  }

  if (parsed.provider === "gitlab") {
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
