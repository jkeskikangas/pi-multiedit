"""Exploration metrics per setup across pi, Claude Code and Codex transcripts."""
import json, glob, os, re, subprocess, sys, collections, statistics
E = os.path.dirname(os.path.abspath(__file__))
READ_CMD = re.compile(r"^\s*(?:/bin/zsh -lc \"?)?\s*(cat|sed -n|head|tail|nl|rg|grep|find|ls|tree|fd|git (?:grep|ls-files|show))\b")
EDIT_CMD = re.compile(r"sed -i|perl -[a-z]*i|python3?\s+-\s*<<|python3?\s+<<|cat\s*>\s*\S|tee\s+\S|(?<![0-9&])>\s*[\w./-]+\.(md|ts|json)\b|apply_patch")

def classify_bash(cmd):
    if EDIT_CMD.search(cmd): return "edit"
    return "read" if READ_CMD.search(cmd) else "run"

def events(jl):
    """(kind, result_chars) per tool call in order; kind in read/edit/run/other."""
    out = []; usage = collections.Counter(); pending = {}
    harness = "cc" if any(t in jl for t in ("-native-", )) and ("opus" in jl or "sonnet" in jl) else "codex" if "-native-" in jl else "pi"
    for line in open(jl):
        try: e = json.loads(line)
        except Exception: continue
        if harness == "pi":
            if e.get("type") == "tool_execution_start":
                n = e["toolName"]; a = e.get("args") or {}
                k = "read" if n in ("read", "grep", "find", "ls") else "edit" if n in ("edit", "write") else classify_bash(a.get("command", "")) if n == "bash" else "other"
                pending[e["toolCallId"]] = len(out); out.append([k, 0])
            if e.get("type") == "tool_execution_end" and e.get("toolCallId") in pending:
                r = e.get("result") or {}; out[pending[e["toolCallId"]]][1] = sum(len(x.get("text", "")) for x in r.get("content", []) if isinstance(x, dict))
            if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
                u = e["message"].get("usage") or {}; usage["in"] += u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0); usage["out"] += u.get("output", 0)
        elif harness == "cc":
            if e.get("type") == "assistant":
                for b in e["message"].get("content", []):
                    if b.get("type") == "tool_use" and b["id"] not in pending:
                        n = b["name"]; k = "read" if n in ("Read", "Grep", "Glob") else "edit" if n in ("Edit", "Write", "MultiEdit") else classify_bash(b["input"].get("command", "")) if n == "Bash" else "other"
                        pending[b["id"]] = len(out); out.append([k, 0])
            if e.get("type") == "user":
                for b in e["message"].get("content", []) if isinstance(e["message"].get("content"), list) else []:
                    if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                        c = b.get("content"); c = " ".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else str(c)
                        out[pending[b["tool_use_id"]]][1] = len(c)
            if e.get("type") == "result":
                u = e.get("usage") or {}; usage["in"] = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0); usage["out"] = u.get("output_tokens", 0)
        else:
            if e.get("type") == "item.completed":
                it = e["item"]; t = it.get("type")
                if t == "command_execution": out.append([classify_bash(it.get("command", "")), len(it.get("aggregated_output") or "")])
                elif t == "file_change": out.append(["edit", 0])
            if e.get("type") == "turn.completed":
                u = e.get("usage") or {}; usage["in"] += u.get("input_tokens", 0); usage["out"] += u.get("output_tokens", 0)
    return out, usage

def bash_read(jl):
    """Read/search calls made through a shell (pi bash, Claude Bash, Codex commands)."""
    n = 0
    for line in open(jl):
        try: e = json.loads(line)
        except Exception: continue
        if e.get("type") == "tool_execution_start" and e["toolName"] == "bash" and classify_bash((e.get("args") or {}).get("command", "")) == "read": n += 1
        if e.get("type") == "assistant":
            for b in e["message"].get("content", []):
                if b.get("type") == "tool_use" and b["name"] == "Bash" and classify_bash(b["input"].get("command", "")) == "read": n += 1
        if e.get("type") == "item.completed" and e["item"].get("type") == "command_execution" and classify_bash(e["item"].get("command", "")) == "read": n += 1
    return n

print(f"{'setup':28} pass  calls  before-1st-edit(med)  read-calls  bash-reads  read-output(kchars)  tokens-in  tokens-out  secs")
rows = {}
for spec in sys.argv[1:]:
    name, pat = spec.split("=", 1)
    P = calls = br = rc = rchars = 0; befores = []; tin = tout = secs = 0; n = 0
    for jl in sorted(glob.glob(f"{E}/runs/{pat}.jsonl")):
        base = jl[:-6]; task = os.path.basename(base).split("-")[0]; n += 1
        ev, u = events(jl)
        P += json.loads(subprocess.run([sys.executable, f"{E}/check.py", task, base], capture_output=True, text=True).stdout)["pass"]
        calls += len(ev); kinds = [k for k, _ in ev]
        befores.append(kinds.index("edit") if "edit" in kinds else len(kinds))
        rc += sum(1 for k, _ in ev if k == "read"); rchars += sum(c for k, c in ev if k == "read")
        br += bash_read(jl); tin += u["in"]; tout += u["out"]; secs += int(open(base + ".exit").read().split()[1])
    rows[name] = dict(P=P, n=n, calls=calls, before=statistics.median(befores) if befores else 0, rc=rc, br=br, rchars=rchars, tin=tin, tout=tout, secs=secs)
    r = rows[name]
    print(f"{name:28} {P:2}/{n:<2} {calls:5}  {r['before']:16.1f}  {rc:10}  {br:10}  {rchars/1000:17.0f}  {tin/1000:8.0f}k  {tout/1000:8.1f}k  {secs:5}")
