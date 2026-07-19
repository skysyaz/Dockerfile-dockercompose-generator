import type { RepoProvider } from "./types";

export interface ParsedRepoUrl {
  provider: RepoProvider;
  host: string;
  projectPath: string;
  repoName: string;
}

const PROVIDER_LABELS: Record<RepoProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  codeberg: "Codeberg",
  gitea: "Gitea",
};

export function getProviderLabel(provider: RepoProvider): string {
  return PROVIDER_LABELS[provider];
}

export function parseRepoUrl(url: string): ParsedRepoUrl | null {
  const trimmed = url.trim().replace(/\/$/, "");

  const github = trimmed.match(/^(?:https?:\/\/)?github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (github) {
    const repoName = github[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "github",
      host: "github.com",
      projectPath: `${github[1]}/${repoName}`,
      repoName,
    };
  }

  const gitlab = trimmed.match(
    /^(?:https?:\/\/)?((?:[^/]+\.)?gitlab\.com)\/(.+)$/i,
  );
  if (gitlab) {
    const projectPath = gitlab[2].replace(/\.git$/, "");
    const segments = projectPath.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const repoName = segments[segments.length - 1]!;
    return {
      provider: "gitlab",
      host: gitlab[1].toLowerCase(),
      projectPath,
      repoName,
    };
  }

  const bitbucket = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?bitbucket\.org[/:]([^/]+)\/([^/#?]+)/i,
  );
  if (bitbucket) {
    const repoName = bitbucket[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "bitbucket",
      host: "bitbucket.org",
      projectPath: `${bitbucket[1]}/${repoName}`,
      repoName,
    };
  }

  const codeberg = trimmed.match(/^(?:https?:\/\/)?codeberg\.org[/:]([^/]+)\/([^/#?]+)/i);
  if (codeberg) {
    const repoName = codeberg[2].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "codeberg",
      host: "codeberg.org",
      projectPath: `${codeberg[1]}/${repoName}`,
      repoName,
    };
  }

  const gitea = trimmed.match(/^(?:https?:\/\/)?([^/]+)\/([^/]+)\/([^/#?]+)/i);
  if (gitea) {
    const host = gitea[1].toLowerCase();
    if (
      host === "github.com" ||
      host === "gitlab.com" ||
      host.endsWith(".gitlab.com") ||
      host === "bitbucket.org" ||
      host === "codeberg.org"
    ) {
      return null;
    }
    const repoName = gitea[3].replace(/\.git$/, "");
    if (!repoName) return null;
    return {
      provider: "gitea",
      host,
      projectPath: `${gitea[2]}/${repoName}`,
      repoName,
    };
  }

  return null;
}

/** @deprecated Use parseRepoUrl instead */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const parsed = parseRepoUrl(url);
  if (!parsed || parsed.provider !== "github") return null;
  const [owner, repo] = parsed.projectPath.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function resolveAccessToken(
  provider: RepoProvider,
  requestToken?: string,
): string | undefined {
  const token = requestToken?.trim();
  if (token) return token;
  switch (provider) {
    case "github":
      return process.env.GITHUB_TOKEN || undefined;
    case "gitlab":
      return process.env.GITLAB_TOKEN || process.env.GITHUB_TOKEN || undefined;
    case "bitbucket":
      return process.env.BITBUCKET_TOKEN || undefined;
    default:
      return (
        process.env.GITHUB_TOKEN ||
        process.env.GITLAB_TOKEN ||
        process.env.GITEA_TOKEN ||
        undefined
      );
  }
}
