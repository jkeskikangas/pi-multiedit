import { execFile } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  generateDiffString,
  renderDiff,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { commit, drift, type FileChange } from "./commit.ts";
import { Planner, toRaw, type EditRequest, type Failure } from "./engine.ts";
import { renderReport, type FileReport } from "./feedback.ts";
import { anchorOf } from "./hash.ts";
import { newSyntaxErrors } from "./syntax.ts";
import { splitLines } from "./text.ts";

const run = promisify(execFile);

const editItem = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "File to edit; defaults to the top-level path" })),
    glob: Type.Optional(Type.String({ description: "Edit every git-visible file matching this glob (e.g. lib/**/*.ex) instead of one path" })),
    old: Type.Optional(Type.String({ description: "Selector: exact text" })),
    regex: Type.Optional(Type.String({ description: "Selector: JavaScript regex; new may use $1, $<name>, $&" })),
    flags: Type.Optional(Type.String({ description: "Regex flags (i, m, s, u); g is implied" })),
    ast: Type.Optional(Type.String({ description: "Selector: ast-grep pattern, e.g. Repo.get($S, $ID); new may use $S, $$$ARGS" })),
    lang: Type.Optional(Type.String({ description: "ast-grep language when the extension does not tell" })),
    from: Type.Optional(Type.String({ description: "Selector: range start, a LINE#HASH anchor or exact unique text" })),
    to: Type.Optional(Type.String({ description: "Range end, inclusive (anchor or text after from)" })),
    until: Type.Optional(Type.String({ description: "Range end, exclusive: the range stops where this text begins" })),
    json: Type.Optional(Type.String({ description: "Selector: JSON pointer in a JSON/JSONC file; segments may be [key=value] or - (append)" })),
    new: Type.Optional(Type.Unknown({ description: "Replacement or inserted text; with json, any JSON value" })),
    action: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("before"), Type.Literal("after"), Type.Literal("delete")], {
        description: "replace (default), insert before/after the selection, or delete it",
      }),
    ),
    count: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("all")], {
        description: "Expected number of matches across all target files; default 1",
      }),
    ),
    edits: Type.Optional(Type.Array(Type.Unknown(), { description: "Group: edits that inherit this item's path/glob" })),
    oldText: Type.Optional(Type.String({ description: "Alias of old" })),
    newText: Type.Optional(Type.String({ description: "Alias of new" })),
  },
  { additionalProperties: false },
);

const fileItem = Type.Object(
  {
    path: Type.String(),
    write: Type.Optional(Type.String({ description: "Create or overwrite with this content" })),
    moveTo: Type.Optional(Type.String({ description: "Move/rename to this path" })),
    delete: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const editSchema = Type.Object(
  {
    path: Type.Optional(Type.String({ description: "Default file for edits that name none" })),
    glob: Type.Optional(Type.String({ description: "Default glob for edits that name no path or glob" })),
    edits: Type.Optional(Type.Array(editItem, { description: "Applied in order; each sees the result of the previous ones" })),
    files: Type.Optional(Type.Array(fileItem, { description: "Create, overwrite, move or delete files; runs before edits" })),
    patch: Type.Optional(Type.String({ description: "A Codex apply_patch envelope (*** Begin Patch … *** End Patch); runs first" })),
    dryRun: Type.Optional(Type.Boolean({ description: "Plan and show the diff without writing" })),
    allowSyntaxErrors: Type.Optional(Type.Boolean({ description: "Write even if the edit introduces parse errors (only when the parser is wrong)" })),
  },
  { additionalProperties: false },
);

type Params = EditRequest & { dryRun?: boolean; allowSyntaxErrors?: boolean };

export type EditDetails = {
  files: { path: string; status: FileReport["status"]; diff: string }[];
  written: boolean;
};

const DESCRIPTION = `Edit files: any number of edits across any number of files, applied all-or-nothing in one call.
Every edit is checked in memory first; if any edit fails, nothing is written and every failure is reported at once with nearby LINE#HASH anchors for the retry.

Each edit = one selector + an action:
- old: exact text. A miss retries ignoring trailing whitespace/typographic punctuation, then a uniform indentation shift (new is re-indented to match); the result says so.
- from [+ to | until]: a range. Each end is a LINE#HASH anchor from read (whole lines) or exact text. to is inclusive, until exclusive.
- regex (+ flags): JavaScript regex; new may use $1, $<name>, $&.
- ast (+ lang): ast-grep pattern; $X matches one node, $$$X many; reuse them in new. Multi-line new is indented relative to the match.
- json: JSON pointer for JSON/JSONC files, e.g. /suites/[path=test/a.exs]/layer; "-" appends to an array. new is a JSON value. Only that node changes.
action: replace (default), before, after, delete (also implied when new is omitted). Line-anchored ranges take whole lines: the trailing newline of new is optional, and new: "" removes the lines.
count: matches expected across all targets (default 1, or a number, or "all"); a mismatch fails with the match locations.
glob instead of path applies the edit to every git-visible matching file.

files: write/moveTo/delete whole files, before the edits run (edits then use the new paths). patch: a Codex apply_patch envelope, applied first.
Edits run in order on the evolving content; LINE#HASH anchors always refer to the file as you last read it and are mapped through earlier edits in the same call.
An edit whose old text is gone but whose new text is present fails like any miss, naming where new already is (drop it if it was applied before).
The result lists only changed lines: +N#HH:text for added lines and ~N#HH:… with [-removed-]{+added+} for rewritten lines; those anchors are valid for the next call.
An edit that introduces a parse error in a file with a known grammar is refused like any failure (errors already in the file do not count); allowSyntaxErrors overrides this when the parser is wrong.
The result is the verified on-disk state: files are re-read after writing. Do not re-read, cat or git diff to confirm an edit.`;

const SNIPPET = "Atomic multi-file edits: exact text, LINE#HASH ranges, regex, ast-grep, JSON pointer, file create/move/delete, in one call";

const GUIDELINES = [
  "Put every edit for a change — across all files — into one edit call instead of several calls or a shell script.",
  "Prefer from/to LINE#HASH anchors from read for replacing or deleting blocks; use old for short unique snippets.",
  "Use glob + count for the same rewrite in many files; ast for code-structural rewrites; json for JSON data files.",
  "Do not use python, sed, perl or heredocs to edit files.",
];

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

async function readText(abs: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EISDIR") throw new Error(`${abs} is a directory`);
    throw e;
  }
  if (isBinary(buf)) throw new Error(`${abs} is binary; this tool edits text`);
  const text = buf.toString("utf8");
  // Decoding invalid UTF-8 replaces bytes with U+FFFD, and writing it back would corrupt the file.
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`${abs} is not valid UTF-8; this tool would corrupt it`);
  return text;
}

