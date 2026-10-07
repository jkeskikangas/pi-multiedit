// From a task description to the files it is about: identifier variants of the description's
// words, ripgrep for where they occur, declarations (tree-sitter outline) to tell where a name is
// defined from where it is merely used, and one hop of cross-references for the fan-out.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { outlineLines } from "./outline.ts";
import { splitLines } from "./text.ts";

const run = promisify(execFile);

export type Located = {
  path: string;
  score: number;
  /** Terms found in this file, rarest first. */
  terms: string[];
  /** 1-based lines of declarations whose name contains a term. */
  declarations: number[];
  /** True when the file was added only because it references a top file's declarations. */
  reference: boolean;
};

const STOP = new Set(
  ("the a an and or but if then else for to of in on at by with from into onto over under about as is are was were be been being " +
    "this that these those it its we you they he she them our your their there here what which who whom when where why how " +
    "all any each every some no not only also just very more most less least so than too can could should would will shall may might must " +
    "do does did done doing have has had having make makes made use uses used using get gets got set sets add adds added new old " +
    "file files code change changes changed update updates updated fix fixes fixed please need needs want wants like see make sure " +
    "read follow run task item brief protocol skill invoke first then before after into via per one two three").split(" "),
);

// Prose and generated files repeat a task's words far more than the code that implements it.
const PROSE = /(^|\/)(CHANGELOG|HISTORY|NEWS|LICENSE)[^/]*$|\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\/|(^|\/)dist\/|\.lock$|-lock\.json$|\.generated\.|\.snap$|\.min\.js$/i;
const ABOUT_PROSE = /\b(docs?|documentation|readme|changelog|guide|markdown|wording|copy)\b/i;

/** Ranking weight of a file for an intent: prose counts a quarter unless the task is about prose. */
export function fileWeight(path: string, intent: string): number {
  return PROSE.test(path) && !ABOUT_PROSE.test(intent) ? 0.25 : 1;
}

