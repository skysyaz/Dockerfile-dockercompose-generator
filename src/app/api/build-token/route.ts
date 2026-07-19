import { NextResponse } from "next/server";

export async function GET() {
  const token = process.env.BUILD_SERVICE_TOKEN;
  if (!token) {
    return NextResponse.json(
      { detail: "Test Build is disabled. Set BUILD_SERVICE_TOKEN to enable." },
      { status: 503 },
    );
  }
  return NextResponse.json({ token });
}
