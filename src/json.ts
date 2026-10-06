// JSON/JSONC selector: a pointer whose segments are keys, indexes, `-` (append) or `[key=value]`
// (the array element whose `key` equals `value`). Edits are minimal splices via jsonc-parser,
// so formatting and comments outside the touched node survive.
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type FormattingOptions, type ParseError } from "jsonc-parser";

export type JsonAction = "replace" | "before" | "after" | "delete";

type Segment = string | number;

function decode(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolvePath(doc: unknown, pointer: string): { path: Segment[]; append: boolean } {
  if (pointer === "" || pointer === "/") return { path: [], append: false };
  if (!pointer.startsWith("/")) throw new Error(`json pointer must start with "/": ${pointer}`);
  // Split on "/" outside [key=value] brackets: values are often paths.
  const raw = (pointer.slice(1).match(/(?:\[[^\]]*\]|[^/])+|(?<=\/)(?=\/|$)/g) ?? [""]).map(decode);
  const path: Segment[] = [];
  let node: unknown = doc;
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i];
    const last = i === raw.length - 1;
    if (Array.isArray(node)) {
      if (seg === "-") {
        if (!last) throw new Error(`"-" must be the last pointer segment: ${pointer}`);
        return { path: [...path, node.length], append: true };
      }
      const where = /^\[([^=\]]+)=(.*)\]$/.exec(seg);
      let index: number;
      if (where) {
        const [, key, value] = where;
        const hits = node.flatMap((el, j) =>
          el && typeof el === "object" && String((el as Record<string, unknown>)[key]) === value ? [j] : [],
        );
        if (hits.length !== 1) {
          throw new Error(`${pointer}: [${key}=${value}] matched ${hits.length} elements at /${path.join("/")}, expected 1`);
        }
        index = hits[0];
      } else if (/^\d+$/.test(seg)) {
        index = Number(seg);
        if (index >= node.length) throw new Error(`${pointer}: index ${index} out of range (${node.length})`);
      } else {
        throw new Error(`${pointer}: "${seg}" does not select an array element (use an index, -, or [key=value])`);
      }
      path.push(index);
      node = node[index];
    } else if (node && typeof node === "object") {
      if (!last && !(seg in (node as object))) throw new Error(`${pointer}: no key "${seg}" at /${path.join("/")}`);
      path.push(seg);
      node = (node as Record<string, unknown>)[seg];
    } else {
      throw new Error(`${pointer}: /${path.join("/")} is not a container`);
    }
  }
  return { path, append: false };
}

function formatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    insertFinalNewline: text.endsWith("\n"),
  };
}

export function jsonEdit(text: string, pointer: string, action: JsonAction, valueText?: string): string {
  const errors: ParseError[] = [];
  const doc = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error(`not valid JSON/JSONC (parse error at offset ${errors[0].offset})`);
  const { path, append } = resolvePath(doc, pointer);
  let value: unknown;
  if (action !== "delete") {
    if (valueText === undefined) throw new Error(`json ${action} needs \`new\` (a JSON value)`);
    try {
      value = JSON.parse(valueText);
    } catch {
      value = valueText; // A bare word like integration means the string.
    }
  }
  const options = { formattingOptions: formatting(text) };
  const parentIsArray = typeof path[path.length - 1] === "number";
  let edits;
  if (action === "delete") {
    if (append) throw new Error(`cannot delete "-"`);
    edits = modify(text, path, undefined, options);
  } else if (action === "replace") {
    edits = modify(text, path, value, { ...options, isArrayInsertion: append });
  } else {
    if (!parentIsArray) throw new Error(`json ${action} needs an array element pointer`);
    const index = (path[path.length - 1] as number) + (action === "after" && !append ? 1 : 0);
    const styled = insertLikeSiblings(text, path.slice(0, -1), index, value);
    if (styled !== undefined) return styled;
    edits = modify(text, [...path.slice(0, -1), index], value, { ...options, isArrayInsertion: true });
  }
  if (append && action === "replace") {
    const styled = insertLikeSiblings(text, path.slice(0, -1), path[path.length - 1] as number, value);
    if (styled !== undefined) return styled;
  }
  return applyEdits(text, edits);
}

/**
 * Inserts `value` at `index` of a non-empty array, copying the separator and the one-line vs
 * multi-line style of the neighbouring element so the rest of the array is left untouched.
 */
function insertLikeSiblings(text: string, arrayPath: Segment[], index: number, value: unknown): string | undefined {
  const array = findNodeAtLocation(parseTree(text)!, arrayPath);
  const items = array?.children ?? [];
  if (!array || array.type !== "array" || items.length === 0) return undefined;
  const ref = items[Math.min(index, items.length - 1)];
  const neighbour = index < items.length ? items[index] : items[items.length - 1];
  const sep = items.length > 1
    ? text.slice(items[0].offset + items[0].length, items[1].offset)
    : `,${text.slice(array.offset + 1, items[0].offset) || " "}`;
  const lineStart = text.lastIndexOf("\n", neighbour.offset) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
  const refText = text.slice(ref.offset, ref.offset + ref.length);
  const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  const rendered = refText.includes("\n")
    ? JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`)
    : JSON.stringify(value, null, 1).replace(/\n\s*/g, " ");
  if (index < items.length) {
    const at = items[index].offset;
    return text.slice(0, at) + rendered + sep + text.slice(at);
  }
  const last = items[items.length - 1];
  const at = last.offset + last.length;
  return text.slice(0, at) + sep + rendered + text.slice(at);
}
