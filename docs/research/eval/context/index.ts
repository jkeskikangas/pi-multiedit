// H1 prototype: `context` — one call returns a symbol's neighbourhood, anchored for edit:
// definition block, references (±3 lines, grouped by file), test blocks mentioning it, and one hop of
// the test helpers those blocks call. Language-agnostic block heuristic (indentation return).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAnchored } from "../../../../src/hash.ts";

const run = promisify(execFile);
const BUDGET = Number(process.env.PI_CONTEXT_BUDGET ?? 30000); // chars (~8k tokens)
const LOG = process.env.PI_CONTEXT_LOG;

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|_test\.exs?$/;
const HELPER_PATH = /(^|\/)(test\/support|tests?\/helpers?|__tests__\/(utils|helpers)|spec\/support|fixtures?)(\/|$)|helpers?\.(ex|exs|ts|js|py)$/;
const DEF_RE = (s: string) =>
  new RegExp(
    `^\\s*(export\\s+)?(async\\s+)?(def|defp|defmodule|defmacro|defstruct|function|class|interface|type|enum|const|let|var|module|describe)\\b[^\\n]*\\b${esc(s)}\\b|^\\s*(export\\s+)?(const|let|var)\\s+${esc(s)}\\b|^\\s*${esc(s)}\\s*[:=]\\s*(async\\s*)?(\\(|function|=>)`,
  );
const TEST_BLOCK_RE = /^\s*(test|it|describe|context|scenario)\s*[("']|^\s*(async\s+)?def test_|^\s*@tag\b/;
function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function indent(l: string) {
  return l.length - l.trimStart().length;
}
/** Block from `start` (0-based) to the line where indentation returns to <= start's, inclusive of that closer. */
function blockEnd(lines: string[], start: number, max = 120): number {
  const base = indent(lines[start]);
  let last = start;
  for (let i = start + 1; i < lines.length && i - start < max; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indent(l) <= base) {
      // closer (`end`, `}`, `)`) on the same indent belongs to the block; a new sibling does not
      return /^\s*(end\b|[}\])]|<\/)/.test(l) ? i : last;
    }
    last = i;
  }
  return last;
}
function testBlockStart(lines: string[], hit: number): number {
  for (let i = hit; i >= 0 && hit - i < 80; i--) if (TEST_BLOCK_RE.test(lines[i])) return i;
  return Math.max(0, hit - 3);
}

type Hit = { file: string; line: number; text: string };
async function rg(cwd: string, pattern: string, extra: string[] = []): Promise<Hit[]> {
  try {
    const { stdout } = await run(
      "rg",
      ["-n", "--no-heading", "-w", "-e", pattern, "--glob", "!node_modules", "--glob", "!deps", "--glob", "!_build", "--glob", "!*.lock", "--glob", "!dist", "--max-count", "40", ...extra, "."],
      { cwd, maxBuffer: 64 << 20 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const m = /^\.\/(.*?):(\d+):(.*)$/.exec(l);
        return m ? { file: m[1], line: Number(m[2]), text: m[3] } : null;
      })
      .filter((h): h is Hit => !!h);
  } catch {
    return [];
  }
}

