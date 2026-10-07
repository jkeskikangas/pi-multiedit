"""Score Exp A/l1 runs: pi json (multi/builtin/retire) and Claude Code stream-json (native). usage: score_e.py <task-regex> [arms...]"""
import json, glob, re, subprocess, sys, collections, os
E = os.path.dirname(os.path.abspath(__file__))
SHELLEDIT = re.compile(r"\b(sed\s+-i|python3?\s+-c|python3?\s+-\s*<<|python3?\s+<<|perl\s+-p?i|cat\s*>|cat\s*<<|tee\s|\bsd\s)")
EDITTOOLS = {"edit", "write", "Edit", "MultiEdit", "Write"}
def parse(jl):
    c = collections.Counter(); native = False
    for line in open(jl):
        try: e = json.loads(line)
        except: continue
        t = e.get("type")
        if t == "tool_execution_start":  # pi
            n = e.get("toolName"); a = e.get("args") or {}; c["calls"] += 1; c["t:" + n] += 1
            if n in EDITTOOLS: c["edit_calls"] += 1; c["edits"] += len(a.get("edits") or [1])
            if n == "bash" and SHELLEDIT.search(str(a.get("command", ""))): c["shelledit"] += 1
        elif t == "tool_execution_end" and e.get("toolName") in EDITTOOLS and e.get("isError"): c["edit_err"] += 1
        elif t == "message_end" and e["message"].get("role") == "assistant":
            u = e["message"].get("usage") or {}; c["turns"] += 1; c["fresh"] += u.get("input", 0); c["cread"] += u.get("cacheRead", 0); c["cwrite"] += u.get("cacheWrite", 0); c["out"] += u.get("output", 0); c["cost"] += (u.get("cost") or {}).get("total", 0)
        elif t == "assistant":  # claude code stream-json
            native = True; m = e.get("message") or {}; u = m.get("usage") or {}
            c["turns"] += 1; c["fresh"] += u.get("input_tokens", 0); c["cread"] += u.get("cache_read_input_tokens", 0); c["cwrite"] += u.get("cache_creation_input_tokens", 0); c["out"] += u.get("output_tokens", 0)
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    n = b.get("name"); a = b.get("input") or {}; c["calls"] += 1; c["t:" + n] += 1
                    if n in EDITTOOLS: c["edit_calls"] += 1; c["edits"] += len(a.get("edits") or [1])
                    if n == "Bash" and SHELLEDIT.search(str(a.get("command", ""))): c["shelledit"] += 1
        elif t == "user" and native:
            for b in (e.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"): c["tool_err"] += 1
        elif t == "result": c["cost"] += e.get("total_cost_usd", 0) or 0
    return c
pat = re.compile(sys.argv[1]); arms = sys.argv[2:]
agg = collections.defaultdict(collections.Counter); rows = []
for jl in sorted(glob.glob(f"{E}/runs/*.jsonl")):
    name = os.path.basename(jl)[:-6]; m = re.match(r"(\w+)-(\w+)-(\w+)-r(\w+)$", name)
    if not m or not pat.fullmatch(m.group(1)) or (arms and m.group(3) not in arms): continue
    task, model, arm, rep = m.groups()
    try: code, secs = open(jl[:-6] + ".exit").read().split()
    except: continue
    chk = f"{E}/check_l1.py" if task == "l1" else f"{E}/check.py"
    res = json.loads(subprocess.run([sys.executable, chk, task, jl[:-6]], capture_output=True, text=True).stdout or '{"pass":false,"failures":["crash"]}')
    c = parse(jl); c["runs"] += 1; c["ok"] += res["pass"]; c["wall"] += int(secs)
    rows.append((task, model, arm, rep, res["pass"], c, res["failures"]))
    agg[(model, arm)].update(c)
print(f"{'task':4} {'model':6} {'arm':8} r ok turns calls edits shell eerr   out  cread cwrite fresh  wall  failures")
for task, model, arm, rep, ok, c, f in rows:
    print(f"{task:4} {model:6} {arm:8} {rep} {'✓' if ok else '✗'} {c['turns']:5} {c['calls']:5} {c['edit_calls']:5} {c['shelledit']:5} {c['edit_err']:4} {c['out']:5} {c['cread']/1000:6.0f}k {c['cwrite']/1000:5.0f}k {c['fresh']/1000:4.0f}k {c['wall']:5}  {'; '.join(f)[:70]}")
print(f"\n{'model':6} {'arm':8} pass   turns calls edit-calls shell  out    cread  cwrite  fresh  wall  cost$")
for (model, arm), c in sorted(agg.items()):
    n = c["runs"]
    print(f"{model:6} {arm:8} {c['ok']:2}/{n:<3} {c['turns']/n:5.1f} {c['calls']/n:5.1f} {c['edit_calls']/n:8.1f} {c['shelledit']/n:6.2f} {c['out']/n:6.0f} {c['cread']/n/1000:6.0f}k {c['cwrite']/n/1000:6.0f}k {c['fresh']/n/1000:5.0f}k {c['wall']/n:5.0f} {c['cost']/n:6.2f}")
