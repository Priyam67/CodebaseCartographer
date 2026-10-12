"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeGraph, {
  type GraphCommand,
  type GraphCommandRequest,
} from "./components/CodeGraph";
import DetailPanel, {
  buildGraphIndex,
  type DetailImpactInfo,
} from "./components/DetailPanel";
import ImpactPanel from "./components/ImpactPanel";
import OverviewPanel from "./components/OverviewPanel";
import RepoInput, { type AnalyzeTarget } from "./components/RepoInput";
import SearchBar from "./components/SearchBar";
import {
  buildImpactHighlight,
  createImpactEngine,
} from "@/src/analysis/impact";
import { LANGUAGES } from "@/src/types/graph";
import type {
  AnalysisResult,
  AnalyzeRequest,
  Language,
} from "@/src/types/graph";

type Status =
  | { kind: "idle" }
  | { kind: "loading"; target: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "success"; result: AnalysisResult; runId: number };

type PanelTab = "overview" | "details" | "impact";

const LANGUAGE_LABEL: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(
  data: unknown,
): { code: string; message: string } | null {
  if (!isRecord(data) || !isRecord(data.error)) return null;

  const { code, message } = data.error;

  return typeof message === "string"
    ? { code: typeof code === "string" ? code : "ERROR", message }
    : null;
}

