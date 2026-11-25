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
export WORKTREE_CYCLE_PORT_REGISTRY="$WORK/port-registry.json"
# A bare `command -v` is not enough: on Windows `python3` can be the Microsoft Store stub, which
# exists on PATH and fails when run. Same check as scripts/start-worktree.sh.
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
[ -n "$PY" ] || { echo "FAIL  Python 3.10+ not found (tried python3, python)" >&2; exit 1; }
"$PY" "${HERE}/test_ports.py" -q || exit 1
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
    remove-nonempty)
      # Deregistered and mostly emptied, but ignored content (node_modules) survived.
      p="${@: -1}"
      "$WTC_REAL_GIT" "$@" >/dev/null 2>&1 || true
      mkdir -p "$p/node_modules/pkg"
      : > "$p/node_modules/pkg/index.js"
      echo "error: failed to delete '$p': Directory not empty" >&2
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

assert_stdout_contains() {
  if grep -qF -- "$2" "$OUT"; then pass "$1"; else fail "$1" "missing [$2] in stdout"; fi
}

# port_base_of <worktree> — the port base reserved for that worktree, or nothing.
port_base_of() {
  gd="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
  [ -f "$gd/worktree-ports" ] || return 0
  awk -F= '$1 == "WORKTREE_PORT_BASE" { print $2 }' "$gd/worktree-ports"
}

echo "== packaging =="

if [ -x "$START" ]; then pass "start-worktree.sh is executable"; else
  fail "start-worktree.sh is executable" "missing exec bit — commit with 'git add --chmod=+x'"; fi
if [ -x "$FINISH" ]; then pass "finish-worktree.sh is executable"; else
  fail "finish-worktree.sh is executable" "missing exec bit — commit with 'git add --chmod=+x'"; fi

echo "== start-worktree =="

repo="$(new_repo start-happy)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
assert_exit "start creates a worktree" 0
assert_eq "start branches worktree-<name> from local dev HEAD" \
  "$(head_of "$repo" dev)" "$(head_of "$wt" HEAD)"
base1="$(port_base_of "$wt")"
if [ -n "$base1" ] && [ "$base1" -ge 20000 ] && [ "$base1" -le 29990 ] && [ $((base1 % 10)) -eq 0 ]; then
  pass "start reserves a port block inside 20000-29990, on the 10 grid"
else
  fail "start reserves a port block inside 20000-29990, on the 10 grid" "got [$base1]"
fi
# The reservation must never dirty the worktree: finish requires an empty status there,
# untracked included, so a file inside the tree would block every finish from then on.
assert_eq "the reservation leaves the worktree clean" "" "$(git -C "$wt" status --porcelain)"

# The repository path belongs in the hash input. Without it two repositories on one machine
# hand the same worktree name the same block, and they cannot see each other's reservations.
repo2="$(new_repo start-happy-twin)"
run_in "$repo2" "$START" feat1
b="$(port_base_of "$repo2/.worktrees/feat1")"
if [ -n "$base1" ] && [ "$base1" != "$b" ]; then
  pass "the same worktree name in two repositories gets different blocks"
else
  fail "the same worktree name in two repositories gets different blocks" "both got [$base1]"
fi

# The whole point of the skill: a stale base must never come from a remote fallback.
repo="$(new_repo start-no-base)"
git -C "$repo" branch -M main
run_in "$repo" "$START" feat1 --base dev
assert_exit_nonzero "start refuses when the local base branch is missing"
assert_no_dir "start created nothing on failure" "$repo/.worktrees/feat1"

# An empty directory at the target path is the residue Windows leaves behind when finish could
# not rmdir the worktree. start reclaims it; rmdir refuses a non-empty directory.
mkdir -p "$repo/.worktrees/feat1"
run_in "$repo" "$START" feat1
assert_exit "start reclaims an empty leftover directory" 0
assert_dir "the worktree lands at the reclaimed path" "$repo/.worktrees/feat1"

mkdir -p "$repo/.worktrees/feat2"
printf 'keep me\n' > "$repo/.worktrees/feat2/keep.txt"
run_in "$repo" "$START" feat2
assert_exit_nonzero "start refuses an existing path that holds anything"
if [ -f "$repo/.worktrees/feat2/keep.txt" ]; then
  pass "the refusal leaves the existing content untouched"; else
  fail "the refusal leaves the existing content untouched" "keep.txt was destroyed"; fi

