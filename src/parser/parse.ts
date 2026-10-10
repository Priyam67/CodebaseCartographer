import path from "node:path";
import Parser from "web-tree-sitter";
import type { AdapterOutput, Diagnostic, FileExtraction, GrammarId, SourceFile } from "@/src/types/graph";
import { detectLanguage } from "./detect-language";
import { extractGo } from "./adapters/go";
import { extractJavaScript } from "./adapters/javascript";
import { extractPython } from "./adapters/python";
import { extractRust } from "./adapters/rust";

// Server-only module: never import this from a client component.

type Adapter = (root: Parser.SyntaxNode, source: string) => AdapterOutput;

const ADAPTERS: Record<GrammarId, Adapter> = {
  javascript: extractJavaScript,
  typescript: extractJavaScript,
  tsx: extractJavaScript,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
};

const WASM_FILES: Record<GrammarId, string> = {
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
};

// Resolved from the project root (works with pnpm's top-level symlinks for
// direct dependencies). Both packages are marked as server externals in
// next.config.ts so these files exist on disk at runtime.
const CORE_WASM = path.join(process.cwd(), "node_modules", "web-tree-sitter", "tree-sitter.wasm");
const GRAMMAR_DIR = path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out");

interface ParserRuntime {
  init: Promise<void> | null;
  languages: Map<GrammarId, Promise<Parser.Language>>;
  parsers: Map<GrammarId, Parser>;
}

// Stored on globalThis so dev-mode hot reloads don't re-initialise WASM.
const globalStore = globalThis as typeof globalThis & { __cartographerParsers?: ParserRuntime };
const runtime: ParserRuntime = (globalStore.__cartographerParsers ??= {
  init: null,
  languages: new Map(),
  parsers: new Map(),
});

function ensureInit(): Promise<void> {
  if (!runtime.init) {
    runtime.init = Parser.init({
      locateFile: (name: string) => (name === "tree-sitter.wasm" ? CORE_WASM : name),
    });
    runtime.init.catch(() => {
      runtime.init = null; // allow a retry on the next request
    });
  }
  return runtime.init;
}

async function getParser(grammar: GrammarId): Promise<Parser> {
  await ensureInit();
  const existing = runtime.parsers.get(grammar);
  if (existing) return existing;

  let languagePromise = runtime.languages.get(grammar);
  if (!languagePromise) {
    languagePromise = Parser.Language.load(path.join(GRAMMAR_DIR, WASM_FILES[grammar]));
    runtime.languages.set(grammar, languagePromise);
    languagePromise.catch(() => runtime.languages.delete(grammar));
  }
  const language = await languagePromise;

  // Re-check: another call may have created the parser while we awaited.
  const raced = runtime.parsers.get(grammar);
  if (raced) return raced;
  const parser = new Parser();
  parser.setLanguage(language);
  runtime.parsers.set(grammar, parser);
  return parser;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
  return lines;
}

/**
 * Parses one file and runs its language adapter. Never throws: failures become
 * diagnostics so one bad file cannot abort a whole repository analysis.
 * Returns null if the file's language is not supported.
 */
export async function parseSourceFile(file: SourceFile): Promise<FileExtraction | null> {
  const detected = detectLanguage(file.path);
  if (!detected) return null;

  const diagnostics: Diagnostic[] = [];
  const empty: FileExtraction = {
    filePath: file.path,
    language: detected.language,
    lineCount: countLines(file.content),
    symbols: [],
    imports: [],
    calls: [],
    diagnostics,
  };

  try {
    const parser = await getParser(detected.grammar);
    // parse() and the adapter run synchronously, so the shared parser instance
    // is never used by two files at once.
    const tree = parser.parse(file.content);
    try {
      const root = tree.rootNode;
      if (root.hasError) {
        const firstError = root.descendantsOfType("ERROR")[0];
        diagnostics.push({
          severity: "warning",
          filePath: file.path,
          line: firstError ? firstError.startPosition.row + 1 : null,
          message: "Syntax errors found; symbols in this file may be incomplete.",
        });
      }
      const output = ADAPTERS[detected.grammar](root, file.content);
      return { ...empty, ...output };
    } finally {
      tree.delete();
    }
  } catch (error) {
    diagnostics.push({
      severity: "error",
      filePath: file.path,
      line: null,
      message: `Could not parse file: ${error instanceof Error ? error.message : String(error)}`,
    });
    return empty;
  }
}