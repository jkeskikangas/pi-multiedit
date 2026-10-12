// Drafts: edits planned and kept in memory instead of written, then applied later all-or-nothing.
// A draft is a scope with its own view of the workspace (disk overlaid with its changes) and its own
// record of what the model has seen (shown.ts), so a speculative run can edit, read its own edits
// back, and chain anchors exactly as on disk without touching the user's files.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { generateDiffString, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commit, ConflictError, drift, serially, type FileChange } from "./commit.ts";
import type { PlanFs } from "./engine.ts";
import { countChanges, renderReport, type FileReport } from "./feedback.ts";
import { renderAnchored } from "./read.ts";
import { dropScope, noteShown, shownHash } from "./shown.ts";
import { ATTEMPTS, isSymlink, listFiles, noChangesResult, planEdits, readText, resultText, syntaxSummary, type EditDetails, type EditParams } from "./tool.ts";

export type Draft = {
  id: string;
  /** The directory edit paths are relative to, as given. */
  cwd: string;
  /** Drafted files by canonical path: `before` is the disk content when the draft first touched the file, `after` the latest. */
  changes: Map<string, FileChange>;
  /** Every successful edit call, in order, bare line numbers resolved to anchors; replayed on a conflict. */
  requests: EditParams[];
  /** The draft's scope in shown.ts. */
  shown: string;
};

type Internal = Draft & { realCwd: string; queue: Promise<unknown> };

export type EditResult = { content: { type: "text"; text: string }[]; details: EditDetails };

export type DraftSummary = {
  files: { path: string; status: "created" | "modified" | "deleted"; diff: string }[];
  insertions: number;
  deletions: number;
};

const drafts = new Map<string, Internal>();

