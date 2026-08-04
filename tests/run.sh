#!/usr/bin/env bash
# Self-contained regression checks for scripts/start-worktree.sh and finish-worktree.sh.
#
# Every case builds a throwaway git repository, runs the real scripts against it, and asserts
# the resulting git state. Pure shell so it runs under Git Bash on Windows too — no process
# substitution, no GNU-only flags.
#
# Run: bash skills/worktree-cycle/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
START="$HERE/../scripts/start-worktree.sh"
FINISH="$HERE/../scripts/finish-worktree.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/worktree-cycle-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

OUT="$WORK/out"
ERR="$WORK/err"
EC=0

# Isolate from the developer's real git configuration and hooks.
export HOME="$WORK/home"
export USERPROFILE="$HOME"
export GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL  %s\n        %s\n' "$1" "$2"
  printf '        stdout: %s\n' "$(tr '\n' '|' < "$OUT" 2>/dev/null | head -c 300)"
  printf '        stderr: %s\n' "$(tr '\n' '|' < "$ERR" 2>/dev/null | head -c 300)"
}

assert_exit() {
  if [ "$EC" = "$2" ]; then pass "$1 [exit $2]"; else fail "$1" "expected exit $2, got $EC"; fi
}
assert_exit_nonzero() {
  if [ "$EC" != "0" ]; then pass "$1 [exit $EC]"; else fail "$1" "expected a non-zero exit, got 0"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi
}
assert_dir() {
  if [ -d "$2" ]; then pass "$1"; else fail "$1" "expected directory to exist: $2"; fi
}
assert_no_dir() {
  if [ ! -d "$2" ]; then pass "$1"; else fail "$1" "expected directory to be gone: $2"; fi
}
assert_stderr_contains() {
  if grep -qF -- "$2" "$ERR"; then pass "$1"; else fail "$1" "missing [$2] in stderr"; fi
}
assert_no_file() {
  if [ ! -f "$2" ]; then pass "$1"; else fail "$1" "expected file to be absent: $2"; fi
}

# run_in <cwd> <script> [args...] — capture stdout/stderr/exit code.
run_in() {
  cwd="$1"; shift
  ( cd "$cwd" && bash "$@" ) >"$OUT" 2>"$ERR"
  EC=$?
}

# new_repo <name> — throwaway repo with one commit on branch `dev`; .worktrees/ excluded.
new_repo() {
  d="$WORK/$1"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name  "Worktree Cycle Tests"
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.autocrlf false
  printf 'base\n' > "$d/file.txt"
  git -C "$d" add file.txt
  git -C "$d" commit -qm "init"
  git -C "$d" branch -M dev
  printf '.worktrees/\n' >> "$d/.git/info/exclude"
  printf '%s' "$d"
}

# commit_in <dir> <file> <content> <message>
commit_in() {
  printf '%s\n' "$3" > "$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -qm "$4"
}

count_commits() { git -C "$1" rev-list --count "$2"; }
head_of()       { git -C "$1" rev-parse "$2"; }
branch_exists() { git -C "$1" show-ref --verify --quiet "refs/heads/$2"; }
stash_count()   { git -C "$1" stash list | grep -c . ; }

# A git shim on PATH that fails one specific subcommand and forwards everything else to the
# real git. The cleanup-failure branch is otherwise unreachable in a test: it needs an OS-level
# refusal to delete a directory.
REAL_GIT="$(command -v git)"
make_git_stub() {
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/git" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "remove" ]; then
  case "${WTC_STUB_MODE:-}" in
    remove-empty)
      # Reproduce what Windows actually does: git deregisters the worktree and deletes its
      # contents, then fails on the final rmdir because the directory is still held open.
      p="${@: -1}"
      "$WTC_REAL_GIT" "$@" >/dev/null 2>&1 || true
      mkdir -p "$p"
      echo "error: failed to delete '$p': Permission denied" >&2
      exit 1
      ;;
    remove-hard)
      echo "error: failed to delete: Permission denied" >&2
      exit 1
      ;;
  esac
fi
if [ "${1:-}" = "branch" ] && [ "${2:-}" = "-D" ] && [ "${WTC_STUB_MODE:-}" = "branch-fail" ]; then
  echo "error: cannot delete branch" >&2
  exit 1
fi
exec "$WTC_REAL_GIT" "$@"
STUB
  chmod +x "$WORK/bin/git"
}

