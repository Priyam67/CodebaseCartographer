import { AnalysisFailure } from "@/src/types/graph";
import type { Diagnostic, RepoLimits, SourceFile } from "@/src/types/graph";
import {
  decodeSource,
  isIgnoredPath,
  makeSourceFile,
  mapPool,
  planSelection,
  type RepoEntry,
  type RepositorySnapshot,
} from "./files";

// Server-only. SSRF protection: URLs are always built from fixed GitHub hosts,
// and every redirect target is re-validated against this allowlist.
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const FETCH_CONCURRENCY = 8;
const USER_AGENT = "codebase-cartographer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  ref: string | null;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,100}$/;

const URL_HELP = "Use a URL like https://github.com/owner/repo (optionally .../tree/<branch>).";

/** Accepts only github.com repository URLs; throws INVALID_URL otherwise. */
export function parseGithubUrl(input: string): ParsedGithubUrl {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 300) {
    throw new AnalysisFailure("INVALID_URL", `Enter a GitHub repository URL. ${URL_HELP}`);
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new AnalysisFailure("INVALID_URL", `That does not look like a valid URL. ${URL_HELP}`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    throw new AnalysisFailure("INVALID_URL", `Only github.com repositories are supported. ${URL_HELP}`);
  }
  if (url.username || url.password || url.port) {
    throw new AnalysisFailure("INVALID_URL", `Credentials and custom ports are not allowed. ${URL_HELP}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repo || !OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new AnalysisFailure("INVALID_URL", `Could not find an owner and repository name. ${URL_HELP}`);
  }

  let ref: string | null = null;
  if (parts.length > 2) {
    if (parts[2] === "tree" && parts.length === 4 && parts[3]) {
      try {
        ref = decodeURIComponent(parts[3]);
      } catch {
        throw new AnalysisFailure("INVALID_URL", `The branch name in the URL is not valid. ${URL_HELP}`);
      }
      if (!REF_PATTERN.test(ref) || ref.includes("..")) {
        throw new AnalysisFailure("INVALID_URL", `The branch name in the URL is not valid. ${URL_HELP}`);
      }
    } else {
      throw new AnalysisFailure(
        "INVALID_URL",
        `Only whole repositories can be analysed (no sub-paths). ${URL_HELP}`,
      );
    }
  }

  return { owner, repo, ref };
}

async function githubFetch(rawUrl: string, token: string | undefined): Promise<Response> {
  let url = new URL(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub redirected to an unexpected host; the request was blocked.");
    }

    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (url.hostname === "api.github.com") {
      headers.Accept = "application/vnd.github+json";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      // The token is only ever attached to api.github.com requests.
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AnalysisFailure("UPSTREAM_ERROR", "Could not reach GitHub (network error or timeout).");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub sent an invalid redirect.");
      try {
        url = new URL(location, url);
      } catch {
        throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub sent an invalid redirect.");
      }
      continue;
    }
    return response;
  }

  throw new AnalysisFailure("UPSTREAM_ERROR", "Too many redirects from GitHub.");
}

function failureFor(response: Response, subject: string): AnalysisFailure {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 && (remaining === "0" || response.headers.has("retry-after")));
  if (rateLimited) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const when =
      Number.isFinite(reset) && reset > 0 ? ` The limit resets around ${new Date(reset * 1000).toISOString()}.` : "";
    return new AnalysisFailure(
      "RATE_LIMITED",
      `GitHub rate limit reached.${when} Try again later, or ask the server operator to configure a GITHUB_TOKEN for higher limits.`,
    );
  }
  if (response.status === 404 || response.status === 403 || response.status === 422) {
    return new AnalysisFailure(
      "NOT_FOUND",
      `${subject} was not found, or it is private or unavailable. Only public repositories are supported.`,
    );
  }
  if (response.status === 409) {
    return new AnalysisFailure("NO_SUPPORTED_FILES", "The repository is empty.");
  }
  return new AnalysisFailure("UPSTREAM_ERROR", `GitHub responded with status ${response.status}.`);
}

async function getJson(url: string, token: string | undefined, subject: string): Promise<Record<string, unknown>> {
  const response = await githubFetch(url, token);
  if (!response.ok) {
    await response.body?.cancel();
    throw failureFor(response, subject);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub returned an unreadable response.");
  }
  if (!isRecord(data)) throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub returned an unexpected response.");
  return data;
}

function rawUrl(owner: string, repo: string, sha: string, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${encodedPath}`;
}

/**
 * Loads a public repository through the Git Trees API plus raw file downloads.
 * Chosen over a clone because it needs no git binary, downloads only the files
 * that pass the limits, and keeps all network access on two GitHub hosts.
 * Public repositories work without a token; GITHUB_TOKEN only raises API limits.
 */
export async function loadGithubRepository(repoUrl: string, limits: RepoLimits): Promise<RepositorySnapshot> {
  const parsed = parseGithubUrl(repoUrl);
  const token = process.env.GITHUB_TOKEN?.trim() || undefined;
  const repoApi = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;

  let ref = parsed.ref;
  let owner = parsed.owner;
  let name = parsed.repo;

  if (!ref) {
    const meta = await getJson(repoApi, token, "The repository");
    if (typeof meta.default_branch !== "string" || !meta.default_branch) {
      throw new AnalysisFailure("NOT_FOUND", "The repository's default branch is unavailable.");
    }
    ref = meta.default_branch;
    if (typeof meta.name === "string") name = meta.name;
    if (isRecord(meta.owner) && typeof meta.owner.login === "string") owner = meta.owner.login;
  }

  const commit = await getJson(`${repoApi}/commits/${encodeURIComponent(ref)}`, token, `The branch or ref "${ref}"`);
  const sha = commit.sha;
  const treeSha = isRecord(commit.commit) && isRecord(commit.commit.tree) ? commit.commit.tree.sha : undefined;
  if (typeof sha !== "string" || typeof treeSha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub returned an unexpected commit response.");
  }

  const tree = await getJson(`${repoApi}/git/trees/${treeSha}?recursive=1`, token, "The repository tree");
  if (tree.truncated === true) {
    throw new AnalysisFailure(
      "LIMIT_EXCEEDED",
      "The repository is too large to list in one GitHub request. Try a smaller repository.",
    );
  }
  if (!Array.isArray(tree.tree)) {
    throw new AnalysisFailure("UPSTREAM_ERROR", "GitHub returned an unexpected tree response.");
  }

  const entries: RepoEntry[] = [];
  for (const item of tree.tree as unknown[]) {
    if (!isRecord(item)) continue;
    const { path: itemPath, type, size, mode } = item;
    if (type !== "blob" || mode === "120000") continue; // skip dirs, submodules, symlinks
    if (typeof itemPath !== "string" || typeof size !== "number") continue;
    entries.push({ path: itemPath, size });
  }

  const plan = planSelection(entries, limits);
  const knownPaths = entries.map((entry) => entry.path).filter((p) => !isIgnoredPath(p));

  const diagnostics: Diagnostic[] = [];
  const downloads = [...plan.manifests, ...plan.sources];
  const maxBytes = Math.max(limits.maxFileBytes, 200_000);

  const results = await mapPool(downloads, FETCH_CONCURRENCY, async (entry): Promise<SourceFile | null> => {
    const response = await githubFetch(rawUrl(owner, name, sha, entry.path), undefined);
    if (response.status === 429) {
      await response.body?.cancel();
      throw new AnalysisFailure("RATE_LIMITED", "GitHub throttled file downloads. Try again in a few minutes.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      diagnostics.push({
        severity: "info",
        filePath: entry.path,
        line: null,
        message: `Skipped: download failed with status ${response.status}.`,
      });
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return null;
    const text = decodeSource(bytes);
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
    throw new AnalysisFailure("NO_SUPPORTED_FILES", "No source files could be downloaded from this repository.");
  }

  return {
    repo: {
      source: "github",
      name,
      owner,
      ref: `${ref} (${sha.slice(0, 7)})`,
      url: `https://github.com/${owner}/${name}`,
    },
    files,
    manifests,
    knownPaths,
    filesSkipped: skipped,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    diagnostics,
  };
}