/** Symlinks resolved on the longest existing ancestor, so a file created in a new directory keeps one key. */
async function canonicalDeep(abs: string): Promise<string> {
  const tail: string[] = [];
  for (let dir = abs; ; ) {
    try {
      return join(await realpath(dir), ...tail);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs;
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

const fromHome = (path: string) => path.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

function relTo(d: Internal, abs: string): string | undefined {
  for (const base of [d.realCwd, d.cwd]) {
    const r = relative(base, abs);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return r;
  }
  return undefined;
}

function need(id: string): Internal {
  const d = drafts.get(id);
  if (!d) throw new Error(`unknown draft ${id}`);
  return d;
}

/** Runs `fn` after every earlier operation on the draft, so concurrent calls see each other's results. */
function queued<T>(d: Internal, fn: () => Promise<T>): Promise<T> {
  const run = d.queue.then(fn, fn);
  d.queue = run.catch(() => {});
  return run;
}

async function create(cwd: string): Promise<Internal> {
  const id = randomUUID();
  return { id, cwd, realCwd: await canonicalDeep(cwd), changes: new Map(), requests: [], shown: `draft:${id}`, queue: Promise.resolve() };
}

/** The workspace as the draft sees it: disk, overlaid with the draft's files (created, changed, deleted). */
function draftFs(d: Internal): PlanFs {
  return {
    read: async (abs) => {
      const c = d.changes.get(abs);
      return c ? c.after : readText(abs);
    },
    list: async (cwd) => {
      const disk = await listFiles(cwd);
      const deleted = new Set<string>();
      const created: string[] = [];
      for (const c of d.changes.values()) {
        const rel = relTo(d, c.abs);
        if (rel === undefined) continue;
        if (c.after === null) deleted.add(rel);
        else if (c.before === null) created.push(rel);
      }
      return [...new Set([...disk.filter((p) => !deleted.has(p)), ...created])];
    },
    canonical: canonicalDeep,
    isSymlink,
    shownHash: (abs, n) => shownHash(abs, n, d.shown),
  };
}

/** The request with bare line numbers in from/to replaced by the anchor they resolved to, so a replay means the same lines. */
async function pinned(d: Internal, params: EditParams): Promise<EditParams> {
  const edits = await Promise.all(
    (params.edits ?? []).map(async (e) => {
      if (e.path === undefined) return e;
      const out = { ...e };
      for (const key of ["from", "to"] as const) {
        const bare = typeof e[key] === "string" ? /^\s*(\d+)\s*#?\s*$/.exec(e[key]) : null;
        if (!bare) continue;
        const n = Number(bare[1]);
        const hash = shownHash(await canonicalDeep(resolve(d.cwd, fromHome(e.path))), n, d.shown);
        if (hash !== undefined) out[key] = `${n}#${hash}`;
      }
      return out;
    }),
  );
  return { ...params, edits };
}

/** Plans `params` in the draft's view and stores the result; throws (leaving the draft as it was) on any failure. */
async function editIn(d: Internal, params: EditParams): Promise<EditResult> {
  const request = await pinned(d, params);
  const p = await planEdits(d.cwd, params, draftFs(d));
  if (p.changes.length === 0) return noChangesResult(p);
  for (const c of p.changes) {
    const prev = d.changes.get(c.abs);
    const before = prev ? prev.before : c.before;
    // A file edited back to its original content is no longer part of the draft.
    if (before === c.after) d.changes.delete(c.abs);
    else d.changes.set(c.abs, { abs: c.abs, before, after: c.after });
  }
  d.requests.push(request);
  // As after a normal edit, the result shows each changed file's new state, now this draft's view of it.
  for (const st of p.changed) if (st.cur !== null) noteShown(st.abs, st.cur, d.shown);
  return { content: [{ type: "text", text: resultText(p, "drafted, not written") }], details: p.details };
}

/** Content as `read` shows it: no BOM, LF endings. */
const shownText = (raw: string | null) => (raw === null ? null : raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));

function reportsOf(d: Internal, changes: FileChange[]): FileReport[] {
  return changes.map((c) => ({
    path: relTo(d, c.abs) ?? c.abs,
    status: c.after === null ? "deleted" : c.before === null ? "created" : "modified",
    before: shownText(c.before),
    after: shownText(c.after),
  }));
}

function remove(d: Internal): void {
  drafts.delete(d.id);
  dropScope(d.shown);
}

// ── public API ─────────────────────────────────────────────────────────────────

/** Opens an empty draft over `cwd`; returns its id. */
export async function openDraft(cwd: string): Promise<string> {
  const d = await create(cwd);
  drafts.set(d.id, d);
  return d.id;
}

/** The draft's public state, or undefined if there is no such draft. */
export function getDraft(id: string): Draft | undefined {
  const d = drafts.get(id);
  return d && { id: d.id, cwd: d.cwd, changes: d.changes, requests: d.requests, shown: d.shown };
}

/**
 * Runs an edit call (the edit tool's parameters) inside the draft: planned against the draft's view,
 * with the same checks and all-or-nothing behaviour, and stored instead of written. Returns the edit
 * tool's result shape (`details.written` false); throws the edit tool's error text on failure.
 */
export async function draftEdit(id: string, params: EditParams): Promise<EditResult> {
  const d = need(id);
  return queued(d, () => editIn(d, params));
}

/** `read` inside the draft: drafted content with the same anchors and paging; records the view in the draft's scope. */
export async function draftRead(id: string, params: { path: string; offset?: number; limit?: number }): Promise<{ content: { type: "text"; text: string }[] }> {
  const d = need(id);
  return queued(d, async () => {
    const abs = await canonicalDeep(resolve(d.cwd, fromHome(params.path)));
    let raw: string;
    const c = d.changes.get(abs);
    if (c) {
      if (c.after === null) throw new Error(`${params.path}: does not exist (deleted in this draft)`);
      raw = c.after;
    } else {
      const info = await stat(abs);
      if (info.isDirectory()) throw new Error(`${params.path} is a directory; use ls or find`);
      const buf = await readFile(abs);
      if (buf.subarray(0, 8192).includes(0)) throw new Error(`${params.path} is binary; a draft reads text files only`);
      raw = buf.toString("utf8");
    }
    const { out, view } = renderAnchored(raw, params.offset, params.limit);
    if (view !== undefined) noteShown(abs, view, d.shown);
    return { content: [{ type: "text", text: out }] };
  });
}

/**
 * Writes the draft to disk as one all-or-nothing commit. If a drafted file changed on disk since it
 * was drafted, the draft's edit calls are replayed in order against the current disk and that result
 * is committed; if any replayed call fails, nothing is written and the error names the moved files.
 * On success the draft is removed and the written files count as shown in the main scope.
 */
export async function applyDraft(id: string): Promise<EditResult> {
  const d = need(id);
  return queued(d, async () => {
    if (!drafts.has(d.id)) throw new Error(`unknown draft ${id}`);
    const editCount = d.requests.reduce((n, r) => n + (r.edits?.length ?? 0), 0);
    let changes = [...d.changes.values()];
    const moved = new Set<string>();
    let drifted: Awaited<ReturnType<typeof drift>> = [];
    for (let attempt = 1; changes.length > 0; attempt++) {
      try {
        const pending = changes;
        drifted = await serially(async () => {
          await commit(pending);
          return drift(pending);
        });
        break;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        for (const p of e.paths) moved.add(relTo(d, p) ?? p);
        if (attempt >= ATTEMPTS) throw new Error(`Nothing was written: ${[...moved].join(", ")} kept changing during ${ATTEMPTS} attempts`);
        const scratch = await create(d.cwd);
        try {
          for (const [i, req] of d.requests.entries()) {
            try {
              await editIn(scratch, req);
            } catch (err) {
              throw new Error(
                `Nothing was written: ${[...moved].join(", ")} changed on disk since drafting, and replaying the draft's edit call ${i + 1} of ${d.requests.length} on the new content failed:\n${(err as Error).message}`,
              );
            }
          }
        } finally {
          dropScope(scratch.shown);
        }
        changes = [...scratch.changes.values()];
      }
    }
    remove(d);
    const reports = reportsOf(d, changes);
    const details: EditDetails = {
      written: changes.length > 0,
      files: reports.map((r) => ({ path: r.path, status: r.status, diff: generateDiffString(r.before ?? "", r.after ?? "").diff })),
    };
    if (changes.length === 0) return { content: [{ type: "text", text: "No changes: the draft leaves every file as it was." }], details };
    // The result shows the new state of every written file, so bare line numbers may refer to it next.
    reports.forEach((r, i) => r.after !== null && noteShown(changes[i].abs, r.after));
    const disk = drifted.length
      ? `WARNING: on re-read these differ from what was written (another process changed them): ${drifted.map((x) => relTo(d, x.abs) ?? x.abs).join(", ")}`
      : "re-read from disk: identical";
    const text = resultText({ editCount, changes, reports, syntax: syntaxSummary(reports), noteText: "" }, disk, moved);
    return { content: [{ type: "text", text }], details };
  });
}

/** Drops the draft without writing anything; false if there was no such draft. */
export function discardDraft(id: string): boolean {
  const d = drafts.get(id);
  if (!d) return false;
  remove(d);
  return true;
}

/** Every drafted file with its status and a unified diff against disk-as-drafted, plus line totals. */
export function draftSummary(id: string): DraftSummary {
  const d = need(id);
  let insertions = 0;
  let deletions = 0;
  const files = reportsOf(d, [...d.changes.values()]).map((r) => {
    const { added, removed } = countChanges(r.before ?? "", r.after ?? "");
    insertions += added;
    deletions += removed;
    return { path: r.path, status: r.status, diff: generateDiffString(r.before ?? "", r.after ?? "").diff };
  });
  return { files, insertions, deletions };
}

/**
 * Writes every drafted file's content into `dir` at its path relative to the draft's cwd, and deletes
 * the files the draft deletes there (for checks in a throwaway worktree). Refuses, writing nothing,
 * if a drafted file lies outside the cwd.
 */
export async function materializeDraft(id: string, dir: string): Promise<void> {
  const d = need(id);
  const targets = [...d.changes.values()].map((c) => ({ c, rel: relTo(d, c.abs) }));
  const outside = targets.filter((t) => t.rel === undefined).map((t) => t.c.abs);
  if (outside.length) throw new Error(`drafted files outside ${d.cwd}: ${outside.join(", ")}`);
  for (const { c, rel } of targets) {
    const to = join(dir, rel!);
    if (c.after === null) await rm(to, { force: true });
    else {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, c.after, "utf8");
    }
  }
}

// ── event channel ──────────────────────────────────────────────────────────────

/** Request/response channel on pi's event bus: `{op, reply, ...}`; `reply` is called exactly once. */
export const DRAFT_EVENT = "multiedit:draft";
/** Emitted once on load with `{version}`, so callers can tell drafts are supported. */
export const DRAFT_READY_EVENT = "multiedit:draft-ready";
export const DRAFT_VERSION = 1;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Handles one channel request; resolves to the reply payload (errors become `{error}` or `{ok: false, error}`). */
export async function handleDraftRequest(req: Record<string, unknown>): Promise<unknown> {
  const { op, draftId } = req;
  const id = String(draftId);
  const known = () => {
    if (!drafts.has(id)) throw new Error(`unknown draft ${String(draftId)}`);
  };
  switch (op) {
    case "open": {
      if (typeof req.cwd !== "string" || !isAbsolute(req.cwd)) return { error: "open needs an absolute cwd" };
      return { draftId: await openDraft(req.cwd) };
    }
    case "edit":
      try {
        known();
        const params = req.params as EditParams | undefined;
        if (!params || !Array.isArray(params.edits)) return { error: "edit needs params: {edits, allowSyntaxErrors?}" };
        return await draftEdit(id, params);
      } catch (e) {
        return { error: message(e) };
      }
    case "read":
      try {
        known();
        if (typeof req.path !== "string") return { error: "read needs path" };
        const { offset, limit } = req as { offset?: number; limit?: number };
        return await draftRead(id, { path: req.path, offset, limit });
      } catch (e) {
        return { error: message(e) };
      }
    case "apply":
      try {
        known();
        return { ok: true, ...(await applyDraft(id)) };
      } catch (e) {
        return { ok: false, error: message(e) };
      }
    case "discard":
      return discardDraft(id) ? { ok: true } : { error: `unknown draft ${String(draftId)}` };
    case "summary":
      try {
        return draftSummary(id);
      } catch (e) {
        return { error: message(e) };
      }
    case "materialize":
      try {
        known();
        if (typeof req.dir !== "string" || !isAbsolute(req.dir)) return { ok: false, error: "materialize needs an absolute dir" };
        await materializeDraft(id, req.dir);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e) };
      }
    default:
      return { error: `unknown op ${String(op)}` };
  }
}

export function listenForDraftRequests(pi: ExtensionAPI): void {
  pi.events.on(DRAFT_EVENT, (data) => {
    const req = (data ?? {}) as Record<string, unknown>;
    const reply = req.reply;
    if (typeof reply !== "function") return;
    let replied = false;
    const once = (result: unknown) => {
      if (replied) return;
      replied = true;
      try {
        reply(result);
      } catch {
        // The caller's callback failing is the caller's problem; never call it twice.
      }
    };
    handleDraftRequest(req).then(once, (e) => once({ error: message(e) }));
  });
  pi.events.emit(DRAFT_READY_EVENT, { version: DRAFT_VERSION });
}
