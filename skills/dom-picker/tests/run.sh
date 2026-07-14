#!/usr/bin/env bash
# Self-contained, dependency-free checks for the dom-picker skill.
#
# These are static checks (syntax, usage, schema validity, eval shape, and
# regression guards for reload safety, durable queue draining, and apply policy).
# The picker's runtime behavior is verified in a real browser during development.
#
# Run: bash skills/dom-picker/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SKILL/../.." && pwd)"
PICKER="$SKILL/assets/element-picker.js"
CDP="$SKILL/scripts/cdp.mjs"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_ok() { if [ "$?" -eq 0 ]; then pass "$1"; else fail "$1" "$2"; fi; }
assert_contains() {
  if grep -qF -- "$2" "$3"; then
    pass "$1"
  else
    fail "$1" "missing [$2] in ${3#$ROOT/}"
  fi
}

# --- syntax ---------------------------------------------------------------
node --check "$PICKER" 2>"$HERE/.err"; assert_ok "element-picker.js parses" "$(cat "$HERE/.err")"
node --check "$CDP" 2>"$HERE/.err"; assert_ok "cdp.mjs parses" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

node "$HERE/e2e.mjs" >"$HERE/.out" 2>"$HERE/.err"
E2E_EC=$?
if [ "$E2E_EC" -eq 0 ]; then
  pass "real-browser picker lifecycle e2e"
elif [ "$E2E_EC" -eq 77 ]; then
  pass "real-browser picker lifecycle e2e (skipped: Chrome unavailable)"
else
  fail "real-browser picker lifecycle e2e" "$(cat "$HERE/.out" "$HERE/.err" | head -c 500)"
fi
rm -f "$HERE/.out" "$HERE/.err"

# --- cdp usage ------------------------------------------------------------
USAGE="$(node "$CDP" 2>&1)"
case "$USAGE" in
  *"usage: node cdp.mjs"*) pass "cdp.mjs prints usage with no command" ;;
  *) fail "cdp.mjs prints usage with no command" "got: $USAGE" ;;
esac
case "$USAGE" in
  *"serve"*) pass "cdp.mjs usage documents serve" ;;
  *) fail "cdp.mjs usage documents serve" "missing serve in: $USAGE" ;;
esac
case "$USAGE" in
  *"--timeout"*) pass "cdp.mjs usage documents wait --timeout" ;;
  *) fail "cdp.mjs usage documents wait --timeout" "missing --timeout in: $USAGE" ;;
esac
case "$USAGE" in
  *"inject"*) pass "cdp.mjs usage documents inject" ;;
  *) fail "cdp.mjs usage documents inject" "missing inject in: $USAGE" ;;
esac

node "$CDP" read --port=0 >"$HERE/.out" 2>"$HERE/.err"
if [ "$?" -eq 2 ] && grep -qF "invalid --port" "$HERE/.err"; then
  pass "cdp rejects an out-of-range port before connecting"
else
  fail "cdp rejects an out-of-range port before connecting" "$(cat "$HERE/.out" "$HERE/.err")"
fi
node "$CDP" wait --timeout=-1 >"$HERE/.out" 2>"$HERE/.err"
if [ "$?" -eq 2 ] && grep -qF "invalid --timeout" "$HERE/.err"; then
  pass "cdp rejects a negative timeout before connecting"
else
  fail "cdp rejects a negative timeout before connecting" "$(cat "$HERE/.out" "$HERE/.err")"
fi
rm -f "$HERE/.out" "$HERE/.err"

# --- picker/driver regression guards --------------------------------------
assert_contains "picker persists state under a namespaced sessionStorage key" "__s2p_state_v1" "$PICKER"
assert_contains "picker defines saveState/loadState" "function saveState" "$PICKER"
assert_contains "picker restores state on install" "function restoreState" "$PICKER"
assert_contains "picker restores only uniquely matched selectors" "matches.length === 1" "$PICKER"
assert_contains "picker escapes data-testid attribute values" "attrEscape" "$PICKER"
assert_contains "picker verifies selector uniqueness" "function isUnique" "$PICKER"
assert_contains "picker exposes ariaLabel in payload" "ariaLabel:" "$PICKER"
assert_contains "picker has durable request queue" "queue: []" "$PICKER"
assert_contains "picker enqueues requests" "api.queue.push" "$PICKER"
assert_contains "picker keeps latest request alias" "back-compat: latest enqueued request" "$PICKER"
assert_contains "picker exposes atomic public queue drain" "drainQueue: drainQueue" "$PICKER"
assert_contains "picker teardown clears persisted state" "sessionStorage.removeItem(STATE_KEY)" "$PICKER"
assert_contains "picker documents Alt+Shift+S hotkey" "Alt+Shift+S" "$PICKER"
assert_contains "cdp connect exposes close() for socket lifecycle" "const close = ()" "$CDP"
assert_contains "cdp rejects pending requests on disconnect" "rejectPending(error)" "$CDP"
assert_contains "cdp bounds command waits" "CDP command timed out" "$CDP"
if grep -Fq "setInterval(" "$CDP"; then
  fail "cdp polling is serialized" "setInterval can overlap async CDP operations"
