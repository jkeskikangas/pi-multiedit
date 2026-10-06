import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import { commit, drift, type FileChange } from "../src/commit.ts";
import { Planner, toRaw, type EditRequest } from "../src/engine.ts";
import { changedLines } from "../src/feedback.ts";
import { anchorOf } from "../src/hash.ts";

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "multiedit-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
async function setup(files: Record<string, string>): Promise<string> {
  const dir = join(root, `case${n++}`);
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  return dir;
}

async function readOrNull(p: string) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function planner(dir: string) {
  return new Planner(dir, {
    read: readOrNull,
    list: async () => {
      const { glob } = await import("node:fs/promises");
      const out: string[] = [];
      for await (const p of glob("**/*", { cwd: dir })) out.push(p as string);
      return out;
    },
  });
}

/** Plans and, when it succeeds, commits; returns failures and the resulting disk content. */
async function apply(dir: string, req: EditRequest) {
  const p = planner(dir);
  const plan = await p.run(req);
  if (plan.failures.length === 0) {
    const changes: FileChange[] = [...plan.files.values()]
      .filter((s) => s.cur !== s.orig)
      .map((s) => ({ abs: s.abs, before: s.raw, after: toRaw(s, s.cur) }));
    await commit(changes);
  }
  const read = (rel: string) => readOrNull(join(dir, rel));
  return { plan, read };
}

const lines = (...l: string[]) => l.join("\n") + "\n";

