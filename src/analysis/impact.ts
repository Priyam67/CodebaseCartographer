import type { CodeGraph, Confidence, EdgeBasis, GraphEdge, GraphNode } from "@/src/types/graph";

/**
 * Change-impact analysis over the existing graph. Pure TypeScript with no server
 * imports, so it runs in the browser on the result the API already returned.
 *
 * Direction: a hop {from, to} means "`from` depends on `to`". Starting at the
 * target, we walk those hops backwards to find everything that depends on it.
 * Only `imports` and `calls` edges are dependencies; `contains` is used solely to
 * attach a type's members (symbol targets) or a Go package's files (file targets).
 */

export type ImpactMode = "file" | "symbol";
/** Same vocabulary as GraphEdge.basis: "syntax" = read from code, "inferred" = heuristic. */
export type ImpactEvidence = EdgeBasis;
export type ImpactRelation = "imports" | "calls";

export const MAX_IMPACT_NODES = 1500;
const MAX_MEMBERS = 500;
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export interface ImpactHop {
  /** The dependent node. */
  from: string;
  /** The node it depends on (closer to the target). */
  to: string;
  relation: ImpactRelation;
  basis: EdgeBasis;
  confidence: Confidence;
  /** Explanation taken from the underlying graph edge(s). */
  note: string;
  /** Line of the import/call site inside `from`'s file. */
  line: number | null;
  /** How many underlying edges were merged into this hop. */
  count: number;
  /** Member symbol or Go package the hop passes through, if any. */
  viaId: string | null;
}

export interface ImpactItem {
  nodeId: string;
  /** True when the displayed chain has exactly one hop. */
  direct: boolean;
  distance: number;
  /** Weakest hop of the displayed chain. */
  evidence: ImpactEvidence;
  /** Lowest confidence along the displayed chain. */
  confidence: Confidence;
  /** Shortest chain from this node to the target. */
  chain: ImpactHop[];
  /** Shortest chain made only of syntax-derived hops, when the main chain is inferred but one exists. */
  syntaxChain: ImpactHop[] | null;
}

export interface ImpactSummary {
  total: number;
  direct: number;
  transitive: number;
  syntax: number;
  inferred: number;
  /** Inferred items that also have a syntax-only route. */
  withSyntaxAlternative: number;
  maxDepth: number;
  files: number;
  symbols: number;
  directories: Array<{ directory: string; count: number }>;
}

export interface ImpactResult {
  targetId: string;
  mode: ImpactMode;
  items: ImpactItem[];
  summary: ImpactSummary;
  truncated: boolean;
  /** Members of a type target that were included in the search. */
  memberCount: number;
}

export type ImpactOutcome = { ok: true; result: ImpactResult } | { ok: false; reason: string };
export type TargetCheck = { ok: true; mode: ImpactMode } | { ok: false; reason: string };

export interface ImpactEngine {
  analyze(targetId: string): ImpactOutcome;
}

/** Everything the graph view needs to highlight a result. */
export interface ImpactHighlight {
  targetId: string;
  mode: ImpactMode;
  evidenceById: ReadonlyMap<string, ImpactEvidence>;
  /** Intermediate nodes (members, Go packages) that explain a hop. */
  extraIds: ReadonlySet<string>;
  /** "from|to" -> evidence, for edges that lie on a displayed chain. */
  hopPairs: ReadonlyMap<string, ImpactEvidence>;
}

/* ------------------------------ helpers ------------------------------ */

function isSymbolNode(node: GraphNode): boolean {
  return node.kind !== "file" && node.kind !== "external" && !node.id.startsWith("pkg:");
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function directoryOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  return slash === -1 ? "(root)" : filePath.slice(0, slash);
}

export function checkImpactTarget(node: GraphNode | null | undefined): TargetCheck {
  if (!node) return { ok: false, reason: "The selected node is not part of this graph." };
  if (node.kind === "file") return { ok: true, mode: "file" };
  if (node.kind === "external") {
    return { ok: false, reason: "External packages are outside the analysed repository, so they cannot be analysed." };
  }
  if (node.id.startsWith("pkg:")) {
    return { ok: false, reason: "Change-impact analysis is available for files and symbols. Select a file in this package." };
  }
  return { ok: true, mode: "symbol" };
}

