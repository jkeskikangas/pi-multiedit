"""Jev seed vs baseline (multi) per model × task group; seed latency and size. usage: score_jev.py"""
import json, glob, re, subprocess, sys, collections, os
E = os.path.dirname(os.path.abspath(__file__))
sys.argv = ["x", "."]; exec(open(f"{E}/score_e.py").read().split("pat = re.compile")[0])  # reuse parse()
agg = collections.defaultdict(collections.Counter); rows = []
for jl in sorted(glob.glob(f"{E}/runs/*-r[12].jsonl")):
    m = re.match(r".*/([exb]\d)-(opus|sonnet|sol61|luna)-(multi|jev|jev2)-r(\d)\.jsonl", jl)
    if not m: continue
    task, model, arm, rep = m.groups(); group = "treat" if task[0] == "e" else "pi"
    try: code, secs = open(jl[:-6] + ".exit").read().split()
    except: continue
    res = json.loads(subprocess.run([sys.executable, f"{E}/check.py", task, jl[:-6]], capture_output=True, text=True).stdout or '{"pass":false,"failures":["crash"]}')
    c = parse(jl); c["runs"] += 1; c["ok"] += res["pass"]; c["wall"] += int(secs)
    seed = re.search(r"\[jev\] (\d+) candidates, (\d+) whole, (\d+) chars, (\d+) ms", open(jl[:-6] + ".err", errors="replace").read()) if arm == "jev" else None
    if seed: c["seed_whole"] += int(seed.group(2)); c["seed_chars"] += int(seed.group(3)); c["seed_ms"] += int(seed.group(4)); c["seeded"] += 1
    first = None
    for line in open(jl):
        e = json.loads(line)
        if e.get("type") == "tool_execution_start": first = e["toolName"]; break
    c["first_edit"] += first == "edit"
    rows.append((task, model, arm, rep, res["pass"], c, res["failures"], seed.group(2) if seed else "-"))
    agg[(group, model, arm)].update(c)
print(f"{'task':4} {'model':6} {'arm':5} r ok turns calls edits eerr  wall  whole-seeded first-tool-edit  failures")
for task, model, arm, rep, ok, c, f, w in rows:
    print(f"{task:4} {model:6} {arm:5} {rep} {'✓' if ok else '✗'} {c['turns']:5} {c['calls']:5} {c['edit_calls']:5} {c['edit_err']:4} {c['wall']:5}  {w:>12} {'yes' if c['first_edit'] else 'no':>15}  {'; '.join(f)[:60]}")
print(f"\n{'group':5} {'model':6} {'arm':5} pass   wall  turns  calls  edit-err  first=edit  seed ms  seed whole  seed chars")
for (group, model, arm), c in sorted(agg.items()):
    n = c["runs"]; s = max(c["seeded"], 1)
    print(f"{group:5} {model:6} {arm:5} {c['ok']:2}/{n:<3} {c['wall']/n:5.0f} {c['turns']/n:6.1f} {c['calls']/n:6.1f} {c['edit_err']/n:9.2f} {c['first_edit']:4}/{n:<4} {c['seed_ms']/s if arm=='jev' else 0:7.0f} {c['seed_whole']/s if arm=='jev' else 0:10.1f} {c['seed_chars']/s/1000 if arm=='jev' else 0:9.0f}k")
