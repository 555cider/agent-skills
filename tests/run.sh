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

# new_repo <dir>: an empty git repo with bin/ and a one-line plan.md.
new_repo() {
  mkdir -p "$1/bin"
  git -C "$1" init -q
  printf '# Plan\n\nShip it.\n' >"$1/plan.md"
}

# Stub reviewer: argv goes to $PEER_REVIEW_STUB_ARGS and, per CLI, to
# $PEER_REVIEW_STUB_ARGS.<cli> so parallel reviewers in one run stay apart.
make_stub_cli() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  case "${0##*/}" in
    codex) printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules' ;;
    agy) printf '%s\n' '--sandbox --mode' ;;
    claude) printf '%s\n' '--permission-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --effort' ;;
  esac
  exit 0
fi
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS"
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS.${0##*/}"
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
printf '%s\n' "$@" > "$PEER_REVIEW_STUB_ARGS.opencode"
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

make_failing_stub_cli() {
  cat >"$1" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--permission-mode --tools --strict-mcp-config --mcp-config --no-session-persistence --effort'
  exit 0
fi
echo "stub boom" >&2
exit 1
EOF
  chmod +x "$1"
}

export PEER_REVIEW_STUB_ARGS="$WORK/stub-args"
ARGS="$PEER_REVIEW_STUB_ARGS"

# A PATH holding only core tool dirs — excludes wherever a real reviewer CLI
# (agy/codex/...) might be installed, so "missing CLI" and `all` / index tests
# are deterministic on machines that happen to have a reviewer CLI installed.
# The bash running this suite goes first: without it `#!/usr/bin/env bash` falls
# back to macOS /bin/bash 3.2, which the script rejects with exit 2.
CORE_PATH="$(dirname "$BASH")"
for _t in git mktemp python3 sed grep tr ls cat od date dirname basename head tail wc chmod mkdir rm sleep sort; do
  _d="$(command -v "$_t" 2>/dev/null)" || continue
  _d="$(dirname "$_d")"
  case ":$CORE_PATH:" in *":$_d:"*) ;; *) CORE_PATH="${CORE_PATH:+$CORE_PATH:}$_d" ;; esac
done

# --- read-only flags for opencode and agy, run together ---
D2="$WORK/opencode-agy"
new_repo "$D2"
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
set +e
(
  cd "$D2" &&
  PATH="$D2/bin:$PATH" PEER_REVIEW_STUB_AGENT_COPY="$D2/opencode_agent.md" \
    "$PR" plan.md --reviewer=opencode-test,agy-test --host=claude --timeout=10
) >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "opencode and agy run" 0
assert_file_has_line "opencode receives mapped model" "$ARGS.opencode" "opencode/gpt-5"
assert_file_contains "opencode receives read-only agent" "$ARGS.opencode" "peer-review-readonly-"
assert_file_contains "opencode disables ambient plugins and config" "$ARGS.opencode" "--pure"
assert_file_not_contains "opencode does not bypass permissions" "$ARGS.opencode" "--dangerously-skip-permissions"
assert_file_contains "opencode agent denies edits" "$D2/opencode_agent.md" "edit: deny"
assert_file_contains "opencode agent denies shell" "$D2/opencode_agent.md" "bash: deny"
if [ -e "$D2/.opencode" ]; then
  fail "opencode temp agent cleaned up" "$(find "$D2/.opencode" -maxdepth 3 -print 2>/dev/null | tr '\n' '|' | head -c 300)"
else
  pass "opencode temp agent cleaned up"
fi
assert_file_has_line "agy receives model value" "$ARGS.agy" "gemini-3.5-flash"
assert_file_contains "agy receives sandbox flag" "$ARGS.agy" "--sandbox"
assert_file_has_line "agy receives plan mode" "$ARGS.agy" "plan"
assert_file_not_contains "agy does not bypass permissions" "$ARGS.agy" "--dangerously-skip-permissions"

