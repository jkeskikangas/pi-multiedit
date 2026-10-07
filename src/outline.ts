// The structure of a file, as the 1-based lines that start its declarations or headings, so an
// agent can find the function it needs without reading the whole file.
import { extname } from "node:path";
import { parseRoot, type TreeNode } from "./ast.ts";

// Nodes that are declarations, and containers whose children are worth listing (bodies of
// classes, modules and exports, never function bodies).
const DECLARATION = new Set([
  // TypeScript / JavaScript
  "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration", "lexical_declaration", "variable_declaration",
  "internal_module", "module", "method_definition", "public_field_definition", "method_signature",
  "abstract_method_signature",
  // Python
  "function_definition", "class_definition",
]);
const CONTAINER = new Set([
  "program", "export_statement", "class_declaration", "abstract_class_declaration", "class_body", "class",
  "internal_module", "statement_block", "module", "class_definition", "block", "decorated_definition",
]);
const ELIXIR_CONTAINERS = new Set(["defmodule", "defprotocol", "defimpl"]);
const ELIXIR_DEFINITIONS = new Set(["def", "defp", "defmacro", "defmacrop", "defguard", "defdelegate", "defstruct", "defexception", "defimpl", "defprotocol", "defmodule"]);

/** Declaration lines, or undefined when the file type has no outline. */
export function outlineLines(path: string, text: string): number[] | undefined {
  return outlineBlocks(path, text)?.map((b) => b.line);
}

export type Block = { line: number; end: number };

/** Declarations (or Markdown sections) with the 1-based lines they span, sorted by start line. */
export function outlineBlocks(path: string, text: string): Block[] | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown") {
    const heads = markdownHeadings(text);
    const total = text.split("\n").length;
    return heads.map((line, i) => ({ line, end: (heads[i + 1] ?? total + 1) - 1 }));
  }
  const root = parseRoot(path, text);
  if (!root) return undefined;
  const blocks = new Map<number, number>();
  const lines = { add: (line: number, node: TreeNode) => blocks.set(line, Math.max(blocks.get(line) ?? 0, node.range().end.line + 1)) };
  const visit = (node: TreeNode, depth: number) => {
    for (const child of node.children()) {
      const kind = child.kind();
      const line = child.range().start.line + 1;
      if (kind === "call") {
        // Elixir: `defmodule …`, `def …` and friends are calls named by their first identifier.
        const name = child.children()[0]?.text();
        if (name && ELIXIR_DEFINITIONS.has(name)) {
          lines.add(line, child);
          if (ELIXIR_CONTAINERS.has(name)) for (const c of child.children()) if (c.kind() === "do_block") visit(c, depth + 1);
        }
        continue;
      }
      if (kind === "export_statement" || DECLARATION.has(kind)) lines.add(line, child);
      // Function bodies are skipped: in Python a "block" is a body only below a class.
      const intoBlock = kind !== "block" || node.kind() === "class_definition";
      if (CONTAINER.has(kind) && intoBlock && depth < 4 && !(kind === "statement_block" && node.kind() !== "internal_module")) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return [...blocks].map(([line, end]) => ({ line, end })).sort((a, b) => a.line - b.line);
}

function markdownHeadings(text: string): number[] {
  const out: number[] = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{1,6}\s/.test(line)) out.push(i + 1);
  });
  return out;
}
