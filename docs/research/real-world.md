# pi-multiedit on real work: correctness, wall time, and where the turns go

Research report, round 2, October 2026. Follows [search-read.md](search-read.md) (round 1: search and
read levers failed the ≥25% bar). `main` stays at v0.2.7. Primary metrics in this round, in order:
correctness, wall time, turns, tool calls. Tokens and cost are reported but secondary.

## Summary

On the user's real codebase (treat: Elixir with Finnish strings, heredocs and sigils, plus a TypeScript
workspace), pi-multiedit is correct and fast, and it is at parity with pi's built-in edit on every primary
metric. Both pi setups finish small and medium tasks in 8–9 turns and 24–40 s; Claude Code needs
15–17 turns for the same wall time. pi-multiedit's remaining advantage over pi built-in is that every
edit goes through a verified tool (0 shell edits per run against 1.2–1.6); its remaining cost is 0.4–0.5
failed edit calls per run, each one turn.

The turn budget of a pi-multiedit run is: **exploration 64%** (5.8 turns of search and read), edit 15%,
edit retries 5%, final answer 11%, post-edit verification 1%. Edit mechanics are therefore 1.75 turns of
9, and pi's process startup and shutdown are 7–8 s of a 26–40 s run. A material cut in wall time for
small and medium tasks has to come from exploration turns or from fixed overhead, not from the edit
tool. The one edit-level fix with evidence is cheap: three of the seven edit misses were line
references without hashes (`19`, `19#`, `147#`) after the model had read the file with `sed -n`
instead of `read`.

Long sessions are a different regime: 98% of the user's real spend is in Claude Code sessions over 100
turns, where cost is the re-read prefix and a result-retirement policy simulates −36%. That is secondary
to this round's targets; it is sized in [Exp B](#exp-b-retiring-old-tool-results-secondary-cost) with
the caveat that the prototype has a cliff.

## Exp A: pi-multiedit on treat

Four tasks from real treat commits, specified by subject and body, at the commit's parent. Every
AGENTS.md/CLAUDE.md and harness config is stripped from the fixture so each harness sees the same tree;
checkers are static and validated both ways (parent fails, reference passes); the prompt forbids running
mix, tests or builds because the fixtures have no `_build`/`deps`.

| ID | Commit | Files |
|---|---|---|
| e1 | reject token-less legacy sessions in VerifiedSession | 1 lib, 1 test (Elixir) |
| e2 | restrict the domain verification token to company admins | 2 lib (one edits prose in a `@moduledoc """` heredoc), 1 test |
| e3 | label support Slack alerts and ping the channel | 2 lib, 2 tests; Finnish strings (ä/ö) next to the change |
| e4 | optional doctor presence and specialty in the case contract | zod schema, mock, scenarios, test, docs (TypeScript) |

Arms: pi + pi-multiedit v0.2.7; pi built-in edit/read; Claude Code with Bash/Read/Edit/Write/Glob/Grep.
Opus 5.5 and Sonnet 5.5 at low effort, 2 reps, 48 runs. Two checks were relaxed after the first rep
because they encoded the reference's variable names rather than the prompt (e2's test shape, e4's
inline enum); all four still fail the parent and pass the reference. Averages per run:

| Model | Harness | Pass | Wall s | Turns | Tool calls | Edit calls | Shell edits | Edit errors | Tokens out | Cached in |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| opus | pi + pi-multiedit | 8/8 | 40 | 9.0 | 8.1 | 1.8 | 0.0 | 0.50 | 3.7k | 94k |
| opus | pi built-in | 8/8 | 40 | 8.9 | 9.4 | 1.8 | 1.2 | 0.25 | 3.1k | 94k |
| opus | Claude Code | 8/8 | 41 | 16.5 | 11.6 | 2.1 | 1.4 | 0.00 | 0.8k | 246k |
| sonnet | pi + pi-multiedit | 7/8 | 26 | 8.1 | 8.0 | 1.9 | 0.0 | 0.38 | 3.2k | 91k |
| sonnet | pi built-in | 7/8 | 24 | 7.6 | 7.4 | 0.1 | 1.6 | 0.00 | 2.8k | 70k |
| sonnet | Claude Code | 8/8 | 29 | 14.5 | 10.4 | 2.0 | 0.6 | 0.00 | 0.7k | 183k |

