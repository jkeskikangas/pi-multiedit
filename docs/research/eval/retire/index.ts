// Research prototype: retire old tool results from the context sent to the model.
// A tool result older than K assistant turns, outside the newest N results, and not an edit
// result, is replaced by a one-line stub. Retirement is decided only every B turns (so the
// cached prefix is rewritten rarely) and is sticky for the session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const K = Number(process.env.PI_RETIRE_K ?? 30);
const N = Number(process.env.PI_RETIRE_N ?? 10);
const B = Number(process.env.PI_RETIRE_B ?? 5);
const KEEP = new Set((process.env.PI_RETIRE_KEEP ?? "edit").split(","));
const LOG = process.env.PI_RETIRE_LOG;

const retired = new Map<string, string>(); // toolCallId -> stub text

export default function (pi: ExtensionAPI): void {
  pi.on("context", async (event) => {
    const msgs = event.messages as any[];
    const turns = msgs.filter((m) => m.role === "assistant").length;
    // position of each tool result: how many assistant messages precede it
    const results: { i: number; turn: number }[] = [];
    let seen = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant") seen++;
      else if (m.role === "toolResult") results.push({ i, turn: seen });
    }
    if (turns % B === 0) {
      const candidates = results.slice(0, Math.max(0, results.length - N)).filter((r) => turns - r.turn > K);
      for (const r of candidates) {
        const m = msgs[r.i];
        if (retired.has(m.toolCallId) || KEEP.has(m.toolName)) continue;
        const text = (m.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");
        const first = text.split("\n", 1)[0].slice(0, 120);
        retired.set(
          m.toolCallId,
          `[retired: this ${m.toolName} result (${text.length} chars, from ${turns - r.turn} turns ago) was removed from context to save space. First line was: ${first}\nCall the tool again if you need it.]`,
        );
      }
    }
    if (retired.size === 0) return;
    let n = 0;
    const out = msgs.map((m) => {
      if (m.role !== "toolResult" || !retired.has(m.toolCallId)) return m;
      n++;
      return { ...m, content: [{ type: "text", text: retired.get(m.toolCallId) }] };
    });
    if (LOG) process.stderr.write(`[retire] turn ${turns}: ${n} results stubbed\n`);
    return { messages: out };
  });
}
