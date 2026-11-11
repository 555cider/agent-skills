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

# Whole-line match that a trailing CR (Windows text-mode output) must fail. Git
# Bash's grep drops the CR before LF on its own, so CRs are checked separately.
assert_file_has_line() {
  if grep -qx -- "$3" "$2" && [ "$(tr -dc '\r' < "$2" | wc -c)" -eq 0 ]; then
    pass "$1"
  else
    fail "$1" "no line exactly [$3] in $2: $(od -c "$2" 2>/dev/null | head -c 300)"
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
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  case "$(basename "$0")" in
    codex) printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules' ;;
    agy) printf '%s\n' '--sandbox --mode' ;;
    claude) printf '%s\n' '--permission-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --effort' ;;
  esac
  exit 0
fi
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS"
if [ -n "${PEER_REVIEW_STUB_STDIN:-}" ]; then
  cat > "$PEER_REVIEW_STUB_STDIN"
fi
printf 'stub review ok\n'
EOF
  chmod +x "$path"
}

make_opencode_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--pure --agent --variant'
  exit 0
fi
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
    PEER_REVIEW_STUB_STDIN="$D/prompt-all.md" \
    "$PR" plan.md --reviewer=codex-effort-only --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "effort-only profile run" 0
assert_file_has_line "effort forwarded to codex config" "$D/args.txt" "model_reasoning_effort=high"
assert_file_not_contains "effort not misread as model flag" "$D/args.txt" "--model"
assert_file_contains "codex uses an ephemeral session" "$D/args.txt" "--ephemeral"
assert_file_contains "codex ignores ambient user config" "$D/args.txt" "--ignore-user-config"
assert_file_contains "all focus reviews correctness" "$D/prompt-all.md" "Correctness"
assert_file_contains "all focus reviews feasibility" "$D/prompt-all.md" "Feasibility and dependencies"
assert_file_contains "all focus reviews assumptions" "$D/prompt-all.md" "Hidden assumptions"
assert_file_contains "all focus reviews failure modes" "$D/prompt-all.md" "Failure modes and edge cases"
assert_file_contains "all focus reviews repo fit" "$D/prompt-all.md" "Repository fit and duplication"
assert_file_contains "all focus reviews simpler alternatives" "$D/prompt-all.md" "Simpler alternatives"
assert_file_contains "all focus labels severity and evidence status" "$D/prompt-all.md" "[high|medium|low][verified|inferred]"
assert_file_contains "all focus distinguishes no issue from omission" "$D/prompt-all.md" "No material issue found"

