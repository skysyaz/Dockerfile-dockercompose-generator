import { NextRequest, NextResponse } from "next/server";
import {
  cloneAndAnalyze,
  generateAllFiles,
  generateFromCache,
  parseGithubUrl,
  redactSecrets,
} from "@/lib/analyzer";
import type { Customizations } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      repoUrl?: string;
      githubToken?: string;
      port?: number;
      baseImageVersion?: string;
      extraEnv?: Record<string, string>;
      enabledServices?: string[];
    };

    const repoUrl = body.repoUrl?.trim();
    if (!repoUrl || !parseGithubUrl(repoUrl)) {
      return NextResponse.json(
        { detail: "Please enter a valid GitHub repository URL" },
        { status: 400 },
      );
    }

    const token = body.githubToken?.trim() || process.env.GITHUB_TOKEN || undefined;
    const customizations: Customizations = {
      port: body.port,
      baseImageVersion: body.baseImageVersion,
      extraEnv: body.extraEnv,
      enabledServices: body.enabledServices,
    };

    let analysis = generateFromCache(repoUrl, token, customizations)?.analysis;
    let files = generateFromCache(repoUrl, token, customizations)?.files;

    if (!analysis) {
      const result = await cloneAndAnalyze(repoUrl, token);
      analysis = result.analysis;
    }
    files = generateAllFiles(analysis, customizations);

    return NextResponse.json({
      analysis,
      customizations,
      files,
    });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : "An unexpected error occurred",
    );
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}
