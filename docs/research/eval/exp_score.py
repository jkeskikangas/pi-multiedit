# Per model x arm: pass rate, turns, calls, wall time, token components, first-request cached share, search output volume.
import json, glob, subprocess, sys, collections, re
TASKS = "x1 x2 x3 x4 r1 r2 r3 r4".split()
SEARCH = re.compile(r"^\s*(rg|grep)\s")
def run(jl):
    m = collections.Counter(); first = None; pending = {}
    for line in open(jl):
        try: e = json.loads(line)
        except: continue
        t = e.get("type")
        if t == "tool_execution_start":
            m["calls"] += 1; a = e.get("args") or {}
            pending[e.get("toolCallId")] = e.get("toolName") == "grep" or (e.get("toolName") == "bash" and bool(SEARCH.match(str(a.get("command", ""))))) or (e.get("toolName") == "read" and any("pattern" in s or "intent" in s for s in a.get("reads", []) if isinstance(s, dict)))
        if t == "tool_execution_end" and pending.get(e.get("toolCallId")):
            r = e.get("result") or {}
            m["search_chars"] += sum(len(c.get("text", "")) for c in r.get("content", []) if isinstance(c, dict))
        if t == "message_end" and e["message"].get("role") == "assistant":
            u = e["message"].get("usage") or {}; m["turns"] += 1
            if first is None:
                first = u; tot = u.get("input", 0) + u.get("cacheRead", 0) + u.get("cacheWrite", 0)
                m["first_cached_pct_x100"] += round(100 * 100 * u.get("cacheRead", 0) / max(tot, 1))
            m["fresh"] += u.get("input", 0); m["cread"] += u.get("cacheRead", 0); m["cwrite"] += u.get("cacheWrite", 0); m["out"] += u.get("output", 0)
    return m
arms = sys.argv[1:] or ["base", "seed", "compact", "cache"]
print(f"{'model':7} {'arm':8} {'pass':6} {'turns':>6} {'calls':>6} {'wall s':>7} {'fresh':>7} {'cread':>8} {'cwrite':>7} {'out':>6} {'1st$%':>6} {'search':>7}")
for model in ("opus", "sonnet", "sol", "luna"):
    for arm in arms:
        t = collections.Counter(); n = ok = wall = 0
        for task in TASKS:
            for jl in sorted(glob.glob(f"runs/{task}-{model}-{arm}-r[12].jsonl")):
                ex = jl[:-6] + ".exit"
                try: code, secs = open(ex).read().split()
                except: continue
                n += 1; wall += int(secs); t.update(run(jl))
                res = json.loads(subprocess.run([sys.executable, "check.py", task, jl[:-6]], capture_output=True, text=True).stdout or '{"pass":false}')
                ok += res["pass"]
        if n: print(f"{model:7} {arm:8} {ok:2}/{n:<3} {t['turns']/n:6.1f} {t['calls']/n:6.1f} {wall/n:7.0f} {t['fresh']/n/1000:6.0f}k {t['cread']/n/1000:7.0f}k {t['cwrite']/n/1000:6.0f}k {t['out']/n/1000:5.1f}k {t['first_cached_pct_x100']/n/100:5.0f}% {t['search_chars']/n/1000:6.1f}k")
