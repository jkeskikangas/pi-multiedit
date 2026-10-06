// Always-on, config-free syntax check of edited files: parse before and after, report only the
// errors the edit introduced. Advisory: multi-step refactors legitimately pass through broken states.
import { extname } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { syntaxErrorLines } from "./ast.ts";
import { lineAt, lineStarts } from "./text.ts";

function errorLines(path: string, text: string): number[] | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".json" || ext === ".jsonc") {
    const errors: ParseError[] = [];
    parse(text, errors, { allowTrailingComma: ext === ".jsonc" });
    const starts = lineStarts(text);
    return [...new Set(errors.map((e) => lineAt(starts, e.offset)))];
  }
  try {
    return syntaxErrorLines(path, text);
  } catch {
    return undefined;
  }
}

/** Lines (in `after`) of syntax errors the edit introduced; empty when none, undefined when unknown. */
export function newSyntaxErrors(path: string, before: string | null, after: string): number[] | undefined {
  const now = errorLines(path, after);
  if (now === undefined || now.length === 0) return now;
  const was = before === null ? [] : (errorLines(path, before) ?? []);
  return now.length > was.length ? now : [];
}