# A relative --path must resolve against the caller's directory, not the main worktree.
mkdir -p "$repo/sub"
run_in "$repo/sub" "$START" feat3 --path rel-wt
assert_exit "start accepts a relative --path" 0
assert_dir "relative --path resolves against the caller's cwd" "$repo/sub/rel-wt"

echo "== port allocation =="

# Explicit allocation must use the same collision guard as automatic allocation.
repo="$(new_repo ports-collision)"
run_in "$repo" "$START" feat1
taken="$(port_base_of "$repo/.worktrees/feat1")"
run_in "$repo" "$START" feat2 --port-base "$taken"
assert_exit_nonzero "explicit allocation refuses another worktree's reserved block"
assert_dir "port failure reports a created worktree, not a failed creation" "$repo/.worktrees/feat2"
assert_eq "failed port allocation does not write a reservation" "" "$(port_base_of "$repo/.worktrees/feat2")"
assert_stderr_contains "port failure prints the allocator retry command" "reserve-ports.py --repo"
assert_stderr_not_contains "an allocator refusal does not blame a missing Python" "Python 3.10+ not found"

run_in "$repo" "$START" feat3 --port-base 3000
assert_exit_nonzero "start rejects a --port-base outside the reserved range"

echo "== finish-worktree: happy path =="

repo="$(new_repo finish-happy)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
first="$(port_base_of "$wt")"
commit_in "$wt" work.txt "one"   "wip 1"
commit_in "$wt" work.txt "two"   "wip 2"
head_before="$(head_of "$repo" dev)"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): title" --dry-run
assert_exit "finish --dry-run exits 0" 0
assert_eq "--dry-run does not commit" "$head_before" "$(head_of "$repo" dev)"
assert_dir "--dry-run keeps the worktree" "$wt"
# Repeated -m are paragraphs, as with git commit: the first stays the subject.
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): title" -m "body line"
assert_exit "finish squash-merges and cleans up" 0
assert_eq "finish adds exactly one commit to dev" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_eq "the first -m is the subject" "feat(x): title" "$(git -C "$repo" log -1 --format=%s dev)"
assert_eq "a later -m becomes the body" "body line" "$(git -C "$repo" log -1 --format=%b dev | tr -d '\r')"
assert_eq "finish brings the worktree content over" "two" "$(cat "$repo/work.txt" 2>/dev/null)"
assert_no_dir "finish removes the worktree" "$wt"
if branch_exists "$repo" worktree-feat1; then
  fail "finish deletes the branch" "branch still present"
else
  pass "finish deletes the branch"
fi
assert_no_file "finish removes the port reservation along with the worktree" \
  "$repo/.git/worktrees/feat1/worktree-ports"
run_in "$repo" "$START" feat1
assert_eq "recreating the same worktree name restores the same block" \
  "$first" "$(port_base_of "$repo/.worktrees/feat1")"

echo "== finish-worktree: strategies =="

# merge, chosen through the repository's recorded convention instead of --strategy.
repo="$(new_repo finish-merge)"
git -C "$repo" config worktree-cycle.strategy merge
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip 1"
commit_in "$wt" work.txt "two" "wip 2"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): merged"
assert_exit "finish with worktree-cycle.strategy=merge lands and cleans up" 0
assert_eq "merge keeps both branch commits plus a merge commit" "$((before + 3))" "$(count_commits "$repo" dev)"
assert_eq "the merge commit has two parents" "2" \
  "$(git -C "$repo" rev-list --parents -n 1 dev | awk '{print NF - 1}')"
assert_no_dir "merge removes the worktree" "$wt"

# ff moves base onto the branch tip: no new commit, and no -m needed.
repo="$(new_repo finish-ff)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "feat(x): first"
tip="$(head_of "$repo" worktree-feat1)"
run_in "$repo" "$FINISH" -b worktree-feat1 --strategy ff
assert_exit "finish --strategy ff runs without -m" 0
assert_eq "ff moves base to the branch tip" "$tip" "$(head_of "$repo" dev)"
assert_no_dir "ff removes the worktree" "$wt"

