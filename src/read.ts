// `read` with LINE#HASH anchors on every text line (same format as pi-hashline-edit). Images and
// other non-text files go to pi's built-in read.
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatAnchored, parseAnchor } from "./hash.ts";
import { notePartial, noteShown } from "./shown.ts";
import { splitLines } from "./text.ts";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const MAX_FILES = 20;
const fileSchema = Type.Object(
  {
    path: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "first line, 1-based" })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const readSchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    offset: fileSchema.properties.offset,
    limit: fileSchema.properties.limit,
    files: Type.Optional(Type.Array(fileSchema, { minItems: 1, maxItems: MAX_FILES })),
  },
  { additionalProperties: false },
);

type FileParams = Static<typeof fileSchema>;
type ReadExecution = ReturnType<typeof createReadToolDefinition>["execute"];
type ReadResult = Awaited<ReturnType<ReadExecution>>;

/** Read without recording a view: a batch may show only part of this result, or none of it. */
async function readOne(
  id: string,
  params: FileParams,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<ReadExecution>[3],
  ctx: Parameters<ReadExecution>[4],
): Promise<{ result: ReadResult; canonical?: string; view?: string }> {
  signal?.throwIfAborted();
  const abs = resolve(ctx.cwd, params.path.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  const info = await stat(abs);
  if (info.isDirectory()) throw new Error(`${params.path} is a directory; use ls or find`);
  const buf = await readFile(abs, { signal });
  if (IMAGE.has(extname(abs).toLowerCase()) || buf.subarray(0, 8192).includes(0)) {
    return { result: await createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx) };
  }
  const { out, view } = renderAnchored(buf.toString("utf8"), params.offset, params.limit);
  const canonical = await realpath(abs).catch(() => abs);
  signal?.throwIfAborted();
  return { result: { content: [{ type: "text", text: out }], details: undefined }, canonical, view };
}

async function readBatch(id: string, files: FileParams[], signal: AbortSignal | undefined, ctx: Parameters<ReadExecution>[4]) {
  const content: ReadResult["content"] = [];
  const views: { canonical: string; lines: Map<number, string> }[] = [];
  // Reserve room for a final continuation notice. Count headers, separators and error text too.
  let bytes = DEFAULT_MAX_BYTES - 256;
  let lines = DEFAULT_MAX_LINES - 3;
  let failed = false;
  const append = (text: string) => {
    content.push({ type: "text", text });
    bytes -= Buffer.byteLength(text) + 1;
    lines -= text.split("\n").length;
  };

  batch: for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    const header = `== ${JSON.stringify(file.path)} ==`;
    if (bytes < Buffer.byteLength(header) + 2 || lines < 2) {
      append(`[Batch output limit reached. Retry files[${index}] onward in another read call.]`);
      break;
    }
    append(header);
    let read: Awaited<ReturnType<typeof readOne>>;
    try {
      // Batch updates must not bypass labeling or the shared output budget.
      read = await readOne(id, file, signal, undefined, ctx);
    } catch (error) {
      signal?.throwIfAborted();
      failed = true;
      read = { result: { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: undefined } };
    }
    signal?.throwIfAborted();
    for (const block of read.result.content) {
      if (block.type !== "text") {
        content.push(block);
        continue;
      }
      const clipped = truncateHead(block.text, { maxBytes: Math.max(0, bytes - 1), maxLines: Math.max(0, lines) });
      if (clipped.content) append(clipped.content);
      const shown = new Map<number, string>();
      if (read.canonical) {
        for (const line of clipped.content.split("\n")) {
          const anchor = parseAnchor(line);
          if (anchor?.content !== undefined) shown.set(anchor.line, anchor.content);
        }
        if (shown.size) views.push({ canonical: read.canonical, lines: shown });
      }
      if (clipped.truncated) {
        const next = shown.size ? Math.max(...shown.keys()) + 1 : (file.offset ?? 1);
        const continuation = read.canonical ? ` Continue this file with offset=${next}.` : "";
        const longLine = clipped.firstLineExceedsLimit ? " Read this file separately for more space." : "";
        append(`[Batch output limit reached at files[${index}].${continuation}${longLine} Retry remaining files separately.]`);
        break batch;
      }
    }
  }
  // Cancellation must not record output that the model never receives.
  signal?.throwIfAborted();
  for (const view of views) notePartial(view.canonical, view.lines);
  return { content, details: undefined, isError: failed || undefined };
}