# --- same CLI + model is flagged as one backend; other models and CLIs are not ---
D6="$WORK/backend-overlap"
new_repo "$D6"
make_stub_cli "$D6/bin/codex"
make_stub_cli "$D6/bin/claude"
cat >"$D6/.peer-review.json" <<'EOF'
{
  "reviewers": {
    "codex-high": { "cli": "codex", "model": "gpt-5", "effort": "high" },
    "codex-low": { "cli": "codex", "model": "gpt-5", "effort": "low" },
    "codex-other": { "cli": "codex", "model": "gpt-5-mini" },
    "claude-same-name": { "cli": "claude", "model": "gpt-5" }
  }
}
EOF
run_pr "$D6" "$D6/bin:$PATH" plan.md --reviewer=codex-high,codex-low,codex-other,claude-same-name --host=opencode --timeout=10
assert_exit "backend overlap run" 0
assert_eq "only same CLI and model overlap" "WARN=reviewer_backend_overlap cli=codex reviewers=codex-high,codex-low" \
  "$(grep '^WARN=reviewer_backend_overlap' "$WORK/out")"

# --- edge cases: empty input, missing CLI, codex flags, output path, temp cleanup ---
D3="$WORK/edge"
new_repo "$D3"
make_stub_cli "$D3/bin/codex"
: >"$D3/empty.md"

run_pr "$D3" "$D3/bin:$PATH" empty.md --reviewer=codex --host=claude --timeout=5
assert_exit "empty plan file rejected" 2

# Only the codex stub is on PATH here (CORE_PATH excludes any real agy), so a
# request for agy hits the CLI-presence check and exits 3.
run_pr "$D3" "$D3/bin:$CORE_PATH" plan.md --reviewer=agy --host=claude --timeout=5
assert_exit "missing reviewer CLI" 3

run_pr "$D3" "$D3/bin:$PATH" plan.md --reviewer=codex --host=claude --timeout=5
assert_exit "codex review run" 0
assert_file_contains "codex uses an ephemeral session" "$ARGS" "--ephemeral"
assert_file_contains "codex ignores ambient user config" "$ARGS" "--ignore-user-config"
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    assert_file_has_line "codex keeps a Windows sandbox that can run reads" "$ARGS" 'windows.sandbox="unelevated"' ;;
  *)
    assert_file_not_contains "codex sandbox override is Windows-only" "$ARGS" "windows.sandbox" ;;
esac
assert_file_contains "review path under .peer-review/reviews" "$WORK/out" "/.peer-review/reviews/"
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

# --- multi-reviewer: a failing CLI and an unbuildable CLI drop out, the run does not ---
D4="$WORK/multi"
new_repo "$D4"
make_stub_cli "$D4/bin/agy"
make_failing_stub_cli "$D4/bin/claude"
printf '#!/usr/bin/env bash\nprintf "usage: codex exec\\n"\n' >"$D4/bin/codex"
chmod +x "$D4/bin/codex"
run_pr "$D4" "$D4/bin:$PATH" plan.md --reviewer=agy,claude,codex --host=opencode --timeout=10
assert_exit "multi-reviewer partial failure exits 0" 0
assert_eq "the working reviewer still reports" "REVIEW=agy " "$(reviews_in_out)"
assert_file_contains "failed reviewer reported on stderr" "$WORK/err" "ERROR=claude"
assert_file_contains "the build failure is an ERROR line" "$WORK/err" "ERROR=codex codex CLI lacks required read-only reviewer flag: --sandbox"

# --- concurrent runs sharing OUT_DIR must not clobber each other ---
D5="$WORK/concurrent"
new_repo "$D5"
cat >"$D5/bin/codex" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules'
  exit 0
fi
sleep 1
printf 'stub review ok\n'
EOF
chmod +x "$D5/bin/codex"
set +e
( cd "$D5" && PATH="$D5/bin:$PATH" "$PR" plan.md --reviewer=codex --host=claude --timeout=10 ) >"$WORK/cout1" 2>"$WORK/cerr1" &
CP1=$!
( cd "$D5" && PATH="$D5/bin:$PATH" "$PR" plan.md --reviewer=codex --host=claude --timeout=10 ) >"$WORK/cout2" 2>"$WORK/cerr2" &
CP2=$!
wait "$CP1"; CE1=$?
wait "$CP2"; CE2=$?
set -e
if [ "$CE1" = 0 ] && [ "$CE2" = 0 ] && grep -q '^REVIEW=codex' "$WORK/cout1" && grep -q '^REVIEW=codex' "$WORK/cout2"; then
  pass "concurrent runs both produce a review (no cross-run temp deletion)"
