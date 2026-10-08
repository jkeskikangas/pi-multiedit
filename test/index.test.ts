import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { shownHash, VIEW_EVENT } from "../src/shown.ts";
import { lineHash } from "../src/hash.ts";

const events = () => {
  const subs = new Map<string, ((data: unknown) => void)[]>();
  return {
    on: (ch: string, h: (data: unknown) => void) => (subs.set(ch, [...(subs.get(ch) ?? []), h]), () => {}),
    emit: (ch: string, data: unknown) => subs.get(ch)?.forEach((h) => h(data)),
  };
};

test("the extension withdraws pi's write tool: whole-file edits replace it", async () => {
  const handlers = new Map<string, Function>();
  let active = ["read", "bash", "edit", "write", "grep"];
  extension({
    registerTool: () => {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
    events: events(),
  } as never);
  await handlers.get("session_start")!({}, {});
  assert.deepEqual(active, ["read", "bash", "edit", "grep"]);
  // Tree navigation restores the transcript's tool set; the extension withdraws write again.
  active = ["read", "bash", "edit", "write"];
  await handlers.get("session_tree")!({}, {});
  assert.deepEqual(active, ["read", "bash", "edit"]);
});

test("a file another extension shows with anchors counts as shown, so bare line numbers resolve against it", async () => {
  const bus = events();
  extension({ registerTool: () => {}, on: () => {}, getActiveTools: () => [], setActiveTools: () => {}, events: bus } as never);
  const dir = await mkdtemp(join(tmpdir(), "pme-view-"));
  const file = join(dir, "a.ts");
  await writeFile(file, "export const a = 1;\nexport const b = 2;\n");
  bus.emit(VIEW_EVENT, { path: "relative.ts", text: "x" });
  bus.emit(VIEW_EVENT, { path: file, text: "export const a = 1;\nexport const b = 2;\n" });
  const { realpath } = await import("node:fs/promises");
  const abs = await realpath(file);
  for (let i = 0; i < 20 && shownHash(abs, 2) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(shownHash(abs, 2), lineHash(2, "export const b = 2;"));
  assert.equal(shownHash(join(process.cwd(), "relative.ts"), 1), undefined);
});