interface Candidate {
  from: string;
  relation: ImpactRelation;
  edge: GraphEdge;
  viaId: string | null;
  note: string;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const basis = (c: Candidate): number => (c.edge.basis === "syntax" ? 0 : 1);
  return (
    basis(a) - basis(b) ||
    CONFIDENCE_RANK[b.edge.confidence] - CONFIDENCE_RANK[a.edge.confidence] ||
    (a.relation === b.relation ? 0 : a.relation === "imports" ? -1 : 1) ||
    a.edge.id.localeCompare(b.edge.id)
  );
}

/** Merges parallel candidates per dependent, keeping the strongest evidence. */
function reduce(to: string, candidates: readonly Candidate[]): ImpactHop[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) push(groups, candidate.from, candidate);

  const hops: ImpactHop[] = [];
  for (const [from, group] of groups) {
    group.sort(compareCandidates);
    const best = group[0];
    if (!best) continue;
    hops.push({
      from,
      to,
      relation: best.relation,
      basis: best.edge.basis,
      confidence: best.edge.confidence,
      note: best.note.trim(),
      line: best.edge.line,
      count: group.length,
      viaId: best.viaId,
    });
  }
  hops.sort((a, b) => (a.basis === b.basis ? 0 : a.basis === "syntax" ? -1 : 1) || a.from.localeCompare(b.from));
  return hops;
}

interface Traversal {
  parent: Map<string, ImpactHop>;
  order: string[];
  truncated: boolean;
}

/** Breadth-first search over reverse dependencies; a visited set makes cycles harmless. */
function traverse(
  rootId: string,
  expand: (id: string) => ImpactHop[],
  excluded: ReadonlySet<string>,
  syntaxOnly: boolean,
): Traversal {
  const parent = new Map<string, ImpactHop>();
  const order: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  let truncated = false;

  for (let head = 0; head < queue.length && !truncated; head++) {
    const current = queue[head];
    if (current === undefined) break;
    for (const hop of expand(current)) {
      if (syntaxOnly && hop.basis !== "syntax") continue;
      if (seen.has(hop.from) || excluded.has(hop.from)) continue;
      if (order.length >= MAX_IMPACT_NODES) {
        truncated = true;
        break;
      }
      seen.add(hop.from);
      parent.set(hop.from, hop);
      order.push(hop.from);
      queue.push(hop.from);
    }
  }
  return { parent, order, truncated };
}

function chainOf(parent: ReadonlyMap<string, ImpactHop>, nodeId: string, rootId: string): ImpactHop[] | null {
  const chain: ImpactHop[] = [];
  let current = nodeId;
  for (let guard = 0; current !== rootId && guard < 10_000; guard++) {
    const hop = parent.get(current);
    if (!hop) return null;
    chain.push(hop);
    current = hop.to;
  }
  return current === rootId ? chain : null;
}

function weakestConfidence(chain: readonly ImpactHop[]): Confidence {
  let lowest: Confidence = "high";
  for (const hop of chain) {
    if (CONFIDENCE_RANK[hop.confidence] < CONFIDENCE_RANK[lowest]) lowest = hop.confidence;
  }
  return lowest;
}

/* -------------------------------- engine ------------------------------- */

