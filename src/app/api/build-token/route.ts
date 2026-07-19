import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// NOTE: this endpoint hands the build-service token to any visitor who can
// reach the UI. Only enable Test Build (BUILD_SERVICE_TOKEN) on deployments
// that are private or protected by an auth layer in front of the app.
export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`build-token:${ip}`);
  if (!limit.allowed) {
    return NextResponse.json(
      { detail: `Rate limit exceeded. Try again in ${limit.retryAfterSec} seconds.` },
      { status: 429 },
    );
  }

  const token = process.env.BUILD_SERVICE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { detail: "Test Build is disabled. Set BUILD_SERVICE_TOKEN to enable." },
      { status: 503 },
    );
  }
  const serverTokenConfigured = Boolean(
    process.env.GITHUB_TOKEN ||
      process.env.GITLAB_TOKEN ||
      process.env.BITBUCKET_TOKEN ||
      process.env.GITEA_TOKEN,
  );
  return NextResponse.json({ token, serverTokenConfigured });
}
