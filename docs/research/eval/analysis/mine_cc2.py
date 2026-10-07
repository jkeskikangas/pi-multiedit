"""Bash categories, edit batching potential, context growth in Claude Code treat sessions."""
import json, glob, re, sys, collections, os, statistics
CATS = [
    ("shelledit", re.compile(r"\b(sed\s+-i|python3?\s+-c|python3?\s+<<|perl\s+-p?i|cat\s*>|cat\s*<<|tee\s)")),
    ("test", re.compile(r"\b(mix test|pnpm (test|vitest)|npm test|npx vitest|vitest|pytest|bun test|mix check|checks)\b")),
    ("compile_lint", re.compile(r"\b(mix compile|mix format|mix credo|mix dialyzer|tsc|eslint|pnpm (lint|typecheck|build)|npm run)\b")),
    ("git_diff", re.compile(r"\bgit (diff|status|show|log)\b")),
    ("git_other", re.compile(r"\bgit\b|\bgh\b")),
    ("search", re.compile(r"\b(rg|grep|ag|ast-grep|sg)\b")),
    ("read", re.compile(r"^\s*(cat|sed\s+-n|head|tail|bat|less)\b|\b(cat|sed -n|head|tail)\s+[\w./-]+\s*$")),
    ("list", re.compile(r"^\s*(ls|find|tree|wc|du)\b")),
]
def cat_of(cmd):
    for k, rx in CATS:
        if rx.search(cmd): return k
    return "other"
def text_of(content):
    if isinstance(content, str): return content
    return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
bash = collections.Counter(); bash_chars = collections.Counter(); bash_err = collections.Counter()
samples = collections.defaultdict(list)
msgs_with_edits = 0; edit_calls_in_msgs = 0; edit_only_runs = []  # lengths of runs of consecutive assistant messages whose tool calls are all edits
ctx_sizes = []; turns_seen = 0; result_sizes = []
seq_edits = 0  # edit messages immediately following an edit message (separate turns)
for jl in sorted(glob.glob(sys.argv[1])):
    pending = {}; prev_msg_edit_only = False; run = 0
    for line in open(jl, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("isSidechain"): continue
        m = e.get("message") or {}
        if e.get("type") == "assistant":
            u = m.get("usage") or {}
            if u: ctx_sizes.append(u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("input_tokens", 0))
            tools = [b for b in m.get("content") or [] if isinstance(b, dict) and b.get("type") == "tool_use"]
            if not tools: continue
            names = [b.get("name") for b in tools]
            edit_only = all(n in ("Edit", "MultiEdit", "Write") for n in names)
            if edit_only:
                msgs_with_edits += 1; edit_calls_in_msgs += len(names)
                if prev_msg_edit_only: seq_edits += 1; run += 1
                else:
                    if run: edit_only_runs.append(run)
                    run = 1
            else:
                if run: edit_only_runs.append(run)
                run = 0
            prev_msg_edit_only = edit_only
            for b in tools:
                pending[b.get("id")] = (b.get("name"), b.get("input") or {})
                if b.get("name") == "Bash":
                    cmd = str(b["input"].get("command", "")); k = cat_of(cmd); bash[k] += 1
                    if len(samples[k]) < 6 and k in ("shelledit", "other", "read"): samples[k].append(cmd[:160].replace("\n", "\\n"))
        elif e.get("type") == "user":
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_result": continue
                n, a = pending.get(b.get("tool_use_id"), (None, {})); txt = text_of(b.get("content") or "")
                result_sizes.append((n, len(txt)))
                if n == "Bash":
                    k = cat_of(str(a.get("command", ""))); bash_chars[k] += len(txt)
                    if b.get("is_error"): bash_err[k] += 1
    if run: edit_only_runs.append(run)
tot = sum(bash.values()); totc = sum(bash_chars.values())
print("bash by category: calls / result chars / errors")
for k, v in bash.most_common(): print(f"  {k:12} {v:6} {100*v/tot:5.1f}%  {bash_chars[k]/1000:9.0f}k {100*bash_chars[k]/totc:5.1f}%  err {bash_err[k]}")
for k in ("shelledit", "other", "read"):
    print(f"samples {k}:"); [print("   ", s) for s in samples[k]]
print(f"\nedit-only assistant messages {msgs_with_edits}, edit calls in them {edit_calls_in_msgs}; messages that directly follow another edit-only message {seq_edits}")
print("runs of consecutive edit-only turns: n", len(edit_only_runs), "mean", round(statistics.mean(edit_only_runs), 2), "dist", collections.Counter(min(r, 6) for r in edit_only_runs))
print("turns that could be saved by merging each run into one call:", sum(r - 1 for r in edit_only_runs), "of", len(ctx_sizes), "turns")
ctx_sizes.sort()
print("context size per request: median", ctx_sizes[len(ctx_sizes)//2], "p90", ctx_sizes[int(len(ctx_sizes)*.9)], "mean", int(statistics.mean(ctx_sizes)))
rs = sorted(result_sizes, key=lambda x: -x[1])
print("largest tool results:", [(n, s) for n, s in rs[:8]])
big = [s for _, s in result_sizes if s > 20000]
print("results > 20k chars:", len(big), "of", len(result_sizes), "bytes share", round(100*sum(big)/max(sum(s for _, s in result_sizes),1)), "%")
