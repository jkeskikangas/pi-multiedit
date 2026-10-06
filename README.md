# pi-multiedit

A [pi](https://pi.dev) extension that replaces the `read` and `edit` tools with a transactional,
multi-file edit tool. One `edit` call carries any number of edits across any number of files and
applies all of them or none.

## Install

```bash
npm install
pi install /path/to/pi-multiedit   # remove pi-hashline-edit: both register read and edit
```

## The model

An edit is **scope × selector × action × count**:

| | Options |
|---|---|
| scope | `path` (or the call's top-level `path`) · `glob` over git-visible files |
| selector | `old` exact text · `from` + `to`/`until` (LINE#HASH anchor or text) · `regex` · `ast` (ast-grep) · `json` (pointer with `[key=value]`, `-`) |
| action | `replace` · `before` · `after` · `delete` |
| count | expected matches across the scope: default 1, a number, or `"all"` |

Whole-file operations go in `files` (`write`, `moveTo`, `delete`) and run before the edits. `patch`
accepts a Codex `apply_patch` envelope. `dryRun` previews the change without writing.

## Guarantees

- **All or nothing.** Every edit is planned in memory first. Any failure writes nothing, and the
  result lists every failure with fresh anchors near the miss. The commit re-checks each file on
  disk, writes through temp file + rename, and restores already-written files if a later write fails.
- **Anchors are stable within a call.** `read` returns `LINE#HASH:` lines, with hashes compatible
  with pi-hashline-edit. Anchors always refer to the file as read and are mapped through the
  call's earlier edits. A stale anchor, or one inside a region an earlier edit changed, is refused.
- **Feedback is the verified state.** Files are re-read after writing. The result shows only the
  changed lines: rewritten lines as word diffs with their new anchors.
- **No new syntax errors.** Every edited file with a known grammar is parsed before and after. An
  edit that introduces a parse error is refused, and the broken lines come back with anchors. Errors
  already in the file don't count; `allowSyntaxErrors` overrides the check when the parser is wrong.
- **Forgiving matching, honestly reported.** When `old` misses, the tool retries ignoring trailing
  whitespace and typographic punctuation, then a uniform indentation shift (re-indenting `new`). The
  result says when it did so.

## Limits

- Text files only, valid UTF-8 only; binary files and other encodings are refused.
- A consistently CRLF file keeps CRLF. In a file with mixed line endings, unedited lines keep theirs;
  edited lines are written with LF, and a multi-line `old` matches only loosely (the result says so).
- Writes go through symlinks to their target, but `files` will not delete or move a symlink. Use
  bash for links.
- Temp file + rename gives the file a new inode. It keeps the mode, but breaks hard links and does
  not keep the owner or extended attributes.
- `ast` covers TypeScript, JavaScript, CSS and HTML; Elixir and Python come from
  `@ast-grep/lang-*`. Install another `@ast-grep/lang-<name>` to add a language.

## Develop

```bash
npm test            # node:test + fast-check
npx tsc -p .        # typecheck
```

## Credits

The hash-anchored `LINE#HASH` format comes from [oh-my-pi](https://github.com/can1357/oh-my-pi), and
its hashes match [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit). The `patch` input
follows Codex's `apply_patch` (V4A) format. Structural matching uses [ast-grep](https://ast-grep.github.io).

## License

[MIT](LICENSE)