# ff refuses when base moved on, and changes nothing.
run_in "$repo" "$START" feat2
wt="$repo/.worktrees/feat2"
commit_in "$wt"   work.txt  "two"  "wip"
commit_in "$repo" other.txt "dev"  "dev moved"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat2 --strategy ff
assert_exit_nonzero "ff refuses a base that moved on"
assert_eq "a refused ff leaves base where it was" "$head_before" "$(head_of "$repo" dev)"
assert_eq "a refused ff leaves a clean main worktree" "" "$(git -C "$repo" status --porcelain)"
assert_dir "a refused ff keeps the worktree" "$wt"

# Nothing recorded, but base keeps merge commits: finish asks instead of squashing.
repo="$(new_repo finish-strategy-unset-merges)"
git -C "$repo" checkout -q -b side
commit_in "$repo" side.txt "side" "side work"
git -C "$repo" checkout -q dev
git -C "$repo" merge -q --no-ff -m "Merge branch 'side'" side
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): guessed"
assert_exit_nonzero "finish will not guess squash over a base with merge commits"
assert_eq "the refusal changes nothing" "$head_before" "$(head_of "$repo" dev)"

# pr: the server merged the pull request; finish only cleans up, and only once it has landed.
repo="$(new_repo finish-pr-not-landed)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 --strategy pr
assert_exit_nonzero "pr refuses a branch that has not landed"
assert_dir "an unlanded pr keeps the worktree" "$wt"
assert_eq "an unlanded pr leaves base alone" "$head_before" "$(head_of "$repo" dev)"

# Squash-merged on the server: only the remote-tracking base has it, under a new commit, and the
# main worktree sits elsewhere with local edits — none of which matters to a cleanup.
repo="$(new_repo finish-pr-squashed)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip 1"
commit_in "$wt" work.txt "two" "wip 2"
git -C "$repo" checkout -q -b scratch
git -C "$repo" merge -q --squash worktree-feat1 >/dev/null
git -C "$repo" commit -qm "feat(x): squashed by the server (#1)"
git -C "$repo" update-ref refs/remotes/origin/dev scratch
git -C "$repo" reset -q --hard dev
git -C "$repo" checkout -q dev
git -C "$repo" checkout -q -b elsewhere
printf 'local edit\n' > "$repo/file.txt"
dev_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 --strategy pr
assert_exit "pr cleans up a squash-merged branch found on origin/dev" 0
assert_no_dir "pr removes the worktree" "$wt"
if branch_exists "$repo" worktree-feat1; then fail "pr deletes the branch" "branch still present"; else
  pass "pr deletes the branch"; fi
assert_eq "pr does not move local base" "$dev_before" "$(head_of "$repo" dev)"
assert_eq "pr leaves the main worktree's edits alone" "local edit" "$(cat "$repo/file.txt")"

# Partial landing: the server squashed only the first of two commits. pr must refuse — deleting
# here would lose the second commit.
repo="$(new_repo finish-pr-partial)"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" a.txt "a" "add a"
first="$(head_of "$repo" worktree-feat1)"
commit_in "$wt" b.txt "b" "add b"
git -C "$repo" checkout -q -b scratch
git -C "$repo" merge -q --squash "$first" >/dev/null
git -C "$repo" commit -qm "feat(x): only a (#3)"
git -C "$repo" update-ref refs/remotes/origin/dev scratch
git -C "$repo" checkout -q dev
run_in "$repo" "$FINISH" -b worktree-feat1 --strategy pr
assert_exit_nonzero "pr refuses a branch that only partly landed"
assert_dir "a partly landed pr keeps the worktree" "$wt"

# merge=ours keeps base's side in an in-memory merge, so the branch's edit to that file would look
# landed. pr must still refuse when the file differs.
repo="$(new_repo finish-pr-merge-ours)"
printf 'c.txt merge=ours\n' > "$repo/.gitattributes"
printf 'base\n' > "$repo/c.txt"
git -C "$repo" add .gitattributes c.txt
git -C "$repo" commit -qm "attrs"
git -C "$repo" config merge.ours.driver true
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt"   c.txt "from branch" "branch edits c"
commit_in "$repo" c.txt "from dev"    "dev edits c"
run_in "$repo" "$FINISH" -b worktree-feat1 --strategy pr
assert_exit_nonzero "pr refuses a branch whose merge=ours file never landed"
assert_dir "a merge=ours false landing keeps the worktree" "$wt"

