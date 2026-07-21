export function redactSecrets(message: string): string {
  return message
    .replace(/(https?:\/\/)[^@]+@/g, "$1")
    .replace(/\b(ghp_|github_pat_|glpat-)[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

export function classifyCloneError(
  rawMessage: string,
): { status: 404 | 401 | 504 | 429; message: string } | null {
  const message = redactSecrets(rawMessage);
  if (
    /fatal: repository ['"].*['"] does not exist|Repository not found|Invalid repository URL/i.test(
      message,
    )
  ) {
    return {
      status: 404,
      message:
        "Repository not found. Check the URL and provider, or provide an access token if the repo is private.",
    };
  }
  if (
    /could not read Username|could not read Password|Authentication failed|Permission denied|requires authentication/i.test(
      message,
    )
  ) {
    return {
      status: 401,
      message:
        "Could not access the repository. If it is private, provide a valid access token for that Git host.",
    };
  }
  if (/rate limit/i.test(message)) {
    return { status: 429, message };
  }
  if (
    /timed out|timeout|ETIMEDOUT|early EOF|RPC failed|fetch-pack: unexpected disconnect|aborted/i.test(
      message,
    )
  ) {
    return {
      status: 504,
      message:
        "Download timed out or was interrupted. The repository may be too large — try again or use a smaller repo.",
    };
  }
  return null;
}
