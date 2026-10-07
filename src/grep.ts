// `grep`: search by regex or by intent, many searches in one call, over the whole repository
// unless a path or glob narrows it. Replaces pi's grep; reading stays in read.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listFiles, readText } from "./fs.ts";
import { jevReranker } from "./jev.ts";
import { MAX_BYTES, MAX_LINES, ReadCache, Reader, validate, type ReadItem } from "./reader.ts";

type Search = { pattern?: string; intent?: string; path?: string; glob?: string; context?: number; flags?: string };

const search = Type.Object(
  {
    pattern: Type.Optional(Type.String()),
    intent: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    context: Type.Optional(Type.Integer({ minimum: 0 })),
    flags: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const DESCRIPTION = `Search files: many searches in one call, over the whole repository (git-visible files) unless path or glob narrows it. Each search has a pattern or an intent.
- pattern (+ context, flags): JS regex, line by line; matching lines come back with context lines around them (default 2).
- intent: a task in plain words, e.g. "where the diff preview's context lines are set"; returns the files the task most likely involves, best first, with their matching declarations and lines. Use it when you don't know the names yet.
Lines come back as N#HH:content; pass the anchors to edit (from/to) without reading the file first.
Output is capped at ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB per call. Use grep instead of grep, rg or find in bash.

Example:
{"searches": [{"intent": "where users are fetched by id"}, {"pattern": "findOrThrow\\\\(", "glob": "src/**/*.ts", "context": 1}]}`;

export function registerGrepTool(pi: ExtensionAPI): void {
  const cache = new ReadCache(); // searches are never stubbed; the reader needs one anyway
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: DESCRIPTION,
    promptSnippet: "Search files by regex or by intent (a task in plain words), many at once",
    parameters: Type.Object({ searches: Type.Array(search, { minItems: 1 }) }, { additionalProperties: false }),
    async execute(_id, params: { searches: Search[] }, _signal, _onUpdate, ctx) {
      const problems: string[] = [];
      const items: ReadItem[] = params.searches.map((s, i) => {
        if ((s.pattern === undefined) === (s.intent === undefined)) problems.push(`search ${i + 1}: give pattern or intent`);
        const scope = s.path !== undefined ? { path: s.path } : { glob: s.glob ?? "**/*" };
        return { ...scope, search: s.pattern, intent: s.intent, context: s.context, flags: s.flags };
      });
      problems.push(...validate(items));
      if (problems.length) throw new Error(problems.join("\n"));
      const text = await new Reader(ctx.cwd, { read: readText, list: listFiles }, cache, ctx.modelRegistry ? jevReranker(ctx.modelRegistry, ctx.cwd) : undefined).run(items);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
