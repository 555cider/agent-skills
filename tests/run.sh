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
REAL_RMDIR="$(command -v rmdir)"
make_git_stub() {
  mkdir -p "$WORK/bin"
  cat > "$WORK/bin/git" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "remove" ]; then
  case "${WTC_STUB_MODE:-}" in
    remove-empty|remove-empty-locked)
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

  # The other half of the Windows leftover: even the empty directory refuses to go while a
  # process still has its current directory inside it. That lock is bound to the holding
  # process, not to elapsed time, so nothing the script can do during its own run beats it —
  # retrying and renaming were both measured to fail. The stub makes that state reachable here.
  cat > "$WORK/bin/rmdir" <<'STUB'
#!/usr/bin/env bash
if [ "${WTC_STUB_MODE:-}" = "remove-empty-locked" ]; then
  echo "rmdir: failed to remove '${@: -1}': Device or resource busy" >&2
  exit 1
fi
exec "$WTC_REAL_RMDIR" "$@"
STUB
  chmod +x "$WORK/bin/rmdir"
}

# with_git_stub <mode> <cwd> <script> [args...]
with_git_stub() {
  mode="$1"; shift
  cwd="$1"; shift
  ( cd "$cwd" && PATH="$WORK/bin:$PATH" WTC_STUB_MODE="$mode" \
      WTC_REAL_GIT="$REAL_GIT" WTC_REAL_RMDIR="$REAL_RMDIR" bash "$@" ) \
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

# An empty directory at the target path is the residue Windows leaves behind when finish could
# not rmdir the worktree (see the locked-leftover case below). Refusing it would make that
# residue block the next start under the same name, so start reclaims it instead. rmdir refuses
# a non-empty directory, so nothing real can be destroyed by this.
repo="$(new_repo start-empty-leftover)"
mkdir -p "$repo/.worktrees/feat1"
run_in "$repo" "$START" feat1
assert_exit "start reclaims an empty leftover directory" 0
assert_dir "the worktree lands at the reclaimed path" "$repo/.worktrees/feat1"
assert_eq "the reclaimed worktree still branches from local dev HEAD" \
  "$(head_of "$repo" dev)" "$(head_of "$repo/.worktrees/feat1" HEAD)"

repo="$(new_repo start-existing-path)"
mkdir -p "$repo/.worktrees/feat1"
printf 'keep me\n' > "$repo/.worktrees/feat1/keep.txt"
run_in "$repo" "$START" feat1
assert_exit_nonzero "start refuses an existing path that holds anything"
assert_stderr_contains "the refusal names the path" "already exists"
if [ -f "$repo/.worktrees/feat1/keep.txt" ]; then
  pass "the refusal leaves the existing content untouched"; else
  fail "the refusal leaves the existing content untouched" "keep.txt was destroyed"; fi

repo="$(new_repo start-existing-file)"
mkdir -p "$repo/.worktrees"
printf 'not a directory\n' > "$repo/.worktrees/feat1"
run_in "$repo" "$START" feat1
assert_exit_nonzero "start refuses a plain file at the target path"

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

echo "== port allocation =="

# port_base_of <worktree> — the port base reserved for that worktree, or nothing.
port_base_of() {
  gd="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
  [ -f "$gd/worktree-ports" ] || return 0
  awk -F= '$1 == "WORKTREE_PORT_BASE" { print $2 }' "$gd/worktree-ports"
}

# hash_base_for <repo> <branch> — the block the script derives before any collision walking.
# Mirrors allocate_port_block() so a test can occupy that exact block, and so the repository
# path's presence in the hash input is asserted rather than assumed.
hash_base_for() {
  printf '%s\n%s' "$1" "$2" | cksum | awk '{ print 20000 + ($1 % 1000) * 10 }'
}

repo="$(new_repo ports-basic)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
base1="$(port_base_of "$wt")"
if [ -n "$base1" ] && [ "$base1" -ge 20000 ] && [ "$base1" -le 29990 ] && [ $((base1 % 10)) -eq 0 ]; then
  pass "start reserves a port block inside 20000-29990, on the 10 grid"
else
  fail "start reserves a port block inside 20000-29990, on the 10 grid" "got [$base1]"
fi
assert_eq "the reservation records the block size" "10" \
  "$(awk -F= '$1 == "WORKTREE_PORT_COUNT" { print $2 }' "$repo/.git/worktrees/feat1/worktree-ports")"
assert_eq "the reservation names the branch it belongs to" "worktree-feat1" \
  "$(awk -F= '$1 == "WORKTREE_BRANCH" { print $2 }' "$repo/.git/worktrees/feat1/worktree-ports")"
if grep -q "ports  $base1-$((base1 + 9))" "$OUT"; then
  pass "start reports the reserved block"
else
  fail "start reports the reserved block" "no 'ports $base1-$((base1 + 9))' line in stdout"
fi
# The reservation must never dirty the worktree: finish requires an empty status there,
# untracked included, so a file inside the tree would block every finish from then on.
assert_eq "the reservation leaves the worktree clean" "" "$(git -C "$wt" status --porcelain)"

# main_path_of <repo> — the main worktree path exactly as the script derives it. Git prints a
# native path here (C:/... on Windows), which is not the shell's view of the same directory,
# so a test that wants to reproduce the hash input has to ask git the same way the script does.
main_path_of() {
  git -C "$1" worktree list --porcelain | awk 'NR == 1 && /^worktree /{ print substr($0, 10) }'
}

# The repository path belongs in the hash input. Without it two repositories on one machine
# hand the same worktree name the same block — and they cannot see each other's reservations,
# so nothing downstream catches it.
repo="$(new_repo ports-repo-a)"
repo2="$(new_repo ports-repo-b)"
run_in "$repo"  "$START" feat1
run_in "$repo2" "$START" feat1
a="$(port_base_of "$repo/.worktrees/feat1")"
b="$(port_base_of "$repo2/.worktrees/feat1")"
assert_eq "the block is derived from the repository path and the branch name" \
  "$(hash_base_for "$(main_path_of "$repo")" worktree-feat1)" "$a"
assert_eq "the same derivation holds in a second repository" \
  "$(hash_base_for "$(main_path_of "$repo2")" worktree-feat1)" "$b"
if [ -n "$a" ] && [ "$a" != "$b" ]; then
  pass "the same worktree name in two repositories gets different blocks"
else
  fail "the same worktree name in two repositories gets different blocks" \
    "both got [$a] — either a 1-in-1000 hash collision or the repository path left the input"
fi

repo="$(new_repo ports-distinct)"
run_in "$repo" "$START" feat1
run_in "$repo" "$START" feat2
a="$(port_base_of "$repo/.worktrees/feat1")"
b="$(port_base_of "$repo/.worktrees/feat2")"
if [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ]; then
  pass "two worktrees in one repo get different port blocks"
else
  fail "two worktrees in one repo get different port blocks" "feat1=[$a] feat2=[$b]"
fi

# Collision: park feat2's derived block on feat1's reservation, so allocation has to walk on.
repo="$(new_repo ports-collision)"
run_in "$repo" "$START" feat1
taken="$(hash_base_for "$(main_path_of "$repo")" worktree-feat2)"
printf 'WORKTREE_PORT_BASE=%s\n' "$taken" > "$repo/.git/worktrees/feat1/worktree-ports"
run_in "$repo" "$START" feat2
assert_eq "allocation walks past a block another worktree already reserved" \
  "$(( 20000 + ((((taken - 20000) / 10) + 1) % 1000) * 10 ))" \
  "$(port_base_of "$repo/.worktrees/feat2")"

# Determinism, and the reservation's lifetime: git owns the file, so finish takes it away.
repo="$(new_repo ports-determinism)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
first="$(port_base_of "$wt")"
commit_in "$wt" work.txt "one" "wip"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): squashed"
assert_exit "finish is unaffected by the port reservation" 0
assert_no_file "finish removes the reservation along with the worktree" \
  "$repo/.git/worktrees/feat1/worktree-ports"
