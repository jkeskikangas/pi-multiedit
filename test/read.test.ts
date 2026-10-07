// read v2: batched reads, search, outline, file listing, an "unchanged" cache and an output budget.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { anchorOf } from "../src/hash.ts";
import { registerReadTool } from "../src/read.ts";
import { registerEditTool } from "../src/tool.ts";

type Tool = { name: string; description: string; execute: Function };

/** A fresh extension instance: its own read cache and session-event handlers. */
function instance() {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Function>();
  const pi = { registerTool: (t: Tool) => tools.set(t.name, t), on: (e: string, h: Function) => handlers.set(e, h) };
  registerReadTool(pi as never);
  registerEditTool(pi as never);
  const call = async (name: string, params: object) => {
    const r = await tools.get(name)!.execute("id", params, undefined, undefined, { cwd: dir });
    return r.content.map((c: { text?: string }) => c.text ?? "").join("\n") as string;
  };
  return { read: (params: object) => call("read", params), edit: (params: object) => call("edit", params), handlers, tools };
}

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-read-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(
    join(dir, "src/repo.ts"),
    [
      'import { db } from "./db";',
      "",
      "export interface Row { id: string }",
      "",
      "export class Repo {",
      "  find(id: string): Row | null {",
      "    return db.get(id);",
      "  }",
      "",
      "  findOrThrow(id: string): Row {",
      "    const row = this.find(id);",
      '    if (!row) throw new Error("not found");',
      "    return row;",
      "  }",
      "}",
      "",
      "export const repo = new Repo();",
      "",
      "export function count(): number {",
      "  return db.size();",
      "}",
    ].join("\n") + "\n",
  );
  await writeFile(join(dir, "src/users.ts"), 'import { repo } from "./repo";\n\nexport const fetchUser = (id: string) => repo.find(id);\n');
  await writeFile(join(dir, "docs/guide.md"), "# Guide\n\nIntro.\n\n## Install\n\n```sh\n# not a heading\n```\n\n## Usage\n\nText.\n");
  await writeFile(join(dir, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
after(async () => rm(dir, { recursive: true, force: true }));

test("A1: several reads in one call; overlapping ranges of one file are printed once", async () => {
  const { read } = instance();
  const out = await read({ reads: [{ path: "src/users.ts" }, { path: "src/repo.ts", offset: 5, limit: 4 }, { path: "src/repo.ts", offset: 7, limit: 4 }] });
  assert.match(out, /src\/users\.ts/);
  assert.ok(out.includes(`${anchorOf(3, "export const fetchUser = (id: string) => repo.find(id);")}:export const fetchUser`));
  const repoLines = out.split("\n").filter((l) => /^\s*\d+#[A-Z]{2}:/.test(l) && l.includes("find"));
  assert.equal(repoLines.filter((l) => l.includes("find(id: string): Row | null")).length, 1, out);
  assert.match(out, /10#[A-Z]{2}:  findOrThrow/);
});

test("A2: a search over a glob returns anchored hits with context that edit accepts", async () => {
  const { read, edit } = instance();
  const out = await read({ reads: [{ glob: "src/**/*.ts", search: "repo\\.find\\(" }] });
  assert.match(out, /1 match in 1 file/);
  const hit = /^\s*(\d+#[A-Z]{2}):export const fetchUser/m.exec(out)!;
  assert.ok(hit, out);
  await edit({ edits: [{ path: "src/users.ts", from: hit[1], new: "export const fetchUser = (id: string) => repo.findOrThrow(id);" }] });
  assert.match(await readFile(join(dir, "src/users.ts"), "utf8"), /repo\.findOrThrow\(id\)/);
});

test("A2: search context lines are configurable and windows are merged", async () => {
  const { read } = instance();
  const out = await read({ reads: [{ path: "src/repo.ts", search: "find", context: 0 }] });
  assert.match(out, /3 matches in 1 file/);
  assert.ok(!out.includes("export class Repo"), "context 0 shows only matching lines");
});

test("A3: outline lists declarations with anchors (TypeScript and Markdown)", async () => {
  const { read } = instance();
  const ts = await read({ reads: [{ path: "src/repo.ts", outline: true }] });
  for (const decl of ["export interface Row", "export class Repo", "  find(id: string)", "  findOrThrow(id: string)", "export const repo", "export function count()"]) {
    assert.ok(ts.includes(decl), `${decl} missing from:\n${ts}`);
  }
  assert.ok(!ts.includes("return db.get(id)"), "bodies are not in the outline");
  const md = await read({ reads: [{ path: "docs/guide.md", outline: true }] });
  assert.match(md, /1#[A-Z]{2}:# Guide/);
  assert.match(md, /#[A-Z]{2}:## Install/);
  assert.ok(!md.includes("not a heading"), "lines in code fences are not headings");
});

test("A3: a glob with no selector lists the matching files", async () => {
  const { read } = instance();
  const out = await read({ reads: [{ glob: "src/*.ts" }] });
  assert.match(out, /src\/\*\.ts: 2 files/);
  assert.match(out, /src\/repo\.ts/);
  assert.match(out, /src\/users\.ts/);
  assert.ok(!out.includes("#"), "no file contents in a listing");
});

test("A4: an unchanged re-read returns a stub once; asking again serves the text; a change serves it", async () => {
  const { read } = instance();
  await writeFile(join(dir, "src/cache.ts"), "export const a = 1;\n");
  const first = await read({ reads: [{ path: "src/cache.ts" }] });
  assert.match(first, /export const a = 1;/);
  const second = await read({ reads: [{ path: "src/cache.ts" }] });
  assert.match(second, /unchanged since your last read/);
  assert.ok(!second.includes("export const a = 1;"));
  const third = await read({ reads: [{ path: "src/cache.ts" }] });
  assert.match(third, /export const a = 1;/);
  await writeFile(join(dir, "src/cache.ts"), "export const a = 2;\n");
  const changed = await read({ reads: [{ path: "src/cache.ts" }] });
  assert.match(changed, /export const a = 2;/);
});

test("A4: compaction and tree navigation reset the cache", async () => {
  const { read, handlers } = instance();
  await writeFile(join(dir, "src/compact.ts"), "export const c = 1;\n");
  await read({ reads: [{ path: "src/compact.ts" }] });
  await handlers.get("session_compact")!({}, {});
  assert.match(await read({ reads: [{ path: "src/compact.ts" }] }), /export const c = 1;/);
  await handlers.get("session_tree")!({}, {});
  assert.match(await read({ reads: [{ path: "src/compact.ts" }] }), /export const c = 1;/);
});

test("A5: the output budget cuts a long read and says how to continue", async () => {
  const { read } = instance();
  const out = await read({ reads: [{ path: "big.txt" }, { path: "src/users.ts" }] });
  assert.match(out, /Lines 1-2000 of 3000\. Continue with offset=2001/);
  assert.match(out, /not read \(output budget reached\): src\/users\.ts/);
});

test("refuses unclear requests", async () => {
  const { read } = instance();
  await assert.rejects(read({ reads: [{ glob: "src/*.ts", offset: 3 }] }), /offset\/limit need path/);
  await assert.rejects(read({ reads: [{ path: "src/repo.ts", search: "x", outline: true }] }), /at most one of search, outline/);
  await assert.rejects(read({ reads: [{ path: "src" }] }), /is a directory; read it with glob/);
  await assert.rejects(read({ reads: [{ path: "src/missing.ts" }] }), /does not exist/);
});

test("the schema takes reads only", async () => {
  const { tools } = instance();
  const { Value } = await import("typebox/value");
  const schema = (tools.get("read") as unknown as { parameters: never }).parameters;
  assert.ok(Value.Check(schema, { reads: [{ path: "a.ts" }, { glob: "**/*.ts", search: "x", context: 1 }, { path: "b.md", outline: true }] }));
  assert.ok(!Value.Check(schema, { path: "a.ts" }), "the old single-path shape");
  assert.ok(!Value.Check(schema, { reads: [{ path: "a.ts", lines: "1-3" }] }), "unknown field");
});
