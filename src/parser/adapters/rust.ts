import type { AdapterOutput } from "@/src/types/graph";
import { Collector, COMPLEX_RECEIVER, receiverOf, type SyntaxNode } from "./shared";

interface State {
  parentId: string | null;
  callerId: string | null;
  /** Set inside `impl X { ... }`: the implemented type's name. */
  implType: string | null;
  implTrait: string | null;
  /** True inside a trait body. */
  inTrait: boolean;
}

interface UsePath {
  path: string;
  alias: string | null;
  wildcard: boolean;
}

/** `Vec<T>` -> "Vec", `&Foo` -> "Foo", `a::Foo` -> "Foo". */
function typeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case "type_identifier":
      return node.text;
    case "generic_type":
    case "reference_type":
      return typeName(node.childForFieldName("type"));
    case "scoped_type_identifier":
      return node.childForFieldName("name")?.text ?? null;
    default:
      return null;
  }
}

function join(prefix: string, segment: string): string {
  if (!prefix) return segment;
  return segment === "self" ? prefix : `${prefix}::${segment}`;
}

/** Flattens `use a::{b, c as d, e::*}` into individual paths. */
function flattenUse(node: SyntaxNode, prefix: string): UsePath[] {
  switch (node.type) {
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias");
      return path ? [{ path: join(prefix, path.text), alias: alias?.text ?? null, wildcard: false }] : [];
    }
    case "use_wildcard": {
      const inner = node.namedChildren[0];
      return [{ path: inner ? join(prefix, inner.text) : prefix, alias: null, wildcard: true }];
    }
    case "use_list":
      return node.namedChildren.flatMap((child) => flattenUse(child, prefix));
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const list = node.childForFieldName("list");
      const nextPrefix = path ? join(prefix, path.text) : prefix;
      return list ? flattenUse(list, nextPrefix) : [];
    }
    default:
      // identifier, scoped_identifier, crate, self, super
      return [{ path: join(prefix, node.text.replace(/\s+/g, "")), alias: null, wildcard: false }];
  }
}

export function extractRust(root: SyntaxNode, source: string): AdapterOutput {
  const out = new Collector(source);

  function visitChildren(node: SyntaxNode, state: State): void {
    for (const child of node.namedChildren) visit(child, state);
  }

  const isPub = (node: SyntaxNode): boolean => node.namedChildren.some((c) => c.type === "visibility_modifier");

  function calleeOf(node: SyntaxNode): { name: string; receiver: string | null } | null {
    switch (node.type) {
      case "identifier":
        return { name: node.text, receiver: null };
      case "scoped_identifier": {
        const name = node.childForFieldName("name");
        const path = node.childForFieldName("path");
        return name ? { name: name.text, receiver: receiverOf(path) ?? COMPLEX_RECEIVER } : null;
      }
      case "field_expression": {
        const field = node.childForFieldName("field");
        return field
          ? { name: field.text, receiver: receiverOf(node.childForFieldName("value")) ?? COMPLEX_RECEIVER }
          : null;
      }
      case "generic_function": {
        const inner = node.childForFieldName("function");
        return inner ? calleeOf(inner) : null;
      }
      default:
        return null;
    }
  }

  function visit(node: SyntaxNode, state: State): void {
    switch (node.type) {
      case "use_declaration": {
        const argument = node.childForFieldName("argument");
        if (!argument) return;
        for (const use of flattenUse(argument, "")) {
          const last = use.path.split("::").pop() ?? use.path;
          out.addImport(node, {
            specifier: use.wildcard ? `${use.path}::*` : use.path,
            style: "static",
            bindings: use.wildcard
              ? [{ imported: "*", local: "*" }]
              : [{ imported: last, local: use.alias ?? last }],
          });
        }
        return;
      }

      case "mod_item": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const body = node.childForFieldName("body");
        if (!body) {
          // `mod foo;` declares a child module living in foo.rs or foo/mod.rs.
          out.addImport(node, {
            specifier: nameNode.text,
            style: "mod",
            bindings: [{ imported: "*", local: nameNode.text }],
          });
          return;
        }
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: "module",
          parentLocalId: state.parentId,
          exported: isPub(node),
        });
        visitChildren(body, { ...state, parentId: id, callerId: id });
        return;
      }

      case "function_item":
      case "function_signature_item": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const isMethod = state.implType !== null || state.inTrait;
        const details: Record<string, string> = {};
        if (state.implType) details.implFor = state.implType;
        if (state.implTrait) details.trait = state.implTrait;
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: isMethod ? "method" : "function",
          parentLocalId: state.parentId,
          exported: isPub(node) || state.inTrait,
          details,
        });
        if (state.implType) out.deferParent(id, state.implType);
        visitChildren(node, { ...state, parentId: id, callerId: id, implType: null, implTrait: null, inTrait: false });
        return;
      }

      case "struct_item":
      case "enum_item":
      case "type_item": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const kind = node.type === "struct_item" ? "struct" : node.type === "enum_item" ? "enum" : "type";
        out.addSymbol(node, { name: nameNode.text, kind, parentLocalId: state.parentId, exported: isPub(node) });
        return;
      }

      case "trait_item": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) return;
        const id = out.addSymbol(node, {
          name: nameNode.text,
          kind: "trait",
          parentLocalId: state.parentId,
          exported: isPub(node),
        });
        const body = node.childForFieldName("body");
        if (body) visitChildren(body, { ...state, parentId: id, callerId: id, inTrait: true });
        return;
      }

      case "impl_item": {
        const target = typeName(node.childForFieldName("type"));
        const trait = typeName(node.childForFieldName("trait"));
        const body = node.childForFieldName("body");
        if (body) {
          visitChildren(body, { ...state, implType: target, implTrait: trait, inTrait: false });
        }
        return;
      }

      case "call_expression": {
        const callee = node.childForFieldName("function");
        const resolved = callee ? calleeOf(callee) : null;
        if (resolved) {
          out.addCall(node, { callerLocalId: state.callerId, name: resolved.name, receiver: resolved.receiver });
        }
        visitChildren(node, state);
        return;
      }

      default:
        visitChildren(node, state);
    }
  }

  visit(root, { parentId: null, callerId: null, implType: null, implTrait: null, inTrait: false });
  return out.finish();
}