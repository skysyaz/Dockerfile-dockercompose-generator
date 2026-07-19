import { NextResponse } from "next/server";

export async function GET() {
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
