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

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
