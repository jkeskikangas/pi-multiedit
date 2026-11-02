import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { lineHash } from "../src/hash.ts";
import { readSchema, registerReadTool, renderAnchored } from "../src/read.ts";
import { shownHash } from "../src/shown.ts";
import { registerEditTool } from "../src/tool.ts";

const tools = new Map<string, { name: string; execute: Function; renderCall?: Function }>();
const pi = { registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool) };
registerReadTool(pi as never);
registerEditTool(pi as never);
let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "multiedit-read-")); });
after(async () => rm(dir, { recursive: true, force: true }));
const read = (params: object, signal?: AbortSignal) => tools.get("read")!.execute("id", params, signal, undefined, { cwd: dir });
const edit = (edits: object[]) => tools.get("edit")!.execute("id", { edits }, undefined, undefined, { cwd: dir });
const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const bounded = (result: Parameters<typeof text>[0]) => {
  assert.ok(Buffer.byteLength(text(result)) <= DEFAULT_MAX_BYTES);
  assert.ok(text(result).split("\n").length <= DEFAULT_MAX_LINES);
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAP8BBAEAeX5eMQAAAABJRU5ErkJggg==", "base64");

test("the read schema preserves single-file calls and accepts per-file batch paging", () => {
  assert.ok(Value.Check(readSchema, { path: "a.txt" }));
  assert.ok(Value.Check(readSchema, { path: "a.txt", offset: 2, limit: 3 }));
  assert.ok(Value.Check(readSchema, { files: [{ path: "a.txt" }, { path: "b.txt", offset: 2, limit: 3 }] }));
  for (const params of [
    { files: [] }, { files: Array.from({ length: 21 }, () => ({ path: "a.txt" })) },
    { files: ["a.txt"] }, { files: [{ path: "a.txt", offset: 0 }] },
    { files: [{ path: "a.txt", limit: 0 }] }, { files: [{ path: "a.txt", extra: true }] },
    { path: "a.txt", paths: ["b.txt"] },
  ]) assert.ok(!Value.Check(readSchema, params), JSON.stringify(params));
});

test("read rejects ambiguous forms, misplaced paging and empty or oversized batches", async () => {
  for (const params of [{}, { path: "a.txt", files: [{ path: "b.txt" }] }]) {
    await assert.rejects(read(params), /Use exactly one of path or files/);
  }
  for (const params of [{ files: [{ path: "a.txt" }], offset: 2 }, { files: [{ path: "a.txt" }], limit: 2 }]) {
    await assert.rejects(read(params), /put offset\/limit inside each file entry/);
  }
  for (const files of [[], Array.from({ length: 21 }, () => ({ path: "a.txt" }))]) {
    await assert.rejects(read({ files }), /files must contain 1-20 entries/);
  }
});

test("single-file output and paging are unchanged", async () => {
  const raw = "\uFEFFfirst\r\nsecond\r\nthird\r\n";
  await writeFile(join(dir, "single.txt"), raw);
  const result = await read({ path: "single.txt", offset: 2, limit: 1 });
  assert.equal(text(result), renderAnchored(raw, 2, 1).out);
  assert.equal(result.details, undefined);
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(text(result), /==/);
  await assert.rejects(read({ path: "missing-single.txt" }), /ENOENT/);
  await assert.rejects(read({ path: "single.txt", offset: 10 }), /past the end/);
});

test("batch results are labeled in request order and their anchors and bare numbers edit each file", async () => {
  await writeFile(join(dir, "batch-a.txt"), "first\nsecond\n");
  await writeFile(join(dir, "batch-b.txt"), "alpha\nbeta\n");
  const result = await read({ files: [{ path: "batch-a.txt" }, { path: "batch-b.txt" }] });
  assert.equal(result.isError, undefined);
  assert.ok(text(result).indexOf('== "batch-a.txt" ==') < text(result).indexOf('== "batch-b.txt" =='));
  const anchor = /^(\d+#[A-Z]{2}):second$/m.exec(text(result))![1];
  await edit([{ path: "batch-a.txt", from: anchor, new: "SECOND" }, { path: "batch-b.txt", from: "2", new: "BETA" }]);
  assert.equal(await readFile(join(dir, "batch-a.txt"), "utf8"), "first\nSECOND\n");
  assert.equal(await readFile(join(dir, "batch-b.txt"), "utf8"), "alpha\nBETA\n");
});

test("batch entries page independently and record only the lines actually shown", async () => {
  const raw = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
  await writeFile(join(dir, "pages.txt"), raw);
  const result = await read({ files: [{ path: "pages.txt", offset: 3, limit: 2 }, { path: "pages.txt", offset: 8, limit: 1 }] });
  assert.match(text(result), /^3#[A-Z]{2}:line3$/m);
  assert.match(text(result), /^8#[A-Z]{2}:line8$/m);
  assert.match(text(result), /Continue with offset=5/);
  assert.match(text(result), /Continue with offset=9/);
  const canonical = await realpath(join(dir, "pages.txt"));
  assert.equal(shownHash(canonical, 1), undefined);
  assert.equal(shownHash(canonical, 3), lineHash(3, "line3"));
  assert.equal(shownHash(canonical, 8), lineHash(8, "line8"));
  assert.equal(shownHash(canonical, 9), undefined);
});

test("a batch view retains stale-line protection", async () => {
  await writeFile(join(dir, "stale.txt"), "original\n");
  await read({ files: [{ path: "stale.txt" }] });
  await writeFile(join(dir, "stale.txt"), "other writer\n");
  await assert.rejects(edit([{ path: "stale.txt", from: "1", new: "wrong" }]));
  assert.equal(await readFile(join(dir, "stale.txt"), "utf8"), "other writer\n");
});

test("batch reads record canonical paths, including directory aliases", async () => {
  await mkdir(join(dir, "real-dir"));
  await writeFile(join(dir, "real-dir", "alias.txt"), "before\n");
  await symlink(join(dir, "real-dir"), join(dir, "alias-dir"), process.platform === "win32" ? "junction" : "dir");
  await read({ files: [{ path: "alias-dir/alias.txt" }] });
  await edit([{ path: "real-dir/alias.txt", from: "1", new: "after" }]);
  assert.equal(await readFile(join(dir, "real-dir", "alias.txt"), "utf8"), "after\n");
});

test("errors retain successful results before and after missing files, directories and invalid offsets", async () => {
  await writeFile(join(dir, "errors-ok.txt"), "visible\n");
  await mkdir(join(dir, "a-directory"));
  const result = await read({ files: [
    { path: "errors-ok.txt" }, { path: "missing-batch.txt" }, { path: "a-directory" },
    { path: "errors-ok.txt", offset: 20 }, { path: "errors-ok.txt" },
  ] });
  assert.equal(result.isError, true);
  assert.equal((text(result).match(/^1#[A-Z]{2}:visible$/gm) ?? []).length, 2);
  assert.match(text(result), /== "missing-batch.txt" ==\nError:.*ENOENT/);
  assert.match(text(result), /== "a-directory" ==\nError:.*is a directory/);
  assert.match(text(result), /Error: offset 20 is past the end/);
  bounded(result);
});

test("a batch where every file fails is an error with every file labeled", async () => {
  const result = await read({ files: [{ path: "absent-a.txt" }, { path: "absent-b.txt" }] });
  assert.equal(result.isError, true);
  assert.equal((text(result).match(/Error:.*ENOENT/g) ?? []).length, 2);
  assert.match(text(result), /== "absent-a.txt" ==/);
  assert.match(text(result), /== "absent-b.txt" ==/);
});

test("an empty file does not prevent later batch reads", async () => {
  await writeFile(join(dir, "empty.txt"), "");
  await writeFile(join(dir, "after-empty.txt"), "after\n");
  const result = await read({ files: [{ path: "empty.txt" }, { path: "after-empty.txt" }] });
  assert.match(text(result), /empty file/);
  assert.match(text(result), /^1#[A-Z]{2}:after$/m);
  assert.equal(result.isError, undefined);
});

test("single and batch image reads preserve attachments alongside anchored text", async () => {
  await writeFile(join(dir, "pixel.png"), png);
  await writeFile(join(dir, "with-image.txt"), "text beside image\n");
  const single = await read({ path: "pixel.png" });
  const batch = await read({ files: [{ path: "pixel.png" }, { path: "with-image.txt" }] });
  const image = single.content.find((block: { type: string }) => block.type === "image");
  assert.ok(image, text(single));
  assert.deepEqual(batch.content.find((block: { type: string }) => block.type === "image"), image);
  assert.match(text(batch), /== "pixel.png" ==/);
  assert.match(text(batch), /^1#[A-Z]{2}:text beside image$/m);
  bounded(batch);
});

test("non-text fallback remains unanchored and does not record a text view", async () => {
  await writeFile(join(dir, "nul.bin"), Buffer.from("a\0b\n"));
  const single = await read({ path: "nul.bin" });
  const batch = await read({ files: [{ path: "nul.bin" }] });
  assert.ok(text(batch).includes(text(single)));
  assert.doesNotMatch(text(batch), /^\d+#[A-Z]{2}:/m);
  assert.equal(shownHash(await realpath(join(dir, "nul.bin")), 1), undefined);
});

test("a shared line budget keeps whole anchors, gives a continuation and leaves later files unseen", async () => {
  const raw = Array.from({ length: 1400 }, (_, i) => `l${i + 1}`).join("\n");
  await writeFile(join(dir, "lines-a.txt"), raw);
  await writeFile(join(dir, "lines-b.txt"), raw);
  await writeFile(join(dir, "lines-unseen.txt"), "not shown\n");
  const result = await read({ files: [{ path: "lines-a.txt" }, { path: "lines-b.txt" }, { path: "lines-unseen.txt" }] });
  bounded(result);
  assert.match(text(result), /Batch output limit reached at files\[1\]/);
  const offset = Number(/Continue this file with offset=(\d+)/.exec(text(result))![1]);
  assert.ok(offset > 1 && offset < 1400);
  const canonical = await realpath(join(dir, "lines-b.txt"));
  assert.equal(shownHash(canonical, offset - 1), lineHash(offset - 1, `l${offset - 1}`));
  assert.equal(shownHash(canonical, offset), undefined);
  assert.equal(shownHash(await realpath(join(dir, "lines-unseen.txt")), 1), undefined);
  const continued = await read({ files: [{ path: "lines-b.txt", offset }, { path: "lines-unseen.txt" }] });
  assert.match(text(continued), new RegExp(`^ *${offset}#[A-Z]{2}:l${offset}$`, "m"));
  assert.match(text(continued), /^1#[A-Z]{2}:not shown$/m);
});

test("the shared byte budget counts UTF-8 without splitting lines or recording omitted content", async () => {
  const line = "é界".repeat(40);
  const raw = Array.from({ length: 180 }, () => line).join("\n");
  await writeFile(join(dir, "bytes-a.txt"), raw);
  await writeFile(join(dir, "bytes-b.txt"), raw);
  const result = await read({ files: [{ path: "bytes-a.txt" }, { path: "bytes-b.txt" }] });
  bounded(result);
  assert.match(text(result), /Batch output limit reached at files\[1\]/);
  assert.doesNotMatch(text(result), /\uFFFD/);
  for (const match of text(result).matchAll(/^ *\d+#[A-Z]{2}:(.*)$/gm)) assert.equal(match[1], line);
  const offset = Number(/Continue this file with offset=(\d+)/.exec(text(result))![1]);
  assert.equal(shownHash(await realpath(join(dir, "bytes-b.txt")), offset), undefined);
});

test("an oversized first line yields a bounded actionable notice rather than a broken anchor", async () => {
  await writeFile(join(dir, "huge-line.txt"), "x".repeat(DEFAULT_MAX_BYTES * 2));
  const result = await read({ files: [{ path: "huge-line.txt" }] });
  bounded(result);
  assert.match(text(result), /Continue this file with offset=1/);
  assert.match(text(result), /Read this file separately/);
  assert.doesNotMatch(text(result), /^\d+#[A-Z]{2}:/m);
  assert.equal(shownHash(await realpath(join(dir, "huge-line.txt")), 1), undefined);
});

test("oversized file labels cannot bypass the batch text budget", async () => {
  const result = await read({ files: [{ path: "x".repeat(DEFAULT_MAX_BYTES * 2) }] });
  bounded(result);
  assert.match(text(result), /Retry files\[0\] onward/);
});

test("aborted reads fail without recording a batch view", async () => {
  await writeFile(join(dir, "aborted.txt"), "not seen\n");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read({ files: [{ path: "aborted.txt" }] }, controller.signal));
  await assert.rejects(read({ path: "aborted.txt" }, controller.signal));
  assert.equal(shownHash(await realpath(join(dir, "aborted.txt")), 1), undefined);
});

test("cancellation between batch files does not record staged views", async (t) => {
  await writeFile(join(dir, "cancel-first.txt"), "first\n");
  await writeFile(join(dir, "cancel-second.txt"), "second\n");
  const controller = new AbortController();
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, "throwIfAborted", () => {
    // The fifth cancellation checkpoint starts the second file, after the first was staged.
    if (++checks === 5) controller.abort();
    original();
  });
  await assert.rejects(read({ files: [{ path: "cancel-first.txt" }, { path: "cancel-second.txt" }] }, controller.signal));
  assert.equal(checks, 5);
  assert.equal(shownHash(await realpath(join(dir, "cancel-first.txt")), 1), undefined);
  assert.equal(shownHash(await realpath(join(dir, "cancel-second.txt")), 1), undefined);
});

test("batch call rendering identifies the requested files", () => {
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
  const component = tools.get("read")!.renderCall!({ files: [{ path: "a.txt" }, { path: "b.txt" }] }, theme, {});
  assert.match(component.render(100).join("\n"), /read.*a.txt, b.txt/);
});