else
  fail "concurrent runs both produce a review (no cross-run temp deletion)" "exit1=$CE1 exit2=$CE2 err1=$(cat "$WORK/cerr1" | tr '\n' '|' | head -c 150) err2=$(cat "$WORK/cerr2" | tr '\n' '|' | head -c 150)"
fi

# --- without timeout/gtimeout (stock macOS) the shell fallback must still feed the prompt on stdin ---
# Skipped on Git Bash: it always ships timeout, and its ln -s copies whole files.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
  D6="$WORK/no-timeout"
  new_repo "$D6"
  mkdir -p "$D6/sysbin"
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
    PATH="$D6/bin:$D6/sysbin" PEER_REVIEW_STUB_STDIN="$D6/prompt.md" \
      "$PR" plan.md --reviewer=codex --host=claude --timeout=5
  ) >"$WORK/out" 2>"$WORK/err"
  EC=$?
  set -e

  assert_exit "fallback timeout run" 0
  assert_file_contains "fallback timeout passes prompt on stdin" "$D6/prompt.md" "No timeout binary."
  ;;
esac

# --- reviewer selection without a config: host avoidance, all, self-review, index ---
D7="$WORK/select"
new_repo "$D7"
make_stub_cli "$D7/bin/codex"
make_stub_cli "$D7/bin/claude"
SEL_PATH="$D7/bin:$CORE_PATH"

run_pr "$D7" "$SEL_PATH" plan.md --host=codex --timeout=5
assert_exit "omitted reviewer with --host=codex" 0
assert_eq "default reviewer avoids the host" "REVIEW=claude " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=all --host=claude --timeout=5
assert_exit "all with --host" 0
assert_eq "all skips the host CLI" "REVIEW=codex " "$(reviews_in_out)"

run_pr "$D7" "$SEL_PATH" plan.md --reviewer=0 --host=claude --timeout=5
assert_exit "--reviewer=0 self-review" 0
assert_eq "0 resolves to the host CLI" "REVIEW=claude " "$(reviews_in_out)"

# No config: indexes count on-PATH CLIs in codex, claude, opencode, agy order.
run_pr "$D7" "$SEL_PATH" plan.md --reviewer=2 --host=opencode --timeout=5
assert_exit "index without config" 0
assert_eq "index 2 is the second on-PATH CLI" "REVIEW=claude " "$(reviews_in_out)"

# --- with a config: ranges address profiles in file order; effort has no CR ---
D8="$WORK/select-config"
new_repo "$D8"
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
CFG_PATH="$D8/bin:$CORE_PATH"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=1-3 --host=opencode --timeout=10
assert_exit "profile range" 0
assert_eq "1-3 picks every profile" "REVIEW=p-a REVIEW=p-b REVIEW=p-c " "$(reviews_in_out)"
assert_file_has_line "claude effort reaches argv without a CR" "$ARGS.claude" "low"

run_pr "$D8" "$CFG_PATH" plan.md --reviewer=4 --timeout=5
assert_exit "profile index out of range" 2

run_pr "$D8" "$CFG_PATH" list --host=claude
assert_exit "list with a claude effort profile" 0
if grep -Eq '^  2 +p-b +claude {20,}low +on PATH$' "$WORK/out"; then
  pass "list shows the effort without a CR"
else
  fail "list shows the effort without a CR" "$(od -c "$WORK/out" | head -c 600)"
fi

# A python3 that is on PATH but does not run (the Windows Store stub) must not
# hide a working `python`: the config still loads. The profile has an effort but
# no model, which must not shift the effort into the model flag.
REAL_PY=""
for _c in python3 python; do
  if command -v "$_c" >/dev/null 2>&1 && "$_c" -c 'import sys; assert sys.version_info >= (3, 7)' >/dev/null 2>&1; then
    REAL_PY="$(command -v "$_c")"; break
  fi
done
if [ -n "$REAL_PY" ]; then
  D14="$WORK/python-probe"
  new_repo "$D14"
  make_stub_cli "$D14/bin/codex"
  printf '#!/usr/bin/env bash\necho "Python was not found" >&2\nexit 9009\n' >"$D14/bin/python3"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$REAL_PY" >"$D14/bin/python"
  chmod +x "$D14/bin/python3" "$D14/bin/python"
  printf '{ "reviewers": { "fast": { "cli": "codex", "effort": "high" } } }\n' >"$D14/.peer-review.json"
  run_pr "$D14" "$D14/bin:$PATH" plan.md --reviewer=fast --host=claude --timeout=5
  assert_exit "config loads past a broken python3" 0
  assert_file_has_line "effort forwarded to codex config" "$ARGS" "model_reasoning_effort=high"
  assert_file_not_contains "effort not misread as model flag" "$ARGS" "--model"
  assert_file_not_contains "no python-missing warning" "$WORK/err" "ignoring config"
