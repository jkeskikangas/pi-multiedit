// Line numbers the model reads off shell output: `cat -n`/`nl` (`   12\tline`), and `rg -n`/`grep -n`
// with a path (`src/a.ts:12:line`, context lines `src/a.ts-12-line`) or without one (`12:line`, for a
// single file). Each numbered line is attributed to a file only when that file's current line has
// exactly that text, so a bare number in from/to then resolves with the usual stale check.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notePartial } from "./shown.ts";
import { splitLines } from "./text.ts";

type Numbered = { path?: string; n: number; text: string };

const CAT_N = /^ *(\d+)\t(.*)$/;
const WITH_PATH = /^([^\s:][^:]*?)(?::(\d+):|-(\d+)-)(.*)$/;
const NO_PATH = /^(\d+)[:-](.*)$/;
const MAX_FILES = 40;
const MAX_BYTES = 4 * 1024 * 1024;

// Hashes ignore trailing whitespace, and so does the comparison.
const same = (a: string | undefined, b: string) => a !== undefined && a.trimEnd() === b.trimEnd();

async function fileLines(abs: string): Promise<string[] | null> {
  const st = await stat(abs);
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const buf = await readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return splitLines(buf.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
}

/** Numbered lines in the output, in order; a run of lines without a path ends at any other line. */
export function numberedLines(output: string): Numbered[][] {
  const blocks: Numbered[][] = [];
  let run: Numbered[] = [];
  const end = () => (run.length > 0 && blocks.push(run), (run = []));
  for (const line of output.split("\n")) {
    const cat = CAT_N.exec(line);
    const bare = cat ?? NO_PATH.exec(line);
    if (bare) {
      run.push({ n: Number(bare[1]), text: bare[2] });
      continue;
    }
    end();
    const m = WITH_PATH.exec(line);
    if (m) blocks.push([{ path: m[1], n: Number(m[2] ?? m[3]), text: m[4] }]);
  }
  end();
  return blocks;
}

/** Directories a relative path in the output may be relative to: the cwd and every `cd` target. */
function bases(cwd: string, command: string): string[] {
  const out = [cwd];
  for (const m of command.matchAll(/(?:^|[;&|(\n]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    const dir = m[1].replace(/^["']|["']$/g, "");
    out.push(resolve(out[out.length - 1], dir), resolve(cwd, dir));
  }
  return [...new Set(out)];
}

/** Words in the command and whole output lines that look like file paths. */
function pathWords(command: string, output: string): string[] {
  const words = command.split(/[\s;&|()<>=]+/).map((w) => w.replace(/^["']|["']$/g, ""));
  const lines = output.split("\n").map((l) => l.trim());
  return [...new Set([...words, ...lines].filter((w) => /^[\w@.~/+-]*[\w-]\.?[\w-]*$/.test(w) && /[./]/.test(w) && !/^-/.test(w)))];
}

export async function harvest(cwd: string, command: string, output: string): Promise<void> {
  const blocks = numberedLines(output);
  if (blocks.length === 0) return;
  const dirs = bases(cwd, command);
  const files = new Map<string, string[] | null>();
  const load = async (rel: string): Promise<{ abs: string; lines: string[] }[]> => {
    const found: { abs: string; lines: string[] }[] = [];
    for (const dir of isAbsolute(rel) ? [""] : dirs) {
      const abs = await realpath(resolve(dir, rel)).catch(() => undefined);
      if (!abs) continue;
      if (!files.has(abs)) {
        if (files.size >= MAX_FILES) continue;
        files.set(abs, await fileLines(abs).catch(() => null));
      }
      const lines = files.get(abs);
      if (lines && !found.some((f) => f.abs === abs)) found.push({ abs, lines });
    }
    return found;
  };
  const seen = new Map<string, Map<number, string>>();
  const note = (abs: string, n: number, text: string) => {
    if (!seen.has(abs)) seen.set(abs, new Map());
    seen.get(abs)!.set(n, text);
  };
  const candidates = (await Promise.all(pathWords(command, output).map(load))).flat();
  for (const block of blocks) {
    if (block[0].path !== undefined) {
      const { path, n, text } = block[0];
      for (const f of await load(path!)) if (same(f.lines[n - 1], text)) note(f.abs, n, text);
      continue;
    }
    // A run without paths belongs to the one candidate file whose lines it reproduces.
    const fits = candidates.filter((f) => block.every(({ n, text }) => same(f.lines[n - 1], text)));
    if (new Set(fits.map((f) => f.abs)).size === 1) for (const { n, text } of block) note(fits[0].abs, n, text);
  }
  for (const [abs, lines] of seen) notePartial(abs, lines);
}

export function listenForShellViews(pi: ExtensionAPI): void {
  pi.on("tool_result", async (event, ctx) => {
    // A failing pipeline (grep without a match, say) can still have printed numbered lines.
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    const output = event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (typeof command === "string") await harvest(ctx.cwd, command, output).catch(() => {});
  });
}
