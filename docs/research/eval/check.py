"""Checks a finished eval run directory; prints JSON {pass, failures}."""
import json, os, re, subprocess, sys, pathlib
task, d = sys.argv[1], pathlib.Path(sys.argv[2])
fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
r = lambda p: (d / p).read_text() if (d / p).exists() else ""
if task == "t1":
    src = r("src/accounts.ts") + r("src/cases.ts")
    need("repo.find(" not in src, "repo.find( left in src")
    need(src.count("repo.findOrThrow(") == 3, "expected 3 repo.findOrThrow(")
    need("findOrThrow: (table" in r("src/repo.ts") and "find: (table" in r("src/repo.ts"), "src/repo.ts changed")
    try:
        suites = {s["path"]: s["layer"] for s in json.loads(r("test/layers.json"))["suites"]}
        need(suites.get("test/cases.test.ts") == "integration", "cases test not integration")
        need(suites.get("test/accounts-api.test.ts") == "integration", "accounts-api test missing")
        need(suites.get("test/accounts.test.ts") == "unit", "accounts test changed")
    except Exception as e:
        fails.append(f"layers.json invalid: {e}")
    doc = r("docs/api.md")
    acc = doc.split("## Accounts", 1)[-1].split("## Cases", 1)[0]
    need("findOrThrow" in acc and "not" in acc.lower() and "found" in acc.lower(), "Accounts section not rewritten")
    need("Cases are fetched by id." in doc, "Cases section damaged")
elif task == "t2":
    src = r("src/pricing.py") + r("src/cart.py") + r("tests/test_pricing.py")
    need(not re.search(r"(?<![\w.])total\(", src), "old total( call left")
    need(re.search(r"def order_total\(items, tax, discount=0\)", r("src/pricing.py")) is not None, "signature")
    need(len(re.findall(r"(?<!def )order_total\(", src)) >= 4, "callers not all updated")
    out = subprocess.run([sys.executable, "-c",
        "from src.pricing import order_total;from src.cart import Cart;"
        "assert order_total([{'price':10,'qty':2}],0.1,discount=5)==16.5, order_total([{'price':10,'qty':2}],0.1,discount=5);"
        "assert order_total([{'price':10,'qty':2}],0.1)==22.0;c=Cart(0.0);c.add(3,2);assert c.checkout()==6"],
        cwd=d, capture_output=True, text=True)
    need(out.returncode == 0, "behaviour: " + out.stderr.strip().splitlines()[-1] if out.stderr.strip() else "behaviour")
elif task == "t3":
    ts = r("src/flags.ts")
    need("legacy" not in ts.lower(), "legacy block left")
    out = subprocess.run(["node", "--experimental-strip-types", "-e",
        "import('./src/flags.ts').then(m=>{for(const[k,v]of Object.entries(m.flags)){if(v.rollout!==0)throw new Error(k+' rollout '+v.rollout)}"
        "if(!m.isEnabled('alpha'))throw new Error('isEnabled broken');if('legacyEnabled' in m)throw new Error('legacy export')})"],
        cwd=d, capture_output=True, text=True)
    need(out.returncode == 0, "flags.ts: " + (out.stderr.strip().splitlines() or ["?"])[-1][:120])
    rows = [l for l in r("docs/flags.md").splitlines() if l.startswith("|")]
    need(len(rows) == 5 and "rollout" in rows[0], "docs header")
    need(all(re.search(r"\|\s*0\s*\|\s*$", l) for l in rows[2:]), "docs rows lack 0")
    need("legacyEnabled" not in r("docs/flags.md"), "legacy sentence left in docs")
