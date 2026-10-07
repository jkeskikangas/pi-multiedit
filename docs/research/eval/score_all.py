"""One table across pi, Claude Code and Codex transcripts. Usage: score_all.py <arm>=<rep-glob> ..."""
import json, glob, os, re, subprocess, sys, collections
E = os.path.dirname(os.path.abspath(__file__))
# Commands that write files: in-place sed/perl, python heredoc/inline scripts that write, shell redirects into source files.
BASH_EDIT = re.compile(r"sed -i|perl -[a-z]*i|python3?\s+-\s*<<|python3?\s+<<|python3? -c [^|]*(write|open\()|cat\s*>\s*[\w./-]+\.\w+|tee\s+[\w./-]+\.\w+|(?<![0-9&])>\s*[\w./-]+\.(ex|exs|py|ts|md|json)\b")

def pi_run(jl):
    m = collections.Counter(); bash_edits = 0
    for line in open(jl):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "tool_execution_start":
            m["calls"] += 1; n = e["toolName"]
            if n in ("edit", "write"): m["edits"] += 1
            if n == "bash" and BASH_EDIT.search((e.get("args") or {}).get("command", "")): bash_edits += 1
        if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
            u = e["message"].get("usage") or {}; m["turns"] += 1
            m["input"] += u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0); m["output"] += u.get("output", 0)
            m["cost_micro"] += round(((u.get("cost") or {}).get("total", 0)) * 1e6)
    m["bash_edits"] = bash_edits; return m

def cc_run(jl):
    m = collections.Counter(); seen = set()
    for line in open(jl):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "assistant":
            for b in e["message"].get("content", []):
                if b.get("type") == "tool_use" and b["id"] not in seen:
                    seen.add(b["id"]); m["calls"] += 1
                    if b["name"] in ("Edit", "Write", "MultiEdit", "NotebookEdit"): m["edits"] += 1
                    if b["name"] == "Bash" and BASH_EDIT.search(b["input"].get("command", "")): m["bash_edits"] += 1
        if e.get("type") == "result":
            u = e.get("usage") or {}; m["turns"] = e.get("num_turns", 0)
            m["input"] = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            m["output"] = u.get("output_tokens", 0)
            m["cost_micro"] = round((e.get("total_cost_usd") or 0) * 1e6)
    return m

# pi's catalog list prices (USD per million tokens) for the openai-codex models, so Codex is priced like pi.
CODEX_PRICE = {"sol": (2.0, 0.2, 10.0), "luna": (0.1, 0.01, 0.5)}

def codex_run(jl):
    m = collections.Counter()
    price = CODEX_PRICE["sol" if "-sol-" in jl else "luna"]
    for line in open(jl):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "item.completed":
            it = e["item"]; t = it.get("type")
            if t in ("command_execution", "file_change", "mcp_tool_call", "web_search"): m["calls"] += 1
            if t == "file_change": m["edits"] += 1
            if t == "command_execution" and BASH_EDIT.search(it.get("command", "")): m["bash_edits"] += 1
        if e.get("type") == "turn.completed":
            u = e.get("usage") or {}; m["turns"] += 1
            m["input"] += u.get("input_tokens", 0); m["output"] += u.get("output_tokens", 0)
            cached = u.get("cached_input_tokens", 0)
            m["cost_micro"] += round(((u.get("input_tokens", 0) - cached) * price[0] + cached * price[1] + u.get("output_tokens", 0) * price[2]))
    return m

def score(arm, pattern):
    rows = []
    for jl in sorted(glob.glob(f"{E}/runs/{pattern}.jsonl")):
        base = jl[:-6]; task = os.path.basename(base).split("-")[0]
        kind = cc_run if any(t in base for t in ("cc-native", "opus-native", "sonnet-native")) else codex_run if any(t in base for t in ("codex-native", "sol-native", "luna-native")) else pi_run
        m = kind(jl); m["secs"] = int(open(base + ".exit").read().split()[1])
        m["ok"] = json.loads(subprocess.run([sys.executable, f"{E}/check.py", task, base], capture_output=True, text=True).stdout)["pass"]
        rows.append(m)
    t = collections.Counter()
    for r in rows: t.update({k: int(v) for k, v in r.items()})
    return len(rows), t

print(f"{'arm':34} pass   calls edits shell-edits input_tok output  secs   cost$  $/run")
for spec in sys.argv[1:]:
    arm, pats = spec.split("=", 1)
    n = 0; t = collections.Counter()
    for p in pats.split(","):
        k, c = score(arm, p); n += k; t.update(c)
    cost = t["cost_micro"] / 1e6
    print(f"{arm:34} {t['ok']:2}/{n:<2} {t['calls']:6} {t['edits']:5} {t['bash_edits']:11} {t['input']:9} {t['output']:6} {t['secs']:5} {cost:7.3f} {cost/max(n,1):6.4f}")
