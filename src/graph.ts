// A lazy code graph: definitions and references from tree-sitter, computed on demand. ripgrep
// shortlists the files that mention a name; parsing them keeps only real identifier uses (never
// comments or strings). Nothing is indexed, so nothing goes stale.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseRoot, type TreeNode } from "./ast.ts";
import { splitLines } from "./text.ts";

const run = promisify(execFile);

export type Definition = { name: string; line: number; signature: string };
export type Site = { path: string; line: number; text: string };
export type Blast = { name: string; change: "signature" | "removed"; was: string; now?: string; sites: Site[]; truncated: number };

const DECLARATIONS = new Set([
  "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration", "method_definition", "method_signature",
  "abstract_method_signature", "function_definition", "class_definition",
]);
const ELIXIR_DEFINITIONS = new Set(["defmodule", "def", "defp", "defmacro", "defmacrop", "defguard", "defdelegate", "defprotocol", "defimpl"]);
const lineOf = (n: TreeNode) => n.range().start.line + 1;

/** The name an Elixir definition call defines: `def name(...)`, `def name(...) when ...`, `defmodule A.B`. */
function elixirName(call: TreeNode): string | undefined {
  const args = call.children().find((c) => c.kind() === "arguments");
  let head = args?.children()[0];
  if (head?.kind() === "binary_operator") head = head.children()[0]; // a guard: `name(x) when ...`
  if (!head) return undefined;
  if (head.kind() === "call") return head.children()[0]?.text();
  return head.text();
}

/** Top-level and member definitions with their first line as the signature; undefined without a grammar. */
export function definitionsOf(path: string, text: string): Definition[] | undefined {
  const root = parseRoot(path, text);
  if (!root) return undefined;
  const lines = splitLines(text);
  const out: Definition[] = [];
  const add = (name: string | undefined, line: number) => {
    if (name) out.push({ name, line, signature: (lines[line - 1] ?? "").trim() });
  };
  const visit = (node: TreeNode, parent?: TreeNode) => {
    const kind = node.kind();
    if (DECLARATIONS.has(kind)) add(node.field("name")?.text(), lineOf(node));
    else if (kind === "variable_declarator" && parent?.kind() === "lexical_declaration") {
      // Module-level `const f = …` only; locals inside functions are not part of anyone's contract.
      const holder = parent;
      add(node.field("name")?.text(), lineOf(holder));
    } else if (kind === "call") {
      const fn = node.children()[0]?.text();
      if (fn && ELIXIR_DEFINITIONS.has(fn)) add(elixirName(node), lineOf(node));
    }
    // Function bodies hold locals, not definitions others depend on.
    if (/^(statement_block|arrow_function|function_expression)$/.test(kind) && parent && DECLARATIONS.has(parent.kind()) && parent.kind() !== "class_declaration") return;
    for (const c of node.children()) visit(c, node);
  };
  visit(root);
  return out;
}

/** 1-based lines where `name` is used as an identifier (calls, imports, types, member access). */
export function referenceLines(path: string, text: string, name: string): number[] | undefined {
  const root = parseRoot(path, text);
  if (!root) return undefined;
  const lines = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.isLeaf()) {
      const kind = node.kind();
      if ((kind.endsWith("identifier") || kind === "alias") && node.text() === name) lines.add(lineOf(node));
      continue;
    }
    stack.push(...node.children());
  }
  return [...lines].sort((a, b) => a - b);
}

async function filesMentioning(cwd: string, name: string): Promise<string[]> {
  try {
    // An explicit "." matters: without a path and with stdin not a terminal, rg searches stdin.
    const { stdout } = await run("rg", ["-l", "-w", "-F", "--", name, "."], { cwd, maxBuffer: 64 << 20 });
    return stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  } catch (e) {
    if ((e as { code?: number }).code === 1) return [];
    throw e;
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * For definitions an edit renamed, removed or re-signed: their remaining uses, read from the
 * post-edit state (`after` for the changed files, `read` for the rest).
 */
export async function blastRadius(
  cwd: string,
  changes: { path: string; before: string | null; after: string | null }[],
  read: (path: string) => Promise<string | null>,
  opts: { maxSites?: number } = {},
): Promise<Blast[]> {
  const maxSites = opts.maxSites ?? 12;
  const after = new Map(changes.map((c) => [c.path, c.after]));
  const blasts: Blast[] = [];
  for (const c of changes) {
    if (c.before === null) continue;
    const was = definitionsOf(c.path, c.before);
    if (!was) continue;
    const now = c.after === null ? [] : (definitionsOf(c.path, c.after) ?? []);
    const nowByName = new Map(now.map((d) => [d.name, d]));
    for (const d of was) {
      if (d.name.length < 3) continue;
      const n = nowByName.get(d.name);
      if (n && squash(n.signature) === squash(d.signature)) continue;
      const change = n ? "signature" : "removed";
      const sites: Site[] = [];
      let total = 0;
      for (const file of [...new Set([...(await filesMentioning(cwd, d.name)), ...after.keys()])].sort()) {
        const text = after.has(file) ? after.get(file)! : await read(file);
        if (text === null) continue;
        const refs = referenceLines(file, text, d.name);
        if (!refs) continue;
        const lines = splitLines(text);
        for (const line of refs) {
          if (file === c.path && n && line === n.line) continue; // the definition itself
          total++;
          if (sites.length < maxSites) sites.push({ path: file, line, text: lines[line - 1] ?? "" });
        }
      }
      if (total > 0) blasts.push({ name: d.name, change, was: d.signature, now: n?.signature, sites, truncated: total - sites.length });
    }
  }
  return blasts;
}
