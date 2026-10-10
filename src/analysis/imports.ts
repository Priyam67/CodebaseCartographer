import path from "node:path";
import type { Confidence, EdgeBasis, ExtractedImport, Language, SourceFile } from "@/src/types/graph";

const posix = path.posix;

/** What an import points at inside the repository. */
export type ImportTarget =
  | { type: "file"; path: string }
  | { type: "package"; dir: string; files: string[] };

export type Ecosystem = "js" | "python" | "go" | "rust";

export type ImportResolution =
  | {
      status: "resolved";
      targets: ImportTarget[];
      basis: EdgeBasis;
      confidence: Confidence;
      note: string;
      /** imported name -> file, for names that turned out to be submodules (python, rust). */
      submodules: Record<string, string>;
    }
  | { status: "external"; name: string; ecosystem: Ecosystem; confidence: Confidence; note: string }
  | { status: "unresolved"; reason: string }
  | { status: "ignored" };

export interface ImportResolverInput {
  /** Paths of files that became graph nodes. */
  analyzedPaths: ReadonlySet<string>;
  /** Every non-ignored file in the repo (to tell assets like .css from missing files). */
  knownPaths: ReadonlySet<string>;
  manifests: readonly SourceFile[];
}

export interface ImportResolver {
  resolve(fromPath: string, language: Language, imp: ExtractedImport): ImportResolution;
}

/* ------------------------------ helpers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dirOf(filePath: string): string {
  const dir = posix.dirname(filePath);
  return dir === "." ? "" : dir;
}

/** Normalises a joined path; null if it escapes the repository root. */
function norm(p: string): string | null {
  if (p === "." || p === "") return "";
  if (p === ".." || p.startsWith("../")) return null;
  return p;
}

function joinNorm(...parts: string[]): string | null {
  return norm(posix.join(...parts));
}

function parentDir(dir: string): string | null {
  return dir === "" ? null : dirOf(dir);
}

function resolved(
  targets: ImportTarget[],
  basis: EdgeBasis,
  confidence: Confidence,
  note: string,
  submodules: Record<string, string> = {},
): ImportResolution {
  return { status: "resolved", targets, basis, confidence, note, submodules };
}

function unresolved(reason: string): ImportResolution {
  return { status: "unresolved", reason };
}

const IGNORED: ImportResolution = { status: "ignored" };

/* ----------------------------- tsconfig ------------------------------ */

interface TsPathEntry {
  pattern: string;
  prefix: string;
  suffix: string;
  hasStar: boolean;
  targets: string[];
}

interface TsConfigInfo {
  dir: string;
  baseUrl: string | null;
  paths: TsPathEntry[];
}

function stripJsonComments(text: string): string {
  return text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, str: string | undefined) => str ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
}

function parseTsConfig(dir: string, content: string): TsConfigInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonComments(content));
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const options = data.compilerOptions;
  if (!isRecord(options)) return { dir, baseUrl: null, paths: [] };

  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : null;
  const paths: TsPathEntry[] = [];
  if (isRecord(options.paths)) {
    for (const [pattern, rawTargets] of Object.entries(options.paths)) {
      if (!Array.isArray(rawTargets)) continue;
      const targets = rawTargets.filter((t): t is string => typeof t === "string");
      const star = pattern.indexOf("*");
      paths.push({
        pattern,
        prefix: star === -1 ? pattern : pattern.slice(0, star),
        suffix: star === -1 ? "" : pattern.slice(star + 1),
        hasStar: star !== -1,
        targets,
      });
    }
  }
  return { dir, baseUrl, paths };
}

/* ------------------------------ manifests ---------------------------- */

interface CargoCrate {
  dir: string;
  name: string;
  srcDir: string;
  rootFile: string | null;
}

