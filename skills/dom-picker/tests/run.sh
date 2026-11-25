#!/usr/bin/env bash
# Dependency-free regression suite for DOM Picker v2.
# Run from any directory: bash skills/dom-picker/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
DRIVER="$SKILL/scripts/dom-picker.mjs"
LOCATOR="$SKILL/scripts/locate-source.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

# Every Chrome the driver launches gets a temporary profile that must be gone when the
# session ends; on Windows a launcher-only kill left the renderers holding it open.
count_profiles() { find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'dom-picker-v2-*' | wc -l; }
PROFILES_BEFORE="$(count_profiles)"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_status() {
  local expected="$1" label="$2"
  shift 2
  "$@" >"$TMP/out" 2>"$TMP/err"
  local actual=$?
  if [ "$actual" -eq "$expected" ]; then pass "$label"; else fail "$label" "exit $actual; $(head -c 500 "$TMP/out" "$TMP/err")"; fi
}

# Command contracts that fail before any browser is involved.
node "$DRIVER" verify --request="$TMP/missing-request.json" >"$TMP/out" 2>"$TMP/err"
if [ "$?" -eq 2 ] && grep -qF "verify requires --assertions" "$TMP/err"; then pass "verifier requires declared assertions"; else fail "verifier requires declared assertions" "$(cat "$TMP/out" "$TMP/err")"; fi
printf '{"picks":[]}\n' >"$TMP/no-picks.json"
assert_status 2 "locator rejects evidence with no picks (space-separated options)" node "$LOCATOR" --repo "$SKILL" --input "$TMP/no-picks.json"
if grep -qF "does not contain any picks" "$TMP/err"; then pass "locator reads space-separated options"; else fail "locator reads space-separated options" "$(cat "$TMP/err")"; fi

# Durable session and CLI contracts.
assert_status 0 "durable FIFO session ledger" node "$HERE/ledger.mjs"
assert_status 0 "lifecycle CLI JSON contracts" node "$HERE/lifecycle-cli.mjs"
assert_status 0 "locator precision report" node "$HERE/locator-report.mjs"

# Real Chromium integration. Chrome absence is an explicit, successful skip.
node "$HERE/e2e.mjs" >"$TMP/e2e.out" 2>"$TMP/e2e.err"
E2E_STATUS=$?
if [ "$E2E_STATUS" -eq 0 ]; then
  pass "real Chromium trust, reload, locator, and verification e2e"
elif [ "$E2E_STATUS" -eq 77 ]; then
  pass "real Chromium e2e (skipped: Chrome unavailable)"
else
  fail "real Chromium trust, reload, locator, and verification e2e" "$(head -c 1600 "$TMP/e2e.out" "$TMP/e2e.err")"
fi

PROFILES_AFTER=""
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  PROFILES_AFTER="$(count_profiles)"
  [ "$PROFILES_AFTER" = "$PROFILES_BEFORE" ] && break
  sleep 0.2
done
if [ "$PROFILES_AFTER" = "$PROFILES_BEFORE" ]; then
  pass "Chrome temporary profiles are removed"
else
  fail "Chrome temporary profiles are removed" "before=$PROFILES_BEFORE after=$PROFILES_AFTER"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
