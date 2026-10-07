# Can search and read improve as much as edit did?

Research report, October 2026. Branch `research/search-read`; `main` stays at the v0.2.7 release.

## Summary

**No.** Nothing built in this round improved agent outcomes enough to release. The bar was set in
advance: ≥25% fewer turns or tokens at an equal pass rate.

| What was tried | Offline / mechanism | Agent-level outcome |
|---|---|---|
| Intent search (locator + Jev re-rank) | hit@5 29% → 71–76% (pi), 33% → 41–52% (treat) | no gain; misled Luna; Sol/Luna turns and tokens rose |
| Separate grep tool | fixed Claude's low adoption of search inside read | Claude cache read +50–80% |
| Blast radius on edit | lists stale call sites after a signature change | models already found every call site (0 missed in both arms) |
| Answer-sized large reads | outline + matching parts for reads over 400 lines | rarely fires: models read ranges, not whole files |
| Lazy code graph propagation (one hop) | within one point of no graph | reverted |
| Seeding candidate files before turn 1 | works; the right file is usually listed | turns −16–18% (Sonnet, Sol), +2–8% (Opus, Luna); wall time not better |
| Repository-level OpenAI `prompt_cache_key` | first request cached 68% → 79% (Sol) | Luna 41% → 38%; fresh-input drop not attributable to it |
| Compact search output | search output −16–58% | turns rose for three of four models; net tokens ≈ flat except Opus |

The root cause is the size of the lever. In these tasks, search output is a few thousand tokens out of
30–60k per run. Even a large cut in search output can't move totals by 25%. Cache writes, cache reads
of the growing prefix, and output dominate cost.

One lead is open: the current branch build used fewer turns than v0.2.7 (Opus 4.8 → 3.9, −19%). Those
arms ran hours apart, so the comparison isn't controlled (see [Open leads](#open-leads)).

## Background

The pi-multiedit edit tool (v0.2.x) was a clear win over pi's built-in edit, pi-hashline-edit, and Claude
Code's and Codex's native tools. The question was whether read and search had a similar gap. The ideas
tested were:

