import type { AdapterOutput, ImportBinding } from "@/src/types/graph";
import { Collector, COMPLEX_RECEIVER, receiverOf, type SyntaxNode } from "./shared";

interface State {
  parentId: string | null;
  callerId: string | null;
  declLevel: boolean;
  inClass: boolean;
}

/** Python has no export keyword; a leading underscore conventionally means "private". */
function isPublicName(name: string): boolean {
  return !name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"));
}

export function extractPython(root: SyntaxNode, source: string): AdapterOutput {
  const out = new Collector(source);

  function visitChildren(node: SyntaxNode, state: State): void {
    for (const child of node.namedChildren) visit(child, state);
  }

  function visit(node: SyntaxNode, state: State): void {
    switch (node.type) {
      case "import_statement": {
        for (const child of node.namedChildren) {
          if (child.type === "dotted_name") {
            out.addImport(node, {
              specifier: child.text,
              style: "static",
              bindings: [{ imported: "*", local: child.text.split(".")[0] ?? child.text }],
            });
          } else if (child.type === "aliased_import") {
            const name = child.childForFieldName("name");
            const alias = child.childForFieldName("alias");
            if (!name) continue;
            out.addImport(node, {
              specifier: name.text,
              style: "static",
              bindings: [{ imported: "*", local: alias?.text ?? name.text.split(".")[0] ?? name.text }],
            });
          }
        }
        return;
      }

      case "import_from_statement": {
        const moduleNode = node.childForFieldName("module_name");
        if (!moduleNode) return;
        const bindings: ImportBinding[] = [];
        for (const child of node.namedChildren) {
          if (child.id === moduleNode.id) continue;
          if (child.type === "dotted_name") {
            bindings.push({ imported: child.text, local: child.text });
          } else if (child.type === "aliased_import") {
            const name = child.childForFieldName("name");
            const alias = child.childForFieldName("alias");
            if (name) bindings.push({ imported: name.text, local: alias?.text ?? name.text });
          } else if (child.type === "wildcard_import") {
            bindings.push({ imported: "*", local: "*" });
          }
        }
        // Specifier keeps leading dots for relative imports: ".", "..pkg", ".models".
        out.addImport(node, { specifier: moduleNode.text, style: "static", bindings });
        return;
      }

      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        if (!state.declLevel || !nameNode) {
          visitChildren(node, { ...state, declLevel: false });
          return;
        }
        const isAsync = node.children.some((c) => c.type === "async");
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: state.inClass ? "method" : "function",
          parentLocalId: state.parentId,
          exported: isPublicName(nameNode.text),
          details: isAsync ? { async: "true" } : {},
        });
        visitChildren(node, { parentId: id, callerId: id, declLevel: false, inClass: false });
        return;
      }

      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        if (!state.declLevel || !nameNode) {
          visitChildren(node, { ...state, declLevel: false });
          return;
        }
        const bases = node.childForFieldName("superclasses");
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: "class",
          parentLocalId: state.parentId,
          exported: isPublicName(nameNode.text),
          details: bases ? { bases: bases.text.slice(0, 160) } : {},
        });
        const body = node.childForFieldName("body");
        if (body) {
          visitChildren(body, { parentId: id, callerId: id, declLevel: true, inClass: true });
        }
        return;
      }

      case "call": {
        const callee = node.childForFieldName("function");
        if (callee?.type === "identifier") {
          out.addCall(node, { callerLocalId: state.callerId, name: callee.text, receiver: null });
        } else if (callee?.type === "attribute") {
          const attribute = callee.childForFieldName("attribute");
          if (attribute) {
            out.addCall(node, {
              callerLocalId: state.callerId,
              name: attribute.text,
              receiver: receiverOf(callee.childForFieldName("object")) ?? COMPLEX_RECEIVER,
            });
          }
        }
        visitChildren(node, state);
        return;
      }

      case "lambda": {
        visitChildren(node, { ...state, declLevel: false });
        return;
      }

      default:
        // decorated_definition, if/try/with blocks etc. pass the state through so
        // conditionally defined functions at module level are still found.
        visitChildren(node, state);
    }
  }

  visit(root, { parentId: null, callerId: null, declLevel: true, inClass: false });
  return out.finish();
}