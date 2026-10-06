import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { Planner, type EditSpec } from "../src/engine.ts";
import { anchorOf, lineHash } from "../src/hash.ts";
import { jsonEdit } from "../src/json.ts";

const memFs = (files: Record<string, string>) => ({
  read: async (abs: string) => files[abs.split("/").pop()!] ?? null,
  list: async () => Object.keys(files),
});

const plan = async (files: Record<string, string>, edits: EditSpec[]) => {
  const p = new Planner("/w", memFs(files));
  const result = await p.run({ edits });
  return { result, out: (name: string) => result.files.get(`/w/${name}`)?.cur };
};

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "multiedit-prop-"));
});
after(async () => rm(dir, { recursive: true, force: true }));

test("golden hashes match pi-hashline-edit", () => {
  // Computed with pi-hashline-edit 0.6.1's computeLineHash.
  const golden: [number, string, string][] = [
    [1, "function x() {", "KH"],
    [2, "  }", "JX"],
    [3, "", "HW"],
    [4, "  return ä€😀;  ", "RJ"],
    [5, "end", "PT"],
    [6, "\t\tfoo\r", "JJ"],
    [7, "})", "HY"],
    [8, "# Heading", "MW"],
  ];
  for (const [n, line, hash] of golden) assert.equal(lineHash(n, line), hash, JSON.stringify(line));
});

// Reference model: line-anchored ops keyed by original line numbers, applied to the original.
type Op = { kind: "replace" | "delete" | "after"; from: number; to: number; text: string[] };

function reference(lines: string[], ops: Op[]): string[] {
  const out: string[] = [];
  for (let i = 1; i <= lines.length; i++) {
    const op = ops.find((o) => i >= o.from && i <= o.to);
    if (!op) out.push(lines[i - 1]);
    else if (op.kind === "after") {
      out.push(lines[i - 1]);
      out.push(...op.text);
    } else if (op.kind === "replace" && i === op.from) out.push(...op.text);
  }
  return out;
}

const lineArb = fc.stringMatching(/^[a-z ]{0,6}$/);

test("anchors resolve to the lines as read, whatever order earlier edits ran in", async () => {
  const scenario = fc
    .array(lineArb, { minLength: 1, maxLength: 25 })
    .chain((lines) =>
      fc.record({
        lines: fc.constant(lines),
        cuts: fc.uniqueArray(fc.integer({ min: 1, max: lines.length }), { minLength: 1, maxLength: Math.min(8, lines.length) }),
        kinds: fc.array(fc.constantFrom("replace", "delete", "after") as fc.Arbitrary<Op["kind"]>, { minLength: 8, maxLength: 8 }),
        texts: fc.array(fc.array(lineArb, { minLength: 1, maxLength: 3 }), { minLength: 8, maxLength: 8 }),
        order: fc.array(fc.nat(), { minLength: 8, maxLength: 8 }),
      }),
    );
  await fc.assert(
    fc.asyncProperty(scenario, async ({ lines, cuts, kinds, texts, order }) => {
      // Disjoint single-or-two-line ranges starting at each cut.
      const sorted = [...cuts].sort((a, b) => a - b);
      const ops: Op[] = sorted.map((from, i) => {
        const next = sorted[i + 1] ?? lines.length + 1;
        const to = kinds[i] !== "after" && from + 1 < next ? from + 1 : from;
        return { kind: kinds[i], from, to, text: texts[i] };
      });
      const shuffled = ops.map((o, i) => ({ o, k: order[i] })).sort((a, b) => a.k - b.k).map((x) => x.o);
      const src = lines.join("\n") + "\n";
      const anchor = (n: number) => anchorOf(n, lines[n - 1]);
      const edits: EditSpec[] = shuffled.map((o) => ({
        path: "f.txt",
        from: anchor(o.from),
        ...(o.to !== o.from ? { to: anchor(o.to) } : {}),
        ...(o.kind === "delete" ? { action: "delete" as const } : { new: o.text.map((l) => l + "\n").join(""), action: o.kind === "after" ? ("after" as const) : ("replace" as const) }),
      }));
      const { result, out } = await plan({ "f.txt": src }, edits);
      assert.deepEqual(result.failures, []);
      const want = reference(lines, ops);
      assert.equal(out("f.txt"), want.length ? want.join("\n") + "\n" : "");
    }),
    { numRuns: 300 },
  );
});

test("count: all on exact text equals split/join", async () => {
  await fc.assert(
    fc.asyncProperty(fc.stringMatching(/^[ab\n]{0,40}$/), fc.stringMatching(/^[ab]{1,3}$/), fc.stringMatching(/^[xy]{0,3}$/), async (text, old, repl) => {
      const hits = text.split(old).length - 1;
      fc.pre(hits > 0);
      const { result, out } = await plan({ "f.txt": text }, [{ path: "f.txt", old, new: repl, count: "all" }]);
      assert.deepEqual(result.failures, []);
      assert.equal(out("f.txt"), text.split(old).join(repl));
    }),
  );
});

test("a request with any failing edit changes no file on disk", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }), fc.nat(), async (oks, seed) => {
      const failing = seed % oks.length;
      const names = oks.map((_, i) => `f${i}.txt`);
      for (const n of names) await writeFile(join(dir, n), `content of ${n}\n`);
      const p = new Planner(dir, { read: (a) => readFile(a, "utf8").catch(() => null), list: async () => names });
      const res = await p.run({
        edits: names.map((n, i) => ({ path: n, old: i === failing ? "absent" : "content", new: "changed" })),
      });
      assert.equal(res.failures.length, 1);
      assert.equal(res.failures[0].edit, failing + 1);
      // The planner never writes; the tool commits only a failure-free plan.
      for (const n of names) assert.equal(await readFile(join(dir, n), "utf8"), `content of ${n}\n`);
    }),
    { numRuns: 30 },
  );
});

test("json set changes only the addressed value", () => {
  const value = fc.oneof(fc.integer(), fc.boolean(), fc.string({ maxLength: 5 }), fc.constant(null));
  fc.assert(
    fc.property(fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), value, { minKeys: 1, maxKeys: 6 }), fc.nat(), value, (obj, pick, next) => {
      const keys = Object.keys(obj);
      const key = keys[pick % keys.length];
      const text = JSON.stringify({ data: obj }, null, 2) + "\n";
      const out = jsonEdit(text, `/data/${key}`, "replace", next);
      assert.deepEqual(JSON.parse(out), { data: { ...obj, [key]: next } });
      assert.ok(out.endsWith("}\n"));
    }),
  );
});
