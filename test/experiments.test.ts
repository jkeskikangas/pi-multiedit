// The flagged experiments: search-output grouping and the repository cache key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactSearchOutput, repositoryKey } from "../src/experiments.ts";

test("large rg output is grouped per file with counts; small output is left alone", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `src/f${i % 30}.ts:${i + 1}:const value${i} = computeSomethingLong(${i});`);
  const out = compactSearchOutput(lines.join("\n"))!;
  assert.match(out, /^300 matching lines in 30 files/);
  assert.match(out, /src\/f0\.ts \(10\)\n  1:const value0/);
  assert.match(out, /… 7 more/);
  assert.match(out, /… 15 more files: /);
  assert.ok(out.length < lines.join("\n").length / 3);
  assert.equal(compactSearchOutput("src/a.ts:1:x"), undefined);
});

test("the repository cache key is stable and not the session", async () => {
  const a = await repositoryKey(process.cwd());
  assert.match(a, /^repo-[0-9a-f]{32}$/);
  assert.equal(await repositoryKey("/somewhere/else"), a, "computed once per process");
});
