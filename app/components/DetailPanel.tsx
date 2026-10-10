"use client";

import type { CodeGraph, EdgeKind, GraphEdge, GraphNode, RepoInfo } from "@/src/types/graph";

export interface GraphIndex {
  nodes: Map<string, GraphNode>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
}

/** Lookup tables over the full (unfiltered) graph, built once per analysis. */
export function buildGraphIndex(graph: CodeGraph): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const node of graph.nodes) nodes.set(node.id, node);
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.source);
    if (out) out.push(edge);
    else outgoing.set(edge.source, [edge]);
    const inc = incoming.get(edge.target);
    if (inc) inc.push(edge);
    else incoming.set(edge.target, [edge]);
  }
  return { nodes, outgoing, incoming };
}

interface RelationItem {
  edge: GraphEdge;
  other: GraphNode;
}

function collect(
  index: GraphIndex,
  edges: readonly GraphEdge[] | undefined,
  kind: EdgeKind,
  end: "source" | "target",
): RelationItem[] {
  const items: RelationItem[] = [];
  for (const edge of edges ?? []) {
    if (edge.kind !== kind) continue;
    const other = index.nodes.get(end === "target" ? edge.target : edge.source);
    if (other) items.push({ edge, other });
  }
  return items.sort(
    (a, b) =>
      (a.other.filePath ?? "").localeCompare(b.other.filePath ?? "") ||
      (a.other.startLine ?? 0) - (b.other.startLine ?? 0) ||
      a.other.name.localeCompare(b.other.name),
  );
}

function githubLink(repo: RepoInfo, node: GraphNode): string | null {
  if (repo.source !== "github" || !repo.url || !repo.ref || !node.filePath) return null;
  const branch = repo.ref.split(" (")[0];
  if (!branch) return null;
  const isDirectory = node.id.startsWith("pkg:");
  const branchPart = branch.split("/").map(encodeURIComponent).join("/");
  const pathPart =
    node.filePath === "." ? "" : `/${node.filePath.split("/").map(encodeURIComponent).join("/")}`;
  let lines = "";
  if (!isDirectory && node.startLine && node.endLine) {
    lines = node.startLine === node.endLine ? `#L${node.startLine}` : `#L${node.startLine}-L${node.endLine}`;
  }
  return `${repo.url}/${isDirectory ? "tree" : "blob"}/${branchPart}${pathPart}${lines}`;
}

function describeLocation(node: GraphNode): string {
  if (!node.filePath) return "";
  return node.startLine ? `${node.filePath}:${node.startLine}` : node.filePath;
}

interface RelationSectionProps {
  title: string;
  items: readonly RelationItem[];
  onSelect: (id: string) => void;
}

const LIST_LIMIT = 40;

function RelationSection({ title, items, onSelect }: RelationSectionProps) {
  if (items.length === 0) return null;
  return (
    <section className="rel">
      <h3 className="rel__title">
        {title} ({items.length})
      </h3>
      <ul className="rel-list">
        {items.slice(0, LIST_LIMIT).map(({ edge, other }) => (
          <li key={edge.id}>
            <button
              type="button"
              className={`rel-item kind-${other.kind}`}
              title={edge.note ?? undefined}
              onClick={() => onSelect(other.id)}
            >
              <span className="badge">{other.kind}</span>
              <span className="rel-item__name">{other.name}</span>
              <span className="rel-item__path">{describeLocation(other)}</span>
              {(edge.basis === "inferred" || edge.confidence !== "high") && (
                <span className={`tag tag-${edge.confidence}`}>
                  {edge.basis} · {edge.confidence}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {items.length > LIST_LIMIT && <div className="rel__more">+{items.length - LIST_LIMIT} more</div>}
    </section>
  );
}

interface DetailPanelProps {
  node: GraphNode | null;
  index: GraphIndex;
  repo: RepoInfo;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export default function DetailPanel({ node, index, repo, onSelect, onClose }: DetailPanelProps) {
  if (!node) {
    return (
      <div className="detail">
        <p className="detail__empty">
          Select a node in the graph, or search for a file or symbol, to see its location and relationships.
        </p>
      </div>
    );
  }

  const outgoing = index.outgoing.get(node.id);
  const incoming = index.incoming.get(node.id);
  const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;

  const contains = collect(index, outgoing, "contains", "target");
  const containedBy = collect(index, incoming, "contains", "source");
  const imports = collect(index, outgoing, "imports", "target");
  const importedBy = collect(index, incoming, "imports", "source");
  const calls = collect(index, outgoing, "calls", "target");
  const calledBy = collect(index, incoming, "calls", "source");

  const hasInferred = [...imports, ...importedBy, ...calls, ...calledBy].some(
    ({ edge }) => edge.basis === "inferred" || edge.confidence !== "high",
  );

  const link = githubLink(repo, node);
  const detailEntries = Object.entries(node.details);
  const lineRange =
    node.startLine === null || node.endLine === null
      ? null
      : node.startLine === node.endLine
        ? `line ${node.startLine}`
        : `lines ${node.startLine}–${node.endLine}`;

  return (
    <div className={`detail kind-${node.kind}`}>
      <div className="detail__head">
        <h2 className="detail__title">{node.name}</h2>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="detail__meta">
        <span className="badge">{node.kind}</span>
        {node.language && <span className="lang-pill">{node.language}</span>}
        {node.kind !== "external" && <span className="lang-pill">{node.exported ? "exported / public" : "not exported"}</span>}
      </div>

      {node.filePath && (
        <p className="detail__path">
          {node.filePath}
          {lineRange ? ` · ${lineRange}` : ""}
        </p>
      )}
      {link && (
        <a href={link} target="_blank" rel="noreferrer noopener">
          Open on GitHub
        </a>
      )}

      {node.excerpt && <pre className="detail__code">{node.excerpt}</pre>}

      {detailEntries.length > 0 && (
        <dl className="kv">
          {detailEntries.map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {parent && parent.kind !== "file" && containedBy.length === 0 && null}
      <RelationSection title="Contained in" items={containedBy} onSelect={onSelect} />
      <RelationSection title="Contains" items={contains} onSelect={onSelect} />
      <RelationSection title="Imports" items={imports} onSelect={onSelect} />
      <RelationSection title="Imported by" items={importedBy} onSelect={onSelect} />
      <RelationSection title="Calls" items={calls} onSelect={onSelect} />
      <RelationSection title="Called by" items={calledBy} onSelect={onSelect} />

      {hasInferred && (
        <p className="hint">
          Tags mark relationships that were inferred (path or name matching) rather than read directly from syntax.
          Hover an item to see how it was resolved.
        </p>
      )}
    </div>
  );
}