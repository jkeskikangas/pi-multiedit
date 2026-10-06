// Text matching: exact occurrences, a line-wise fuzzy ladder for when the model's recall of
// whitespace or punctuation is off, and nearest-candidate hints when nothing matches.
import { formatAnchored } from "./hash.ts";

export type Span = { start: number; end: number; replacement?: string };
export type Fuzz = "exact" | "loose" | "reindent";

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/** Offset of the first character of each line, plus one past the end. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  if (text.endsWith("\n")) starts.pop();
  return starts;
}

export function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

const PUNCT: [RegExp, string][] = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[‐-―−]/g, "-"],
  [/[  -   　]/g, " "],
];

function loose(line: string): string {
  let out = line.trimEnd();
  for (const [re, to] of PUNCT) out = out.replace(re, to);
  return out;
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/**
 * Line-wise fuzzy search for `needle` (whole lines). `loose` ignores trailing whitespace and
 * typographic punctuation; `reindent` also tolerates a uniform indentation shift and returns
 * `replacement` re-indented by the same shift so the edit keeps the file's indentation.
 */
export function fuzzyFind(text: string, needle: string, replacement: string, level: Exclude<Fuzz, "exact">): Span[] {
  const hay = splitLines(text);
  const want = splitLines(needle.endsWith("\n") ? needle : needle + "\n");
  if (want.length === 0 || want.every((l) => l.trim() === "")) return [];
  const starts = lineStarts(text);
  const spans: Span[] = [];
  for (let i = 0; i + want.length <= hay.length; i++) {
    let shift: { from: string; to: string } | null | undefined;
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) {
      const a = loose(hay[i + k]);
      const b = loose(want[k]);
      if (level === "loose") ok = a === b;
      else if (b.trim() === "") ok = a.trim() === "";
      else {
        const ia = indentOf(a);
        const ib = indentOf(b);
        if (a.slice(ia.length) !== b.slice(ib.length)) ok = false;
        else if (!shift) shift = shiftBetween(ib, ia);
        else ok = shift !== null && applyShift(ib, shift) === ia;
        if (shift === null) ok = false;
      }
    }
    if (!ok) continue;
    const start = starts[i];
    const endLine = i + want.length;
    let end = endLine < starts.length ? starts[endLine] : text.length;
    // Keep the trailing newline out of the span unless the needle carried one.
    if (!needle.endsWith("\n") && text[end - 1] === "\n") end -= 1;
    const repl = level === "reindent" && shift ? reindent(replacement, shift) : replacement;
    spans.push({ start, end, replacement: repl });
    i += want.length - 1;
  }
  return spans;
}

function shiftBetween(from: string, to: string): { from: string; to: string } | null {
  if (to.startsWith(from)) return { from: "", to: to.slice(from.length) };
  if (from.startsWith(to)) return { from: from.slice(to.length), to: "" };
  return null;
}

function applyShift(indent: string, s: { from: string; to: string }): string | undefined {
  if (!indent.startsWith(s.from)) return undefined;
  return s.to + indent.slice(s.from.length);
}

function reindent(text: string, s: { from: string; to: string }): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const ind = indentOf(line);
      const next = applyShift(ind, s);
      return next === undefined ? s.to + line : next + line.slice(ind.length);
    })
    .join("\n");
}

/** Up to `max` places that most resemble `needle`, rendered with fresh anchors for a retry. */
export function nearestHints(text: string, needle: string, max = 2): string[] {
  const hay = splitLines(text);
  const want = splitLines(needle).filter((l) => l.trim() !== "");
  if (want.length === 0 || hay.length === 0) return [];
  const probe = want.reduce((a, b) => (b.trim().length > a.trim().length ? b : a)).trim();
  const scored = hay
    .map((line, i) => ({ i, score: similarity(line.trim(), probe) }))
    .filter((c) => c.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  const picked: number[] = [];
  for (const c of scored) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p - c.i) > want.length + 2)) picked.push(c.i);
  }
  return picked.map((i) => {
    const from = Math.max(0, i - 1);
    const to = Math.min(hay.length, i + Math.min(want.length, 8) + 1);
    return formatAnchored(hay.slice(from, to), from + 1);
  });
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  return (2 * common) / (a.length - 1 + (b.length - 1));
}
