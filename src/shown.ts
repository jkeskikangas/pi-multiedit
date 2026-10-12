// What the model has seen of each file, as line hashes: recorded whenever this extension shows a
// file (read, an edit result, a seed) and for the numbered lines of shell output (numbered.ts). A bare line number in from/to resolves against it, so the
// usual stale-anchor check still applies and a number from an old view is refused, not misapplied.
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lineHash } from "./hash.ts";
import { splitLines } from "./text.ts";

// Views are kept per scope: the main session (the default everywhere) and one per draft (draft.ts),
// so a number seen in a draft never validates an edit in the main session, or the reverse.

/** The main session's scope; every caller that names no scope uses it. */
export const MAIN_SCOPE = "main";

const scopes = new Map<string, Map<string, (string | undefined)[]>>();

function viewsOf(scope: string): Map<string, (string | undefined)[]> {
  let views = scopes.get(scope);
  if (!views) scopes.set(scope, (views = new Map()));
  return views;
}

/** Records the file's current content as the model's view of it. `abs` is the canonical path. */
export function noteShown(abs: string, text: string, scope: string = MAIN_SCOPE): void {
  const lines = splitLines(text);
  viewsOf(scope).set(
    abs,
    lines.map((l, i) => lineHash(i + 1, l)),
  );
}

/** Records single lines the model saw with their numbers, on top of what it saw of the file before. */
export function notePartial(abs: string, lines: Map<number, string>, scope: string = MAIN_SCOPE): void {
  const views = viewsOf(scope);
  const view = views.get(abs) ?? [];
  for (const [n, text] of lines) view[n - 1] = lineHash(n, text);
  views.set(abs, view);
}

/** The hash the model would have for line `n` (1-based) of `abs`, or undefined when the file was never shown. */
export function shownHash(abs: string, n: number, scope: string = MAIN_SCOPE): string | undefined {
  return scopes.get(scope)?.get(abs)?.[n - 1];
}

export function hasShown(abs: string, scope: string = MAIN_SCOPE): boolean {
  return scopes.get(scope)?.has(abs) ?? false;
}

/** Forgets everything a scope saw (a draft that was applied or discarded). The main scope stays. */
export function dropScope(scope: string): void {
  if (scope !== MAIN_SCOPE) scopes.delete(scope);
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
