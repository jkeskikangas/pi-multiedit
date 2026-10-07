// `read`: many reads in one call. Each read is a scope (path or glob) and at most one selector
// (a line range, a search or an outline); every text line carries an N#HH anchor for edit.
import { extname, resolve } from "node:path";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listFiles, readText } from "./fs.ts";
import { jevReranker } from "./jev.ts";
import { MAX_BYTES, MAX_LINES, ReadCache, Reader, validate, type ReadItem } from "./reader.ts";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const base = {
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  outline: Type.Optional(Type.Boolean()),
};
const searching = {
  search: Type.Optional(Type.String()),
  flags: Type.Optional(Type.String()),
  context: Type.Optional(Type.Integer({ minimum: 0 })),
  intent: Type.Optional(Type.String()),
};
const schemaWith = (search: boolean) =>
  Type.Object(
    { reads: Type.Array(Type.Object(search ? { ...base, ...searching } : base, { additionalProperties: false }), { minItems: 1 }) },
    { additionalProperties: false },
  );

const SEARCH_LINES = `- search (+ context, flags): JS regex, line by line, over the path or every file in the glob; matching lines come back with context lines around them (default 2).
- intent: a task in plain words, e.g. "where the diff preview's context lines are set"; returns the files the task most likely involves, best first, with their matching declarations and lines.
`;
const describe = (search: boolean) => `${search ? "Read and search files" : "Read files"}: many reads in one call. Each read: a scope (path, or glob over git-visible files) and at most one selector.
- none: a path returns the whole file; a glob lists the matching files.
- offset/limit (path only): a line range.
${search ? SEARCH_LINES : ""}- outline: the declarations and headings of the path or of every file in the glob (TypeScript, JavaScript, Python, Markdown; other languages with their grammar).
Lines come back as N#HH:content; pass the anchors to edit (from/to) without reading again.
A re-read of unchanged lines returns a short "unchanged" note; read it again if you need the text itself.
Output is capped at ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB per call; the result says what was left out and how to get it.
${search ? "Use one read call instead of cat, sed, head, grep, rg or find in bash." : "Use read instead of cat, sed or head in bash; search with grep."}

Example:
${search ? '{"reads": [{"glob": "**/*", "intent": "where users are fetched by id"}, {"glob": "src/**/*.ts", "search": "findOrThrow\\\\("}, {"path": "src/users.ts", "offset": 1, "limit": 40}]}' : '{"reads": [{"path": "src/repo.ts", "outline": true}, {"path": "src/users.ts", "offset": 1, "limit": 40}, {"glob": "src/**/*.ts"}]}'}`;

/** `search: false` leaves searching to the grep tool, so each tool has one job. */
export function registerReadTool(pi: ExtensionAPI, opts: { search?: boolean } = {}): void {
  const search = opts.search ?? true;
  const cache = new ReadCache();
  // The model loses earlier reads on compaction, and tree navigation changes what it has seen.
  const reset = async () => cache.reset();
  pi.on("session_start", reset);
  pi.on("session_compact", reset);
  pi.on("session_tree", reset);
  pi.registerTool({
    name: "read",
    label: "read",
    description: describe(search),
    promptSnippet: search ? "Read files, search them and outline them, many at once; lines carry anchors for edit" : "Read and outline files, many at once; lines carry anchors for edit",
    parameters: schemaWith(search),
    async execute(id, params: { reads: ReadItem[] }, signal, onUpdate, ctx) {
      const problems = validate(params.reads);
      if (problems.length) throw new Error(problems.join("\n"));
      const only = params.reads.length === 1 ? params.reads[0] : undefined;
      if (only?.path !== undefined && IMAGE.has(extname(only.path).toLowerCase()) && only.search === undefined && !only.outline) {
        // Images go to pi's built-in read, which returns them as attachments.
        return createReadToolDefinition(ctx.cwd).execute(id, { path: resolve(ctx.cwd, only.path) }, signal, onUpdate, ctx);
      }
      const text = await new Reader(ctx.cwd, { read: readText, list: listFiles }, cache, jevReranker(ctx.modelRegistry, ctx.cwd)).run(params.reads);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
