import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { registerReadTool } from "../src/read.ts";
import { registerEditTool } from "../src/tool.ts";

type Registered = { name: string; execute: Function };
const tools = new Map<string, Registered>();
const pi = { registerTool: (t: Registered) => tools.set(t.name, t) };
registerEditTool(pi as never);
registerReadTool(pi as never);

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-tool-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
after(async () => rm(dir, { recursive: true, force: true }));

/** Test shorthand: `path` beside `edits` scopes every edit that names none. */
const run = (params: { path?: string; edits?: object[]; [k: string]: unknown }) => {
  const { path, edits, ...rest } = params;
  const scopedEdits = edits?.map((e) => ("path" in e || "glob" in e ? e : { ...e, path }));
  return tools.get("edit")!.execute("id", { ...rest, edits: scopedEdits }, undefined, undefined, { cwd: dir });
};
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

test("failure is an error result listing every failure, and nothing is written", async () => {
  await writeFile(join(dir, "a.txt"), "one\n");
  await assert.rejects(
    run({ edits: [{ path: "a.txt", old: "one", new: "1" }, { path: "a.txt", old: "zzz", new: "2" }, { path: "b.txt", old: "q", new: "3" }] }),
    (e: Error) => /Nothing was written: 2 of 3/.test(e.message) && /step 2/.test(e.message) && /step 3/.test(e.message),
  );
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "one\n");
});




test("read tags lines with anchors that edit accepts", async () => {
  await writeFile(join(dir, "r.txt"), "first\nsecond\n");
  const r = await tools.get("read")!.execute("id", { path: "r.txt" }, undefined, undefined, { cwd: dir });
  const anchor = /^(\d+#[A-Z]{2}):second$/m.exec(text(r))![1];
  await run({ path: "r.txt", edits: [{ from: anchor, new: "SECOND" }] });
  assert.equal(await readFile(join(dir, "r.txt"), "utf8"), "first\nSECOND\n");
});

test("read pages long files and says where to continue", async () => {
  await writeFile(join(dir, "long.txt"), Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
  const r = await tools.get("read")!.execute("id", { path: "long.txt", offset: 10, limit: 5 }, undefined, undefined, { cwd: dir });
  assert.match(text(r), /^10#[A-Z]{2}:l10$/m);
  assert.match(text(r), /Lines 10-14 of 30\. Continue with offset=15/);
});

test("an edit that introduces a parse error is refused with the broken lines, and nothing is written", async () => {
  await writeFile(join(dir, "s.ts"), "const a = 1;\nconst b = 2;\n");
  await assert.rejects(
    run({ path: "s.ts", edits: [{ old: "const b = 2;", new: "const b = (2;" }] }),
    (e: Error) => /Nothing was written: the edit introduces parse errors/.test(e.message) && /s\.ts\n {2}1#[A-Z]{2}:const a = 1;\n {2}2#[A-Z]{2}:const b = \(2;/.test(e.message),
  );
  assert.equal(await readFile(join(dir, "s.ts"), "utf8"), "const a = 1;\nconst b = 2;\n");
});

test("allowSyntaxErrors writes anyway and still reports the errors", async () => {
  await writeFile(join(dir, "o.ts"), "const b = 2;\n");
  const r = await run({ path: "o.ts", edits: [{ old: "const b = 2;", new: "const b = (2;" }], allowSyntaxErrors: true });
  assert.match(text(r), /syntax: NEW ERRORS in 1 file/);
  assert.equal(await readFile(join(dir, "o.ts"), "utf8"), "const b = (2;\n");
});

test("a file that was already broken stays editable", async () => {
  await writeFile(join(dir, "p.ts"), "const a = (1;\nconst b = 2;\n");
  const r = await run({ path: "p.ts", edits: [{ old: "const b = 2;", new: "const b = 3;" }] });
  assert.match(text(r), /syntax: ok/);
});

test("the schema accepts the canonical shape and rejects everything else", async () => {
  const { editSchema } = await import("../src/tool.ts");
  const { Value } = await import("typebox/value");
  const ok = (v: unknown) => Value.Check(editSchema, v);
  assert.ok(ok({ edits: [{ path: "a.ts", old: "x", new: "y" }, { path: "a.ts", from: "3#KT", to: "5#BH", action: "delete" }] }));
  assert.ok(ok({ edits: [{ path: "l.json", json: "/suites/-", new: { path: "t.exs" } }, { glob: "**/*.ex", regex: "f\\((\\w+)\\)", new: "g($1)", count: "all" }] }));
  assert.ok(ok({ edits: [{ path: "new.ts", new: "x" }, { path: "old.ts", action: "delete" }], allowSyntaxErrors: true }));
  for (const [why, bad] of Object.entries({
    "top-level path": { path: "a.ts", edits: [{ old: "x", new: "y" }] },
    patch: { patch: "*** Begin Patch\n*** End Patch" },
    files: { files: [{ path: "a.ts", delete: true }] },
    dryRun: { edits: [], dryRun: true },
    until: { edits: [{ path: "a.ts", from: "x", until: "y" }] },
    ast: { edits: [{ path: "a.ts", ast: "f($A)", new: "g($A)" }] },
    aliases: { edits: [{ path: "a.ts", oldText: "x", newText: "y" }] },
    groups: { edits: [{ path: "a.ts", edits: [{ old: "x", new: "y" }] }] },
    "count below 1": { edits: [{ path: "a.ts", old: "x", new: "y", count: 0 }] },
  })) assert.ok(!ok(bad), why);
});

test("new must be a string outside json", async () => {
  await writeFile(join(dir, "n.txt"), "x\n");
  await assert.rejects(run({ path: "n.txt", edits: [{ old: "x", new: 1 }] }), /new must be a string; only json takes a JSON value/);
});

test("the example in the tool description is valid JSON that the schema accepts", async () => {
  const { editSchema } = await import("../src/tool.ts");
  const { Value } = await import("typebox/value");
  const description = tools.get("edit")!.description as string;
  const example = JSON.parse(description.slice(description.indexOf('{"edits"')));
  assert.ok(Value.Check(editSchema, example));
});
