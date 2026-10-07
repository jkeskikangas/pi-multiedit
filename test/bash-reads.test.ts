// Session focus for shaping, and the bash `cat` hook that shapes large files like read does.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { registerBashReads } from "../src/bash-reads.ts";
import { focusOf } from "../src/focus.ts";

const session = (messages: object[]) => ({ getBranch: () => messages.map((message) => ({ type: "message", message })) });

test("focus: the latest user request plus recent search arguments", () => {
  const f = focusOf(
    session([
      { role: "user", content: "old request" },
      { role: "user", content: [{ type: "text", text: "reduce the diff context lines" }] },
      { role: "assistant", content: [{ type: "toolCall", name: "grep", arguments: { searches: [{ pattern: "contextLines" }, { intent: "diff preview" }] } }] },
    ]) as never,
  );
  assert.match(f, /reduce the diff context lines/);
  assert.match(f, /contextLines/);
  assert.match(f, /diff preview/);
  assert.ok(!f.includes("old request"));
});

let dir: string;
let handler: Function;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-bash-"));
  await mkdir(join(dir, "src"), { recursive: true });
  const fn = (n: string, tag: string) => [`export function ${n}(x: number) {`, ...Array.from({ length: 60 }, (_, i) => `  const v${i} = ${i}; // ${tag}`), "  return x;", "}"];
  await writeFile(join(dir, "src/big.ts"), ["alpha", "diffContext", "gamma", "delta", "epsilon", "zeta", "eta"].flatMap((n) => fn(n, n === "diffContext" ? "diff context" : "other")).join("\n") + "\n");
  await writeFile(join(dir, "src/small.ts"), "export const a = 1;\n");
  registerBashReads({ on: (_e: string, h: Function) => (handler = h) } as never);
});
after(async () => rm(dir, { recursive: true, force: true }));

const ctx = () => ({ cwd: dir, sessionManager: session([{ role: "user", content: "change the diff context" }]) });
const bash = (command: string) => handler({ toolName: "bash", isError: false, input: { command }, content: [{ type: "text", text: "raw" }] }, ctx());

test("a plain cat of a large file is shaped once; the same cat again keeps the full output", async () => {
  const first = await bash("cat src/big.ts");
  assert.match(first.content[0].text, /showing the outline and 1 part matching the task/);
  assert.match(first.content[0].text, /run the same cat again for the full output/);
  assert.equal(await bash("cat src/big.ts"), undefined);
});

test("small files, pipelines, other commands and failed commands are left alone", async () => {
  assert.equal(await bash("cat src/small.ts"), undefined);
  assert.equal(await bash("cat src/big.ts | head -50"), undefined);
  assert.equal(await bash("sed -n 1,20p src/big.ts"), undefined);
  assert.equal(await handler({ toolName: "bash", isError: true, input: { command: "cat src/big.ts" }, content: [] }, ctx()), undefined);
});