export function createImpactEngine(graph: CodeGraph): ImpactEngine {
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodes.set(node.id, node);

  const incoming = new Map<string, GraphEdge[]>();
  const children = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue; // tolerate dangling edges
    push(incoming, edge.target, edge);
    if (edge.kind === "contains") push(children, edge.source, edge.target);
  }

  const fileIdCache = new Map<string, string | null>();
  /** Follows parentId up to the containing file node. */
  function fileIdOf(node: GraphNode): string | null {
    if (fileIdCache.has(node.id)) return fileIdCache.get(node.id) ?? null;
    let found: string | null = null;
    let current: GraphNode | undefined = node;
    for (let guard = 0; current && guard < 25; guard++) {
      if (current.kind === "file") {
        found = current.id;
        break;
      }
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    fileIdCache.set(node.id, found);
    return found;
  }

  let cachedSymbols: Map<string, GraphNode[]> | null = null;
  function symbolsOfFile(fileId: string): GraphNode[] {
    if (!cachedSymbols) {
      const map = new Map<string, GraphNode[]>();
      for (const node of nodes.values()) {
        if (!isSymbolNode(node)) continue;
        const owner = fileIdOf(node);
        if (owner) push(map, owner, node);
      }
      cachedSymbols = map;
    }
    return cachedSymbols.get(fileId) ?? [];
  }

  function descendants(rootId: string): string[] {
    const found: string[] = [];
    const seen = new Set<string>([rootId]);
    const stack = [rootId];
    while (stack.length > 0 && found.length < MAX_MEMBERS) {
      const current = stack.pop();
      if (current === undefined) break;
      for (const childId of children.get(current) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        found.push(childId);
        stack.push(childId);
      }
    }
    return found;
  }

  /** Files that depend on `fileId`: importers, Go package importers, and files calling into it. */
  function fileDependents(fileId: string): ImpactHop[] {
    const candidates: Candidate[] = [];

    const collectImports = (targetId: string, via: GraphNode | null): void => {
      for (const edge of incoming.get(targetId) ?? []) {
        if (edge.kind !== "imports") continue;
        const source = nodes.get(edge.source);
        if (!source || source.kind !== "file" || source.id === fileId) continue;
        candidates.push({
          from: source.id,
          relation: "imports",
          edge,
          viaId: via?.id ?? null,
          note: via
            ? `Imports the Go package that contains this file (Go imports are package-level). ${edge.note ?? ""}`
            : (edge.note ?? "Import statement."),
        });
      }
    };

    collectImports(fileId, null);
    for (const edge of incoming.get(fileId) ?? []) {
      if (edge.kind === "contains" && edge.source.startsWith("pkg:")) {
        const pkg = nodes.get(edge.source);
        if (pkg) collectImports(pkg.id, pkg);
      }
    }

    for (const symbol of symbolsOfFile(fileId)) {
      for (const edge of incoming.get(symbol.id) ?? []) {
        if (edge.kind !== "calls") continue;
        const caller = nodes.get(edge.source);
        if (!caller) continue;
        const callerFile = caller.kind === "file" ? caller.id : fileIdOf(caller);
        if (!callerFile || callerFile === fileId) continue;
        candidates.push({
          from: callerFile,
          relation: "calls",
          edge,
          viaId: symbol.id,
          note: `${caller.name} calls ${symbol.name}. ${edge.note ?? ""}`,
        });
      }
    }
    return reduce(fileId, candidates);
  }

  /** Callers of `id`; for the root type also callers of its members. */
  function symbolDependents(id: string, members: readonly string[]): ImpactHop[] {
    const target = nodes.get(id);
    if (!target) return [];
    const candidates: Candidate[] = [];
    for (const calleeId of [id, ...members]) {
      const callee = nodes.get(calleeId);
      if (!callee) continue;
      const viaId = calleeId === id ? null : calleeId;
      for (const edge of incoming.get(calleeId) ?? []) {
        if (edge.kind !== "calls" || !nodes.has(edge.source)) continue;
        const prefix = viaId ? `Calls ${callee.name}, a member of ${target.name}. ` : "";
        candidates.push({
          from: edge.source,
          relation: "calls",
          edge,
          viaId,
          note: `${prefix}${edge.note ?? "Resolved call."}`,
        });
      }
    }
    return reduce(id, candidates);
  }

  return {
    analyze(targetId: string): ImpactOutcome {
      const target = nodes.get(targetId);
      if (!target) return { ok: false, reason: "The selected node is not part of this graph." };
      const check = checkImpactTarget(target);
      if (!check.ok) return { ok: false, reason: check.reason };

      const mode = check.mode;
      const members = mode === "symbol" ? descendants(targetId) : [];
      const excluded = new Set<string>([targetId, ...members]);

      const cache = new Map<string, ImpactHop[]>();
      const expand = (id: string): ImpactHop[] => {
        const cached = cache.get(id);
        if (cached) return cached;
        const hops = mode === "file" ? fileDependents(id) : symbolDependents(id, id === targetId ? members : []);
        cache.set(id, hops);
        return hops;
      };

      const all = traverse(targetId, expand, excluded, false);
      const syntaxOnly = traverse(targetId, expand, excluded, true);

      const items: ImpactItem[] = [];
      for (const nodeId of all.order) {
        const chain = chainOf(all.parent, nodeId, targetId);
        if (!chain || chain.length === 0) continue;
        const evidence: ImpactEvidence = chain.every((hop) => hop.basis === "syntax") ? "syntax" : "inferred";
        items.push({
          nodeId,
          direct: chain.length === 1,
          distance: chain.length,
          evidence,
          confidence: weakestConfidence(chain),
          chain,
          syntaxChain: evidence === "inferred" ? chainOf(syntaxOnly.parent, nodeId, targetId) : null,
        });
      }

      items.sort(
        (a, b) =>
          a.distance - b.distance ||
          (a.evidence === b.evidence ? 0 : a.evidence === "syntax" ? -1 : 1) ||
          (nodes.get(a.nodeId)?.filePath ?? "").localeCompare(nodes.get(b.nodeId)?.filePath ?? "") ||
          (nodes.get(a.nodeId)?.name ?? "").localeCompare(nodes.get(b.nodeId)?.name ?? ""),
      );

      const fileIds = new Set<string>();
      const directoryCounts = new Map<string, number>();
      let symbols = 0;
      for (const item of items) {
        const node = nodes.get(item.nodeId);
        if (!node) continue;
        if (isSymbolNode(node)) symbols++;
        const owner = node.kind === "file" ? node.id : fileIdOf(node);
        if (owner) fileIds.add(owner);
        if (node.filePath) {
          const directory = directoryOf(node.filePath);
          directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
        }
      }

      const summary: ImpactSummary = {
        total: items.length,
        direct: items.filter((item) => item.direct).length,
        transitive: items.filter((item) => !item.direct).length,
        syntax: items.filter((item) => item.evidence === "syntax").length,
        inferred: items.filter((item) => item.evidence === "inferred").length,
        withSyntaxAlternative: items.filter((item) => item.syntaxChain !== null).length,
        maxDepth: items.reduce((max, item) => Math.max(max, item.distance), 0),
        files: fileIds.size,
        symbols,
        directories: [...directoryCounts.entries()]
          .map(([directory, count]) => ({ directory, count }))
          .sort((a, b) => b.count - a.count || a.directory.localeCompare(b.directory))
          .slice(0, 5),
      };

      return {
        ok: true,
        result: { targetId, mode, items, summary, truncated: all.truncated, memberCount: members.length },
      };
    },
  };
}

export function buildImpactHighlight(result: ImpactResult): ImpactHighlight {
  const evidenceById = new Map<string, ImpactEvidence>();
  const hopPairs = new Map<string, ImpactEvidence>();
  const extraIds = new Set<string>();

  for (const item of result.items) {
    evidenceById.set(item.nodeId, item.evidence);
    for (const hop of item.chain) {
      hopPairs.set(`${hop.from}|${hop.to}`, hop.basis);
      if (hop.viaId) {
        hopPairs.set(`${hop.from}|${hop.viaId}`, hop.basis);
        hopPairs.set(`${hop.viaId}|${hop.to}`, hop.basis);
        if (result.mode === "symbol" || hop.viaId.startsWith("pkg:")) extraIds.add(hop.viaId);
      }
    }
  }
  return { targetId: result.targetId, mode: result.mode, evidenceById, extraIds, hopPairs };
}