# The branch checked out in the main worktree is not a worktree to remove.
repo="$(new_repo finish-pr-main-checkout)"
git -C "$repo" checkout -q -b feature-x
commit_in "$repo" work.txt "one" "wip"
git -C "$repo" checkout -q dev
git -C "$repo" merge -q --no-ff -m "Merge pull request #4" feature-x
git -C "$repo" checkout -q feature-x
run_in "$repo" "$FINISH" -b feature-x --base dev --strategy pr
assert_exit_nonzero "pr refuses a branch checked out in the main worktree"
assert_eq "the main worktree keeps its branch" "feature-x" "$(git -C "$repo" branch --show-current)"

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
assert_eq "dirty-main guard keeps the edit" "edited" "$(cat "$repo/file.txt")"
assert_dir "dirty-main guard keeps the worktree" "$repo/.worktrees/feat1"
git -C "$repo" checkout -q -- file.txt

# The same repo, now with the worktree itself dirty.
wt="$repo/.worktrees/feat1"
printf 'uncommitted\n' > "$wt/work.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): should not run"
assert_exit_nonzero "finish refuses a dirty worktree"
assert_eq "dirty-worktree guard keeps the uncommitted edit" "uncommitted" "$(cat "$wt/work.txt")"
git -C "$wt" checkout -q -- work.txt

# The documented top footgun: running finish from inside the worktree it would delete.
run_in "$wt" "$FINISH" -b worktree-feat1 -m "feat(x): from inside"
assert_exit_nonzero "finish refuses to run from inside the target worktree"
assert_eq "cwd guard changes nothing" "$head_before" "$(head_of "$repo" dev)"
assert_dir "cwd guard keeps the worktree" "$wt"

# An unrelated branch has no merge base, and the collision scan would otherwise die on raw git
# output before printing anything useful.
repo="$(new_repo unrelated-history)"
git -C "$repo" checkout -q --orphan lonely
printf 'orphan\n' > "$repo/orphan.txt"
git -C "$repo" add -A
git -C "$repo" commit -qm "orphan root"
git -C "$repo" checkout -q -f dev
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b lonely -m "feat(x): unrelated" --base dev
assert_exit_nonzero "finish refuses a branch with no common ancestor"
assert_stderr_contains "the refusal names the missing ancestor" "no common ancestor"
assert_eq "the unrelated-history guard changes nothing" "$head_before" "$(head_of "$repo" dev)"

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

# A merge conflict is recovered the same way as a squash conflict.
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): conflicting" --strategy merge
assert_exit_nonzero "finish stops on a merge conflict"
assert_eq "merge conflict recovery leaves dev at its previous commit" "$head_before" "$(head_of "$repo" dev)"
assert_eq "merge conflict recovery leaves a clean main worktree" "" "$(git -C "$repo" status --porcelain)"
assert_no_file "merge conflict recovery clears MERGE_HEAD" "$repo/.git/MERGE_HEAD"

# A run that changes nothing must really leave nothing changed — including the stash.
commit_in "$wt" new.txt "from branch" "add new.txt"
printf 'my draft\n' > "$repo/new.txt"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): conflicting with autostash"
assert_exit_nonzero "a conflict after autostashing still fails"
assert_eq "conflict recovery restores the stashed draft" "my draft" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "conflict recovery leaves no stash behind" "0" "$(stash_count "$repo")"
assert_eq "conflict recovery leaves dev untouched" "$head_before" "$(head_of "$repo" dev)"

echo "== finish-worktree: autostash =="

# The common case: a draft written in the main tree, then committed from the worktree.
# git aborts such a merge, so the colliding files are stashed instead of blocking the run.
# Untracked files the merge does not touch stay out of the stash.
repo="$(new_repo finish-autostash)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" new.txt "from branch" "add new.txt"
printf 'my draft\n' > "$repo/new.txt"
printf 'scratch\n' > "$repo/unrelated.png"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): autostash"
assert_exit "finish autostashes colliding untracked files" 0
assert_eq "the merged content wins in the working tree" "from branch" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "the stash holds the pre-merge draft" \
  "my draft" "$(git -C "$repo" show 'stash@{0}^3:new.txt' 2>/dev/null)"
assert_eq "only the colliding file is stashed" "new.txt" \
  "$(git -C "$repo" ls-tree --name-only 'stash@{0}^3' 2>/dev/null)"
assert_eq "non-colliding untracked files stay put" "scratch" "$(cat "$repo/unrelated.png" 2>/dev/null)"

