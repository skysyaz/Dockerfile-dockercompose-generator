import { createGunzip } from "zlib";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as fs from "fs/promises";
import * as tar from "tar";
import {
  getProviderLabel,
  parseRepoUrl,
  type ParsedRepoUrl,
} from "./repo-url";

const DEFAULT_BRANCHES = ["main", "master", "HEAD"];

async function extractTarball(response: Response, dest: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`Archive download failed with status ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Archive download returned an empty body");
  }

  await fs.mkdir(dest, { recursive: true });
  const nodeStream = Readable.fromWeb(response.body as never);
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

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    return await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGithubArchive(
  parsed: ParsedRepoUrl,
  dest: string,
  accessToken?: string,
): Promise<void> {
  const [owner, repo] = parsed.projectPath.split("/");
  const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball`;
  const headers: Record<string, string> = {
    "User-Agent": "DockGen/1.0",
    Accept: "application/vnd.github+json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  const res = await fetchWithTimeout(tarballUrl, headers);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`fatal: repository '${parsed.projectPath}' does not exist`);
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
}

async function fetchGitlabArchive(
  parsed: ParsedRepoUrl,
  dest: string,
  accessToken?: string,
): Promise<void> {
  const encoded = encodeURIComponent(parsed.projectPath);
  const headers: Record<string, string> = {
    "User-Agent": "DockGen/1.0",
    ...(accessToken ? { "PRIVATE-TOKEN": accessToken } : {}),
  };
  const url = `https://${parsed.host}/api/v4/projects/${encoded}/repository/archive.tar.gz`;
  const res = await fetchWithTimeout(url, headers);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`fatal: repository '${parsed.projectPath}' does not exist`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `fatal: Authentication failed for https://${parsed.host}/${parsed.projectPath}. Provide a GitLab personal access token with read_repository scope.`,
      );
    }
    throw new Error(`GitLab API returned ${res.status}`);
  }
  await extractTarball(res, dest);
}

async function fetchBitbucketArchive(
  parsed: ParsedRepoUrl,
  dest: string,
  accessToken?: string,
): Promise<void> {
  const [workspace, repo] = parsed.projectPath.split("/");
  const headers: Record<string, string> = {
    "User-Agent": "DockGen/1.0",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  let lastError: Error | null = null;
  for (const branch of DEFAULT_BRANCHES) {
    const url = `https://bitbucket.org/${workspace}/${repo}/get/${branch}.tar.gz`;
    try {
      const res = await fetchWithTimeout(url, headers);
      if (res.ok) {
        await extractTarball(res, dest);
        return;
      }
      if (res.status === 404) {
        lastError = new Error(`fatal: repository '${parsed.projectPath}' does not exist`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `fatal: Authentication failed for https://bitbucket.org/${parsed.projectPath}. Provide a Bitbucket app password or access token.`,
        );
      }
      lastError = new Error(`Bitbucket returned ${res.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Could not download Bitbucket archive for ${parsed.projectPath}`);
}

async function fetchGiteaArchive(
  parsed: ParsedRepoUrl,
  dest: string,
  accessToken?: string,
): Promise<void> {
  const [owner, repo] = parsed.projectPath.split("/");
  const headers: Record<string, string> = {
    "User-Agent": "DockGen/1.0",
    ...(accessToken ? { Authorization: `token ${accessToken}` } : {}),
  };

  let lastError: Error | null = null;
  for (const branch of DEFAULT_BRANCHES) {
    const url = `https://${parsed.host}/api/v1/repos/${owner}/${repo}/archive/${branch}.tar.gz`;
    try {
      const res = await fetchWithTimeout(url, headers);
      if (res.ok) {
        await extractTarball(res, dest);
        return;
      }
      if (res.status === 404) {
        lastError = new Error(`fatal: repository '${parsed.projectPath}' does not exist`);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `fatal: Authentication failed for https://${parsed.host}/${parsed.projectPath}. Provide an access token with repository read scope.`,
        );
      }
      lastError = new Error(`${getProviderLabel(parsed.provider)} returned ${res.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw (
    lastError ??
    new Error(`Could not download archive for https://${parsed.host}/${parsed.projectPath}`)
  );
}

export async function fetchRepoArchive(
  repoUrl: string,
  dest: string,
  accessToken?: string,
): Promise<ParsedRepoUrl> {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) {
    throw new Error(
      "Invalid repository URL. Supported hosts: GitHub, GitLab, Bitbucket, Codeberg, and Gitea-compatible instances.",
    );
  }

  switch (parsed.provider) {
    case "github":
      await fetchGithubArchive(parsed, dest, accessToken);
      break;
    case "gitlab":
      await fetchGitlabArchive(parsed, dest, accessToken);
      break;
    case "bitbucket":
      await fetchBitbucketArchive(parsed, dest, accessToken);
      break;
    case "codeberg":
    case "gitea":
      await fetchGiteaArchive(parsed, dest, accessToken);
      break;
  }

  return parsed;
}
