import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.ts";
import { registerEditTool } from "./src/tool.ts";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  // Whole-file edits create and overwrite files, so pi's write tool would be a second way to do it;
  // Tree navigation restores the tool set recorded in the transcript, so withdraw it there too.
  // read searches, outlines and lists files too, so pi's grep, find and ls go the same way.
  const withdrawn = new Set(["write", "grep", "find", "ls"]);
  const withdraw = async () => pi.setActiveTools(pi.getActiveTools().filter((name) => !withdrawn.has(name)));
  pi.on("session_start", withdraw);
  pi.on("session_tree", withdraw);
}
