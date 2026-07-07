#!/usr/bin/env bash
# Self-contained, dependency-free checks for the dom-picker skill.
#
# These are STATIC checks (syntax, usage, schema validity, eval shape, and
# regression guards for the reload-safety invariants). The picker's runtime
# behavior — selector uniqueness, dedup, and sessionStorage restore across a
# hard reload — is verified in a real browser during development; see SKILL.md
# "Reload semantics". Keeping this suite browser-free keeps it fast and portable.
#
# Run: bash skills/dom-picker/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
PICKER="$ROOT/assets/element-picker.js"
CDP="$ROOT/scripts/cdp.mjs"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_ok() { if [ "$?" -eq 0 ]; then pass "$1"; else fail "$1" "$2"; fi; }

# --- syntax ---------------------------------------------------------------
node --check "$PICKER" 2>"$HERE/.err"; assert_ok "element-picker.js parses" "$(cat "$HERE/.err")"
node --check "$CDP" 2>"$HERE/.err"; assert_ok "cdp.mjs parses" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

# --- cdp usage ------------------------------------------------------------
USAGE="$(node "$CDP" 2>&1)"
case "$USAGE" in
  *"usage: node cdp.mjs"*) pass "cdp.mjs prints usage with no command" ;;
  *) fail "cdp.mjs prints usage with no command" "got: $USAGE" ;;
esac
case "$USAGE" in
  *"--timeout"*) pass "cdp.mjs usage documents wait --timeout" ;;
  *) fail "cdp.mjs usage documents wait --timeout" "missing --timeout in: $USAGE" ;;
esac
case "$USAGE" in
  *"inject"*) pass "cdp.mjs usage documents inject" ;;
  *) fail "cdp.mjs usage documents inject" "missing inject in: $USAGE" ;;
esac

# --- reload-safety regression guards (element-picker.js) ------------------
guard() { # <label> <file> <fixed-string>
  if grep -qF -- "$3" "$2"; then pass "$1"; else fail "$1" "pattern not found: $3"; fi
}
guard "picker persists state under a namespaced sessionStorage key" "$PICKER" "__s2p_state_v1"
guard "picker defines saveState/loadState" "$PICKER" "function saveState"
guard "picker restores state on install" "$PICKER" "function restoreState"
guard "picker escapes data-testid attribute values" "$PICKER" "attrEscape"
guard "picker verifies selector uniqueness" "$PICKER" "function isUnique"
guard "picker exposes ariaLabel in payload" "$PICKER" "ariaLabel:"
guard "cdp connect exposes close() for socket lifecycle" "$CDP" "const close = ()"

# --- schema validity ------------------------------------------------------
for schema in input output; do
  python3 -c "import json,sys; json.load(open('$ROOT/references/$schema.schema.json',encoding='utf-8'))" 2>"$HERE/.err"
  assert_ok "$schema.schema.json is valid JSON" "$(cat "$HERE/.err")"
done
# screenshot must NOT be required (headless agent picks omit it)
python3 - "$ROOT/references/input.schema.json" <<'PY' 2>"$HERE/.err"
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
assert "screenshot" not in d["required"], "screenshot should be optional"
assert {"instruction", "page", "element", "candidateFiles"} <= set(d["required"])
PY
assert_ok "input.schema.json makes screenshot optional" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

# --- eval assets ----------------------------------------------------------
python3 - "$ROOT/evals/behavior-evals.json" "$ROOT/evals/trigger-evals.json" <<'PY' 2>"$HERE/.err"
import json, sys
behavior = json.load(open(sys.argv[1], encoding="utf-8"))
trigger = json.load(open(sys.argv[2], encoding="utf-8"))
assert behavior["skill_name"] == "dom-picker"
assert len(behavior["evals"]) >= 4
assert all({"id", "prompt", "expected_output"} <= set(item) for item in behavior["evals"])
assert isinstance(trigger, list) and len(trigger) >= 8
assert sum(1 for item in trigger if item["should_trigger"]) >= 4
assert sum(1 for item in trigger if not item["should_trigger"]) >= 4
assert all({"query", "should_trigger"} <= set(item) for item in trigger)
PY
assert_ok "eval assets have expected schema" "$(cat "$HERE/.err")"
rm -f "$HERE/.err"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
