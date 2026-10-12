"use client";

import { useMemo, useState } from "react";
import type { AnalysisSummary, RepoInfo, GraphNode } from "@/src/types/graph";
import type {
  ImpactHop,
  ImpactItem,
  ImpactOutcome,
} from "@/src/analysis/impact";
import type { GraphIndex } from "./DetailPanel";
import { githubUrl } from "./DetailPanel";

interface ImpactPanelProps {
  outcome: ImpactOutcome | null;
  targetId: string | null;
  index: GraphIndex;
  repo: RepoInfo;
  analysis: AnalysisSummary;
  onSelectNode: (id: string) => void;
  onClear: () => void;
}

function locationOf(node: GraphNode): string {
  if (!node.filePath) return "External package";
  return node.startLine
    ? `${node.filePath}:${node.startLine}`
    : node.filePath;
}

function displayNode(node: GraphNode | undefined, id: string): string {
  return node ? `${node.name} (${locationOf(node)})` : id;
}

function Chain({
  item,
  index,
}: {
  item: ImpactItem;
  index: GraphIndex;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = item.chain[0];
  const last = item.chain[item.chain.length - 1];

  if (!first || !last) return null;

  const startNode = index.nodes.get(first.from);
  const targetNode = index.nodes.get(last.to);

  return (
    <details className="chain" open={expanded}>
      <summary onClick={(event) => {
        event.preventDefault();
        setExpanded((value) => !value);
      }}>
        {expanded ? "Hide dependency path" : "Show dependency path"}
      </summary>

      <ol className="chain__steps">
        {item.chain.map((hop: ImpactHop, position) => {
          const fromNode = index.nodes.get(hop.from);
          const toNode = index.nodes.get(hop.to);
          const sourceLink = fromNode?.filePath
            ? githubUrl(
                { source: "local", name: "", owner: null, ref: null, url: null },
                fromNode.filePath,
                "blob",
                fromNode.startLine,
                fromNode.endLine,
              )
            : null;

          return (
            <li className="chain__step" key={`${hop.from}|${hop.to}|${position}`}>
              <span className="chain__line">
                <strong>{fromNode?.name ?? hop.from}</strong>
                {" depends on "}
                <strong>{toNode?.name ?? hop.to}</strong>
              </span>

              <span className={`tag ${hop.basis === "syntax" ? "tag-fact" : ""}`}>
                {hop.basis} · {hop.confidence}
              </span>

              <span className="chain__count">
                {hop.relation}
                {hop.line ? ` · line ${hop.line}` : ""}
                {hop.count > 1 ? ` · ${hop.count} matching edges` : ""}
              </span>

              {hop.note && <span className="chain__note">{hop.note}</span>}

              {sourceLink && (
                <a href={sourceLink} target="_blank" rel="noreferrer noopener">
                  Source
                </a>
              )}
            </li>
          );
        })}
      </ol>

      {startNode && targetNode && (
        <p className="chain__alt">
          Path length: {item.distance} hop{item.distance === 1 ? "" : "s"}.
        </p>
      )}

      {item.syntaxChain && (
        <p className="chain__alt">
          A syntax-derived alternative path is available.
        </p>
      )}
    </details>
  );
}

export default function ImpactPanel({
  outcome,
  targetId,
  index,
  repo,
  analysis,
  onSelectNode,
  onClear,
}: ImpactPanelProps) {
  const [filter, setFilter] = useState<"all" | "direct" | "transitive">("all");
  const [evidence, setEvidence] = useState<"all" | "syntax" | "inferred">("all");

  const result = outcome?.ok ? outcome.result : null;
  const target = targetId ? index.nodes.get(targetId) : undefined;

  const items = useMemo(() => {
    if (!result) return [];

    return result.items.filter((item) => {
      if (filter === "direct" && !item.direct) return false;
      if (filter === "transitive" && item.direct) return false;
      if (evidence !== "all" && item.evidence !== evidence) return false;
      return true;
    });
  }, [result, filter, evidence]);

  if (!targetId) {
    return (
      <section className="impact detail">
        <div className="detail__head">
          <h2 className="detail__title">Change impact</h2>
        </div>
        <p className="ov-empty">
          Select a file or symbol in Details and choose Analyze change impact.
        </p>
      </section>
    );
  }

  if (!outcome) {
    return (
      <section className="impact detail">
        <div className="detail__head">
          <h2 className="detail__title">Change impact</h2>
          <button type="button" className="btn btn--ghost" onClick={onClear}>
            Clear
          </button>
        </div>
        <p className="ov-empty">Preparing impact analysis…</p>
      </section>
    );
  }

  if (!outcome.ok) {
    return (
      <section className="impact detail">
        <div className="detail__head">
          <h2 className="detail__title">Change impact</h2>
          <button type="button" className="btn btn--ghost" onClick={onClear}>
            Clear
          </button>
        </div>
        <p className="ov-empty">{outcome.reason}</p>
      </section>
    );
  }
  if (!result) {
  return (
    <div className="impact">
      <p>No impact analysis results available.</p>
    </div>
  );
}

const summary = result.summary;
const targetLink =
    target?.filePath
      ? githubUrl(
          repo,
          target.filePath,
          target.kind === "file" ? "blob" : "blob",
          target.startLine,
          target.endLine,
        )
      : null;

  return (
    <section className="impact detail">
      <div className="detail__head">
        <h2 className="detail__title">Change impact</h2>
        <button type="button" className="btn btn--ghost" onClick={onClear}>
          Clear analysis
        </button>
      </div>

      <p className="detail__desc">
        Dependents reachable from the selected target in the analysed graph.
        This report uses graph relationships; it does not predict runtime
        failures.
      </p>

      {target && (
        <div className="impact-banner impact-banner--target">
          <span>
            Target: <strong>{target.name}</strong>
            <br />
            {locationOf(target)}
          </span>
          <span className="impact-banner__actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onSelectNode(target.id)}
            >
              View target
            </button>
            {targetLink && (
              <a href={targetLink} target="_blank" rel="noreferrer noopener">
                Source
              </a>
            )}
          </span>
        </div>
      )}

      <dl className="stats">
        <div className="stat">
          <dt>Affected</dt>
          <dd>{summary.total}</dd>
        </div>
        <div className="stat">
          <dt>Direct</dt>
          <dd>{summary.direct}</dd>
        </div>
        <div className="stat">
          <dt>Transitive</dt>
          <dd>{summary.transitive}</dd>
        </div>
        <div className="stat">
          <dt>Syntax-derived</dt>
          <dd>{summary.syntax}</dd>
        </div>
        <div className="stat">
          <dt>Inferred</dt>
          <dd>{summary.inferred}</dd>
        </div>
        <div className="stat">
          <dt>Max depth</dt>
          <dd>{summary.maxDepth}</dd>
        </div>
      </dl>

      {result.truncated && (
        <p className="hint">
          The report reached the analysis limit. Additional dependents may not
          be included.
        </p>
      )}

      {summary.withSyntaxAlternative > 0 && (
        <p className="hint">
          {summary.withSyntaxAlternative} result(s) have an inferred shortest
          path and also a syntax-derived alternative.
        </p>
      )}

      {summary.direct === 0 && summary.transitive === 0 && (
        <p className="ov-empty">
          No dependents were found in the available graph. This does not prove
          that the target has no dependencies outside the analysed repository
          or beyond the parser's capabilities.
        </p>
      )}

      <div className="impact-filters">
        <label>
          Relationship distance
          <select
            value={filter}
            onChange={(event) =>
              setFilter(event.target.value as typeof filter)
            }
          >
            <option value="all">All dependents</option>
            <option value="direct">Direct only</option>
            <option value="transitive">Transitive only</option>
          </select>
        </label>

        <label>
          Evidence
          <select
            value={evidence}
            onChange={(event) =>
              setEvidence(event.target.value as typeof evidence)
            }
          >
            <option value="all">All evidence</option>
            <option value="syntax">Syntax-derived</option>
            <option value="inferred">Inferred</option>
          </select>
        </label>
      </div>

      <p className="direction__hint">
        Showing {items.length} of {summary.total} affected nodes.
      </p>

      {items.map((item) => {
        const node = index.nodes.get(item.nodeId);
        if (!node) return null;

        return (
          <article className="impact-row" key={item.nodeId}>
            <div className="rel-item">
              <span className="badge">{node.kind}</span>
              <button
                type="button"
                className="impact-row__select"
                onClick={() => onSelectNode(node.id)}
              >
                <strong>{node.name}</strong>
                <span className="rel-item__path">{locationOf(node)}</span>
              </button>
            </div>

            <div className="rel-meta">
              <span className="tag">
                {item.direct ? "direct" : "transitive"}
              </span>
              <span
                className={`tag ${item.evidence === "syntax" ? "tag-fact" : ""}`}
              >
                {item.evidence}
              </span>
              <span className="tag">{item.confidence} confidence</span>
              <span className="chain__count">
                {item.distance} hop{item.distance === 1 ? "" : "s"}
              </span>
            </div>

            <Chain item={item} index={index} />
          </article>
        );
      })}

      {items.length === 0 && summary.total > 0 && (
        <p className="ov-empty">
          No dependents match the current filters.
        </p>
      )}

      <p className="hint">
        Analysis is based on the repository graph and its extracted
        relationships. Repository summary: {analysis.filesAnalyzed} files
        analysed, {analysis.nodeCount} graph nodes.
      </p>
    </section>
  );
}