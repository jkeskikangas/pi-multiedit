// Tree-sitter parsing via ast-grep for the syntax check. Loaded on first use, so the native binding
// and grammars cost nothing until an edited file needs checking.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Python ships with the package: the prebuilt tree-sitter parsers of @ast-grep/lang-python 0.0.6
// (vendor/lang-python, MIT). Depending on that package instead would run its postinstall, which npm
// 11.21+ blocks and warns about; on every platform it has a prebuild for, that script does nothing.
// An installed @ast-grep/lang-python still takes precedence.
const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const ARCH: Record<string, string> = { x64: "X64", arm64: "ARM64" };

export function vendoredPython(platform: string = process.platform, arch: string = process.arch): unknown | undefined {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (!os || !cpu) return undefined;
  const libraryPath = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "lang-python", "prebuilds", `prebuild-${os}-${cpu}`, "parser.so");
  if (!existsSync(libraryPath)) return undefined;
  return { libraryPath, extensions: ["py"], languageSymbol: "tree_sitter_python", expandoChar: "µ" };
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
      // Not installed: that language is unavailable, except the vendored Python grammar.
      if (name === "python") {
        const vendored = vendoredPython();
        if (vendored) langs[name] = vendored;
      }
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