/**
 * The text `read` shows for a file's content: `N#HH:` lines from `offset`, capped and paged. `view` is
 * the whole file as shown (BOM dropped, LF endings), to record as seen; undefined for an empty file.
 */
export function renderAnchored(raw: string, offset?: number, limit?: number): { out: string; view?: string } {
  let text = raw;
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = splitLines(text.replace(/\r\n/g, "\n"));
  if (lines.length === 0) return { out: "(empty file; create content with edit files[].write)" };
  const first = offset ?? 1;
  if (first > lines.length) throw new Error(`offset ${first} is past the end (${lines.length} lines)`);
  const last = Math.min(lines.length, first - 1 + (limit ?? DEFAULT_MAX_LINES), first - 1 + DEFAULT_MAX_LINES);
  const picked: string[] = [];
  let bytes = 0;
  for (let n = first; n <= last; n++) {
    bytes += Buffer.byteLength(lines[n - 1]) + 10;
    if (bytes > DEFAULT_MAX_BYTES && picked.length > 0) break;
    picked.push(lines[n - 1]);
  }
  let out = formatAnchored(picked, first);
  const end = first + picked.length - 1;
  if (end < lines.length) out += `\n\n[Lines ${first}-${end} of ${lines.length}. Continue with offset=${end + 1}.]`;
  return { out, view: lines.join("\n") };
}

export function registerReadTool(pi: ExtensionAPI): void {
  const builtin = createReadToolDefinition(process.cwd());
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read one file with {path, offset?, limit?}, or up to ${MAX_FILES} with {files: [{path, offset?, limit?}, ...]}. Use exactly one form; paging belongs inside each batch entry. Lines come back as N#HH:content; use the anchors in edit (from/to). Output is capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; batches share that text budget and label each file in request order. Per-file errors keep successful reads but mark the batch as an error. On a batch limit, retry the indicated file/offset and remaining files. Images come back as attachments (outside the text budget).`,
    promptSnippet: "Read files singly or in batches; text lines carry LINE#HASH anchors for edit",
    parameters: readSchema,
    async execute(id, params, signal, onUpdate, ctx) {
      if ((params.path === undefined) === (params.files === undefined)) throw new Error("Use exactly one of path or files");
      if (params.files !== undefined) {
        if (params.offset !== undefined || params.limit !== undefined) throw new Error("With files, put offset/limit inside each file entry");
        if (params.files.length < 1 || params.files.length > MAX_FILES) throw new Error(`files must contain 1-${MAX_FILES} entries`);
        return readBatch(id, params.files, signal, ctx);
      }
      const read = await readOne(id, { path: params.path!, offset: params.offset, limit: params.limit }, signal, onUpdate, ctx);
      // Preserve the single-file view behavior; batch reads record only the lines actually returned.
      if (read.view !== undefined) noteShown(read.canonical!, read.view);
      return read.result;
    },
    renderCall(args, theme, context) {
      if (!args.files) {
        const single = { path: args.path!, offset: args.offset, limit: args.limit };
        return builtin.renderCall!(single, theme, { ...context, args: single });
      }
      const shown = args.files.slice(0, 3).map((file) => file.path).join(", ");
      const more = args.files.length > 3 ? ` +${args.files.length - 3} more` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", shown)}${theme.fg("muted", more)}`, 0, 0);
    },
  });
}
