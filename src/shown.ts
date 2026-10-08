// What the model has seen of each file, as line hashes: recorded whenever this extension shows a
// file (read, an edit result, a seed). A bare line number in from/to resolves against it, so the
// usual stale-anchor check still applies and a number from an old view is refused, not misapplied.
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/**
 * Event other extensions emit on pi's shared bus when they put a whole file in front of the model
 * with N#HH anchors (pi-jev-kit's first-turn seed does): `{ path, text }`, `path` absolute and `text`
 * exactly the content shown. Recorded like a read, so bare line numbers resolve against that view.
 */
export const VIEW_EVENT = "anchored-view";

export function listenForViews(pi: ExtensionAPI): void {
  pi.events.on(VIEW_EVENT, (data) => {
    const { path, text } = (data ?? {}) as { path?: unknown; text?: unknown };
    if (typeof path !== "string" || !isAbsolute(path) || typeof text !== "string") return;
    // The engine keys files by their symlink-resolved path.
    void realpath(path).then(
      (abs) => noteShown(abs, text),
      () => noteShown(path, text),
    );
  });
}
