// The lazy code graph: definitions and references from tree-sitter, and the blast radius of an edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { blastRadius, definitionsOf, referenceLines } from "../src/graph.ts";
import { registerEditTool } from "../src/tool.ts";

test("definitions: names and signature lines in TypeScript, Python and Elixir", () => {
  const ts = definitionsOf("a.ts", "export function fetchUser(id: string) {\n  return 1;\n}\nexport class Repo {\n  find(id: string) {}\n}\nexport const load = (x: number) => x;\n")!;
  assert.deepEqual(ts.map((d) => [d.name, d.line, d.signature]), [
    ["fetchUser", 1, "export function fetchUser(id: string) {"],
    ["Repo", 4, "export class Repo {"],
    ["find", 5, "find(id: string) {}"],
    ["load", 7, "export const load = (x: number) => x;"],
  ]);
  const py = definitionsOf("a.py", "class A:\n    def f(self, x):\n        pass\n\ndef top(y):\n    return y\n")!;
  assert.deepEqual(py.map((d) => d.name), ["A", "f", "top"]);
  const ex = definitionsOf("a.ex", "defmodule Care.Accounts do\n  def fetch(id), do: id\n  defp hidden(x), do: x\nend\n")!;
  assert.deepEqual(ex.map((d) => d.name), ["Care.Accounts", "fetch", "hidden"]);
  assert.equal(definitionsOf("a.txt", "x"), undefined);
});

test("references: identifier uses only, never inside comments or strings", () => {
  const text = 'import { fetchUser } from "./a";\n// fetchUser(1) in a comment\nconst s = "fetchUser(2)";\nfetchUser(3);\nobj.fetchUser(4);\n';
  assert.deepEqual(referenceLines("b.ts", text, "fetchUser"), [1, 4, 5]);
});

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-graph-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/users.ts"), "export function fetchUser(id: string) {\n  return id;\n}\n\nexport function other() {\n  return fetchUser(\"x\");\n}\n");
  await writeFile(join(dir, "src/a.ts"), 'import { fetchUser } from "./users";\n\nexport const a = () => fetchUser("a");\n');
  await writeFile(join(dir, "src/b.ts"), 'import { fetchUser } from "./users";\n// fetchUser is mentioned here only in a comment in c? no, used below\nexport const b = () => fetchUser("b");\n');
  await writeFile(join(dir, "src/c.ts"), '// fetchUser(1) appears only in this comment\nexport const c = "fetchUser";\n');
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
after(async () => rm(dir, { recursive: true, force: true }));

const read = (rel: string) => readFile(join(dir, rel), "utf8").catch(() => null);

test("blast radius: a changed signature lists every remaining use outside the definition", async () => {
  const before = await read("src/users.ts");
  const after = before!.replace("fetchUser(id: string)", "fetchUser(id: string, opts: { cache: boolean })");
  const blasts = await blastRadius(dir, [{ path: "src/users.ts", before, after }], read);
  assert.equal(blasts.length, 1);
  assert.equal(blasts[0].change, "signature");
  assert.deepEqual(blasts[0].sites.map((s) => `${s.path}:${s.line}`).sort(), ["src/a.ts:1", "src/a.ts:3", "src/b.ts:1", "src/b.ts:3", "src/users.ts:6"]);
});

test("blast radius: a rename flags what still uses the old name; uses fixed in the same call are not listed", async () => {
  const usersBefore = await read("src/users.ts");
  const aBefore = await read("src/a.ts");
  const blasts = await blastRadius(
    dir,
    [
      { path: "src/users.ts", before: usersBefore, after: usersBefore!.replaceAll("fetchUser", "getUser") },
      { path: "src/a.ts", before: aBefore, after: aBefore!.replaceAll("fetchUser", "getUser") },
    ],
    read,
  );
  assert.equal(blasts.length, 1);
  assert.equal(blasts[0].change, "removed");
  assert.deepEqual(blasts[0].sites.map((s) => `${s.path}:${s.line}`), ["src/b.ts:1", "src/b.ts:3"]);
});

test("blast radius: an edit inside a body reports nothing", async () => {
  const before = await read("src/users.ts");
  assert.deepEqual(await blastRadius(dir, [{ path: "src/users.ts", before, after: before!.replace("return id;", "return id.trim();") }], read), []);
});

test("the edit result reports the blast radius with anchors", async () => {
  let edit: { execute: Function } | undefined;
  registerEditTool({ registerTool: (t: { execute: Function }) => (edit = t) } as never);
  const r = await edit!.execute(
    "id",
    { edits: [{ path: "src/users.ts", old: "export function fetchUser(id: string) {", new: "export function fetchUser(id: string, opts?: { cache: boolean }) {" }] },
    undefined,
    undefined,
    { cwd: dir },
  );
  const text = r.content[0].text as string;
  assert.match(text, /changed definition fetchUser: check its \d+ uses? in 3 files/);
  assert.match(text, /src\/b\.ts\n\s*1#[A-Z]{2}:import \{ fetchUser \}[^\n]*\n\s*3#[A-Z]{2}:export const b = \(\) => fetchUser\("b"\);/);
});
