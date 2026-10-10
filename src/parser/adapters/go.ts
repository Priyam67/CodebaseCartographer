import type { AdapterOutput } from "@/src/types/graph";
import { Collector, COMPLEX_RECEIVER, receiverOf, unquote, type SyntaxNode } from "./shared";

interface State {
  callerId: string | null;
}

/**
 * Best-effort guess of the identifier a Go import binds. The real name is the
 * package clause of the imported package, which we cannot see from the import
 * alone, so this is an approximation: last path segment, skipping "v2"-style
 * major-version suffixes and ".v3" suffixes (gopkg.in/yaml.v3 -> yaml).
 */
function guessPackageName(importPath: string): string {
  const parts = importPath.split("/").filter(Boolean);
  let last = parts[parts.length - 1] ?? importPath;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2] ?? last;
  return last.replace(/\.v\d+$/, "").replace(/-/g, "_");
}

export function extractGo(root: SyntaxNode, source: string): AdapterOutput {
  const out = new Collector(source);

  function visitChildren(node: SyntaxNode, state: State): void {
    for (const child of node.namedChildren) visit(child, state);
  }

  const isExported = (name: string): boolean => /^[A-Z]/.test(name);

  function visit(node: SyntaxNode, state: State): void {
    switch (node.type) {
      case "import_declaration": {
        for (const spec of node.descendantsOfType("import_spec")) {
          const pathNode = spec.childForFieldName("path");
          if (!pathNode) continue;
          const specifier = unquote(pathNode.text);
          const alias = spec.childForFieldName("name")?.text;
          // "_" (side-effect) and "." (dot import) bind no usable qualifier.
          const local = alias === undefined ? guessPackageName(specifier) : alias === "_" || alias === "." ? null : alias;
          out.addImport(spec, {
            specifier,
            style: "static",
            bindings: local ? [{ imported: "*", local }] : [],
          });
        }
        return;
      }

      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: "function",
          parentLocalId: null,
          exported: isExported(nameNode.text),
        });
        visitChildren(node, { callerId: id });
        return;
      }

      case "method_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const receiver = node.childForFieldName("receiver");
        const param = receiver?.namedChildren.find((c) => c.type === "parameter_declaration");
        const receiverType = param?.childForFieldName("type")?.text ?? "";
        const receiverName = param?.childForFieldName("name")?.text;
        const typeName = /([A-Za-z_]\w*)/.exec(receiverType.replace(/^\*/, ""))?.[1];
        const details: Record<string, string> = {};
        if (receiverType) details.receiver = receiverType;
        if (receiverName) details.receiverName = receiverName;
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: "method",
          parentLocalId: null,
          exported: isExported(nameNode.text),
          details,
        });
        if (typeName) out.deferParent(id, typeName);
        visitChildren(node, { callerId: id });
        return;
      }

      case "type_declaration": {
        for (const spec of node.namedChildren) {
          if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
          const nameNode = spec.childForFieldName("name");
          const typeNode = spec.childForFieldName("type");
          if (!nameNode) continue;
          const kind =
            typeNode?.type === "struct_type" ? "struct" : typeNode?.type === "interface_type" ? "interface" : "type";
          out.addSymbol(spec, {
            name: nameNode.text,
            kind,
            parentLocalId: null,
            exported: isExported(nameNode.text),
          });
        }
        return;
      }

      case "call_expression": {
        const callee = node.childForFieldName("function");
        if (callee?.type === "identifier") {
          out.addCall(node, { callerLocalId: state.callerId, name: callee.text, receiver: null });
        } else if (callee?.type === "selector_expression") {
          const field = callee.childForFieldName("field");
          if (field) {
            out.addCall(node, {
              callerLocalId: state.callerId,
              name: field.text,
              receiver: receiverOf(callee.childForFieldName("operand")) ?? COMPLEX_RECEIVER,
            });
          }
        }
        visitChildren(node, state);
        return;
      }

      default:
        visitChildren(node, state);
    }
  }

  visit(root, { callerId: null });
  return out.finish();
}