# with_git_stub <mode> <cwd> <script> [args...]
with_git_stub() {
  mode="$1"; shift
  cwd="$1"; shift
  ( cd "$cwd" && PATH="$WORK/bin:$PATH" WTC_STUB_MODE="$mode" WTC_REAL_GIT="$REAL_GIT" bash "$@" ) \
    >"$OUT" 2>"$ERR"
  EC=$?
}

# fake_remote_ahead <repo> — give the repo an origin/dev that is one commit ahead of dev, with
# no upstream configured. That is the real shape seen in the agent-skills repo itself.
fake_remote_ahead() {
  git -C "$1" checkout -q -b tmp-remote
  printf 'remote only\n' > "$1/remote.txt"
  git -C "$1" add remote.txt
  git -C "$1" commit -qm "remote-only commit"
  sha="$(git -C "$1" rev-parse tmp-remote)"
  git -C "$1" checkout -q dev
  git -C "$1" branch -qD tmp-remote
  git -C "$1" update-ref refs/remotes/origin/dev "$sha"
  rm -f "$1/remote.txt"
}

assert_stderr_not_contains() {
  if grep -qF -- "$2" "$ERR"; then fail "$1" "unexpected [$2] in stderr"; else pass "$1"; fi
}

echo "== packaging =="

if [ -x "$START" ]; then pass "start-worktree.sh is executable"; else
  fail "start-worktree.sh is executable" "missing exec bit — commit with 'git add --chmod=+x'"; fi
if [ -x "$FINISH" ]; then pass "finish-worktree.sh is executable"; else
  fail "finish-worktree.sh is executable" "missing exec bit — commit with 'git add --chmod=+x'"; fi

echo "== start-worktree =="

repo="$(new_repo start-happy)"
run_in "$repo" "$START" feat1
assert_exit "start creates a worktree" 0
assert_dir "start uses the default .worktrees path" "$repo/.worktrees/feat1"
assert_eq "start branches worktree-<name> from local dev HEAD" \
  "$(head_of "$repo" dev)" "$(head_of "$repo/.worktrees/feat1" HEAD)"
if branch_exists "$repo" worktree-feat1; then pass "start creates branch worktree-feat1"; else
  fail "start creates branch worktree-feat1" "branch missing"; fi

# The whole point of the skill: a stale base must never come from a remote fallback.
repo="$(new_repo start-no-base)"
git -C "$repo" branch -M main
run_in "$repo" "$START" feat1 --base dev
assert_exit_nonzero "start refuses when the local base branch is missing"
assert_stderr_contains "start explains the missing local branch" "no local branch 'dev'"
assert_no_dir "start created nothing on failure" "$repo/.worktrees/feat1"

repo="$(new_repo start-existing-path)"
mkdir -p "$repo/.worktrees/feat1"
run_in "$repo" "$START" feat1
assert_exit_nonzero "start refuses an existing path"

repo="$(new_repo start-existing-branch)"
git -C "$repo" branch worktree-feat1
run_in "$repo" "$START" feat1
assert_exit_nonzero "start refuses an existing branch"

repo="$(new_repo start-missing-value)"
run_in "$repo" "$START" feat1 --base
assert_exit_nonzero "start rejects a flag with no value"
assert_stderr_contains "start names the flag that lost its value" "--base requires a value"

# A relative --path must resolve against the caller's directory, not the main worktree.
repo="$(new_repo start-relative-path)"
mkdir -p "$repo/sub"
run_in "$repo/sub" "$START" feat1 --path rel-wt
assert_exit "start accepts a relative --path" 0
assert_dir "relative --path resolves against the caller's cwd" "$repo/sub/rel-wt"
assert_no_dir "relative --path is not resolved against the main worktree" "$repo/rel-wt"

repo="$(new_repo start-help)"
run_in "$repo" "$START" --help
assert_exit "start --help exits 0" 0
if head -n 1 "$OUT" | grep -q '/usr/bin/env'; then
  fail "start --help omits the shebang" "first help line was the shebang"
else
  pass "start --help omits the shebang"
fi

echo "== finish-worktree: happy path =="

