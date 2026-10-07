"""Chained task l1 = b1 + b2 + x2 + x3 (x3 without its changed-files constraint)."""
import json, subprocess, sys, pathlib
d = pathlib.Path(sys.argv[2]); here = pathlib.Path(__file__).parent
fails = []
for t in ("b1", "b2", "x2"):
    res = json.loads(subprocess.run([sys.executable, str(here / "check.py"), t, str(d)], capture_output=True, text=True).stdout or '{"pass":false,"failures":["checker crashed"]}')
    fails += [f"{t}: {f}" for f in res["failures"]]
f = d / "packages/coding-agent/src/core/tools/file-mutation-queue.ts"
lines = f.read_text().splitlines() if f.exists() else []
i = next((k for k, l in enumerate(lines) if "function getMutationQueueKey" in l), None)
if not (i is not None and lines[i - 1].strip() == "/** Key for the per-file mutation queue: the resolved real path. */"): fails.append("x3: comment not directly above getMutationQueueKey")
print(json.dumps({"pass": not fails, "failures": fails, "steps_ok": 4 - len({x.split(":")[0] for x in fails})}))
