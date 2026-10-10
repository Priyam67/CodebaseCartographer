import type { GrammarId, Language } from "@/src/types/graph";

export interface LanguageInfo {
  language: Language;
  grammar: GrammarId;
}

const BY_EXTENSION: Record<string, LanguageInfo> = {
  ".js": { language: "javascript", grammar: "javascript" },
  ".jsx": { language: "javascript", grammar: "javascript" },
  ".mjs": { language: "javascript", grammar: "javascript" },
  ".cjs": { language: "javascript", grammar: "javascript" },
  ".ts": { language: "typescript", grammar: "typescript" },
  ".mts": { language: "typescript", grammar: "typescript" },
  ".cts": { language: "typescript", grammar: "typescript" },
  ".tsx": { language: "typescript", grammar: "tsx" },
  ".py": { language: "python", grammar: "python" },
  ".pyi": { language: "python", grammar: "python" },
  ".go": { language: "go", grammar: "go" },
  ".rs": { language: "rust", grammar: "rust" },
};

/** TypeScript declaration files describe types only and are usually generated. */
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;

/** Returns null for files that are not parsed. */
export function detectLanguage(filePath: string): LanguageInfo | null {
  const lower = filePath.toLowerCase();
  if (DECLARATION_FILE.test(lower)) return null;
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXTENSION[lower.slice(dot)] ?? null;
}

/**
 * Project manifests are never parsed, but the import resolver reads some of them
 * (go.mod for the module path, tsconfig.json for path aliases, ...).
 */
export const MANIFEST_FILENAMES: readonly string[] = [
  "go.mod",
  "Cargo.toml",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
];

export function isManifestFile(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  return MANIFEST_FILENAMES.includes(base);
}