import { NextRequest, NextResponse } from "next/server";
import {
  buildGeneratedFiles,
  cloneAndAnalyze,
  getCachedAnalysis,
  getCachedCloneDir,
  redactSecrets,
} from "@/lib/analyzer";
import { buildEffectiveEnvVars } from "@/lib/env-discovery";
import { parseRepoUrl, resolveAccessToken } from "@/lib/repo-url";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { Customizations } from "@/lib/types";
import {
  sanitizeBaseImageVersion,
  sanitizeDatabaseMode,
  sanitizeEnvValues,
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
      accessToken?: string;
      port?: number;
      baseImageVersion?: string;
      extraEnv?: Record<string, string>;
      enabledServices?: string[];
      databaseMode?: "bundled" | "external";
      envValues?: Record<string, string>;
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
      parsed.host,
    );
    const customizations: Customizations = {
      port: sanitizePort(body.port),
      baseImageVersion: sanitizeBaseImageVersion(body.baseImageVersion),
      extraEnv: sanitizeExtraEnv(body.extraEnv),
      enabledServices: body.enabledServices,
      databaseMode: sanitizeDatabaseMode(body.databaseMode),
      envValues: sanitizeEnvValues(body.envValues),
    };

    let analysis = getCachedAnalysis(repoUrl, token);
    let cloneDir = getCachedCloneDir(repoUrl, token);

    if (!analysis || !Array.isArray(analysis.rootFiles) || !cloneDir) {
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
      envVars: buildEffectiveEnvVars(analysis, customizations),
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
