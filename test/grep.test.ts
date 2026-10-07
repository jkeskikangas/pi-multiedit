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
