import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
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

// Field semantics live in DESCRIPTION; the schema carries types only, since both are sent every turn.
const editItem = Type.Object(
  {
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    old: Type.Optional(Type.String()),
    regex: Type.Optional(Type.String()),
    flags: Type.Optional(Type.String()),
    ast: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    json: Type.Optional(Type.String()),
    new: Type.Optional(Type.Unknown({ description: "string; any JSON value with json" })),
    action: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("before"), Type.Literal("after"), Type.Literal("delete")])),
    count: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("all")])),
  },
  { additionalProperties: false },
);

export const editSchema = Type.Object(
  {
    edits: Type.Array(editItem),
    allowSyntaxErrors: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

type Params = EditRequest & { allowSyntaxErrors?: boolean };

export type EditDetails = {
  files: { path: string; status: FileReport["status"]; diff: string }[];
  written: boolean;
};

const DESCRIPTION = `Edit files: many edits across many files in one call, all-or-nothing. If any edit fails, nothing is written and every failure is listed with nearby N#HH anchors.

Each edit: a scope (path, or glob over git-visible files), at most one selector, optional action and count.
Selectors:
- old: exact text. A miss retries ignoring trailing whitespace/curly quotes, then a uniform indentation shift (re-indenting new), and says so.
- from [+ to]: whole lines from one anchor to another, inclusive; an anchor is N#HH or N#HH:content from read (content checked exactly), or exact text.
- regex (+ flags): JS regex; new may use $1, $<name>, $&.
- ast: ast-grep pattern; reuse $X / $$$X in new.
- json: JSON pointer; segments are keys, indexes, - (append) or [key=value]. new is the JSON value itself, e.g. "unit", 3, {"path": "a"}.
- none: the whole file (path only): new creates or overwrites it, before/after prepends/appends, delete deletes it.
action: replace (default), before, after, delete (default without new). On line ranges new is whole lines; new: "" removes them.
count: expected matches across the scope: 1 (default), a number, or "all".
Edits run in order; anchors refer to the file as last read and are mapped through earlier edits.
An edit that introduces a parse error is refused (existing errors don't count); allowSyntaxErrors only if the parser is wrong.
The result is the re-read disk state, changed lines only (+N#HH:text added, ~N#HH:[-old-]{+new+} rewritten), with anchors usable next call. Don't re-read or git diff to confirm.

Example:
{"edits": [
  {"path": "lib/a.ex", "old": "Repo.get(User, id)", "new": "Repo.get!(User, id)"},
  {"path": "lib/a.ex", "from": "12#KT", "to": "15#BH", "action": "delete"},
  {"path": "lib/b.ex", "new": "defmodule B do\nend\n"},
  {"path": "test/layers.json", "json": "/suites/-", "new": {"path": "test/b_test.exs", "layer": "unit"}},
  {"glob": "lib/**/*.ex", "ast": "Logger.debug($MSG)", "action": "delete", "count": "all"}
]}`;

const SNIPPET = "All-or-nothing edits across many files in one call";

const GUIDELINES = [
  "Make all edits for a change, across files, in one edit call; never edit files with python, sed, perl or heredocs.",
  "Use from/to anchors for blocks, old for short snippets, glob + count for repeated rewrites, ast for code shapes, json for data.",
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
    const path = r.path;
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
      const changes: FileChange[] = changed.map((st) => ({ abs: st.abs, before: st.raw, after: toRaw(st, st.cur) }));
      const reports: FileReport[] = changed.map((st) => ({
        path: planner.rel(st.abs),
        status: st.cur === null ? "deleted" : st.orig === null ? "created" : "modified",
        before: st.orig,
        after: st.cur,
      }));
      const details: EditDetails = {
        written: false,
        files: reports.map((r) => ({ path: r.path, status: r.status, diff: generateDiffString(r.before ?? "", r.after ?? "").diff })),
      };
      const noteText = plan.notes.map((n) => `step ${n.edit}: ${n.text}`).join("\n");
      const body = renderReport(reports);
      if (changes.length === 0) {
        return { content: [{ type: "text", text: ["No changes: the edits leave every file as it was.", noteText].filter(Boolean).join("\n") }], details };
      }
      const syntax = syntaxSummary(reports);
      if (syntax.broken && !params.allowSyntaxErrors) {
        throw new Error(
          `Nothing was written: the edit introduces parse errors. Fix them in the retry, or set allowSyntaxErrors if the parser is wrong.\n${syntax.warning}`,
        );
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
      const targets = [...new Set((args.edits ?? []).map((e) => e.glob ?? e.path ?? "?"))];
      const shown = targets.slice(0, 3).join(", ") + (targets.length > 3 ? ` +${targets.length - 3}` : "");
      const n = args.edits?.length ?? 0;
      return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", shown)}${n > 1 ? theme.fg("muted", ` (${n} edits)`) : ""}`, 0, 0);
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