elif task == "t4":
    pairs = [("add(1,2)","3"),("add(add(1,2),add(3,4))","10"),("sum(1,2,3)","6"),("pair(1,2)","{a:1,b:2}"),("pair(3,4).a","3"),
             ("label.length>0","true"),("sum()","0"),("sum(add(1,1),2,add(3,add(4,5)))","16"),("[1,2].map((x)=>add(x,1))","[2,3]")]
    text = "".join(r(f) for f in ("tests/add.test.ts", "tests/pair.test.ts", "tests/sum.test.ts"))
    squashed = re.sub(r"\s+", "", text).replace(",)", ")")
    for a_, e_ in pairs:
        need(f"expect({a_}).toEqual({e_})" in squashed, f"missing expect({a_}).toEqual({e_})")
    need(text.count("assertEqual(") == 2, f"assertEqual( occurrences {text.count('assertEqual(')}, expected 2 (comment + string)")
    need(text.count("assertEqualish(0.1 + 0.2, 0.3)") == 1, "assertEqualish changed")
    need(text.count("import {") == 3 and "assertEqual }" in r("tests/add.test.ts"), "imports changed")
elif task in ("x1", "x2", "x3", "x4"):
    git = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True).stdout
    changed = set(git("status", "--porcelain").replace("?? ", " M ").split()[1::2])
    if task == "x1":
        f = "packages/coding-agent/src/core/tools/edit-diff.ts"
        need("contextLines = 2," in r(f), "contextLines default not 2")
        need(changed == {f}, f"changed files {sorted(changed)}")
        need(git("diff", "--numstat").split()[:2] == ["1", "1"], "more than one line changed")
    elif task == "x2":
        old = git("grep", "-c", "-w", "isToolCallEventType", "--", ".")
        new = git("grep", "-c", "-w", "isToolCallOfType", "--", ".")
        need(old.strip() == "packages/coding-agent/CHANGELOG.md:2", f"old name left: {old.strip()}")
        need(sum(int(l.split(":")[-1]) for l in new.split()) == 20, f"new name count: {new.strip()}")
        need("packages/coding-agent/CHANGELOG.md" not in changed, "CHANGELOG changed")
    elif task == "x3":
        f = "packages/coding-agent/src/core/tools/file-mutation-queue.ts"
        lines = r(f).splitlines()
        i = next((k for k, l in enumerate(lines) if "function getMutationQueueKey" in l), None)
        need(i is not None and lines[i - 1].strip() == "/** Key for the per-file mutation queue: the resolved real path. */", "comment not directly above getMutationQueueKey")
        need(changed == {f}, f"changed files {sorted(changed)}")
    else:
        rows = [l.strip() for l in r("ANSWER.md").splitlines() if l.strip()]
        need(bool(rows) and rows[0].replace(" ", "") == "packages/coding-agent/src/core/tools/truncate.ts:2000", f"definition line: {rows[:1]}")
        want = {"packages/coding-agent/src/core/tools/bash.ts", "packages/coding-agent/src/core/tools/index.ts", "packages/coding-agent/src/core/tools/output-accumulator.ts",
                "packages/coding-agent/src/core/tools/read.ts", "packages/coding-agent/src/index.ts", "packages/coding-agent/src/modes/interactive/components/bash-execution.ts"}
        got = {x.strip("`- ") for x in rows[1:]}
        need(got == want, f"files: missing {sorted(want - got)}, extra {sorted(got - want)}")
        need(changed == {"ANSWER.md"}, f"changed files {sorted(changed)}")
elif task in ("r1", "r2", "r3", "r4"):
    git = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True).stdout
    changed = {l[3:] for l in git("status", "--porcelain").splitlines() if l.strip()}
    targets = set(open(f"{os.path.dirname(os.path.abspath(__file__))}/fixtures/{task}.targets").read().split())
    need(targets <= changed, f"target not changed: {sorted(targets - changed)}; changed {sorted(changed)[:6]}")
