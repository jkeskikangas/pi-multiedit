import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import extension from "../index.ts";
import {
  applyDraft,
  discardDraft,
  draftEdit,
  draftRead,
  draftSummary,
  DRAFT_EVENT,
  DRAFT_READY_EVENT,
  getDraft,
  materializeDraft,
  openDraft,
} from "../src/draft.ts";
import { formatAnchored } from "../src/hash.ts";
import { registerReadTool } from "../src/read.ts";
import { registerEditTool } from "../src/tool.ts";

type Registered = { name: string; execute: Function };
const tools = new Map<string, Registered>();
const pi = { registerTool: (t: Registered) => tools.set(t.name, t) };
registerEditTool(pi as never);
registerReadTool(pi as never);

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-draft-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
after(async () => rm(dir, { recursive: true, force: true }));

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const disk = (p: string) => readFile(join(dir, p), "utf8").catch(() => null);
const mainEdit = (edits: object[]) => tools.get("edit")!.execute("id", { edits }, undefined, undefined, { cwd: dir });
const mainRead = (path: string) => tools.get("read")!.execute("id", { path }, undefined, undefined, { cwd: dir });
const anchorOf = (out: string, line: string) => new RegExp(`^\\s*(\\d+#[A-Z]{2}):${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(out)![1];

test("edits in a draft leave the disk alone, and later edits and reads see the earlier ones", async () => {
  await writeFile(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const id = await openDraft(dir);
  const r1 = await draftEdit(id, { edits: [{ path: "a.ts", old: "const a = 1;", new: "const a = 10;" }] });
  assert.match(text(r1), /^Applied 1 step\(s\) to 1 file\(s\); drafted, not written; syntax: ok \(1 file\(s\)\)\./);
  assert.doesNotMatch(text(r1), /re-read from disk/);
  assert.equal(r1.details.written, false);
  assert.equal(r1.details.files[0].status, "modified");
  assert.equal(await disk("a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");

  // read in the draft shows drafted content, with the anchors the normal read would give it.
  const shown = text(await draftRead(id, { path: "a.ts" }));
  assert.equal(shown, formatAnchored(["const a = 10;", "const b = 2;", "const c = 3;"], 1));
  const r2 = await draftEdit(id, { edits: [{ path: "a.ts", from: anchorOf(shown, "const a = 10;"), to: anchorOf(shown, "const b = 2;"), new: "const ab = 12;\n" }] });
  assert.match(text(r2), /drafted, not written/);
  assert.equal(text(await draftRead(id, { path: "a.ts" })), formatAnchored(["const ab = 12;", "const c = 3;"], 1));
  assert.equal(await disk("a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  // before stays the disk content from when the draft first touched the file; after is the latest.
  const change = [...getDraft(id)!.changes.values()][0];
  assert.equal(change.before, "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  assert.equal(change.after, "const ab = 12;\nconst c = 3;\n");
  discardDraft(id);
});

test("draft read pages like read", async () => {
  await writeFile(join(dir, "long.txt"), Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "long.txt", old: "l12\n", new: "twelve\n" }] });
  const r = text(await draftRead(id, { path: "long.txt", offset: 10, limit: 5 }));
  assert.match(r, /^12#[A-Z]{2}:twelve$/m);
  assert.match(r, /Lines 10-14 of 30\. Continue with offset=15/);
  await assert.rejects(draftRead(id, { path: "long.txt", offset: 40 }), /offset 40 is past the end/);
  discardDraft(id);
});

test("files a draft creates and deletes exist, or not, in its view, its listing and globs", async () => {
  await writeFile(join(dir, "keep.md"), "keep x\n");
  await writeFile(join(dir, "gone.md"), "gone x\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "sub/new.md", new: "new x\n" }, { path: "gone.md", action: "delete" }] });
  assert.equal(await disk("sub/new.md"), null);
  assert.equal(await disk("gone.md"), "gone x\n");
  assert.match(text(await draftRead(id, { path: "sub/new.md" })), /^1#[A-Z]{2}:new x$/);
  await assert.rejects(draftRead(id, { path: "gone.md" }), /does not exist \(deleted in this draft\)/);
  // The glob sees the created file and not the deleted one.
  const r = await draftEdit(id, { edits: [{ glob: "**/*.md", old: "x", new: "y", count: "all" }] });
  assert.deepEqual(r.details.files.map((f) => f.path).sort(), ["keep.md", "sub/new.md"]);
  assert.equal(await disk("keep.md"), "keep x\n");
  assert.deepEqual(
    draftSummary(id).files.map((f) => [f.path, f.status]).sort(),
    [["gone.md", "deleted"], ["keep.md", "modified"], ["sub/new.md", "created"]],
  );
  // A file created then deleted in the draft drops out of it.
  await draftEdit(id, { edits: [{ path: "sub/new.md", action: "delete" }] });
  assert.deepEqual(draftSummary(id).files.map((f) => f.path).sort(), ["gone.md", "keep.md"]);
  discardDraft(id);
});

test("a failing draft edit leaves the draft as it was, with the edit tool's errors and syntax check", async () => {
  await writeFile(join(dir, "f.ts"), "const f = 1;\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "f.ts", old: "const f = 1;", new: "const f = 2;" }] });
  const before = draftSummary(id);
  await assert.rejects(
    draftEdit(id, { edits: [{ path: "f.ts", old: "const f = 2;", new: "const f = 3;" }, { path: "f.ts", old: "zzz", new: "q" }] }),
    /Nothing was written: 1 of 2 step\(s\) failed/,
  );
  await assert.rejects(draftEdit(id, { edits: [{ path: "f.ts", old: "const f = 2;", new: "const f = (2;" }] }), /introduces parse errors/);
  assert.deepEqual(draftSummary(id), before);
  assert.equal(getDraft(id)!.requests.length, 1);
  const forced = await draftEdit(id, { edits: [{ path: "f.ts", old: "const f = 2;", new: "const f = (2;" }], allowSyntaxErrors: true });
  assert.match(text(forced), /syntax: NEW ERRORS in 1 file/);
  discardDraft(id);
});

test("apply on an unchanged disk writes exactly the drafted bytes, and the result counts as shown", async () => {
  await writeFile(join(dir, "crlf.txt"), "\uFEFFone\r\ntwo\r\n");
  await writeFile(join(dir, "old.txt"), "bye\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "crlf.txt", old: "two", new: "TWO" }, { path: "made/new.txt", new: "hi\n" }, { path: "old.txt", action: "delete" }] });
  const drafted = new Map([...getDraft(id)!.changes.values()].map((c) => [c.abs, c.after]));
  const r = await applyDraft(id);
  assert.match(text(r), /^Applied 3 step\(s\) to 3 file\(s\); re-read from disk: identical;/);
  assert.equal(r.details.written, true);
  assert.deepEqual(r.details.files.map((f) => [f.path, f.status]).sort(), [["crlf.txt", "modified"], ["made/new.txt", "created"], ["old.txt", "deleted"]]);
  assert.equal(await disk("crlf.txt"), "\uFEFFone\r\nTWO\r\n");
  for (const [abs, after] of drafted) assert.equal(await readFile(abs, "utf8").catch(() => null), after);
  assert.equal(await disk("old.txt"), null);
  assert.equal(getDraft(id), undefined);
  // Like a normal edit result, the applied files are now shown in the main scope.
  await mainEdit([{ path: "crlf.txt", from: "2", new: "three" }]);
  assert.equal(await disk("crlf.txt"), "\uFEFFone\r\nthree\r\n");
});

test("apply after an unrelated change to a drafted file replays the draft on top of it", async () => {
  await writeFile(join(dir, "r.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const id = await openDraft(dir);
  await draftRead(id, { path: "r.ts" });
  // A bare line number from the draft's read, then an anchor from the draft's previous result.
  const r1 = await draftEdit(id, { edits: [{ path: "r.ts", from: "1", new: "const a = 10;" }] });
  await draftEdit(id, { edits: [{ path: "r.ts", from: /^~(\d+#[A-Z]{2}):/m.exec(text(r1))![1], action: "after", new: "const a2 = 11;" }] });
  await writeFile(join(dir, "r.ts"), "const a = 1;\nconst b = 2;\nconst c = 30;\n");
  const r = await applyDraft(id);
  assert.match(text(r), /re-planned on top of concurrent changes to: r\.ts/);
  assert.equal(await disk("r.ts"), "const a = 10;\nconst a2 = 11;\nconst b = 2;\nconst c = 30;\n");
  assert.equal(getDraft(id), undefined);
});

test("apply after a change under a drafted anchor fails, writing nothing", async () => {
  await writeFile(join(dir, "s.ts"), "const a = 1;\nconst b = 2;\n");
  await writeFile(join(dir, "t.ts"), "const t = 1;\n");
  const id = await openDraft(dir);
  const shown = text(await draftRead(id, { path: "s.ts" }));
  await draftEdit(id, { edits: [{ path: "s.ts", from: anchorOf(shown, "const a = 1;"), new: "const a = 10;" }, { path: "t.ts", old: "1", new: "2" }] });
  await writeFile(join(dir, "s.ts"), "const a = 5;\nconst b = 2;\n");
  await assert.rejects(applyDraft(id), (e: Error) => /Nothing was written: s\.ts changed on disk since drafting/.test(e.message) && /is stale/.test(e.message));
  assert.equal(await disk("s.ts"), "const a = 5;\nconst b = 2;\n");
  assert.equal(await disk("t.ts"), "const t = 1;\n");
  assert.ok(getDraft(id), "the draft stays for the caller to discard");
  assert.equal(discardDraft(id), true);
  assert.equal(discardDraft(id), false);
  await assert.rejects(draftEdit(id, { edits: [] }), /unknown draft/);
});

test("line numbers seen in a draft do not validate bare numbers in the main scope, and the reverse", async () => {
  await writeFile(join(dir, "d.txt"), "one\ntwo\n");
  await writeFile(join(dir, "m.txt"), "one\ntwo\n");
  const id = await openDraft(dir);
  await draftRead(id, { path: "d.txt" });
  await assert.rejects(mainEdit([{ path: "d.txt", from: "2", new: "TWO" }]), /has not been shown/);
  await mainRead("m.txt");
  await assert.rejects(draftEdit(id, { edits: [{ path: "m.txt", from: "2", new: "TWO" }] }), /has not been shown/);
  // Each scope's own view still works.
  await draftEdit(id, { edits: [{ path: "d.txt", from: "2", new: "TWO" }] });
  await mainEdit([{ path: "m.txt", from: "2", new: "TWO" }]);
  assert.equal(await disk("m.txt"), "one\nTWO\n");
  discardDraft(id);
});

test("summary counts inserted and deleted lines", async () => {
  await writeFile(join(dir, "sum.txt"), "a\nb\nc\n");
  await writeFile(join(dir, "del.txt"), "x\ny\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "sum.txt", old: "b\n", new: "B\nB2\n" }, { path: "del.txt", action: "delete" }, { path: "add.txt", new: "1\n2\n3\n" }] });
  const s = draftSummary(id);
  assert.equal(s.insertions, 2 + 3);
  assert.equal(s.deletions, 1 + 2);
  const sum = s.files.find((f) => f.path === "sum.txt")!;
  assert.match(sum.diff, /-2 b/);
  assert.match(sum.diff, /\+2 B/);
  discardDraft(id);
});

test("materialize writes the drafted files into another directory and refuses paths outside the cwd", async () => {
  await writeFile(join(dir, "mat.txt"), "old\n");
  await writeFile(join(dir, "matdel.txt"), "x\n");
  const id = await openDraft(dir);
  await draftEdit(id, { edits: [{ path: "mat.txt", old: "old", new: "new" }, { path: "deep/m.txt", new: "m\n" }, { path: "matdel.txt", action: "delete" }] });
  const out = await mkdtemp(join(tmpdir(), "multiedit-mat-"));
  await writeFile(join(out, "matdel.txt"), "x\n");
  await materializeDraft(id, out);
  assert.equal(await readFile(join(out, "mat.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(out, "deep/m.txt"), "utf8"), "m\n");
  assert.equal(await readFile(join(out, "matdel.txt"), "utf8").catch(() => null), null);
  assert.equal(await disk("mat.txt"), "old\n");
  discardDraft(id);

  const inner = join(dir, "inner");
  await mkdir(inner);
  const id2 = await openDraft(inner);
  await draftEdit(id2, { edits: [{ path: "../outside.txt", new: "o\n" }] });
  const out2 = await mkdtemp(join(tmpdir(), "multiedit-mat-"));
  await assert.rejects(materializeDraft(id2, out2), /outside/);
  discardDraft(id2);
  await rm(out, { recursive: true, force: true });
  await rm(out2, { recursive: true, force: true });
});

test("the event channel round-trips every op and replies exactly once, errors included", async () => {
  const subs = new Map<string, ((data: unknown) => void)[]>();
  const bus = {
    on: (ch: string, h: (data: unknown) => void) => (subs.set(ch, [...(subs.get(ch) ?? []), h]), () => {}),
    emit: (ch: string, data: unknown) => subs.get(ch)?.forEach((h) => h(data)),
  };
  const ready: unknown[] = [];
  bus.on(DRAFT_READY_EVENT, (d) => ready.push(d));
  extension({ registerTool: () => {}, on: () => {}, getActiveTools: () => [], setActiveTools: () => {}, events: bus } as never);
  assert.deepEqual(ready, [{ version: 1 }]);

  const calls: unknown[][] = [];
  const ask = (req: object) =>
    new Promise<any>((done) => {
      const replies: unknown[] = [];
      calls.push(replies);
      bus.emit(DRAFT_EVENT, {
        ...req,
        reply: (r: unknown) => {
          replies.push(r);
          done(r);
        },
      });
    });

  await writeFile(join(dir, "ev.txt"), "alpha\nbeta\n");
  const { draftId } = await ask({ op: "open", cwd: dir });
  assert.equal(typeof draftId, "string");
  const edited = await ask({ op: "edit", draftId, params: { edits: [{ path: "ev.txt", old: "beta", new: "BETA" }] } });
  assert.match(edited.content[0].text, /drafted, not written/);
  assert.equal(edited.details.written, false);
  assert.match((await ask({ op: "edit", draftId, params: { edits: [{ path: "ev.txt", old: "nope", new: "x" }] } })).error, /Nothing was written/);
  assert.match((await ask({ op: "read", draftId, path: "ev.txt", offset: 2 })).content[0].text, /^2#[A-Z]{2}:BETA$/);
  assert.match((await ask({ op: "read", draftId, path: "missing.txt" })).error, /ENOENT/);
  const summary = await ask({ op: "summary", draftId });
  assert.deepEqual([summary.insertions, summary.deletions, summary.files[0].path], [1, 1, "ev.txt"]);
  const out = await mkdtemp(join(tmpdir(), "multiedit-ev-"));
  assert.deepEqual(await ask({ op: "materialize", draftId, dir: out }), { ok: true });
  assert.equal(await readFile(join(out, "ev.txt"), "utf8"), "alpha\nBETA\n");
  await rm(out, { recursive: true, force: true });
  assert.equal(await disk("ev.txt"), "alpha\nbeta\n");
  const applied = await ask({ op: "apply", draftId });
  assert.equal(applied.ok, true);
  assert.match(applied.content[0].text, /re-read from disk: identical/);
  assert.equal(applied.details.files[0].path, "ev.txt");
  assert.equal(await disk("ev.txt"), "alpha\nBETA\n");

  // Unknown drafts and ops, and a failing apply, all reply with an error.
  assert.match((await ask({ op: "apply", draftId })).error, /unknown draft/);
  assert.equal((await ask({ op: "apply", draftId })).ok, false);
  for (const op of ["edit", "read", "discard", "summary", "materialize"]) {
    assert.match((await ask({ op, draftId: "nope", path: "x", dir: "/tmp", params: { edits: [] } })).error, /unknown draft/, op);
  }
  assert.match((await ask({ op: "fly" })).error, /unknown op/);
  const { draftId: other } = await ask({ op: "open", cwd: dir });
  assert.deepEqual(await ask({ op: "discard", draftId: other }), { ok: true });

  // A reply callback that throws is still called only once.
  let thrown = 0;
  bus.emit(DRAFT_EVENT, { op: "fly", reply: () => (thrown++, assert.fail("boom")) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(thrown, 1);
  await new Promise((r) => setTimeout(r, 20));
  for (const replies of calls) assert.equal(replies.length, 1);
});