# Both stashes at once — this is what the push-order contract exists for: the tracked one must
# come back, the untracked one must stay parked.
repo="$(new_repo tracked-and-untracked-autostash)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" new.txt "from branch" "add new.txt"
printf 'edited in main\n' > "$repo/file.txt"
printf 'my draft\n' > "$repo/new.txt"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): both stashes" --autostash-tracked
assert_exit "--autostash-tracked parks and restores tracked changes" 0
assert_eq "the squash commit landed" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_eq "the tracked edit is uncommitted again" \
  " M file.txt" "$(git -C "$repo" status --porcelain -- file.txt)"
assert_eq "the tracked edit came back" "edited in main" "$(cat "$repo/file.txt" 2>/dev/null)"
assert_eq "the merged content wins for the colliding path" "from branch" "$(cat "$repo/new.txt" 2>/dev/null)"
assert_eq "exactly the untracked stash is left" "1" "$(stash_count "$repo")"
assert_eq "and it holds the untracked draft" \
  "my draft" "$(git -C "$repo" show 'stash@{0}^3:new.txt' 2>/dev/null)"

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

# The same Windows leftover, but the directory is still locked (a process has its current
# directory inside it). Everything that could be lost is safe by then and start reclaims the
# empty directory, so the run reports residue and succeeds.
run_in "$repo" "$START" feat2
wt="$repo/.worktrees/feat2"
commit_in "$wt" work2.txt "two" "wip"
before="$(count_commits "$repo" dev)"
with_git_stub remove-empty-locked "$repo" "$FINISH" -b worktree-feat2 -m "feat(x): locked empty shell"
assert_exit "a locked empty leftover does not fail the run" 0
assert_dir "the empty directory survives" "$wt"
assert_eq "the merge still landed" "$((before + 1))" "$(count_commits "$repo" dev)"
if branch_exists "$repo" worktree-feat2; then
  fail "the branch is still deleted" "branch still present"; else pass "the branch is still deleted"; fi

# A worktree git genuinely could not touch (the junction case) stays a failure.
run_in "$repo" "$START" feat3
wt="$repo/.worktrees/feat3"
commit_in "$wt" work3.txt "three" "wip"
before="$(count_commits "$repo" dev)"
with_git_stub remove-hard "$repo" "$FINISH" -b worktree-feat3 -m "feat(x): undeletable"
assert_exit_nonzero "an undeletable worktree fails the run"
assert_dir "the worktree survives" "$wt"
assert_eq "the merge landed even though cleanup failed" "$((before + 1))" "$(count_commits "$repo" dev)"
assert_stderr_contains "a still-registered worktree gets the remove --force advice" "worktree remove --force"

# Deregistered, but content survived: the advice must be the link-safe recipe, not plain rmdir.
# The space in the repository name keeps the quoted-path advice honest.
repo="$(new_repo "cleanup nonempty leftover")"
run_in "$repo" "$START" feat1
wt="$repo/.worktrees/feat1"
commit_in "$wt" work.txt "one" "wip"
with_git_stub remove-nonempty "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): node_modules survived"
assert_exit_nonzero "a non-empty deregistered leftover fails the run"
assert_dir "the leftover is not deleted by the script" "$wt/node_modules"
assert_stderr_contains "the advice deletes without following junctions" "rmdir //s //q \""
assert_stderr_not_contains "the still-registered advice is not given" "worktree remove --force"

echo "== base selection =="

# No --base: the default is the branch the main worktree has checked out, not a fixed "dev".
repo="$(new_repo base-default-main)"
git -C "$repo" branch -M main
run_in "$repo" "$START" feat1
assert_exit "start defaults to the main worktree's branch" 0
assert_eq "the worktree branches from local main HEAD" \
  "$(head_of "$repo" main)" "$(head_of "$repo/.worktrees/feat1" HEAD)"
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
before="$(count_commits "$repo" main)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): onto main"
assert_exit "finish defaults to the same base" 0
assert_eq "finish merged into main" "$((before + 1))" "$(count_commits "$repo" main)"

# git config worktree-cycle.base overrides the default, and finish follows the base recorded at
# start: it refuses while the main worktree is elsewhere rather than merging into dev.
repo="$(new_repo base-config)"
git -C "$repo" branch integ
commit_in "$repo" file.txt "dev only" "dev moves on"
git -C "$repo" config worktree-cycle.base integ
run_in "$repo" "$START" feat1
assert_exit "start honours git config worktree-cycle.base" 0
assert_eq "the worktree branches from the configured base" \
  "$(head_of "$repo" integ)" "$(head_of "$repo/.worktrees/feat1" HEAD)"
