import path from "node:path";
import type {
  Confidence,
  EdgeBasis,
  EdgeKind,
  ExtractedSymbol,
  FileExtraction,
  GraphEdge,
  GraphNode,
  Language,
} from "@/src/types/graph";

export function fileNodeId(filePath: string): string {
  return `file:${filePath}`;
}

export function makeEdge(
  source: string,
  target: string,
  kind: EdgeKind,
  basis: EdgeBasis,
  confidence: Confidence,
  note: string | null,
  line: number | null,
): GraphEdge {
  return { id: `${kind}|${source}|${target}`, source, target, kind, basis, confidence, note, line };
}

/** One analysed file's nodes plus lookup tables used by call resolution. */
export interface FileSymbols {
  path: string;
  language: Language;
  fileNode: GraphNode;
  /** Symbol nodes only (not the file node). */
  symbols: GraphNode[];
  byId: Map<string, GraphNode>;
  byLocalId: Map<string, GraphNode>;
  byName: Map<string, GraphNode[]>;
  /** Symbol children by parent node id (the file's own children are not listed). */
  children: Map<string, GraphNode[]>;
}

/**
 * Turns one file's extraction into graph nodes with globally unique ids and
 * the containment edges (file -> symbol, class -> method, ...).
 */
export function createFileSymbols(extraction: FileExtraction): { file: FileSymbols; containsEdges: GraphEdge[] } {
  const filePath = extraction.filePath;
  const fileId = fileNodeId(filePath);
  const directory = path.posix.dirname(filePath);

  const fileNode: GraphNode = {
    id: fileId,
    name: path.posix.basename(filePath),
    kind: "file",
    language: extraction.language,
    filePath,
    startLine: 1,
    endLine: Math.max(1, extraction.lineCount),
    parentId: null,
    exported: true,
    excerpt: null,
    details: { directory: directory === "." ? "(root)" : directory },
  };

  const local = new Map<string, ExtractedSymbol>();
  for (const symbol of extraction.symbols) local.set(symbol.localId, symbol);

  const qualifiedCache = new Map<string, string>();
  const qualified = (localId: string, depth: number): string => {
    const cached = qualifiedCache.get(localId);
    if (cached !== undefined) return cached;
    const symbol = local.get(localId);
    if (!symbol) return "";
    const parent = symbol.parentLocalId && depth < 20 ? qualified(symbol.parentLocalId, depth + 1) : "";
    const result = parent ? `${parent}.${symbol.name}` : symbol.name;
    qualifiedCache.set(localId, result);
    return result;
  };

  // First pass: ids (parents may be declared after their children for Go/Rust methods).
  const used = new Set<string>();
  const globalIds = new Map<string, string>();
  for (const symbol of extraction.symbols) {
    const base = `sym:${filePath}#${qualified(symbol.localId, 0)}:${symbol.startLine}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}~${suffix++}`;
    used.add(id);
    globalIds.set(symbol.localId, id);
  }

  const symbols: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();
  const byLocalId = new Map<string, GraphNode>();
  const byName = new Map<string, GraphNode[]>();
  const children = new Map<string, GraphNode[]>();
  const containsEdges: GraphEdge[] = [];

  for (const symbol of extraction.symbols) {
    const id = globalIds.get(symbol.localId);
    if (!id) continue;
    const parentId = (symbol.parentLocalId ? globalIds.get(symbol.parentLocalId) : undefined) ?? fileId;

    const node: GraphNode = {
      id,
      name: symbol.name,
      kind: symbol.kind,
      language: extraction.language,
      filePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      parentId,
      exported: symbol.exported,
      excerpt: symbol.excerpt,
      details: symbol.details,
    };
    symbols.push(node);
    byId.set(id, node);
    byLocalId.set(symbol.localId, node);
    byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), node]);
    if (parentId !== fileId) children.set(parentId, [...(children.get(parentId) ?? []), node]);

    const attached = parentId !== fileId && Boolean(symbol.details.receiver || symbol.details.implFor);
    containsEdges.push(
      makeEdge(
        parentId,
        id,
        "contains",
        "syntax",
        "high",
        attached ? "Attached to its type through the receiver / impl block." : null,
        symbol.startLine,
      ),
    );
  }

  return {
    file: { path: filePath, language: extraction.language, fileNode, symbols, byId, byLocalId, byName, children },
    containsEdges,
  };
}