#!/usr/bin/env bash
# Dependency-free regression suite for DOM Picker v2.
# Run from any directory: bash skills/dom-picker/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SKILL/../.." && pwd)"
PICKER="$SKILL/assets/picker-runtime.js"
DRIVER="$SKILL/scripts/dom-picker.mjs"
LOCATOR="$SKILL/scripts/locate-source.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT

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

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file"; then pass "$label"; else fail "$label" "missing [$needle] in ${file#$ROOT/}"; fi
}

assert_not_contains() {
  local label="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file"; then fail "$label" "found stale [$needle] in ${file#$ROOT/}"; else pass "$label"; fi
}

# Syntax and command contracts.
assert_status 0 "picker runtime parses" node --check "$PICKER"
assert_status 0 "Chromium driver parses" node --check "$DRIVER"
assert_status 0 "source locator parses" node --check "$LOCATOR"
assert_status 0 "driver help succeeds" node "$DRIVER" help
if grep -qF "start <url>" "$TMP/out" && grep -qF "verify --request" "$TMP/out"; then
  pass "driver help documents continuous and verification paths"
else
  fail "driver help documents continuous and verification paths" "$(cat "$TMP/out")"
fi
assert_status 2 "driver rejects port zero for attach commands" node "$DRIVER" targets --port=0
if grep -qF 'invalid port "0"' "$TMP/err"; then pass "invalid-port diagnostic is actionable"; else fail "invalid-port diagnostic is actionable" "$(cat "$TMP/out" "$TMP/err")"; fi
assert_status 2 "driver rejects unknown commands" node "$DRIVER" legacy-serve
assert_status 2 "verifier requires declared assertions" node "$DRIVER" verify --request="$TMP/missing-request.json"
if grep -qF "verify requires --assertions" "$TMP/err"; then pass "missing-assertion diagnostic is actionable"; else fail "missing-assertion diagnostic is actionable" "$(cat "$TMP/out" "$TMP/err")"; fi
printf '{"picks":[]}\n' >"$TMP/no-picks.json"
assert_status 2 "locator rejects evidence with no picks" node "$LOCATOR" --repo="$ROOT" --input="$TMP/no-picks.json"

# Runtime and trust-boundary regression guards.
assert_contains "runtime exposes protocol v2" "var VERSION = 2" "$PICKER"
assert_contains "runtime defaults to closed Shadow DOM" 'var shadowMode = config.shadowMode === "open" || config.shadowMode === "light" ? config.shadowMode : "closed"' "$PICKER"
assert_contains "runtime requires trusted pointer input" "!event.isTrusted" "$PICKER"
assert_contains "runtime pins the allowed origin" "location.origin !== ALLOWED_ORIGIN" "$PICKER"
assert_contains "runtime records locator ladders" "function buildLocators" "$PICKER"
assert_contains "runtime captures pseudo styles" "pseudoStyles" "$PICKER"
assert_contains "runtime captures overflow metrics" "horizontalOverflow" "$PICKER"
assert_contains "runtime self-heals a removed host" "if (!host.isConnected) mount()" "$PICKER"
assert_contains "runtime exposes targeted UI audit evidence" "textareaLabelled" "$PICKER"
assert_contains "driver names its isolated world" 'const WORLD_NAME = "dom-picker-v2"' "$DRIVER"
assert_contains "driver binds only the named execution context" "executionContextName: WORLD_NAME" "$DRIVER"
assert_contains "driver injects into the named world" "worldName: WORLD_NAME" "$DRIVER"
assert_contains "driver uses a random session binding" "randomUUID()" "$DRIVER"
assert_contains "driver persists requests atomically" "function atomicJson" "$DRIVER"
assert_contains "driver fails closed on target count" "if (matches.length !== 1)" "$DRIVER"
assert_contains "driver verifies by reacquiring picks" "._host.reacquire" "$DRIVER"
assert_contains "locator uses fixed-string ripgrep arguments" '["-l", "-F", "--no-messages", "--", query, repoRoot]' "$LOCATOR"
assert_contains "locator enforces the high score" "top.score >= 0.82" "$LOCATOR"
assert_contains "locator enforces the runner-up margin" "margin >= 0.12" "$LOCATOR"

for file in "$SKILL/SKILL.md" "$SKILL/README.md" "$SKILL/references/protocol.md" "$SKILL/references/safety-policy.md"; do
  assert_not_contains "v2 docs omit the legacy main-world API in ${file#$SKILL/}" "window.__s2p" "$file"
  assert_not_contains "v2 docs omit the legacy driver in ${file#$SKILL/}" "scripts/cdp.mjs" "$file"
done

# JSON contracts: valid, duplicate-free, and semantically pinned.
python3 - "$SKILL/references/protocol.schema.json" "$SKILL/references/fix-result.schema.json" "$SKILL/evals/behavior-evals.json" "$SKILL/evals/trigger-evals.json" <<'PY' >"$TMP/out" 2>"$TMP/err"
import json
import sys

def no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"duplicate JSON key: {key}")
        out[key] = value
    return out

values = []
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        values.append(json.load(handle, object_pairs_hook=no_duplicates))

protocol, result, behavior, triggers = values
assert protocol["properties"]["protocolVersion"]["const"] == 2
events = set(protocol["properties"]["event"]["enum"])
assert {"ready", "pick", "request", "verification", "rejected", "stopped"} <= events
provenance = protocol["definitions"]["requestPayload"]["properties"]["provenance"]
assert {"channel", "trustedUserEvent"} <= set(provenance["required"])
assert set(result["properties"]["status"]["enum"]) == {"applied_verified", "no_change", "review_required", "blocked"}
assert set(result["properties"]["authorization"]["properties"]["channel"]["enum"]) == {"trusted-chat", "isolated-picker", "none"}
assert behavior["skill_name"] == "dom-picker" and len(behavior["evals"]) >= 8
ids = {item["id"] for item in behavior["evals"]}
assert {"isolated-picker-applies-and-verifies", "main-world-forgery-rejected", "verification-failure-is-not-completion", "cross-origin-navigation-pauses-authority"} <= ids
assert len(triggers) >= 20
assert sum(item["should_trigger"] for item in triggers) >= 10
assert sum(not item["should_trigger"] for item in triggers) >= 10
PY
if [ "$?" -eq 0 ]; then pass "schemas and evals enforce the v2 contracts"; else fail "schemas and evals enforce the v2 contracts" "$(cat "$TMP/err")"; fi

# Documentation integrity.
for reference in protocol source-location verification safety-policy examples; do
  if [ -s "$SKILL/references/$reference.md" ]; then pass "reference exists: $reference.md"; else fail "reference exists: $reference.md" "missing or empty"; fi
done
assert_contains "SKILL requires target reacquisition" "targetReacquired: true" "$SKILL/SKILL.md"
assert_contains "SKILL trusts only persisted isolated requests" "atomically persisted and acknowledged" "$SKILL/SKILL.md"
assert_contains "safety policy rejects main-world imitations" "main-world imitation" "$SKILL/references/safety-policy.md"
assert_contains "verification policy refuses apply-only completion" "Never report completion" "$SKILL/references/verification.md"

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

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
