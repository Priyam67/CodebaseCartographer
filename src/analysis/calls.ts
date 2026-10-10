import path from "node:path";
import { COMPLEX_RECEIVER } from "@/src/parser/adapters/shared";
import type { Confidence, ExtractedCall, GraphNode, NodeKind } from "@/src/types/graph";
import type { ImportTarget } from "./imports";
import type { FileSymbols } from "./symbols";

/**
 * Lightweight call resolution. Tree-sitter gives us call *sites*, not types, so
 * a call is only linked when a name can be tied to a declaration through an
 * explicit import, the enclosing type, or a same-file / same-package lookup.
 * Everything else (e.g. `obj.method()` on a variable) is dropped, not guessed.
 */

export interface ImportedName {
  /** Name in the target: a symbol name, "default", or "*" for a whole module/namespace. */
  imported: string;
  specifier: string;
  targets: ImportTarget[];
}

export interface ReExport {
  exportedName: string;
  originalName: string;
  targets: ImportTarget[];
}

export interface CallContext {
  file: FileSymbols;
  filesByPath: ReadonlyMap<string, FileSymbols>;
  /** Go package directory -> files in it. */
  goPackages: ReadonlyMap<string, readonly FileSymbols[]>;
  /** Local name -> what it was imported as, for the current file. */
  imports: ReadonlyMap<string, ImportedName>;
  /** File path -> its `export ... from` re-exports (barrel files). */
  reexports: ReadonlyMap<string, readonly ReExport[]>;
}

export interface ResolvedCall {
  sourceId: string;
  target: GraphNode;
  confidence: Confidence;
  note: string;
  line: number;
}

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["function", "class"]);
const TYPE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["class", "struct", "enum", "trait", "interface", "type"]);
const MAX_REEXPORT_DEPTH = 3;

interface Hit {
  target: GraphNode;
  confidence: Confidence;
  note: string;
}

function topLevel(file: FileSymbols, name: string, kinds: ReadonlySet<NodeKind>): GraphNode[] {
  return (file.byName.get(name) ?? []).filter((n) => n.parentId === file.fileNode.id && kinds.has(n.kind));
}

