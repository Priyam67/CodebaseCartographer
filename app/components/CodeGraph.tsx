"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import "@xyflow/react/dist/style.css";
import { LANGUAGES } from "@/src/types/graph";
import type {
  AnalysisResult,
  Confidence,
  EdgeBasis,
  EdgeKind,
  GraphEdge,
  GraphNode,
  Language,
  NodeKind,
} from "@/src/types/graph";

/** Hard cap so the browser stays responsive; extra nodes are dropped by connectivity. */
const MAX_RENDER_NODES = 500;
const AUTO_SYMBOLS_MAX_NODES = 150;
const MINIMAP_MIN_NODES = 25;
const NODE_WIDTH = 176;
const NODE_HEIGHT = 40;

type Group = "files" | "types" | "functions" | "external";

const GROUPS: readonly Group[] = ["files", "types", "functions", "external"];
const GROUP_LABEL: Record<Group, string> = {
  files: "Files",
  types: "Types & modules",
  functions: "Functions & methods",
  external: "External packages",
};

const EDGE_KINDS: readonly EdgeKind[] = ["contains", "imports", "calls"];
const EDGE_LABEL: Record<EdgeKind, string> = { contains: "Contains", imports: "Imports", calls: "Calls" };
const EDGE_COLOR: Record<EdgeKind, string> = { contains: "#6e7681", imports: "#58a6ff", calls: "#f0883e" };

const LANGUAGE_LABEL: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  go: "Go",
  rust: "Rust",
};

const KIND_BADGE: Record<NodeKind, string> = {
  file: "F",
  function: "ƒ",
  method: "m",
  class: "C",
  interface: "I",
  struct: "S",
  trait: "T",
  enum: "E",
  type: "t",
  module: "M",
  external: "pkg",
};

// Hex copies of the --kind colours in globals.css (the minimap cannot read CSS variables).
const KIND_COLOR: Record<NodeKind, string> = {
  file: "#58a6ff",
  function: "#3fb950",
  method: "#2fb5a8",
  class: "#d2a8ff",
  interface: "#f778ba",
  struct: "#ffa657",
  trait: "#ff7b72",
  enum: "#e3b341",
  type: "#a5d6ff",
  module: "#8b949e",
  external: "#8b949e",
};

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const CONFIDENCE_OPACITY: Record<Confidence, number> = { low: 0.4, medium: 0.65, high: 0.9 };

/* ------------------------------ commands -------------------------------- */

/** Requests from outside the graph (the overview panel) to change its filters. */
export type GraphCommandRequest =
  | { type: "isolate-language"; language: Language }
  | { type: "only-edge-kind"; kind: EdgeKind }
  | { type: "reset" };

export type GraphCommand = GraphCommandRequest & { nonce: number };

/* ------------------------------- filters -------------------------------- */

interface Filters {
  groups: Record<Group, boolean>;
  edges: Record<EdgeKind, boolean>;
  hiddenLanguages: Language[];
}

function groupOf(node: GraphNode): Group {
  if (node.kind === "file" || node.id.startsWith("pkg:")) return "files";
  if (node.kind === "external") return "external";
  if (node.kind === "function" || node.kind === "method") return "functions";
  return "types";
}

function passesFilters(node: GraphNode, filters: Filters): boolean {
  if (!filters.groups[groupOf(node)]) return false;
  return node.language === null || !filters.hiddenLanguages.includes(node.language);
}

function defaultFilters(result: AnalysisResult): Filters {
  const internalCount = result.graph.nodes.filter((node) => node.kind !== "external").length;
  const showSymbols = internalCount <= AUTO_SYMBOLS_MAX_NODES;
  return {
    groups: { files: true, types: showSymbols, functions: showSymbols, external: false },
    edges: { contains: showSymbols, imports: true, calls: true },
    hiddenLanguages: [],
  };
}

