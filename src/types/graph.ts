/**
 * Shared data contract for the whole project: parser output, analysis result,
 * API payloads and the graph rendered by the UI.
 *
 * This file must stay free of Node/browser-only imports so both server and
 * client code can import it.
 */

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

export type Language = "javascript" | "typescript" | "python" | "go" | "rust";

export const LANGUAGES: readonly Language[] = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
];

/**
 * Tree-sitter grammar variant. TSX needs its own grammar; JSX is handled by the
 * JavaScript grammar. TSX files still report `language: "typescript"`.
 */
export type GrammarId = "javascript" | "typescript" | "tsx" | "python" | "go" | "rust";

/* ------------------------------------------------------------------ */
/* Graph model                                                         */
/* ------------------------------------------------------------------ */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "trait"
  | "enum"
  | "type"
  | "module";

/** "external" = a package/module outside the analysed repository. */
export type NodeKind = "file" | SymbolKind | "external";

export type EdgeKind = "contains" | "imports" | "calls";

/**
 * syntax   - both ends are established directly from syntax (containment, or an
 *            import whose target path exists exactly as written).
 * inferred - depends on a heuristic (name matching, module-path guessing, ...).
 */
export type EdgeBasis = "syntax" | "inferred";

export type Confidence = "high" | "medium" | "low";

export interface GraphNode {
  /** Unique within one analysis. */
  id: string;
  name: string;
  kind: NodeKind;
  /** null for external packages. */
  language: Language | null;
  /** Repo-relative path using "/" separators; null for external packages. */
  filePath: string | null;
  /** 1-based, inclusive. null for external packages. */
  startLine: number | null;
  endLine: number | null;
  /** Containing node (file for top-level symbols, class for methods, ...). */
  parentId: string | null;
  exported: boolean;
  /** First line of the declaration, trimmed. */
  excerpt: string | null;
  /** Language-specific extras (e.g. receiver, bases, async). Strings only. */
  details: Record<string, string>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  basis: EdgeBasis;
  confidence: Confidence;
  /** Human-readable explanation of how the edge was established. */
  note: string | null;
  /** Line of the import/call site in the source file, when known. */
  line: number | null;
}

export interface CodeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* ------------------------------------------------------------------ */
/* Parser output (language adapters -> analysis engine)                */
/* ------------------------------------------------------------------ */

export interface SourceFile {
  /** Repo-relative path using "/" separators. */
  path: string;
  content: string;
  sizeBytes: number;
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  filePath: string | null;
  line: number | null;
  message: string;
}

export interface ExtractedSymbol {
  /** Unique within one file extraction. */
  localId: string;
  name: string;
  kind: SymbolKind;
  parentLocalId: string | null;
  startLine: number;
  endLine: number;
  exported: boolean;
  excerpt: string;
  details: Record<string, string>;
}

export type ImportStyle = "static" | "reexport" | "require" | "dynamic" | "mod";

export interface ImportBinding {
  /** Name exported by the target: a symbol name, "default", or "*" (whole module). */
  imported: string;
  /** Name bound in the importing file. */
  local: string;
}

export interface ExtractedImport {
  /** Raw specifier as written: "./a", "os.path", "github.com/x/y", "crate::a::b". */
  specifier: string;
  style: ImportStyle;
  bindings: ImportBinding[];
  line: number;
  typeOnly: boolean;
}

export interface ExtractedCall {
  /** Enclosing symbol; null when the call is at file level. */
  callerLocalId: string | null;
  /** Called name (last segment): "foo" for foo() and a.b.foo(). */
  name: string;
  /**
   * null for a bare call `foo()`. Otherwise the receiver text (`this`, `utils`,
   * `self.repo`) or "<expr>" when the receiver is not a simple name chain.
   */
  receiver: string | null;
  line: number;
  isConstructor: boolean;
}

/** What a language adapter returns for one syntax tree. */
export interface AdapterOutput {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
}

export interface FileExtraction extends AdapterOutput {
  filePath: string;
  language: Language;
  lineCount: number;
  diagnostics: Diagnostic[];
}

/* ------------------------------------------------------------------ */
/* Analysis request / result / errors                                  */
/* ------------------------------------------------------------------ */

export interface RepoLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  /** The UI and API refuse to return graphs larger than this. */
  maxGraphNodes: number;
}

export interface RepoInfo {
  source: "github" | "local";
  name: string;
  owner: string | null;
  ref: string | null;
  url: string | null;
}

export interface LanguageStats {
  files: number;
  symbols: number;
}

export interface AnalysisSummary {
  filesAnalyzed: number;
  filesSkipped: number;
  totalBytes: number;
  symbolCount: number;
  languages: Partial<Record<Language, LanguageStats>>;
  nodeCount: number;
  edgeCount: number;
  edgesByKind: Record<EdgeKind, number>;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
  callsResolved: number;
  callsDropped: number;
  parseFailures: number;
}

export interface AnalysisResult {
  repo: RepoInfo;
  graph: CodeGraph;
  summary: AnalysisSummary;
  diagnostics: Diagnostic[];
}

export type AnalysisErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_URL"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "LIMIT_EXCEEDED"
  | "NO_SUPPORTED_FILES"
  | "UPSTREAM_ERROR"
  | "LOCAL_DISABLED"
  | "INTERNAL_ERROR";

export interface AnalysisErrorBody {
  error: {
    code: AnalysisErrorCode;
    message: string;
  };
}

export interface AnalyzeRequest {
  /** Public GitHub repository URL. */
  repoUrl?: string;
  /** Development-only; ignored unless local analysis is explicitly enabled. */
  localPath?: string;
}

export type AnalyzeResponse = AnalysisResult | AnalysisErrorBody;

/** Thrown by repository loaders and mapped to an HTTP status in the route handler. */
export class AnalysisFailure extends Error {
  readonly code: AnalysisErrorCode;

  constructor(code: AnalysisErrorCode, message: string) {
    super(message);
    this.name = "AnalysisFailure";
    this.code = code;
  }
}