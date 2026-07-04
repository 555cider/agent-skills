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

make_failing_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
echo "stub boom" >&2
exit 1
EOF
  chmod +x "$path"
}

make_slow_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
sleep 1
printf 'stub review ok\n'
EOF
  chmod +x "$path"
}

# A PATH holding only core tool dirs — excludes wherever a real reviewer CLI
# (agy/codex/...) might be installed, so "missing CLI" tests are deterministic
# on machines that happen to have a reviewer CLI installed.
CORE_PATH=""
for _t in git mktemp python3 sed grep tr ls cat od date dirname basename head tail wc chmod mkdir rm sleep sort; do
  _d="$(command -v "$_t" 2>/dev/null)" || continue
  _d="$(dirname "$_d")"
  case ":$CORE_PATH:" in *":$_d:"*) ;; *) CORE_PATH="${CORE_PATH:+$CORE_PATH:}$_d" ;; esac
done

# --- edge cases: empty input, missing CLI, output path, exclude entry ---
D3="$WORK/edge"
mkdir -p "$D3/bin"
git -C "$D3" init -q
make_stub_cli "$D3/bin/codex"
printf '# Plan\n\nDo the thing.\n' >"$D3/plan.md"
: >"$D3/empty.md"
printf '   \n\t\n' >"$D3/whitespace.md"

set +e
( cd "$D3" && PATH="$D3/bin:$PATH" "$PR" empty.md --reviewer=codex --host=claude --timeout=5 ) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "empty plan file rejected" 2

set +e
( cd "$D3" && PATH="$D3/bin:$PATH" "$PR" whitespace.md --reviewer=codex --host=claude --timeout=5 ) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "whitespace-only plan file rejected" 2

set +e
( cd "$D3" && PATH="$D3/bin:$PATH" "$PR" --stdin-plan --reviewer=codex --host=claude --timeout=5 ) >"$WORK/out" 2>"$WORK/err" </dev/null
EC=$?
set -e
assert_exit "empty stdin plan rejected" 2

# Only the codex stub is on PATH here (CORE_PATH excludes any real agy), so a
# request for agy hits the CLI-presence check and exits 3.
set +e
( cd "$D3" && PATH="$D3/bin:$CORE_PATH" "$PR" plan.md --reviewer=agy --host=claude --timeout=5 ) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "missing reviewer CLI" 3

set +e
( cd "$D3" && PATH="$D3/bin:$PATH" "$PR" plan.md --reviewer=codex --host=claude --timeout=5 ) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "codex review run (edge repo)" 0
assert_file_contains "review path under .peer-review/reviews" "$WORK/out" "/.peer-review/reviews/"
assert_file_contains "exclude note emitted" "$WORK/out" "EXCLUDE_NOTE="
if grep -qF ".peer-review/" "$D3/.git/info/exclude" 2>/dev/null; then
  pass "output dir added to .git/info/exclude"
else
  fail "output dir added to .git/info/exclude" "$(cat "$D3/.git/info/exclude" 2>/dev/null | tr '\n' '|' | head -c 200)"
fi
# cleanup must remove this run's own temp files without a shared glob.
if ls "$D3/.peer-review/reviews/".peer-review-prompt-* >/dev/null 2>&1 \
   || ls "$D3/.peer-review/reviews/".peer-review-out-* >/dev/null 2>&1 \
   || ls "$D3/.peer-review/reviews/".peer-review-err-* >/dev/null 2>&1; then
  fail "no leftover temp files after run" "$(ls -a "$D3/.peer-review/reviews/" | tr '\n' '|' | head -c 300)"
else
  pass "no leftover temp files after run"
fi

# --- multi-reviewer partial failure: one succeeds, one fails -> exit 0 ---
D4="$WORK/multi"
mkdir -p "$D4/bin"
git -C "$D4" init -q
make_stub_cli "$D4/bin/codex"
make_failing_stub_cli "$D4/bin/claude"
printf '# Plan\n\nShip.\n' >"$D4/plan.md"

set +e
( cd "$D4" && PATH="$D4/bin:$PATH" "$PR" plan.md --reviewer=codex,claude --host=opencode --timeout=5 ) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "multi-reviewer partial failure exits 0" 0
assert_file_contains "successful reviewer reported on stdout" "$WORK/out" "REVIEW=codex"
assert_file_contains "failed reviewer reported on stderr" "$WORK/err" "ERROR=claude"

# --- concurrent runs sharing OUT_DIR must not clobber each other ---
D5="$WORK/concurrent"
mkdir -p "$D5/bin"
git -C "$D5" init -q
make_slow_stub_cli "$D5/bin/codex"
printf '# Plan\n\nConcurrent.\n' >"$D5/plan.md"

set +e
( cd "$D5" && PATH="$D5/bin:$PATH" "$PR" plan.md --reviewer=codex --host=claude --timeout=10 ) >"$WORK/cout1" 2>"$WORK/cerr1" &
CP1=$!
( cd "$D5" && PATH="$D5/bin:$PATH" "$PR" plan.md --reviewer=codex --host=claude --timeout=10 ) >"$WORK/cout2" 2>"$WORK/cerr2" &
CP2=$!
wait "$CP1"; CE1=$?
wait "$CP2"; CE2=$?
set -e
if [ "$CE1" = 0 ] && [ "$CE2" = 0 ]; then
  pass "concurrent runs both succeed (no cross-run temp deletion)"
else
  fail "concurrent runs both succeed (no cross-run temp deletion)" "exit1=$CE1 exit2=$CE2 err1=$(cat "$WORK/cerr1" | tr '\n' '|' | head -c 150) err2=$(cat "$WORK/cerr2" | tr '\n' '|' | head -c 150)"
fi
assert_file_contains "concurrent run 1 produced review" "$WORK/cout1" "REVIEW=codex"
assert_file_contains "concurrent run 2 produced review" "$WORK/cout2" "REVIEW=codex"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
