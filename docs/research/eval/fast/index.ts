// Eval helper: request OpenAI's priority ("fast") service tier on every Codex Responses request.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let logged = false;
export default function (pi: ExtensionAPI): void {
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || !("input" in payload || "messages" in payload)) return undefined;
    if (!logged) {
      logged = true;
      process.stderr.write(`[fast] service_tier=priority set on ${String(payload.model)}\n`);
    }
    return { ...payload, service_tier: "priority" };
  });
}