function parseCargoPackageName(content: string): string | null {
  const section = /\[package\]([^[]*)/.exec(content)?.[1];
  if (!section) return null;
  return /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
}

function parseGoModulePath(content: string): string | null {
  const raw = /^\s*module\s+(\S+)/m.exec(content)?.[1];
  return raw ? raw.replace(/^"|"$/g, "") : null;
}

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function jsPackageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/* ------------------------------ resolver ----------------------------- */

export function createImportResolver(input: ImportResolverInput): ImportResolver {
  const { analyzedPaths, knownPaths } = input;

  const manifestContent = new Map<string, string>();
  for (const manifest of input.manifests) manifestContent.set(manifest.path, manifest.content);

  const goModules: Array<{ dir: string; modulePath: string }> = [];
  const crates: CargoCrate[] = [];
  for (const manifest of input.manifests) {
    const base = posix.basename(manifest.path);
    if (base === "go.mod") {
      const modulePath = parseGoModulePath(manifest.content);
      if (modulePath) goModules.push({ dir: dirOf(manifest.path), modulePath });
    } else if (base === "Cargo.toml") {
      const name = parseCargoPackageName(manifest.content);
      if (!name) continue;
      const dir = dirOf(manifest.path);
      const srcDir = dir ? `${dir}/src` : "src";
      const lib = `${srcDir}/lib.rs`;
      const main = `${srcDir}/main.rs`;
      crates.push({ dir, name, srcDir, rootFile: analyzedPaths.has(lib) ? lib : analyzedPaths.has(main) ? main : null });
    }
  }
  goModules.sort((a, b) => b.modulePath.length - a.modulePath.length);
  crates.sort((a, b) => b.dir.length - a.dir.length);

  const goFilesByDir = new Map<string, string[]>();
  for (const filePath of analyzedPaths) {
    if (!filePath.endsWith(".go") || filePath.endsWith("_test.go")) continue;
    const dir = dirOf(filePath);
    goFilesByDir.set(dir, [...(goFilesByDir.get(dir) ?? []), filePath]);
  }

  const tsConfigCache = new Map<string, TsConfigInfo | null>();

  /* ---- JavaScript / TypeScript ---- */

  function probeJs(base: string): { path: string; exact: boolean } | null {
    if (analyzedPaths.has(base)) return { path: base, exact: true };

    // TypeScript ESM convention: "./foo.js" may refer to foo.ts
    const esm = /^(.*)\.(?:js|jsx|mjs|cjs)$/.exec(base);
    if (esm && esm[1] !== undefined) {
      for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
        const candidate = esm[1] + ext;
        if (analyzedPaths.has(candidate)) return { path: candidate, exact: false };
      }
    }
    for (const ext of JS_EXTENSIONS) {
      if (analyzedPaths.has(base + ext)) return { path: base + ext, exact: false };
    }
    const prefix = base ? `${base}/` : "";
    for (const ext of JS_EXTENSIONS) {
      const candidate = `${prefix}index${ext}`;
      if (analyzedPaths.has(candidate)) return { path: candidate, exact: false };
    }
    return null;
  }

  function findTsConfig(from: string): TsConfigInfo | null {
    let dir = dirOf(from);
    for (;;) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const manifestPath = dir ? `${dir}/${name}` : name;
        const content = manifestContent.get(manifestPath);
        if (content === undefined) continue;
        if (!tsConfigCache.has(manifestPath)) tsConfigCache.set(manifestPath, parseTsConfig(dir, content));
        return tsConfigCache.get(manifestPath) ?? null;
      }
      if (dir === "") return null;
      dir = dirOf(dir);
    }
  }

  function resolveAlias(from: string, specifier: string): ImportResolution | null {
    const config = findTsConfig(from);
    if (!config) return null;
    const root = config.baseUrl !== null ? joinNorm(config.dir, config.baseUrl) : config.dir;
    if (root === null) return null;

    for (const entry of config.paths) {
      let captured = "";
      if (entry.hasStar) {
        if (
          !specifier.startsWith(entry.prefix) ||
          !specifier.endsWith(entry.suffix) ||
          specifier.length < entry.prefix.length + entry.suffix.length
        ) {
          continue;
        }
        captured = specifier.slice(entry.prefix.length, specifier.length - entry.suffix.length);
      } else if (specifier !== entry.pattern) {
        continue;
      }
      for (const target of entry.targets) {
        const base = joinNorm(root, target.replace("*", captured));
        if (base === null) continue;
        const hit = probeJs(base);
        if (hit) {
          return resolved(
            [{ type: "file", path: hit.path }],
            "inferred",
            "medium",
            `Resolved through tsconfig/jsconfig path alias "${entry.pattern}".`,
          );
        }
      }
    }

    if (config.baseUrl !== null) {
      const base = joinNorm(root, specifier);
      const hit = base === null ? null : probeJs(base);
      if (hit) {
        return resolved([{ type: "file", path: hit.path }], "inferred", "medium", "Resolved through tsconfig baseUrl.");
      }
    }
    return null;
  }

  function resolveJs(from: string, specifier: string): ImportResolution {
    if (specifier.startsWith(".")) {
      const base = joinNorm(dirOf(from), specifier);
      if (base === null) return unresolved("The path escapes the repository root.");
      const hit = probeJs(base);
      if (hit) {
        return resolved(
          [{ type: "file", path: hit.path }],
          hit.exact ? "syntax" : "inferred",
          "high",
          hit.exact
            ? "Relative import; the file exists at the written path."
            : "Relative import resolved by trying file extensions and index files.",
        );
      }
      if (knownPaths.has(base)) return IGNORED; // e.g. a .css or .json asset
      return unresolved(`No analysed file matches "${specifier}".`);
    }

    const alias = resolveAlias(from, specifier);
    if (alias) return alias;
    // "@/x", "~/x" and "#x" cannot be npm package names, so they are unmatched aliases.
    if (/^(@\/|~\/|#)/.test(specifier)) {
      return unresolved(`Alias "${specifier}" is not covered by a tsconfig/jsconfig "paths" entry.`);
    }
    return {
      status: "external",
      name: jsPackageName(specifier),
      ecosystem: "js",
      confidence: "high",
      note: "Package outside this repository.",
    };
  }

  /* ---- Python ---- */

  function probePyModule(base: string): string | null {
    const candidates = [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`, `${base}/__init__.pyi`];
    return candidates.find((c) => analyzedPaths.has(c)) ?? null;
  }

  function probePyPackage(dir: string): string | null {
    const prefix = dir ? `${dir}/` : "";
    return [`${prefix}__init__.py`, `${prefix}__init__.pyi`].find((c) => analyzedPaths.has(c)) ?? null;
  }

  function resolvePython(from: string, imp: ExtractedImport): ImportResolution {
    const specifier = imp.specifier;
    const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
    const modulePath = specifier.slice(dots).replace(/\./g, "/");
    const importedNames = imp.bindings.map((b) => b.imported).filter((name) => name !== "*");

    const tryRoot = (root: string): { targets: ImportTarget[]; submodules: Record<string, string> } | null => {
      const base = joinNorm(root, modulePath);
      if (base === null) return null;
      const targets: ImportTarget[] = [];
      const submodules: Record<string, string> = {};

      const main = modulePath === "" ? probePyPackage(base) : probePyModule(base);
      if (main) targets.push({ type: "file", path: main });

      // `from pkg import mod`: "mod" may be a submodule file rather than a name.
      for (const name of importedNames) {
        const subBase = joinNorm(base, name);
        const sub = subBase === null || subBase === "" ? null : probePyModule(subBase);
        if (sub) {
          targets.push({ type: "file", path: sub });
          submodules[name] = sub;
        }
      }
      return targets.length > 0 ? { targets, submodules } : null;
    };

    if (dots > 0) {
      let dir: string | null = dirOf(from);
      for (let i = 1; i < dots && dir !== null; i++) dir = parentDir(dir);
      if (dir === null) return unresolved("Relative import goes above the repository root.");
      const hit = tryRoot(dir);
      return hit
        ? resolved(hit.targets, "inferred", "high", "Relative import resolved from the importing file's package.", hit.submodules)
        : unresolved(`No analysed module matches "${specifier}".`);
    }

    // Absolute import: Python resolves against sys.path, which we cannot know.
    // Try the usual layouts: the file's own directory, the repo root, and src/.
    const roots = [...new Set([dirOf(from), "", "src"])];
    for (const root of roots) {
      const hit = tryRoot(root);
      if (hit) {
        return resolved(
          hit.targets,
          "inferred",
          "medium",
          `Resolved against source root "${root || "."}" (sys.path layout is a guess).`,
          hit.submodules,
        );
      }
    }
    return {
      status: "external",
      name: specifier.split(".")[0] ?? specifier,
      ecosystem: "python",
      confidence: "medium",
      note: "Not found in the repository; assumed to be a standard-library or third-party package.",
    };
  }

  /* ---- Go ---- */

  function resolveGo(specifier: string): ImportResolution {
    const module = goModules.find((m) => specifier === m.modulePath || specifier.startsWith(`${m.modulePath}/`));
    if (module) {
      const rel = specifier === module.modulePath ? "" : specifier.slice(module.modulePath.length + 1);
      const dir = joinNorm(module.dir, rel);
      const files = dir === null ? undefined : goFilesByDir.get(dir);
      if (dir !== null && files && files.length > 0) {
        return resolved(
          [{ type: "package", dir, files }],
          "inferred",
          "high",
          "Resolved through the module path declared in go.mod.",
        );
      }
      return unresolved(`No analysed Go files in the package directory for "${specifier}".`);
    }
    return {
      status: "external",
      name: specifier,
      ecosystem: "go",
      confidence: "high",
      note: "Not part of any go.mod module in this repository (standard library or third-party).",
    };
  }

  /* ---- Rust ---- */

  function moduleDirOf(file: string): string {
    const base = posix.basename(file);
    if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") return dirOf(file);
    return file.replace(/\.rs$/, "");
  }

  function nearestCrate(from: string): CargoCrate | null {
    return crates.find((c) => c.dir === "" || from.startsWith(`${c.dir}/`)) ?? null;
  }

  /** Follows `a::b::c` through module files; stops at the first segment that is not a file. */
  function walkModules(startDir: string, segments: string[]): { file: string | null; consumed: number } {
    let dir = startDir;
    let file: string | null = null;
    let consumed = 0;
    for (const segment of segments) {
      const direct = joinNorm(dir, `${segment}.rs`);
      const modRs = joinNorm(dir, segment, "mod.rs");
      const hit = direct !== null && analyzedPaths.has(direct) ? direct : modRs !== null && analyzedPaths.has(modRs) ? modRs : null;
      if (!hit) break;
      file = hit;
      consumed++;
      const next = joinNorm(dir, segment);
      if (next === null) break;
      dir = next;
    }
    return { file, consumed };
  }

  function moduleFileForDir(dir: string, crate: CargoCrate | null): string | null {
    if (crate && dir === crate.srcDir) return crate.rootFile;
    return [`${dir}.rs`, `${dir}/mod.rs`].find((c) => analyzedPaths.has(c)) ?? null;
  }

  function resolveRust(from: string, imp: ExtractedImport): ImportResolution {
    const here = moduleDirOf(from);
    const crate = nearestCrate(from);

    if (imp.style === "mod") {
      const walked = walkModules(here, [imp.specifier]);
      if (walked.file) {
        return resolved(
          [{ type: "file", path: walked.file }],
          "inferred",
          "high",
          "`mod` declaration resolved to its module file.",
          { [imp.specifier]: walked.file },
        );
      }
      return unresolved(`No module file found for "mod ${imp.specifier};" (it may use #[path] or be cfg-gated).`);
    }

    const segments = imp.specifier.replace(/::\*$/, "").split("::").filter(Boolean);
    const first = segments[0];
    if (!first) return unresolved("Empty use path.");

    interface Attempt {
      startDir: string;
      fallbackFile: string | null;
      rest: string[];
      note: string;
    }
    const attempts: Attempt[] = [];

    if (first === "crate") {
      if (!crate) return unresolved("No Cargo.toml was found for this file.");
      attempts.push({ startDir: crate.srcDir, fallbackFile: crate.rootFile, rest: segments.slice(1), note: "Resolved from the crate root." });
    } else if (first === "self") {
      attempts.push({ startDir: here, fallbackFile: from, rest: segments.slice(1), note: "Resolved relative to the current module." });
    } else if (first === "super") {
      let dir: string | null = here;
      let index = 0;
      while (segments[index] === "super") {
        dir = dir === null ? null : parentDir(dir);
        index++;
      }
      if (dir === null) return unresolved("`super` goes above the repository root.");
      attempts.push({ startDir: dir, fallbackFile: moduleFileForDir(dir, crate), rest: segments.slice(index), note: "Resolved relative to the parent module." });
    } else {
      attempts.push({ startDir: here, fallbackFile: null, rest: segments, note: "Resolved as a child module of the current module." });
      const workspaceCrate = crates.find((c) => c.name.replace(/-/g, "_") === first);
      if (workspaceCrate) {
        attempts.push({ startDir: workspaceCrate.srcDir, fallbackFile: workspaceCrate.rootFile, rest: segments.slice(1), note: `Resolved into workspace crate "${workspaceCrate.name}".` });
      }
    }

    for (const attempt of attempts) {
      const walked = walkModules(attempt.startDir, attempt.rest);
      const file = walked.consumed > 0 ? walked.file : attempt.fallbackFile;
      if (!file) continue;
      const submodules: Record<string, string> = {};
      const last = attempt.rest[attempt.rest.length - 1];
      if (walked.consumed > 0 && walked.consumed === attempt.rest.length && last) submodules[last] = file;
      return resolved(
        [{ type: "file", path: file }],
        "inferred",
        "medium",
        `${attempt.note} The trailing segment is assumed to be an item inside that module.`,
        submodules,
      );
    }

    if (first === "crate" || first === "self" || first === "super") {
      return unresolved(`No module file found for "${imp.specifier}".`);
    }
    return {
      status: "external",
      name: first,
      ecosystem: "rust",
      confidence: "medium",
      note: "Not found in this repository; assumed to be std or an external crate.",
    };
  }

  return {
    resolve(fromPath: string, language: Language, imp: ExtractedImport): ImportResolution {
      switch (language) {
        case "javascript":
        case "typescript":
          return resolveJs(fromPath, imp.specifier);
        case "python":
          return resolvePython(fromPath, imp);
        case "go":
          return resolveGo(imp.specifier);
        case "rust":
          return resolveRust(fromPath, imp);
      }
    },
  };
}