repo="$(new_repo finish-happy)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one"   "wip 1"
commit_in "$wt" work.txt "two"   "wip 2"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): squashed"
assert_exit "finish squash-merges and cleans up" 0
assert_eq "finish adds exactly one commit to dev" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_eq "finish uses the given commit message" \
  "feat(x): squashed" "$(git -C "$repo" log -1 --format=%s dev)"
assert_eq "finish brings the worktree content over" "two" "$(cat "$repo/work.txt" 2>/dev/null)"
assert_no_dir "finish removes the worktree" "$wt"
if branch_exists "$repo" worktree-feat1; then
  fail "finish deletes the branch" "branch still present"
else
  pass "finish deletes the branch"
fi

# Untracked scratch files in the main tree are explicitly allowed by the guard.
repo="$(new_repo finish-untracked-ok)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
printf 'scratch\n' > "$repo/scratch.png"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): with scratch present"
assert_exit "finish tolerates untracked files in the main tree" 0

echo "== finish-worktree: guards =="

# Each guard must stop before anything is modified.
repo="$(new_repo finish-dirty-main)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
printf 'edited\n' > "$repo/file.txt"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): should not run"
assert_exit_nonzero "finish refuses a dirty main worktree"
assert_eq "dirty-main guard changes nothing" "$head_before" "$(head_of "$repo" dev)"
assert_dir "dirty-main guard keeps the worktree" "$repo/.worktrees/feat1"

repo="$(new_repo finish-dirty-worktree)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
printf 'uncommitted\n' > "$wt/work.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): should not run"
assert_exit_nonzero "finish refuses a dirty worktree"
assert_dir "dirty-worktree guard keeps the worktree" "$wt"

repo="$(new_repo finish-nothing-ahead)"
run_in "$repo" "$START" feat1
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): nothing to merge"
assert_exit_nonzero "finish refuses a branch with no new commits"

repo="$(new_repo finish-wrong-base)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
git -C "$repo" checkout -q -b other
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): wrong base"
assert_exit_nonzero "finish refuses when the main worktree is not on base"

repo="$(new_repo finish-same-branch)"
run_in "$repo" "$FINISH" -b dev -m "feat(x): same branch"
assert_exit_nonzero "finish refuses merging base into itself"

repo="$(new_repo finish-missing-value)"
run_in "$repo" "$FINISH" -b
assert_exit_nonzero "finish rejects a flag with no value"
assert_stderr_contains "finish names the flag that lost its value" "-b/--branch requires a value"

# The documented top footgun: running finish from inside the worktree it would delete.
repo="$(new_repo finish-inside-worktree)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
head_before="$(head_of "$repo" dev)"
run_in "$wt" "$FINISH" -b worktree-feat1 -m "feat(x): from inside"
assert_exit_nonzero "finish refuses to run from inside the target worktree"
assert_stderr_contains "finish explains the cwd problem" "inside the worktree being removed"
assert_eq "cwd guard changes nothing" "$head_before" "$(head_of "$repo" dev)"
assert_dir "cwd guard keeps the worktree" "$wt"

repo="$(new_repo finish-dry-run)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): preview" --dry-run
assert_exit "finish --dry-run exits 0" 0
assert_eq "--dry-run does not commit" "$head_before" "$(head_of "$repo" dev)"
assert_dir "--dry-run keeps the worktree" "$wt"
if branch_exists "$repo" worktree-feat1; then pass "--dry-run keeps the branch"; else
  fail "--dry-run keeps the branch" "branch was deleted"; fi

echo "== finish-worktree: conflict recovery =="

repo="$(new_repo finish-conflict)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt"   file.txt "from worktree" "worktree edit"
commit_in "$repo" file.txt "from dev"      "dev edit"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): conflicting"
assert_exit_nonzero "finish stops on a squash-merge conflict"
assert_eq "conflict recovery leaves dev at its previous commit" "$head_before" "$(head_of "$repo" dev)"
assert_eq "conflict recovery leaves a clean main worktree" "" "$(git -C "$repo" status --porcelain)"
assert_no_file "conflict recovery clears SQUASH_MSG" "$repo/.git/SQUASH_MSG"
assert_dir "conflict recovery keeps the worktree" "$wt"
if branch_exists "$repo" worktree-feat1; then pass "conflict recovery keeps the branch"; else
  fail "conflict recovery keeps the branch" "branch was deleted"; fi

echo "== finish-worktree: untracked files the merge would overwrite =="

