// Plans a whole request in memory: every edit is resolved against the current in-memory state of
// its files, in order, and nothing touches disk here. A plan with any error is never committed.
import { isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { astFind } from "./ast.ts";
import { ANCHOR_PREFIX_RE, formatAnchored, lineHash, parseAnchor } from "./hash.ts";
import { jsonEdit } from "./json.ts";
import { findAll, fuzzyFind, lineAt, lineStarts, nearestHints, splitLines, type Fuzz, type Span } from "./text.ts";
import { parseV4A, type Hunk } from "./v4a.ts";

export type Action = "replace" | "before" | "after" | "delete";

export type EditSpec = {
  path?: string;
  glob?: string;
  old?: string;
  regex?: string;
  flags?: string;
  ast?: string;
  lang?: string;
  from?: string;
  to?: string;
  until?: string;
  json?: string;
  new?: string;
  action?: Action;
  count?: number | "all";
  /** Aliases from pi's built-in edit tool. */
  oldText?: string;
  newText?: string;
};

/** As sent by the model: with `json`, `new` may be any JSON value (a non-JSON string is a string). */
export type EditInput = Omit<EditSpec, "new" | "newText"> & { new?: unknown; newText?: unknown; edits?: unknown[] };

export type FileSpec = { path: string; write?: string; moveTo?: string; delete?: boolean };

export type EditRequest = {
  path?: string;
  glob?: string;
  edits?: EditInput[];
  files?: FileSpec[];
  patch?: string;
};

/** Filesystem reads the planner needs; `null` content means the file does not exist. */
export type PlanFs = {
  read(abs: string): Promise<string | null>;
  list(cwd: string): Promise<string[]>;
  /** The path with symlinks resolved, so aliases of one file share one state. Default: identity. */
  canonical?(abs: string): Promise<string>;
  isSymlink?(abs: string): Promise<boolean>;
};

type LineChange = { line: number; removed: number; added: number; edit: number };

export type FileState = {
  abs: string;
  /** Content at the start of the call (LF, no BOM); `null` if the file did not exist. */
  orig: string | null;
  cur: string | null;
  bom: boolean;
  crlf: boolean;
  /** Anchors refer to `orig`; these translate its line numbers to `cur`. */
  changes: LineChange[];
  /** Set when the content was replaced wholesale, so `orig` anchors no longer apply. */
  rewrittenBy?: number;
  /** Raw disk content at planning time (what the commit re-checks), or null if absent. */
  raw: string | null;
  /** For a move destination: the source's start-of-call content, which its anchors refer to. */
  anchorBase?: string | null;
  /** For a move destination: the source path (its mode is kept). */
  movedFrom?: string;
};

export type Note = { edit: number; text: string };
export type Failure = { edit: number; path?: string; message: string; hints?: string[] };

export type Plan = {
  files: Map<string, FileState>;
  notes: Note[];
  failures: Failure[];
  editCount: number;
};

class EditError extends Error {
  hints?: string[];
  path?: string;
  constructor(message: string, hints?: string[], path?: string) {
    super(message);
    this.hints = hints;
    this.path = path;
  }
}

const norm = (s: string) => s.replace(/\r\n/g, "\n");

export class Planner {
  readonly files = new Map<string, FileState>();
  readonly notes: Note[] = [];
  readonly failures: Failure[] = [];
  private listing?: string[];
  private editNo = 0;

  readonly cwd: string;
  readonly fs: PlanFs;

  constructor(cwd: string, fs: PlanFs) {
    this.cwd = cwd;
    this.fs = fs;
  }

  abs(path: string): string {
    const p = path.startsWith("@") ? path.slice(1) : path;
    return resolve(this.cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  }

  private realCwd?: string;

  rel(abs: string): string {
    for (const base of [this.cwd, this.realCwd]) {
      if (!base) continue;
      const r = relative(base, abs);
      if (!r.startsWith("..") && !isAbsolute(r)) return r;
    }
    return abs;
  }

  async state(path: string): Promise<FileState> {
    this.realCwd ??= this.fs.canonical ? await this.fs.canonical(this.cwd) : this.cwd;
    const abs = this.fs.canonical ? await this.fs.canonical(path) : path;
    let st = this.files.get(abs);
    if (!st) {
      const raw = await this.fs.read(abs);
      const bom = raw?.startsWith("\uFEFF") ?? false;
      const body = raw === null ? null : bom ? raw.slice(1) : raw;
      // Only a consistently CRLF file is normalised (and restored); mixed endings stay as they are.
      const crlf = body !== null && body.includes("\r\n") && !/(^|[^\r])\n/.test(body);
      const text = body === null ? null : crlf ? norm(body) : body;
      st = { abs, orig: text, cur: text, raw, bom, crlf, changes: [] };
      this.files.set(abs, st);
    }
    return st;
  }

  async run(req: EditRequest): Promise<Plan> {
    if (req.patch) await this.step(() => this.patch(req.patch!));
    for (const f of req.files ?? []) await this.step(() => this.fileOp(f));
    for (const e of flatten(req.edits ?? [])) await this.step(() => this.edit(e, req));
    if (this.editNo === 0) this.failures.push({ edit: 0, message: "nothing to do: pass edits, files or patch" });
    return { files: this.files, notes: this.notes, failures: this.failures, editCount: this.editNo };
  }

  private async step(fn: () => Promise<void>): Promise<void> {
    this.editNo++;
    try {
      await fn();
    } catch (e) {
      const err = e as EditError;
      this.failures.push({ edit: this.editNo, path: err.path, message: err.message, hints: err.hints });
    }
  }

  // ── file operations ──────────────────────────────────────────────────────────

  private async fileOp(f: FileSpec): Promise<void> {
    const abs = this.abs(f.path);
    if ((f.delete || f.moveTo !== undefined) && (await this.fs.isSymlink?.(abs))) {
      throw new EditError(`${f.path}: is a symlink; this tool edits file content, so delete or move links with bash`, undefined, f.path);
    }
    const st = await this.state(abs);
    const kinds = [f.write !== undefined, f.moveTo !== undefined, f.delete === true].filter(Boolean).length;
    if (kinds !== 1) throw new EditError(`${f.path}: give exactly one of write, moveTo, delete`, undefined, f.path);
    if (f.write !== undefined) {
      if (ANCHOR_PREFIX_RE.test(f.write)) throw new EditError(`${f.path}: content starts with a LINE#HASH: prefix; send literal file content`);
      st.cur = norm(f.write);
      st.rewrittenBy = this.editNo;
      return;
    }
    if (st.cur === null) throw new EditError(`${f.path}: does not exist`, undefined, f.path);
    if (f.delete) {
      st.cur = null;
      return;
    }
    const dest = this.abs(f.moveTo!);
    const dst = await this.state(dest);
    if (dst.cur !== null) throw new EditError(`${f.moveTo}: already exists; delete it first or write it`, undefined, f.moveTo);
    // The destination inherits the source's identity so anchors read from the source still work.
    Object.assign(dst, {
      cur: st.cur,
      changes: [...st.changes],
      rewrittenBy: st.rewrittenBy,
      bom: st.bom,
      crlf: st.crlf,
      anchorBase: st.anchorBase !== undefined ? st.anchorBase : st.orig,
      movedFrom: st.movedFrom ?? st.abs,
    });
    st.cur = null;
  }

  // ── edits ────────────────────────────────────────────────────────────────────

  private async targets(spec: EditSpec, defaults: { path?: string; glob?: string }): Promise<string[]> {
    const e = spec.path === undefined && spec.glob === undefined ? { ...spec, path: defaults.path, glob: defaults.glob } : spec;
    if (e.glob !== undefined && e.path !== undefined) throw new EditError("give path or glob, not both");
    if (e.glob !== undefined) {
      this.listing ??= await this.fs.list(this.cwd);
      // Files created or moved earlier in this call are in scope too.
      const pending = [...this.files.values()].filter((s) => s.cur !== null).map((s) => this.rel(s.abs));
      const all = [...new Set([...this.listing, ...pending])];
      const hits = all.filter((p) => matchesGlob(p, e.glob!)).map((p) => this.abs(p));
      const live: string[] = [];
      for (const abs of hits) {
        const st = await this.state(abs);
        if (st.cur !== null && !live.includes(st.abs)) live.push(st.abs);
      }
      if (live.length === 0) throw new EditError(`glob ${e.glob} matched no files`);
      return live.sort();
    }
    const path = e.path;
    if (!path) throw new EditError("edit needs path or glob (its own or the call's)");
    return [(await this.state(this.abs(path))).abs];
  }

  private async edit(raw: EditInput, defaults: { path?: string; glob?: string }): Promise<void> {
    const given = raw.new ?? raw.newText;
    if (given !== undefined && typeof given !== "string") {
      if (raw.json === undefined) throw new EditError("new must be a string (any JSON value is accepted only with json)");
    }
    const { newText: _alias, ...rest } = raw;
    const e: EditSpec = {
      ...rest,
      old: raw.old ?? raw.oldText,
      new: given === undefined || typeof given === "string" ? given : JSON.stringify(given),
    };
    const action: Action = e.action ?? (e.new === undefined && e.json === undefined ? "delete" : "replace");
    if (action !== "delete" && e.new === undefined) throw new EditError(`action ${action} needs new`);
    if (e.new !== undefined) {
      e.new = norm(e.new);
      if (e.new.split("\n").some((l) => ANCHOR_PREFIX_RE.test(l))) {
        throw new EditError("new contains LINE#HASH: prefixes; send literal file content without anchors");
      }
    }
    if (e.old !== undefined) e.old = norm(e.old);
    const selectors = (["old", "regex", "ast", "from", "json"] as const).filter((k) => e[k] !== undefined);
    if (selectors.length !== 1) {
      throw new EditError(`give exactly one selector (old, regex, ast, from[/to|until], json); got ${selectors.join(", ") || "none"}`);
    }
    if ((e.to !== undefined || e.until !== undefined) && e.from === undefined) throw new EditError("to/until need from");
    if (e.to !== undefined && e.until !== undefined) throw new EditError("give to (inclusive) or until (exclusive), not both");

    const paths = await this.targets(e, defaults);
    const kind = selectors[0];

    if (kind === "json") {
      for (const abs of paths) {
        const st = await this.live(abs);
        try {
          this.replaceWhole(st, jsonEdit(st.cur!, e.json!, action, e.new));
        } catch (err) {
          throw new EditError(`${this.rel(abs)}: ${(err as Error).message}`, undefined, this.rel(abs));
        }
      }
      return;
    }

    // Collect matches across all target files, check the count once, then apply.
    const found: { st: FileState; spans: Span[]; fuzz: Fuzz }[] = [];
    for (const abs of paths) {
      const st = await this.live(abs);
      const { spans, fuzz } = this.select(kind, e, st, action);
      if (spans.length) found.push({ st, spans, fuzz });
    }
    const total = found.reduce((n, f) => n + f.spans.length, 0);
    const want = e.count ?? 1;

    if (total === 0) {
      this.failIfAlreadyApplied(kind, e, action, paths);
      const where = e.glob ? `glob ${e.glob}` : this.rel(paths[0]);
      const st = this.files.get(paths[0])!;
      const needle = e.old ?? e.from ?? "";
      const hints = !e.glob && needle ? nearestHints(st.cur!, needle) : undefined;
      throw new EditError(`${kind} not found in ${where}`, hints?.length ? hints : undefined, e.glob ? undefined : where);
    }
    if (want !== "all" && total !== want) {
      const per = found.map((f) => `${this.rel(f.st.abs)}: lines ${f.spans.map((s) => lineAt(lineStarts(f.st.cur!), s.start)).join(", ")}`);
      throw new EditError(
        `${kind} matched ${total} times, expected ${want}. Add surrounding context, or set count to ${total} or "all".`,
        per.slice(0, 8),
      );
    }
    for (const f of found) {
      if (f.fuzz !== "exact") {
        this.notes.push({ edit: this.editNo, text: `${this.rel(f.st.abs)}: matched ${f.fuzz === "loose" ? "ignoring trailing whitespace/typographic punctuation" : "with re-indentation"}` });
      }
      this.applySpans(f.st, f.spans);
    }
    if (total > 1) this.notes.push({ edit: this.editNo, text: `${total} matches in ${found.length} file(s)` });
  }

  private async live(abs: string): Promise<FileState> {
    const st = await this.state(abs);
    if (st.cur === null) throw new EditError(`${this.rel(abs)}: does not exist${st.orig !== null ? " (deleted or moved earlier in this call)" : ""}`, undefined, this.rel(abs));
    return st;
  }

  private select(kind: string, e: EditSpec, st: FileState, action: Action): { spans: Span[]; fuzz: Fuzz } {
    const text = st.cur!;
    const wrap = (spans: Span[], fuzz: Fuzz = "exact") => ({ spans: spans.map((s) => this.act(s, text, action, e.new ?? "")), fuzz });
    switch (kind) {
      case "old": {
        if (e.old === "") throw new EditError("old must not be empty");
        if (e.old!.split("\n").some((l) => ANCHOR_PREFIX_RE.test(l))) {
          throw new EditError("old contains LINE#HASH: prefixes; use from/to with anchors, or literal text");
        }
        const exact = findAll(text, e.old!);
        if (exact.length) return wrap(exact.map((i) => ({ start: i, end: i + e.old!.length, replacement: e.new })));
        for (const level of ["loose", "reindent"] as const) {
          const spans = fuzzyFind(text, e.old!, e.new ?? "", level);
          if (spans.length) return wrap(spans, level);
        }
        return { spans: [], fuzz: "exact" };
      }
      case "regex": {
        let re: RegExp;
        try {
          re = new RegExp(e.regex!, [...new Set(((e.flags ?? "") + "g").replace(/y/g, ""))].join(""));
        } catch (err) {
          throw new EditError(`invalid regex: ${(err as Error).message}`);
        }
        const spans: Span[] = [];
        for (const m of text.matchAll(re)) {
          if (m[0] === "" && action === "replace" && e.new === "") continue;
          spans.push({ start: m.index!, end: m.index! + m[0].length, replacement: expandRegex(m, e.new ?? "") });
        }
        return wrap(spans);
      }
      case "ast": {
        try {
          return wrap(astFind(st.abs, text, e.ast!, e.new ?? "", e.lang));
        } catch (err) {
          throw new EditError(`${this.rel(st.abs)}: ${(err as Error).message}`, undefined, this.rel(st.abs));
        }
      }
      default:
        return this.range(e, st, action);
    }
  }

  /** before/after keep the match; delete drops it. Line-shaped matches insert line-shaped text. */
  private act(span: Span, text: string, action: Action, add: string): Span {
    const matched = text.slice(span.start, span.end);
    const repl = span.replacement ?? add;
    if (action === "replace") return { ...span, replacement: repl };
    if (action === "delete") return { ...span, replacement: "" };
    return { ...span, replacement: action === "before" ? add + matched : matched + add };
  }

  private range(e: EditSpec, st: FileState, action: Action): { spans: Span[]; fuzz: Fuzz } {
    const text = st.cur!;
    const from = this.locate(e.from!, st, 0, "from");
    const endRef = e.to ?? e.until;
    const start = from.start;
    let end = from.end;
    let lineShaped = from.line;
    if (endRef !== undefined) {
      const to = this.locate(endRef, st, from.end, e.to !== undefined ? "to" : "until");
      if (to.start < from.start) throw new EditError(`${e.to !== undefined ? "to" : "until"} is before from`, undefined, this.rel(st.abs));
      end = e.to !== undefined ? to.end : to.start;
      lineShaped = from.line && to.line;
    }
    let add = e.new ?? "";
    if (lineShaped) {
      if (add !== "" && !add.endsWith("\n")) add += "\n";
      if (end === text.length && !text.endsWith("\n") && add.endsWith("\n") && action === "replace") add = add.slice(0, -1);
    }
    const span = { start, end };
    if (lineShaped && action === "before") return { spans: [{ start, end: start, replacement: add }], fuzz: "exact" };
    if (lineShaped && action === "after") {
      const prefix = end === text.length && !text.endsWith("\n") ? "\n" : "";
      const tail = prefix ? add.replace(/\n$/, "") : add;
      return { spans: [{ start: end, end, replacement: prefix + tail }], fuzz: "exact" };
    }
    return { spans: [this.act({ ...span, replacement: action === "replace" ? add : undefined }, text, action, add)], fuzz: "exact" };
  }

  /** A `N#HH` anchor (whole line, newline included) or exact text that must occur once after `after`. */
  private locate(ref: string, st: FileState, after: number, role: string): { start: number; end: number; line: boolean } {
    const text = st.cur!;
    const rel = this.rel(st.abs);
    const anchor = parseAnchor(ref);
    if (anchor) {
      const line = this.mapAnchor(anchor, st, role);
      const starts = lineStarts(text);
      if (line < 1 || line > starts.length) throw new EditError(`${role} ${ref}: line out of range`, undefined, rel);
      return { start: starts[line - 1], end: line < starts.length ? starts[line] : text.length, line: true };
    }
    const needle = norm(ref);
    const hits = findAll(text.slice(after), needle).map((i) => i + after);
    if (hits.length === 0) throw new EditError(`${role} text not found${after ? " after from" : ""} in ${rel}`, nearestHints(text, needle), rel);
    if (role === "from" && hits.length > 1) {
      throw new EditError(`from text occurs ${hits.length} times in ${rel}; make it unique or use a LINE#HASH anchor`, undefined, rel);
    }
    return { start: hits[0], end: hits[0] + needle.length, line: false };
  }

  /** Validates an anchor against the file as it was read, then maps it through this call's edits. */
  private mapAnchor(a: { line: number; hash: string; content?: string }, st: FileState, role: string): number {
    const rel = this.rel(st.abs);
    const base = st.anchorBase !== undefined ? st.anchorBase : st.orig;
    if (base === null) throw new EditError(`${role} ${a.line}#${a.hash}: ${rel} did not exist when this call started; anchor by text`, undefined, rel);
    if (st.rewrittenBy !== undefined) throw new EditError(`${role} ${a.line}#${a.hash}: ${rel} was rewritten by step ${st.rewrittenBy}; anchor by text`, undefined, rel);
    const lines = splitLines(base);
    if (a.content !== undefined && lines[a.line - 1]?.trimEnd() !== a.content.trimEnd()) {
      // Copied content is a stronger check than the hash: a slipped line number is corrected
      // only when exactly one nearby line has that content.
      const near: number[] = [];
      for (let n = Math.max(1, a.line - 5); n <= Math.min(lines.length, a.line + 5); n++) {
        if (lines[n - 1].trimEnd() === a.content.trimEnd()) near.push(n);
      }
      if (near.length !== 1) {
        const from = Math.max(1, a.line - 2);
        const to = Math.min(lines.length, a.line + 2);
        throw new EditError(
          `${role} ${a.line}#${a.hash}: content does not match line ${a.line}${near.length > 1 ? ` (it matches lines ${near.join(", ")})` : ""}`,
          to >= from ? [formatAnchored(lines.slice(from - 1, to), from)] : undefined,
          rel,
        );
      }
      this.notes.push({ edit: this.editNo, text: `${rel}: ${role} anchor line ${a.line} → ${near[0]} (matched by its content)` });
      a = { ...a, line: near[0], hash: lineHash(near[0], lines[near[0] - 1]) };
    }
    const actual = a.line <= lines.length ? lineHash(a.line, lines[a.line - 1]) : undefined;
    if (actual !== a.hash) {
      const from = Math.max(1, a.line - 2);
      const to = Math.min(lines.length, a.line + 2);
      throw new EditError(
        `${role} ${a.line}#${a.hash} is stale: ${rel} changed since it was read (line ${a.line} is now ${actual ? `${a.line}#${actual}` : "past EOF"})`,
        to >= from ? [formatAnchored(lines.slice(from - 1, to), from)] : undefined,
        rel,
      );
    }
    let line = a.line;
    for (const c of st.changes) {
      if (line < c.line) continue;
      if (line >= c.line + c.removed) line += c.added - c.removed;
      else throw new EditError(`${role} ${a.line}#${a.hash}: that line was changed by step ${c.edit} of this call; anchor by text`, undefined, rel);
    }
    return line;
  }

  /** A retried edit: old is gone but new is present. Still a failure (the call must stay exact), with a hint. */
  private failIfAlreadyApplied(kind: string, e: EditSpec, action: Action, paths: string[]): void {
    if (kind !== "old" || e.glob || !e.new) return;
    const st = this.files.get(paths[0])!;
    const probe = action === "before" ? e.new + e.old : action === "after" ? e.old + e.new : e.new;
    const at = findAll(st.cur!, probe!);
    if (at.length === 0) return;
    const lines = at.slice(0, 3).map((i) => lineAt(lineStarts(st.cur!), i)).join(", ");
    throw new EditError(
      `old not found in ${this.rel(st.abs)}, but new is already present at line ${lines}; if this edit was applied before, drop it`,
      undefined,
      this.rel(st.abs),
    );
  }

  private replaceWhole(st: FileState, next: string): void {
    if (next === st.cur) return;
    const cur = st.cur!;
    let p = 0;
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
    let s = 0;
    while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;
    this.applySpans(st, [{ start: p, end: cur.length - s, replacement: next.slice(p, next.length - s) }]);
  }

  /** Applies non-overlapping spans back to front, recording line changes for anchor mapping. */
  private applySpans(st: FileState, spans: Span[]): void {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end) throw new EditError(`${this.rel(st.abs)}: matches overlap; narrow the selector`, undefined, this.rel(st.abs));
    }
    let text = st.cur!;
    for (const span of sorted.reverse()) {
      const starts = lineStarts(text);
      const repl = span.replacement!;
      // Pure whole-line insertions/deletions are recorded by position: aligning them by content
      // slides past identical neighbouring lines and would misplace later anchors.
      const atLineStart = span.start === 0 || text[span.start - 1] === "\n";
      if (atLineStart && (span.start === span.end ? repl.endsWith("\n") : repl === "" && (text[span.end - 1] === "\n" || span.end === text.length))) {
        const line = span.start >= text.length ? starts.length + 1 : lineAt(starts, span.start);
        const removed = splitLines(text.slice(span.start, span.end)).length;
        st.changes.push({ line, removed, added: splitLines(repl).length, edit: this.editNo });
        text = text.slice(0, span.start) + repl + text.slice(span.end);
        continue;
      }
      const sl = lineAt(starts, span.start);
      let el = span.end > span.start ? lineAt(starts, span.end - 1) : sl;
      const regionStart = starts[sl - 1] ?? text.length;
      let regionEnd = el < starts.length ? starts[el] : text.length;
      const next = text.slice(0, span.start) + span.replacement! + text.slice(span.end);
      let region = next.slice(regionStart, regionEnd + (next.length - text.length));
      if (region !== "" && !region.endsWith("\n") && regionEnd < text.length) {
        el += 1;
        regionEnd = el < starts.length ? starts[el] : text.length;
        region = next.slice(regionStart, regionEnd + (next.length - text.length));
      }
      const oldLines = splitLines(text.slice(regionStart, regionEnd));
      const newLines = splitLines(region);
      let head = 0;
      while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
      let tail = 0;
      while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
      const removed = oldLines.length - head - tail;
      const added = newLines.length - head - tail;
      if (removed || added) st.changes.push({ line: sl + head, removed, added, edit: this.editNo });
      text = next;
    }
    st.cur = text;
  }

  // ── V4A patch ────────────────────────────────────────────────────────────────

  private async patch(patch: string): Promise<void> {
    let ops;
    try {
      ops = parseV4A(norm(patch));
    } catch (err) {
      throw new EditError(`patch: ${(err as Error).message}`);
    }
    for (const op of ops) {
      const abs = this.abs(op.path);
      const st = await this.state(abs);
      if (op.kind === "add") {
        if (st.cur !== null) throw new EditError(`patch: Add File ${op.path}: already exists (use Update File)`, undefined, op.path);
        st.cur = op.content;
        st.rewrittenBy = this.editNo;
        continue;
      }
      if (st.cur === null) throw new EditError(`patch: ${op.path} does not exist`, undefined, op.path);
      if (op.kind === "delete") {
        await this.fileOp({ path: op.path, delete: true });
        continue;
      }
      if (op.hunks.length) this.applySpans(st, hunkSpans(st.cur, op.hunks, op.path, this.notes, this.editNo));
      if (op.moveTo) await this.fileOp({ path: op.path, moveTo: op.moveTo });
    }
  }
}