else
  pass "cdp polling is serialized"
fi
assert_contains "cdp has serve command" 'case "serve":' "$CDP"
assert_contains "cdp prints request batches" "REQUEST " "$CDP"
assert_contains "cdp emits requests field" "requests:" "$CDP"
assert_contains "cdp prefers the picker public drain API" "typeof s.drainQueue==='function'" "$CDP"
if grep -Fq "window.__s2p.queue=[]" "$CDP" || grep -Fq "s.queue=[]" "$CDP"; then
  pass "cdp atomically clears the in-page queue"
else
  fail "cdp atomically clears the in-page queue" "missing queue clear in ${CDP#$ROOT/}"
fi

# --- schema validity ------------------------------------------------------
for schema in input output; do
  python3 -c "import json,sys; json.load(open('$SKILL/references/$schema.schema.json',encoding='utf-8'))" 2>"$HERE/.err"
  assert_ok "$schema.schema.json is valid JSON" "$(cat "$HERE/.err")"
done

python3 - "$SKILL/references/input.schema.json" "$SKILL/references/output.schema.json" <<'PY' 2>"$HERE/.err"
import json
import sys

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        json.load(handle, object_pairs_hook=reject_duplicates)
PY
assert_ok "schemas contain no duplicate JSON keys" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

python3 - "$SKILL" <<'PY' 2>"$HERE/.err"
import json
import sys
from pathlib import Path

skill = Path(sys.argv[1])
inp = json.loads((skill / "references/input.schema.json").read_text())
assert "screenshot" not in inp["required"], "screenshot should be optional"
assert {"instruction", "page", "element", "candidateFiles"} <= set(inp["required"])
assert "requests" in inp.get("properties", {}), "input schema must expose optional requests batch"

out = json.loads((skill / "references/output.schema.json").read_text())
assert "applyDecision" in out.get("required", []), "output schema must require applyDecision"
decision_props = out["properties"]["applyDecision"]["properties"]
assert "authorizedBy" in decision_props, "applyDecision must expose authorizedBy"
assert "applied" in decision_props, "applyDecision must expose applied"
for value in ("trusted-chat", "confirmed-browser-request", "none"):
    assert value in decision_props["authorizedBy"].get("enum", []), f"authorizedBy enum missing {value}"
batch = out.get("definitions", {}).get("batch", {})
assert batch.get("type") == "array" and batch.get("items", {}).get("$ref") == "#", \
    "output schema definitions.batch must be an array of the result object"
PY
assert_ok "schemas enforce optional screenshot, batch, and applyDecision" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

# --- docs/policy guards ---------------------------------------------------
assert_contains "SKILL documents serve" "serve" "$SKILL/SKILL.md"
assert_contains "SKILL documents drainQueue browser API" "window.__s2p.drainQueue()" "$SKILL/SKILL.md"
assert_contains "SKILL documents Alt+Shift+S" "Alt+Shift+S" "$SKILL/SKILL.md"
if grep -Eiq "re-?arm|re-?launch .*serve" "$SKILL/SKILL.md"; then
  pass "SKILL documents re-arming serve after a batch"
else
  fail "SKILL documents re-arming serve after a batch" "missing re-arm/re-launch guidance"
fi
if grep -Eiq "once at the (end|session)|tear down once|torn down once" "$SKILL/SKILL.md"; then
  pass "SKILL documents teardown once at session end"
else
  fail "SKILL documents teardown once at session end" "missing teardown guidance"
fi
assert_contains "SKILL documents second approval policy" "second approval" "$SKILL/SKILL.md"
assert_contains "safety policy documents trusted chat request" "trusted chat request" "$SKILL/references/safety-policy.md"
assert_contains "safety policy documents confirmed browser request" "confirmed browser request" "$SKILL/references/safety-policy.md"
assert_contains "patch policy documents second approval" "second approval" "$SKILL/references/patch-policy.md"

# --- eval assets ----------------------------------------------------------
python3 - "$SKILL/evals/behavior-evals.json" "$SKILL/evals/trigger-evals.json" <<'PY' 2>"$HERE/.err"
import json
import sys

behavior = json.load(open(sys.argv[1], encoding="utf-8"))
trigger = json.load(open(sys.argv[2], encoding="utf-8"))
assert behavior["skill_name"] == "dom-picker"
assert len(behavior["evals"]) >= 4
assert all({"id", "prompt", "expected_output"} <= set(item) for item in behavior["evals"])
ids = {case["id"] for case in behavior["evals"]}
for case_id in (
    "trusted-chat-apply-without-second-approval",
    "confirmed-browser-request-apply-without-second-approval",
    "diff-only-request-does-not-apply",
    "unsafe-auto-apply-blocked",
):
    assert case_id in ids, f"behavior eval missing {case_id}"
assert isinstance(trigger, list) and len(trigger) >= 8
assert sum(1 for item in trigger if item["should_trigger"]) >= 4
assert sum(1 for item in trigger if not item["should_trigger"]) >= 4
assert all({"query", "should_trigger"} <= set(item) for item in trigger)
PY
assert_ok "eval assets have expected schema and policy cases" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
