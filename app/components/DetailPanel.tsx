"use client";

import { useState } from "react";
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

type Direction = "outgoing" | "incoming";

interface Relation {
  edge: GraphEdge;
  other: GraphNode;
}

interface RelationGroupData {
  kind: EdgeKind;
  items: Relation[];
}

const EDGE_ORDER: readonly EdgeKind[] = ["contains", "imports", "calls"];
const LIST_LIMIT = 25;

function relationsByKind(index: GraphIndex, nodeId: string, direction: Direction): RelationGroupData[] {
  const edges = (direction === "outgoing" ? index.outgoing : index.incoming).get(nodeId) ?? [];
  const byKind = new Map<EdgeKind, Relation[]>();
  for (const edge of edges) {
    const other = index.nodes.get(direction === "outgoing" ? edge.target : edge.source);
    if (!other) continue;
    const list = byKind.get(edge.kind) ?? [];
    list.push({ edge, other });
    byKind.set(edge.kind, list);
  }
  return EDGE_ORDER.flatMap((kind) => {
    const items = byKind.get(kind);
    if (!items) return [];
    items.sort(
      (a, b) =>
        (a.other.filePath ?? "").localeCompare(b.other.filePath ?? "") ||
        (a.other.startLine ?? 0) - (b.other.startLine ?? 0) ||
        a.other.name.localeCompare(b.other.name),
    );
    return [{ kind, items }];
  });
}

