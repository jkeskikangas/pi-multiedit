// Model-facing report of what actually changed: per file, changed lines only (no context — the
// anchors locate them), each new line carrying its fresh LINE#HASH so the next call can chain on
// it, and a one-for-one line rewrite shown as a word diff (`[-old-]{+new+}`) instead of two lines.
import { diffLines, diffWordsWithSpace } from "diff";
import { anchorOf } from "./hash.ts";
import { similarity, splitLines } from "./text.ts";

export type FileReport = {
  path: string;
  status: "modified" | "created" | "deleted" | "moved";
  movedTo?: string;
  before: string | null;
  after: string | null;
};

const PER_FILE = 60;
const TOTAL = 240;

export function countChanges(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

function wordDiff(a: string, b: string): string {
  return diffWordsWithSpace(a, b)
    .map((p) => (p.added ? `{+${p.value}+}` : p.removed ? `[-${p.value}-]` : p.value))
    .join("");
}

/** Changed-lines-only diff of one file; returns rendered lines (uncapped). */
export function changedLines(before: string, after: string): string[] {
  const out: string[] = [];
  let newLine = 1;
  const parts = diffLines(before, after);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lines = splitLines(part.value.endsWith("\n") ? part.value : part.value + "\n");
    if (!part.added && !part.removed) {
      newLine += lines.length;
      continue;
    }
    if (part.removed && parts[i + 1]?.added) {
      const added = splitLines(parts[i + 1].value.endsWith("\n") ? parts[i + 1].value : parts[i + 1].value + "\n");
      out.push(`@@ ${newLine}`);
      // Pair each removed line with the next similar added line (a rewrite); the rest stay -/+.
      let j = 0;
      for (const l of lines) {
        let k = j;
        while (k < added.length && similarity(l.trim(), added[k].trim()) < 0.5) k++;
        if (k === added.length) {
          out.push(`-${l}`);
          continue;
        }
        for (; j < k; j++) out.push(`+${anchorOf(newLine + j, added[j])}:${added[j]}`);
        out.push(`~${anchorOf(newLine + k, added[k])}:${wordDiff(l, added[k])}`);
        j = k + 1;
      }
      for (; j < added.length; j++) out.push(`+${anchorOf(newLine + j, added[j])}:${added[j]}`);
      newLine += added.length;
      i++;
      continue;
    }
    out.push(`@@ ${newLine}`);
    if (part.removed) for (const l of lines) out.push(`-${l}`);
    else {
      lines.forEach((l, k) => out.push(`+${anchorOf(newLine + k, l)}:${l}`));
      newLine += lines.length;
    }
  }
  return out;
}

export function renderReport(files: FileReport[]): string {
  const blocks: string[] = [];
  let budget = TOTAL;
  for (const f of files) {
    if (f.status === "deleted") {
      blocks.push(`${f.path}: deleted`);
      continue;
    }
    const head = f.status === "moved" ? `${f.path} -> ${f.movedTo}` : f.path;
    if (f.status === "created") {
      blocks.push(`${head}: created (${splitLines(f.after!).length} lines)`);
      continue;
    }
    const { added, removed } = countChanges(f.before!, f.after!);
    if (added + removed === 0) {
      blocks.push(`${head}: moved, content unchanged`);
      continue;
    }
    const lines = changedLines(f.before!, f.after!);
    const cap = Math.min(PER_FILE, budget);
    budget -= Math.min(lines.length, cap);
    const shown = lines.slice(0, cap);
    const more = lines.length - shown.length;
    blocks.push(
      [`${head}  +${added} -${removed}`, ...shown, ...(more > 0 ? [`… ${more} more diff lines; read the file for anchors`] : [])].join("\n"),
    );
  }
  return blocks.join("\n\n");
}