# The common case: a draft written in the main tree, then committed from the worktree.
# git aborts such a merge, so the colliding files are stashed instead of blocking the run.
repo="$(new_repo finish-autostash)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" new.txt "from branch" "add new.txt"
printf 'my draft\n' > "$repo/new.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): autostash"
assert_exit "finish autostashes colliding untracked files" 0
assert_eq "the merged content wins in the working tree" "from branch" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "the pre-merge draft is parked in a stash" "1" "$(stash_count "$repo")"
assert_eq "the stash holds the pre-merge draft" \
  "my draft" "$(git -C "$repo" show 'stash@{0}^3:new.txt' 2>/dev/null)"

# --no-autostash keeps it a hard guard, and the message must name the real cause.
repo="$(new_repo finish-no-autostash)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" new.txt "from branch" "add new.txt"
printf 'my draft\n' > "$repo/new.txt"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): blocked" --no-autostash
assert_exit_nonzero "--no-autostash refuses instead of stashing"
assert_stderr_contains "the refusal names the real cause" "would be overwritten by this merge"
assert_stderr_contains "the refusal names the colliding file" "new.txt"
assert_eq "--no-autostash changes nothing" "$head_before" "$(head_of "$repo" dev)"
assert_eq "--no-autostash leaves the draft in place" "my draft" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "--no-autostash creates no stash" "0" "$(stash_count "$repo")"

# Untracked files the merge does not touch must be left completely alone.
repo="$(new_repo finish-untracked-no-collision)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
printf 'scratch\n' > "$repo/unrelated.png"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): unrelated untracked"
assert_exit "non-colliding untracked files do not trigger a stash" 0
assert_eq "non-colliding untracked files are not stashed" "0" "$(stash_count "$repo")"
assert_eq "non-colliding untracked files stay put" "scratch" "$(cat "$repo/unrelated.png" 2>/dev/null)"

# A run that changes nothing must really leave nothing changed — including the stash.
repo="$(new_repo finish-autostash-restore)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" new.txt "from branch" "add new.txt"
printf 'from worktree\n' > "$wt/file.txt"
git -C "$wt" commit -qam "worktree edit"
commit_in "$repo" file.txt "from dev" "dev edit"
printf 'my draft\n' > "$repo/new.txt"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): conflicting with autostash"
assert_exit_nonzero "a conflict after autostashing still fails"
assert_eq "conflict recovery restores the stashed draft" "my draft" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "conflict recovery leaves no stash behind" "0" "$(stash_count "$repo")"
assert_eq "conflict recovery leaves dev untouched" "$head_before" "$(head_of "$repo" dev)"

echo "== finish-worktree: cleanup failures =="

make_git_stub

# Observed for real on Windows: git deregisters and empties the worktree, then cannot rmdir the
# directory. `git worktree remove` would now say "is not a working tree", so the script has to
# finish the job itself rather than hand back advice that cannot work.
repo="$(new_repo cleanup-empty-shell)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
before="$(count_commits "$repo" dev)"
with_git_stub remove-empty "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): empty shell left behind"
assert_exit "an emptied-but-undeletable worktree is finished off" 0
assert_no_dir "the leftover empty directory is removed" "$wt"
assert_eq "the merge still landed" "$((before + 1))" "$(count_commits "$repo" dev)"
if branch_exists "$repo" worktree-feat1; then
  fail "the branch is still deleted" "branch still present"; else pass "the branch is still deleted"; fi

# A worktree git genuinely could not touch (the junction case) stays a failure.
repo="$(new_repo cleanup-hard-fail)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
before="$(count_commits "$repo" dev)"
with_git_stub remove-hard "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): undeletable"
assert_exit_nonzero "an undeletable worktree fails the run"
assert_dir "the worktree survives" "$wt"
assert_eq "the merge landed even though cleanup failed" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_stderr_contains "the report says the merge is done" "do NOT re-run"
assert_stderr_contains "a still-registered worktree gets the remove --force advice" "worktree remove --force"
assert_stderr_not_contains "and not the empty-directory advice" "is not a working tree"

repo="$(new_repo cleanup-branch-fail)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
with_git_stub branch-fail "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): branch stays"
assert_exit_nonzero "a branch that cannot be deleted fails the run"
assert_stderr_contains "the report names the branch cleanup" "branch -D worktree-feat1"

echo "== finish-worktree: --autostash-tracked =="

