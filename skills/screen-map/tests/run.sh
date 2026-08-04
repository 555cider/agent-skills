#!/usr/bin/env bash
# Self-contained regression checks for the screen-map skill.
#
# Run: bash skills/screen-map/tests/run.sh
#
# Windows note: never use process substitution (`--config <(printf ...)`). Node on
# Windows resolves /proc/<pid>/fd/N to C:\proc\... and cannot open it, which is how
# the ui-audit suite once lost 24 cases. Write real files instead.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$HERE/../scripts/screen-map.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/screen-map-tests.XXXXXX")"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

run_suite() { # name, command...
  local name="$1"; shift
  if "$@" > "$WORK/$name.log" 2>&1; then
    sed 's/^/    /' "$WORK/$name.log"
    pass "$name"
  else
    sed 's/^/    /' "$WORK/$name.log"
    fail "$name" "see output above"
  fi
}

echo "── pure model ───────────────────────────────────────────"
run_suite unit node "$HERE/unit.mjs"

echo
echo "── safety gate ──────────────────────────────────────────"
printf '%s' '{"baseUrl":"https://example.com"}' > "$WORK/off-limits.json"
node "$CLI" crawl --config "$WORK/off-limits.json" > "$WORK/gate.json" 2> "$WORK/gate.err"
GATE_CODE=$?
if [ "$GATE_CODE" -eq 3 ]; then pass "a host outside allowHosts is refused (exit 3)"
else fail "a host outside allowHosts is refused (exit 3)" "exit $GATE_CODE: $(cat "$WORK/gate.json" "$WORK/gate.err" 2>/dev/null | tr '\n' ' ')"; fi
if grep -q "refusing to crawl" "$WORK/gate.json" 2>/dev/null; then pass "the refusal names the host"
else fail "the refusal names the host" "$(cat "$WORK/gate.json" 2>/dev/null)"; fi

echo
echo "── fixture app ──────────────────────────────────────────"
node "$HERE/fixture-server.mjs" --port-file "$WORK/port" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do [ -s "$WORK/port" ] && break; sleep 0.1; done
if [ ! -s "$WORK/port" ]; then
  fail "fixture server starts" "$(cat "$WORK/server.log" 2>/dev/null)"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
PORT="$(cat "$WORK/port")"
BASE="http://127.0.0.1:$PORT"
pass "fixture server listening on $PORT"

APP="$WORK/app"
mkdir -p "$APP/.screen-map"
cat > "$APP/.screen-map/config.json" <<JSON
{
  "baseUrl": "$BASE",
  "entrypoints": ["/"],
  "budget": { "maxStates": 30, "maxActions": 120, "maxMillis": 180000 }
}
JSON
printf 'fixture app\n' > "$APP/README.md"
git -C "$APP" init -q
git -C "$APP" config user.email tests@example.invalid
git -C "$APP" config user.name "screen-map tests"
git -C "$APP" add -A
git -C "$APP" commit -q -m "fixture app"

echo
echo "── crawl (default: nothing mutating runs) ────────────────"
if node "$CLI" crawl --config "$APP/.screen-map/config.json" > "$WORK/crawl.json" 2> "$WORK/crawl.err"; then
  pass "crawl completes"
else
  fail "crawl completes" "$(cat "$WORK/crawl.json" "$WORK/crawl.err" 2>/dev/null | tr '\n' ' ')"
fi
run_suite assert-crawl node "$HERE/assert-crawl.mjs" --map "$APP/.screen-map/map.json" --base "$BASE" --mode default

echo
echo "── queries ──────────────────────────────────────────────"
run_suite assert-queries node "$HERE/assert-queries.mjs" --app "$APP"

echo
echo "── crawl (--allow-mutating) ─────────────────────────────"
APP2="$WORK/app2"
mkdir -p "$APP2/.screen-map"
cp "$APP/.screen-map/config.json" "$APP2/.screen-map/config.json"
printf 'fixture app\n' > "$APP2/README.md"
git -C "$APP2" init -q
git -C "$APP2" config user.email tests@example.invalid
git -C "$APP2" config user.name "screen-map tests"
git -C "$APP2" add -A
git -C "$APP2" commit -q -m "fixture app"
if node "$CLI" crawl --config "$APP2/.screen-map/config.json" --allow-mutating > "$WORK/crawl2.json" 2> "$WORK/crawl2.err"; then
  pass "crawl with --allow-mutating completes"
else
  fail "crawl with --allow-mutating completes" "$(cat "$WORK/crawl2.json" "$WORK/crawl2.err" 2>/dev/null | tr '\n' ' ')"
fi
run_suite assert-crawl-mutating node "$HERE/assert-crawl.mjs" --map "$APP2/.screen-map/map.json" --base "$BASE" --mode mutating

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