/** Links to the analysed commit when available, so line numbers match the analysed source. */
function githubUrl(
  repo: RepoInfo,
  filePath: string | null,
  type: "blob" | "tree",
  startLine: number | null,
  endLine: number | null,
): string | null {
  if (repo.source !== "github" || !repo.url || !repo.ref || !filePath) return null;
  const sha = /\(([0-9a-f]{7,40})\)$/.exec(repo.ref)?.[1];
  const ref = sha ?? repo.ref.split(" (")[0];
  if (!ref) return null;
  const refPart = ref.split("/").map(encodeURIComponent).join("/");
  const pathPart = filePath === "." ? "" : `/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  let lines = "";
  if (type === "blob" && startLine) {
    lines = endLine && endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  }
  return `${repo.url}/${type}/${refPart}${pathPart}${lines}`;
}

function locationOf(node: GraphNode): string {
  if (!node.filePath) return node.details.ecosystem ? `external · ${node.details.ecosystem}` : "external package";
  return node.startLine ? `${node.filePath}:${node.startLine}` : node.filePath;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Plain-language description built only from fields and edges that exist on the node. */
function describeNode(node: GraphNode, index: GraphIndex): string {
  const out = index.outgoing.get(node.id) ?? [];
  const inc = index.incoming.get(node.id) ?? [];

  if (node.kind === "file") {
    const symbols = out.filter((edge) => edge.kind === "contains").length;
    const lang = node.language ? `${capitalize(node.language)} source file` : "Source file";
    const dir = node.details.directory ? ` in ${node.details.directory}` : "";
    const lines = node.endLine ? `, ${node.endLine} lines` : "";
    return `${lang}${dir}${lines}. Declares ${symbols} extracted symbol${symbols === 1 ? "" : "s"}.`;
  }
  if (node.kind === "external") {
    const importers = inc.filter((edge) => edge.kind === "imports").length;
    const eco = node.details.ecosystem ? ` (${node.details.ecosystem})` : "";
    return `External package${eco}, not part of this repository. Imported by ${importers} analysed file${importers === 1 ? "" : "s"}.`;
  }
  if (node.id.startsWith("pkg:")) {
    return `Go package directory containing ${node.details.files ?? "some"} analysed file(s).`;
  }

  const parent = node.parentId ? index.nodes.get(node.parentId) : undefined;
  const where =
    parent && parent.kind !== "file" ? `inside ${parent.kind} ${parent.name}` : "at the top level of its file";
  const lines =
    node.startLine !== null && node.endLine !== null
      ? node.startLine === node.endLine
        ? `line ${node.startLine}`
        : `lines ${node.startLine}–${node.endLine}`
      : null;
  const exported = node.exported ? " Exported / public." : "";
  return `${capitalize(node.kind)} ${node.name}, declared ${where}${node.filePath ? ` in ${node.filePath}` : ""}${lines ? ` (${lines})` : ""}.${exported}`;
}

function evidenceClass(edge: GraphEdge): string {
  if (edge.confidence === "low") return "tag tag-low";
  return edge.basis === "inferred" ? "tag" : "tag tag-fact";
}

interface GroupProps {
  group: RelationGroupData;
  direction: Direction;
  node: GraphNode;
  repo: RepoInfo;
  onSelect: (id: string) => void;
}

function RelationGroup({ group, direction, node, repo, onSelect }: GroupProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? group.items : group.items.slice(0, LIST_LIMIT);

  return (
    <section className="rel-group">
      <h4 className="rel-group__title">
        <span aria-hidden="true">{direction === "outgoing" ? "→" : "←"}</span> {group.kind}
        <span className="dir">({group.items.length})</span>
      </h4>
      <ul className="rel-list">
        {visible.map(({ edge, other }) => {
          const siteNode = direction === "outgoing" ? node : other;
          const siteLink =
            edge.kind !== "contains" && edge.line
              ? githubUrl(repo, siteNode.filePath, "blob", edge.line, edge.line)
              : null;
          const sitePath = siteNode.filePath ? `${siteNode.filePath}:${edge.line}` : null;
          return (
            <li key={edge.id} className="rel-entry">
              <button
                type="button"
                className={`rel-item kind-${other.kind}`}
                onClick={() => onSelect(other.id)}
                aria-label={`Select ${other.kind} ${other.name}`}
              >
                <span className="badge">{other.kind}</span>
                <span className="rel-item__name">{other.name}</span>
                <span className="rel-item__path">{locationOf(other)}</span>
              </button>
              <div className="rel-meta">
                <span className={evidenceClass(edge)}>
                  {edge.basis} · {edge.confidence}
                </span>
                {edge.kind !== "contains" && edge.line && sitePath && (
                  <span className="rel-meta__site">
                    at{" "}
                    {siteLink ? (
                      <a href={siteLink} target="_blank" rel="noreferrer noopener">
                        {sitePath}
                      </a>
                    ) : (
                      sitePath
                    )}
                  </span>
                )}
                {edge.note && <span className="rel-meta__note">{edge.note}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {group.items.length > LIST_LIMIT && (
        <button type="button" className="btn btn--ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show fewer" : `Show all ${group.items.length}`}
        </button>
      )}
    </section>
  );
}

interface DetailBodyProps {
  node: GraphNode;
  index: GraphIndex;
  repo: RepoInfo;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function DetailBody({ node, index, repo, onSelect, onClose }: DetailBodyProps) {
  const [copied, setCopied] = useState(false);

  const outgoing = relationsByKind(index, node.id, "outgoing");
  const incoming = relationsByKind(index, node.id, "incoming");
  const hasInferred = [...outgoing, ...incoming].some((group) =>
    group.items.some(({ edge }) => edge.basis === "inferred" || edge.confidence !== "high"),
  );

  const isDirectory = node.id.startsWith("pkg:");
  const link = githubUrl(repo, node.filePath, isDirectory ? "tree" : "blob", node.startLine, node.endLine);
  const detailEntries = Object.entries(node.details);
  const lineRange =
    node.startLine === null || node.endLine === null
      ? null
      : node.startLine === node.endLine
        ? `line ${node.startLine}`
        : `lines ${node.startLine}–${node.endLine}`;

  const copyPath = async (): Promise<void> => {
    if (!node.filePath) return;
    try {
      await navigator.clipboard.writeText(node.startLine ? `${node.filePath}:${node.startLine}` : node.filePath);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false); // clipboard unavailable (e.g. insecure context); nothing else to do
    }
  };

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
        {node.kind !== "external" && !isDirectory && (
          <span className="lang-pill">{node.exported ? "exported / public" : "not exported"}</span>
        )}
      </div>

      <p className="detail__desc">{describeNode(node, index)}</p>

      {node.filePath && (
        <p className="detail__path">
          {node.filePath}
          {lineRange ? ` · ${lineRange}` : ""}
        </p>
      )}
      {(link || node.filePath) && (
        <div className="detail__actions">
          {link && (
            <a href={link} target="_blank" rel="noreferrer noopener">
              Open on GitHub
            </a>
          )}
          {node.filePath && !isDirectory && (
            <button type="button" className="btn btn--ghost" onClick={() => void copyPath()}>
              {copied ? "Copied" : "Copy path"}
            </button>
          )}
        </div>
      )}

      {node.excerpt && (
        <>
          <p className="rel__title">Declaration (first line)</p>
          <pre className="detail__code">{node.excerpt}</pre>
        </>
      )}

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

      <div className="direction">
        <h3 className="direction__title">Outgoing</h3>
        <p className="direction__hint">Edges that start at this node.</p>
        {outgoing.length === 0 && <p className="ov-empty">No outgoing relationships.</p>}
        {outgoing.map((group) => (
          <RelationGroup key={group.kind} group={group} direction="outgoing" node={node} repo={repo} onSelect={onSelect} />
        ))}
      </div>

      <div className="direction">
        <h3 className="direction__title">Incoming</h3>
        <p className="direction__hint">Edges that point at this node.</p>
        {incoming.length === 0 && <p className="ov-empty">No incoming relationships.</p>}
        {incoming.map((group) => (
          <RelationGroup key={group.kind} group={group} direction="incoming" node={node} repo={repo} onSelect={onSelect} />
        ))}
      </div>

      {hasInferred && (
        <p className="hint">
          Each relationship shows how it was established: <strong>syntax</strong> means read directly from the code,{" "}
          <strong>inferred</strong> means it relies on path or name matching. Confidence is the resolver&apos;s own rating.
        </p>
      )}
    </div>
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
  // Keyed by id so expanded lists and the "Copied" state reset when the selection changes.
  return <DetailBody key={node.id} node={node} index={index} repo={repo} onSelect={onSelect} onClose={onClose} />;
}