"use client";

import { useMemo } from "react";
import { LANGUAGES } from "@/src/types/graph";
import type { AnalysisResult, EdgeKind, GraphNode, Language } from "@/src/types/graph";
import type { GraphCommandRequest } from "./CodeGraph";

interface OverviewPanelProps {
  result: AnalysisResult;
  onSelectNode: (id: string) => void;
  onGraphCommand: (request: GraphCommandRequest) => void;
}

const LANGUAGE_LABEL: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
};

const EDGE_ORDER: readonly EdgeKind[] = ["contains", "imports", "calls"];

interface Ranked {
  node: GraphNode;
  incoming: number;
  outgoing: number;
  total: number;
}

interface Overview {
  fileCount: number;
  symbolCount: number;
  symbolsByKind: Array<[string, number]>;
  externalCount: number;
  packageCount: number;
  nodeCount: number;
  languages: Array<{ language: Language; files: number; symbols: number }>;
  edgeStats: Record<EdgeKind, { total: number; inferred: number }>;
  mostConnected: Ranked[];
  topExternal: Array<{ node: GraphNode; importers: number }>;
}

/**
 * Definitions (shared with the graph filters):
 *  - file:     kind "file"
 *  - external: kind "external" (packages outside the repository)
 *  - package:  Go package nodes (id "pkg:...")
 *  - symbol:   every other node (functions, methods, classes, types, inline modules, ...)
 */
