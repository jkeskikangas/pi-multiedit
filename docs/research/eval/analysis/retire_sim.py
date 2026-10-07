"""Simulate retiring old tool results from the prefix, on real Claude Code sessions. Cost at Opus 5.5 (5-min cache)."""
import json, glob, re, sys, collections
CPT = 3.5  # chars per token (code-heavy)
CREAD, CWRITE, OUT = 0.20, 5.0, 20.0  # $/M
def text_of(c): return c if isinstance(c, str) else "".join(x.get("text", "") for x in c if isinstance(x, dict))
def simulate(turns, K, N, B, keep_kinds):
    """turns: list of (out_chars, [(kind,key,chars)] results). Retire results older than K turns, except newest N, in batches every B turns."""
    base = policy = 0.0; rewrites = 0.0; prefix_items = []  # (turn, kind, key, chars, alive)
    sys_tok = 25000
    base_prefix = policy_prefix = sys_tok
    last_batch = 0
    for t, (out_chars, results) in enumerate(turns):
        base += base_prefix * CREAD / 1e6; policy += policy_prefix * CREAD / 1e6
        new = out_chars / CPT + sum(c for _, _, c in results) / CPT
        base += new * CWRITE / 1e6; policy += new * CWRITE / 1e6
        base_prefix += new; policy_prefix += new
        for kind, key, c in results: prefix_items.append([t, kind, key, c / CPT, True])
        if t - last_batch >= B:
            last_batch = t
            alive = [it for it in prefix_items if it[4]]
            cand = [it for it in alive[:-N] if t - it[0] > K and it[1] not in keep_kinds]
            if cand:
                freed = sum(it[3] - 20 for it in cand)
                if freed > 20000:  # only when it pays: rewrite everything after the earliest retired item
                    first = cand[0]; after = sum(it[3] for it in prefix_items if it[0] >= first[0]) + 0  # approx: results after that point
                    policy += after * CWRITE / 1e6; rewrites += after
                    for it in cand: it[4] = False
                    policy_prefix -= freed
    return base, policy, rewrites
TOT = collections.Counter(); rows = []
for jl in glob.glob(sys.argv[1]):
    pending = {}; turns = []; cur = None; reread_old = reread_any = 0; last_seen = {}
    for line in open(jl, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("isSidechain"): continue
        m = e.get("message") or {}
        if e.get("type") == "assistant" and (m.get("usage") or {}):
            cur = [0, []]; turns.append(cur)
            for b in m.get("content") or []:
                if not isinstance(b, dict): continue
                if b.get("type") == "text": cur[0] += len(b.get("text", ""))
                if b.get("type") == "tool_use":
                    n = b.get("name"); a = b.get("input") or {}; cur[0] += len(json.dumps(a))
                    key = a.get("file_path") or str(a.get("command", ""))[:120]
                    kind = "edit" if n in ("Edit", "MultiEdit", "Write") else "read" if n == "Read" or re.match(r"^\s*(cat|sed -n|head|tail)\b", str(a.get("command", ""))) else "bash" if n == "Bash" else "other"
                    pending[b["id"]] = (kind, key)
                    if kind == "read":
                        t = len(turns)
                        if key in last_seen:
                            reread_any += 1
                            if t - last_seen[key] > 30: reread_old += 1
                        last_seen[key] = t
        elif e.get("type") == "user" and cur is not None:
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    kind, key = pending.get(b.get("tool_use_id"), ("other", "")); cur[1].append((kind, key, len(text_of(b.get("content") or ""))))
    if len(turns) < 20: continue
    b0, p1, rw = simulate(turns, K=30, N=10, B=25, keep_kinds={"edit"})
    _, p2, _ = simulate(turns, K=60, N=20, B=40, keep_kinds={"edit"})
    rows.append((len(turns), b0, p1, p2, reread_any, reread_old))
    TOT["turns"] += len(turns); TOT["base"] += b0; TOT["p1"] += p1; TOT["p2"] += p2; TOT["reread_any"] += reread_any; TOT["reread_old"] += reread_old; TOT["n"] += 1
print(f"sessions {TOT['n']} (>=20 turns), turns {TOT['turns']}")
print(f"simulated base cost ${TOT['base']:,.0f}; retire K=30/N=10/B=25: ${TOT['p1']:,.0f} ({100*(1-TOT['p1']/TOT['base']):.1f}% saved); K=60/N=20/B=40: ${TOT['p2']:,.0f} ({100*(1-TOT['p2']/TOT['base']):.1f}% saved)")
print(f"natural re-reads of a file: {TOT['reread_any']}, of which after >30 turns: {TOT['reread_old']} (harm proxy: would need a re-read under K=30)")
rows.sort(key=lambda r: -r[0])
print("largest sessions: turns base p1 p2 saved%")
for r in rows[:8]: print(f"  {r[0]:5} ${r[1]:7.0f} ${r[2]:7.0f} ${r[3]:7.0f} {100*(1-r[2]/r[1]):5.1f}%")
