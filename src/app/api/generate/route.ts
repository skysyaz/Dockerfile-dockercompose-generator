import { NextRequest, NextResponse } from "next/server";
import {
  buildGeneratedFiles,
  cloneAndAnalyze,
  getCachedAnalysis,
  getCachedCloneDir,
  parseGithubUrl,
  redactSecrets,
} from "@/lib/analyzer";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { Customizations } from "@/lib/types";
import {
  sanitizeBaseImageVersion,
  sanitizeExtraEnv,
  sanitizePort,
} from "@/lib/validation";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`generate:${ip}`);
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
      port: sanitizePort(body.port),
      baseImageVersion: sanitizeBaseImageVersion(body.baseImageVersion),
      extraEnv: sanitizeExtraEnv(body.extraEnv),
      enabledServices: body.enabledServices,
    };

    let analysis = getCachedAnalysis(repoUrl, token);
    let cloneDir = getCachedCloneDir(repoUrl, token);

    if (!analysis) {
      const result = await cloneAndAnalyze(repoUrl, token);
      analysis = result.analysis;
      cloneDir = result.dir;
    }

    const { files, auditFixes } = await buildGeneratedFiles(
      analysis,
      customizations,
      cloneDir ?? undefined,
    );

    const effectivePort = customizations.port ?? analysis.port;
    const newNotes = auditFixes.filter(
      (fix) => !analysis.notes.some((note) => note.includes(fix)),
    );

    const enrichedAnalysis = {
      ...analysis,
      port: effectivePort,
      auditFixes,
      notes: newNotes.length ? [...analysis.notes, ...newNotes] : analysis.notes,
    };

    return NextResponse.json({
      analysis: enrichedAnalysis,
      customizations,
      files,
      auditFixes,
    });
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : "An unexpected error occurred",
    );
    return NextResponse.json({ detail: message }, { status: 500 });
  }
}
