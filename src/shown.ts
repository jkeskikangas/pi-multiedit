// What the model has seen of each file, as line hashes: recorded whenever this extension shows a
// file (read, an edit result, a seed). A bare line number in from/to resolves against it, so the
// usual stale-anchor check still applies and a number from an old view is refused, not misapplied.
import { lineHash } from "./hash.ts";
import { splitLines } from "./text.ts";

const shown = new Map<string, string[]>();

/** Records the file's current content as the model's view of it. `abs` is the canonical path. */
export function noteShown(abs: string, text: string): void {
  const lines = splitLines(text);
  shown.set(
    abs,
    lines.map((l, i) => lineHash(i + 1, l)),
  );
}

/** The hash the model would have for line `n` (1-based) of `abs`, or undefined when the file was never shown. */
export function shownHash(abs: string, n: number): string | undefined {
  return shown.get(abs)?.[n - 1];
}

export function hasShown(abs: string): boolean {
  return shown.has(abs);
}