function hunkSpans(text: string, hunks: Hunk[], path: string, notes: Note[], step: number): Span[] {
  const lines = splitLines(text);
  const starts = lineStarts(text);
  const offset = (line: number) => (line < starts.length ? starts[line] : text.length);
  const spans: Span[] = [];
  let cursor = 0;
  const levels: [Fuzz | "trim", (s: string) => string][] = [
    ["exact", (s) => s],
    ["loose", (s) => s.trimEnd()],
    ["trim", (s) => s.trim()],
  ];
  for (const [n, h] of hunks.entries()) {
    if (h.header) {
      const at = lines.findIndex((l, i) => i >= cursor && l.trim() === h.header!.trim());
      const loose = at === -1 ? lines.findIndex((l, i) => i >= cursor && l.includes(h.header!.trim())) : at;
      if (loose === -1) throw new EditError(`patch: ${path} hunk ${n + 1}: @@ ${h.header} not found`, nearestHints(text, h.header), path);
      cursor = loose + 1;
    }
    let at = -1;
    let used = "exact";
    if (h.old.length === 0) {
      at = h.eof || !h.header ? lines.length : cursor;
    } else {
      for (const [name, f] of levels) {
        const want = h.old.map(f);
        const match = (i: number) => want.every((w, k) => f(lines[i + k]) === w);
        const cands: number[] = [];
        for (let i = cursor; i + want.length <= lines.length; i++) if (match(i)) cands.push(i);
        if (cands.length) {
          at = h.eof && match(lines.length - want.length) ? lines.length - want.length : cands[0];
          used = name;
          break;
        }
      }
    }
    if (at === -1) {
      throw new EditError(`patch: ${path} hunk ${n + 1}: context not found`, nearestHints(text, h.old.join("\n")), path);
    }
    if (used !== "exact") notes.push({ edit: step, text: `${path} hunk ${n + 1}: context matched ignoring whitespace` });
    const start = offset(at);
    const endLine = at + h.old.length;
    let end = offset(endLine);
    let repl = h.new.length ? h.new.join("\n") + "\n" : "";
    if (endLine >= lines.length && !text.endsWith("\n") && h.old.length) {
      end = text.length;
      repl = repl.replace(/\n$/, "");
    }
    spans.push({ start, end, replacement: repl });
    cursor = endLine;
  }
  return spans;
}

