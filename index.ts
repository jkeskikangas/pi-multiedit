import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.ts";
import { registerEditTool } from "./src/tool.ts";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  // Whole-file edits create and overwrite files, so pi's write tool would be a second way to do it.
  pi.on("session_start", async () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "write"));
  });
}
