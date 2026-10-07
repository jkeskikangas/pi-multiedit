// Regression tests for the independent review's findings (symlinks, encodings, modes, rollback).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { registerEditTool } from "../src/tool.ts";

type Registered = { name: string; execute: Function };
let edit: Registered;
registerEditTool({ registerTool: (t: Registered) => (edit = t) } as never);

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-review-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
after(async () => rm(dir, { recursive: true, force: true }));

const run = (params: { path?: string; edits?: object[] }) => {
  const { path, edits } = params;
  return edit.execute("id", { edits: edits?.map((e) => ("path" in e || "glob" in e ? e : { ...e, path })) }, undefined, undefined, { cwd: dir });
};
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");
const withTimeout = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out (deadlock?)")), ms))]);

test("a glob reaching one file through a symlink alias edits it once, without hanging", async () => {
  await writeFile(join(dir, "AGENTS.md"), "use npm\n");
  await symlink("AGENTS.md", join(dir, "CLAUDE.md"));
  const r = (await withTimeout(run({ edits: [{ glob: "*.md", old: "npm", new: "pnpm" }] }))) as { content: { text: string }[] };
  assert.match(text(r), /Applied 1 step\(s\) to 1 file\(s\)/);
  assert.equal(await readFile(join(dir, "AGENTS.md"), "utf8"), "use pnpm\n");
  assert.equal(await readlink(join(dir, "CLAUDE.md")), "AGENTS.md");
});

test("edits through an alias and the real path in one call both land", async () => {
  await writeFile(join(dir, "real.txt"), "a\nb\n");
  await symlink("real.txt", join(dir, "alias.txt"));
  await withTimeout(run({ edits: [{ path: "real.txt", old: "a", new: "A" }, { path: "alias.txt", old: "b", new: "B" }] }));
  assert.equal(await readFile(join(dir, "real.txt"), "utf8"), "A\nB\n");
});

test("deleting a symlink is refused and its target survives", async () => {
  await writeFile(join(dir, "target.txt"), "keep\n");
  await symlink("target.txt", join(dir, "link.txt"));
  await assert.rejects(run({ edits: [{ path: "link.txt", action: "delete" }] }), /symlink/);
  assert.equal(await readFile(join(dir, "target.txt"), "utf8"), "keep\n");
  assert.equal(await readlink(join(dir, "link.txt")), "target.txt");
});

test("a file that is not valid UTF-8 is refused, not corrupted", async () => {
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a]);
  await writeFile(join(dir, "latin1.txt"), latin1);
  await assert.rejects(run({ path: "latin1.txt", edits: [{ old: "x", new: "y" }] }), /UTF-8/);
  assert.ok((await readFile(join(dir, "latin1.txt"))).equals(latin1));
});

test("file mode is kept exactly, regardless of umask", async () => {
  await writeFile(join(dir, "script.sh"), "echo a\n");
  await chmod(join(dir, "script.sh"), 0o775);
  await run({ path: "script.sh", edits: [{ old: "a", new: "b" }] });
  assert.equal((await stat(join(dir, "script.sh"))).mode & 0o777, 0o775);
});

test("mixed line endings are left as they are on unedited lines", async () => {
  await writeFile(join(dir, "mixed.txt"), "a\r\nb\nc\n");
  await run({ path: "mixed.txt", edits: [{ old: "c", new: "C" }] });
  assert.equal(await readFile(join(dir, "mixed.txt"), "utf8"), "a\r\nb\nC\n");
});

test("old text missing while new text exists elsewhere is a failure with a hint, not a silent skip", async () => {
  await writeFile(join(dir, "skip.txt"), "return total;\n");
  await assert.rejects(run({ path: "skip.txt", edits: [{ old: "retrun total;", new: "return total;" }] }), /already present at line 1/);
});






test("a glob edit skips binary and non-UTF-8 files instead of failing; an explicit path still refuses", async () => {
  await mkdir(join(dir, "mixed"), { recursive: true });
  await writeFile(join(dir, "mixed/a.md"), "old name\n");
  await writeFile(join(dir, "mixed/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  await writeFile(join(dir, "mixed/latin1.txt"), Buffer.from([0x6f, 0x6c, 0x64, 0xe9, 0x0a]));
  await run({ edits: [{ glob: "mixed/**", old: "old name", new: "new name" }] });
  assert.equal(await readFile(join(dir, "mixed/a.md"), "utf8"), "new name\n");
  await assert.rejects(run({ edits: [{ path: "mixed/logo.png", old: "x", new: "y" }] }), /binary/);
});
