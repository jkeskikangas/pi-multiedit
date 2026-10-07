// Reads, searches, outlines and listings for one read call: everything anchored, overlapping
// lines printed once, unchanged re-reads answered with a stub, and one output budget for the call.
import { createHash } from "node:crypto";
import { extname, matchesGlob, resolve } from "node:path";
import { formatAnchored } from "./hash.ts";
import { outlineLines } from "./outline.ts";
import { splitLines } from "./text.ts";

export type ReadItem = {
  path?: string;
  glob?: string;
  offset?: number;
  limit?: number;
  search?: string;
  flags?: string;
  context?: number;
  outline?: boolean;
};

export type ReadFs = {
  /** File text, null if absent; throws for directories, binary and non-UTF-8 files. */
  read(abs: string): Promise<string | null>;
  list(cwd: string): Promise<string[]>;
};

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
const LIST_MAX = 500;

/** What each file's last full or ranged read delivered, so an unchanged re-read can be a stub. */
export class ReadCache {
  private files = new Map<string, { hash: string; delivered: Set<number>; stubbed?: string }>();

  reset(): void {
    this.files.clear();
  }

  /** "stub" when every requested line was delivered before and the file is unchanged. */
  check(abs: string, hash: string, from: number, to: number): "stub" | "changed" | "serve" {
    const entry = this.files.get(abs);
    if (!entry) return "serve";
    if (entry.hash !== hash) return "changed";
    const key = `${from}-${to}`;
    for (let n = from; n <= to; n++) if (!entry.delivered.has(n)) return "serve";
    if (entry.stubbed === key) {
      entry.stubbed = undefined; // asked again right after a stub: the text is really needed
      return "serve";
    }
    entry.stubbed = key;
    return "stub";
  }

  delivered(abs: string, hash: string, lines: number[]): void {
    let entry = this.files.get(abs);
    if (!entry || entry.hash !== hash) this.files.set(abs, (entry = { hash, delivered: new Set() }));
    for (const n of lines) entry.delivered.add(n);
  }
}

class Budget {
  lines = 0;
  bytes = 0;
  full = false;

  /** Takes as many of `rows` as fit; marks the budget full when some did not. */
  take(rows: string[]): string[] {
    const out: string[] = [];
    for (const row of rows) {
      const b = Buffer.byteLength(row) + 1;
      if (this.lines + 1 > MAX_LINES || this.bytes + b > MAX_BYTES) {
        this.full = true;
        break;
      }
      this.lines += 1;
      this.bytes += b;
      out.push(row);
    }
    return out;
  }
}

const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");

function describe(item: ReadItem): string {
  const scope = item.path ?? item.glob ?? "?";
  if (item.search !== undefined) return `${scope} search ${JSON.stringify(item.search)}`;
  if (item.outline) return `${scope} outline`;
  if (item.offset !== undefined || item.limit !== undefined) return `${scope} offset=${item.offset ?? 1}`;
  return scope;
}

export function validate(items: ReadItem[]): string[] {
  const problems: string[] = [];
  items.forEach((it, i) => {
    const at = `read ${i + 1}`;
    if ((it.path === undefined) === (it.glob === undefined)) problems.push(`${at}: give path or glob`);
    if (it.search !== undefined && it.outline) problems.push(`${at}: give at most one of search, outline`);
    if ((it.offset !== undefined || it.limit !== undefined) && (it.path === undefined || it.search !== undefined || it.outline)) {
      problems.push(`${at}: offset/limit need path and no search or outline`);
    }
    if (it.context !== undefined && it.search === undefined) problems.push(`${at}: context needs search`);
    if (it.flags !== undefined && it.search === undefined) problems.push(`${at}: flags needs search`);
  });
  return problems;
}

export class Reader {
  private printed = new Map<string, Set<number>>();
  private budget = new Budget();
  private listing?: string[];
  private out: string[] = [];
  private failures = 0;
  readonly cwd: string;
  readonly fs: ReadFs;
  readonly cache: ReadCache;

  constructor(cwd: string, fs: ReadFs, cache: ReadCache) {
    this.cwd = cwd;
    this.fs = fs;
    this.cache = cache;
  }

