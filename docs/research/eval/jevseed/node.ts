// Seed v4: node-level. Candidate files (prompt words + path tokens) are split into nodes (tree-sitter
// outline leaves; test blocks by heuristic), expanded one hop along references from anchor nodes,
// scored per node by Jev (25 per request, in parallel), and injected as anchored sections with the
// file head; a file mostly selected is injected whole. Labelled as already read.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatAnchored } from "../../../../src/hash.ts";
import { noteShown } from "../../../../src/shown.ts";
import { outlineBlocks } from "./outline.ts";

const run = promisify(execFile);
const BUDGET_MS = Number(process.env.PI_JEV_MS ?? 8000);
const CHARS = Number(process.env.PI_JEV_CHARS ?? 40000);
const NODE_P = Number(process.env.PI_JEV_P ?? 0.5);
const MAX_FILES = 40, HOP_FILES = 15, MAX_NODES = 300, CHUNK = 30, HEAD_LINES = 40, WHOLE_LINES = 400, MAX_MD = 2;
const GENERIC = new Set(["config", "parse", "load", "new", "get", "put", "run", "main", "index", "default", "handle", "build", "create", "update", "delete", "render", "init", "start", "stop", "call", "cast", "info", "error", "format", "to_string", "from_string", "label", "value", "data", "type", "name", "state", "test", "setup"]);
const LOG = process.env.PI_JEV_LOG;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|_test\.exs?$/;
const TEST_BLOCK = /^\s*(test|it|describe|context|scenario|setup|setup_all)\b\s*[("'a-z_]|^\s*(async\s+)?def test_/;
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "only", "when", "each", "must", "does", "not", "also", "then", "than", "them", "they", "both", "every", "other", "which", "while", "their", "where"]);

type Node = { file: string; start: number; end: number; header: string; relation: string; p?: number };

