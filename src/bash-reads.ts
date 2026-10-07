// Half of agents' reading goes through bash. A plain `cat` of a large file gets the same shaping
// as read: the outline plus the parts the task is about. Running the same cat again returns the
// full output, so nothing is out of reach.
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { focusOf } from "./focus.ts";
import { listFiles, readText } from "./fs.ts";
import { ReadCache, Reader } from "./reader.ts";

const PLAIN_CAT = /^\s*cat\s+(['"]?)([^\s'";|&<>()$`]+)\1\s*$/;

export function registerBashReads(pi: ExtensionAPI): void {
  const shapedOnce = new Set<string>();
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return undefined;
    const m = PLAIN_CAT.exec(String((event.input as { command?: unknown }).command ?? ""));
    if (!m) return undefined;
    const abs = resolve(ctx.cwd, m[2]);
    if (shapedOnce.has(abs)) {
      shapedOnce.delete(abs); // asked again right after a shaped answer: the full output stands
      return undefined;
    }
    const text = await new Reader(ctx.cwd, { read: readText, list: listFiles }, new ReadCache(), undefined, focusOf(ctx.sessionManager))
      .run([{ path: m[2] }])
      .catch(() => undefined);
    if (!text || !/; showing (the outline|the outline and)/.test(text.split("\n")[0])) return undefined;
    shapedOnce.add(abs);
    return { content: [{ type: "text", text: `${text}\n\n(cat of a large file, shaped by pi-multiedit; run the same cat again for the full output)` }] };
  });
}
