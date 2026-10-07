import json, glob, subprocess, sys, re, collections, statistics
def run(jl):
    m = collections.Counter()
    for line in open(jl):
        try: e = json.loads(line)
        except: continue
        if e.get("type") == "tool_execution_start": m["calls"] += 1
        if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
            u = e["message"].get("usage") or {}
            m["fresh"] += u.get("input", 0); m["cread"] += u.get("cacheRead", 0); m["cwrite"] += u.get("cacheWrite", 0); m["out"] += u.get("output", 0)
            m["cost_u"] += round(((u.get("cost") or {}).get("total", 0)) * 1e6)
    return m
print(f"{'model':7} {'group':4} {'arm':4} pass  missed  calls   cost$   fresh   cache-read  cache-write  output")
for model in ("opus", "sonnet", "sol", "luna"):
    for group, tasks in (("b", "b1 b2"), ("r", "r1 r2 r3 r4")):
        for arm in ("off", "cur"):
            t = collections.Counter(); n = ok = missed = 0
            for task in tasks.split():
                for jl in glob.glob(f"runs/{task}-{model}-{arm}-r[12].jsonl"):
                    n += 1; t.update(run(jl))
                    res = json.loads(subprocess.run([sys.executable, "check.py", task, jl[:-6]], capture_output=True, text=True).stdout)
                    ok += res["pass"]
                    for f in res["failures"]:
                        mm = re.match(r"(\d+) of \d+ call sites", f)
                        if mm: missed += int(mm.group(1))
            print(f"{model:7} {group:4} {arm:4} {ok:2}/{n:<2} {missed if group=='b' else '-':>6} {t['calls']:6} {t['cost_u']/1e6:7.3f} {t['fresh']/1000:6.0f}k {t['cread']/1000:9.0f}k {t['cwrite']/1000:10.0f}k {t['out']/1000:6.1f}k")
