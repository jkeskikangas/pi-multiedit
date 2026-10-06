# pi-multiedit

One edit call for a whole change in [pi](https://pi.dev). An agent can rename a function across a
codebase, move a file and fix its imports, add an entry to a JSON registry and rewrite a section
of docs, all in a single `edit` call that applies everything or nothing. What comes back is what
landed on disk, line by line.

```
pi install npm:pi-multiedit
```

It replaces pi's `read` and `edit` tools, so remove pi-hashline-edit if you have it installed:
both register those names.

## Why it's built this way

Agents edit files badly in predictable ways. The usual edit tool changes one file per call, so a
ten-file change takes ten calls, or the agent writes a throwaway Python script to do it. One
codebase had 3,700 such scripts in a single month. Those scripts fail halfway and leave half a
change on disk. Exact-text matching breaks on a trailing space the model didn't remember. After
editing, the agent runs `git diff` or `cat` to see what happened. pi-multiedit is built so that
none of this is needed.

- **All or nothing.** Every edit in a call is checked in memory before anything is written. If
  any one fails, no file changes, and the agent gets every failure at once with the nearby lines
  to retry from. Writes are atomic per file, and if a write fails halfway through a call, the
  files already written are restored.
- **Point at lines instead of retyping them.** `read` tags each line with a short anchor, like
  `12#KT:`. An edit can name a range by its anchors (`from: "12#KT", to: "15#BH"`), so the model
  doesn't reproduce text it might get slightly wrong. Anchors stay valid through the earlier
  edits in the same call, and a stale one is refused instead of hitting the wrong line.
- **The right selector for the job.** Exact text for small changes, anchor ranges for blocks,
  regex for patterns, [ast-grep](https://ast-grep.github.io) patterns for code shapes such as
  every `Repo.get($S, $ID)` call, and JSON pointers for data files. Any of them can apply to one
  file or to every file matching a glob.
- **The result is the proof.** Files are re-read after writing and compared byte for byte with
  what was intended. The result shows only the lines that changed, as word diffs with fresh
  anchors the next call can use. There's nothing left to check with `git diff`.
- **No new syntax errors.** Every edited file with a known grammar is parsed before and after.
  An edit that breaks parsing is refused, and the broken lines come back with anchors. Errors
  that were already in the file don't count.
- **One strict shape, explained in full.** The tool has one canonical argument shape. Its
  description covers every field and ends with a complete example. In evals, that brought tool
  errors to zero where looser variants had several.

## The two tools

| Tool | What it does |
|---|---|
| `read{path, offset?, limit?}` | Returns text with an anchor on every line (`12#KT:  return total`). The hashes are compatible with pi-hashline-edit. Images and other non-text files use pi's built-in `read`. |
| `edit{path?, edits?, files?, patch?, dryRun?, allowSyntaxErrors?}` | Applies every step in order, all or nothing. `path` is the default file for edits that don't name one. |

Each item in `edits` has a **scope**, exactly one **selector**, and optionally an **action** and a
**count**:

| | Options |
|---|---|
| scope | `path`, or `glob` over git-visible files (e.g. `lib/**/*.ex`) |
| selector | `old`: exact text · `from` + `to` (inclusive) or `until` (exclusive): an anchor or exact text at each end · `regex` (+ `flags`), where `new` may use `$1` and `$<name>` · `ast` (+ `lang`), an ast-grep pattern whose `$X` and `$$$X` can be reused in `new` · `json`, a pointer whose segments may be `[key=value]` or `-` (append) |
| action | `replace` (default), `before`, `after`, `delete` (the default when `new` is omitted) |
| count | how many matches are expected across the scope: `1` (default), a number, or `"all"` |

`new` is text for every selector except `json`, where it is the JSON value itself (`"integration"`,
`3`, `{"path": "a"}`). `files` creates, moves or deletes whole files before the edits run. `patch`
accepts a Codex `apply_patch` envelope, which GPT models write natively. `dryRun` shows the diff
without writing.

A single call that changes code, a JSON registry and every matching call site:

```json
{"edits": [
  {"path": "lib/accounts.ex", "from": "12#KT", "to": "15#BH", "action": "delete"},
  {"glob": "lib/**/*.ex", "old": "Repo.get(", "new": "Repo.get!(", "count": "all"},
  {"path": "test/layers.json", "json": "/suites/-", "new": {"path": "test/accounts_api_test.exs", "layer": "integration"}}
]}
```

## What comes back

On success, the files that changed, with only their changed lines. `~` marks a rewritten line,
`+` an added one, and each carries its new anchor:

```
Applied 2 step(s) to 2 file(s); re-read from disk: identical; syntax: ok (2 file(s)).

step 1: 2 matches in 1 file(s)

lib/accounts.ex  +2 -2
@@ 2
~2#MJ:  def fetch_user(id), do: Repo.get{+!+}(User, id)
@@ 5
~5#TX:    Repo.get{+!+}(Company, id)

test/layers.json  +2 -1
@@ 3
~3#YS:    { "path": "test/accounts_test.exs", "layer": "unit" }{+,+}
+4#JY:    { "path": "test/accounts_api_test.exs", "layer": "integration" }
```

On failure, nothing is written, and every failing step is listed with what the agent needs to fix
it in one retry:

```
Nothing was written: 2 of 2 step(s) failed.

step 1 (lib/accounts.ex): old not found in lib/accounts.ex
nearest:
1#MW:defmodule Accounts do
2#KR:  def fetch_user(id), do: Repo.get(User, id)
3#HW:

step 2: old matched 2 times, expected 1. Add surrounding context, or set count to 2 or "all".
  lib/accounts.ex: lines 2, 5
```

An edit that would leave a file unparsable is refused the same way:

```
Nothing was written: the edit introduces parse errors. Fix them in the retry, or set allowSyntaxErrors if the parser is wrong.
New parse errors near:
lib/accounts.ex
  8#PT:end
```

When `old` doesn't match exactly, the tool tries again ignoring trailing whitespace and curly
quotes, then a consistent indentation shift (re-indenting `new` to match). It does so only when
the match is unique, and the result says when it happened.

## How it compares

A small synthetic eval in pi, run on gpt-6-luna and claude-sonnet-5-5 at low thinking: 3 tasks,
each repeated twice per tool. The tasks were a multi-file Elixir change with a JSON registry and
docs, a Python rename that adds a parameter, and a TypeScript config and docs change.

| Model and tool | Tasks passed | Tool calls | Edit calls | Time |
|---|---|---|---|---|
| gpt-6-luna, pi built-in edit | 6/6 | 41 | 18 | 105 s |
| gpt-6-luna, pi-hashline-edit | 6/6 | 50 | 20 | 113 s |
| gpt-6-luna, pi-multiedit | 6/6 | 23 | 7 | 75 s |
| claude-sonnet-5-5, pi built-in edit | 6/6 | 23 | 5 | 74 s |
| claude-sonnet-5-5, pi-hashline-edit | 6/6 | 21 | 4 | 72 s |
| claude-sonnet-5-5, pi-multiedit | 6/6 | 18 | 6 | 46 s |

Every tool got every task right, so the differences are in effort. With pi-multiedit, 11 of 12
runs made the whole change in one edit call. The one exception was a correct refusal: GPT dropped
trailing commas, the syntax check refused the call, and the retry fixed them. Total input tokens
were 30% lower than with the built-in edit for GPT and 5% lower for Sonnet, whose prompt is cached.
Six runs per row show a direction, not a significant result, and wall time varies a lot between
runs.

## Limits

- Text files in valid UTF-8 only. Binary files and other encodings are refused, never rewritten.
- A consistently CRLF file keeps CRLF. In a file with mixed line endings, unedited lines keep
  theirs. Edited lines are written with LF, and a multi-line `old` only matches loosely there (the
  result says so).
- Writes go through symlinks to the file they point to. `files` won't delete or move a symlink
  itself; use bash for links.
- Each write replaces the file with a new one (temp file and rename). The file mode is kept, but
  hard links break and the owner and extended attributes are not kept.
- `ast` and the syntax check cover TypeScript, JavaScript, CSS, HTML, Elixir and Python. To add a
  language, install its `@ast-grep/lang-<name>` package next to this one.

## How it works

A call is planned entirely in memory. Each step runs against the current in-memory state of its
files, in order, and records which lines it changed. That record is what lets anchors from your
last `read` still find the right lines after earlier steps in the same call have moved them. If
any step fails, the plan is thrown away.

A successful plan is committed under pi's per-file locks, taken in a fixed order so that two
concurrent calls can't deadlock. Before writing, each file is checked again to make sure nothing
changed it since planning. Each file is then written to a temporary file and renamed into place.
If a write fails, the files already written are put back. Finally every file is read back and
compared with what was intended.

## Requirements

- pi 1.0.3 or newer, on Node 22.19 or newer.

## Development

```
npm install
npm test            # unit, property (fast-check) and tool tests; no model calls
npx tsc -p .        # typecheck
```

## Credits

Hash-anchored lines come from [oh-my-pi](https://github.com/can1357/oh-my-pi), and the hashes
match [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit). The `patch` input follows
Codex's `apply_patch` format. Structural matching uses [ast-grep](https://ast-grep.github.io).

## License

[MIT](LICENSE)