const words = (text: string) => text.match(/[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*/g) ?? [];

/** Lowercase word parts of an identifier: `contextLines` → context, lines; `CONTEXT_LINES` → context, lines. */
function parts(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

function variants(ws: string[]): string[] {
  const [first, ...rest] = ws;
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  return [first + rest.map(cap).join(""), ws.map(cap).join(""), ws.join("_"), ws.join("-"), ws.join("_").toUpperCase()];
}

/** Search terms for a task description: code-like tokens as written, words, and identifier forms of adjacent word pairs. */
export function termsOf(intent: string, max = 40): string[] {
  const out = new Set<string>();
  const plain: string[] = [];
  for (const token of words(intent)) {
    const ps = parts(token);
    const codeLike = ps.length > 1 || /[_.]/.test(token) || /\d/.test(token);
    if (codeLike && token.length >= 4) out.add(token);
    for (const p of ps) if (p.length >= 3 && !STOP.has(p)) plain.push(p);
  }
  for (let i = 0; i + 1 < plain.length; i++) if (plain[i] !== plain[i + 1]) for (const v of variants([plain[i], plain[i + 1]])) out.add(v);
  for (const w of plain) {
    if (w.length < 4) continue;
    out.add(w);
    // A crude singular, so "scopes" in a task also finds `scope` in code.
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) out.add(w.endsWith("ies") ? w.slice(0, -3) + "y" : w.slice(0, -1));
  }
  return [...out].slice(0, max);
}

async function rgCounts(cwd: string, term: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const caseless = term === term.toLowerCase();
    // An explicit "." matters: without a path and with stdin not a terminal, rg searches stdin.
    const { stdout } = await run("rg", ["--count-matches", "--fixed-strings", ...(caseless ? ["--ignore-case"] : []), "--max-filesize", "1M", "--", term, "."], {
      cwd,
      maxBuffer: 64 << 20,
    });
    for (const line of stdout.split("\n")) {
      const i = line.lastIndexOf(":");
      if (i > 0) counts.set(line.slice(0, i).replace(/^\.\//, ""), Number(line.slice(i + 1)));
    }
  } catch (e) {
    if ((e as { code?: number }).code !== 1) throw e; // 1 = no matches
  }
  return counts;
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const DECLARED = /(?:function|class|interface|type|enum|const|let|var|def|defp|defmodule|defmacro|module|struct|fn)\s+([A-Za-z_][\w.!?]*)/g;

export async function locate(cwd: string, intent: string, opts: { top?: number; files?: string[] } = {}): Promise<Located[]> {
  const top = opts.top ?? 10;
  const terms = termsOf(intent);
  if (terms.length === 0) return [];
  const all = opts.files ?? (await run("rg", ["--files", "."], { cwd, maxBuffer: 64 << 20 })).stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  const scope = new Set(all);
  const total = Math.max(all.length, 1);
  const hits = (await inBatches(terms, 8, (t) => rgCounts(cwd, t))).map((h) => new Map([...h].filter(([f]) => scope.has(f))));

  // Rarer terms weigh more; a term that hits a third of the repository says little.
  const idf = hits.map((h) => Math.log(1 + total / (1 + h.size)));
  const score = new Map<string, number>();
  const found = new Map<string, Set<number>>();
  hits.forEach((h, ti) => {
    for (const [file, n] of h) {
      score.set(file, (score.get(file) ?? 0) + idf[ti] * (1 + Math.log(n)));
      (found.get(file) ?? found.set(file, new Set()).get(file)!).add(ti);
    }
  });
  terms.forEach((t, ti) => {
    const lower = t.toLowerCase();
    for (const file of all) if (file.toLowerCase().includes(lower)) score.set(file, (score.get(file) ?? 0) + 2 * idf[ti]);
  });
  // Code that matches several distinct terms is about the task, not about one common word. Prose
  // naturally contains many of a task's words, so it gets no such bonus, only its lower weight.
  for (const [file, s] of score) {
    const w = fileWeight(file, intent);
    score.set(file, s * (w < 1 ? w : 1 + 0.5 * ((found.get(file)?.size ?? 1) - 1)));
  }

  const candidates = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(40, top * 3));
  const ranked: Located[] = [];
  for (const [path, s] of candidates) {
    let text: string;
    try {
      text = await readFile(join(cwd, path), "utf8");
    } catch {
      continue;
    }
    const lines = splitLines(text);
    // Declarations are evidence of where code is defined; prose headings are not.
    const decl = fileWeight(path, intent) < 1 ? [] : (outlineLines(path, text) ?? []).filter((n) => terms.some((t) => lines[n - 1]?.toLowerCase().includes(t.toLowerCase())));
    const ts = [...(found.get(path) ?? [])].sort((a, b) => idf[b] - idf[a]).map((i) => terms[i]);
    ranked.push({ path, score: s * (1 + Math.min(decl.length, 3)), terms: ts, declarations: decl, reference: false });
  }
  ranked.sort((a, b) => b.score - a.score);

  // One hop of fan-out: files that use what the best files declare.
  const names = new Set<string>();
  for (const r of ranked.slice(0, 3)) {
    const text = await readFile(join(cwd, r.path), "utf8").catch(() => "");
    const lines = splitLines(text);
    for (const n of r.declarations) for (const m of (lines[n - 1] ?? "").matchAll(DECLARED)) if (m[1].length >= 5) names.add(m[1]);
  }
  const have = new Set(ranked.map((r) => r.path));
  const refs = await inBatches([...names].slice(0, 12), 8, async (name) => [...(await rgCounts(cwd, name)).keys()].filter((f) => scope.has(f)));
  const best = ranked[0]?.score ?? 1;
  for (const file of new Set(refs.flat())) {
    if (have.has(file)) continue;
    ranked.push({ path: file, score: best * 0.05, terms: [], declarations: [], reference: true });
  }
  return ranked.sort((a, b) => b.score - a.score);
}
