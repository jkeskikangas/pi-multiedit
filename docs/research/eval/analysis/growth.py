"""What fills the context in real sessions, and what it costs (Opus 5.5 pricing)."""
import json, glob, collections, sys
P = {"in": 4, "out": 20, "cread": 0.20, "cw5": 5, "cw1h": 8}
C = collections.Counter(); comp = collections.Counter(); cost = collections.Counter()
for jl in glob.glob(sys.argv[1]):
    pending = {}
    for line in open(jl, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("isSidechain"): continue
        m = e.get("message") or {}
        if e.get("type") == "assistant":
            u = m.get("usage") or {}
            if u:
                cw = u.get("cache_creation_input_tokens", 0); cc = u.get("cache_creation") or {}
                C["out"] += u.get("output_tokens", 0); C["cread"] += u.get("cache_read_input_tokens", 0); C["cwrite"] += cw; C["fresh"] += u.get("input_tokens", 0)
                C["cw1h"] += cc.get("ephemeral_1h_input_tokens", 0); C["cw5"] += cc.get("ephemeral_5m_input_tokens", 0)
            for b in m.get("content") or []:
                if not isinstance(b, dict): continue
                t = b.get("type")
                if t == "thinking": comp["thinking"] += len(b.get("thinking", "") or "")
                elif t == "text": comp["text"] += len(b.get("text", ""))
                elif t == "tool_use":
                    n = b.get("name"); s = len(json.dumps(b.get("input") or {}))
                    comp["args:" + ("edit" if n in ("Edit", "MultiEdit", "Write") else n if n in ("Bash", "Read") else "other")] += s
        elif e.get("type") == "user":
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    c = b.get("content"); comp["results"] += len(c) if isinstance(c, str) else sum(len(x.get("text", "")) for x in c if isinstance(x, dict))
                elif isinstance(b, dict) and b.get("type") == "text": comp["user_text"] += len(b.get("text", ""))
            if isinstance(m.get("content"), str): comp["user_text"] += len(m["content"])
tot = sum(comp.values())
print("context composition by chars (what accumulates in the prefix):")
for k, v in comp.most_common(): print(f"  {k:14} {v/1e6:7.1f}M  {100*v/tot:5.1f}%")
cost = {"cache read": C["cread"]*P["cread"]/1e6, "cache write 1h": C["cw1h"]*P["cw1h"]/1e6, "cache write 5m": C["cw5"]*P["cw5"]/1e6, "cache write (unsplit)": (C["cwrite"]-C["cw1h"]-C["cw5"])*P["cw5"]/1e6, "output": C["out"]*P["out"]/1e6, "fresh": C["fresh"]*P["in"]/1e6}
T = sum(cost.values())
print(f"\ncost at Opus 5.5 list prices: ${T:,.0f} total")
for k, v in cost.items(): print(f"  {k:22} ${v:8,.0f} {100*v/T:5.1f}%")
print("tokens:", dict(C))