  private abs(path: string): string {
    const p = path.startsWith("@") ? path.slice(1) : path;
    return resolve(this.cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  }

  private async files(glob: string): Promise<string[]> {
    this.listing ??= await this.fs.list(this.cwd);
    return this.listing.filter((p) => matchesGlob(p, glob)).sort();
  }

  private async text(path: string): Promise<string | null> {
    try {
      const t = await this.fs.read(this.abs(path));
      return t === null ? null : t.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    } catch (e) {
      const msg = (e as Error).message;
      if (/is a directory/.test(msg)) throw new Error(`${path} is a directory; read it with glob: "${path.replace(/\/$/, "")}/*"`);
      throw new Error(`${path}: ${msg.replace(/^.*?: /, "").replace(/; this tool edits text/, "")}`);
    }
  }

  /** Anchored rows for the given line numbers of `lines`, in runs, skipping lines printed earlier in this call. */
  private rows(abs: string, lines: string[], numbers: number[]): string[] {
    const seen = this.printed.get(abs) ?? new Set<number>();
    this.printed.set(abs, seen);
    const rows: string[] = [];
    let prev = -1;
    for (const n of numbers) {
      if (seen.has(n)) continue;
      if (prev !== -1 && n !== prev + 1) rows.push("…");
      rows.push(formatAnchored([lines[n - 1]], n));
      seen.add(n);
      prev = n;
    }
    return rows;
  }

  async run(items: ReadItem[]): Promise<string> {
    for (const [i, item] of items.entries()) {
      if (this.budget.full) {
        this.out.push(`not read (output budget reached): ${items.slice(i).map(describe).join("; ")}`);
        break;
      }
      try {
        if (item.search !== undefined) await this.search(item);
        else if (item.outline) await this.outline(item);
        else if (item.glob !== undefined) await this.list(item.glob);
        else await this.file(item);
      } catch (e) {
        this.failures++;
        this.out.push(`${describe(item)}: ${(e as Error).message}`);
      }
    }
    if (this.failures === items.length) throw new Error(this.out.join("\n\n"));
    return this.out.join("\n\n");
  }

  private async file(item: ReadItem): Promise<void> {
    const path = item.path!;
    const text = await this.text(path);
    if (text === null) throw new Error(`${path} does not exist`);
    const abs = this.abs(path);
    const lines = splitLines(text);
    if (lines.length === 0) {
      this.out.push(`${path} (empty file)`);
      return;
    }
    const from = item.offset ?? 1;
    if (from > lines.length) throw new Error(`offset ${from} is past the end of ${path} (${lines.length} lines)`);
    const to = Math.min(lines.length, from - 1 + (item.limit ?? lines.length));
    const hash = hashOf(text);
    const state = this.cache.check(abs, hash, from, to);
    if (state === "stub") {
      this.out.push(`${path}: unchanged since your last read (lines ${from}-${to}); its anchors are still valid. Read it again to get the text.`);
      return;
    }
    const numbers = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const rows = this.rows(abs, lines, numbers);
    const head = `${path} (${from === 1 && to === lines.length ? `${lines.length} lines` : `lines ${from}-${to} of ${lines.length}`})${state === "changed" ? " — changed since your last read" : ""}`;
    if (rows.length === 0) {
      this.out.push(`${path}: lines ${from}-${to} are shown above`);
      return;
    }
    const taken = this.budget.take(rows);
    const shownTo = from - 1 + taken.filter((r) => r !== "…").length;
    this.cache.delivered(abs, hash, numbers.slice(0, shownTo - from + 1));
    const block = [head, ...taken];
    if (taken.length < rows.length) block.push(`[Lines ${from}-${shownTo} of ${lines.length}. Continue with offset=${shownTo + 1}.]`);
    this.out.push(block.join("\n"));
  }

  private async list(glob: string): Promise<void> {
    const files = await this.files(glob);
    const shown = this.budget.take(files.slice(0, LIST_MAX));
    const more = files.length - shown.length;
    this.out.push([`${glob}: ${files.length} file${files.length === 1 ? "" : "s"}`, ...shown, ...(more > 0 ? [`… ${more} more; narrow the glob`] : [])].join("\n"));
  }

  private async scope(item: ReadItem): Promise<string[]> {
    if (item.path !== undefined) return [item.path];
    const files = await this.files(item.glob!);
    if (files.length === 0) throw new Error(`glob ${item.glob} matched no files`);
    return files;
  }

  private async search(item: ReadItem): Promise<void> {
    let re: RegExp;
    try {
      re = new RegExp(item.search!, (item.flags ?? "").replace(/[gy]/g, ""));
    } catch (e) {
      throw new Error(`invalid regex: ${(e as Error).message}`);
    }
    const context = item.context ?? 2;
    const blocks: string[] = [];
    let matches = 0;
    let hitFiles = 0;
    for (const path of await this.scope(item)) {
      let text: string | null;
      try {
        text = await this.text(path);
      } catch (e) {
        if (item.path !== undefined) throw e;
        continue; // binary or undecodable files are skipped in a glob search
      }
      if (text === null) {
        if (item.path !== undefined) throw new Error(`${path} does not exist`);
        continue;
      }
      const lines = splitLines(text);
      const hits = lines.flatMap((l, k) => (re.test(l) ? [k + 1] : []));
      if (hits.length === 0) continue;
      matches += hits.length;
      hitFiles++;
      if (this.budget.full) continue;
      const wanted = new Set<number>();
      for (const h of hits) for (let n = Math.max(1, h - context); n <= Math.min(lines.length, h + context); n++) wanted.add(n);
      const rows = this.rows(this.abs(path), lines, [...wanted].sort((a, b) => a - b));
      const taken = this.budget.take([path, ...rows]);
      if (taken.length) blocks.push(taken.join("\n"));
    }
    const scope = item.path ?? item.glob;
    const head = `search ${JSON.stringify(item.search)} in ${scope}: ${matches} match${matches === 1 ? "" : "es"} in ${hitFiles} file${hitFiles === 1 ? "" : "s"}`;
    const cut = this.budget.full ? ["… output budget reached; narrow the search (a path, a tighter glob or pattern, or context: 0)"] : [];
    this.out.push([head, ...blocks, ...cut].join("\n\n"));
  }

  private async outline(item: ReadItem): Promise<void> {
    const blocks: string[] = [];
    for (const path of await this.scope(item)) {
      const text = await this.text(path).catch((e) => {
        if (item.path !== undefined) throw e;
        return null;
      });
      if (text === null) {
        if (item.path !== undefined) throw new Error(`${path} does not exist`);
        continue;
      }
      const lines = splitLines(text);
      const decl = outlineLines(path, text);
      if (decl === undefined) {
        if (item.path !== undefined) blocks.push(`${path}: no outline for ${extname(path) || "this file type"}; use search`);
        continue;
      }
      if (this.budget.full) break;
      const rows = this.rows(this.abs(path), lines, decl);
      const taken = this.budget.take([`${path} (outline of ${lines.length} lines)`, ...rows]);
      if (taken.length) blocks.push(taken.join("\n"));
    }
    if (this.budget.full) blocks.push("… output budget reached; outline fewer files");
    this.out.push(blocks.join("\n\n"));
  }
}
