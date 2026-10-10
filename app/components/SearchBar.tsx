"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { GraphNode } from "@/src/types/graph";

interface SearchBarProps {
  nodes: readonly GraphNode[];
  onSelect: (id: string) => void;
}

const MAX_RESULTS = 8;

/** Lower is better; -1 means no match. */
function score(node: GraphNode, query: string): number {
  const name = node.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (node.filePath?.toLowerCase().includes(query)) return 3;
  return -1;
}

export default function SearchBar({ nodes, onSelect }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

console.log(
  "[SearchBar] node count:",
  nodes.length,
  "sample nodes:",
  nodes.slice(0, 10).map((node) => ({
    name: node.name,
    filePath: node.filePath,
    kind: node.kind,
  })),
 );

  const listId = useId();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return nodes
      .map((node) => ({ node, rank: score(node, q) }))
      .filter((entry) => entry.rank >= 0)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(b.node.kind === "file") - Number(a.node.kind === "file") ||
          a.node.name.localeCompare(b.node.name),
      )
      .slice(0, MAX_RESULTS)
      .map((entry) => entry.node);
  }, [nodes, query]);

  const pick = (node: GraphNode): void => {
    setQuery(node.name);
    setOpen(false);
    onSelect(node.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      const node = results[active];
      if (open && node) {
        event.preventDefault();
        pick(node);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div
      className="search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <input
        className="search__input"
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
        aria-label="Search files and symbols"
        placeholder="Search files and symbols…"
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {showList && (
        <ul className="search__list" id={listId} role="listbox">
          {results.length === 0 && <li className="search__none">No matches</li>}
          {results.map((node, index) => (
            <li
              key={node.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="search__option"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(node)}
            >
              <span className={`badge kind-${node.kind}`}>{node.kind}</span>
              <span className="search__name">{node.name}</span>
              <span className="search__path">
                {node.filePath ?? "external package"}
                {node.startLine ? `:${node.startLine}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}