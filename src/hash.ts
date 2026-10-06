// LINE#HASH anchors, byte-compatible with pi-hashline-edit / oh-my-pi so existing habits and
// anchors carry over: xxHash32 of the right-trimmed line, low byte mapped to two letters.
import XXH from "xxhashjs";

const NIBBLES = "ZPMQVRWSNKTXJBYH";
const DICT = Array.from({ length: 256 }, (_, i) => NIBBLES[i >>> 4] + NIBBLES[i & 15]);
const SIGNIFICANT = /[\p{L}\p{N}]/u;

// `N#HH`, optionally followed by `:content` as read displays it (models often copy the whole line).
export const ANCHOR_RE = /^\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})(?::(.*)|\s*)$/s;
export const ANCHOR_PREFIX_RE = /^\s*\d+#[ZPMQVRWSNKTXJBYH]{2}:/;

export function lineHash(lineNumber: number, line: string): string {
  const text = line.replace(/\r/g, "").trimEnd();
  // Punctuation-only lines (`}`, `end`-less braces) collide constantly; seed them by position.
  const seed = SIGNIFICANT.test(text) ? 0 : lineNumber;
  return DICT[(XXH.h32(text, seed).toNumber() >>> 0) & 0xff];
}

export function anchorOf(lineNumber: number, line: string): string {
  return `${lineNumber}#${lineHash(lineNumber, line)}`;
}

export function parseAnchor(text: string): { line: number; hash: string; content?: string } | undefined {
  const m = ANCHOR_RE.exec(text);
  return m ? { line: Number(m[1]), hash: m[2], content: m[3]?.replace(/\n$/, "") } : undefined;
}

/** `lines[i]` rendered as `N#HH:text`, numbers padded so the hash column aligns. */
export function formatAnchored(lines: string[], firstLine: number): string {
  const width = String(firstLine + Math.max(0, lines.length - 1)).length;
  return lines
    .map((line, i) => `${String(firstLine + i).padStart(width)}#${lineHash(firstLine + i, line)}:${line}`)
    .join("\n");
}
