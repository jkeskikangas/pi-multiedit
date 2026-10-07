// grep: search by regex or by intent, over the whole repository unless a path or glob narrows it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { jevReranker } from "../src/jev.ts";
import { registerGrepTool } from "../src/grep.ts";

let dir: string;
let grep: { execute: Function; parameters: unknown };
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-grep-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/queue.ts"), "export function mutationQueueKey(path: string) {\n  return path;\n}\n");
  await writeFile(join(dir, "src/other.ts"), "export const unrelated = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  registerGrepTool({ registerTool: (t: typeof grep) => (grep = t), on: () => {} } as never);
});
after(async () => rm(dir, { recursive: true, force: true }));

const call = async (params: object, modelRegistry?: object) =>
  (await grep.execute("id", params, undefined, undefined, { cwd: dir, modelRegistry })).content[0].text as string;

test("a pattern searches the whole repository by default", async () => {
  const out = await call({ searches: [{ pattern: "mutationQueueKey" }] });
  assert.match(out, /1 match in 1 file/);
  assert.match(out, /1#[A-Z]{2}:export function mutationQueueKey/);
});

test("an intent ranks files without a pattern", async () => {
  const out = await call({ searches: [{ intent: "the function that computes the mutation queue key" }] });
  assert.equal(out.split("\n").find((l) => l.startsWith("src/")), "src/queue.ts");
});

test("pattern and intent are exclusive, and one is required", async () => {
  await assert.rejects(call({ searches: [{ pattern: "a", intent: "b" }] }), /give pattern or intent/);
  await assert.rejects(call({ searches: [{ path: "src/queue.ts" }] }), /give pattern or intent/);
});

test("the Jev re-ranker orders by probability and falls back to the given order without a classifier", async () => {
  const ranked = [{ path: "a.ts" }, { path: "b.ts" }] as never[];
  const none = jevReranker({ getAvailableOfType: async () => [] } as never, dir);
  assert.deepEqual((await none("x", ranked)).map((r: { path: string }) => r.path), ["a.ts", "b.ts"]);
  const prefersB = jevReranker(
    {
      getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
      classify: async (_m: unknown, c: { state: { file: string } }) => ({ stopReason: "stop", answers: { relevant: { type: "bool", probability: c.state.file === "b.ts" ? 0.9 : 0.1 } } }),
    } as never,
    dir,
  );
  assert.deepEqual((await prefersB("x", ranked)).map((r: { path: string }) => r.path), ["b.ts", "a.ts"]);
});

test("intent ranks source code above prose that repeats the task's words", async () => {
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "CHANGELOG.md"), "- theme: share the theme across package scopes\n- theme scopes theme package\n".repeat(5));
  await writeFile(join(dir, "docs/themes.md"), "# Themes\nThemes in package scopes share the theme. theme package scope theme.\n".repeat(5));
  await writeFile(join(dir, "src/theme.ts"), "export function loadTheme(scope: string) {\n  return scope;\n}\n");
  const out = await call({ searches: [{ intent: "share theme across package scopes" }] });
  assert.equal(out.split("\n").find((l) => /^(src|docs|CHANGELOG)/.test(l)), "src/theme.ts", out);
});

test("intent still prefers prose when the task is about docs", async () => {
  const out = await call({ searches: [{ intent: "update the themes documentation about package scopes" }] });
  assert.match(out.split("\n").find((l) => /^(src|docs|CHANGELOG)/.test(l)) ?? "", /^docs\/themes\.md|^CHANGELOG\.md/);
});

test("a pattern search caps its matches and says how many it left out", async () => {
  await writeFile(join(dir, "src/many.ts"), Array.from({ length: 120 }, (_, i) => `export const item${i} = ${i};`).join("\n") + "\n");
  const out = await call({ searches: [{ pattern: "export const item", path: "src/many.ts", context: 0 }] });
  assert.match(out, /120 matches in 1 file/);
  assert.equal(out.split("\n").filter((l) => /^\s*\d+#[A-Z]{2}:export const item/.test(l)).length, 50);
  assert.match(out, /70 more matches not shown; narrow the search/);
});

test("the Jev re-ranker retries a failed call once, and keeps the locator's order if a call still fails", async () => {
  const ranked = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] as never[];
  let calls = 0;
  const flaky = jevReranker(
    {
      getAvailableOfType: async () => [{ provider: "typesafe", id: "jev-latest" }],
      classify: async (_m: unknown, c: { state: { file: string } }) => {
        calls++;
        if (c.state.file === "a.ts") return { stopReason: "error", errorMessage: "429" };
        return { stopReason: "stop", answers: { relevant: { type: "bool", probability: c.state.file === "c.ts" ? 0.9 : 0.2 } } };
      },
    } as never,
    dir,
  );
  assert.deepEqual((await flaky("x", ranked)).map((r: { path: string }) => r.path), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(calls, 4, "a.ts was tried twice");
});
