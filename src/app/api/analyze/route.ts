import { NextRequest, NextResponse } from "next/server";
import {
  classifyCloneError,
  cloneAndAnalyze,
  parseGithubUrl,
  redactSecrets,
} from "@/lib/analyzer";
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
    };

    const repoUrl = body.repoUrl?.trim();
    if (!repoUrl || !parseGithubUrl(repoUrl)) {
      return NextResponse.json(
        { detail: "Please enter a valid GitHub repository URL" },
        { status: 400 },
      );
    }

    const token = body.githubToken?.trim() || process.env.GITHUB_TOKEN || undefined;
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
