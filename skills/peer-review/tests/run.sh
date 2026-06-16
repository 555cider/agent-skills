#!/usr/bin/env bash
# Self-contained regression checks for scripts/run-peer-review.sh.
#
# Run: bash skills/peer-review/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PR="$HERE/../scripts/run-peer-review.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/peer-review-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_file_contains() {
  if grep -qF -- "$3" "$2"; then
    pass "$1"
  else
    fail "$1" "missing [$3] in $2: $(cat "$2" 2>/dev/null | tr '\n' '|' | head -c 300)"
  fi
}

assert_file_not_contains() {
  if grep -qF -- "$3" "$2"; then
    fail "$1" "unexpected [$3] in $2: $(cat "$2" 2>/dev/null | tr '\n' '|' | head -c 300)"
  else
    pass "$1"
  fi
}

assert_exit() {
  if [ "$EC" = "$2" ]; then
    pass "$1 [exit $2]"
  else
    fail "$1" "expected exit $2, got $EC (stderr: $(cat "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300))"
  fi
}

make_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS"
printf 'stub review ok\n'
EOF
  chmod +x "$path"
}

# Profiles with an omitted model but non-empty effort must not shift the effort
# value into the model field.
D="$WORK/effort-only"
mkdir -p "$D/bin"
git -C "$D" init -q
make_stub_cli "$D/bin/codex"
cat >"$D/.peer-review.json" <<'EOF'
{
  "reviewers": {
    "codex-effort-only": { "cli": "codex", "effort": "high" }
  }
}
EOF
printf '# Plan\n\nShip the small thing.\n' >"$D/plan.md"

set +e
(
  cd "$D" &&
  PATH="$D/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D/args.txt" \
    "$PR" plan.md --reviewer=codex-effort-only --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "effort-only profile run" 0
assert_file_contains "effort forwarded to codex config" "$D/args.txt" "model_reasoning_effort=high"
assert_file_not_contains "effort not misread as model flag" "$D/args.txt" "--model"

set +e
(
  cd "$D" &&
  PATH="$D/bin:$PATH" "$PR" list --host=claude
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "effort-only profile list" 0
if grep -Eq 'codex-effort-only[[:space:]]+codex[[:space:]]{20,}high[[:space:]]+on PATH' "$WORK/out"; then
  pass "list keeps effort in effort column"
else
  fail "list keeps effort in effort column" "$(cat "$WORK/out" | tr '\n' '|' | head -c 300)"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