function findInFile(
  ctx: CallContext,
  filePath: string,
  name: string,
  kinds: ReadonlySet<NodeKind>,
  depth: number,
): GraphNode | null {
  const file = ctx.filesByPath.get(filePath);
  if (!file) return null;

  const direct = topLevel(file, name, kinds)[0];
  if (direct) return direct;

  if (depth >= MAX_REEXPORT_DEPTH) return null;
  for (const reexport of ctx.reexports.get(filePath) ?? []) {
    if (reexport.exportedName === name) {
      const hit = findInTargets(ctx, reexport.targets, reexport.originalName, kinds, depth + 1);
      if (hit) return hit;
    } else if (reexport.exportedName === "*") {
      const hit = findInTargets(ctx, reexport.targets, name, kinds, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function findInTargets(
  ctx: CallContext,
  targets: readonly ImportTarget[],
  name: string,
  kinds: ReadonlySet<NodeKind>,
  depth = 0,
): GraphNode | null {
  for (const target of targets) {
    const paths = target.type === "file" ? [target.path] : target.files;
    for (const filePath of paths) {
      const hit = findInFile(ctx, filePath, name, kinds, depth);
      if (hit) return hit;
    }
  }
  return null;
}

function ownerOf(file: FileSymbols, node: GraphNode | null): GraphNode | null {
  let current: GraphNode | null = node;
  for (let guard = 0; current && guard < 10; guard++) {
    if (TYPE_KINDS.has(current.kind)) return current;
    current = current.parentId ? (file.byId.get(current.parentId) ?? null) : null;
  }
  return null;
}

function methodsNamed(file: FileSymbols, owner: GraphNode, name: string): GraphNode[] {
  return (file.children.get(owner.id) ?? []).filter((n) => n.kind === "method" && n.name === name);
}

function typeNameFromReceiver(receiver: string | undefined): string | null {
  if (!receiver) return null;
  return /([A-Za-z_]\w*)/.exec(receiver.replace(/^\*/, ""))?.[1] ?? null;
}

function selfNames(language: string, caller: GraphNode | null): string[] {
  switch (language) {
    case "javascript":
    case "typescript":
      return ["this"];
    case "python":
      return ["self", "cls"];
    case "rust":
      return ["self", "Self"];
    case "go": {
      const name = caller?.details.receiverName;
      return name ? [name] : [];
    }
    default:
      return [];
  }
}

function resolveOne(ctx: CallContext, call: ExtractedCall, caller: GraphNode | null): Hit | null {
  const file = ctx.file;
  const language = file.language;

  /* ---- bare calls: foo() / new Foo() ---- */
  if (call.receiver === null) {
    const imported = ctx.imports.get(call.name);
    if (imported && imported.imported !== "*") {
      const target = findInTargets(ctx, imported.targets, imported.imported, CALLABLE_KINDS);
      if (target) {
        return {
          target,
          confidence: "high",
          note: `Bound by the import of "${imported.imported}" from "${imported.specifier}".`,
        };
      }
    }

    const sameFile = topLevel(file, call.name, CALLABLE_KINDS);
    if (sameFile.length === 1 && sameFile[0]) {
      return { target: sameFile[0], confidence: "medium", note: "Name match in the same file (no scope analysis)." };
    }
    if (sameFile.length > 1) return null; // ambiguous

    if (language === "go") {
      const dir = path.posix.dirname(file.path);
      const matches: GraphNode[] = [];
      for (const sibling of ctx.goPackages.get(dir) ?? []) {
        matches.push(...topLevel(sibling, call.name, CALLABLE_KINDS));
      }
      if (matches.length === 1 && matches[0]) {
        return { target: matches[0], confidence: "high", note: "Go package scope: same directory, unique name." };
      }
    }
    return null;
  }

  /* ---- receiver calls ---- */
  const receiver = call.receiver;
  if (receiver === COMPLEX_RECEIVER) return null;

  // this.foo() / self.foo() / Self::foo() / s.foo() inside a Go method
  if (caller && selfNames(language, caller).includes(receiver)) {
    const staticTypes = language === "go" || language === "rust";
    const confidence: Confidence = staticTypes ? "high" : "medium";

    if (language === "go") {
      const typeName = typeNameFromReceiver(caller.details.receiver);
      if (!typeName) return null;
      const dir = path.posix.dirname(file.path);
      const matches: GraphNode[] = [];
      for (const sibling of ctx.goPackages.get(dir) ?? []) {
        for (const node of sibling.byName.get(call.name) ?? []) {
          if (node.kind === "method" && typeNameFromReceiver(node.details.receiver) === typeName) matches.push(node);
        }
      }
      const target = matches[0];
      return matches.length === 1 && target
        ? { target, confidence, note: `Method call on the receiver of type ${typeName} (same package).` }
        : null;
    }

    const owner = ownerOf(file, caller);
    if (!owner) return null;
    const methods = methodsNamed(file, owner, call.name);
    const target = methods[0];
    return methods.length === 1 && target
      ? { target, confidence, note: `Call on "${receiver}" resolved to a method of ${owner.name}; overrides in subclasses are not considered.` }
      : null;
  }

  // module.func() / namespace.func() / Type.method() through an import
  const imported = ctx.imports.get(receiver);
  if (imported) {
    if (imported.imported === "*") {
      const target = findInTargets(ctx, imported.targets, call.name, CALLABLE_KINDS);
      return target
        ? { target, confidence: "high", note: `Called through the module/namespace "${receiver}" imported from "${imported.specifier}".` }
        : null;
    }
    const type = findInTargets(ctx, imported.targets, imported.imported, TYPE_KINDS);
    const typeFile = type?.filePath ? ctx.filesByPath.get(type.filePath) : undefined;
    if (type && typeFile) {
      const methods = methodsNamed(typeFile, type, call.name);
      const target = methods[0];
      if (methods.length === 1 && target) {
        return { target, confidence: "medium", note: `Static/associated call on the imported type "${type.name}".` };
      }
    }
    return null;
  }

  // Type.method() / Type::method() on a type declared in the same file
  if (/^[A-Za-z_]\w*$/.test(receiver)) {
    const type = topLevel(file, receiver, TYPE_KINDS)[0];
    if (type) {
      const methods = methodsNamed(file, type, call.name);
      const target = methods[0];
      if (methods.length === 1 && target) {
        return {
          target,
          confidence: language === "rust" ? "high" : "medium",
          note: `Static/associated call on "${type.name}", declared in the same file.`,
        };
      }
    }
  }

  return null;
}

export function resolveCalls(
  ctx: CallContext,
  calls: readonly ExtractedCall[],
): { resolved: ResolvedCall[]; dropped: number } {
  const resolved: ResolvedCall[] = [];
  let dropped = 0;

  for (const call of calls) {
    const caller = call.callerLocalId ? (ctx.file.byLocalId.get(call.callerLocalId) ?? null) : null;
    const sourceId = caller?.id ?? ctx.file.fileNode.id;
    const hit = resolveOne(ctx, call, caller);
    // Direct recursion would only add a self-loop, so it is counted as dropped.
    if (!hit || hit.target.id === sourceId) {
      dropped++;
      continue;
    }
    resolved.push({ sourceId, target: hit.target, confidence: hit.confidence, note: hit.note, line: call.line });
  }
  return { resolved, dropped };
}