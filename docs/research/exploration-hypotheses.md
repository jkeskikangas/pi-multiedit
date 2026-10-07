# Can the search/read phase be improved materially? Hypotheses before experiments

October 2026. Metrics in priority order: correctness, wall time, turns, tool calls. Sample repositories:
treat (Elixir + TypeScript monorepo, 4,675 files, 4,600 commits since June), pi (TypeScript monorepo,
842 files), tulka (two legacy JavaScript React apps, 367 and 514 files, untyped, dormant since June).

## Belief

Yes, but only in one way. Not by ranking files better (round 1 tested that: offline hit@5 29% → 76%,
agent turns unchanged), and not by smaller search output (compaction raised turns). The lever that
remains is structural: exploration is a chain of dependent hops, and a tool can perform a hop's
successor steps itself and return their content. If models use such a tool as their first move, the
ceiling on Exp A-like tasks is roughly −35% turns and −25% wall time; the honest prior that they use it
is about even, and that is what the experiments must settle first.

## What exploration is, measured

Exp A (treat, 16 pi-multiedit runs): 5.75 of 9 turns are exploration, almost all of them single Bash
calls that already combine several commands (`rg -l … ; cat … ; rg -n … test`). The models batch
whatever is independent; what costs a turn is a hop whose input is the previous result. The chains
decompose into five hop types:

| Hop | Example from the runs | Runs containing it |
|---|---|---|
| locate the primary file from an identifier in the prompt | `rg -l "defmodule CareWeb.VerifiedSession"`, `git ls-files \| head -300` | 8/8 |
| read the definition | `cat $f`, `sed -n 1,50p cases.ts` | 8/8 |
| find tests and callers of it | `rg -ln "VerifiedSession" test`, `rg -n "doctor_name" packages/api-mock/src` | 8/8 |
| read the matching test blocks / call sites | `sed -n 84,150p patient_cases_channel_test.exs` | 8/8 |
| find and read the helpers those tests use | `rg -n "def build_platform_admin" test/support`, `cat test/support/customer_service_notification_helpers.ex` | 5/8 |

Three of the five hops are deterministic given the previous one (tests and callers of a symbol, the
test blocks that mention it, the helpers those blocks call). A tool can do them without the model.

## What the literature says (2025–2026)

