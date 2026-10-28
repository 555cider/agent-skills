#!/usr/bin/env bash
# Packaging checks only. Behavioral quality is evaluated with evals, not exact prose.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# A bare `command -v` is not enough: on Windows `python3` can be the Microsoft Store stub, which
# exists on PATH and fails when run. Same check as
# skills/worktree-cycle/scripts/start-worktree.sh.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
[ -n "$PY" ] || { echo "FAIL  Python 3.10+ not found (tried python3, python)" >&2; exit 1; }
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