/** Expands `{path|glob, edits: [...]}` groups into their edits, which inherit the group's scope. */
function flatten(items: EditInput[]): EditInput[] {
  return items.flatMap((item) => {
    if (!Array.isArray(item.edits)) return [item];
    const { edits, ...group } = item;
    const scope = { ...(group.path !== undefined && { path: group.path }), ...(group.glob !== undefined && { glob: group.glob }) };
    const children = edits as EditInput[];
    return flatten(children.map((child) => (child.path === undefined && child.glob === undefined ? { ...scope, ...child } : child)));
  });
}

/** `$&`, `$1`…`$99`, `$<name>` and `$$`, as in String.prototype.replace. */
export function expandRegex(m: RegExpMatchArray, template: string): string {
  return template.replace(/\$(\$|&|<([^>]+)>|(\d{1,2}))/g, (whole, tok: string, name?: string, num?: string) => {
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (name !== undefined) return m.groups?.[name] ?? "";
    const i = Number(num);
    if (i > 0 && i < m.length) return m[i] ?? "";
    return whole;
  });
}

/** Content as it should land on disk: the file's own BOM and line endings restored. */
export function toRaw(st: FileState, text: string | null): string | null {
  if (text === null) return null;
  return (st.bom ? "\uFEFF" : "") + (st.crlf ? text.replace(/\n/g, "\r\n") : text);
}