git -C "$repo" config --unset worktree-cycle.base
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
head_before="$(head_of "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): recorded base"
assert_exit_nonzero "finish refuses while the main worktree is not on the recorded base"
assert_eq "dev is untouched" "$head_before" "$(head_of "$repo" dev)"
git -C "$repo" checkout -q integ
before="$(count_commits "$repo" integ)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): recorded base"
assert_exit "finish merges into the recorded base once the main worktree is on it" 0
assert_eq "the squash landed on integ" "$((before + 1))" "$(count_commits "$repo" integ)"

# A branch with no recorded base (older, or made by plain `git worktree add`) must not be
# merged into whatever the main worktree happens to be on.
repo="$(new_repo base-unrecorded)"
run_in "$repo" "$START" feat1
commit_in "$repo/.worktrees/feat1" work.txt "one" "wip"
git -C "$repo" config --unset branch.worktree-feat1.worktreeCycleBase
git -C "$repo" checkout -q -b feature-x
before="$(count_commits "$repo" feature-x)"
run_in "$repo" "$FINISH" -b worktree-feat1 -m "feat(x): unrecorded"
assert_exit_nonzero "finish refuses a branch with no recorded base"
assert_eq "feature-x is untouched" "$before" "$(count_commits "$repo" feature-x)"

echo "== base behind its remote counterpart =="

repo="$(new_repo upstream-behind-start)"
fake_remote_ahead "$repo"
run_in "$repo" "$START" feat1
assert_exit "start still branches when the base trails origin" 0
assert_stderr_contains "start reports the trailing base" "behind origin/dev"

echo "== worktree already gone =="

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

# A worktree directory deleted by hand is still registered, and git refuses to delete a branch
# checked out in a registered worktree. finish prunes the stale registration first.
run_in "$repo" "$START" feat2
commit_in "$repo/.worktrees/feat2" work2.txt "two" "wip"
rm -rf "$repo/.worktrees/feat2"
before="$(count_commits "$repo" dev)"
run_in "$repo" "$FINISH" -b worktree-feat2 -m "feat(x): worktree dir deleted by hand"
assert_exit "finish handles a worktree directory deleted by hand" 0
assert_eq "it merges one commit" "$((before + 1))" "$(count_commits "$repo" dev)"
if branch_exists "$repo" worktree-feat2; then
  fail "it deletes the branch despite the stale registration" "branch still present"
else pass "it deletes the branch despite the stale registration"; fi
assert_eq "the stale registration is dropped" "1" "$(git -C "$repo" worktree list --porcelain | grep -c '^worktree ')"

echo "== overlap with other worktrees =="

repo="$(new_repo overlap)"
printf 'shared\n' > "$repo/shared.txt"
printf 'alone\n' > "$repo/alone.txt"
git -C "$repo" add shared.txt alone.txt
git -C "$repo" commit -qm "seed shared files"
run_in "$repo" "$START" first
commit_in "$repo/.worktrees/first" shared.txt "first edit" "first edits shared"
printf 'draft\n' > "$repo/.worktrees/first/draft.txt"
run_in "$repo" "$START" second
assert_exit "start next to an active worktree" 0
assert_stdout_contains "start counts committed and untracked changes of the other worktree" \
  "2 changed: draft.txt, shared.txt"
if grep -q "^    worktree-second " "$OUT"; then fail "start does not list the new worktree itself" "listed"; else
  pass "start does not list the new worktree itself"; fi

commit_in "$repo/.worktrees/second" shared.txt "second edit" "second edits shared"
run_in "$repo" "$FINISH" -b worktree-second -m "feat(x): shared"
assert_exit "finish lands despite a shared file (warning only)" 0
assert_stderr_contains "the warning lists the shared path" "shared.txt"
assert_dir "the other worktree is untouched" "$repo/.worktrees/first"

# A worktree whose branch has no recorded base still compares against worktree-cycle.base.
git -C "$repo" config worktree-cycle.base dev
git -C "$repo" worktree add -q -b manual "$repo/.worktrees/manual" dev
commit_in "$repo/.worktrees/manual" alone.txt "manual edit" "manual edits alone"
run_in "$repo" "$START" third
assert_stdout_contains "a branch without a recorded base is compared with worktree-cycle.base" "1 changed: alone.txt"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
