#!/usr/bin/env bash
# Packaging checks only. Behavioral quality is evaluated with evals, not exact prose.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
"$PY" - "$HERE/.." <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
text = (root / "SKILL.md").read_text(encoding="utf-8")
assert text.startswith("---\n"), "missing frontmatter"
assert "name: step-back" in text.split("---", 2)[1], "wrong skill name"
for name in ("trigger-evals.json", "behavior-evals.json"):
    data = json.loads((root / "evals" / name).read_text(encoding="utf-8"))
    assert data, f"empty eval asset: {name}"
print("PASS step-back packaging; model behavior not evaluated by this check")
PY