/** Symlinks resolved; for a path that does not exist yet, its directory is resolved instead. */
async function canonical(abs: string): Promise<string> {
  try {
    return await realpath(abs);
  } catch {
    try {
      return join(await realpath(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

async function isSymlink(abs: string): Promise<boolean> {
  return (await lstat(abs).catch(() => undefined))?.isSymbolicLink() ?? false;
}

async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxBuffer: 256 << 20 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    const { glob } = await import("node:fs/promises");
    const out: string[] = [];
    for await (const p of glob("**/*", { cwd, exclude: (p: string) => /(^|\/)(node_modules|\.git|_build|deps|dist)$/.test(p) })) {
      out.push(p as string);
    }
    return out;
  }
}

function syntaxSummary(reports: FileReport[]): { summary: string; warning?: string; broken?: boolean } {
  let checked = 0;
  const broken: string[] = [];
  for (const r of reports) {
    if (r.after === null) continue;
    const path = r.movedTo ?? r.path;
    const lines = newSyntaxErrors(path, r.before, r.after);
    if (lines === undefined) continue;
    checked++;
    if (lines.length) {
      // Each error with a line of context either side, anchored, so the retry needs no re-read.
      const text = splitLines(r.after);
      const shown = new Set(lines.slice(0, 3).flatMap((n) => [n - 1, n, n + 1]).filter((n) => n >= 1 && n <= text.length));
      broken.push(`${path}\n${[...shown].sort((a, b) => a - b).map((n) => `  ${anchorOf(n, text[n - 1])}:${text[n - 1]}`).join("\n")}`);
    }
  }
  if (checked === 0) return { summary: "syntax: no grammar for these files" };
  if (broken.length === 0) return { summary: `syntax: ok (${checked} file(s))` };
  return { summary: `syntax: NEW ERRORS in ${broken.length} file(s)`, warning: `New parse errors near:\n${broken.join("\n")}`, broken: true };
}

function formatFailures(failures: Failure[], total: number): string {
  const lines = [`Nothing was written: ${failures.length} of ${total} step(s) failed.`];
  for (const f of failures) {
    lines.push("", `step ${f.edit}${f.path ? ` (${f.path})` : ""}: ${f.message}`);
    for (const h of f.hints ?? []) lines.push(h.startsWith("@") || /^\s*\d+#/.test(h) ? `nearest:\n${h}` : `  ${h}`);
  }
  return lines.join("\n");
}

async function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(paths)].sort();
  const step = (i: number): Promise<T> => (i === sorted.length ? fn() : withFileMutationQueue(sorted[i], () => step(i + 1)));
  return step(0);
}

export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: DESCRIPTION,
    promptSnippet: SNIPPET,
    promptGuidelines: GUIDELINES,
    parameters: editSchema,
    async execute(_id, params: Params, signal, _onUpdate, ctx: ExtensionContext) {
      const planner = new Planner(ctx.cwd, { read: readText, list: listFiles, canonical, isSymlink });
      const plan = await planner.run(params);
      if (plan.failures.length) throw new Error(formatFailures(plan.failures, plan.editCount));
      signal?.throwIfAborted();

      const changed = [...plan.files.values()].filter((st) => st.cur !== st.orig || (st.orig === null && st.cur !== null));
      const changes: FileChange[] = [];
      for (const st of changed) {
        let mode: number | undefined;
        if (st.orig === null && st.movedFrom) mode = (await stat(st.movedFrom).catch(() => undefined))?.mode;
        changes.push({ abs: st.abs, before: st.raw, after: toRaw(st, st.cur), mode: mode === undefined ? undefined : mode & 0o7777 });
      }
      const movedTo = new Map(changed.filter((s) => s.movedFrom).map((s) => [s.movedFrom!, s]));
      const reports: FileReport[] = [];
      for (const st of changed) {
        const rel = planner.rel(st.abs);
        if (st.movedFrom && movedTo.get(st.movedFrom) === st) continue;
        const dest = movedTo.get(st.abs);
        if (dest && st.cur === null) {
          reports.push({ path: rel, status: "moved", movedTo: planner.rel(dest.abs), before: st.orig, after: dest.cur });
        } else if (st.cur === null) reports.push({ path: rel, status: "deleted", before: st.orig, after: null });
        else if (st.orig === null) reports.push({ path: rel, status: "created", before: null, after: st.cur });
        else reports.push({ path: rel, status: "modified", before: st.orig, after: st.cur });
      }
      const details: EditDetails = {
        written: false,
        files: reports.map((r) => ({ path: r.movedTo ? `${r.path} -> ${r.movedTo}` : r.path, status: r.status, diff: generateDiffString(r.before ?? "", r.after ?? "").diff })),
      };
      const noteText = plan.notes.map((n) => `step ${n.edit}: ${n.text}`).join("\n");
      const body = renderReport(reports);
      if (changes.length === 0) {
        return { content: [{ type: "text", text: ["No changes: the edits leave every file as it was.", noteText].filter(Boolean).join("\n") }], details };
      }
      const syntax = syntaxSummary(reports);
      if (syntax.broken && !params.allowSyntaxErrors && !params.dryRun) {
        throw new Error(
          `Nothing was written: the edit introduces parse errors. Fix them in the retry, or set allowSyntaxErrors if the parser is wrong.\n${syntax.warning}`,
        );
      }
      if (params.dryRun) {
        return { content: [{ type: "text", text: [`Dry run, nothing written. ${changes.length} file(s) would change; ${syntax.summary}.`, syntax.warning, noteText, body].filter(Boolean).join("\n\n") }], details };
      }

      await withLocks(changes.map((c) => c.abs), () => commit(changes));
      details.written = true;
      const drifted = await drift(changes);
      const disk = drifted.length
        ? `WARNING: on re-read these differ from what was written (another process changed them): ${drifted.map((d) => planner.rel(d.abs)).join(", ")}`
        : "re-read from disk: identical";
      const out = [`Applied ${plan.editCount} step(s) to ${changes.length} file(s); ${disk}; ${syntax.summary}.`];
      if (syntax.warning) out.push(syntax.warning);
      if (noteText) out.push(noteText);
      out.push(body);

      return { content: [{ type: "text", text: out.join("\n\n") }], details };
    },

    renderCall(args: Params, theme) {
      const targets = new Set<string>();
      if (args.path) targets.add(args.path);
      for (const e of args.edits ?? []) targets.add(e.glob ?? e.path ?? args.path ?? "?");
      for (const f of args.files ?? []) targets.add(f.path);
      if (args.patch) for (const m of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) targets.add(m[1].trim());
      const n = (args.edits?.length ?? 0) + (args.files?.length ?? 0);
      const list = [...targets];
      const shown = list.slice(0, 3).join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "");
      const flags = args.dryRun ? "dry run" : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shown)}${n > 1 ? theme.fg("muted", ` (${n} steps)`) : ""}${flags ? theme.fg("muted", ` · ${flags}`) : ""}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, context) {
      const container = new Container();
      const details = result.details as EditDetails | undefined;
      if (context.isError || !details) {
        const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        container.addChild(new Text(theme.fg(context.isError ? "error" : "muted", text), 1, 0));
        return container;
      }
      for (const f of details.files) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", `${f.path} (${f.status})`), 1, 0));
        if (f.diff && f.status !== "deleted") container.addChild(new Text(renderDiff(f.diff), 1, 0));
      }
      if (!details.written) container.addChild(new Text(theme.fg("muted", "nothing written"), 1, 0));
      return container;
    },
  });
}