- **Agentic exploration beats static retrieval, and scaffolding adds little.** On SWE-Explore (848
  instances, 10 languages) classical retrievers sit near random while agents find the right files
  60–68% of the time, but line-level recall is only 15–19%, and 25–47% of selected lines are off-target
  ([SWE-Explore](https://arxiv.org/html/2606.07297v1)). ContextBench (1,136 tasks) finds that "more
  complex retrieval scaffolds do not consistently outperform a simple baseline": mini-SWE-agent beats
  graph-based Prometheus on file recall (0.68 vs 0.34) and Pass@1 (0.65 vs 0.51)
  ([ContextBench](https://arxiv.org/html/2602.05892v1)). Round 1's result is the same finding.
- **The relevant unit is "what the agent needs next", and it is structural.** Agent Retrieval Bench
  defines relevance by the agent's next need (code2test, trace2code, edit2ripple) and finds no single
  retriever wins: embeddings lead code2test, a tree-sitter RepoMap leads trace2code and has the best
  context yield under an 8k-token budget ([Agent Retrieval Bench](https://arxiv.org/html/2607.24882)).
  CoSIL's iterative graph traversal has the highest non-oracle recall on SWE-Explore (0.79). Those are
  exactly the hops in the table above.
- **Symbol-level tools help navigation, not plain search.** The LSP measurement study finds savings
  for definition and cross-file lookups and none for simple pattern matching, with tool-call overhead
  able to negate the gain ([Does a Language Server Save Tokens](https://arxiv.org/pdf/2608.13568));
  Serena-style `find_symbol` / `find_referencing_symbols` tools are the common packaging
  ([Serena](https://github.com/cek/serena)).
- **Recall matters more than precision; consolidation is the failure.** Missing core evidence is the
  dominant failure mode (SWE-Explore); agents retrieve gold code and then fail to use it (ContextBench
  "evidence drop" up to 0.43). So a tool that returns more of the right neighbourhood in one hop is in
  the safe direction; one that returns less is not (round 1's compaction result).
- **Delegated search is not a shortcut.** Sub-agent exploration for repository QA was less accurate
  (46% vs 65%) and 2.3× costlier per correct answer than index-backed retrieval, with 42% of failures at
  the planner→sub-agent boundary ([Deep Agentic Search](https://arxiv.org/html/2608.01507)). Claude
  Code's Explore sub-agent trades turns for parallel context, not fewer hops.
- **Coding-agent harnesses in practice** rely on ls/grep/find/read rather than an embedding lookup
  ([CORE-Bench](https://arxiv.org/html/2606.11864v3)), and the general-purpose agents (Claude Code,
  OpenHands, mini-SWE-agent) show "surprisingly similar" exploration profiles (SWE-Explore). Treat's
  real sessions agree: Bash search is 32% of all calls.

## Hypotheses

**H1 — Context pack: one call returns the symbol's neighbourhood.** `context{symbols | files}` returns,
anchored and ready for `edit`: the enclosing definition of each named symbol (tree-sitter), its
references grouped by file with ±N lines, the test blocks that mention it, and one hop of the helpers
those blocks call (definitions from `test/support`, `__tests__/utils`, fixtures). Capped at ~8k tokens,
largest-first. *Prediction:* the locate/read/find-tests/read-tests/find-helpers chain collapses to 1–2
turns; explore turns 5.75 → ~3; total 9 → ~6.5 (−28%); wall −20%; pass rate unchanged. *Falsified if*
models keep issuing `rg`/`cat` after the pack (adoption), or if the pack's omissions cause extra turns
(the round-1 compaction effect). Why it might work where round-1 intent search did not: it returns
content at the granularity the model reads anyway, not a ranking to verify. Treat is the strongest
case (tests in a separate tree with shared helpers); pi similar; tulka weakest (few tests, untyped
JS: the pack degenerates to definition + callers).

**H2 — Repo map at turn 0.** A static tree-sitter outline of the repository subtree (files and
top-level symbols, ≤4k tokens, cached per commit) injected before the first turn. *Prediction:* removes
the locate hop (`git ls-files | head -300`, `find . -name`) in the 4/8 runs that start with it:
−0.5–1 turn, no added latency (round 1's seeding cost 2–5 s and lost that on wall time). Agent
Retrieval Bench's budgeted-yield result supports it. *Falsified if* turns are unchanged or the model
reads the map and then lists files anyway.

**H3 — Hash-anchored bash reads.** `sed -n`/`cat` output through pi's bash gets `N#HH` anchors
(round 1's `bash-reads.ts` shaping), so the model can use `from`/`to` without a `read`. *Prediction:*
removes the "line reference without hash" edit misses (3 of 7 in Exp A) and some re-reads: −0.2–0.4
turns. Cheap; orthogonal to H1/H2.

**H4 — Parallel hops by instruction.** A guideline ("issue independent lookups in one turn") and a
batched `context` call. *Prediction:* small (−0.5 turn) because the models already batch inside one
Bash command; dependent hops are the problem, which is H1's territory.

Not pursued: better ranking (round 1), semantic index (CORE-Bench: general embeddings degrade on this
setting; the literature's wins are on retrieval benchmarks, not agent turns), sub-agent exploration
(Deep Agentic Search), search-output compaction (round 1).

## Experiment plan

1. **H1 first, adoption gate.** Build `context` on the round-1 branch's locator/outline code (tree-sitter
   via ast-grep for ts/js/ex/exs/py), 4 Exp A tasks + 4 pi tasks (x1–x4) + 2 tulka tasks built the same
   way (real commits, static checkers), Opus and Sonnet at low effort, 2 reps, arms multi vs multi+context.
   Gate: ≥70% of runs use `context` in turn 1. If not, revise the description/placement once and
   rerun before measuring anything else.
2. **H1 + H2 + H3 factorial on the same tasks** once H1 is adopted: 8 arms × 2 models × 10 tasks × 2
   reps = 320 runs (~$40 at Exp A rates, ~2 h at 4 in parallel). Primary readout: pass rate, wall,
   turns; secondary: calls, tokens.
3. **Decision rule:** ship a lever only if turns −20% and wall −15% with pass rate not worse across
   both models; otherwise record and stop, as in rounds 1 and 2.

Fixed overhead is outside this programme but larger than any single lever here: pi startup and
shutdown are 7–8 s of a 26–40 s run (Exp A). Measure it directly before optimising exploration.

## H1 minimal test: result

Prototype `context{symbols, terms?}` (`eval/context/index.ts`, ~200 lines, rg + an indentation-based
block heuristic, anchored output, 30k-char budget) run on e1–e4 with the pi-multiedit arm as baseline
(Exp A runs). Two attempts, as pre-registered: v1, then one revision (whole file for a defining file
under 400 lines; free-text `terms` for behaviour words; "call this FIRST" as the description's first
line). Sonnet 2 reps, Opus 1 rep per attempt.

| Model | Arm | Pass | Wall s | Turns | Explore turns | `context` first | bash calls after `context` |
|---|---|--:|--:|--:|--:|--:|--:|
| opus | baseline (n=8) | 8/8 | 40 | 9.0 | 6.1 | – | – |
| opus | v1 (n=4) | 4/4 | 41 | 10.2 | 7.2 | 0/4 | – |
| opus | v2 (n=4) | 4/4 | 26 | 6.5 | 4.0 | 2/4 | 0.8 |
| sonnet | baseline (n=8) | 7/8 | 26 | 8.1 | 5.4 | – | – |
| sonnet | v1 (n=8) | 8/8 | 45 | 7.9 | 5.8 | 5/8 | 2.0 |
| sonnet | v2 (n=8) | 6/8 | 36 | 7.4 | 5.1 | 7/8 | 2.9 |

- **Adoption:** v1 failed the gate (Opus 0/4). v2 reached it for Sonnet (7/8) and half for Opus (2/4);
  the description's first line mattered more than the system-prompt guideline, which was rendered in
  both attempts.
- **Opus, when it used the pack:** e1 5 turns (baseline 10 and 6), e2 6 turns (baseline 8 and 15); its
  v2 average is −28% turns and −35% wall on n=4, two of them without the pack. Direction consistent
  with H1, sample too small to count.
- **Sonnet:** no turn gain (−9%), wall worse (+38%; two outliers of 94 s and 69 s), pass 6/8 (both e4
  failures are the same `doctor_specialty` omission Sonnet built-in also made once; not pack-induced).
  After the pack it still ran 2–3 bash calls: it re-read the primary files whole even when the pack had
  returned them whole and anchored (e2: `company_domain.ex`, 201 lines, given in full, read again by
  both models), read the whole test file after getting the matching test block, and searched for
  concepts it had not passed as `terms` ("read policy", "company member"); on e3 it passed `parse/3` and
  a Finnish string as symbols and got 391 chars back.
- **Decision rule** (turns −20% and wall −15%, pass not worse, both models): **not met.** One model
  shows the predicted effect at n=4, the other shows none and verifies regardless, which is round 1's
  conclusion again. The pack adds 14–30k chars to the first turn and does not remove the model's own
  reads.

What a third attempt would change, if one is funded: tell the model in the result itself that the
whole-file sections are complete reads (so it stops re-reading them); give test files whole below a
size; make `terms` mandatory-by-example in the description; and run Opus with 2 reps to confirm or
dissolve the −28%. The honest expectation from two attempts and round 1 is that Sonnet will keep its
own chain and Opus will gain 1–3 turns when it adopts the tool.
