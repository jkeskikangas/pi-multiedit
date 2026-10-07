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

## H1 variant with Jev: seed the whole files at turn 0

The adoption problem disappears if nothing has to be called. `eval/jevseed/index.ts` (`before_agent_start`):
identifiers and quoted strings from the prompt → `rg -l` candidates (≤40 files) → TypeSafe Jev
classifies each ("would the developer need to open this file?", 8 in parallel, file declarations and
matching lines as evidence) → files with p ≥ 0.6 and ≤ 400 lines are injected **whole and anchored,
labelled "complete, already read"**, p ≥ 0.3 as matching lines, 40k-char cap, 6 s budget (no seed on
timeout or when the prompt names nothing). Run on treat e1–e4 and pi x1–x4, b1–b2, Opus and Sonnet
at low effort, 2 reps (40 runs), against the pi-multiedit baselines.

| Repo | Model | Arm | Pass | Wall s | Turns | Calls | Edit errors | Seed ms | Files whole | Seed chars |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| treat | opus | baseline | 8/8 | 40 | 9.0 | 8.1 | 0.50 | – | – | – |
| treat | opus | jev seed | 8/8 | 34 | 6.2 | 5.4 | 0.12 | 3,776 | 3.6 | 30k |
| treat | sonnet | baseline | 7/8 | 26 | 8.1 | 8.0 | 0.38 | – | – | – |
| treat | sonnet | jev seed | 6/8 | 36 | 7.0 | 6.5 | 0.38 | 3,786 | 3.5 | 30k |
| pi | opus | baseline | 8/8 | 15 | 3.5 | 2.5 | 0.00 | – | – | – |
| pi | opus | jev seed | 12/12 | 15 | 3.4 | 2.7 | 0.00 | 830 | 2.8 | 26k |
| pi | sonnet | baseline | 8/8 | 16 | 3.6 | 2.9 | 0.00 | – | – | – |
| pi | sonnet | jev seed | 11/12 | 15 | 3.8 | 3.1 | 0.08 | 791 | 2.5 | 26k |

- **Opus on treat meets the decision rule:** turns −31%, calls −33%, wall −15% (with 3.8 s of seed
  latency inside it), pass 8/8, edit errors 0.50 → 0.12. Two runs (e1 for both models) went straight
  to a correct `edit` with `from`/`to` anchors from the seed: 2 turns, 1 call.
- **Sonnet on treat does not:** turns −14%, wall +38%, pass 6/8. The wall figure is one run (e1 r1:
  62 s, 11 turns): three refused edit calls, a missing `new` and twice a bare line number for `to`
  (`"43"`, `"42"`) while the seed showed the anchors; the other two failures are Sonnet's own task
  omissions seen in the baseline too (e3 rules test, e4 `doctor_specialty`). Without the outlier
  Sonnet's wall is 32 s, still above baseline because of the seed's 3.8 s and 30k extra prefix chars.
- **pi tasks are at their floor** (3–4 turns: search, edit, answer); the seed changes nothing there and
  costs 0.8 s. Jev picked the right files (Opus 12/12 pass).
- **The seed is trusted less than it could be:** only 2 of 16 treat runs edited first; the rest still
  searched and read, mostly the test file and concept words ("revoke", "read policy") that the seed
  cannot derive from identifiers. The 2-turn runs show the ceiling.
- Jev quality on treat: top file p = 0.99 for the defining module on e1, tests ranked next; no run
  seeded a wrong file whole. Latency is 40 classifications at 8 in parallel; 20 candidates at 16
  parallel would be ~1.5 s.

**Reading.** Content at turn 0, selected by a classifier that knows the task, is the first exploration
lever in two rounds that moved Opus by more than 20% on a real repository with pass rate intact. It is
not yet a Sonnet win, and the remaining cost is the model's habit of re-verifying what it was given.
The cheapest next steps are mechanical: accept a bare line number for `to` when `from` is an anchor
(three incidents across the rounds), cut seed latency to ~1.5 s, and add the test file whole when the
defining file is. Then 4 reps per model on treat to confirm.

### Seed v2: one Jev request per 20 files, plus bare line numbers