set +e
(
  cd "$D" &&
  PATH="$D/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D/args-correctness.txt" \
    PEER_REVIEW_STUB_STDIN="$D/prompt-correctness.md" \
    "$PR" plan.md --reviewer=codex-effort-only --focus=correctness --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "explicit correctness focus run" 0
assert_file_contains "explicit correctness focus keeps narrow contract" "$D/prompt-correctness.md" "Surface only:"
assert_file_not_contains "explicit correctness focus does not expand to full matrix" "$D/prompt-correctness.md" "Feasibility and dependencies"

set +e
(
  cd "$D" &&
  PATH="$D/bin:$PATH" "$PR" list --host=claude
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "effort-only profile list" 0
if grep -Eq '^  1 +codex-effort-only +codex {20,}high +on PATH$' "$WORK/out"; then
  pass "list keeps effort in effort column"
else
  fail "list keeps effort in effort column" "$(od -c "$WORK/out" | head -c 600)"
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
assert_file_contains "opencode disables ambient plugins and config" "$D2/args_opencode.txt" "--pure"
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
assert_file_contains "agy receives plan mode" "$D2/args_agy.txt" "plan"
assert_file_not_contains "agy does not bypass permissions" "$D2/args_agy.txt" "--dangerously-skip-permissions"

# Multiple profile names that resolve to the same CLI and model are correlated
# signals even when their effort differs. Different explicit models or CLIs are
# not inferred to be the same backend.
D6="$WORK/backend-overlap"
mkdir -p "$D6/bin"
git -C "$D6" init -q
make_stub_cli "$D6/bin/codex"
make_stub_cli "$D6/bin/claude"
make_opencode_stub_cli "$D6/bin/opencode"
cat >"$D6/.peer-review.json" <<'EOF'
{
  "reviewers": {
    "codex-high": { "cli": "codex", "model": "gpt-5", "effort": "high" },
    "codex-low": { "cli": "codex", "model": "gpt-5", "effort": "low" },
    "codex-other": { "cli": "codex", "model": "gpt-5-mini" },
    "codex-default-a": { "cli": "codex" },
    "codex-default-b": { "cli": "codex" },
    "claude-same-name": { "cli": "claude", "model": "gpt-5" },
    "opencode-short": { "cli": "opencode", "model": "gpt-5" },
    "opencode-qualified": { "cli": "opencode", "model": "opencode/gpt-5" }
  }
}
EOF
printf '# Plan\n\nCompare reviewer signals.\n' >"$D6/plan.md"

set +e
(
  cd "$D6" &&
  PATH="$D6/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
    "$PR" plan.md --reviewer=codex-high,codex-low --host=opencode --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "same backend profiles run" 0
assert_file_contains "same CLI and model emit overlap warning" "$WORK/out" \
  "WARN=reviewer_backend_overlap cli=codex reviewers=codex-high,codex-low"

set +e
(
  cd "$D6" &&
  PATH="$D6/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
    "$PR" plan.md --reviewer=codex-default-a,codex-default-b --host=opencode --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "same default backend profiles run" 0
assert_file_contains "same CLI defaults emit overlap warning" "$WORK/out" \
  "WARN=reviewer_backend_overlap cli=codex reviewers=codex-default-a,codex-default-b"

set +e
(
  cd "$D6" &&
  PATH="$D6/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
    "$PR" plan.md --reviewer=codex-high,codex-other --host=opencode --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "different model profiles run" 0
assert_file_not_contains "different explicit models do not emit overlap warning" "$WORK/out" \
  "WARN=reviewer_backend_overlap"

set +e
(
  cd "$D6" &&
  PATH="$D6/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
    "$PR" plan.md --reviewer=codex-high,claude-same-name --host=opencode --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "different CLI profiles run" 0
assert_file_not_contains "different CLIs do not infer backend overlap" "$WORK/out" \
  "WARN=reviewer_backend_overlap"

set +e
(
  cd "$D6" &&
  PATH="$D6/bin:$PATH" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
    "$PR" plan.md --reviewer=opencode-short,opencode-qualified --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "equivalent opencode model profiles run" 0
assert_file_contains "opencode model normalization still emits overlap warning" "$WORK/out" \
  "WARN=reviewer_backend_overlap cli=opencode reviewers=opencode-short,opencode-qualified"

make_failing_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--permission-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --effort'
  exit 0
fi
echo "stub boom" >&2
exit 1
EOF
  chmod +x "$path"
}

make_slow_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules'
  exit 0
fi
sleep 1
printf 'stub review ok\n'
EOF
  chmod +x "$path"
}

# A PATH holding only core tool dirs — excludes wherever a real reviewer CLI
# (agy/codex/...) might be installed, so "missing CLI" tests are deterministic
# on machines that happen to have a reviewer CLI installed. The bash running
# this suite goes first: without it `#!/usr/bin/env bash` falls back to macOS
# /bin/bash 3.2, which the script rejects with exit 2 before any CLI check.
CORE_PATH="$(dirname "$BASH")"
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

# --- without timeout/gtimeout (stock macOS) the shell fallback must still feed the prompt on stdin ---
# Skipped on Git Bash: it always ships timeout, and its ln -s copies whole files.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
  D6="$WORK/no-timeout"
  mkdir -p "$D6/bin" "$D6/sysbin"
  git -C "$D6" init -q
  make_stub_cli "$D6/bin/codex"
  printf '# Plan\n\nNo timeout binary.\n' >"$D6/plan.md"
  # Mirror every PATH command except timeout/gtimeout so the script takes its fallback.
  IFS=: read -r -a path_dirs <<<"$PATH"
  for dir in "${path_dirs[@]}"; do
    [ -d "$dir" ] || continue
    for cmd in "$dir"/*; do
      name="${cmd##*/}"
      case "$name" in timeout|gtimeout|timeout.exe|gtimeout.exe) continue ;; esac
      [ -x "$cmd" ] && [ ! -e "$D6/sysbin/$name" ] && ln -s "$cmd" "$D6/sysbin/$name" 2>/dev/null
    done
  done

  set +e
  (
    cd "$D6" &&
    PATH="$D6/bin:$D6/sysbin" PEER_REVIEW_STUB_ARGS="$D6/args.txt" \
      PEER_REVIEW_STUB_STDIN="$D6/prompt.md" \
      "$PR" plan.md --reviewer=codex --host=claude --timeout=5
  ) >"$WORK/out" 2>"$WORK/err"
  EC=$?
  set -e

  assert_exit "fallback timeout run" 0
  assert_file_contains "fallback timeout passes prompt on stdin" "$D6/prompt.md" "No timeout binary."
  ;;
esac


# ---------------------------------------------------------------------------
# Reviewer selection, self-review, timeouts, stdin plans, build isolation.
# CORE_PATH keeps any real reviewer CLI on this machine out of `all` / index
# expansion, so only the stubs below are "on PATH".
# ---------------------------------------------------------------------------
export PEER_REVIEW_STUB_ARGS="$WORK/stub-args"

assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3] (stderr: $(tr '\n' '|' < "$WORK/err" | head -c 300))"; fi
}

# run_pr <dir> <PATH> <args...>: run the script from <dir>, capture out/err/EC.
run_pr() {
  local dir="$1" path="$2"
  shift 2
  set +e
  ( cd "$dir" && PATH="$path" "$PR" "$@" ) >"$WORK/out" 2>"$WORK/err"
  EC=$?
  set -e
}

# The REVIEW= reviewer names on stdout, in order, space-separated.
reviews_in_out() { grep '^REVIEW=' "$WORK/out" | cut -d' ' -f1 | tr '\n' ' '; }

D7="$WORK/select"
mkdir -p "$D7/bin"
git -C "$D7" init -q
make_stub_cli "$D7/bin/codex"
make_stub_cli "$D7/bin/claude"
printf '# Plan\n\nPick reviewers.\n' >"$D7/plan.md"
SEL_PATH="$D7/bin:$CORE_PATH"

run_pr "$D7" "$SEL_PATH" plan.md --host=codex --timeout=5
assert_exit "omitted reviewer with --host=codex" 0
assert_eq "default reviewer avoids the host" "REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=all --host=claude --timeout=5
assert_exit "all with --host" 0
assert_eq "all skips the host CLI" "REVIEW=codex " "$(reviews_in_out)"
assert_file_contains "all names the skipped host" "$WORK/err" "all: skipping claude"
assert_file_not_contains "all without the host raises no host warning" "$WORK/out" "WARN=reviewer_matches_host"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=all,0 --host=claude --timeout=5
assert_exit "all,0 with --host" 0
assert_eq "all,0 opts the host back in" "REVIEW=codex REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=all --timeout=5
assert_exit "all without --host" 0
assert_eq "all without --host runs every CLI on PATH" "REVIEW=codex REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=all --exclude-cli=codex --host=claude --timeout=5
assert_exit "all minus host and --exclude-cli leaves nobody" 2
assert_file_contains "empty all expansion is named" "$WORK/err" "no valid reviewers"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=0 --host=claude --timeout=5
assert_exit "--reviewer=0 self-review" 0
assert_eq "0 resolves to the host CLI" "REVIEW=claude " "$(reviews_in_out)"
assert_file_not_contains "explicit self-review is not warned about" "$WORK/out" "WARN=reviewer_matches_host"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=0 --timeout=5
assert_exit "--reviewer=0 without --host" 2
assert_file_contains "0 without --host names the missing flag" "$WORK/err" "--reviewer=0 requires --host"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=claude --host=claude --timeout=5
assert_exit "naming the host CLI" 0
assert_file_contains "naming the host warns without opt-in" "$WORK/out" "WARN=reviewer_matches_host reviewer=claude host=claude self_opt_in=0"

# No config: indexes count on-PATH CLIs in codex, claude, opencode, agy order.
run_pr "$D7" "$SEL_PATH" plan.md --reviewer=2 --host=opencode --timeout=5
assert_exit "index without config" 0
assert_eq "index 2 is the second on-PATH CLI" "REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=1-2 --host=opencode --timeout=5
assert_exit "range without config" 0
assert_eq "range 1-2 runs both on-PATH CLIs" "REVIEW=codex REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=3 --host=opencode --timeout=5
assert_exit "index past the on-PATH CLIs" 2
assert_file_contains "out-of-range index is named" "$WORK/err" "out of range"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=2-1 --timeout=5
assert_exit "descending range" 2

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=0-1 --host=claude --timeout=5
assert_exit "range containing 0" 2

# With a config: indexes and ranges address profiles in file order.
D8="$WORK/select-config"
mkdir -p "$D8/bin"
git -C "$D8" init -q
make_stub_cli "$D8/bin/codex"
make_stub_cli "$D8/bin/claude"
cat >"$D8/.peer-review.json" <<'EOF'
{
  "reviewers": {
    "p-a": { "cli": "codex" },
    "p-b": { "cli": "claude", "effort": "low" },
    "p-c": { "cli": "codex", "model": "gpt-5-mini" }
  }
}
EOF
printf '# Plan\n\nPick profiles.\n' >"$D8/plan.md"
CFG_PATH="$D8/bin:$CORE_PATH"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=2 --host=opencode --timeout=5
assert_exit "profile index" 0
assert_eq "index 2 is the second profile" "REVIEW=p-b " "$(reviews_in_out)"
assert_file_has_line "claude effort reaches argv without a CR" "$PEER_REVIEW_STUB_ARGS" "low"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=1,3 --host=opencode --timeout=5
assert_exit "profile index list" 0
assert_eq "1,3 picks the first and third profiles" "REVIEW=p-a REVIEW=p-c " "$(reviews_in_out)"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=1-3 --host=opencode --timeout=5
assert_exit "profile range" 0
assert_eq "1-3 picks every profile" "REVIEW=p-a REVIEW=p-b REVIEW=p-c " "$(reviews_in_out)"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=4 --timeout=5
assert_exit "profile index out of range" 2
assert_file_contains "profile range bound is named" "$WORK/err" "out of range (1..3)"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=all --host=codex --timeout=5
assert_exit "all over profiles with --host" 0
assert_eq "all skips every host-backed profile" "REVIEW=p-b " "$(reviews_in_out)"

run_pr "$D8" "$CFG_PATH" list --host=claude
assert_exit "list with a claude effort profile" 0
if grep -Eq '^  2 +p-b +claude {20,}low +on PATH$' "$WORK/out"; then
  pass "list shows the effort without a CR"
else
  fail "list shows the effort without a CR" "$(od -c "$WORK/out" | head -c 600)"
fi

# A python3 that is on PATH but does not run (the Windows Store stub) must not
# hide a working `python`: the config still loads.
REAL_PY=""
for _c in python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c 'import sys; assert sys.version_info >= (3, 7)' >/dev/null 2>&1; then
    REAL_PY="$(command -v "$_c")"; break
  fi
done
if [ -n "$REAL_PY" ]; then
  D14="$WORK/python-probe"
  mkdir -p "$D14/bin"
  git -C "$D14" init -q
  make_stub_cli "$D14/bin/codex"
  printf '#!/usr/bin/env bash\necho "Python was not found" >&2\nexit 9009\n' >"$D14/bin/python3"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$REAL_PY" >"$D14/bin/python"
  chmod +x "$D14/bin/python3" "$D14/bin/python"
  printf '{ "reviewers": { "fast": { "cli": "codex", "effort": "high" } } }\n' >"$D14/.peer-review.json"
  printf '# Plan\n\nProbe python.\n' >"$D14/plan.md"
  run_pr "$D14" "$D14/bin:$PATH" plan.md --reviewer=fast --host=claude --timeout=5
  assert_exit "config loads past a broken python3" 0
  assert_file_has_line "config effort applied via python fallback" "$PEER_REVIEW_STUB_ARGS" "model_reasoning_effort=high"
  assert_file_not_contains "no python-missing warning" "$WORK/err" "ignoring config"
fi

# --- real timeout: a reviewer that hangs is cut off, its children included ---
make_hanging_stub_cli() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules'
  exit 0
fi
# The grandchild is what a CLI's worker process looks like; it must die too.
( sleep 4; : > "$PEER_REVIEW_STUB_LATE" ) &
wait
printf 'too late\n'
EOF
  chmod +x "$1"
}
D9="$WORK/timeout"
mkdir -p "$D9/bin"
git -C "$D9" init -q
make_hanging_stub_cli "$D9/bin/codex"
make_stub_cli "$D9/bin/claude"
printf '# Plan\n\nHang.\n' >"$D9/plan.md"
export PEER_REVIEW_STUB_LATE="$D9/late-marker"

