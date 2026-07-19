import { NextRequest, NextResponse } from "next/server";
import {
  classifyCloneError,
  cloneAndAnalyze,
  redactSecrets,
} from "@/lib/analyzer";
import { parseRepoUrl, resolveAccessToken } from "@/lib/repo-url";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`analyze:${ip}`);
  if (!limit.allowed) {
    return NextResponse.json(
      { detail: `Rate limit exceeded. Try again in ${limit.retryAfterSec} seconds.` },
      { status: 429 },
    );
  }

  try {
    const body = (await request.json()) as {
      repoUrl?: string;
      githubToken?: string;
      accessToken?: string;
    };

    const repoUrl = body.repoUrl?.trim();
    const parsed = repoUrl ? parseRepoUrl(repoUrl) : null;
    if (!repoUrl || !parsed) {
      return NextResponse.json(
        {
          detail:
            "Please enter a valid repository URL (GitHub, GitLab, Bitbucket, Codeberg, or Gitea).",
        },
        { status: 400 },
      );
    }

    const token = resolveAccessToken(
      parsed.provider,
      body.accessToken || body.githubToken,
    );
    const { analysis } = await cloneAndAnalyze(repoUrl, token);

    return NextResponse.json({
      analysis,
      tokenProvided: Boolean(token),
      redactedUrl: repoUrl.replace(/\.git$/, ""),
    });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : "An unexpected error occurred",
    );
    const classified = classifyCloneError(message);
    if (classified) {
      return NextResponse.json({ detail: classified.message }, { status: classified.status });
    }
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}
