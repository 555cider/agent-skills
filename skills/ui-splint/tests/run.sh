#!/usr/bin/env bash
# Self-contained regression checks for the zero-dependency ui-splint runner.
#
# Run: bash skills/ui-splint/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../scripts/audit-chrome.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ui-splint-tests.XXXXXX")"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_exit() {
  if [ "$EC" = "$2" ]; then
    pass "$1 [exit $2]"
  else
    fail "$1" "expected exit $2, got $EC (output: $(cat "$WORK/out" 2>/dev/null | tr '\n' '|' | head -c 300))"
  fi
}

PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/fixtures" >"$WORK/http.log" 2>&1 &
SERVER_PID=$!
sleep 0.5

cat >"$WORK/missing-route.json" <<'EOF'
{
  "routes": ["/missing.html"],
  "viewports": [{ "name": "mobile", "width": 390, "height": 844, "isMobile": true, "dpr": 3 }],
  "themes": ["dark"],
  "states": ["default"],
  "scrollPositions": ["top"]
}
EOF

set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/missing-route.json" --out-dir "$WORK/audit" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "missing route blocks audit" 1
if python3 - "$WORK/audit/coverage.json" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1]))
cell = data["matrix"][0]
assert cell["status"] == "error", cell
assert "HTTP 404" in cell["error"], cell
PY
then
  pass "coverage records HTTP 404 as unverified"
else
  fail "coverage records HTTP 404 as unverified" "$(cat "$WORK/audit/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 300)"
fi

set +e
python3 - "$HERE" "$RUNNER" "$PORT" "$WORK" >"$WORK/contract.out" 2>"$WORK/contract.err" <<'PY'
import json
import pathlib
import subprocess
import sys

here = pathlib.Path(sys.argv[1])
runner = pathlib.Path(sys.argv[2])
port = sys.argv[3]
work = pathlib.Path(sys.argv[4])
expected = json.loads((here / "expected.json").read_text(encoding="utf-8"))["fixtures"]
base = f"http://127.0.0.1:{port}"
errors = []

for fixture in expected:
    file_name = fixture["file"]
    viewport = fixture["viewport"]
    out_dir = work / ("contract-" + file_name.replace(".", "-"))
    config = {
        "routes": ["/" + file_name],
        "viewports": [{
            "name": "fixture",
            "width": viewport["width"],
            "height": viewport["height"],
            "isMobile": viewport.get("isMobile", True),
            "dpr": viewport.get("dpr", 3),
        }],
        "themes": [fixture.get("theme", "light")],
        "states": ["default"],
        "scrollPositions": ["top", "bottom"],
    }
    cfg_path = work / (file_name + ".json")
    cfg_path.write_text(json.dumps(config), encoding="utf-8")
    result = subprocess.run(
        ["node", str(runner), base, "--config", str(cfg_path), "--out-dir", str(out_dir), "--no-screenshots"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode not in (0, 1):
        errors.append(f"{file_name}: runner exited {result.returncode}\n{result.stderr or result.stdout}")
        continue

    findings_path = out_dir / "findings.json"
    coverage_path = out_dir / "coverage.json"
    if not findings_path.exists() or not coverage_path.exists():
        errors.append(f"{file_name}: missing findings/coverage output")
        continue

    findings = json.loads(findings_path.read_text(encoding="utf-8"))
    coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
    bad_cells = [c for c in coverage.get("matrix", []) if c.get("status") != "checked"]
    if bad_cells:
        errors.append(f"{file_name}: unverified coverage cells {bad_cells!r}")

    if fixture.get("expectZeroFindings") and findings:
        rules = ", ".join(sorted({f.get("rule", "?") for f in findings}))
        errors.append(f"{file_name}: expected zero findings, got {len(findings)} ({rules})")

    for must in fixture.get("mustHit", []):
        rule = must["rule"]
        needle = must.get("matches")
        matched = False
        for finding in findings:
            if finding.get("rule") != rule:
                continue
            blob = json.dumps(finding, ensure_ascii=False)
            if not needle or needle in blob:
                matched = True
                break
        if not matched:
            detail = f" matching {needle!r}" if needle else ""
            rules = ", ".join(sorted({f.get("rule", "?") for f in findings}))
            errors.append(f"{file_name}: missing {rule}{detail}; saw [{rules}]")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
PY
EC=$?
set -e

assert_exit "fixture contract matches expected.json" 0
if [ "$EC" -ne 0 ]; then
  fail "fixture contract details" "$(cat "$WORK/contract.err" 2>/dev/null | tr '\n' '|' | head -c 800)"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
