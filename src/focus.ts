// What the session is working on, for shaping large reads: the latest user request and the
// arguments of recent searches. Read from the session branch; nothing is stored.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const RECENT_MESSAGES = 10;
const SEARCH_ARGS = ["search", "pattern", "intent"];

type Block = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

export function focusOf(sessionManager: ExtensionContext["sessionManager"] | undefined): string {
  const entries = sessionManager?.getBranch?.() ?? [];
  const messages = entries.flatMap((e) => (e.type === "message" ? [e.message as { role: string; content: unknown }] : []));
  const parts: string[] = [];
  const user = [...messages].reverse().find((m) => m.role === "user");
  const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? (c as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(" ") : "");
  if (user) parts.push(text(user.content));
  for (const m of messages.slice(-RECENT_MESSAGES)) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Block[]) {
      if (b.type !== "toolCall") continue;
      for (const item of [b.arguments ?? {}, ...((b.arguments?.reads ?? b.arguments?.searches ?? []) as Record<string, unknown>[])]) {
        for (const key of SEARCH_ARGS) if (typeof item[key] === "string") parts.push(item[key] as string);
      }
    }
  }
  return parts.join("\n").slice(0, 4000);
}
