// Smoke test: loads every grammar through web-tree-sitter and parses a tiny snippet.
// Run with: pnpm check:parsers
import path from "node:path";
import Parser from "web-tree-sitter";

const root = process.cwd();
const coreWasm = path.join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm");
const wasmDir = path.join(root, "node_modules", "tree-sitter-wasms", "out");

const samples = {
  javascript: "import a from './a'; export function f() { return a(); }",
  typescript: "interface A { x: number } export const f = (a: A): number => a.x;",
  tsx: "export const C = () => <div>hi</div>;",
  python: "import os\n\ndef f():\n    return os.getcwd()\n",
  go: 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n',
  rust: "use std::fmt;\n\npub fn f() -> u32 { 1 }\n",
};

let failed = false;

try {
  await Parser.init({
    locateFile: (name) => (name === "tree-sitter.wasm" ? coreWasm : name),
  });
} catch (error) {
  console.error("FAIL: Parser.init()", error);
  process.exit(1);
}

for (const [grammar, code] of Object.entries(samples)) {
  try {
    const language = await Parser.Language.load(
      path.join(wasmDir, `tree-sitter-${grammar}.wasm`),
    );
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(code);
    const hasError = tree.rootNode.hasError;
    console.log(
      `${hasError ? "WARN" : "ok  "} ${grammar.padEnd(10)} root=${tree.rootNode.type} hasError=${hasError}`,
    );
    if (hasError) failed = true;
    tree.delete();
    parser.delete();
  } catch (error) {
    failed = true;
    console.error(`FAIL ${grammar}:`, error instanceof Error ? error.message : error);
  }
}

process.exit(failed ? 1 : 0);