run_pr "$D9" "$D9/bin:$PATH" plan.md --reviewer=codex --host=opencode --timeout=1
assert_exit "a hung single reviewer times out" 124
assert_file_contains "timeout is reported as such" "$WORK/err" "codex timed out after 1s"
assert_file_not_contains "no review saved for the hung reviewer" "$WORK/out" "REVIEW="

run_pr "$D9" "$D9/bin:$PATH" plan.md --reviewer=codex,claude --host=opencode --timeout=1
assert_exit "one hung reviewer among two" 0
assert_file_contains "multi-reviewer timeout is an ERROR line" "$WORK/err" "ERROR=codex timed out after 1s"
assert_eq "the other reviewer still reports" "REVIEW=claude " "$(reviews_in_out)"
sleep 5
if [ -e "$PEER_REVIEW_STUB_LATE" ]; then
  fail "timed-out reviewer's process tree is killed" "grandchild wrote $PEER_REVIEW_STUB_LATE"
else
  pass "timed-out reviewer's process tree is killed"
fi

# --- a chat plan over --stdin-plan runs end to end and leaves no temp plan ---
D10="$WORK/stdin-ok"
mkdir -p "$D10/bin"
git -C "$D10" init -q
make_stub_cli "$D10/bin/codex"
set +e
printf '# Chat plan\n\nFrom stdin marker-7731.\n' | (
  cd "$D10" && PATH="$D10/bin:$PATH" PEER_REVIEW_STUB_STDIN="$D10/prompt.md" \
    "$PR" --stdin-plan --reviewer=codex --host=claude --timeout=5
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "stdin plan review" 0
assert_file_contains "stdin plan review is saved" "$WORK/out" "REVIEW=codex"
assert_file_contains "stdin plan slug comes from its heading" "$WORK/out" "-chat-plan-codex-r1.md"
assert_file_contains "stdin plan reaches the reviewer prompt" "$D10/prompt.md" "marker-7731"
if [ -e "$D10/.peer-review/tmp" ]; then
  fail "stdin temp plan removed" "$(ls -a "$D10/.peer-review/tmp" | tr '\n' '|')"
else
  pass "stdin temp plan removed"
fi

# --- a reviewer whose command cannot be built is dropped, not the run ---
D11="$WORK/build-fail"
mkdir -p "$D11/bin"
git -C "$D11" init -q
printf '#!/usr/bin/env bash\nprintf "usage: codex exec\\n"\n' >"$D11/bin/codex"
chmod +x "$D11/bin/codex"
make_stub_cli "$D11/bin/claude"
printf '# Plan\n\nOld codex.\n' >"$D11/plan.md"

run_pr "$D11" "$D11/bin:$PATH" plan.md --reviewer=claude,codex --host=opencode --timeout=5
assert_exit "a later reviewer's build failure keeps the run" 0
assert_eq "the buildable reviewer still reports" "REVIEW=claude " "$(reviews_in_out)"
assert_file_contains "the build failure is an ERROR line" "$WORK/err" "ERROR=codex codex CLI lacks required read-only reviewer flag: --sandbox"

run_pr "$D11" "$D11/bin:$PATH" plan.md --reviewer=codex --host=opencode --timeout=5
assert_exit "a single unbuildable reviewer" 3

# --- ANSI stripping keeps the reviewer's line endings and leaves no temp ---
D13="$WORK/ansi"
mkdir -p "$D13/bin"
git -C "$D13" init -q
cat >"$D13/bin/codex" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules'
  exit 0
fi
cat >/dev/null
printf '\033[31mred\033[0m\nline2\n'
EOF
chmod +x "$D13/bin/codex"
printf '# Plan\n\nColor.\n' >"$D13/plan.md"
run_pr "$D13" "$D13/bin:$PATH" plan.md --reviewer=codex --host=claude --timeout=5
assert_exit "ansi review run" 0
_review="$(sed -n 's/^REVIEW=codex //p' "$WORK/out")"
printf 'red\nline2\n' >"$WORK/ansi-expected"
if [ -n "$_review" ] && cmp -s "$_review" "$WORK/ansi-expected"; then
  pass "ANSI codes stripped, LF line endings kept"
else
  fail "ANSI codes stripped, LF line endings kept" "$(od -c "$_review" 2>/dev/null | head -c 300)"
fi
if ls "$D13/.peer-review/reviews/"*.clean >/dev/null 2>&1; then
  fail "no .clean temp left" "$(ls -a "$D13/.peer-review/reviews/" | tr '\n' '|')"
else
  pass "no .clean temp left"
fi

# --- Windows: agy's prompt-in-argv must fit the 32,767-char command line ---
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    D12="$WORK/agy-limit"
    mkdir -p "$D12/bin"
    git -C "$D12" init -q
    make_stub_cli "$D12/bin/agy"
    make_stub_cli "$D12/bin/codex"
    { printf '# Big plan\n\n'; head -c 33000 /dev/zero | tr '\0' 'x'; printf '\n'; } >"$D12/big.md"
    rm -f "$PEER_REVIEW_STUB_ARGS"
    run_pr "$D12" "$D12/bin:$PATH" big.md --reviewer=agy --host=claude --timeout=5
    assert_exit "agy prompt over the Windows limit" 2
    assert_file_contains "oversized agy prompt is named before spawning" "$WORK/err" "ERROR=agy prompt too large"
    if [ -e "$PEER_REVIEW_STUB_ARGS" ]; then
      fail "agy is not started with an oversized prompt" "stub ran"
    else
      pass "agy is not started with an oversized prompt"
    fi

    run_pr "$D12" "$D12/bin:$PATH" big.md --reviewer=agy,codex --host=claude --timeout=5
    assert_exit "oversized agy among two reviewers" 0
    assert_eq "the stdin reviewer still runs" "REVIEW=codex " "$(reviews_in_out)"

    # 15,000 Hangul syllables are 45,000 UTF-8 bytes but 15,000 UTF-16 units.
    { printf '# Korean plan\n\n'; _i=0; while [ "$_i" -lt 1500 ]; do printf '가나다라마바사아자차'; _i=$((_i + 1)); done; printf '\n'; } >"$D12/ko.md"
    run_pr "$D12" "$D12/bin:$PATH" ko.md --reviewer=agy --host=claude --timeout=5
    assert_exit "a Korean plan under the limit in characters" 0
    ;;
esac

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
