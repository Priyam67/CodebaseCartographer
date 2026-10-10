import { promises as fs } from "node:fs";
import path from "node:path";
import { AnalysisFailure } from "@/src/types/graph";
import type { Diagnostic, RepoLimits, SourceFile } from "@/src/types/graph";
import { detectLanguage, isManifestFile } from "@/src/parser/detect-language";
import {
  decodeSource,
  isIgnoredDirName,
  isIgnoredPath,
  makeSourceFile,
  mapPool,
  planSelection,
  type RepoEntry,
  type RepositorySnapshot,
} from "./files";

// Development-only. Reads files from disk, so it is disabled unless all of:
//   NODE_ENV !== "production", CARTOGRAPHER_ENABLE_LOCAL=1, CARTOGRAPHER_LOCAL_ROOT=<dir>
// and the requested path must resolve (symlinks included) inside that root.

const MAX_SCANNED_FILES = 100_000;
const READ_CONCURRENCY = 16;

export function isLocalAnalysisEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.CARTOGRAPHER_ENABLE_LOCAL === "1" &&
    Boolean(process.env.CARTOGRAPHER_LOCAL_ROOT)
  );
}

interface WalkState {
  scanned: number;
  entries: RepoEntry[];
  knownPaths: string[];
}

async function walk(root: string, rel: string, state: WalkState): Promise<void> {
  const dirents = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      if (dirent.name.startsWith(".") || isIgnoredDirName(dirent.name)) continue;
      await walk(root, relPath, state);
      continue;
    }
    if (!dirent.isFile()) continue;

    state.scanned++;
    if (state.scanned > MAX_SCANNED_FILES) {
      throw new AnalysisFailure("LIMIT_EXCEEDED", "The folder contains too many files to scan.");
    }
    state.knownPaths.push(relPath);
    if (detectLanguage(relPath) || isManifestFile(relPath)) {
      const stat = await fs.stat(path.join(root, relPath));
      state.entries.push({ path: relPath, size: stat.size });
    }
  }
}

export async function loadLocalRepository(localPath: string, limits: RepoLimits): Promise<RepositorySnapshot> {
  if (!isLocalAnalysisEnabled()) {
    throw new AnalysisFailure(
      "LOCAL_DISABLED",
      "Local analysis is disabled. It is a development-only feature; see README.md.",
    );
  }

  let allowedRoot: string;
  try {
    allowedRoot = await fs.realpath(process.env.CARTOGRAPHER_LOCAL_ROOT ?? "");
  } catch {
    throw new AnalysisFailure("INVALID_REQUEST", "CARTOGRAPHER_LOCAL_ROOT does not point to an existing directory.");
  }

  let target: string;
  try {
    // Relative paths are interpreted relative to the allowed root.
    target = await fs.realpath(path.resolve(allowedRoot, localPath));
  } catch {
    throw new AnalysisFailure("NOT_FOUND", "That local path does not exist.");
  }
  if (target !== allowedRoot && !target.startsWith(allowedRoot + path.sep)) {
    throw new AnalysisFailure("INVALID_REQUEST", "The path must be inside CARTOGRAPHER_LOCAL_ROOT.");
  }
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) {
    throw new AnalysisFailure("INVALID_REQUEST", "The path must be a directory.");
  }

  const state: WalkState = { scanned: 0, entries: [], knownPaths: [] };
  await walk(target, "", state);

  const plan = planSelection(state.entries, limits);
  const diagnostics: Diagnostic[] = [];
  const maxBytes = Math.max(limits.maxFileBytes, 200_000);

  const reads = [...plan.manifests, ...plan.sources];
  const results = await mapPool(reads, READ_CONCURRENCY, async (entry): Promise<SourceFile | null> => {
    const buffer = await fs.readFile(path.join(target, entry.path));
    if (buffer.byteLength > maxBytes) return null;
    const text = decodeSource(buffer);
    if (text === null) {
      diagnostics.push({ severity: "info", filePath: entry.path, line: null, message: "Skipped: binary content." });
      return null;
    }
    return makeSourceFile(entry.path, text);
  });

  const manifests: SourceFile[] = [];
  const files: SourceFile[] = [];
  let skipped = plan.skipped;
  results.forEach((file, index) => {
    const isManifest = index < plan.manifests.length;
    if (!file) {
      if (!isManifest) skipped++;
      return;
    }
    (isManifest ? manifests : files).push(file);
  });

  if (files.length === 0) {
    throw new AnalysisFailure("NO_SUPPORTED_FILES", "No readable source files were found in that folder.");
  }

  return {
    repo: { source: "local", name: path.basename(target), owner: null, ref: null, url: null },
    files,
    manifests,
    knownPaths: state.knownPaths.filter((p) => !isIgnoredPath(p)),
    filesSkipped: skipped,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    diagnostics,
  };
}