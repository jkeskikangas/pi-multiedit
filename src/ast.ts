// Structural selector backed by ast-grep. Loaded on first use: the native binding and grammars
// cost nothing for sessions that never send an `ast` edit.
import { createRequire } from "node:module";
import { extname } from "node:path";
import type { Span } from "./text.ts";

const require = createRequire(import.meta.url);

type SgNode = {
  text(): string;
  range(): { start: { index: number }; end: { index: number } };
  getMatch(name: string): SgNode | null;
  getMultipleMatches(name: string): SgNode[];
};
type Napi = {
  parse(lang: string, src: string): { root(): { findAll(pattern: string): SgNode[] } };
  registerDynamicLanguage(langs: Record<string, unknown>): void;
};

const BUILTIN: Record<string, string> = {
  ts: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  tsx: "Tsx",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  html: "Html", htm: "Html",
  css: "Css",
};
// Dynamic grammars: extension -> npm package (`@ast-grep/lang-<name>`); install more to extend.
const DYNAMIC: Record<string, string> = {
  ex: "elixir", exs: "elixir",
  py: "python", pyi: "python",
  rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", json: "json", lua: "lua", scala: "scala",
  heex: "html",
};

let napi: Napi | undefined;
let registered: Set<string> | undefined;

function load(): Napi {
  napi ??= require("@ast-grep/napi") as Napi;
  return napi;
}

/** Only the first registerDynamicLanguage call takes effect, so every installed grammar goes in it. */
function dynamicLanguages(): Set<string> {
  if (registered) return registered;
  const langs: Record<string, unknown> = {};
  for (const name of new Set(Object.values(DYNAMIC))) {
    try {
      const mod = require(`@ast-grep/lang-${name}`) as { default?: unknown };
      langs[name] = mod.default ?? mod;
    } catch {
      // Not installed: that language is unavailable.
    }
  }
  if (Object.keys(langs).length) load().registerDynamicLanguage(langs);
  registered = new Set(Object.keys(langs));
  return registered;
}

export function resolveLang(path: string): string {
  const key = extname(path).slice(1).toLowerCase();
  const builtin = BUILTIN[key] ?? Object.values(BUILTIN).find((v) => v.toLowerCase() === key);
  if (builtin) return builtin;
  const name = DYNAMIC[key] ?? key;
  if (name === "html") return "Html";
  if (!dynamicLanguages().has(name)) {
    throw new Error(`no ast-grep grammar for "${key}" (${path}); install @ast-grep/lang-${name} next to pi-multiedit`);
  }
  return name;
}

type TreeNode = {
  kind(): string;
  isLeaf(): boolean;
  children(): TreeNode[];
  range(): { start: { line: number; index: number }; end: { index: number } };
};

/**
 * 1-based lines of tree-sitter ERROR nodes and MISSING tokens (zero-width leaves the parser
 * inserted to recover, e.g. an unclosed paren), or undefined when no grammar is available.
 */
export function syntaxErrorLines(path: string, text: string): number[] | undefined {
  let grammar: string;
  try {
    grammar = resolveLang(path);
  } catch {
    return undefined;
  }
  const lines = new Set<number>();
  const stack = [load().parse(grammar, text).root() as unknown as TreeNode];
  while (stack.length) {
    const node = stack.pop()!;
    const { start, end } = node.range();
    if (node.kind() === "ERROR" || (node.isLeaf() && start.index === end.index && node.kind() !== "")) {
      lines.add(start.line + 1);
      continue;
    }
    stack.push(...node.children());
  }
  return [...lines].sort((a, b) => a - b);
}

const META = /\$\$\$([A-Z_][A-Z0-9_]*)|\$([A-Z_][A-Z0-9_]*)/g;

/** Matches of `pattern`, outermost only, each with `template` expanded from its metavariables. */
export function astFind(path: string, text: string, pattern: string, template: string): Span[] {
  const grammar = resolveLang(path);
  const root = load().parse(grammar, text).root();
  const spans: Span[] = [];
  for (const node of root.findAll(pattern)) {
    const { start, end } = node.range();
    if (spans.some((s) => start.index >= s.start && end.index <= s.end)) continue;
    spans.push({ start: start.index, end: end.index, replacement: expand(node, text, template, start.index) });
  }
  return spans.sort((a, b) => a.start - b.start);
}

function expand(node: SgNode, text: string, template: string, at: number): string {
  const filled = template.replace(META, (whole, multi: string | undefined, single: string | undefined) => {
    if (multi) {
      const nodes = node.getMultipleMatches(multi);
      if (nodes.length === 0) return "";
      return text.slice(nodes[0].range().start.index, nodes[nodes.length - 1].range().end.index);
    }
    const one = node.getMatch(single!);
    return one ? one.text() : whole;
  });
  // ast-grep convention: continuation lines of a multi-line rewrite are relative to the match.
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, at))![0];
  return filled.split("\n").map((l, i) => (i === 0 || l === "" ? l : indent + l)).join("\n");
}
