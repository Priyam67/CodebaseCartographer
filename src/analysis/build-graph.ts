import path from "node:path";
import { AnalysisFailure } from "@/src/types/graph";
import type {
  AnalysisResult,
  AnalysisSummary,
  Confidence,
  Diagnostic,
  EdgeKind,
  FileExtraction,
  GraphEdge,
  GraphNode,
  Language,
  LanguageStats,
  RepoInfo,
  RepoLimits,
  SourceFile,
} from "@/src/types/graph";
import { parseSourceFile } from "@/src/parser/parse";
import { resolveCalls, type CallContext, type ImportedName, type ReExport } from "./calls";
import { createImportResolver, type Ecosystem, type ImportTarget } from "./imports";
import { createFileSymbols, makeEdge, type FileSymbols } from "./symbols";

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const MAX_DIAGNOSTICS = 200;
const MAX_UNRESOLVED_DIAGNOSTICS = 50;

export interface BuildInput {
  repo: RepoInfo;
  files: SourceFile[];
  manifests: SourceFile[];
  knownPaths: string[];
  filesSkipped: number;
  limits: RepoLimits;
  diagnostics: Diagnostic[];
}

/** Parses every file, normalises facts into one graph, then resolves imports and calls. */
export async function buildAnalysis(input: BuildInput): Promise<AnalysisResult> {
  const diagnostics: Diagnostic[] = [...input.diagnostics];

  /* ---- 1. parse ---- */
  const extractions: FileExtraction[] = [];
  let parseFailures = 0;
  const sortedFiles = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sortedFiles) {
    const extraction = await parseSourceFile(file);
    if (!extraction) continue;
    extractions.push(extraction);
    diagnostics.push(...extraction.diagnostics);
    if (extraction.diagnostics.some((d) => d.severity === "error")) parseFailures++;
  }
  if (extractions.length === 0) {
    throw new AnalysisFailure("NO_SUPPORTED_FILES", "None of the files could be parsed.");
  }

  /* ---- 2. nodes and containment ---- */
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (edge: GraphEdge): void => {
    const existing = edges.get(edge.id);
    if (!existing || CONFIDENCE_RANK[edge.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      edges.set(edge.id, edge);
    }
  };

  const filesByPath = new Map<string, FileSymbols>();
  const goPackages = new Map<string, FileSymbols[]>();
  for (const extraction of extractions) {
    const { file, containsEdges } = createFileSymbols(extraction);
    filesByPath.set(extraction.filePath, file);
    nodes.set(file.fileNode.id, file.fileNode);
    for (const symbol of file.symbols) nodes.set(symbol.id, symbol);
    containsEdges.forEach(addEdge);
    if (extraction.language === "go") {
      const dir = path.posix.dirname(extraction.filePath);
      goPackages.set(dir, [...(goPackages.get(dir) ?? []), file]);
    }
  }

  /* ---- 3. imports ---- */
  const resolver = createImportResolver({
    analyzedPaths: new Set(filesByPath.keys()),
    knownPaths: new Set(input.knownPaths),
    manifests: input.manifests,
  });

  const importsByFile = new Map<string, Map<string, ImportedName>>();
  const reexportsByFile = new Map<string, ReExport[]>();
  let importsResolved = 0;
  let importsExternal = 0;
  let importsUnresolved = 0;
  let unresolvedDiagnostics = 0;

  const ensureExternal = (ecosystem: Ecosystem, name: string): GraphNode => {
    const id = `ext:${ecosystem}:${name}`;
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = {
      id,
      name,
      kind: "external",
      language: null,
      filePath: null,
      startLine: null,
      endLine: null,
      parentId: null,
      exported: false,
      excerpt: null,
      details: { ecosystem },
    };
    nodes.set(id, node);
    return node;
  };

  const ensurePackage = (target: Extract<ImportTarget, { type: "package" }>): GraphNode => {
    const id = `pkg:go:${target.dir || "."}`;
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: GraphNode = {
      id,
      name: target.dir ? path.posix.basename(target.dir) : "(root package)",
      kind: "module",
      language: "go",
      filePath: target.dir || ".",
      startLine: null,
      endLine: null,
      parentId: null,
      exported: true,
      excerpt: null,
      details: { package: target.dir || ".", files: String(target.files.length) },
    };
    nodes.set(id, node);
    for (const filePath of target.files) {
      const file = filesByPath.get(filePath);
      if (file) addEdge(makeEdge(id, file.fileNode.id, "contains", "syntax", "high", "A Go package is the set of files in one directory.", null));
    }
    return node;
  };

  for (const extraction of extractions) {
    const file = filesByPath.get(extraction.filePath);
    if (!file) continue;
    const bindings = new Map<string, ImportedName>();
    importsByFile.set(extraction.filePath, bindings);

    for (const imp of extraction.imports) {
      const resolution = resolver.resolve(extraction.filePath, extraction.language, imp);
      const suffix = imp.typeOnly ? " (type-only import)" : "";

      if (resolution.status === "ignored") continue;

      if (resolution.status === "unresolved") {
        importsUnresolved++;
        if (unresolvedDiagnostics++ < MAX_UNRESOLVED_DIAGNOSTICS) {
          diagnostics.push({
            severity: "info",
            filePath: extraction.filePath,
            line: imp.line,
            message: `Unresolved import "${imp.specifier}": ${resolution.reason}`,
          });
        }
        continue;
      }

      if (resolution.status === "external") {
        importsExternal++;
        const external = ensureExternal(resolution.ecosystem, resolution.name);
        addEdge(
          makeEdge(file.fileNode.id, external.id, "imports", "syntax", resolution.confidence, `${resolution.note}${suffix}`, imp.line),
        );
        continue;
      }

      importsResolved++;
      for (const target of resolution.targets) {
        const targetId =
          target.type === "file" ? filesByPath.get(target.path)?.fileNode.id : ensurePackage(target).id;
        if (!targetId || targetId === file.fileNode.id) continue;
        addEdge(
          makeEdge(file.fileNode.id, targetId, "imports", resolution.basis, resolution.confidence, `${resolution.note}${suffix}`, imp.line),
        );
      }

      if (imp.style === "reexport") {
        const list = reexportsByFile.get(extraction.filePath) ?? [];
        for (const binding of imp.bindings) {
          list.push({ exportedName: binding.local, originalName: binding.imported, targets: resolution.targets });
        }
        reexportsByFile.set(extraction.filePath, list);
        continue;
      }

      for (const binding of imp.bindings) {
        if (binding.local === "*") continue;
        const submodule = binding.imported !== "*" ? resolution.submodules[binding.imported] : undefined;
        const entry: ImportedName = submodule
          ? { imported: "*", specifier: imp.specifier, targets: [{ type: "file", path: submodule }] }
          : { imported: binding.imported, specifier: imp.specifier, targets: resolution.targets };

        // `import a.b` (python) binds "a" but code calls `a.b.f()`: register the dotted name only.
        const dottedPython =
          extraction.language === "python" &&
          imp.specifier.includes(".") &&
          binding.imported === "*" &&
          binding.local === imp.specifier.split(".")[0];
        bindings.set(dottedPython ? imp.specifier : binding.local, entry);
      }
    }
  }

  /* ---- 4. calls ---- */
  let callsResolved = 0;
  let callsDropped = 0;
  for (const extraction of extractions) {
    const file = filesByPath.get(extraction.filePath);
    if (!file) continue;
    const context: CallContext = {
      file,
      filesByPath,
      goPackages,
      imports: importsByFile.get(extraction.filePath) ?? new Map<string, ImportedName>(),
      reexports: reexportsByFile,
    };
    const { resolved, dropped } = resolveCalls(context, extraction.calls);
    callsDropped += dropped;
    callsResolved += resolved.length;
    for (const call of resolved) {
      addEdge(makeEdge(call.sourceId, call.target.id, "calls", "inferred", call.confidence, call.note, call.line));
    }
  }

  /* ---- 5. limits and summary ---- */
  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  if (nodeList.length > input.limits.maxGraphNodes) {
    throw new AnalysisFailure(
      "LIMIT_EXCEEDED",
      `The map would contain ${nodeList.length} nodes, above the limit of ${input.limits.maxGraphNodes}. Try a smaller repository.`,
    );
  }

  const languages: Partial<Record<Language, LanguageStats>> = {};
  for (const extraction of extractions) {
    const stats = languages[extraction.language] ?? { files: 0, symbols: 0 };
    stats.files++;
    stats.symbols += extraction.symbols.length;
    languages[extraction.language] = stats;
  }

  const edgesByKind: Record<EdgeKind, number> = { contains: 0, imports: 0, calls: 0 };
  for (const edge of edgeList) edgesByKind[edge.kind]++;

  const summary: AnalysisSummary = {
    filesAnalyzed: extractions.length,
    filesSkipped: input.filesSkipped,
    totalBytes: input.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    symbolCount: extractions.reduce((sum, extraction) => sum + extraction.symbols.length, 0),
    languages,
    nodeCount: nodeList.length,
    edgeCount: edgeList.length,
    edgesByKind,
    importsResolved,
    importsExternal,
    importsUnresolved,
    callsResolved,
    callsDropped,
    parseFailures,
  };

  let finalDiagnostics = diagnostics;
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    finalDiagnostics = [
      ...diagnostics.slice(0, MAX_DIAGNOSTICS),
      {
        severity: "info",
        filePath: null,
        line: null,
        message: `${diagnostics.length - MAX_DIAGNOSTICS} more diagnostics were omitted.`,
      },
    ];
  }

  return { repo: input.repo, graph: { nodes: nodeList, edges: edgeList }, summary, diagnostics: finalDiagnostics };
}