fi

# --- real timeout: a reviewer that hangs is cut off, its children included ---
# The grandchild is what a CLI's worker process looks like; it must die too.
cat >"$WORK/hang-stub" <<'EOF'
#!/usr/bin/env bash
if printf '%s\n' "$@" | grep -qx -- '--help'; then
  printf '%s\n' '--sandbox --ephemeral --ignore-user-config --ignore-rules'
  exit 0
fi
( sleep "$PEER_REVIEW_STUB_HANG"; : > "$PEER_REVIEW_STUB_LATE" ) &
wait
printf 'too late\n'
EOF
D9="$WORK/timeout"
new_repo "$D9"
cp "$WORK/hang-stub" "$D9/bin/codex"
chmod +x "$D9/bin/codex"
make_stub_cli "$D9/bin/claude"

# The single run's grandchild would write its marker 3s after it started; the
# multi run below outlasts that, so no extra sleep is needed before the check.
export PEER_REVIEW_STUB_HANG=3 PEER_REVIEW_STUB_LATE="$D9/late-single"
run_pr "$D9" "$D9/bin:$PATH" plan.md --reviewer=codex --host=opencode --timeout=1
assert_exit "a hung single reviewer times out" 124
assert_file_contains "timeout is reported as such" "$WORK/err" "codex timed out after 1s"
assert_file_not_contains "no review saved for the hung reviewer" "$WORK/out" "REVIEW="

export PEER_REVIEW_STUB_HANG=8 PEER_REVIEW_STUB_LATE="$D9/late-multi"
run_pr "$D9" "$D9/bin:$PATH" plan.md --reviewer=codex,claude --host=opencode --timeout=3
assert_exit "one hung reviewer among two" 0
assert_file_contains "multi-reviewer timeout is an ERROR line" "$WORK/err" "ERROR=codex timed out after 3s"
assert_eq "the other reviewer still reports" "REVIEW=claude " "$(reviews_in_out)"
if [ -e "$D9/late-single" ]; then
  fail "timed-out reviewer's process tree is killed" "grandchild wrote $D9/late-single"
else
  pass "timed-out reviewer's process tree is killed"
fi

# --- a chat plan over --stdin-plan runs end to end and leaves no temp plan ---
D10="$WORK/stdin-ok"
new_repo "$D10"
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
assert_file_contains "stdin plan reaches the reviewer prompt" "$D10/prompt.md" "marker-7731"
if [ -e "$D10/.peer-review/tmp" ]; then
  fail "stdin temp plan removed" "$(ls -a "$D10/.peer-review/tmp" | tr '\n' '|')"
else
  pass "stdin temp plan removed"
fi

# --- ANSI stripping keeps the reviewer's line endings and leaves no temp ---
D13="$WORK/ansi"
new_repo "$D13"
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
    new_repo "$D12"
    make_stub_cli "$D12/bin/agy"
    { printf '# Big plan\n\n'; head -c 33000 /dev/zero | tr '\0' 'x'; printf '\n'; } >"$D12/big.md"
    rm -f "$ARGS"
    run_pr "$D12" "$D12/bin:$PATH" big.md --reviewer=agy --host=claude --timeout=5
    assert_exit "agy prompt over the Windows limit" 2
    if [ -e "$ARGS" ]; then
      fail "agy is not started with an oversized prompt" "stub ran"
    else
      pass "agy is not started with an oversized prompt"
    fi

    # 15,000 Hangul syllables are 45,000 UTF-8 bytes but 15,000 UTF-16 units.
    { printf '# Korean plan\n\n'; _i=0; while [ "$_i" -lt 1500 ]; do printf '가나다라마바사아자차'; _i=$((_i + 1)); done; printf '\n'; } >"$D12/ko.md"
    run_pr "$D12" "$D12/bin:$PATH" ko.md --reviewer=agy --host=claude --timeout=5
    assert_exit "a Korean plan under the limit in characters" 0
    ;;
esac

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