function applyCommand(previous: Filters, command: GraphCommand, result: AnalysisResult): Filters {
  switch (command.type) {
    case "reset":
      return defaultFilters(result);
    case "isolate-language": {
      const hiddenLanguages = LANGUAGES.filter(
        (language) => result.summary.languages[language] && language !== command.language,
      );
      return { ...previous, groups: { ...previous.groups, files: true }, hiddenLanguages };
    }
    case "only-edge-kind": {
      const edges: Record<EdgeKind, boolean> = { contains: false, imports: false, calls: false };
      edges[command.kind] = true;
      const groups = { ...previous.groups, files: true };
      if (command.kind === "contains") {
        groups.types = true;
        groups.functions = true;
      }
      return { ...previous, groups, edges };
    }
  }
}

/* ------------------------------ view model ------------------------------ */

interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  basis: EdgeBasis;
  confidence: Confidence;
  count: number;
}

function lowest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Builds the edges to draw for a set of visible nodes. Call edges whose symbol
 * endpoints are hidden are "lifted" to the containing files and merged, so a
 * files-only view still shows which files call into which.
 */
function buildViewEdges(
  edges: readonly GraphEdge[],
  nodesById: ReadonlyMap<string, GraphNode>,
  visible: ReadonlySet<string>,
  enabled: Record<EdgeKind, boolean>,
): ViewEdge[] {
  const merged = new Map<string, ViewEdge>();

  const representative = (id: string): string | null => {
    if (visible.has(id)) return id;
    const node = nodesById.get(id);
    if (!node?.filePath) return null;
    const fileId = `file:${node.filePath}`;
    return visible.has(fileId) ? fileId : null;
  };

  for (const edge of edges) {
    if (!enabled[edge.kind]) continue;
    let source = edge.source;
    let target = edge.target;
    if (edge.kind === "calls") {
      const liftedSource = representative(source);
      const liftedTarget = representative(target);
      if (!liftedSource || !liftedTarget) continue;
      source = liftedSource;
      target = liftedTarget;
    } else if (!visible.has(source) || !visible.has(target)) {
      continue;
    }
    if (source === target) continue;

    const key = `${edge.kind}|${source}|${target}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count++;
      existing.confidence = lowest(existing.confidence, edge.confidence);
      if (edge.basis === "inferred") existing.basis = "inferred";
    } else {
      merged.set(key, {
        id: key,
        source,
        target,
        kind: edge.kind,
        basis: edge.basis,
        confidence: edge.confidence,
        count: 1,
      });
    }
  }
  return [...merged.values()];
}

interface View {
  nodes: GraphNode[];
  edges: ViewEdge[];
  hiddenByCap: number;
}

function computeView(result: AnalysisResult, filters: Filters): View {
  const nodesById = new Map(result.graph.nodes.map((node) => [node.id, node] as const));
  const candidates = result.graph.nodes.filter((node) => passesFilters(node, filters));

  let visible: Set<string> = new Set(candidates.map((node) => node.id));
  let edges = buildViewEdges(result.graph.edges, nodesById, visible, filters.edges);
  let hiddenByCap = 0;

  if (candidates.length > MAX_RENDER_NODES) {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const ranked = [...candidates]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, MAX_RENDER_NODES);
    visible = new Set(ranked.map((node) => node.id));
    hiddenByCap = candidates.length - visible.size;
    edges = buildViewEdges(result.graph.edges, nodesById, visible, filters.edges);
  }

  return { nodes: candidates.filter((node) => visible.has(node.id)), edges, hiddenByCap };
}

/* -------------------------------- layout -------------------------------- */

interface PositionedNode {
  node: GraphNode;
  /** Centre of the node. */
  x: number;
  y: number;
}

interface SimNode extends SimulationNodeDatum {
  id: string;
  /** Anchor of the node's directory cluster. */
  ax: number;
  ay: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  kind: EdgeKind;
}

/** Directory a node is clustered with; externals share one far-away cluster. */
function directoryOf(node: GraphNode): string {
  if (node.kind === "external") return "\u0000external";
  if (!node.filePath) return "";
  if (node.id.startsWith("pkg:")) return node.filePath === "." ? "" : node.filePath;
  const slash = node.filePath.lastIndexOf("/");
  return slash === -1 ? "" : node.filePath.slice(0, slash);
}

/**
 * Force layout with one anchor per directory, so files and symbols of the same
 * directory sit together and the first render has recognisable structure.
 * d3-force uses a fixed seed, so the same input always gives the same layout.
 */
function layoutNodes(nodes: readonly GraphNode[], edges: readonly ViewEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];

  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(directoryOf(node), (counts.get(directoryOf(node)) ?? 0) + 1);
  const directories = [...counts.keys()].sort();
  const maxPerDirectory = Math.max(...counts.values());

  const columns = Math.max(1, Math.ceil(Math.sqrt(directories.length)));
  const rows = Math.ceil(directories.length / columns);
  const spacing = Math.max(300, 100 * Math.sqrt(maxPerDirectory) + 160);
  const anchors = new Map<string, { x: number; y: number }>();
  directories.forEach((directory, i) => {
    anchors.set(directory, {
      x: ((i % columns) - (columns - 1) / 2) * spacing,
      y: (Math.floor(i / columns) - (rows - 1) / 2) * spacing,
    });
  });

  const placed = new Map<string, number>();
  const simNodes: SimNode[] = nodes.map((node) => {
    const directory = directoryOf(node);
    const anchor = anchors.get(directory) ?? { x: 0, y: 0 };
    const k = placed.get(directory) ?? 0;
    placed.set(directory, k + 1);
    const angle = k * 2.399963; // golden angle spiral keeps initial positions apart
    const radius = 46 * Math.sqrt(k);
    return {
      id: node.id,
      ax: anchor.x,
      ay: anchor.y,
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
    };
  });
  const links: SimLink[] = edges.map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }));

  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance((l) => (l.kind === "contains" ? 90 : 170))
        .strength((l) => (l.kind === "contains" ? 0.7 : 0.06)),
    )
    .force("charge", forceManyBody<SimNode>().strength(-160).distanceMax(420))
    .force("collide", forceCollide<SimNode>(82).iterations(2))
    .force("x", forceX<SimNode>((d) => d.ax).strength(0.1))
    .force("y", forceY<SimNode>((d) => d.ay).strength(0.1))
    .stop();

  simulation.tick(nodes.length > 300 ? 140 : 260);

  return nodes.map((node, i) => ({ node, x: simNodes[i]?.x ?? 0, y: simNodes[i]?.y ?? 0 }));
}

function signatureOf(nodes: readonly GraphNode[], edges: readonly ViewEdge[]): string {
  let hash = 5381;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  };
  nodes.forEach((node) => mix(node.id));
  edges.forEach((edge) => mix(edge.id));
  return `${nodes.length}:${edges.length}:${hash}`;
}

/* --------------------------------- nodes -------------------------------- */

type Role = "selected" | "neighbor" | "dimmed" | "normal";

type CartoNodeData = {
  label: string;
  sublabel: string | null;
  kind: NodeKind;
  title: string;
  role: Role;
};
type CartoNode = Node<CartoNodeData, "carto">;

function CartoNodeView({ data }: NodeProps<CartoNode>) {
  // Below this zoom the second line is unreadable, so it is dropped to reduce clutter.
  const zoomedOut = useStore((state) => state.transform[2] < 0.5);
  return (
    <div className={`carto-node kind-${data.kind} is-${data.role}`} title={data.title}>
      <Handle type="target" position={Position.Top} className="carto-handle" isConnectable={false} />
      <span className="carto-node__badge">{KIND_BADGE[data.kind]}</span>
      <span className="carto-node__text">
        <span className="carto-node__label">{data.label}</span>
        {!zoomedOut && data.sublabel && <span className="carto-node__sub">{data.sublabel}</span>}
      </span>
      <Handle type="source" position={Position.Bottom} className="carto-handle" isConnectable={false} />
    </div>
  );
}

const nodeTypes = { carto: memo(CartoNodeView) };

function baseName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function sublabelOf(node: GraphNode): string | null {
  if (node.kind === "file") return node.details.directory ?? null;
  if (node.kind === "external") return node.details.ecosystem ? `external · ${node.details.ecosystem}` : "external";
  if (node.id.startsWith("pkg:")) return "Go package";
  if (!node.filePath) return null;
  return `${baseName(node.filePath)}${node.startLine ? `:${node.startLine}` : ""}`;
}

function nodeTitle(node: GraphNode): string {
  const where = node.filePath ? `${node.filePath}${node.startLine ? `:${node.startLine}` : ""}` : "external package";
  return `${node.name} (${node.kind}) — ${where}`;
}

/* -------------------------------- component ------------------------------- */

interface CodeGraphProps {
  result: AnalysisResult;
  selectedId: string | null;
  /** Increment to ask the graph to centre on the selected node. */
  focusToken: number;
  /** Filter request from the overview panel; applied once per nonce. */
  command: GraphCommand | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}

function FilterChip(props: { pressed: boolean; onClick: () => void; dot?: string; count?: number; children: string }) {
  return (
    <button type="button" className="chip" aria-pressed={props.pressed} onClick={props.onClick}>
      {props.dot && <span className="chip__dot" style={{ background: props.dot }} />}
      {props.children}
      {props.count !== undefined && <span className="chip__count">{props.count}</span>}
    </button>
  );
}

function GraphCanvas({ result, selectedId, focusToken, command, onSelect, onClear }: CodeGraphProps) {
  const { fitView, setCenter, getZoom } = useReactFlow();
  const [filters, setFilters] = useState<Filters>(() => defaultFilters(result));

  const nodesById = useMemo(
    () => new Map(result.graph.nodes.map((node) => [node.id, node] as const)),
    [result],
  );
  const groupCounts = useMemo(() => {
    const counts: Record<Group, number> = { files: 0, types: 0, functions: 0, external: 0 };
    for (const node of result.graph.nodes) counts[groupOf(node)]++;
    return counts;
  }, [result]);
  const presentLanguages = useMemo(
    () => LANGUAGES.filter((language) => result.summary.languages[language]),
    [result],
  );

  const view = useMemo(() => computeView(result, filters), [result, filters]);
  const layout = useMemo(() => layoutNodes(view.nodes, view.edges), [view]);
  const signature = useMemo(() => signatureOf(view.nodes, view.edges), [view]);
  const drawnIds = useMemo(() => new Set(view.nodes.map((node) => node.id)), [view]);
  const colorById = useMemo(
    () => new Map(view.nodes.map((node) => [node.id, KIND_COLOR[node.kind]] as const)),
    [view],
  );

  // Direct neighbours of the selection among the *drawn* edges (visual selection only).
  const neighborIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    for (const edge of view.edges) {
      if (edge.source === selectedId) ids.add(edge.target);
      else if (edge.target === selectedId) ids.add(edge.source);
    }
    return ids;
  }, [view.edges, selectedId]);

  const rfNodes = useMemo<CartoNode[]>(
    () =>
      layout.map(({ node, x, y }) => {
        const role: Role =
          selectedId === null
            ? "normal"
            : node.id === selectedId
              ? "selected"
              : neighborIds.has(node.id)
                ? "neighbor"
                : "dimmed";
        return {
          id: node.id,
          type: "carto",
          position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
          data: { label: node.name, sublabel: sublabelOf(node), kind: node.kind, title: nodeTitle(node), role },
          selected: role === "selected",
        };
      }),
    [layout, selectedId, neighborIds],
  );

  const rfEdges = useMemo<Edge[]>(
    () =>
      view.edges.map((edge) => {
        const color = EDGE_COLOR[edge.kind];
        const isActive = selectedId !== null && (edge.source === selectedId || edge.target === selectedId);
        const baseOpacity = edge.kind === "contains" ? 0.45 : CONFIDENCE_OPACITY[edge.confidence];
        const opacity = selectedId === null ? baseOpacity : isActive ? 1 : 0.1;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "straight",
          label: edge.count > 1 ? `×${edge.count}` : undefined,
          labelStyle: { fill: "#e6edf3", fontSize: 11 },
          labelBgStyle: { fill: "#161b22" },
          zIndex: isActive ? 10 : 0,
          markerEnd:
            edge.kind === "contains"
              ? undefined
              : { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          style: {
            stroke: color,
            strokeWidth: isActive ? 2.6 : edge.kind === "contains" ? 1 : 1.5,
            strokeDasharray: edge.basis === "inferred" ? "6 4" : undefined,
            opacity,
          },
        };
      }),
    [view.edges, selectedId],
  );

  // Apply a filter request coming from the overview panel (once per nonce).
  const handledCommand = useRef(command?.nonce ?? 0);
  useEffect(() => {
    if (!command || command.nonce === handledCommand.current) return;
    handledCommand.current = command.nonce;
    setFilters((previous) => applyCommand(previous, command, result));
  }, [command, result]);

  // A selected node (e.g. from search) must not stay hidden behind a filter.
  useEffect(() => {
    if (!selectedId) return;
    const node = nodesById.get(selectedId);
    if (!node) return;
    const group = groupOf(node);
    setFilters((previous) => {
      const needsGroup = !previous.groups[group];
      const needsLanguage = node.language !== null && previous.hiddenLanguages.includes(node.language);
      if (!needsGroup && !needsLanguage) return previous;
      return {
        ...previous,
        groups: needsGroup ? { ...previous.groups, [group]: true } : previous.groups,
        hiddenLanguages: needsLanguage
          ? previous.hiddenLanguages.filter((language) => language !== node.language)
          : previous.hiddenLanguages,
      };
    });
  }, [selectedId, nodesById]);

  // Centre on a searched node, otherwise fit the view whenever the layout changes.
  const handledFocus = useRef(0);
  const lastFitSignature = useRef("");
  useEffect(() => {
    if (layout.length === 0) return;

    if (focusToken !== handledFocus.current && selectedId) {
      const target = layout.find((entry) => entry.node.id === selectedId);
      if (target) {
        handledFocus.current = focusToken;
        lastFitSignature.current = signature;
        void setCenter(target.x, target.y, { zoom: Math.max(getZoom(), 1), duration: 400 });
        return;
      }
      const node = nodesById.get(selectedId);
      if (node && !passesFilters(node, filters)) return; // filters are about to be relaxed
      handledFocus.current = focusToken; // cannot be drawn (node cap); fall through to fit
    }

    if (lastFitSignature.current !== signature) {
      lastFitSignature.current = signature;
      void fitView({ padding: 0.15, duration: 250 });
    }
  }, [layout, signature, focusToken, selectedId, filters, nodesById, setCenter, getZoom, fitView]);

  const handleNodeClick = useCallback<NodeMouseHandler<CartoNode>>(
    (_event, node) => onSelect(node.id),
    [onSelect],
  );

  const toggleGroup = (group: Group): void =>
    setFilters((previous) => ({ ...previous, groups: { ...previous.groups, [group]: !previous.groups[group] } }));
  const toggleEdge = (kind: EdgeKind): void =>
    setFilters((previous) => ({ ...previous, edges: { ...previous.edges, [kind]: !previous.edges[kind] } }));
  const toggleLanguage = (language: Language): void =>
    setFilters((previous) => ({
      ...previous,
      hiddenLanguages: previous.hiddenLanguages.includes(language)
        ? previous.hiddenLanguages.filter((entry) => entry !== language)
        : [...previous.hiddenLanguages, language],
    }));

  const filtersAreDefault = useMemo(
    () => JSON.stringify(filters) === JSON.stringify(defaultFilters(result)),
    [filters, result],
  );
  const kindsInView = useMemo(() => {
    const kinds = new Set<NodeKind>();
    for (const node of view.nodes) kinds.add(node.kind);
    return [...kinds].sort();
  }, [view.nodes]);

  const selectedNotDrawn = selectedId !== null && nodesById.has(selectedId) && !drawnIds.has(selectedId);
  const symbolsHidden = !filters.groups.functions && !filters.groups.types;

  return (
    <div className="graph-card">
      <div className="filters" role="group" aria-label="Graph filters">
        <div className="filter-group">
          <span className="filter-group__label">Show</span>
          {GROUPS.map((group) => (
            <FilterChip
              key={group}
              pressed={filters.groups[group]}
              count={groupCounts[group]}
              onClick={() => toggleGroup(group)}
            >
              {GROUP_LABEL[group]}
            </FilterChip>
          ))}
        </div>
        <div className="filter-group">
          <span className="filter-group__label">Relationships</span>
          {EDGE_KINDS.map((kind) => (
            <FilterChip
              key={kind}
              pressed={filters.edges[kind]}
              dot={EDGE_COLOR[kind]}
              onClick={() => toggleEdge(kind)}
            >
              {EDGE_LABEL[kind]}
            </FilterChip>
          ))}
        </div>
        {presentLanguages.length > 1 && (
          <div className="filter-group">
            <span className="filter-group__label">Language</span>
            {presentLanguages.map((language) => (
              <FilterChip
                key={language}
                pressed={!filters.hiddenLanguages.includes(language)}
                count={result.summary.languages[language]?.files}
                onClick={() => toggleLanguage(language)}
              >
                {LANGUAGE_LABEL[language]}
              </FilterChip>
            ))}
          </div>
        )}
        <div className="filters__actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void fitView({ padding: 0.15, duration: 250 })}
            disabled={layout.length === 0}
          >
            Fit view
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setFilters(defaultFilters(result))}
            disabled={filtersAreDefault}
          >
            Reset filters
          </button>
        </div>
      </div>

      {view.hiddenByCap > 0 && (
        <div className="notice">
          Showing the {MAX_RENDER_NODES} most-connected of {MAX_RENDER_NODES + view.hiddenByCap} matching nodes. Turn
          off a group or language to see the rest.
        </div>
      )}
      {selectedNotDrawn && (
        <div className="notice">
          The selected node is not drawn (hidden by a filter or beyond the {MAX_RENDER_NODES}-node limit). Its details
          are still shown in the side panel.
        </div>
      )}
      {symbolsHidden && filters.edges.calls && (
        <div className="notice notice--info">
          Symbols are hidden, so call edges connect whole files. ×N is the number of call edges merged into one.
        </div>
      )}

      <div
        className="canvas"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClear();
        }}
      >
        {layout.length === 0 && <div className="canvas__empty">No nodes match the current filters.</div>}
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onPaneClick={onClear}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements
          aria-label="Interactive code graph"
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          {layout.length > MINIMAP_MIN_NODES && (
            <MiniMap
              pannable
              zoomable
              nodeStrokeWidth={0}
              nodeColor={(node) => colorById.get(node.id) ?? "#8b949e"}
              maskColor="rgba(13, 17, 23, 0.72)"
              ariaLabel="Graph minimap"
            />
          )}
        </ReactFlow>
      </div>

      <div className="legend" aria-label="Legend">
        {kindsInView.map((kind) => (
          <span key={kind} className={`legend__item kind-${kind}`}>
            <span className="legend__swatch" />
            {kind}
          </span>
        ))}
        {EDGE_KINDS.map((kind) => (
          <span key={kind} className="legend__item">
            <span className="legend__line" style={{ ["--line" as string]: EDGE_COLOR[kind] }} />
            {EDGE_LABEL[kind]}
          </span>
        ))}
        <span className="legend__item">
          <span className="legend__line" /> solid = read from syntax
        </span>
        <span className="legend__item">
          <span className="legend__line legend__line--dashed" /> dashed = inferred
        </span>
        <span className="legend__item">fainter = lower confidence</span>
      </div>
    </div>
  );
}

export default function CodeGraph(props: CodeGraphProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}