Claude Code's output-token count is per message chunk and not comparable. The two failures were model
omissions: Sonnet+multiedit never touched `slack_sender.ex` on e3; Sonnet built-in left
`doctor_specialty` non-optional on e4.

**Correctness.** Equal within noise. Elixir-specific input (heredoc prose, Finnish text, `do … end`
blocks) caused no edit failure; the syntax check parsed every `.ex`/`.exs` file (lang-elixir is
installed). pi built-in and Claude Code make 1–2 shell edits per run (heredoc creates, `sd`, `sed -i`),
which are unverified; pi-multiedit makes none.

**Wall time.** Parity between the pi arms; Claude Code equal despite 1.8× the turns, because its turns
are shorter (less text per turn). In the pi runs, the span from the first user message to the last
assistant message is 32.6 s (Opus) and 21.4 s (Sonnet); the remaining 7–8 s per run is pi process
startup and shutdown, identical with and without pi-multiedit. That is 20–30% of a small task's wall
time and is pi's, not the extension's.

**Turns.** Where the 16 pi-multiedit runs spend them (turns per run):

| Phase | Turns | Share |
|---|--:|--:|
| explore (search, read, list) | 5.75 | 64% |
| edit (successful) | 1.31 | 15% |
| edit retry after a failed call | 0.44 | 5% |
| verify after edit | 0.06 | 1% |
| final answer | 1.00 | 11% |

Edits already batch: 1.8 edit calls per run cover 2–5 files. Verification after an edit has stopped
("the result is the proof" works). The exploration turns are sequential single calls: search, read,
read, search; the models rarely issue independent reads in one turn.

**Edit errors.** 7 failed calls in 29 (24%), each costing a turn:

| Cause | Count | Example |
|---|--:|---|
| line reference without a hash, after a `sed -n` read | 3 | `from: "19", to: "42"`; `from: "19#", to: "40#"`; `from: "147#"` |
| model's wrong guess about file state | 2 | deleting a duplicate line that did not exist; multi-line `old` that was not there |
| missing `new` on a replace | 1 | `{from, to}` with no `new` and no `action: "delete"` |
| edit introduced a parse error (correctly refused) | 1 | |

