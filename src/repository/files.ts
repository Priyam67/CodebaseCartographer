import { AnalysisFailure } from "@/src/types/graph";
import type { Diagnostic, RepoInfo, RepoLimits, SourceFile } from "@/src/types/graph";
import { detectLanguage, isManifestFile } from "@/src/parser/detect-language";

/** What a repository loader hands to the analysis engine. */
export interface RepositorySnapshot {
  repo: RepoInfo;
  /** Parseable source files (supported languages only). */
  files: SourceFile[];
  /** go.mod, Cargo.toml, tsconfig.json, ... used by the import resolver. */
  manifests: SourceFile[];
  /** Every non-ignored file path in the repo, used to tell assets from missing files. */
  knownPaths: string[];
  filesSkipped: number;
  totalBytes: number;
  diagnostics: Diagnostic[];
}

export interface RepoEntry {
  path: string;
  size: number;
}

export interface SelectionPlan {
  sources: RepoEntry[];
  manifests: RepoEntry[];
  skipped: number;
  totalBytes: number;
}

export const DEFAULT_LIMITS: RepoLimits = {
  maxFiles: 1000,
  maxFileBytes: 300_000,
  maxTotalBytes: 15_000_000,
  maxGraphNodes: 5000,
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadLimits(): RepoLimits {
  return {
    maxFiles: readPositiveInt("CARTOGRAPHER_MAX_FILES", DEFAULT_LIMITS.maxFiles),
    maxFileBytes: readPositiveInt("CARTOGRAPHER_MAX_FILE_BYTES", DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: readPositiveInt("CARTOGRAPHER_MAX_TOTAL_BYTES", DEFAULT_LIMITS.maxTotalBytes),
    maxGraphNodes: readPositiveInt("CARTOGRAPHER_MAX_GRAPH_NODES", DEFAULT_LIMITS.maxGraphNodes),
  };
}

const IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "third-party",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  "site-packages",
  "coverage",
  ".gradle",
  ".cache",
]);

const GENERATED_PATTERNS: readonly RegExp[] = [
  /\.min\.(js|mjs|cjs)$/,
  /\.bundle\.js$/,
  /\.pb\.go$/,
  /\.pb\.gw\.go$/,
  /_pb2(_grpc)?\.pyi?$/,
  /\.generated\.\w+$/,
  /\.gen\.\w+$/,
  /_generated\.\w+$/,
  /(^|\/)generated\//,
  /(^|\/)zz_generated/,
];

export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

/** True for dependency/vendored/build-output directories and generated files. */
export function isIgnoredPath(filePath: string): boolean {
  const segments = filePath.split("/");
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRS.has(segments[i] ?? "")) return true;
  }
  return GENERATED_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function isManifestCandidate(filePath: string): boolean {
  return isManifestFile(filePath) && !isIgnoredPath(filePath);
}

const MAX_MANIFESTS = 100;
const MAX_MANIFEST_BYTES = 200_000;

/**
 * Applies the resource limits to a listing of repository files *before* any
 * content is downloaded or read.
 */
export function planSelection(entries: readonly RepoEntry[], limits: RepoLimits): SelectionPlan {
  const sources: RepoEntry[] = [];
  const manifests: RepoEntry[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (isManifestCandidate(entry.path)) {
      if (entry.size <= MAX_MANIFEST_BYTES && manifests.length < MAX_MANIFESTS) manifests.push(entry);
      continue;
    }
    if (!detectLanguage(entry.path)) continue;
    if (isIgnoredPath(entry.path) || entry.size > limits.maxFileBytes) {
      skipped++;
      continue;
    }
    if (entry.size === 0) continue;
    sources.push(entry);
  }

  if (sources.length === 0) {
    throw new AnalysisFailure(
      "NO_SUPPORTED_FILES",
      "No analysable JavaScript, TypeScript, Python, Go or Rust files were found (vendored, generated and oversized files are skipped).",
    );
  }
  if (sources.length > limits.maxFiles) {
    throw new AnalysisFailure(
      "LIMIT_EXCEEDED",
      `The repository has ${sources.length} supported source files; the limit is ${limits.maxFiles}.`,
    );
  }
  const totalBytes = sources.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new AnalysisFailure(
      "LIMIT_EXCEEDED",
      `The source files total ${Math.round(totalBytes / 1024)} KB; the limit is ${Math.round(limits.maxTotalBytes / 1024)} KB.`,
    );
  }

  sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sources, manifests, skipped, totalBytes };
}

/** Decodes UTF-8 and rejects binary content. Returns null for binary files. */
export function decodeSource(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.includes("\u0000") ? null : text;
}

export function makeSourceFile(filePath: string, content: string): SourceFile {
  return { path: filePath, content, sizeBytes: Buffer.byteLength(content, "utf8") };
}

/** Runs `fn` over `items` with bounded concurrency; stops early if one call throws. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}