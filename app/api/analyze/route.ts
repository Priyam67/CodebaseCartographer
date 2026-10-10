import { NextResponse } from "next/server";
import { buildAnalysis } from "@/src/analysis/build-graph";
import { loadGithubRepository } from "@/src/repository/github";
import { loadLimits, type RepositorySnapshot } from "@/src/repository/files";
import { isLocalAnalysisEnabled, loadLocalRepository } from "@/src/repository/local";
import { AnalysisFailure } from "@/src/types/graph";
import type { AnalysisErrorBody, AnalysisErrorCode, AnalyzeResponse } from "@/src/types/graph";

// Tree-sitter WASM and the filesystem need the Node.js runtime, not the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_CHARS = 10_000;

const STATUS_BY_CODE: Record<AnalysisErrorCode, number> = {
  INVALID_REQUEST: 400,
  INVALID_URL: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  LIMIT_EXCEEDED: 422,
  NO_SUPPORTED_FILES: 422,
  UPSTREAM_ERROR: 502,
  LOCAL_DISABLED: 403,
  INTERNAL_ERROR: 500,
};

function errorResponse(code: AnalysisErrorCode, message: string): NextResponse<AnalysisErrorBody> {
  return NextResponse.json({ error: { code, message } }, { status: STATUS_BY_CODE[code] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request): Promise<NextResponse<AnalyzeResponse>> {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) {
      return errorResponse("INVALID_REQUEST", "Request body is too large.");
    }
    body = JSON.parse(text);
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.");
  }

  if (!isRecord(body)) {
    return errorResponse("INVALID_REQUEST", 'Expected a JSON object like {"repoUrl": "https://github.com/owner/repo"}.');
  }
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
  const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
  if ((repoUrl ? 1 : 0) + (localPath ? 1 : 0) !== 1) {
    return errorResponse("INVALID_REQUEST", 'Provide exactly one of "repoUrl" or "localPath".');
  }

  const limits = loadLimits();
  try {
    let snapshot: RepositorySnapshot;
    if (localPath) {
      if (!isLocalAnalysisEnabled()) {
        return errorResponse("LOCAL_DISABLED", "Local analysis is disabled. It is a development-only feature; see README.md.");
      }
      snapshot = await loadLocalRepository(localPath, limits);
    } else {
      snapshot = await loadGithubRepository(repoUrl, limits);
    }

    const result = await buildAnalysis({
      repo: snapshot.repo,
      files: snapshot.files,
      manifests: snapshot.manifests,
      knownPaths: snapshot.knownPaths,
      filesSkipped: snapshot.filesSkipped,
      limits,
      diagnostics: snapshot.diagnostics,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AnalysisFailure) return errorResponse(error.code, error.message);
    // Log server-side only; never echo internal error text (it could include paths or tokens).
    console.error("Unexpected analysis failure:", error);
    return errorResponse("INTERNAL_ERROR", "Unexpected error while analysing the repository.");
  }
}