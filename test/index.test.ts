import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../index.ts";

test("the extension withdraws pi's write tool: whole-file edits replace it", async () => {
  const handlers = new Map<string, Function>();
  let active = ["read", "bash", "edit", "write", "grep"];
  extension({
    registerTool: () => {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
  } as never);
  await handlers.get("session_start")!({}, {});
  assert.deepEqual(active, ["read", "bash", "edit", "grep"]);
  // Tree navigation restores the transcript's tool set; the extension withdraws write again.
  active = ["read", "bash", "edit", "write"];
  await handlers.get("session_tree")!({}, {});
  assert.deepEqual(active, ["read", "bash", "edit"]);
});