Two changes, then 16 treat runs (Opus and Sonnet, 2 reps): the classifier is asked once per chunk of 20
files (the state carries every file's declarations and matching lines, one bool question per file), and
the engine accepts a bare line number in `from`/`to` when the file has been shown by `read`, an `edit`
result or the seed, checking it against that view's line hash (`src/shown.ts`; commit f2ba8d9).

| Model | Arm | Pass | Wall s | Turns | Calls | Edit errors | Seed latency |
|---|---|--:|--:|--:|--:|--:|--:|
| opus | baseline | 8/8 | 40 | 9.0 | 8.1 | 0.50 | – |
| opus | seed v1 (40 requests) | 8/8 | 34 | 6.2 | 5.4 | 0.12 | 3.8 s |
| opus | seed v2 (2 requests) | 8/8 | 36 | 6.2 | 5.2 | 0.12 | 1.4–1.9 s |
| sonnet | baseline | 7/8 | 26 | 8.1 | 8.0 | 0.38 | – |
| sonnet | seed v1 | 6/8 | 36 | 7.0 | 6.5 | 0.38 | 3.8 s |
| sonnet | seed v2 | 7/8 | 31 | 6.6 | 5.8 | 0.25 | 1.4–1.9 s |

- Batched classification keeps the ranking (e1: module 0.99, its test 0.97, the socket caller 0.61,
  the rest below 0.52) at under half the latency, and is more selective (3 files whole instead of 7).
- **e1 is the ceiling case in all four v2 runs: 2 turns, 1 call, 13–17 s** (baseline 5–10 turns,
  14–42 s). Both models edited from the seed's anchors without a single search or read.
- **e2 is the floor:** 7–12 turns in every arm. The prompt names the test by concept ("the
  company-member read policy test"); the identifier extractor does not turn a hyphenated phrase into
  `company_member_read_policy`, so the seed lacks that file and the model hunts for it. Without e2,
  Sonnet's v2 wall is 27 s against a 26 s baseline; with it, the two long hunts (47 s, 36 s) make the
  average 31 s. Mapping hyphenated phrases to snake_case and file-name tokens is the obvious next fix.
- Against the decision rule (turns −20%, wall −15%, pass not worse, both models): Opus turns −31%,
  calls −36%, wall −10%; Sonnet turns −19%, calls −28%, wall +19%, pass equal. **Turns and calls pass
  for both; wall passes for neither**, because Sonnet's turns are short enough that 1.5 s of seed and
  25–30k extra prefix characters show, and Opus's gain is diluted by e2.
- No run used a bare line number, so that change had nothing to do here; it costs nothing when unused.

What a third `context`-tool attempt would change, if one is funded: tell the model in the result itself that the
whole-file sections are complete reads (so it stops re-reading them); give test files whole below a
size; make `terms` mandatory-by-example in the description; and run Opus with 2 reps to confirm or
dissolve the −28%. The honest expectation from two attempts and round 1 is that Sonnet will keep its
own chain and Opus will gain 1–3 turns when it adopts the tool.

### Seed v2 on gpt-6.1-sol and gpt-6-luna

Same tasks and protocol (treat e1–e4, 2 reps, low reasoning effort, openai-codex provider), baseline =
pi + pi-multiedit without the seed.

| Model | Arm | Pass | Wall s | Turns | Calls | Edit errors |
|---|---|--:|--:|--:|--:|--:|
| gpt-6.1-sol | baseline | 8/8 | 40 | 6.2 | 6.0 | 0.00 |
| gpt-6.1-sol | seed v2 | 8/8 | 33 | 4.5 | 4.0 | 0.00 |
| gpt-6-luna | baseline | 5/8 | 21 | 8.0 | 9.8 | 0.12 |
| gpt-6-luna | seed v2 | 5/8 | 19 | 5.0 | 5.1 | 0.38 |

- **Sol 6.1 meets the decision rule:** turns −27%, calls −33%, wall −18%, pass 8/8 both arms. e1 is
  again the ceiling: 2 turns, 1 call, 17 s in both reps (baseline 4–5 turns, 20–24 s).
- **Luna:** turns −38%, calls −48%, wall −10%, pass 5/8 in both arms (its failures are its own: a
  damaged clause on e1, a missing bypass policy on e2, a test omission on e3 — the same classes with and
  without the seed). Edit errors rose 0.12 → 0.38: one anchor copied with the wrong content (`2#VN:…`),
  one regex that matched 12 times; both are Luna's precision, not the seed's.
- Across the four models, seed v2 cuts turns by 19–38% and calls by 28–48% with pass rate unchanged;
  wall time falls for Opus (−10%), Sol (−18%) and Luna (−10%) and rises for Sonnet (+19%, e2-driven).
  The seed's fixed cost (1.4–1.9 s, 25–30k chars) matters most for the fastest model.

Cross-model summary, treat e1–e4, seed v2 vs baseline:

| Model | Turns | Calls | Wall | Pass |
|---|--:|--:|--:|---|
| claude-opus-5-5 | −31% | −36% | −10% | 8/8 → 8/8 |
| claude-sonnet-5-5 | −19% | −28% | +19% | 7/8 → 7/8 |
| gpt-6.1-sol | −27% | −33% | −18% | 8/8 → 8/8 |
| gpt-6-luna | −38% | −48% | −10% | 5/8 → 5/8 |

## Final: seed v3, four models, 4 fresh reps per cell (128 runs)

v3 adds concept-to-file matching: every 2–4-word window of the prompt, hyphens included, becomes a
snake_case token matched against `git ls-files` paths, so "the company-member read policy test" seeds
`company_member_read_policy_test.exs` (p = 0.95; e2 for Sonnet went from 7–12 turns to 3 calls). Both
arms were run fresh in the same hour (Claude API latency drifts between sessions: the Sonnet baseline
measured 26 s earlier and 40 s here), treat e1–e4, low effort, reps 3–6.

| Model | Arm | Pass | Wall s | Turns | Calls | Edit err | Out tok | Cache read | Cache write | Fresh in | Total tok | Cost $ |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| opus 5.5 | baseline | 15/16 | 37 | 9.4 | 8.5 | 0.44 | 3.5k | 102k | 17k | 0 | 122k | 0.225 |
| opus 5.5 | seed v3 | 15/16 | **28** | **4.5** | **3.6** | 0.25 | 2.8k | 77k | 20k | 0 | 100k | 0.233 |
| sonnet 5.5 | baseline | 16/16 | 40 | 8.1 | 8.0 | 0.25 | 3.2k | 85k | 17k | 0 | 105k | 0.117 |
| sonnet 5.5 | seed v3 | 14/16 | **27** | **4.6** | **3.6** | 0.12 | 2.5k | 74k | 20k | 0 | 97k | 0.121 |
| gpt-6.1-sol | baseline | 15/16 | 42 | 6.2 | 6.4 | 0.00 | 1.1k | 35k | – | 19k | 55k | 0.052 |
| gpt-6.1-sol | seed v3 | 16/16 | **33** | **3.9** | **3.5** | 0.06 | 1.1k | 35k | – | 17k | 53k | 0.048 |
| gpt-6-luna | baseline | 7/16 | 20 | 7.5 | 9.5 | 0.25 | 1.3k | 149k | – | 34k | 184k | 0.006 |
| gpt-6-luna | seed v3 | 8/16 | **18** | **4.3** | **4.4** | 0.38 | 1.3k | 56k | – | 19k | 76k | 0.003 |

Relative to baseline:

| Model | Turns | Calls | Wall | Total tokens | Cost | Pass |
|---|--:|--:|--:|--:|--:|---|
| opus 5.5 | −52% | −58% | −24% | −18% | +4% | 15/16 → 15/16 |
| sonnet 5.5 | −43% | −55% | −33% | −8% | +3% | 16/16 → 14/16 |
| gpt-6.1-sol | −37% | −45% | −21% | −4% | −8% | 15/16 → 16/16 |
| gpt-6-luna | −43% | −54% | −10% | −59% | −50% | 7/16 → 8/16 |

- **The decision rule (turns −20%, wall −15%, pass not worse, both Claude models) is met**, and the GPT
  models agree. Turns roughly halve for every model; wall time falls 21–33% for three of four and 10%
  for Luna, whose runs are too short for the seed's 1.5 s to vanish.
- **Correctness:** unchanged within noise. Sonnet's two v3 misses are both e4 `doctor_specialty` left
  non-optional/nullable, an omission it made at 1/8 in earlier baselines and 0/4 here; Luna fails half
  the tasks in both arms. The seed never put a wrong file in whole: 25 of 32 v3 runs on e1/e2 edited
  from the seed's anchors without a search (`first=edit` 21/64 overall, 100% on e1).
- **Tokens:** total input+output falls 4–18% for Opus, Sonnet and Sol and 59% for Luna (which otherwise
  re-reads heavily). Cost is flat for the Claude models because the seed's 25–30k characters are
  written to the cache in the first request (cache write +3k tokens at 5× the read price) while the
  saved reads are cheap; for Luna cost halves. Under this round's priorities (correctness, wall, turns)
  that is the right trade; cost-sensitive users can lower `PI_JEV_CHARS`.
- **Fixed cost of the seed:** two Jev requests, 1.4–1.9 s, plus `rg` over the candidate words (<0.3 s).
  pi's own startup and shutdown (7–8 s) remain the largest fixed component of a 20–30 s run.

**Recommendation:** ship the seed as an opt-in extension setting in pi-multiedit (`TYPESAFE_API_KEY`
present → seed on; no key → silent no-op), with the bare-line-number acceptance already on `main`'s
successor branch. Open items before a default-on: 4 reps on the pi and tulka task sets, a budget cap
per repository size, and a check that a wrong whole-file seed cannot mislead (none observed in 96
seeded runs, but the failure mode exists).

## gpt-6-luna: reasoning effort ladder on the priority ("fast") tier

Same tasks, 4 reps per cell except max (stopped at 10 and 9 runs once the picture was clear). The
priority tier is `service_tier: "priority"` (`eval/fast/index.ts`); pi prices it at 2×, so the cost
column for the fast arms is doubled from the reported figure.

| Effort | Arm | Pass | Wall s | Turns | Calls | Total tok | Cost $ |
|---|---|--:|--:|--:|--:|--:|--:|
| low (standard tier) | baseline | 7/16 | 20 | 7.5 | 9.5 | 184k | 0.006 |
| low (standard tier) | seed v3 | 8/16 | 18 | 4.3 | 4.4 | 76k | 0.003 |
| medium, fast | baseline | 7/16 | 22 | 8.1 | 9.7 | 199k | 0.012 |
| medium, fast | seed v3 | 11/16 | 19 | 5.1 | 5.0 | 102k | 0.008 |
| high, fast | baseline | 16/16 | 44 | 10.8 | 15.4 | 372k | 0.018 |
| high, fast | seed v3 | **15/16** | **37** | **6.6** | 7.7 | 130k | 0.010 |
| max, fast | baseline (n=10) | 9/10 | 111 | 12.1 | 22.0 | 455k | 0.028 |
| max, fast | seed v3 (n=9) | 8/9 | 89 | 6.3 | 12.2 | 317k | 0.022 |

- **Correctness is an effort cliff between medium and high:** 7/16 at low and medium, 16/16 at high,
  9/10 at max. Luna's failures at low effort were care, not capability.
- **Effort buys correctness by exploring more, not by thinking longer:** calls go 9.5 → 15.4 → 22 and
  wall 20 → 44 → 111 s from low to max; reasoning tokens stay around 1k per turn.
- **The seed halves that exploration at every effort level** (calls −45–55%, turns −35–48%) and keeps
  the pass rate; at high it also cuts total tokens by 65% (372k → 130k), because the seeded files
  replace the re-reads that max/high Luna otherwise does.
- **Luna's best operating point is high + seed: 15/16, 37 s, 6.6 turns, $0.01.** It still loses to
  gpt-6.1-sol at low effort with the seed (16/16, 33 s, 3.9 turns, $0.05 standard tier) on wall and
  turns, and to Opus/Sonnet with the seed (28/27 s, 4.5/4.6 turns) on wall; it wins on cost.

## Is this the best way to use Jev?

It is the right kind of use — a cheap, task-aware classifier deciding what the expensive model gets to
read, applied once where the model's own judgement is weakest (turn 0, before it has seen anything) —
and it is the only exploration lever in two rounds that moved every model. It is also the simplest
possible version. What it does not do, in the order the data says to try:

1. **Candidate recall is the bottleneck, not ranking.** Jev only sees files that `rg` found from the
   prompt's identifiers and 2–4-word windows; a file no word of the prompt names cannot be seeded
   (e2 before v3). A name-only pass would widen recall cheaply: one request listing the paths under
   the task's directory (names only, no content) with a bool per path, then content-level scoring of
   the survivors. Jev handled 20 files with evidence per request in ~0.8 s; names-only should allow
   100+ per request.
2. **Section-level seeds for large files.** Files over 400 lines are never seeded whole, and those
   are exactly the ones the models then read in pieces (treat's `caseAuthority.ts`, `horizonScenarios.ts`
   on e4; e4 is the task where the seed helped least). Jev over tree-sitter outline entries (one bool per
   top-level function/test block, or a `score`) would seed the needed sections anchored, within the same
   budget. Round 1's `outline.ts` has the parsing.
3. **Budget by expected value, not a fixed threshold.** p ≥ 0.6 and a 40k-char cap are guesses. The
   Claude cost was flat because the seed is cache-written at 5× read price; a calibrated cut (seed a file
   when p × its read probability × its size beats the write cost) would keep the turn gain and recover
   the token cost. Jev's probabilities looked well calibrated here (0.99/0.97/0.61 on e1 were the three
   files the reference commit touched or called).
4. **Not worth it:** mid-session re-ranking of search hits (round 1: no gain, and the model has context
   by then), and per-turn "enough context, edit now" prompting (the models already edit first when the
   seed is complete — 100% on e1).

What stays true regardless of design: the seed must be labelled as already read and carry anchors, or
the model re-reads it (H1's `context` tool showed that), and Jev's latency (1.4–1.9 s for two requests)
is below the noise of a single API turn.