run_in "$repo" "$START" feat1
assert_eq "recreating the same worktree name restores the same block" \
  "$first" "$(port_base_of "$repo/.worktrees/feat1")"

repo="$(new_repo ports-explicit)"
run_in "$repo" "$START" feat1 --port-base 24000
assert_exit "start accepts an explicit --port-base" 0
assert_eq "an explicit --port-base is used as given" "24000" \
  "$(port_base_of "$repo/.worktrees/feat1")"

run_in "$repo" "$START" feat2 --port-base 3000
assert_exit_nonzero "start rejects a --port-base outside the reserved range"
assert_stderr_contains "the range rejection names the bounds" "must be between 20000 and 29990"

run_in "$repo" "$START" feat3 --port-base 24005
assert_exit_nonzero "start rejects a --port-base off the block grid"
assert_stderr_contains "the grid rejection names the block size" "must be a multiple of 10"

run_in "$repo" "$START" feat4 --port-base
assert_exit_nonzero "start rejects --port-base with no value"

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

# The same Windows leftover, but the directory is still locked when the script tries to finish
# the job. Measured cause: a process — usually the agent's own shell after a cd, a test runner,
# or an editor — has its current directory inside the worktree, and Windows holds a handle on it
# for that process's lifetime. Retrying and renaming were both measured to fail during the run.
# Everything that could be lost is already safe by then: the squash landed, the branch is gone,
# and git has deregistered the worktree. What is left is an empty directory, and start reclaims
# it, so this is residue rather than incomplete work — the run reports it and succeeds.
repo="$(new_repo cleanup-empty-locked)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
before="$(count_commits "$repo" dev)"
with_git_stub remove-empty-locked "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): locked empty shell"
assert_exit "a locked empty leftover does not fail the run" 0
assert_dir "the empty directory survives" "$wt"
assert_eq "the merge still landed" "$((before + 1))" "$(count_commits "$repo" dev)"
if branch_exists "$repo" worktree-feat1; then
  fail "the branch is still deleted" "branch still present"; else pass "the branch is still deleted"; fi
assert_stderr_contains "the report names the current-directory cause" "current directory"
assert_stderr_contains "the report says the next start reclaims it" "start-worktree.sh"
assert_stderr_not_contains "it is not reported as incomplete cleanup" "cleanup is incomplete"
assert_stderr_not_contains "and does not warn against re-running" "do NOT re-run"

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