const cache = new Map<string, string[]>();
async function lines(cwd: string, file: string): Promise<string[]> {
  let v = cache.get(file);
  if (!v) {
    v = (await readFile(resolve(cwd, file), "utf8")).split("\n");
    cache.set(file, v);
  }
  return v;
}
function slice(ls: string[], a: number, b: number): string {
  return formatAnchored(ls.slice(a, b + 1), a + 1);
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "context",
    label: "context",
    description: `Call this FIRST, before any bash search or read: one call returns what the usual rg → cat → rg tests → sed -n chain would, anchored (N#HH) so edit can use from/to directly.
symbols: exact identifiers from the task (modules, functions, fields, constants). For each: the defining file in full when it is under 400 lines (else the definition block), references grouped by file (±3 lines), the test blocks that mention it, and the test helpers those blocks call.
terms: behaviour words or phrases the task implies but does not name (e.g. "revoke", "read policy", a user-visible string): every matching line, grouped by file.
Put every identifier and term from the task in one call; search with bash only for what is missing afterwards.`,
    promptSnippet: "context: definition + references + tests + helpers for identifiers, in one call",
    promptGuidelines: [
      "Begin with one context call naming every identifier the task mentions; search or read with bash only for what context did not return.",
    ],
    parameters: Type.Object(
      { symbols: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }), terms: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })), path: Type.Optional(Type.String({ description: "limit to this directory" })) },
      { additionalProperties: false },
    ),
    async execute(_id, params: { symbols: string[]; terms?: string[]; path?: string }, _signal, _update, ctx) {
      cache.clear();
      const cwd = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
      const out: string[] = [];
      const shownWhole = new Set<string>();
      let used = 0;
      const push = (s: string) => {
        if (used + s.length > BUDGET) {
          out.push(`… (budget reached; ${s.length} chars omitted — read the file for the rest)`);
          used = BUDGET + 1;
          return false;
        }
        out.push(s);
        used += s.length;
        return true;
      };
      for (const sym of params.symbols) {
        const hits = await rg(cwd, sym);
        if (!hits.length) {
          push(`## ${sym}: no matches`);
          continue;
        }
        const byFile = new Map<string, Hit[]>();
        for (const h of hits) (byFile.get(h.file) ?? byFile.set(h.file, []).get(h.file)!).push(h);
        push(`## ${sym}: ${hits.length} matches in ${byFile.size} files`);
        // definition(s): the whole file when it is small (models read it anyway), else the enclosing block
        const defs = hits.filter((h) => DEF_RE(sym).test(h.text) && !TEST_PATH.test(h.file)).slice(0, 2);
        for (const d of defs) {
          const ls = await lines(cwd, d.file);
          if (ls.length <= 400 && !shownWhole.has(d.file)) {
            shownWhole.add(d.file);
            push(`### file ${d.file} (whole, ${ls.length} lines)\n${slice(ls, 0, ls.length - 1)}`);
          } else {
            const end = blockEnd(ls, d.line - 1);
            push(`### definition ${d.file}\n${slice(ls, d.line - 1, end)}`);
          }
        }
        // references in non-test files
        const refFiles = [...byFile.entries()].filter(([f]) => !TEST_PATH.test(f)).slice(0, 12);
        for (const [f, hs] of refFiles) {
          const ls = await lines(cwd, f);
          const chunks: string[] = [];
          let lastEnd = -1;
          for (const h of hs.filter((h) => !defs.some((d) => d.file === h.file && d.line === h.line)).slice(0, 5)) {
            const a = Math.max(0, h.line - 4), b = Math.min(ls.length - 1, h.line + 2);
            if (a <= lastEnd) continue;
            chunks.push(slice(ls, a, b));
            lastEnd = b;
          }
          if (chunks.length) push(`### references ${f} (${hs.length})\n${chunks.join("\n…\n")}`);
        }
        // test blocks + helper hop
        const helperNames = new Set<string>();
        const testFiles = [...byFile.entries()].filter(([f]) => TEST_PATH.test(f)).slice(0, 6);
        for (const [f, hs] of testFiles) {
          const ls = await lines(cwd, f);
          const blocks: string[] = [];
          let lastEnd = -1;
          for (const h of hs.slice(0, 6)) {
            const s = testBlockStart(ls, h.line - 1);
            if (s <= lastEnd) continue;
            const e = blockEnd(ls, s);
            blocks.push(slice(ls, s, e));
            lastEnd = e;
            for (const m of ls.slice(s, e + 1).join("\n").matchAll(/\b([a-z_][a-z0-9_]{3,})\(/g)) helperNames.add(m[1]);
            if (blocks.length >= 3) break;
          }
          if (blocks.length) push(`### tests ${f} (${hs.length} matches)\n${blocks.join("\n…\n")}`);
        }
        if (helperNames.size) {
          const names = [...helperNames].filter((n) => !["assert", "refute", "expect", "describe", "setup", "test", "context", "import", "alias", "require"].includes(n)).slice(0, 25);
          const pattern = `^\\s*(export\\s+)?(def|defp|function|const|async function)\\s+(${names.map(esc).join("|")})\\b`;
          const helperHits = (await rg(cwd, pattern, [])).filter((h) => HELPER_PATH.test(h.file) || TEST_PATH.test(h.file));
          const seen = new Set<string>();
          for (const h of helperHits.slice(0, 6)) {
            const key = `${h.file}:${h.line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const ls = await lines(cwd, h.file);
            const end = Math.min(blockEnd(ls, h.line - 1), h.line - 1 + 40);
            if (!push(`### helper ${h.file}\n${slice(ls, h.line - 1, end)}`)) break;
          }
        }
        if (used > BUDGET) break;
      }
      // free-text terms: behaviour words from the task (e.g. "revoke", "read policy"), case-insensitive, lines grouped by file
      for (const term of params.terms ?? []) {
        if (used > BUDGET) break;
        const hits = (await rg(cwd, term, ["-i", "--fixed-strings"])).filter((h) => !shownWhole.has(h.file));
        const byFile = new Map<string, Hit[]>();
        for (const h of hits) (byFile.get(h.file) ?? byFile.set(h.file, []).get(h.file)!).push(h);
        const body = [...byFile.entries()].slice(0, 15).map(([f, hs]) => `${f}\n${hs.slice(0, 4).map((h) => `  ${h.line}: ${h.text.trim().slice(0, 140)}`).join("\n")}`).join("\n");
        push(`## "${term}": ${hits.length} lines in ${byFile.size} files\n${body || "(none)"}`);
      }
      const text = out.join("\n\n");
      if (LOG) process.stderr.write(`[context] ${params.symbols.join(",")} -> ${text.length} chars\n`);
      return { content: [{ type: "text" as const, text }] };
    },
  });
}
