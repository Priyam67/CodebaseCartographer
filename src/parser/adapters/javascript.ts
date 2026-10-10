import type { AdapterOutput, ImportBinding } from "@/src/types/graph";
import { Collector, COMPLEX_RECEIVER, receiverOf, unquote, type SyntaxNode } from "./shared";

/**
 * Handles the javascript, typescript and tsx grammars. TypeScript-only nodes
 * (interface_declaration, enum_declaration, ...) simply never occur in JS trees.
 *
 * State threaded through the walk:
 *  - parentId: symbol that structurally contains what we find
 *  - callerId: symbol that "owns" call sites (null = file level)
 *  - declLevel: true while we may still record declarations. Inside function
 *    bodies we stop recording declarations but keep recording calls.
 */
interface State {
  parentId: string | null;
  callerId: string | null;
  declLevel: boolean;
  exported: boolean;
}

const FUNCTION_VALUE_TYPES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

/** Nodes whose bodies are function scopes: declarations inside are not recorded. */
const FUNCTION_LIKE_TYPES = new Set([...FUNCTION_VALUE_TYPES, "method_definition"]);

export function extractJavaScript(root: SyntaxNode, source: string): AdapterOutput {
  const out = new Collector(source);

  function visitChildren(node: SyntaxNode, state: State): void {
    for (const child of node.namedChildren) visit(child, state);
  }

  const isAsync = (node: SyntaxNode): boolean => node.children.some((c) => c.type === "async");

  function stringArg(call: SyntaxNode): string | null {
    const args = call.childForFieldName("arguments");
    const first = args?.namedChildren[0];
    return first && first.type === "string" ? unquote(first.text) : null;
  }

  function requireBindings(call: SyntaxNode): ImportBinding[] {
    const parent = call.parent;
    if (!parent || parent.type !== "variable_declarator") return [];
    const target = parent.childForFieldName("name");
    if (!target) return [];
    if (target.type === "identifier") return [{ imported: "*", local: target.text }];
    if (target.type !== "object_pattern") return [];
    const bindings: ImportBinding[] = [];
    for (const member of target.namedChildren) {
      if (member.type === "shorthand_property_identifier_pattern") {
        bindings.push({ imported: member.text, local: member.text });
      } else if (member.type === "pair_pattern") {
        const key = member.childForFieldName("key");
        const value = member.childForFieldName("value");
        if (key && value && value.type === "identifier") {
          bindings.push({ imported: key.text, local: value.text });
        }
      }
    }
    return bindings;
  }

  function recordCallee(node: SyntaxNode, callee: SyntaxNode, state: State, isConstructor: boolean): void {
    if (callee.type === "identifier") {
      if (!isConstructor && callee.text === "require") {
        const specifier = stringArg(node);
        if (specifier !== null) {
          out.addImport(node, { specifier, style: "require", bindings: requireBindings(node) });
        }
        return;
      }
      out.addCall(node, { callerLocalId: state.callerId, name: callee.text, receiver: null, isConstructor });
      return;
    }
    if (callee.type === "import" && !isConstructor) {
      const specifier = stringArg(node);
      if (specifier !== null) out.addImport(node, { specifier, style: "dynamic", bindings: [] });
      return;
    }
    if (callee.type === "member_expression") {
      const property = callee.childForFieldName("property");
      if (!property) return;
      out.addCall(node, {
        callerLocalId: state.callerId,
        name: property.text,
        receiver: receiverOf(callee.childForFieldName("object")) ?? COMPLEX_RECEIVER,
        isConstructor,
      });
    }
    // Anything else (calls on call results, IIFEs, ...) is intentionally skipped.
  }

  function addFunctionLike(
    rangeNode: SyntaxNode,
    value: SyntaxNode,
    name: string,
    state: State,
  ): void {
    const id = out.addSymbol(rangeNode, {
      name,
      kind: "function",
      parentLocalId: state.parentId,
      exported: state.exported,
      details: isAsync(value) ? { async: "true" } : {},
    });
    visitChildren(value, { parentId: id, callerId: id, declLevel: false, exported: false });
  }

  function visitClass(node: SyntaxNode, name: string, state: State): void {
    const heritage = node.namedChildren.find((c) => c.type === "class_heritage");
    const id = out.addSymbol(node, {
      name,
      kind: "class",
      parentLocalId: state.parentId,
      exported: state.exported,
      details: heritage ? { heritage: heritage.text.slice(0, 160) } : {},
    });
    const body = node.childForFieldName("body");
    if (!body) return;
    const inner: State = { parentId: id, callerId: id, declLevel: false, exported: false };
    for (const member of body.namedChildren) {
      if (member.type === "method_definition") {
        const nameNode = member.childForFieldName("name");
        if (!nameNode) continue;
        const methodId = out.addSymbol(member, {
          name: nameNode.text,
          kind: "method",
          parentLocalId: id,
          exported: false,
          details: isAsync(member) ? { async: "true" } : {},
        });
        visitChildren(member, { parentId: methodId, callerId: methodId, declLevel: false, exported: false });
      } else if (member.type === "public_field_definition" || member.type === "field_definition") {
        const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
        const value = member.childForFieldName("value");
        if (nameNode && value && FUNCTION_VALUE_TYPES.has(value.type)) {
          const methodId = out.addSymbol(member, {
            name: nameNode.text,
            kind: "method",
            parentLocalId: id,
            exported: false,
            details: isAsync(value) ? { async: "true" } : {},
          });
          visitChildren(value, { parentId: methodId, callerId: methodId, declLevel: false, exported: false });
        } else if (value) {
          visit(value, inner);
        }
      } else if (member.type === "class_static_block") {
        visitChildren(member, inner);
      }
    }
  }

  function visit(node: SyntaxNode, state: State): void {
    switch (node.type) {
      case "import_statement": {
        const source = node.childForFieldName("source");
        if (!source) return;
        const bindings: ImportBinding[] = [];
        const clause = node.namedChildren.find((c) => c.type === "import_clause");
        for (const part of clause?.namedChildren ?? []) {
          if (part.type === "identifier") {
            bindings.push({ imported: "default", local: part.text });
          } else if (part.type === "namespace_import") {
            const id = part.namedChildren.find((c) => c.type === "identifier");
            if (id) bindings.push({ imported: "*", local: id.text });
          } else if (part.type === "named_imports") {
            for (const spec of part.namedChildren) {
              if (spec.type !== "import_specifier") continue;
              const imported = spec.childForFieldName("name");
              const alias = spec.childForFieldName("alias");
              if (imported) bindings.push({ imported: imported.text, local: (alias ?? imported).text });
            }
          }
        }
        out.addImport(node, {
          specifier: unquote(source.text),
          style: "static",
          bindings,
          typeOnly: /^import\s+type\b/.test(node.text.slice(0, 40)),
        });
        return;
      }

      case "export_statement": {
        const source = node.childForFieldName("source");
        if (source) {
          const specifiers = node.descendantsOfType("export_specifier");
          const bindings: ImportBinding[] = specifiers.flatMap((spec) => {
            const imported = spec.childForFieldName("name");
            const alias = spec.childForFieldName("alias");
            return imported ? [{ imported: imported.text, local: (alias ?? imported).text }] : [];
          });
          out.addImport(node, {
            specifier: unquote(source.text),
            style: "reexport",
            bindings: bindings.length > 0 ? bindings : [{ imported: "*", local: "*" }],
          });
          return;
        }
        const exportedState: State = { ...state, exported: true };
        const value = node.childForFieldName("value");
        if (value && state.declLevel && FUNCTION_VALUE_TYPES.has(value.type)) {
          addFunctionLike(node, value, value.childForFieldName("name")?.text ?? "default", exportedState);
          return;
        }
        if (value && state.declLevel && value.type === "class") {
          visitClass(node, value.childForFieldName("name")?.text ?? "default", exportedState);
          return;
        }
        for (const child of node.namedChildren) {
          visit(child, child === value ? { ...state, exported: false } : exportedState);
        }
        return;
      }

      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!state.declLevel || !name) {
          visitChildren(node, { ...state, exported: false });
          return;
        }
        addFunctionLike(node, node, name, state);
        return;
      }

      case "class_declaration":
      case "abstract_class_declaration":
      case "class": {
        const name = node.childForFieldName("name")?.text;
        if (!state.declLevel || !name) {
          visitChildren(node, { ...state, declLevel: false, exported: false });
          return;
        }
        visitClass(node, name, state);
        return;
      }

      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (!state.declLevel || !name) return;
        const kind =
          node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "type";
        const extendsClause = node.namedChildren.find((c) => c.type === "extends_type_clause");
        out.addSymbol(node, {
          name,
          kind,
          parentLocalId: state.parentId,
          exported: state.exported,
          details: extendsClause ? { extends: extendsClause.text.slice(0, 160) } : {},
        });
        return;
      }

      case "lexical_declaration":
      case "variable_declaration": {
        const declarators = node.namedChildren.filter((c) => c.type === "variable_declarator");
        for (const declarator of declarators) {
          const nameNode = declarator.childForFieldName("name");
          const value = declarator.childForFieldName("value");
          if (
            state.declLevel &&
            nameNode?.type === "identifier" &&
            value &&
            FUNCTION_VALUE_TYPES.has(value.type)
          ) {
            addFunctionLike(declarators.length === 1 ? node : declarator, value, nameNode.text, state);
          } else if (value) {
            visit(value, { ...state, declLevel: false, exported: false });
          }
        }
        return;
      }

      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee) recordCallee(node, callee, state, false);
        visitChildren(node, { ...state, exported: false });
        return;
      }

      case "new_expression": {
        const callee = node.childForFieldName("constructor");
        if (callee) recordCallee(node, callee, state, true);
        visitChildren(node, { ...state, exported: false });
        return;
      }

      default: {
        const next: State = FUNCTION_LIKE_TYPES.has(node.type)
          ? { ...state, declLevel: false, exported: false }
          : { ...state, exported: false };
        visitChildren(node, next);
      }
    }
  }

  visit(root, { parentId: null, callerId: null, declLevel: true, exported: false });
  return out.finish();
}