- intent → files: the user describes behaviour, and the model must find the code;
- rg, ast-grep and Jev (TypeSafe's System One classifier);
- a call graph in the spirit of outcome-forge's DuckDB graph;
- token efficiency and inference-cache economics.

## What was built (branch only)

| Piece | File | Behaviour |
|---|---|---|
| read v2 | `src/reader.ts`, `src/read.ts` | batched reads; selectors: whole file, range, `pattern` search (cap 50 matches), outline, `intent`, glob listing; stubs for unchanged re-reads; 2000-line / 50 KB budget |
| locator | `src/locate.ts` | identifier variants and singulars, rg counts, IDF, declaration boost, prose down-weighting (0.25 unless the intent is about docs), one-hop fan-out from the top 3 |
| Jev re-rank | `src/jev.ts` | bool relevance per top-20 file, 8 in parallel, retries once; keeps the original order if any call fails |
| grep tool | `src/grep.ts` | `searches: [{pattern \| intent, path \| glob, context, flags}]`, behind `PI_MULTIEDIT_GREP=1` |
| code graph, blast radius | `src/graph.ts` | rg shortlist + tree-sitter identifier leaves; on edit, lists remaining uses of re-signed or removed definitions (2 s budget) |
| large-read shaping | `src/reader.ts`, `src/bash-reads.ts` | reads over 400 lines return outline + 3 task-matching parts; a plain `cat` gets the same once |
| experiments | `src/experiments.ts` | `PI_MULTIEDIT_SEED`, `PI_MULTIEDIT_CACHE_KEY`, `PI_MULTIEDIT_COMPACT` (below) |

All 95 tests pass and typecheck is clean.

## Method

**Tasks.** All tasks run on a snapshot of the pi monorepo.

| ID | Kind | Task |
|---|---|---|
| x1–x4 | exploration | change a default; rename an export across code and docs; place a comment above a function found by description; list every user of a constant |
| r1–r4 | real fixes | re-implement four real pi commits, from the commit subject only, at the commit's parent |
| b1–b2 | call sites | swap a parameter order or add a required parameter, then fix every caller |

**Checkers** were validated both ways: an untouched tree fails and the reference solution passes.
r-task targets are in `eval/fixtures/rN.targets`.

**Models.** All models ran through pi at low reasoning effort:

- claude-opus-5-5 and claude-sonnet-5-5 via the claude-sdk provider;
- gpt-6-sol and gpt-6-luna via openai-codex.

**Runs.** Each run has a 6-minute cap. The final experiment batch ran 16 runs per model and arm: 8 tasks
× 2 repetitions, 224 runs in all.

**Metrics.** Pass rate, assistant turns, tool calls, and wall time. Token components: fresh input,
cache read, cache write, output. Also the share of the first request served from cache, and the
characters returned by search calls. Token counts are reported, not cost.

**Offline locator benchmark.**

- 150 intents from pi history and 66 from treat history. Each intent is a task description with paths
  removed; its targets are the files the real commit changed.
- Metrics: recall@5, recall@10, hit@5, MRR.

## Results

### 1. Offline: intent → files

| Dataset | Ranker | recall@5 | recall@10 | hit@5 | MRR |
|---|---|---|---|---|---|
| pi (150) | rg on intent words | 18% | 38% | 29% | 0.16 |
| | locator | 48% | 57% | 71% | 0.54 |
| | locator + Jev | | | 76% | |
| treat (66) | rg on intent words | 6% | 9% | 33% | 0.20 |
| | locator | 17% | 25% | 41% | 0.32 |
| | locator + Jev | | | 52% | |

Notes:

- **Jev reliability.** Jev failures under parallel load first sank correct files (treat MRR 0.29). Retry
  plus all-or-nothing re-ranking fixed that.
- **One-hop graph propagation** stayed within one point on both datasets, so it was reverted.

### 2. Agent level: read v2, intent search and grep vs v0.2.7

Arms:

- `multi027`: the release.
- `one`: read v2 with search and intent inside read.
- `two`: the same plus a separate grep tool.

Values are averages per run.

| Model | Arm | Pass | Turns | Wall s | Fresh in | Cache read | Cache write | Search output |
|---|---|---|---|---|---|---|---|---|
| Opus | multi027 | 16/16 | 4.8 | 21 | 0k | 25k | 6k | 2.1k |
| | one | 7/8 | 5.2 | 21 | 0k | 31k | 6k | 1.0k |
| | two | 8/8 | 5.4 | 23 | 0k | 45k | 9k | 7.4k |
| Sonnet | multi027 | 16/16 | 4.8 | 20 | 0k | 25k | 6k | 1.7k |
| | one | 8/8 | 4.5 | 21 | 0k | 24k | 6k | 1.1k |
| | two | 8/8 | 4.6 | 27 | 0k | 39k | 11k | 12.4k |
| Sol | multi027 | 16/16 | 5.6 | 29 | 16k | 33k | – | 14.6k |
| | one | 8/8 | 7.5 | 56 | 26k | 80k | – | 14.5k |
| | two | 7/8 | 7.8 | 48 | 28k | 66k | – | 22.0k |
| Luna | multi027 | 14/16 | 6.3 | 23 | 22k | 78k | – | 19.9k |
| | one | 4/8 | 7.2 | 37 | 29k | 86k | – | 3.3k |
| | two | 4/8 | 5.9 | 40 | 33k | 67k | – | 44.4k |

Intent search found the right files but didn't shorten sessions. The models still verified with their
own searches and reads. When the ranking was wrong, Luna followed it.

### 3. Blast radius and large-read shaping (on vs off)

`cur` has blast radius and shaping on; `off` has both off. Values are totals per task group.

| Model | Group | Arm | Pass | Missed call sites | Calls | Fresh in | Cache read | Cache write | Output |
|---|---|---|---|---|---|---|---|---|---|
| Opus | b | off | 4/4 | 0 | 17 | 0k | 89k | 24k | 5.3k |
| | | cur | 4/4 | 0 | 16 | 0k | 75k | 24k | 5.1k |
| | r | off | 8/8 | – | 40 | 0k | 359k | 65k | 9.6k |
| | | cur | 8/8 | – | 35 | 0k | 320k | 65k | 8.2k |
| Sonnet | b | off | 4/4 | 0 | 19 | 0k | 111k | 32k | 5.7k |
| | | cur | 4/4 | 0 | 16 | 0k | 109k | 30k | 5.1k |
| | r | off | 8/8 | – | 29 | 0k | 244k | 55k | 6.9k |
| | | cur | 7/8 | – | 30 | 0k | 237k | 58k | 6.3k |
| Sol | b | off | 4/4 | 0 | 20 | 51k | 83k | – | 2.4k |
| | | cur | 4/4 | 0 | 20 | 51k | 72k | – | 2.5k |
| | r | off | 8/8 | – | 53 | 185k | 473k | – | 7.2k |
| | | cur | 8/8 | – | 64 | 206k | 745k | – | 7.8k |
| Luna | b | off | 4/4 | 0 | 22 | 60k | 104k | – | 2.6k |
| | | cur | 4/4 | 0 | 21 | 68k | 111k | – | 2.5k |
| | r | off | 4/8 | – | 44 | 194k | 398k | – | 4.5k |
| | | cur | 4/8 | – | 42 | 143k | 346k | – | 4.4k |

- **Blast radius:** no model missed a call site in either arm, so blast radius had nothing to catch.
- **Shaping** fires only on whole-file reads of large files. Claude reads ranges, so shaping rarely fired.
- **Differences** are within noise, in both directions.

### 4. Cost structure: where the tokens go

- **Claude cost** splits into cache write 52–57%, output 28–31%, cache read 15–17%.
- **GPT cost** is dominated by fresh input (68–71%), which is new tool output each turn; output is 13–15%.
- **The first request** (system prompt + tools) is 26% (Opus) and 34% (Sonnet) of Claude's cost, but only
  10–14% of GPT's.
- **pi's Codex provider** sets `prompt_cache_key` to the session id. Each new session therefore starts
  cold, even in the same repository.

Volume of tool results in the pi evals, as a share of all result characters:

| Source | Share |
|---|---|
| bash search | 21% |
| grep pattern | 19% |
| read, mixed batch | 14% |
| read, whole file | 10% |
| read, range | 9% |
| grep intent | 7% |
| tests | 6% |
| edit | 5% |

Search is about 51% of all tool output. That made search output the obvious lever, which experiment 3
in the next section tests.

### 5. Final experiments (same batch, interleaved)

All arms use the current branch with `PI_MULTIEDIT_GREP=1` and Jev, and differ by one flag:

- `seed`: before turn 1, a `before_agent_start` hook runs locator + Jev on the prompt. It adds a hidden
  message with the top candidate files and anchored evidence lines, marked "candidates, verify", capped
  at 4,000 characters and 5 s.
- `cache` (GPT only): a `before_provider_request` hook replaces `prompt_cache_key` with a hash of the
  repository's root commit. These runs went sequentially so that each session could reuse the previous
  one's prefix.
- `compact`:
  - grep defaults to 0 context lines, at most 20 matches and 5 per file;
  - a plain bash `rg`/`grep` result over 4,000 characters is grouped per file with counts;
  - running the same command again returns the full output.

Pre-registered targets:

- seed: turns −25% and wall time −20%, with pass rate not worse;
- cache: first-request cache hits up and GPT cost −8–12%;
- compact: search output −40% and cost −10–15%.

Values are averages per run.

| Model | Arm | Pass | Turns | Wall s | Fresh in | Cache read | Cache write | 1st request cached | Search output |
|---|---|---|---|---|---|---|---|---|---|
| Opus | base | 16/16 | 3.9 | 13 | 0k | 24k | 6k | 53% | 4.5k |
| | seed | 16/16 | 4.2 | 17 | 0k | 30k | 6k | 46% | 1.8k |
| | compact | 16/16 | 3.9 | 12 | 0k | 21k | 5k | 56% | 1.9k |
| Sonnet | base | 15/16 | 4.4 | 13 | 0k | 27k | 6k | 56% | 4.4k |
| | seed | 16/16 | 3.6 | 14 | 0k | 25k | 7k | 46% | 4.3k |
| | compact | 15/16 | 4.8 | 14 | 0k | 28k | 6k | 56% | 3.7k |
| Sol | base | 16/16 | 6.2 | 28 | 15k | 41k | – | 68% | 11.2k |
| | seed | 16/16 | 5.2 | 27 | 11k | 33k | – | 63% | 8.0k |
| | compact | 16/16 | 6.6 | 29 | 11k | 38k | – | 85% | 6.9k |
| | cache | 16/16 | 5.6 | 25 | 11k | 34k | – | 79% | 11.0k |
| Luna | base | 12/16 | 6.0 | 35 | 18k | 45k | – | 41% | 13.2k |
| | seed | 13/16 | 6.1 | 21 | 18k | 53k | – | 32% | 11.6k |
| | compact | 12/16 | 6.6 | 22 | 15k | 48k | – | 41% | 9.4k |
| | cache | 14/16 | 6.1 | 30 | 16k | 37k | – | 38% | 11.6k |

Against the targets:

- **Seed: failed.**
  - Turns: Sonnet −18%, Sol −16%, Opus +8%, Luna +2%.
  - Wall time didn't improve. The locator and Jev add 2–5 s before the first call.
  - Seeding removes a first search, but models still read the file before editing.
- **Cache key: not shown.**
  - Sol's first-request cached share rose from 68% to 79%; Luna's fell from 41% to 38%.
  - The arm's lower fresh input matches `seed` and `compact`, which don't change the key. Base was the
    outlier.
  - OpenAI probably already routes many identical prefixes to a warm cache without a key.
- **Compact: partial.**
  - Search output fell 16–58%.
  - Turns rose for Sonnet, Sol and Luna: models re-ran searches or read more to make up for the dropped
    context.
  - Only Opus came out clearly ahead: cache read −12%, cache write −17%.

## Conclusions

1. **Finding files isn't the bottleneck for frontier models on these tasks.** They find the files in 1–2
   searches. A better ranker raises offline metrics a lot, but turns and tokens barely change.
2. **Models verify regardless of what the tool tells them.** Seeded candidates, intent rankings and blast
   radius lists are all re-checked with the model's own reads. Information the model doesn't trust adds
   tokens without removing calls.
3. **Search output is too small a share of tokens to be the lever.** Cutting it shifts the work into extra
   turns. The cost that stays is the growing prefix of each turn (Claude cache writes and reads, GPT fresh
   input) and output.
4. **The edit win came from removing calls.** One transactional multi-file call replaced many edits plus
   verification. Search and read improvements so far only make each call smaller.

## Open leads

- **Current branch vs v0.2.7, controlled.** The `base` arm of section 5 used fewer turns than `multi027`
  in section 2:
  - Opus 4.8 → 3.9, Sonnet 4.8 → 4.4;
  - Luna's cache read 78k → 45k, but Luna also passed fewer tasks (12/16 vs 14/16).

  The arms ran 4–5 hours apart. Wall time fell uniformly even on tasks where turns didn't change, which
  points to API latency. The turn counts don't depend on latency, but they need a same-batch, interleaved
  rerun before they count: multi027 vs base, 8 tasks × 4 models × 2 reps, 64 runs.
- **Long sessions.** Search output and cross-session cache reuse grow with session length and sessions per
  repository. Long treat-repo sessions (dozens of turns, many subagents) are where an effect could reach
  25%. This eval's 4–6-turn tasks can't show it. That needs a long-session eval built from real treat
  sessions.
- **Calls removed, not bytes.** The analogue of the edit win would be a read that answers the question
  outright, so the model doesn't search and then read. One candidate is the definition plus its users in
  one call. A tool like that should be measured by calls removed per task.

## Reproducing

The `eval/` directory next to this report holds the harness: `run2.sh`, `check.py`, the scorers, the
prompts and the r-task targets. The fixtures (a 121 MB snapshot of the pi monorepo and the four commit
parents) aren't committed. `run2.sh` contains absolute paths from the machine the evals ran on.

```sh
sh eval/run2.sh <task> <model-tag> <arm> <model-id> <rep>   # e.g. x2 sonnet seed claude-sonnet-5-5 1
python3 eval/exp_score.py base seed compact cache           # averages per model x arm
```

Jev needs `TYPESAFE_API_KEY`. `run2.sh` reads it from `~/.config/typesafe/api_key`.
