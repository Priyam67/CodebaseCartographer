"use client";

import { useState, type FormEvent } from "react";

export type AnalyzeTarget =
  | { kind: "github"; repoUrl: string }
  | { kind: "local"; localPath: string };

interface RepoInputProps {
  loading: boolean;
  showExamples: boolean;
  onAnalyze: (target: AnalyzeTarget) => void;
}

// Suggestions only: any public GitHub repository works.
const EXAMPLES: ReadonlyArray<{ label: string; url: string }> = [
  { label: "sindresorhus/is (TypeScript)", url: "https://github.com/sindresorhus/is" },
  { label: "pallets/click (Python)", url: "https://github.com/pallets/click" },
  { label: "spf13/cobra (Go)", url: "https://github.com/spf13/cobra" },
  { label: "BurntSushi/walkdir (Rust)", url: "https://github.com/BurntSushi/walkdir" },
];

// Inlined at build time. The server still refuses local paths unless explicitly enabled.
const LOCAL_TAB_AVAILABLE = process.env.NODE_ENV !== "production";

export default function RepoInput({ loading, showExamples, onAnalyze }: RepoInputProps) {
  const [mode, setMode] = useState<"github" | "local">("github");
  const [value, setValue] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || loading) return;
    onAnalyze(mode === "github" ? { kind: "github", repoUrl: trimmed } : { kind: "local", localPath: trimmed });
  };

  const runExample = (url: string): void => {
    if (loading) return;
    setMode("github");
    setValue(url);
    onAnalyze({ kind: "github", repoUrl: url });
  };

  return (
    <form className="repo-input" onSubmit={submit}>
      {LOCAL_TAB_AVAILABLE && (
        <div className="repo-input__tabs" role="group" aria-label="Repository source">
          <button type="button" className="btn btn--ghost" aria-pressed={mode === "github"} onClick={() => setMode("github")}>
            GitHub URL
          </button>
          <button type="button" className="btn btn--ghost" aria-pressed={mode === "local"} onClick={() => setMode("local")}>
            Local folder (dev)
          </button>
        </div>
      )}

      <div className="repo-input__row">
        <input
          className="repo-input__field"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={mode === "github" ? "https://github.com/owner/repo" : "path inside CARTOGRAPHER_LOCAL_ROOT"}
          aria-label={mode === "github" ? "GitHub repository URL" : "Local folder path"}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn" type="submit" disabled={loading || value.trim().length === 0}>
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {showExamples && (
        <div className="repo-input__examples">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example.url}
              type="button"
              className="chip"
              disabled={loading}
              onClick={() => runExample(example.url)}
            >
              {example.label}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}