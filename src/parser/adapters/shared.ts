import type Parser from "web-tree-sitter";
import type {
  AdapterOutput,
  ExtractedCall,
  ExtractedImport,
  ExtractedSymbol,
  ImportBinding,
  ImportStyle,
  SymbolKind,
} from "@/src/types/graph";

export type SyntaxNode = Parser.SyntaxNode;

export const COMPLEX_RECEIVER = "<expr>";

export function unquote(text: string): string {
  if (text.length < 2) return text;

  const first = text[0];
  const last = text[text.length - 1];

  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "`" && last === "`")
  ) {
    return text.slice(1, -1);
  }

  return text;
}

/**
 * Returns a readable receiver for simple identifier/member chains.
 * Examples: utils, this.service, self.repo, package::module.
 */
export function receiverOf(
  node: SyntaxNode | null | undefined,
): string | null {
  if (!node) return null;

  switch (node.type) {
    case "identifier":
    case "type_identifier":
    case "this":
    case "super":
    case "self":
      return node.text;

    case "member_expression": {
      const object = node.childForFieldName("object");
      const property = node.childForFieldName("property");
      const left = receiverOf(object);

      return left && property ? `${left}.${property.text}` : null;
    }

    case "attribute": {
      const object = node.childForFieldName("object");
      const attribute = node.childForFieldName("attribute");
      const left = receiverOf(object);

      return left && attribute ? `${left}.${attribute.text}` : null;
    }

    case "selector_expression": {
      const operand = node.childForFieldName("operand");
      const field = node.childForFieldName("field");
      const left = receiverOf(operand);

      return left && field ? `${left}.${field.text}` : null;
    }

    case "field_expression": {
      const value = node.childForFieldName("value");
      const field = node.childForFieldName("field");
      const left = receiverOf(value);

      return left && field ? `${left}.${field.text}` : null;
    }

    case "scoped_identifier": {
      const path = node.childForFieldName("path");
      const name = node.childForFieldName("name");
      const left = receiverOf(path);

      return left && name ? `${left}::${name.text}` : null;
    }

    default:
      return null;
  }
}

interface SymbolOptions {
  name: string;
  kind: SymbolKind;
  parentLocalId: string | null;
  exported: boolean;
  details?: Record<string, string>;
}

interface ImportOptions {
  specifier: string;
  style: ImportStyle;
  bindings: ImportBinding[];
  typeOnly?: boolean;
}

interface CallOptions {
  callerLocalId: string | null;
  name: string;
  receiver: string | null;
  isConstructor?: boolean;
}

/**
 * Collects symbols, imports and calls extracted by each language adapter.
 * Local IDs are converted to repository-wide graph IDs in later analysis.
 */
export class Collector {
  private readonly symbols: ExtractedSymbol[] = [];
  private readonly imports: ExtractedImport[] = [];
  private readonly calls: ExtractedCall[] = [];
  private readonly deferredParents = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly source: string) {}

  private lineAt(index: number): number {
    let line = 1;
    const end = Math.max(0, Math.min(index, this.source.length));

    for (let i = 0; i < end; i++) {
      if (this.source.charCodeAt(i) === 10) line++;
    }

    return line;
  }

  private excerpt(node: SyntaxNode): string {
    const start =
      this.source.lastIndexOf("\n", Math.max(0, node.startIndex - 1)) + 1;
    const endIndex = this.source.indexOf("\n", node.startIndex);

    const line = this.source
      .slice(start, endIndex === -1 ? this.source.length : endIndex)
      .trim();

    return line.slice(0, 240);
  }

  addSymbol(node: SyntaxNode, options: SymbolOptions): string {
    const localId = `symbol-${this.nextId++}`;

    const details = { ...(options.details ?? {}) };
    const deferredParent = this.deferredParents.get(localId);

    if (deferredParent) {
      details.deferredParent = deferredParent;
    }

    this.symbols.push({
      localId,
      name: options.name,
      kind: options.kind,
      parentLocalId: options.parentLocalId,
      startLine: this.lineAt(node.startIndex),
      endLine: this.lineAt(node.endIndex),
      exported: options.exported,
      excerpt: this.excerpt(node),
      details,
    });

    return localId;
  }

  addImport(node: SyntaxNode, options: ImportOptions): void {
    this.imports.push({
      specifier: options.specifier,
      style: options.style,
      bindings: options.bindings,
      line: this.lineAt(node.startIndex),
      typeOnly: options.typeOnly ?? false,
    });
  }

  addCall(node: SyntaxNode, options: CallOptions): void {
    this.calls.push({
      callerLocalId: options.callerLocalId,
      name: options.name,
      receiver: options.receiver,
      line: this.lineAt(node.startIndex),
      isConstructor: options.isConstructor ?? false,
    });
  }

  deferParent(localId: string, typeName: string): void {
    this.deferredParents.set(localId, typeName);

    const symbol = this.symbols.find((item) => item.localId === localId);

    if (symbol) {
      symbol.details.deferredParent = typeName;
    }
  }

  finish(): AdapterOutput {
    return {
      symbols: this.symbols,
      imports: this.imports,
      calls: this.calls,
    };
  }
}