describe("text selector", () => {
  test("edits several files in one call, in order", async () => {
    const dir = await setup({ "a.ex": lines("def a, do: 1", "def b, do: 2"), "b.ts": lines("const x = 1;") });
    const { plan, read } = await apply(dir, {
      edits: [
        { path: "a.ex", old: "do: 1", new: "do: 10" },
        { path: "a.ex", old: "do: 10", new: "do: 100" },
        { path: "b.ts", old: "x = 1", new: "x = 2" },
      ],
    });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("a.ex"), lines("def a, do: 100", "def b, do: 2"));
    assert.equal(await read("b.ts"), lines("const x = 2;"));
  });

  test("any failure writes nothing and reports every failure", async () => {
    const dir = await setup({ "a.txt": lines("alpha", "beta"), "b.txt": lines("gamma") });
    const { plan, read } = await apply(dir, {
      edits: [
        { path: "a.txt", old: "alpha", new: "ALPHA" },
        { path: "b.txt", old: "missing", new: "x" },
        { path: "a.txt", old: "nope", new: "y" },
      ],
    });
    assert.deepEqual(plan.failures.map((f) => f.edit), [2, 3]);
    assert.equal(await read("a.txt"), lines("alpha", "beta"));
  });

  test("count guards ambiguity and allows deliberate multi-match", async () => {
    const dir = await setup({ "a.txt": lines("foo", "foo", "bar") });
    const ambiguous = await apply(dir, { path: "a.txt", edits: [{ old: "foo", new: "x" }] });
    assert.match(ambiguous.plan.failures[0].message, /matched 2 times, expected 1/);
    assert.match(ambiguous.plan.failures[0].hints![0], /lines 1, 2/);
    const { read } = await apply(dir, { path: "a.txt", edits: [{ old: "foo", new: "x", count: 2 }] });
    assert.equal(await read("a.txt"), lines("x", "x", "bar"));
  });

  test("glob applies one rewrite across files with a total count", async () => {
    const dir = await setup({ "lib/a.ex": "Old.call()\n", "lib/b.ex": "Old.call() + Old.call()\n", "test/c.ex": "Old.call()\n" });
    const { plan, read } = await apply(dir, { edits: [{ glob: "lib/**/*.ex", old: "Old.call", new: "New.call", count: 3 }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("lib/b.ex"), "New.call() + New.call()\n");
    assert.equal(await read("test/c.ex"), "Old.call()\n");
  });

  test("tolerates trailing whitespace and typographic quotes, and says so", async () => {
    const dir = await setup({ "a.md": lines("He said “hi”   ", "next") });
    const { plan, read } = await apply(dir, { path: "a.md", edits: [{ old: 'He said "hi"\nnext', new: "He said hello\nnext" }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("a.md"), lines("He said hello", "next"));
    assert.match(plan.notes[0].text, /trailing whitespace/);
  });

  test("re-indents when the model got the indentation level wrong", async () => {
    const dir = await setup({ "a.py": lines("def f():", "    if x:", "        return 1", "    return 2") });
    const { plan, read } = await apply(dir, {
      path: "a.py",
      edits: [{ old: "if x:\n    return 1", new: "if x:\n    log()\n    return 1" }],
    });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("a.py"), lines("def f():", "    if x:", "        log()", "        return 1", "    return 2"));
  });

  test("not found returns the nearest region with anchors", async () => {
    const dir = await setup({ "a.ex": lines("defmodule A do", "  def handle(conn, params) do", "    :ok", "  end", "end") });
    const { plan } = await apply(dir, { path: "a.ex", edits: [{ old: "def handle(conn, param) do", new: "x" }] });
    const hint = plan.failures[0].hints![0];
    assert.ok(hint.includes(`${anchorOf(2, "  def handle(conn, params) do")}:  def handle(conn, params) do`), hint);
  });

  test("a retried edit (old gone, new present) fails with a hint naming where new already is", async () => {
    const dir = await setup({ "a.txt": lines("x", "new text") });
    const { plan } = await apply(dir, { path: "a.txt", edits: [{ old: "old text", new: "new text" }] });
    assert.match(plan.failures[0].message, /already present at line 2/);
  });

  test("before/after/delete keep or drop the match", async () => {
    const dir = await setup({ "a.txt": lines("one", "two", "three") });
    const { read } = await apply(dir, {
      path: "a.txt",
      edits: [
        { old: "two\n", new: "1.5\n", action: "before" },
        { old: "two\n", new: "2.5\n", action: "after" },
        { old: "three\n", action: "delete" },
      ],
    });
    assert.equal(await read("a.txt"), lines("one", "1.5", "two", "2.5"));
  });
});

describe("line anchors and ranges", () => {
  const src = lines("a", "b", "c", "d", "e");
  const A = (i: number) => anchorOf(i, "abcde"[i - 1]);

  test("replaces an anchored range of whole lines", async () => {
    const dir = await setup({ "f.txt": src });
    const { read } = await apply(dir, { path: "f.txt", edits: [{ from: A(2), to: A(4), new: "X\nY" }] });
    assert.equal(await read("f.txt"), lines("a", "X", "Y", "e"));
  });

  test("anchors refer to the file as read, even after earlier edits shift lines", async () => {
    const dir = await setup({ "f.txt": src });
    const { plan, read } = await apply(dir, {
      path: "f.txt",
      edits: [
        { from: A(1), new: "a1\na2\na3" },
        { from: A(4), action: "delete" },
        { from: A(5), new: "z", action: "after" },
      ],
    });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("f.txt"), lines("a1", "a2", "a3", "b", "c", "e", "z"));
  });

  test("an anchor inside a region an earlier step changed is refused", async () => {
    const dir = await setup({ "f.txt": src });
    const { plan } = await apply(dir, { path: "f.txt", edits: [{ from: A(2), to: A(3), new: "q" }, { from: A(3), new: "r" }] });
    assert.match(plan.failures[0].message, /changed by step 1/);
  });

  test("a stale anchor fails with fresh anchors", async () => {
    const dir = await setup({ "f.txt": src });
    const { plan } = await apply(dir, { path: "f.txt", edits: [{ from: "3#ZZ", new: "q" }] });
    assert.match(plan.failures[0].message, /stale/);
    assert.ok(plan.failures[0].hints![0].includes(`${A(3)}:c`));
  });

  test("text range with until cuts up to (not including) the next heading", async () => {
    const dir = await setup({ "doc.md": lines("# A", "old 1", "old 2", "# B", "keep") });
    const { read } = await apply(dir, { path: "doc.md", edits: [{ from: "# A\n", until: "# B", new: "# A\nnew\n" }] });
    assert.equal(await read("doc.md"), lines("# A", "new", "# B", "keep"));
  });

  test("rejects LINE#HASH prefixes pasted into new", async () => {
    const dir = await setup({ "f.txt": src });
    const { plan } = await apply(dir, { path: "f.txt", edits: [{ from: A(1), new: `${A(1)}:a` }] });
    assert.match(plan.failures[0].message, /LINE#HASH/);
  });
});

describe("regex, ast and json selectors", () => {
  test("regex with captures and named groups", async () => {
    const dir = await setup({ "a.ts": lines("foo(1, 2)", "foo(3, 4)") });
    const { read } = await apply(dir, {
      path: "a.ts",
      edits: [{ regex: String.raw`foo\((?<a>\d), (\d)\)`, new: "bar($2, $<a>)", count: "all" }],
    });
    assert.equal(await read("a.ts"), lines("bar(2, 1)", "bar(4, 3)"));
  });

  test("ast rewrites Elixir calls with metavariables", async () => {
    const dir = await setup({
      "a.ex": lines("defmodule A do", "  def f(x), do: Repo.get(User, x)", "  def g(y), do: Repo.get(Post, y) |> IO.inspect()", "end"),
    });
    const { plan, read } = await apply(dir, { path: "a.ex", edits: [{ ast: "Repo.get($S, $ID)", new: "Repo.get!($S, $ID)", count: 2 }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(
      await read("a.ex"),
      lines("defmodule A do", "  def f(x), do: Repo.get!(User, x)", "  def g(y), do: Repo.get!(Post, y) |> IO.inspect()", "end"),
    );
  });

  test("ast $$$ keeps argument lists verbatim in TypeScript", async () => {
    const dir = await setup({ "a.ts": lines("log(a, b, c);", "log();") });
    const { read } = await apply(dir, { path: "a.ts", edits: [{ ast: "log($$$ARGS)", new: "logger.info($$$ARGS)", count: "all" }] });
    assert.equal(await read("a.ts"), lines("logger.info(a, b, c);", "logger.info();"));
  });

  test("ast rewrites only the outermost of nested matches, as ast-grep does", async () => {
    const dir = await setup({ "n.ts": lines("wrap(wrap(x));") });
    const { plan, read } = await apply(dir, { path: "n.ts", edits: [{ ast: "wrap($A)", new: "box($A)" }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("n.ts"), lines("box(wrap(x));"));
  });

  test("json sets a field on the element selected by key, keeping formatting", async () => {
    const json = '{\n  "suites": [\n    { "path": "a", "layer": "unit" },\n    { "path": "b", "layer": "unit" }\n  ]\n}\n';
    const dir = await setup({ "layers.json": json });
    const { plan, read } = await apply(dir, {
      path: "layers.json",
      edits: [
        { json: "/suites/[path=b]/layer", new: "integration" },
        { json: "/suites/[path=a]", action: "after", new: {path: "a2", layer: "unit"} },
      ],
    });
    assert.deepEqual(plan.failures, []);
    const out = (await read("layers.json"))!;
    assert.ok(out.includes('{ "path": "b", "layer": "integration" }'), out);
    assert.deepEqual(JSON.parse(out).suites.map((s: { path: string }) => s.path), ["a", "a2", "b"]);
    assert.ok(out.startsWith('{\n  "suites": [\n    { "path": "a", "layer": "unit" },'), out);
  });

  test("json append with - and delete", async () => {
    const dir = await setup({ "c.json": '{"a": [1, 2], "b": true}\n' });
    const { read } = await apply(dir, { path: "c.json", edits: [{ json: "/a/-", new: 3 }, { json: "/b", action: "delete" }] });
    assert.deepEqual(JSON.parse((await read("c.json"))!), { a: [1, 2, 3] });
  });
});

describe("forms models actually send (from evals)", () => {
  test("json [key=value] values may contain slashes", async () => {
    const dir = await setup({ "l.json": '{"suites": [{"path": "test/a.exs", "layer": "unit"}]}\n' });
    const { plan, read } = await apply(dir, { path: "l.json", edits: [{ json: "/suites/[path=test/a.exs]/layer", new: "integration" }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(JSON.parse((await read("l.json"))!).suites[0].layer, "integration");
  });

  test("json new is the JSON value itself: objects, and plain strings", async () => {
    const dir = await setup({ "c.json": '{"a": [], "b": "x"}\n' });
    const { plan, read } = await apply(dir, {
      path: "c.json",
      edits: [
        { json: "/a/-", new: { path: "p", n: 1 } },
        { json: "/b", new: "integration" },
      ],
    });
    assert.deepEqual(plan.failures, []);
    assert.deepEqual(JSON.parse((await read("c.json"))!), { a: [{ path: "p", n: 1 }], b: "integration" });
  });

  test("an anchor copied with its content works; with a wrong line number it is refused", async () => {
    const src = lines("a", "// BEGIN legacy", "x", "// END legacy", "b");
    const dir = await setup({ "f.ts": src });
    const begin = `${anchorOf(2, "// BEGIN legacy")}:// BEGIN legacy`;
    const end = `${anchorOf(4, "// END legacy")}:// END legacy`;
    const slipped = await apply(dir, { path: "f.ts", edits: [{ from: begin.replace(/^2#/, "1#"), to: end, action: "delete" }] });
    assert.match(slipped.plan.failures[0].message, /content does not match line 1/);
    const { plan, read } = await apply(dir, { path: "f.ts", edits: [{ from: begin, to: end, action: "delete" }] });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("f.ts"), lines("a", "b"));
  });



  test("an anchor whose content does not match is refused even when the hash matches", async () => {
    const dir = await setup({ "f.ts": lines("one", "two") });
    const { plan } = await apply(dir, { path: "f.ts", edits: [{ from: `${anchorOf(2, "two")}:three`, new: "2" }] });
    assert.match(plan.failures[0].message, /content/);
  });
});

describe("file operations and patches", () => {
  test("move then edit at the new path, delete, create", async () => {
    const dir = await setup({ "old.ts": lines("export const a = 1;"), "gone.ts": "x\n" });
    const { plan, read } = await apply(dir, {
      files: [{ path: "old.ts", moveTo: "src/new.ts" }, { path: "gone.ts", delete: true }, { path: "src/index.ts", write: 'export * from "./new";\n' }],
      edits: [{ path: "src/new.ts", old: "a = 1", new: "a = 2" }],
    });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("old.ts"), null);
    assert.equal(await read("gone.ts"), null);
    assert.equal(await read("src/new.ts"), lines("export const a = 2;"));
    assert.equal(await read("src/index.ts"), 'export * from "./new";\n');
  });

  test("anchors read from a file keep working after it is moved", async () => {
    const dir = await setup({ "a.txt": lines("one", "two") });
    const { read } = await apply(dir, {
      files: [{ path: "a.txt", moveTo: "b.txt" }],
      edits: [{ path: "b.txt", from: anchorOf(2, "two"), new: "TWO" }],
    });
    assert.equal(await read("b.txt"), lines("one", "TWO"));
  });

  test("Codex apply_patch envelope: update with context, add, move", async () => {
    const dir = await setup({ "app.py": lines("def main():", "    x = 1", "    print(x)", "", "def other():", "    pass") });
    const patch = [
      "*** Begin Patch",
      "*** Update File: app.py",
      "*** Move to: src/app.py",
      "@@ def main():",
      "     x = 1",
      "-    print(x)",
      "+    print(x + 1)",
      "*** Add File: src/__init__.py",
      "+# package",
      "*** End Patch",
    ].join("\n");
    const { plan, read } = await apply(dir, { patch });
    assert.deepEqual(plan.failures, []);
    assert.equal(await read("app.py"), null);
    assert.equal(await read("src/app.py"), lines("def main():", "    x = 1", "    print(x + 1)", "", "def other():", "    pass"));
    assert.equal(await read("src/__init__.py"), "# package\n");
  });
});

describe("encoding and commit safety", () => {
  test("keeps CRLF line endings and a BOM", async () => {
    const dir = await setup({ "w.cs": "\uFEFFclass A {\r\n  int x;\r\n}\r\n" });
    const { read } = await apply(dir, { path: "w.cs", edits: [{ old: "  int x;\n", new: "  int x;\n  int y;\n" }] });
    assert.equal(await read("w.cs"), "\uFEFFclass A {\r\n  int x;\r\n  int y;\r\n}\r\n");
  });

  test("refuses to commit when a file changed after planning, writing nothing", async () => {
    const dir = await setup({ "a.txt": "a\n", "b.txt": "b\n" });
    const p = planner(dir);
    const plan = await p.run({ edits: [{ path: "a.txt", old: "a", new: "A" }, { path: "b.txt", old: "b", new: "B" }] });
    await writeFile(join(dir, "b.txt"), "b changed\n");
    const changes = [...plan.files.values()].map((s) => ({ abs: s.abs, before: s.raw, after: toRaw(s, s.cur) }));
    await assert.rejects(commit(changes), /changed on disk/);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "a\n");
  });

  test("a write failing midway restores the files already written", async () => {
    const dir = await setup({ "a.txt": "a\n", "locked/b.txt": "b\n", "z.txt": "z\n" });
    const p = planner(dir);
    const plan = await p.run({
      edits: [{ path: "a.txt", old: "a", new: "A" }, { path: "locked/b.txt", old: "b", new: "B" }, { path: "z.txt", old: "z", new: "Z" }],
    });
    const changes = [...plan.files.values()].map((s) => ({ abs: s.abs, before: s.raw, after: toRaw(s, s.cur) }));
    const { chmod } = await import("node:fs/promises");
    await chmod(join(dir, "locked"), 0o555);
    try {
      await assert.rejects(commit(changes), /write failed.*All files were restored/);
    } finally {
      await chmod(join(dir, "locked"), 0o755);
    }
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(dir, "locked/b.txt"), "utf8"), "b\n");
    assert.equal(await readFile(join(dir, "z.txt"), "utf8"), "z\n");
  });

  test("the post-write re-read confirms the disk content and catches anything that differs", async () => {
    const dir = await setup({ "a.txt": "a\n", "b.txt": "b\n" });
    const plan = await planner(dir).run({ edits: [{ path: "a.txt", old: "a", new: "A" }, { path: "b.txt", old: "b", new: "B" }] });
    const changes = [...plan.files.values()].map((s) => ({ abs: s.abs, before: s.raw, after: toRaw(s, s.cur) }));
    await commit(changes);
    assert.deepEqual(await drift(changes), []);
    await writeFile(join(dir, "b.txt"), "B changed by a watcher\n");
    assert.deepEqual((await drift(changes)).map((d) => d.disk), ["B changed by a watcher\n"]);
  });

  test("planning is read-only (dry run)", async () => {
    const dir = await setup({ "a.txt": "a\n" });
    await planner(dir).run({ path: "a.txt", edits: [{ old: "a", new: "A" }] });
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "a\n");
    assert.ok(relative(root, dir));
  });
});

describe("feedback", () => {
  test("rewritten lines show as a word diff with fresh anchors; insertions as anchored lines", () => {
    const out = changedLines(lines("const total = sum(a);", "return total;"), lines("const total = sum(a, b);", "log(total);", "return total;"));
    assert.equal(out[0], "@@ 1");
    assert.ok(out.some((l) => l.startsWith(`~${anchorOf(1, "const total = sum(a, b);")}:`) && l.includes("{+, b+}")), out.join("\n"));
    assert.ok(out.includes(`+${anchorOf(2, "log(total);")}:log(total);`), out.join("\n"));
  });
});
