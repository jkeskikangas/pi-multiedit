// Re-ranks located files with a classifier model (TypeSafe's Jev): one yes/no question per file,
// "would this task involve this file?", ordered by probability. Without a classifier it is a no-op.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Located } from "./locate.ts";
import { outlineLines } from "./outline.ts";
import type { Reranker } from "./reader.ts";

const CANDIDATES = 20;
const PARALLEL = 8;

export function jevReranker(registry: ExtensionContext["modelRegistry"], cwd: string): Reranker {
  return async (intent, ranked) => {
    const models = await registry.getAvailableOfType("classifier", "typesafe").catch(() => []);
    const model = models.find((m) => m.id.startsWith("jev")) ?? models[0];
    if (!model) return ranked;
    const top = ranked.slice(0, CANDIDATES);
    const probs: (number | undefined)[] = [];
    for (let i = 0; i < top.length; i += PARALLEL) {
      probs.push(...(await Promise.all(top.slice(i, i + PARALLEL).map((r) => relevance(registry, model, cwd, intent, r)))));
    }
    if (probs.every((p) => p === undefined)) return ranked; // the service failed: keep the locator's order
    const scored = top.map((r, i) => ({ r, p: probs[i] ?? 0 })).sort((a, b) => b.p - a.p).map((x) => x.r);
    return [...scored, ...ranked.slice(CANDIDATES)];
  };
}

type Classifier = Parameters<ExtensionContext["modelRegistry"]["classify"]>[0];

async function relevance(registry: ExtensionContext["modelRegistry"], model: Classifier, cwd: string, intent: string, r: Located): Promise<number | undefined> {
  const text = await readFile(join(cwd, r.path), "utf8").catch(() => "");
  const lines = text.split("\n");
  const declarations = (outlineLines(r.path, text) ?? []).slice(0, 25).map((n) => lines[n - 1]?.trim()).filter(Boolean);
  const terms = (r.terms ?? []).map((t) => t.toLowerCase());
  const matching = lines.filter((l) => terms.some((t) => l.toLowerCase().includes(t))).slice(0, 6).map((l) => l.trim().slice(0, 160));
  const result = await registry.classify(model, {
    state: { task: intent.slice(0, 1500), file: r.path, declarations, matching_lines: matching },
    questions: {
      relevant: {
        type: "bool",
        instructions: "Would a developer doing this task need to read or change this file?",
        criteria: { true: "Yes, the task involves this file", false: "No, unrelated to the task" },
      },
    },
  });
  const answer = result.stopReason === "stop" ? (result.answers?.relevant as { probability?: number } | undefined) : undefined;
  return answer?.probability;
}
