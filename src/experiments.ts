// Experiments under evaluation, each behind its own flag:
// - PI_MULTIEDIT_SEED=1: before the first model call, add the files the task most likely involves.
// - PI_MULTIEDIT_CACHE_KEY=1: key OpenAI's prompt cache by repository, not by session, so sessions,
//   worktrees and subagents of one repository share the cached prefix.
// - PI_MULTIEDIT_COMPACT=1: a plain bash rg/grep with a large output is grouped per file.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listFiles, readText } from "./fs.ts";
import { jevReranker } from "./jev.ts";
import { ReadCache, Reader } from "./reader.ts";

const run = promisify(execFile);
const SEED_MS = 5000;
const SEED_CHARS = 4000;

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);

export function registerSeed(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.prompt?.trim()) return undefined;
    const reader = new Reader(ctx.cwd, { read: readText, list: listFiles }, new ReadCache(), jevReranker(ctx.modelRegistry, ctx.cwd));
    const text = await within(reader.run([{ glob: "**/*", intent: event.prompt }]).catch(() => undefined), SEED_MS);
    if (!text) return undefined;
    const body = text.split("\n").slice(1).join("\n").trim().slice(0, SEED_CHARS);
    return {
      message: {
        customType: "pi-multiedit-seed",
        content: `Files this task most likely involves, ranked automatically from the request (candidates, not exhaustive; verify before relying on them). Lines carry anchors usable by edit.\n\n${body}`,
        display: false,
      },
    };
  });
}

let repoKey: Promise<string> | undefined;

/** A stable cache key for the repository: its first commit, or the working directory outside git. */
export function repositoryKey(cwd: string): Promise<string> {
  repoKey ??= run("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd })
    .then(({ stdout }) => stdout.trim().split("\n").pop() || cwd)
    .catch(() => cwd)
    .then((id) => `repo-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`);
  return repoKey;
}

export function registerCacheKey(pi: ExtensionAPI): void {
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object" || !("prompt_cache_key" in payload)) return undefined;
    return { ...payload, prompt_cache_key: await repositoryKey(ctx.cwd) };
  });
}

const PLAIN_SEARCH = /^\s*(rg|grep)\s[^|;&<>`$]*$/;
const COMPACT_ABOVE = 4000;
const LINES_PER_FILE = 3;
const FILES_SHOWN = 15;

/** Groups `path:line:text` search output per file: a few lines each, then the remaining files with counts. */
export function compactSearchOutput(output: string): string | undefined {
  if (output.length <= COMPACT_ABOVE) return undefined;
  const byFile = new Map<string, string[]>();
  let other = 0;
  for (const line of output.split("\n")) {
    const m = /^([^:\n]+?):(\d+)[:-](.*)$/.exec(line);
    if (!m) {
      if (line.trim()) other++;
      continue;
    }
    (byFile.get(m[1]) ?? byFile.set(m[1], []).get(m[1])!).push(`${m[2]}:${m[3].trim().slice(0, 200)}`);
  }
  if (byFile.size === 0) return undefined;
  const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
  const total = files.reduce((n, [, l]) => n + l.length, 0);
  const out = [`${total} matching lines in ${files.length} files (grouped by pi-multiedit; run the same command again for the full output)`];
  for (const [file, lines] of files.slice(0, FILES_SHOWN)) {
    out.push(`${file} (${lines.length})`, ...lines.slice(0, LINES_PER_FILE).map((l) => `  ${l}`));
    if (lines.length > LINES_PER_FILE) out.push(`  … ${lines.length - LINES_PER_FILE} more`);
  }
  const rest = files.slice(FILES_SHOWN);
  if (rest.length) out.push(`… ${rest.length} more files: ${rest.slice(0, 30).map(([f, l]) => `${f} (${l.length})`).join(", ")}`);
  if (other) out.push(`(${other} other output lines omitted)`);
  return out.join("\n");
}

export function registerCompactSearch(pi: ExtensionAPI): void {
  const compacted = new Set<string>();
  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || event.isError) return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!PLAIN_SEARCH.test(command)) return undefined;
    if (compacted.has(command)) {
      compacted.delete(command); // asked again right after a compacted answer: the full output stands
      return undefined;
    }
    const text = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const compact = compactSearchOutput(text);
    if (!compact) return undefined;
    compacted.add(command);
    return { content: [{ type: "text", text: compact }] };
  });
}
