// Tree-sitter parsing via ast-grep for the syntax check. Loaded on first use, so the native binding
// and grammars cost nothing until an edited file needs checking.
import { createRequire } from "node:module";
import { extname } from "node:path";

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
    throw new Error(
      `no ast-grep grammar for "${key}" (${path}): install the npm package @ast-grep/lang-${name} where pi-multiedit is installed (for pi install npm:pi-multiedit: npm i @ast-grep/lang-${name} --prefix ~/.pi/agent/npm)`,
    );
  }
  return name;
}

export type TreeNode = {
  kind(): string;
  field(name: string): TreeNode | null;
  text(): string;
  isLeaf(): boolean;
  children(): TreeNode[];
  range(): { start: { line: number; index: number }; end: { index: number } };
};

/** The parse tree of `text`, or undefined when no grammar is available for the file's extension. */
export function parseRoot(path: string, text: string): TreeNode | undefined {
  let grammar: string;
  try {
    grammar = resolveLang(path);
  } catch {
    return undefined;
  }
  return load().parse(grammar, text).root() as unknown as TreeNode;
}

/**
 * 1-based lines of tree-sitter ERROR nodes and MISSING tokens (zero-width leaves the parser
 * inserted to recover, e.g. an unclosed paren), or undefined when no grammar is available.
 */
export function syntaxErrorLines(path: string, text: string): number[] | undefined {
  const root = parseRoot(path, text);
  if (!root) return undefined;
  const lines = new Set<number>();
  const stack = [root];
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
