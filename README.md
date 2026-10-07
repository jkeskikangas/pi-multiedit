# pi-multiedit

One edit call for a whole change in [pi](https://pi.dev). An agent can rename a function across a
codebase, create a module and register it, add an entry to a JSON registry and rewrite a section
of docs, all in a single `edit` call that applies everything or nothing. What comes back is what
landed on disk, line by line.

```
pi install npm:pi-multiedit
```

It replaces pi's `read` and `edit` tools, so remove pi-hashline-edit if you have it installed:
both register those names.

## Why it's built this way

Agents edit files badly in predictable ways. The usual edit tool changes one file per call, so a
ten-file change takes ten calls, or the agent writes a throwaway Python script to do it. Those
scripts fail halfway and leave half a change on disk. Exact-text matching breaks on a trailing
space the model didn't remember. After editing, the agent runs `git diff` or `cat` to see what
happened. pi-multiedit is built so that none of this is needed.

- **All or nothing.** Every edit in a call is checked in memory before anything is written. If
  any one fails, no file changes, and the agent gets every failure at once with the nearby lines
  to retry from. Writes are atomic per file, and if a write fails halfway through a call, the
  files already written are restored.
- **Point at lines instead of retyping them.** `read` tags each line with a short anchor, like
  `12#KT:`. An edit can name a range by its anchors (`from: "12#KT", to: "15#BH"`), so the model
  doesn't reproduce text it might get slightly wrong. Anchors stay valid through the earlier
  edits in the same call, and a stale one is refused instead of hitting the wrong line.
- **The right selector for the job.** Exact text for small changes, anchor ranges for blocks,
  regex for patterns, and JSON pointers for data files. Any of them can apply to one file or to
  every file matching a glob.
- **The result is the proof.** Files are re-read after writing and compared byte for byte with
  what was intended. The result shows only the lines that changed, as word diffs with fresh
  anchors the next call can use. There's nothing left to check with `git diff`.
- **No new syntax errors.** Every edited file with a known grammar is parsed before and after.
  An edit that breaks parsing is refused, and the broken lines come back with anchors. Errors
  that were already in the file don't count.
- **One concept, no overlapping options.** Every change is an edit: a scope, at most one
  selector, an action and a count. Without a selector, an edit applies to the whole file, which
  is how files are created, appended to or deleted. There is no second syntax and no alias. The
  description covers every field and ends with a complete example; in evals, that brought tool
  errors to zero where looser variants had several.

## The two tools

| Tool | What it does |
|---|---|
| `read{path, offset?, limit?}` | Returns text with an anchor on every line (`12#KT:  return total`). The hashes are compatible with pi-hashline-edit. Images and other non-text files use pi's built-in `read`. |
| `edit{edits, allowSyntaxErrors?}` | Applies every edit in order, all or nothing. |

Each edit has a **scope**, at most one **selector**, and optionally an **action** and a **count**:

| | Options |
|---|---|
| scope | `path`, or `glob` over git-visible files (e.g. `src/**/*.ts`) |
| selector | `old`: exact text · `from` + `to`: whole lines between two anchors, inclusive (an end may also be exact text) · `regex` (+ `flags`), where `new` may use `$1` and `$<name>` · `json`: a pointer whose segments may be `[key=value]` or `-` (append) · none: the whole file (`path` only) |
| action | `replace` (default), `before`, `after`, `delete`. Every action except `delete` needs `new`; deleting is always explicit |
| count | how many matches are expected across the scope: `1` (default), a number, or `"all"` |

`new` is text for every selector except `json`, where it is the JSON value itself (`"integration"`,
`3`, `{"path": "a"}`). The action composes with every selector the same way. On the whole file,
`replace` creates or overwrites it, `before`/`after` prepend or append raw text to an existing
file, and `delete` removes it.

A single call that changes code, creates a file, updates a JSON registry and every matching call
site:

```json
{"edits": [
  {"path": "src/accounts.ts", "from": "12#KT", "to": "15#BH", "action": "delete"},
  {"path": "src/accounts-api.ts", "new": "export const accountsApi = {};\n"},
  {"glob": "src/**/*.ts", "old": "repo.find(", "new": "repo.findOrThrow(", "count": "all"},
  {"path": "test/layers.json", "json": "/suites/-", "new": {"path": "test/accounts-api.test.ts", "layer": "integration"}}
]}
```

Moving a file is not an edit; use `git mv`.

## What comes back

On success, the files that changed, with only their changed lines. `~` marks a rewritten line,
`+` an added one, and each carries its new anchor:

```
Applied 2 step(s) to 2 file(s); re-read from disk: identical; syntax: ok (2 file(s)).

step 1: 2 matches in 1 file(s)

src/accounts.ts  +2 -2
@@ 4
~4#TS:  return repo.[-find-]{+findOrThrow+}("users", id);
@@ 8
~8#QM:  return repo.[-find-]{+findOrThrow+}("companies", id);

test/layers.json  +2 -1
@@ 3
~3#HR:    { "path": "test/accounts.test.ts", "layer": "unit" }{+,+}
+4#QJ:    { "path": "test/accounts-api.test.ts", "layer": "integration" }
```

On failure, nothing is written, and every failing step is listed with what the agent needs to fix
it in one retry:

```
Nothing was written: 2 of 2 step(s) failed.

step 1 (src/accounts.ts): old not found in src/accounts.ts
nearest:
2#KM:
3#HW:export function fetchUser(id: string) {
4#YR:  return repo.find("users", id);
nearest:
6#SY:
7#JV:export function fetchCompany(id: string) {
8#WN:  return repo.find("companies", id);

step 2: old matched 2 times, expected 1. Add surrounding context, or set count to 2 or "all".
  src/accounts.ts: lines 4, 8
```

An edit that would leave a file unparsable is refused the same way:

```
Nothing was written: the edit introduces parse errors. Fix them in the retry, or set allowSyntaxErrors if the parser is wrong.
New parse errors near:
src/accounts.ts
  9#WN:  return repo.find("companies", id);
  10#BN:}
```

When `old` doesn't match exactly, the tool tries again ignoring trailing whitespace and curly
quotes, then a consistent indentation shift (re-indenting `new` to match). It does so only when
the match is unique, and the result says when it happened.

## How it compares

A small synthetic eval at low thinking: 4 tasks, each run twice per setup. The tasks: a multi-file
TypeScript change with a JSON registry and docs; a Python rename that adds a parameter; a
TypeScript config and docs change; and converting 9 multi-line, nested `assertEqual(a, b)` calls
across 3 test files to `expect(a).toEqual(b)`, next to look-alikes that must not change. Each model
ran in its own vendor's agent with its native edit tool, and in pi with each edit tool.

**claude-opus-5-5**

| Setup | Tool calls | Edit calls | Shell edits | Tokens in | Tokens out | Time |
|---|--:|--:|--:|--:|--:|--:|
| Claude Code | 28 | 6 | 8 | 250k | 9.0k | 117s |
| pi built-in | 32 | 8 | 7 | 155k | 7.8k | 111s |
| pi-hashline-edit | 21 | 1 | 9 | 162k | 6.3k | 99s |
| **pi-multiedit** | 27 | 8 | **0** | 171k | 6.7k | 107s |

**claude-sonnet-5-5**

| Setup | Tool calls | Edit calls | Shell edits | Tokens in | Tokens out | Time |
|---|--:|--:|--:|--:|--:|--:|
| Claude Code | 35 | 6 | 8 | 265k | 9.7k | 122s |
| pi built-in | 32 | 5 | 11 | 169k | 7.8k | 105s |
| pi-hashline-edit | 27 | 4 | 7 | 173k | 7.1k | 99s |
| **pi-multiedit** | 28 | 9 | **0** | 168k | 7.1k | 98s |

**gpt-6-sol**

| Setup | Tool calls | Edit calls | Shell edits | Tokens in | Tokens out | Time |
|---|--:|--:|--:|--:|--:|--:|
| Codex | 42 | 9 | 0 | 805k | 6.8k | 232s |
| pi built-in | 62 | 26 | 2 | 122k | 5.5k | 200s |
| pi-hashline-edit | 57 | 24 | 0 | 137k | 4.0k | 150s |
| **pi-multiedit** | **32** | 8 | **0** | **86k** | **3.7k** | **147s** |

**gpt-6-luna**

| Setup | Tool calls | Edit calls | Shell edits | Tokens in | Tokens out | Time |
|---|--:|--:|--:|--:|--:|--:|
| Codex | 28 | 7 | 1 | 689k | 5.5k | 163s |
| pi built-in | 58 | 23 | 1 | 131k | 4.8k | 151s |
| pi-hashline-edit | 63 | 20 | 5 | 211k | 6.1k | 199s |
| **pi-multiedit** | 36 | 11 | **0** | **120k** | **4.1k** | 157s |

Every setup passed all 8 tasks except gpt-6-luna with pi built-in and with pi-hashline-edit (7/8
each; both failures were Python scripts on the `assertEqual` task). Claude Code and Codex are each
model's own agent with its native edit tool.

"Shell edits" counts files changed with `sed -i` or Python scripts instead of the edit tool:
no checks, no feedback, and the way half-applied changes happen. pi-multiedit is the only setup
with none for every model. GPT models gain the most: with gpt-6-sol it needed about half the tool
calls of pi's other edit tools and the fewest input and output tokens of all four setups. Claude
models already batch their edits, so their numbers are close; with them, pi-multiedit's gain is
that every edit goes through the tool instead of `sed`. Input tokens include cached input, which
the native agents use heavily (Codex served about 83% from cache). Two runs per task show a
direction, not a significant result.

## Limits

- Text files in valid UTF-8 only. Binary files and other encodings are refused, never rewritten.
- A consistently CRLF file keeps CRLF. In a file with mixed line endings, unedited lines keep
  theirs. Edited lines are written with LF, and a multi-line `old` only matches loosely there (the
  result says so).
- Writes go through symlinks to the file they point to. Deleting a symlink itself is refused; use
  bash for links.
- Each write replaces the file with a new one (temp file and rename). The file mode is kept, but
  hard links break and the owner and extended attributes are not kept.
- The syntax check covers TypeScript, JavaScript, CSS, HTML and Python out of the box, chosen by
  file extension. Other languages (Go, Rust, Java, Ruby and more) need their
  grammar: `npm i @ast-grep/lang-<name> --prefix ~/.pi/agent/npm`. Without it, the syntax check
  skips those files.

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
match [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit). The syntax check parses
with [ast-grep](https://ast-grep.github.io)'s tree-sitter bindings.

## License

[MIT](LICENSE)
