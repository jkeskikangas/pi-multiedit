"""Mine Claude Code session transcripts: edit behaviour in long real sessions. usage: mine_cc.py <glob of jsonl>"""
import json, glob, re, sys, collections, os
SHELLEDIT = re.compile(r"\b(sed\s+-i|python3?\s+-c|python3?\s+<<|perl\s+-p?i|cat\s*>|cat\s*<<|tee\s|>\s*[\w./-]+\.(ex|exs|ts|md|json|yml|yaml|js|py))")
VERIFY = re.compile(r"\b(git diff|git status|mix test|mix compile|mix format|mix credo|npm test|pnpm test|pnpm -|npx|node |pytest|tsc|vitest)")
CAT = re.compile(r"^\s*(cat|sed -n|head|tail)\s")
def text_of(content):
    if isinstance(content, str): return content
    return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
def errclass(name, txt):
    t = txt[:300]
    if "has not been read" in t: return "unread"
    if "not found" in t or "does not exist" in t and "file" in t.lower(): return "miss"
    if "Found" in t and "matches" in t: return "multi"
    if "modified since read" in t or "has been modified" in t: return "stale"
    if "same" in t and "old_string" in t: return "same"
    if "InputValidationError" in t or "required" in t: return "schema"
    return "other:" + re.sub(r"\s+", " ", t[:50])
agg = collections.defaultdict(collections.Counter)
sessions = []
for jl in sorted(glob.glob(sys.argv[1])):
    c = collections.Counter(); pending = {}; read_files = set(); edited = set(); last_edit = None; last_tool = None
    seq = []  # (tool, ok)
    for line in open(jl, errors="replace"):
        try: e = json.loads(line)
        except: continue
        if e.get("isSidechain"): continue
        m = e.get("message") or {}
        if e.get("type") == "assistant":
            u = m.get("usage") or {}
            if u: c["turns"] += 1; c["out"] += u.get("output_tokens", 0); c["cread"] += u.get("cache_read_input_tokens", 0); c["cwrite"] += u.get("cache_creation_input_tokens", 0); c["fresh"] += u.get("input_tokens", 0)
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use": continue
                n = b.get("name"); a = b.get("input") or {}; pending[b.get("id")] = (n, a); c["calls"] += 1; c["tool:" + str(n)] += 1
                if n in ("Edit", "MultiEdit", "Write"):
                    p = a.get("file_path"); c["edit_calls"] += 1
                    eds = a.get("edits") or [a]
                    c["edits_total"] += len(eds)
                    for ed in eds:
                        if isinstance(ed.get("old_string"), str): c["old_chars"] += len(ed["old_string"]); c["old_lines"] += ed["old_string"].count("\n") + 1
                        if isinstance(ed.get("new_string"), str): c["new_chars"] += len(ed["new_string"])
                    if n == "Write": c["write_chars"] += len(str(a.get("content", ""))); c["write_overwrite"] += p in read_files
                    if last_edit and last_edit[0] == p: c["consecutive_edit_same_file"] += 1
                    if last_tool in ("Edit", "MultiEdit", "Write"): c["consecutive_edit_calls"] += 1
                    last_edit = (p, b.get("id")); edited.add(p)
                elif n == "Read":
                    p = a.get("file_path"); c["read_after_edit_same"] += p in edited and last_tool in ("Edit", "MultiEdit", "Write")
                    c["reread"] += p in read_files; read_files.add(p)
                    if a.get("offset") or a.get("limit"): c["read_range"] += 1
                    else: c["read_whole"] += 1
                elif n == "Bash":
                    cmd = str(a.get("command", ""))
                    if SHELLEDIT.search(cmd): c["bash_shelledit"] += 1
                    if VERIFY.search(cmd): c["bash_verify"] += 1
                    if CAT.search(cmd): c["bash_cat"] += 1
                    if "git diff" in cmd and last_tool in ("Edit", "MultiEdit", "Write"): c["gitdiff_after_edit"] += 1
                    if re.search(r"\b(rg|grep)\b", cmd): c["bash_search"] += 1
                last_tool = n
        elif e.get("type") == "user":
            for b in m.get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_result": continue
                n, a = pending.get(b.get("tool_use_id"), (None, {})); txt = text_of(b.get("content") or "")
                c["result_chars"] += len(txt); c["rc:" + str(n)] += len(txt)
                err = bool(b.get("is_error"))
                if n in ("Edit", "MultiEdit", "Write"):
                    if err: c["edit_err"] += 1; c["ee:" + errclass(n, txt)] += 1
                    else: c["edit_ok"] += 1
                elif err: c["err:" + str(n)] += 1
    if c["turns"] < 5: continue
    sessions.append((os.path.basename(jl), c))
    agg["all"].update(c); agg["all"]["sessions"] += 1
c = agg["all"]; n = c["sessions"]
print(f"sessions {n}, turns {c['turns']}, calls {c['calls']}")
tools = sorted(((k[5:], v) for k, v in c.items() if k.startswith("tool:")), key=lambda kv: -kv[1])
print("tools:", tools[:14])
print("edit calls", c["edit_calls"], "ok", c["edit_ok"], "err", c["edit_err"], f"({100*c['edit_err']/max(c['edit_calls'],1):.1f}%)")
print("edit errors:", sorted(((k[3:], v) for k, v in c.items() if k.startswith("ee:")), key=lambda kv: -kv[1])[:12])
print("other errors:", sorted(((k[4:], v) for k, v in c.items() if k.startswith("err:")), key=lambda kv: -kv[1])[:8])
print("edits_total", c["edits_total"], "edits/edit-call", round(c["edits_total"]/max(c["edit_calls"],1), 2))
print("consecutive edit calls", c["consecutive_edit_calls"], "same file", c["consecutive_edit_same_file"])
print("old chars", c["old_chars"], "new chars", c["new_chars"], "old lines/edit", round(c["old_lines"]/max(c["edits_total"],1), 1), "write chars", c["write_chars"], "write overwrites read file", c["write_overwrite"])
print("reads whole", c["read_whole"], "range", c["read_range"], "reread", c["reread"], "read-after-edit same file", c["read_after_edit_same"])
print("bash shelledit", c["bash_shelledit"], "verify", c["bash_verify"], "gitdiff after edit", c["gitdiff_after_edit"], "cat", c["bash_cat"], "search", c["bash_search"])
print("tokens: out", c["out"], "cread", c["cread"], "cwrite", c["cwrite"], "fresh", c["fresh"])
rc = sorted(((k[3:], v) for k, v in c.items() if k.startswith("rc:")), key=lambda kv: -kv[1])
tot = sum(v for _, v in rc) or 1
print("result chars share:", [(k, f"{100*v/tot:.0f}%") for k, v in rc[:10]])
print("\nper-session (top by edit errors):")
for name, s in sorted(sessions, key=lambda x: -x[1]["edit_err"])[:8]:
    print(f"  {name[:12]} turns {s['turns']:4} edits {s['edit_calls']:4} err {s['edit_err']:3} shelledit {s['bash_shelledit']:2} verify {s['bash_verify']:3}")
