import json, glob, re, sys, collections
EDITS = ("Edit", "MultiEdit", "Write")
trans = collections.Counter(); tools = collections.Counter(); fmt_after_edit = 0; fmt_total = 0; fmt_err = 0
sd = collections.Counter(); samples = collections.defaultdict(list)
def cls(n, a):
    if n in EDITS: return "edit"
    if n == "Bash":
        c = str(a.get("command", ""))
        if re.search(r"\bmix format\b|prettier|eslint --fix|biome format", c): return "bash:format"
        if re.search(r"\bmix (compile|credo|dialyzer|test|check)\b|pnpm (test|lint|typecheck)|vitest|tsc\b", c): return "bash:verify"
        if re.search(r"\bgit diff\b|\bgit status\b", c): return "bash:gitdiff"
        if re.search(r"\b(rg|grep)\b", c): return "bash:search"
        if re.search(r"^\s*(cat|sed -n|head|tail)\b", c): return "bash:read"
        if re.search(r"\bsd\s|\bast-grep\b|\bsg\s", c): return "bash:bulk"
        return "bash:other"
    return n
for jl in glob.glob(sys.argv[1]):
    pending = {}; prev = None
    for line in open(jl, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("isSidechain"): continue
        m = e.get("message") or {}
        if e.get("type") == "assistant":
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use": continue
                n, a = b.get("name"), b.get("input") or {}; k = cls(n, a); pending[b["id"]] = k
                if prev == "edit": trans[k] += 1
                if k == "bash:format": fmt_total += 1
                if k == "bash:bulk":
                    c = str(a.get("command", "")); kind = "sd" if re.search(r"\bsd\s", c) else "ast-grep"; sd[kind] += 1
                    if len(samples[kind]) < 5: samples[kind].append(c[:200].replace("\n", " "))
                prev = k
        elif e.get("type") == "user":
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_result" and pending.get(b.get("tool_use_id")) == "bash:format":
                    c = b.get("content"); t = c if isinstance(c, str) else "".join(x.get("text", "") for x in c if isinstance(x, dict))
                    if b.get("is_error") or "reformatted" in t or "not formatted" in t: fmt_err += 1
tot = sum(trans.values())
print("what follows an edit call (n=%d):" % tot)
for k, v in trans.most_common(): print(f"  {k:14} {v:5} {100*v/tot:5.1f}%")
print(f"\nformat calls total {fmt_total}, of which errors/reformat-needed {fmt_err}")
print("bulk tools:", dict(sd)); [print("  ", k, s) for k, v in samples.items() for s in v]