The first class is the only one the tool can remove. The model reads with bash when it batches several
`sed -n` ranges in one command, gets no anchors, and improvises a line reference. Options, in order of
safety: (a) say so in the refusal ("`19` is a line number without its hash; use the `N#HH` anchor from
`read`, or quote the line"), which saves nothing but makes the retry certain; (b) accept a bare line
number when `from` and `to` are both bare and the result shows the changed lines, which saves the turn
but applies an unverified edit if the number is stale; (c) anchor bash reads (`sed -n`, `cat`) the way
round 1's `bash-reads.ts` shaped them, which gives the model hashes wherever it reads. Across all 2,100
multiedit edits in both rounds the class occurs 5 times, so the gain is ≤0.2 turns per run.

## What real sessions say about the rest

141 Claude Code sessions on treat (`~/.claude/projects/-Users-pyykkis-work-treat*`; Opus 5.5 in 117),
49,630 turns, 26,011 tool calls. (The pi sessions on treat from August 2026 ran a hashline-style edit
tool, not pi-multiedit.) Used here to size levers, not as a benchmark.

- **Tool mix:** Bash 79% of calls (search 32%, test 16%, read 12%, git diff/status 11%, other 11%, git
  8%, shell edits 6%, compile/lint 5%); Edit 11%; Read 3%; Write 2%. 24% of edits bypass the edit
  tool.
- **Edit tool:** 3,578 calls, 25 errors (0.7%). One edit per call, always; 49% directly follow another
  edit, which batching would merge, but that is 3.5% of turns.
- **After an edit:** another edit 49%, search 18%, other bash 11%, test/compile 6%, `mix format` 6%,
  git diff 3%, a read 5%. Verification fails 12% of the time and leads to a fix edit 45 times in 685.
- **Session length:** median 185 turns, mean 305. Sessions over 100 turns are 98% of cost; over 300,
  83%.
- **Prefix composition:** tool results 60% (Bash 82% of that, Read 15%), bash command text 17%, user
  text 10%, edit arguments 7%, assistant text 4%. Mean context 336k tokens per request.
- **Cost (Opus 5.5 list):** cache read 61%, 1-hour cache writes 25% (166M tokens written for ~20M of
  new content: invalidation re-writes), output 14%.

Sized against this round's metrics (turns in small and medium tasks), the candidates left after round 1
are all small: merging consecutive edits (≤3.5% of turns, already done by the tool), auto-`mix format`
on write (2.1% of turns), `sd`/ast-grep bulk rewrites (24 calls in 141 sessions; glob+regex covers it),
the bare-line-number hint (≤0.2 turns per run).

## Exp B: retiring old tool results (secondary: cost)

Not a turns or wall-time lever; it is the only lever with a ≥25% effect on long-session cost, so it is
recorded for the next round.

**Simulation** on the 131 real sessions of ≥20 turns (tokens ≈ chars/3.5; Opus 5.5 5-minute cache; no
compaction): a tool result older than K assistant turns, outside the newest N results and not an edit
result, is replaced by a one-line stub; decisions are taken every B turns so the prefix is rewritten
rarely, and the rewrite of everything after the earliest retired result is charged at cache-write price.

| Policy | Simulated cost | Saving |
|---|---|---|
| none | $2,422 | – |
| K=30, N=10, B=25 | $1,490 | 38.5% |
| K=60, N=20, B=40 | $1,559 | 35.6% |

The model re-read a file it had read more than 30 turns earlier 101 times in 49,496 turns (0.2%), which
bounds the harm at about one extra call per such event.

**Prototype** (`context` hook, 40 lines): pi accepts rewritten tool results and Sonnet 5.5 and Opus 5.5
accept the edited history. Forced to K=2/N=2/B=1 on a 4-step chained task that both models otherwise
finish in 7–8 turns, both ran past 80 tool calls without finishing step 3 and were stopped. The policy
has a cliff; K=30 cannot be assumed safe from the simulation. Testing it needs sessions of 60+ turns,
which pi-multiedit's batching never produces on synthetic tasks: a buildable treat worktree with tests
in the loop is required.

## Recommendation

1. **Edit tool: ship the bare-line-number hint (a), consider (c)**, and stop there. Correctness and
   wall time are at parity with the best alternative; the tool's distinct value (no unverified shell
   edits) is intact on Elixir.
2. **For wall time on small and medium tasks, measure pi's fixed overhead first.** 7–8 s of startup and
   shutdown in a 26–40 s run is the largest single non-model component; it is outside this extension
   but inside the user's loop.
3. **For turns, the only large pool is exploration (64%).** Round 1 showed that better ranking does not
   shorten it for Claude models. What was not tested is parallel exploration: a guideline and tool
   shape that make the model issue its independent reads and searches in one turn. It is a cheap
   16-run experiment on the Exp A tasks; expected effect 1–2 turns per run if the model complies.
4. **Long sessions:** build the long-session eval (buildable treat worktree, 60–200 turns) before
   spending more on retirement; validate K ∈ {15, 30, 60} on pass rate and cost there.

## Reproducing

`docs/research/eval/` has the harness: `run_l.sh` (arms multi/builtin/native/retire), `check.py` and
`check_l1.py`, prompts, `score_e.py`, `batch-e.sh`, the e-task sha pairs (`fixtures/eN.sha`,
`eN.targets`) and `setup-e.sh` to rebuild a fixture from the treat repo (`git clone --shared`, checkout
the parent, strip agent config, commit); `retire/index.ts` is the prototype; `analysis/` holds the
transcript scripts (`mine_cc.py`, `mine_cc2.py`, `after_edit.py`, `growth.py`, `retire_sim.py`), which
read `~/.claude/projects/-Users-pyykkis-work-treat*/*.jsonl`. Runs and fixtures are not committed.
