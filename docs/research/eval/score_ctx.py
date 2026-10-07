"""H1 readout: adoption, phase budget, and multi vs ctx per model. usage: score_ctx.py"""
import json, glob, re, subprocess, sys, collections, os
E = os.path.dirname(os.path.abspath(__file__))
SEARCH = re.compile(r"\b(rg|grep|git grep|find|ls|git ls-files)\b"); READ = re.compile(r"^\s*(cat|sed -n|head|tail)\b|; *(cat|sed -n)\b"); VER = re.compile(r"\bgit (diff|status)\b|rg -c|rg -l")
rows = []; agg = collections.defaultdict(collections.Counter)
for jl in sorted(glob.glob(f"{E}/runs/e[1-4]-*-{{multi,ctx}}-r[12].jsonl".replace("{multi,ctx}", "*"))):
    m = re.match(r".*/(e\d)-(\w+)-(multi|ctx|ctx2)-r(\d)\.jsonl", jl)
    if not m: continue
    task, model, arm, rep = m.groups()
    try: code, secs = open(jl[:-6] + ".exit").read().split()
    except: continue
    ok = json.loads(subprocess.run([sys.executable, f"{E}/check.py", task, jl[:-6]], capture_output=True, text=True).stdout)["pass"]
    turns = []; cur = None; edited = False; first_tool = None; ctx_calls = 0; ctx_chars = 0; bash_after_ctx = 0; pend = {}
    for line in open(jl):
        e = json.loads(line); t = e.get("type")
        if t == "message_end" and e["message"].get("role") == "assistant":
            if cur is not None: turns.append(cur)
            cur = []
        if t == "tool_execution_start":
            tn = e["toolName"]; a = e.get("args") or {}; pend[e["toolCallId"]] = tn
            first_tool = first_tool or tn
            if tn == "context": ctx_calls += 1; k = "context"
            elif tn == "edit": k = "edit"
            elif tn == "read": k = "read"
            elif tn == "bash":
                c = str(a.get("command", "")); k = "verify" if (edited and VER.search(c)) else "read" if READ.search(c) else "search" if SEARCH.search(c) else "bash-other"
                if ctx_calls and not edited: bash_after_ctx += 1
            else: k = tn
            cur.append(k)
        if t == "tool_execution_end":
            if pend.get(e["toolCallId"]) == "context":
                ctx_chars += sum(len(c.get("text", "")) for c in (e.get("result") or {}).get("content", []) if isinstance(c, dict))
            if e["toolName"] == "edit":
                if e.get("isError"): cur[-1] = "edit-ERR"
                else: edited = True
    if cur is not None: turns.append(cur)
    ph = collections.Counter()
    for tc in turns:
        if not tc: ph["final"] += 1
        elif "edit-ERR" in tc: ph["edit-retry"] += 1
        elif "edit" in tc: ph["edit"] += 1
        elif all(c in ("read", "search", "context") for c in tc): ph["explore"] += 1
        elif "verify" in tc: ph["verify"] += 1
        else: ph["bash-other"] += 1
    r = dict(task=task, model=model, arm=arm, rep=rep, ok=ok, wall=int(secs), turns=len(turns), first=first_tool, ctx=ctx_calls, ctx_chars=ctx_chars, bash_after_ctx=bash_after_ctx, **{"ph:" + k: v for k, v in ph.items()})
    rows.append(r); c = agg[(model, arm)]; c.update({k: v for k, v in r.items() if isinstance(v, (int, bool)) and k not in ("rep",)}); c["n"] += 1; c["first_ctx"] += first_tool == "context"
print(f"{'task':4} {'model':6} {'arm':5} r ok wall turns first-tool ctx ctx-chars bash-after-ctx | explore edit retry final")
for r in rows:
    print(f"{r['task']:4} {r['model']:6} {r['arm']:5} {r['rep']} {'✓' if r['ok'] else '✗'} {r['wall']:4} {r['turns']:5} {str(r['first']):10} {r['ctx']:3} {r['ctx_chars']:9} {r['bash_after_ctx']:14} | {r.get('ph:explore',0):7} {r.get('ph:edit',0):4} {r.get('ph:edit-retry',0):5} {r.get('ph:final',0):5}")
print(f"\n{'model':6} {'arm':5} pass   wall  turns  explore  edit  retry  ctx-first  ctx/run  bash-after-ctx")
for (model, arm), c in sorted(agg.items()):
    n = c["n"]; print(f"{model:6} {arm:5} {c['ok']:2}/{n:<3} {c['wall']/n:5.0f} {c['turns']/n:6.1f} {c['ph:explore']/n:8.2f} {c['ph:edit']/n:5.2f} {c['ph:edit-retry']/n:6.2f} {c['first_ctx']:2}/{n:<4} {c['ctx']/n:7.2f} {c['bash_after_ctx']/n:14.2f}")