function isResult(data: unknown): data is AnalysisResult {
  return (
    isRecord(data) &&
    isRecord(data.repo) &&
    isRecord(data.summary) &&
    isRecord(data.graph) &&
    Array.isArray(data.graph.nodes) &&
    Array.isArray(data.graph.edges)
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Summary({ result }: { result: AnalysisResult }) {
  const { repo, summary } = result;
  const title = repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
  const importTotal = summary.importsResolved + summary.importsExternal;

  return (
    <section className="summary" aria-label="Analysis summary">
      <div className="summary__head">
        <h2 className="summary__title">
          {repo.url ? (
            <a href={repo.url} target="_blank" rel="noreferrer noopener">
              {title}
            </a>
          ) : (
            title
          )}
        </h2>

        {repo.ref && <span className="summary__ref">{repo.ref}</span>}

        <div className="lang-list">
          {LANGUAGES.filter((language) => summary.languages[language]).map(
            (language) => (
              <span key={language} className="lang-pill">
                {LANGUAGE_LABEL[language]} ·{" "}
                {summary.languages[language]?.files} files
              </span>
            ),
          )}
        </div>
      </div>

      <dl className="stats">
        <div className="stat">
          <dt>Files analyzed</dt>
          <dd>
            {formatNumber(summary.filesAnalyzed)}
            <small>
              {formatNumber(summary.filesSkipped)} skipped ·{" "}
              {formatBytes(summary.totalBytes)}
            </small>
          </dd>
        </div>

        <div className="stat">
          <dt>Symbols</dt>
          <dd>{formatNumber(summary.symbolCount)}</dd>
        </div>

        <div className="stat">
          <dt>Imports</dt>
          <dd>
            {formatNumber(importTotal)}
            <small>
              {formatNumber(summary.importsExternal)} external ·{" "}
              {formatNumber(summary.importsUnresolved)} unresolved
            </small>
          </dd>
        </div>

        <div className="stat">
          <dt>Call edges</dt>
          <dd>
            {formatNumber(summary.callsResolved)}
            <small>
              {formatNumber(summary.callsDropped)} call sites not resolved
              (omitted)
            </small>
          </dd>
        </div>

        <div className="stat">
          <dt>Graph</dt>
          <dd>
            {formatNumber(summary.nodeCount)} nodes
            <small>{formatNumber(summary.edgeCount)} edges</small>
          </dd>
        </div>

        {summary.parseFailures > 0 && (
          <div className="stat">
            <dt>Parse failures</dt>
            <dd>{formatNumber(summary.parseFailures)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function Diagnostics({ result }: { result: AnalysisResult }) {
  if (result.diagnostics.length === 0) return null;

  const shown = result.diagnostics.slice(0, 100);

  return (
    <details className="diagnostics">
      <summary>Diagnostics ({result.diagnostics.length})</summary>
      <ul>
        {shown.map((diagnostic, index) => (
          <li key={index} className={`sev-${diagnostic.severity}`}>
            [{diagnostic.severity}] {diagnostic.filePath ?? "general"}
            {diagnostic.line ? `:${diagnostic.line}` : ""} —{" "}
            {diagnostic.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function Page() {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [panelTab, setPanelTab] = useState<PanelTab>("overview");
  const [graphCommand, setGraphCommand] = useState<GraphCommand | null>(null);
  const [impactTargetId, setImpactTargetId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const runCounter = useRef(0);
  const commandCounter = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const analyze = useCallback(async (target: AnalyzeTarget): Promise<void> => {
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    setSelectedId(null);
    setGraphCommand(null);
    setImpactTargetId(null);
    setPanelTab("overview");

    setStatus({
      kind: "loading",
      target: target.kind === "github" ? target.repoUrl : target.localPath,
    });

    const body: AnalyzeRequest =
      target.kind === "github"
        ? { repoUrl: target.repoUrl }
        : { localPath: target.localPath };

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      let data: unknown = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (controller.signal.aborted) return;

      const apiError = readError(data);

      if (!response.ok || apiError) {
        setStatus({
          kind: "error",
          code: apiError?.code ?? `HTTP_${response.status}`,
          message:
            apiError?.message ??
            `The server responded with status ${response.status}.`,
        });
        return;
      }

      if (!isResult(data)) {
        setStatus({
          kind: "error",
          code: "BAD_RESPONSE",
          message: "The server returned an unexpected response.",
        });
        return;
      }

      runCounter.current += 1;

      setStatus({
        kind: "success",
        result: data,
        runId: runCounter.current,
      });
    } catch {
      if (controller.signal.aborted) return;

      setStatus({
        kind: "error",
        code: "NETWORK",
        message:
          "Could not reach the server. Make sure the dev server is still running.",
      });
    }
  }, []);

  const result = status.kind === "success" ? status.result : null;

  const index = useMemo(
    () => (result ? buildGraphIndex(result.graph) : null),
    [result],
  );

  const selectedNode =
    selectedId && index ? (index.nodes.get(selectedId) ?? null) : null;

  // Change-impact analysis runs locally on the graph that was already returned.
  const impactEngine = useMemo(
    () => (result ? createImpactEngine(result.graph) : null),
    [result],
  );

  const impactOutcome = useMemo(
    () =>
      impactEngine && impactTargetId
        ? impactEngine.analyze(impactTargetId)
        : null,
    [impactEngine, impactTargetId],
  );

  const impactHighlight = useMemo(
    () =>
      impactOutcome?.ok
        ? buildImpactHighlight(impactOutcome.result)
        : null,
    [impactOutcome],
  );

  const select = useCallback((id: string, focus: boolean): void => {
    setSelectedId(id);
    setPanelTab("details");

    if (focus) setFocusToken((token) => token + 1);
  }, []);

  // Clearing the selection keeps an active impact analysis on screen.
  const clearSelection = useCallback((): void => {
    setSelectedId(null);
    setPanelTab(impactTargetId ? "impact" : "overview");
  }, [impactTargetId]);

  const analyzeImpact = useCallback((id: string): void => {
    setImpactTargetId(id);
    setPanelTab("impact");
  }, []);

  const clearImpact = useCallback((): void => {
    setImpactTargetId(null);
    setPanelTab(selectedId ? "details" : "overview");
  }, [selectedId]);

  const sendGraphCommand = useCallback(
    (request: GraphCommandRequest): void => {
      commandCounter.current += 1;
      setGraphCommand({ ...request, nonce: commandCounter.current });
    },
    [],
  );

  let detailImpact: DetailImpactInfo | null = null;

  if (
    impactTargetId &&
    impactOutcome?.ok &&
    selectedNode &&
    index
  ) {
    const item =
      impactOutcome.result.items.find(
        (entry) => entry.nodeId === selectedNode.id,
      ) ?? null;

    detailImpact = {
      targetName: index.nodes.get(impactTargetId)?.name ?? "the target",
      role:
        selectedNode.id === impactTargetId
          ? "target"
          : item
            ? "affected"
            : "not-reached",
      item,
      onShowReport: () => setPanelTab("impact"),
      onClear: clearImpact,
    };
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__name">Codebase Cartographer</span>
          <span className="brand__tag">
            Map a repository&apos;s structure with Tree-sitter
          </span>
        </div>

        <RepoInput
          loading={status.kind === "loading"}
          showExamples={status.kind === "idle" || status.kind === "error"}
          onAnalyze={(target) => void analyze(target)}
        />
      </header>

      <main className="content">
        {status.kind === "idle" && (
          <section className="state-card">
            <h2>Map a repository</h2>
            <p>
              Paste a public GitHub repository URL. The server downloads its
              source files, parses them with Tree-sitter and draws an
              interactive graph of files, declarations, imports and function
              calls.
            </p>
            <ul className="feature-list">
              <li>
                Languages: JavaScript, TypeScript, Python, Go and Rust.
              </li>
              <li>
                Solid edges come straight from syntax; dashed edges are
                inferred and tagged with a confidence level.
              </li>
              <li>
                Calls are only linked when a name can be tied to a declaration.
                Ambiguous calls are left out, not guessed.
              </li>
              <li>
                Select a file or symbol and run a change-impact analysis to see
                what depends on it.
              </li>
              <li>
                Vendored, generated, binary and oversized files are skipped;
                repositories above the limits are refused.
              </li>
            </ul>
          </section>
        )}

        {status.kind === "loading" && (
          <section className="state-card" aria-live="polite">
            <div className="spinner" aria-hidden="true" />
            <h2>Analyzing…</h2>
            <p>
              Fetching and parsing <code>{status.target}</code>. Larger
              repositories can take up to a minute.
            </p>
          </section>
        )}

        {status.kind === "error" && (
          <section className="state-card state-card--error" role="alert">
            <h2>Analysis failed</h2>
            <p>{status.message}</p>
            <p className="error-code">{status.code}</p>
          </section>
        )}

        {status.kind === "success" && result && index && (
          <>
            <Summary result={result} />

            <div className="workspace">
              <div className="graph-col">
                <SearchBar
                  nodes={result.graph.nodes}
                  onSelect={(id) => select(id, true)}
                />

                <CodeGraph
                  key={status.runId}
                  result={result}
                  selectedId={selectedId}
                  focusToken={focusToken}
                  command={graphCommand}
                  impact={impactHighlight}
                  onSelect={(id) => select(id, false)}
                  onClear={clearSelection}
                  onClearImpact={clearImpact}
                />
              </div>

              <aside
                className="side-col"
                aria-label="Overview, node details and change impact"
              >
                <div
                  className="panel-tabs"
                  role="tablist"
                  aria-label="Side panel"
                >
                  {(["overview", "details", "impact"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      id={`tab-${tab}`}
                      aria-selected={panelTab === tab}
                      aria-controls={`panel-${tab}`}
                      className="tab-btn"
                      onClick={() => setPanelTab(tab)}
                    >
                      {tab === "overview"
                        ? "Overview"
                        : tab === "details"
                          ? "Details"
                          : impactTargetId
                            ? "Impact ●"
                            : "Impact"}
                    </button>
                  ))}
                </div>

                <div
                  role="tabpanel"
                  id={`panel-${panelTab}`}
                  aria-labelledby={`tab-${panelTab}`}
                >
                  {panelTab === "overview" && (
                    <OverviewPanel
                      result={result}
                      onSelectNode={(id) => select(id, true)}
                      onGraphCommand={sendGraphCommand}
                    />
                  )}

                  {panelTab === "details" && (
                    <DetailPanel
                      node={selectedNode}
                      index={index}
                      repo={result.repo}
                      onSelect={(id) => select(id, true)}
                      onClose={clearSelection}
                      impact={detailImpact}
                      onAnalyzeImpact={analyzeImpact}
                    />
                  )}

                  {panelTab === "impact" && (
                    <ImpactPanel
                      outcome={impactOutcome}
                      targetId={impactTargetId}
                      index={index}
                      repo={result.repo}
                      analysis={result.summary}
                      onSelectNode={(id) => select(id, true)}
                      onClear={clearImpact}
                    />
                  )}
                </div>
              </aside>
            </div>

            <Diagnostics result={result} />
          </>
        )}
      </main>
    </div>
  );
}