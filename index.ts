import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReadTool } from "./src/read.ts";
import { registerEditTool } from "./src/tool.ts";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);
}