function identifiers(prompt: string): { words: string[]; phrases: string[] } {
  const words = new Set<string>();
  for (const m of prompt.matchAll(/`([^`\n]{2,80})`/g)) words.add(m[1].trim());
  for (const m of prompt.matchAll(/\b([A-Z][A-Za-z0-9]+(?:\.[A-Z][A-Za-z0-9]+)+)\b/g)) words.add(m[1]);
  for (const m of prompt.matchAll(/\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) words.add(m[1]);
  for (const m of prompt.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+)\b/g)) words.add(m[1]);
  for (const m of prompt.matchAll(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g)) words.add(m[1]);
  for (const w of [...words]) { const seg = w.split(".").pop()!; if (seg !== w && seg.length > 3) words.add(seg); }
  const phrases = [...prompt.matchAll(/"([^"\n]{8,80})"/g)].map((m) => m[1]);
  return { words: [...words].filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase())).slice(0, 24), phrases: phrases.slice(0, 6) };
}
async function rgFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run("rg", ["-l", "--glob", "!node_modules", "--glob", "!deps", "--glob", "!_build", "--glob", "!*.lock", "--glob", "!dist", "--glob", "!*.{png,jpg,svg,mp3,pdf}", ...args, "."], { cwd, maxBuffer: 32 << 20 });
    return stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  } catch { return []; }
}
let pathCache: { cwd: string; paths: string[] } | undefined;
async function listPaths(cwd: string): Promise<string[]> {
  if (pathCache?.cwd === cwd) return pathCache.paths;
  try {
    const { stdout } = await run("git", ["ls-files", "-z"], { cwd, maxBuffer: 64 << 20 });
    pathCache = { cwd, paths: stdout.split("\0").filter((p) => p && !/(^|\/)(node_modules|deps|_build|dist)\//.test(p)) };
  } catch { pathCache = { cwd, paths: [] }; }
  return pathCache.paths;
}
const normPath = (p: string) => p.toLowerCase().replace(/[-_]/g, "");
function indent(l: string) { return l.length - l.trimStart().length; }
function blockEnd(lines: string[], start: number, max = 150): number {
  const base = indent(lines[start]); let last = start;
  for (let i = start + 1; i < lines.length && i - start < max; i++) {
    const l = lines[i]; if (!l.trim()) continue;
    if (indent(l) <= base) return /^\s*(end\b|[}\])])/.test(l) ? i : last;
    last = i;
  }
  return last;
}
/** Nodes of a file: outline leaves, or test blocks in test files, or the whole file when small and unparsed. */
function nodesOf(file: string, lines: string[]): Node[] {
  const out: Node[] = [];
  if (TEST_PATH.test(file)) {
    for (let i = 0; i < lines.length; i++) if (TEST_BLOCK.test(lines[i])) { const e = blockEnd(lines, i); out.push({ file, start: i + 1, end: e + 1, header: lines[i].trim(), relation: "" }); i = e; }
    if (out.length) return out;
  }
  const blocks = outlineBlocks(file, lines.join("\n")) ?? [];
  const leaves = blocks.filter((b) => !blocks.some((o) => o !== b && o.line > b.line && o.line <= b.end));
  for (const b of leaves) out.push({ file, start: b.line, end: Math.min(b.end, lines.length), header: lines[b.line - 1].trim(), relation: "" });
  if (!out.length && lines.length <= WHOLE_LINES) out.push({ file, start: 1, end: lines.length, header: `(whole file, ${lines.length} lines)`, relation: "" });
  return out;
}
const nameOf = (header: string) => /(?:def|defp|defmodule|function|class|const|let|var|export (?:const|function|class|type|interface)?|type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_.?!]*)/.exec(header)?.[1];

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.trim();
    if (!prompt) return undefined;
    const t0 = Date.now();
    const deadline = new Promise<undefined>((r) => setTimeout(() => r(undefined), BUDGET_MS).unref());
    const work = (async () => {
      const cwd = ctx.cwd;
      const { words, phrases } = identifiers(prompt);
      const lower = words.map((w) => w.toLowerCase());
      const hitCount = new Map<string, number>();
      const bump = (files: string[], w: number) => files.forEach((f) => hitCount.set(f, (hitCount.get(f) ?? 0) + w));
      await Promise.all([...words.map(async (w) => bump(await rgFiles(cwd, ["-w", "-F", "-e", w]), 1)), ...phrases.map(async (p) => bump(await rgFiles(cwd, ["-i", "-F", "-e", p]), 3))]);
      const paths = await listPaths(cwd);
      const pw = prompt.toLowerCase().replace(/[`"'(),.:;]/g, " ").split(/\s+/).filter(Boolean);
      const seenTok = new Set<string>();
      for (let i = 0; i < pw.length; i++) for (let n = 2; n <= 4 && i + n <= pw.length; n++) {
        const tok = pw.slice(i, i + n).join("").replace(/[-_]/g, "");
        if (tok.length < 8 || seenTok.has(tok) || !/^[a-z0-9]+$/.test(tok)) continue;
        seenTok.add(tok);
        for (const p of paths.filter((p) => normPath(p).includes(tok)).slice(0, 4)) hitCount.set(p, (hitCount.get(p) ?? 0) + 3);
      }
      const models = await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe").catch(() => []);
      const model = models.find((m: any) => m.id.startsWith("jev")) ?? models[0];
      if (!model) return undefined;
      // names-only recall pass: Jev over the paths in the candidate files' directories, no content
      const dirs = [...new Set([...hitCount.keys()].map((f) => f.split("/").slice(0, -1).join("/")))].slice(0, 12);
      const namePool = paths.filter((p) => dirs.some((d) => p.startsWith(d + "/")) && !hitCount.has(p) && /\.(ex|exs|ts|tsx|js|jsx|py|md|json)$/.test(p)).slice(0, 120);
      const nameChunks: string[][] = [];
      for (let i = 0; i < namePool.length; i += 60) nameChunks.push(namePool.slice(i, i + 60));
      await Promise.all(nameChunks.map(async (chunk) => {
        const questions = Object.fromEntries(chunk.map((p, i) => [`p${i}`, { type: "bool", instructions: `Judging by its path alone, would the developer need to open p${i} (${p}) to implement the task?`, criteria: { true: "Likely needed", false: "Unlikely" } }]));
        try { const res: any = await ctx.modelRegistry.classify(model, { state: { task: prompt.slice(0, 2000), paths: Object.fromEntries(chunk.map((p, i) => [`p${i}`, p])) }, questions }); if (res.stopReason === "stop") chunk.forEach((p, i) => { const pr = res.answers?.[`p${i}`]?.probability ?? 0; if (pr >= 0.5) hitCount.set(p, (hitCount.get(p) ?? 0) + 2); }); } catch { /* no recall pass */ }
      }));
      let md = 0;
      const files = [...hitCount.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).filter((f) => !/\.(md|markdown)$/i.test(f) || md++ < MAX_MD).slice(0, MAX_FILES);
      if (!files.length) return undefined;
      const weight = (f: string) => hitCount.get(f) ?? 0;
      const texts = new Map<string, string[]>();
      const load = async (f: string) => { if (!texts.has(f)) texts.set(f, (await readFile(resolve(cwd, f), "utf8").catch(() => "")).split("\n")); return texts.get(f)!; };
      let nodes: Node[] = [];
      for (const f of files) for (const n of nodesOf(f, await load(f))) nodes.push(n);
      // anchor nodes: header or body mentions a prompt word; one hop: files referencing the anchor's name
      const anchors = nodes.filter((n) => { const body = texts.get(n.file)!.slice(n.start - 1, n.end).join("\n").toLowerCase(); return lower.some((w) => body.includes(w)); });
      for (const n of anchors) n.relation = "mentions a task identifier";
      const hopNames = [...new Set(anchors.map((n) => nameOf(n.header)).filter((x): x is string => !!x && x.length >= 6 && !GENERIC.has(x.toLowerCase())))].slice(0, 10);
      const hopFiles = new Set<string>();
      await Promise.all(hopNames.map(async (nm) => { const fs = await rgFiles(cwd, ["-w", "-F", "-e", nm]); if (fs.length > 25) return; for (const f of fs) if (!texts.has(f)) hopFiles.add(f); }));
      for (const f of [...hopFiles].slice(0, HOP_FILES)) for (const n of nodesOf(f, await load(f))) { const body = texts.get(f)!.slice(n.start - 1, n.end).join("\n"); const hit = hopNames.find((nm) => body.includes(nm)); if (hit) { n.relation = `references ${hit}`; nodes.push(n); } }
      // keep the most promising nodes within the scoring cap
      // scoring order: anchor nodes first, then by their file's hit weight, so a strong file's nodes are never cut by a weak file's
      nodes = nodes.filter((n) => n.end - n.start < 400);
      nodes.sort((a, b) => ((b.relation ? 1 : 0) - (a.relation ? 1 : 0)) || weight(b.file) - weight(a.file));
      nodes = nodes.slice(0, MAX_NODES);
      if (LOG) process.stderr.write(`[jev] v4 files: ${files.slice(0, 10).map((f) => `${f.split("/").slice(-2).join("/")}=${weight(f)}`).join(" ")}\n`);
      const scoreChunk = async (chunk: Node[]) => {
        const state: Record<string, unknown> = { task: prompt.slice(0, 2000), nodes: Object.fromEntries(chunk.map((n, i) => [`n${i}`, { file: n.file, lines: `${n.start}-${n.end}`, relation: n.relation || "candidate", header: n.header.slice(0, 160), body: texts.get(n.file)!.slice(n.start, Math.min(n.end, n.start + 8)).map((l) => l.trim().slice(0, 120)) }])) };
        const questions = Object.fromEntries(chunk.map((n, i) => [`n${i}`, { type: "bool", instructions: `To implement the task, would the developer need to read or change node n${i} (${n.file} lines ${n.start}-${n.end}, "${n.header.slice(0, 80)}")?`, criteria: { true: "Yes, this code is part of the change or must be understood for it", false: "No, unrelated or only superficially related" } }]));
        try { const res: any = await ctx.modelRegistry.classify(model, { state, questions }); if (res.stopReason !== "stop") return; chunk.forEach((n, i) => (n.p = res.answers?.[`n${i}`]?.probability)); } catch { /* unscored stays undefined */ }
      };
      const chunks: Node[][] = [];
      for (let i = 0; i < nodes.length; i += CHUNK) chunks.push(nodes.slice(i, i + CHUNK));
      await Promise.all(chunks.map(scoreChunk));
      const picked = nodes.filter((n) => (n.p ?? 0) >= NODE_P).sort((a, b) => b.p! - a.p!);
      // compose per file: whole when mostly selected and small, else head + sections
      const byFile = new Map<string, Node[]>();
      for (const n of picked) (byFile.get(n.file) ?? byFile.set(n.file, []).get(n.file)!).push(n);
      const out: string[] = []; let used = 0; let wholeCount = 0, sectionCount = 0;
      const fileOrder = [...byFile.entries()].sort((a, b) => Math.max(...b[1].map((n) => n.p!)) - Math.max(...a[1].map((n) => n.p!)));
      for (const [f, ns] of fileOrder) {
        const lines = texts.get(f)!; const abs = resolve(cwd, f);
        const selected = ns.reduce((s, n) => s + (n.end - n.start + 1), 0);
        let block: string;
        if (lines.length <= WHOLE_LINES && selected >= 0.5 * lines.length) {
          block = `### ${f} (complete, ${lines.length} lines, p=${Math.max(...ns.map((n) => n.p!)).toFixed(2)})\n${formatAnchored(lines, 1)}`;
          if (used + block.length > CHARS) continue;
          wholeCount++;
        } else {
          ns.sort((a, b) => a.start - b.start);
          const firstStart = Math.min(...ns.map((n) => n.start));
          const head = Math.min(HEAD_LINES, firstStart - 1);
          const parts = [head > 0 ? `${formatAnchored(lines.slice(0, head), 1)}` : ""];
          let lastEnd = head;
          for (const n of ns) { if (n.start <= lastEnd) continue; parts.push(`…\n${formatAnchored(lines.slice(n.start - 1, n.end), n.start)}`); lastEnd = n.end; }
          block = `### ${f} (${lines.length} lines; sections ${ns.map((n) => `${n.start}-${n.end} p=${n.p!.toFixed(2)}`).join(", ")}; lines not shown are unchanged context)\n${parts.filter(Boolean).join("\n")}`;
          if (used + block.length > CHARS) continue;
          sectionCount += ns.length;
        }
        out.push(block); used += block.length; noteShown(abs, lines.join("\n"));
      }
      if (LOG) process.stderr.write(`[jev] v4 ${files.length}+${hopFiles.size} files, ${nodes.length} nodes scored in ${chunks.length} requests, ${picked.length} picked (${wholeCount} whole files, ${sectionCount} sections), ${used} chars, ${Date.now() - t0} ms; top: ${picked.slice(0, 6).map((n) => `${n.file.split("/").pop()}:${n.start}=${n.p!.toFixed(2)}`).join(" ")}\n`);
      if (!out.length) return undefined;
      return `Code for this task, selected automatically. "complete" files are the full file; "sections" are the relevant parts with the file head. Everything shown is already read and carries N#HH anchors: edit directly with from/to or old. Read a file only for parts not shown.\n\n${out.join("\n\n")}`;
    })();
    const content = await Promise.race([work.catch((e) => (LOG && process.stderr.write(`[jev] v4 error ${e}\n`), undefined)), deadline]);
    if (!content) { if (LOG) process.stderr.write(`[jev] v4 no seed (${Date.now() - t0} ms)\n`); return undefined; }
    return { message: { customType: "jev-seed", content, display: false } };
  });
}