repo="$(new_repo tracked-guard-message)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
printf 'edited\n' > "$repo/file.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): blocked"
assert_exit_nonzero "tracked changes still stop the run by default"
assert_stderr_contains "the refusal points at the opt-in flag" "--autostash-tracked"

repo="$(new_repo tracked-autostash)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
printf 'edited in main\n' > "$repo/file.txt"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): with tracked autostash" --autostash-tracked
assert_exit "--autostash-tracked parks and restores tracked changes" 0
assert_eq "the squash commit landed" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_eq "the tracked edit is back in the worktree" "edited in main" "$(cat "$repo/file.txt" 2>/dev/null)"
assert_eq "the tracked edit is uncommitted again" \
  " M file.txt" "$(git -C "$repo" status --porcelain -- file.txt)"
assert_eq "no stash is left over" "0" "$(stash_count "$repo")"

# Both stashes at once — this is what the push-order contract exists for: the tracked one must
# come back, the untracked one must stay parked.
repo="$(new_repo tracked-and-untracked-autostash)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" new.txt "from branch" "add new.txt"
printf 'edited in main\n' > "$repo/file.txt"
printf 'my draft\n' > "$repo/new.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): both stashes" --autostash-tracked
assert_exit "both stashes coexist without confusing each other" 0
assert_eq "the tracked edit came back" "edited in main" "$(cat "$repo/file.txt" 2>/dev/null)"
assert_eq "the merged content wins for the colliding path" "from branch" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "exactly the untracked stash is left" "1" "$(stash_count "$repo")"
assert_eq "and it holds the untracked draft" \
  "my draft" "$(git -C "$repo" show 'stash@{0}^3:new.txt' 2>/dev/null)"

echo "== base behind its remote counterpart =="

repo="$(new_repo upstream-behind-start)"
fake_remote_ahead "$repo"
run_in "$repo" "$START" feat1
assert_exit "start still branches when the base trails origin" 0
assert_stderr_contains "start reports the trailing base" "behind origin/dev"
assert_dir "start created the worktree anyway" "$repo/.worktrees/feat1"

commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): preview" --dry-run
assert_exit "finish still runs when the base trails origin" 0
assert_stderr_contains "finish reports the trailing base" "behind origin/dev"

repo="$(new_repo upstream-absent)"
run_in "$repo" "$START" feat1
assert_stderr_not_contains "no remote counterpart means no noise" "behind"

echo "== misc coverage =="

# A branch whose worktree is already gone must still merge and get deleted. This used to die
# with "you are inside the worktree being removed ()" because realdir "" resolved to the
# current directory — `cd ""` succeeds in bash.
repo="$(new_repo branch-without-worktree)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
git -C "$repo" worktree remove --force "$repo/.worktrees/feat1"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): worktree already gone"
assert_exit "finish handles a branch whose worktree is already gone" 0
assert_eq "it still merges one commit" "$((before + 1))" "$(count_commits "$repo" dev)"
if branch_exists "$repo" worktree-feat1; then
  fail "it still deletes the branch" "branch still present"; else pass "it still deletes the branch"; fi

repo="$(new_repo custom-branch-name)"
run_in "$repo" "$START" feat1 --branch my/custom
assert_exit "start accepts a custom --branch" 0
if branch_exists "$repo" my/custom; then pass "the custom branch exists"; else
  fail "the custom branch exists" "branch missing"; fi
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b my/custom -m "feat(x): custom branch"
assert_exit "finish closes a custom branch name" 0
assert_eq "the custom branch merged one commit" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_no_dir "the custom-branch worktree is gone" "$repo/.worktrees/feat1"

# An unrelated branch has no merge base, and the collision scan would otherwise die on raw git
# output before printing anything useful.
repo="$(new_repo unrelated-history)"
git -C "$repo" checkout -q --orphan lonely
printf 'orphan\n' > "$repo/orphan.txt"
git -C "$repo" add -A
git -C "$repo" commit -qm "orphan root"
git -C "$repo" checkout -q -f dev
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b lonely -m "feat(x): unrelated"
assert_exit_nonzero "finish refuses a branch with no common ancestor"
assert_stderr_contains "the refusal names the missing ancestor" "no common ancestor"
assert_eq "the unrelated-history guard changes nothing" "$head_before" "$(head_of "$repo" dev)"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
