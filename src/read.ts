// `read` with LINE#HASH anchors on every text line (same format as pi-hashline-edit). Images and
// other non-text files go to pi's built-in read.
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatAnchored } from "./hash.ts";
import { noteShown } from "./shown.ts";
import { splitLines } from "./text.ts";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const schema = Type.Object(
  {
    path: Type.String(),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "first line, 1-based" })),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export function registerReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read a file. Lines come back as N#HH:content; use the anchors in edit (from/to). Page with offset/limit (cap ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}). Images come back as attachments.`,
    promptSnippet: "Read files; text lines carry LINE#HASH anchors for edit",
    parameters: schema,
    async execute(id, params, signal, onUpdate, ctx) {
      const abs = resolve(ctx.cwd, params.path.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      const info = await stat(abs);
      if (info.isDirectory()) throw new Error(`${params.path} is a directory; use ls or find`);
      const buf = await readFile(abs);
      if (IMAGE.has(extname(abs).toLowerCase()) || buf.subarray(0, 8192).includes(0)) {
        return createReadToolDefinition(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
      }
      let text = buf.toString("utf8");
      if (text.startsWith("\uFEFF")) text = text.slice(1);
      const lines = splitLines(text.replace(/\r\n/g, "\n"));
      if (lines.length === 0) return { content: [{ type: "text", text: "(empty file; create content with edit files[].write)" }], details: undefined };
      const first = params.offset ?? 1;
      if (first > lines.length) throw new Error(`offset ${first} is past the end (${lines.length} lines)`);
      const last = Math.min(lines.length, first - 1 + (params.limit ?? DEFAULT_MAX_LINES), first - 1 + DEFAULT_MAX_LINES);
      const picked: string[] = [];
      let bytes = 0;
      for (let n = first; n <= last; n++) {
        bytes += Buffer.byteLength(lines[n - 1]) + 10;
        if (bytes > DEFAULT_MAX_BYTES && picked.length > 0) break;
        picked.push(lines[n - 1]);
      }
      let out = formatAnchored(picked, first);
      noteShown(abs, lines.join("\n"));
      const end = first + picked.length - 1;
      if (end < lines.length) out += `\n\n[Lines ${first}-${end} of ${lines.length}. Continue with offset=${end + 1}.]`;
      return { content: [{ type: "text", text: out }], details: undefined };
    },
  });
}
