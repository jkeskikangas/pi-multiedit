// Jev-composed seed: before the first model call, find the files the task names (identifiers and
// quoted strings → rg), ask TypeSafe's Jev classifier which of them a developer must read whole,
// and inject those whole and anchored, marked as already read. Falls back to nothing on timeout.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatAnchored } from "../../../../src/hash.ts";
import { noteShown } from "../../../../src/shown.ts";

const run = promisify(execFile);
const BUDGET_MS = Number(process.env.PI_JEV_MS ?? 6000);
const CHARS = Number(process.env.PI_JEV_CHARS ?? 40000);
const WHOLE_P = Number(process.env.PI_JEV_P ?? 0.6);
const MAX_WHOLE_LINES = 400;
const CANDIDATES = 40;
const PARALLEL = 8;
const LOG = process.env.PI_JEV_LOG;
const DEF = /^\s*(export\s+)?(async\s+)?(def|defp|defmodule|defmacro|function|class|interface|type|enum|const|let|module)\b/;

function identifiers(prompt: string): { words: string[]; phrases: string[] } {
  const words = new Set<string>();
  for (const m of prompt.matchAll(/`([^`\n]{2,80})`/g)) words.add(m[1].trim());
  for (const m of prompt.matchAll(/\b([A-Z][A-Za-z0-9]+(?:\.[A-Z][A-Za-z0-9]+)+)\b/g)) words.add(m[1]); // Dotted.Module.Names
  for (const m of prompt.matchAll(/\b([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) words.add(m[1]); // snake_case
  for (const m of prompt.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]+)\b/g)) words.add(m[1]); // camelCase
  for (const m of prompt.matchAll(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g)) words.add(m[1]); // PascalCase
  const phrases = [...prompt.matchAll(/"([^"\n]{8,80})"/g)].map((m) => m[1]);
  // dotted names: also their last segment and the file-ish form
  for (const w of [...words]) {
    const seg = w.split(".").pop()!;
    if (seg !== w && seg.length > 3) words.add(seg);
  }
  return { words: [...words].filter((w) => w.length >= 4 && !/^(the|and|for|with|from|that|this|into|only|when|each|must|does|not)$/i.test(w)).slice(0, 24), phrases: phrases.slice(0, 6) };
}
let pathCache: { cwd: string; paths: string[] } | undefined;
async function listPaths(cwd: string): Promise<string[]> {
  if (pathCache?.cwd === cwd) return pathCache.paths;
  try {
    const { stdout } = await run("git", ["ls-files", "-z"], { cwd, maxBuffer: 64 << 20 });
    pathCache = { cwd, paths: stdout.split("\0").filter((p) => p && !/(^|\/)(node_modules|deps|_build|dist)\//.test(p)) };
  } catch {
    pathCache = { cwd, paths: [] };
  }
  return pathCache.paths;
}
async function rgFiles(cwd: string, args: string[]): Promise<string[]> {
  try {
    const { stdout } = await run("rg", ["-l", "--glob", "!node_modules", "--glob", "!deps", "--glob", "!_build", "--glob", "!*.lock", "--glob", "!dist", "--glob", "!*.{png,jpg,svg,mp3}", ...args, "."], { cwd, maxBuffer: 32 << 20 });
    return stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.trim();
    if (!prompt) return undefined;
    const t0 = Date.now();
    const deadline = new Promise<undefined>((r) => setTimeout(() => r(undefined), BUDGET_MS).unref());
    const work = (async () => {
      const cwd = ctx.cwd;
      const { words, phrases } = identifiers(prompt);
      const hitCount = new Map<string, number>();
      const bump = (files: string[], w: number) => files.forEach((f) => hitCount.set(f, (hitCount.get(f) ?? 0) + w));
      await Promise.all([
        ...words.map(async (w) => bump(await rgFiles(cwd, ["-w", "-F", "-e", w]), 1)),
        ...phrases.map(async (p) => bump(await rgFiles(cwd, ["-i", "-F", "-e", p]), 3)),
      ]);
      // Phrases that name a file by concept ("the company-member read policy test"): every window of
      // 2–4 words, hyphens included, as a snake_case token matched against repository paths.
      const paths = await listPaths(cwd);
      const pw = prompt.toLowerCase().replace(/[`"'(),.:;]/g, " ").split(/\s+/).filter(Boolean);
      const seenTok = new Set<string>();
      for (let i = 0; i < pw.length; i++) {
        for (let n = 2; n <= 4 && i + n <= pw.length; n++) {
          const tok = pw.slice(i, i + n).join("_").replace(/-/g, "_");
          if (tok.length < 8 || seenTok.has(tok) || !/^[a-z0-9_]+$/.test(tok)) continue;
          seenTok.add(tok);
          const matches = paths.filter((p) => p.includes(tok)).slice(0, 4);
          for (const p of matches) hitCount.set(p, (hitCount.get(p) ?? 0) + 3);
        }
      }
      const candidates = [...hitCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([f]) => f);
      if (!candidates.length) return undefined;
      const models = await ctx.modelRegistry.getAvailableOfType("classifier", "typesafe").catch(() => []);
      const model = models.find((m: any) => m.id.startsWith("jev")) ?? models[0];
      if (!model) {
        if (LOG) process.stderr.write(`[jev] no classifier model available\n`);
        return undefined;
      }
      const texts = new Map<string, string>();
      for (const f of candidates) texts.set(f, await readFile(resolve(cwd, f), "utf8").catch(() => ""));
      const lower = words.map((w) => w.toLowerCase());
      // One request per chunk of files: the state carries every file's evidence, one bool question per file.
      const CHUNK = Number(process.env.PI_JEV_CHUNK ?? 20);
      const evidence = (f: string) => {
        const lines = texts.get(f)!.split("\n");
        return {
          lines: lines.length,
          declarations: lines.filter((l) => DEF.test(l)).slice(0, 20).map((l) => l.trim().slice(0, 120)),
          matching_lines: lines.filter((l) => lower.some((w) => l.toLowerCase().includes(w))).slice(0, 6).map((l) => l.trim().slice(0, 140)),
        };
      };
      const classifyChunk = async (files: string[]): Promise<(number | undefined)[]> => {
        const state: Record<string, unknown> = { task: prompt.slice(0, 2000), files: Object.fromEntries(files.map((f, i) => [`f${i}`, { path: f, ...evidence(f) }])) };
        const questions = Object.fromEntries(
          files.map((f, i) => [
            `f${i}`,
            {
              type: "bool",
              instructions: `To implement the task, would the developer need to open file f${i} (${f}) — to change it, or to see how the thing being changed is defined, called or tested?`,
              criteria: { true: "Yes, this file must be read or changed for the task", false: "No, it only mentions related names or is unrelated" },
            },
          ]),
        );
        try {
          const res: any = await ctx.modelRegistry.classify(model, { state, questions });
          if (res.stopReason !== "stop") return files.map(() => undefined);
          return files.map((_, i) => res.answers?.[`f${i}`]?.probability);
        } catch {
          return files.map(() => undefined);
        }
      };
      const chunks: string[][] = [];
      for (let i = 0; i < candidates.length; i += CHUNK) chunks.push(candidates.slice(i, i + CHUNK));
      const probs = (await Promise.all(chunks.map(classifyChunk))).flat();
      const scored = candidates.map((f, i) => ({ f, p: probs[i] ?? 0 })).sort((a, b) => b.p - a.p);
      const out: string[] = [];
      let used = 0;
      const whole: string[] = [];
      for (const { f, p } of scored) {
        const text = texts.get(f)!;
        const lines = text.split("\n");
        if (p >= WHOLE_P && lines.length <= MAX_WHOLE_LINES) {
          const block = `### ${f} (complete, ${lines.length} lines, p=${p.toFixed(2)})\n${formatAnchored(lines, 1)}`;
          if (used + block.length > CHARS) continue;
          out.push(block);
          used += block.length;
          whole.push(f);
          noteShown(resolve(cwd, f), text); // bare line numbers may now refer to this view
        } else if (p >= 0.3) {
          const hits = lines.map((l, i) => [i, l] as const).filter(([, l]) => lower.some((w) => l.toLowerCase().includes(w))).slice(0, 6);
          const block = `### ${f} (${lines.length} lines, p=${p.toFixed(2)}; matching lines)\n${hits.map(([i, l]) => `${i + 1}: ${l.trim().slice(0, 160)}`).join("\n")}`;
          if (used + block.length > CHARS) continue;
          out.push(block);
          used += block.length;
        }
      }
      if (LOG) process.stderr.write(`[jev] ${candidates.length} candidates, ${whole.length} whole, ${used} chars, ${Date.now() - t0} ms; top: ${scored.slice(0, 6).map((s) => `${s.f}=${s.p.toFixed(2)}`).join(" ")}\n`);
      if (!out.length) return undefined;
      return `Files for this task, selected automatically. The ones marked "complete" are the full file, already read: every line carries its N#HH anchor, so edit them directly with from/to or old without reading them again. Files shown as matching lines are candidates; read them if needed.\n\n${out.join("\n\n")}`;
    })();
    const content = await Promise.race([work.catch((e) => (LOG && process.stderr.write(`[jev] error ${e}\n`), undefined)), deadline]);
    if (!content) {
      if (LOG) process.stderr.write(`[jev] no seed (${Date.now() - t0} ms)\n`);
      return undefined;
    }
    return { message: { customType: "jev-seed", content, display: false } };
  });
}