elif task in ("b1", "b2"):
    git = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True).stdout
    name = "resolveToCwd" if task == "b1" else "computeEditsDiff"
    def calls(text):
        out = []; i = 0
        while (i := text.find(name + "(", i)) != -1:
            if text[max(0, i - 16):i].rstrip().endswith("function"): i += 1; continue
            j = i + len(name) + 1; depth = 1; arg = ""; args = []
            while j < len(text) and depth:
                ch = text[j]
                if ch in "([{": depth += 1
                elif ch in ")]}": depth -= 1
                if depth == 1 and ch == ",": args.append(arg.strip()); arg = ""
                elif depth: arg += ch
                j += 1
            args.append(arg.strip()); out.append([a for a in args if a]); i = j
        return out
    files = [f for f in git("ls-files", "packages").split() if f.endswith(".ts")]
    missed = 0; total = 0
    for f in files:
        orig = subprocess.run(["git", "show", f"HEAD:{f}"], cwd=d, capture_output=True, text=True).stdout
        if name + "(" not in orig: continue
        before, after_ = calls(orig), calls(r(f))
        total += len(before)
        if task == "b1":
            want = sorted([b[1], b[0]] for b in before if len(b) == 2)
            have = sorted(a for a in after_ if len(a) == 2)
            missed += sum(1 for w in want if w not in have)
        else:
            missed += sum(1 for a in after_ if not (len(a) == 4 and a[3] == "4"))
    need(missed == 0, f"{missed} of {total} call sites not updated")
    defn = r("packages/coding-agent/src/core/tools/path-utils.ts" if task == "b1" else "packages/coding-agent/src/core/tools/edit-diff.ts")
    need((re.search(r"resolveToCwd\(\s*cwd: string,\s*filePath: string\)", defn) if task == "b1" else re.search(r"computeEditsDiff\([^)]*contextLines: number", defn, re.S)) is not None, "definition not changed")
