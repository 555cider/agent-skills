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

make_opencode_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS"
agent=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--agent" ]; then
    agent="$arg"
    break
  fi
  prev="$arg"
done
if [ -n "$agent" ] && [ -n "${PEER_REVIEW_STUB_AGENT_COPY:-}" ]; then
  cp ".opencode/agent/$agent.md" "$PEER_REVIEW_STUB_AGENT_COPY"
fi
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

# Verify opencode model mapping + read-only agent, and agy model forwarding + sandboxing
D2="$WORK/opencode-agy"
mkdir -p "$D2/bin"
git -C "$D2" init -q
make_opencode_stub_cli "$D2/bin/opencode"
make_stub_cli "$D2/bin/agy"
cat >"$D2/.peer-review.json" <<'EOF'
{
  "reviewers": {
    "opencode-test": { "cli": "opencode", "model": "gpt-5" },
    "agy-test": { "cli": "agy", "model": "gemini-3.5-flash" }
  }
}
EOF
printf '# Plan\n\nShip it.\n' >"$D2/plan.md"

set +e
(
  cd "$D2" &&
  PATH="$D2/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D2/args_opencode.txt" \
    PEER_REVIEW_STUB_AGENT_COPY="$D2/opencode_agent.md" \
    "$PR" plan.md --reviewer=opencode-test --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "opencode-test run" 0
assert_file_contains "opencode receives mapped model flag" "$D2/args_opencode.txt" "-m"
assert_file_contains "opencode receives mapped model value" "$D2/args_opencode.txt" "opencode/gpt-5"
assert_file_contains "opencode receives read-only agent flag" "$D2/args_opencode.txt" "--agent"
assert_file_contains "opencode receives read-only agent name" "$D2/args_opencode.txt" "peer-review-readonly-"
assert_file_not_contains "opencode does not bypass permissions" "$D2/args_opencode.txt" "--dangerously-skip-permissions"
assert_file_contains "opencode agent denies edits" "$D2/opencode_agent.md" "edit: deny"
assert_file_contains "opencode agent denies shell" "$D2/opencode_agent.md" "bash: deny"
if [ -e "$D2/.opencode" ]; then
  fail "opencode temp agent cleaned up" "$(find "$D2/.opencode" -maxdepth 3 -print 2>/dev/null | tr '\n' '|' | head -c 300)"
else
  pass "opencode temp agent cleaned up"
fi

set +e
(
  cd "$D2" &&
  PATH="$D2/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D2/args_agy.txt" \
    "$PR" plan.md --reviewer=agy-test --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "agy-test run" 0
assert_file_contains "agy receives model flag" "$D2/args_agy.txt" "--model"
assert_file_contains "agy receives model value" "$D2/args_agy.txt" "gemini-3.5-flash"
assert_file_contains "agy receives sandbox flag" "$D2/args_agy.txt" "--sandbox"
assert_file_not_contains "agy does not bypass permissions" "$D2/args_agy.txt" "--dangerously-skip-permissions"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
