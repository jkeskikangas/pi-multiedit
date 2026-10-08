import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.ts";
import { listenForViews } from "./src/shown.ts";
import { registerEditTool } from "./src/tool.ts";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
  // Files another extension showed with anchors count as read (see VIEW_EVENT).
  listenForViews(pi);
  // Whole-file edits create and overwrite files, so pi's write tool would be a second way to do it.
  // Tree navigation restores the tool set recorded in the transcript, so withdraw it there too.
  const withdrawWrite = async () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "write"));
  pi.on("session_start", withdrawWrite);
  pi.on("session_tree", withdrawWrite);
}