function computeOverview(result: AnalysisResult): Overview {
  const { nodes, edges } = result.graph;

  let fileCount = 0;
  let externalCount = 0;
  let packageCount = 0;
  let symbolCount = 0;
  const symbolKinds = new Map<string, number>();
  const filesByLanguage = new Map<Language, number>();
  const symbolsByLanguage = new Map<Language, number>();

  for (const node of nodes) {
    if (node.kind === "file") {
      fileCount++;
      if (node.language) filesByLanguage.set(node.language, (filesByLanguage.get(node.language) ?? 0) + 1);
    } else if (node.kind === "external") {
      externalCount++;
    } else if (node.id.startsWith("pkg:")) {
      packageCount++;
    } else {
      symbolCount++;
      symbolKinds.set(node.kind, (symbolKinds.get(node.kind) ?? 0) + 1);
      if (node.language) symbolsByLanguage.set(node.language, (symbolsByLanguage.get(node.language) ?? 0) + 1);
    }
  }

  const edgeStats: Record<EdgeKind, { total: number; inferred: number }> = {
    contains: { total: 0, inferred: 0 },
    imports: { total: 0, inferred: 0 },
    calls: { total: 0, inferred: 0 },
  };
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of edges) {
    edgeStats[edge.kind].total++;
    if (edge.basis === "inferred") edgeStats[edge.kind].inferred++;
    // Containment is structural, so it is excluded from the connection count.
    if (edge.kind !== "contains") {
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
  }

  const ranked: Ranked[] = [];
  const topExternal: Array<{ node: GraphNode; importers: number }> = [];
  for (const node of nodes) {
    const inCount = incoming.get(node.id) ?? 0;
    const outCount = outgoing.get(node.id) ?? 0;
    if (node.kind === "external") {
      if (inCount > 0) topExternal.push({ node, importers: inCount });
    } else if (inCount + outCount > 0) {
      ranked.push({ node, incoming: inCount, outgoing: outCount, total: inCount + outCount });
    }
  }
  ranked.sort((a, b) => b.total - a.total || a.node.name.localeCompare(b.node.name));
  topExternal.sort((a, b) => b.importers - a.importers || a.node.name.localeCompare(b.node.name));

  return {
    fileCount,
    symbolCount,
    symbolsByKind: [...symbolKinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    externalCount,
    packageCount,
    nodeCount: nodes.length,
    languages: LANGUAGES.filter((language) => filesByLanguage.has(language)).map((language) => ({
      language,
      files: filesByLanguage.get(language) ?? 0,
      symbols: symbolsByLanguage.get(language) ?? 0,
    })),
    edgeStats,
    mostConnected: ranked.slice(0, 8),
    topExternal: topExternal.slice(0, 5),
  };
}

function format(value: number): string {
  return value.toLocaleString("en-US");
}

function location(node: GraphNode): string {
  if (!node.filePath) return "";
  return node.startLine ? `${node.filePath}:${node.startLine}` : node.filePath;
}

export default function OverviewPanel({ result, onSelectNode, onGraphCommand }: OverviewPanelProps) {
  const overview = useMemo(() => computeOverview(result), [result]);
  const maxFiles = Math.max(1, ...overview.languages.map((entry) => entry.files));

  return (
    <div className="ov">
      <section>
        <h3 className="ov__h">Contents of the graph</h3>
        <dl className="ov-stats">
          <div className="stat">
            <dt>Files</dt>
            <dd>{format(overview.fileCount)}</dd>
          </div>
          <div className="stat">
            <dt>Symbols</dt>
            <dd>{format(overview.symbolCount)}</dd>
          </div>
          <div className="stat">
            <dt>All nodes</dt>
            <dd>{format(overview.nodeCount)}</dd>
          </div>
        </dl>
        {overview.symbolsByKind.length > 0 ? (
          <p className="ov__note">
            Symbols: {overview.symbolsByKind.map(([kind, count]) => `${format(count)} ${kind}`).join(" · ")}.
          </p>
        ) : (
          <p className="ov-empty">No symbols were extracted from these files.</p>
        )}
        <p className="ov__note">
          Other nodes: {format(overview.externalCount)} external package{overview.externalCount === 1 ? "" : "s"}
          {overview.packageCount > 0 ? `, ${format(overview.packageCount)} Go package${overview.packageCount === 1 ? "" : "s"}` : ""}.
        </p>
      </section>

      <section>
        <h3 className="ov__h">Languages (by analysed files)</h3>
        {overview.languages.length === 0 && <p className="ov-empty">No language information available.</p>}
        {overview.languages.map((entry) => (
          <button
            key={entry.language}
            type="button"
            className="ov-row"
            aria-label={`Show only ${LANGUAGE_LABEL[entry.language]} in the graph`}
            onClick={() => onGraphCommand({ type: "isolate-language", language: entry.language })}
          >
            <span>{LANGUAGE_LABEL[entry.language]}</span>
            <span className="ov-row__meta">
              {format(entry.files)} file{entry.files === 1 ? "" : "s"} · {Math.round((entry.files / overview.fileCount) * 100)}% ·{" "}
              {format(entry.symbols)} symbols
            </span>
            <span className="ov-bar" aria-hidden="true">
              <span style={{ width: `${(entry.files / maxFiles) * 100}%` }} />
            </span>
          </button>
        ))}
        <p className="ov__note">Click a language to show only it in the graph.</p>
      </section>

      <section>
        <h3 className="ov__h">Relationships (edges in the graph)</h3>
        {EDGE_ORDER.map((kind) => {
          const stats = overview.edgeStats[kind];
          return (
            <button
              key={kind}
              type="button"
              className="ov-row"
              disabled={stats.total === 0}
              aria-label={`Show only ${kind} relationships in the graph`}
              onClick={() => onGraphCommand({ type: "only-edge-kind", kind })}
            >
              <span>{kind}</span>
              <span className="ov-row__meta">
                {format(stats.total)}
                {stats.inferred > 0 ? ` · ${format(stats.inferred)} inferred` : ""}
              </span>
            </button>
          );
        })}
        {overview.edgeStats.calls.total === 0 && (
          <p className="ov-empty">No call edges could be resolved with confidence for this repository.</p>
        )}
        {overview.edgeStats.imports.total === 0 && <p className="ov-empty">No import relationships were found.</p>}
        <p className="ov__note">
          Counts are unique edges. A call edge is one resolved caller→callee pair; unresolved calls are not drawn or
          counted.
        </p>
        <button type="button" className="btn btn--ghost" onClick={() => onGraphCommand({ type: "reset" })}>
          Reset graph filters
        </button>
      </section>

      <section>
        <h3 className="ov__h">Most connected</h3>
        {overview.mostConnected.length === 0 ? (
          <p className="ov-empty">No import or call relationships to rank.</p>
        ) : (
          <ul className="rel-list">
            {overview.mostConnected.map(({ node, incoming, outgoing, total }) => (
              <li key={node.id}>
                <button
                  type="button"
                  className={`rel-item kind-${node.kind}`}
                  aria-label={`Select ${node.kind} ${node.name}, ${total} connections`}
                  onClick={() => onSelectNode(node.id)}
                >
                  <span className="badge">{node.kind}</span>
                  <span className="rel-item__name">{node.name}</span>
                  <span className="rel-item__path">{location(node)}</span>
                  <span className="ov-row__meta">
                    {format(total)} ({format(incoming)} in · {format(outgoing)} out)
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="ov__note">
          Connection count = import and call edges touching a node, incoming + outgoing. Containment edges and external
          packages are excluded. This is a degree count, not a complexity measure.
        </p>
      </section>

      <section>
        <h3 className="ov__h">Most-imported external packages</h3>
        {overview.topExternal.length === 0 ? (
          <p className="ov-empty">No external package imports were found.</p>
        ) : (
          <ul className="rel-list">
            {overview.topExternal.map(({ node, importers }) => (
              <li key={node.id}>
                <button
                  type="button"
                  className="rel-item kind-external"
                  aria-label={`Select package ${node.name}, imported by ${importers} files`}
                  onClick={() => onSelectNode(node.id)}
                >
                  <span className="badge">{node.details.ecosystem ?? "external"}</span>
                  <span className="rel-item__name">{node.name}</span>
                  <span className="ov-row__meta">
                    imported by {format(importers)} file{importers === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}