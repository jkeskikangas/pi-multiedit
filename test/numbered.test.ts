import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { harvest, numberedLines } from "../src/numbered.ts";
import { shownHash } from "../src/shown.ts";
import { lineHash } from "../src/hash.ts";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pme-num-")));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}

const A = "defmodule A do\n  def a, do: 1\n  def b, do: 2\nend\n";
const B = "defmodule B do\n  def a, do: 1\nend\n";

test("parses cat -n, pathless rg -n and rg -n with paths and context lines", () => {
  const out = "lib/a.ex\n     1\tdefmodule A do\n     2\t  def a, do: 1\nlib/a.ex:3:  def b, do: 2\nlib/b.ex-2-  def a, do: 1\n4:end";
  assert.deepEqual(numberedLines(out), [
    [{ n: 1, text: "defmodule A do" }, { n: 2, text: "  def a, do: 1" }],
    [{ path: "lib/a.ex", n: 3, text: "  def b, do: 2" }],
    [{ path: "lib/b.ex", n: 2, text: "  def a, do: 1" }],
    [{ n: 4, text: "end" }],
  ]);
});

test("cat -n of a file named by an echoed path records its lines", async () => {
  const dir = await repo({ "lib/a.ex": A, "lib/b.ex": B });
  const out = "lib/a.ex\n" + A.trimEnd().split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n");
  await harvest(dir, 'f=$(rg -l "defmodule A"); echo $f; cat -n $f', out);
  assert.equal(shownHash(join(dir, "lib/a.ex"), 3), lineHash(3, "  def b, do: 2"));
  assert.equal(shownHash(join(dir, "lib/b.ex"), 1), undefined);
});

test("rg -n paths resolve against a cd in the command; only the lines shown are recorded", async () => {
  const dir = await repo({ "svc/lib/a.ex": A, "svc/lib/b.ex": B });
  await harvest(dir, 'cd svc; rg -n "def a" lib', "lib/a.ex:2:  def a, do: 1\nlib/b.ex:2:  def a, do: 1");
  assert.equal(shownHash(join(dir, "svc/lib/a.ex"), 2), lineHash(2, "  def a, do: 1"));
  assert.equal(shownHash(join(dir, "svc/lib/b.ex"), 2), lineHash(2, "  def a, do: 1"));
  assert.equal(shownHash(join(dir, "svc/lib/a.ex"), 3), undefined);
});

test("pathless lines go to the one file that has them; ambiguous or stale lines are not recorded", async () => {
  const dir = await repo({ "a.ex": A, "b.ex": B, "c.ex": A });
  await harvest(dir, 'rg -n "def b" a.ex', "3:  def b, do: 2");
  assert.equal(shownHash(join(dir, "a.ex"), 3), lineHash(3, "  def b, do: 2"));
  // a.ex and c.ex both have it: the model's number could mean either.
  await harvest(dir, "rg -n end a.ex c.ex", "4:end");
  assert.equal(shownHash(join(dir, "c.ex"), 4), undefined);
  // The file no longer reads like this at line 2 (output from before an edit).
  await harvest(dir, "cat -n b.ex", "     2\t  def gone, do: 0");
  assert.equal(shownHash(join(dir, "b.ex"), 2), undefined);
});

test("the extension harvests bash results, even when the command exits non-zero", async () => {
  const dir = await repo({ "x.ts": "const x = 1;\nconst y = 2;\n" });
  let onResult: Function | undefined;
  extension({
    registerTool: () => {},
    on: (event: string, h: Function) => event === "tool_result" && (onResult = h),
    getActiveTools: () => [],
    setActiveTools: () => {},
    events: { on: () => () => {}, emit: () => {} },
  } as never);
  await onResult!(
    { type: "tool_result", toolName: "bash", isError: true, input: { command: "grep -n y x.ts; false" }, content: [{ type: "text", text: "2:const y = 2;\n\nCommand exited with code 1" }] },
    { cwd: dir },
  );
  assert.equal(shownHash(join(dir, "x.ts"), 2), lineHash(2, "const y = 2;"));
});