elif task in ("e1", "e2", "e3", "e4"):
    git = lambda *a: subprocess.run(["git", *a], cwd=d, capture_output=True, text=True).stdout
    changed = {l[3:] for l in git("status", "--porcelain").splitlines() if l.strip()}
    nows = lambda t: re.sub(r"\s+", "", t)
    if task == "e1":
        lib = r("services/care/lib/care_web/verified_session.ex")
        test = r("services/care/test/care_web/patient_cases_channel_test.exs")
        code = "\n".join(l for l in lib.splitlines() if not l.strip().startswith("#"))
        need(not re.search(r'def resolve\(%\{\s*"user"\s*=>', code), '"user" clause still present')
        need("strip_jti" not in code and "resolve_subject" not in code, "legacy helpers left")
        need(re.search(r'def resolve\(%\{\s*"user_token"\s*=>', code) and "Jwt.verify" in code and re.search(r"def resolve\(_\w*\),\s*do:\s*nil", code), "token clause or nil fallback damaged")
        need("StagingInternalLogin" not in code, "unused StagingInternalLogin alias left")
        need(not re.search(r'resolve\(%\{\s*"user"\s*=>[^}]*\}\)\.id', test), "test still expects legacy session to resolve")
        need(re.search(r'revoke\(', test.split("verified session")[-1] if "verified session" in test else test) and len(re.findall(r'resolve\(%\{\s*"user"\s*=>[^}]*\}\)\s*==\s*nil', test)) >= 2
             and re.search(r'resolve\(%\{\s*"user"\s*=>[^}]*<>\s*":"\s*<>', test), "test lacks revoked-token / legacy jti:subject and bare-subject nil assertions")
    elif task == "e2":
        lib = r("services/care/lib/care/accounts/company_domain.ex")
        fp = lib.split("field_policies do", 1)[1] if "field_policies do" in lib else ""
        need(bool(fp), "no field_policies block")
        need(re.search(r"field_policy\s+:verification_token\s+do\s+authorize_if\s+\{\s*Care\.Accounts\.Checks\.ActiveCompanyMembership,\s*role:\s*:admin\s*\}", fp)
             or re.search(r"field_policy\s+\[?:verification_token\]?.*?ActiveCompanyMembership,\s*role:\s*:admin", fp, re.S), "verification_token field policy missing")
        need(re.search(r"field_policy_bypass\b.*?platform_admin\?", fp, re.S) and re.search(r"field_policy\s+:\*\s+do\s+authorize_if\s+always\(\)", fp), "bypass or catch-all field policy missing")
        attr = lib.split("attribute :verification_token", 1)[-1].split("\n    end", 1)[0] if "attribute :verification_token" in lib else ""
        need("public? true" in attr and "public? false" not in attr, "verification_token not public? true")
        doc = r("services/care/lib/care/company_domains.ex")
        need(re.search(r"(token|challenge)[^.]*admin", doc.split('"""')[1] if doc.count('"""') >= 2 else "", re.I | re.S), "CompanyDomains moduledoc not updated")
        test = r("services/care/test/care/accounts/company_member_read_policy_test.exs")
        # relaxed from the reference's exact shape (owner: owner, build_admin()): the prompt only asks for a member -> ForbiddenField test with owner exposed
        need("ForbiddenField" in test and "verification_token" in test and re.search(r"\bowner\b", test), "member/admin token test missing")
    elif task == "e3":
        cfg = r("services/care/lib/care/customer_service/notification_config.ex")
        snd = r("services/care/lib/care/customer_service/slack_sender.ex")
        need(re.search(r"defstruct\s*\[[^\]]*:environment_label", cfg), "environment_label not in struct")
        need(re.search(r":deployment_env", cfg) and re.search(r"Application\.(get_env|fetch_env)\(:care,\s*:app_env", cfg), "load/0 does not prefer :deployment_env")
        need(all(t in cfg for t in ('"prerelease"', '"staging"', '"production"', '"development"')) and "raw[:environment_label]" not in cfg, "environment normalization missing")
        need("<!channel>" in snd and "environment_label" in snd and "Avaa asiakaspalvelun työjono>" in snd, "Slack text lacks label/mention/Finnish link text")
        stest = r("services/care/test/care/customer_service/slack_sender_test.exs")
        rtest = r("services/care/test/care/customer_service/notification_config_rules_test.exs")
        need("[prerelease] <!channel>" in stest or ("<!channel>" in stest and "deployment_env" in stest), "sender test lacks label/mention payload")
        need("environment_label" in rtest and re.search(r'"unknown', rtest), "rules test lacks label normalization / unknown rejection")
    else:
        sch = r("packages/core/src/schemas/cases.ts")
        rec = sch.split("caseRecordSchema", 1)[-1]
        # relaxed: the enum may be inline or a named schema defined elsewhere in the file (models extract it)
        enum_inline = re.search(r'doctor_presence:\s*z\.enum\(\[\s*"online",\s*"away",\s*"offline"\s*\]\)', rec)
        enum_named = re.search(r'doctor_presence:\s*(\w+)', rec) and re.search(r'\b' + (re.search(r'doctor_presence:\s*(\w+)', rec).group(1)) + r'\b\s*=\s*z\.enum\(\[\s*"online",\s*"away",\s*"offline"\s*\]\)', sch)
        need((enum_inline or enum_named) and re.search(r'doctor_presence:[^\n]*(nullable|nullish)', rec)
             and re.search(r'doctor_presence:[^\n]*(optional|nullish)', rec), "doctor_presence schema missing or not optional+nullable")
        need(re.search(r'doctor_specialty:[^\n]*(nullable|nullish)', rec) and re.search(r'doctor_specialty:[^\n]*(optional|nullish)', rec), "doctor_specialty schema missing or not optional+nullable")
        auth = r("packages/api-mock/src/caseAuthority.ts")
        need(re.search(r'doctor_presence:\s*"online"', auth) and re.search(r'doctor_specialty:\s*"general_practitioner"', auth), "mock doctor-chat aggregate not populated")
        hz = r("packages/api-mock/src/horizonScenarios.ts")
        need(re.search(r"doctor_presence:\s*null", hz) and re.search(r"doctor_specialty:\s*null", hz), "horizon scenarios do not clear fields")
        t = r("packages/api-mock/src/cases.test.ts")
        need("doctor_presence" in t and "doctor_specialty" in t and re.search(r'toBe\("general_practitioner"\)|general_practitioner', t), "cases test does not handle provisional keys")
        md = r("docs/rest-api-state.md")
        need(re.search(r"^\|[^\n]*doctor_presence[^\n]*Mock only", md, re.M) and re.search(r"^\|[^\n]*doctor_specialty[^\n]*Mock only", md, re.M), "docs rows missing")
print(json.dumps({"pass": not fails, "failures": fails}))
