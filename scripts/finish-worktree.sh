#!/usr/bin/env bash
# finish-worktree.sh — merge a finished worktree branch into the local integration branch (one
# squash commit, a merge commit, or a fast-forward — whatever the repository uses), then remove
# the worktree and delete the branch.
#
# Design notes — every guard here exists because the failure it prevents is expensive:
#   - This script NEVER pushes. Publishing the integration branch stays a separate human step.
#   - The worktree base must be the local integration branch HEAD (see start-worktree.sh).
#     A stale base surfaces as a merge conflict; the main worktree is restored and the
#     script stops rather than leaving a half-merged index behind.
#   - A squash merge is not recorded as a merge, so deleting the branch needs -D, not -d.
#   - The main worktree must be clean (tracked files) before merging, so the new commit
#     cannot swallow unrelated staged work and conflict recovery cannot destroy it. pr merges
#     nothing locally and only cleans up, so it skips this.
#   - Cleanup failures are failures: if the worktree or the branch cannot be removed, the
#     script reports what is left over and exits non-zero instead of claiming success.
#   - Untracked files in the main worktree are allowed, but git aborts the merge when an
#     incoming path already exists untracked there (work drafted in the main tree, then
#     committed from the worktree). Those files are stashed automatically — never deleted,
#     never moved aside invisibly — and the stash ref is reported.
#   - Tracked changes in the main worktree stay a hard stop unless --autostash-tracked is
#     given, in which case they are parked and put back after the merge.
#   - A base that trails its remote counterpart is reported, never blocked: this skill works
#     off the LOCAL branch by design. Nothing here touches the network.
#   - Files the branch changes that another active worktree also changes are a warning,
#     never a stop (worktree_overlap.py check; skipped for pr and without Python 3.10+).
#
# Usage (from the MAIN worktree — never from inside the worktree being removed):
#   finish-worktree.sh -b <branch> -m "<conventional commit message>" [-m "<body>" ...]
#                      [-w <worktree-path>] [--base <branch>] [--strategy squash|merge|ff|pr]
#                      [--dry-run] [--no-autostash] [--autostash-tracked]
#
# A relative -w resolves against the directory you invoked the script from.
#
# Strategy (how the branch lands), first match wins: --strategy; git config
# worktree-cycle.strategy; squash.
#   squash  one new commit on base with the -m message (git merge --squash + commit)
#   merge   a merge commit with the -m message, branch history kept (git merge --no-ff)
#   ff      fast-forward base to the branch, no new commit, -m not used (git merge --ff-only);
#           refuses when base has moved — rebase the branch onto base first
#   pr      merge nothing: the branch went through a pull request merged on the server. Only
#           clean up, and only once the branch content is in base — checked against the
#           remote-tracking base (fetch first; this script never touches the network) or the
#           local base, whichever has it. Squash-, rebase- and merge-commit PRs all count.
#
# Base (the branch merged into), first match wins: --base; the base start-worktree.sh recorded on
# the branch (git config branch.<branch>.worktreeCycleBase); git config worktree-cycle.base. With
# none of them the run stops and asks for --base; it never guesses from the main worktree's branch.
#
# Typical flow:
#   1) implement and commit inside the worktree (tests green)
#   2) return to the main worktree, keeping the worktree on disk
#   3) run this script → merge + cleanup
#   4) publish yourself when ready: git push <remote> <base>

set -euo pipefail

BASE=""
BASE_SET=0
STRATEGY=""
STRATEGY_SET=0
BRANCH=""
MSG=""
WT=""
DRY=0
AUTOSTASH=1
AUTOSTASH_TRACKED=0
PWD0="$PWD"   # captured before we move to the main worktree

die()   { echo "‼️  $*" >&2; exit 1; }
info()  { echo "· $*"; }
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; }

# Absolute already? Accept POSIX (/x), MSYS (/c/x) and Windows drive (C:/x, C:\x) forms.
abspath() {
  case "$1" in
    /*|[A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
    *)                  printf '%s\n' "$PWD0/$1" ;;
  esac
}

# Normalize a directory to the shell's own path form so prefix comparison is meaningful.
# Needed on Windows: $PWD is /c/repo while git prints C:/repo, and a naive compare would
# silently skip the "running inside the worktree" guard exactly where it matters most.
# NB: the empty-string check is load-bearing. `cd ""` SUCCEEDS in bash and leaves you where you
# are, so without it realdir "" returns the current directory — which made the guard below
# announce "you are inside the worktree being removed ()" for any branch that has no worktree.
realdir() {
  [ -n "${1:-}" ] || { printf '%s\n' ""; return 0; }
  local dir
  dir="$( (cd "$1" 2>/dev/null && pwd -P) )" || { printf '%s\n' ""; return 0; }
  # Git Bash maps %TEMP% to /tmp for one spelling of a path and not the other, so two
  # names for one directory compared unequal there. cygpath -m gives both one form.
  if command -v cygpath >/dev/null 2>&1; then
    dir="$(cygpath -m "$dir" 2>/dev/null)" || true
  fi
  printf '%s\n' "$dir"
}

# upstream_counterpart <branch> — print a remote-tracking ref worth comparing against, or
# nothing. Reads only refs that are already local; no fetch, no network. @{upstream} alone is
# not enough: a branch can have no upstream configured while refs/remotes/origin/<branch>
# exists and has moved ahead, which is precisely the case that goes unnoticed.
upstream_counterpart() {
  local b="$1" up
  up="$(git rev-parse --abbrev-ref --symbolic-full-name "$b@{upstream}" 2>/dev/null)" || up=""
  if [ -n "$up" ]; then printf '%s\n' "$up"; return 0; fi
  git show-ref --verify --quiet "refs/remotes/origin/$b" && printf '%s\n' "origin/$b"
  return 0
}

# warn_if_base_behind <branch> — advisory only. Branching from and merging into the LOCAL
# branch is the whole point of this skill, so a behind base is reported, never blocked.
warn_if_base_behind() {
  local b="$1" ref n
  ref="$(upstream_counterpart "$b")"
  [ -n "$ref" ] || return 0
  n="$(git rev-list --count "$b..$ref" 2>/dev/null)" || return 0
  [ -n "$n" ] && [ "$n" -gt 0 ] || return 0
  echo "⚠️  local '$b' is $n commit(s) behind $ref (read from refs you already have; no fetch)." >&2
  echo "    Proceeding — this skill works off the local branch by design. Pull first if that matters here." >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    -b|--branch)   [ $# -ge 2 ] || die "-b/--branch requires a value";   BRANCH="$2"; shift 2;;
    # Repeated -m become paragraphs, as with `git commit -m title -m body`.
    -m|--message)  [ $# -ge 2 ] || die "-m/--message requires a value"
                   if [ -n "$MSG" ]; then MSG="$MSG"$'\n\n'"$2"; else MSG="$2"; fi; shift 2;;
    -w|--worktree) [ $# -ge 2 ] || die "-w/--worktree requires a value"; WT="$2";     shift 2;;
    --base)        [ $# -ge 2 ] || die "--base requires a value";        BASE="$2"; BASE_SET=1; shift 2;;
    --strategy)    [ $# -ge 2 ] || die "--strategy requires a value (squash, merge, ff or pr)"
                   STRATEGY="$2"; STRATEGY_SET=1; shift 2;;
    --dry-run)     DRY=1; shift;;
    --autostash)          AUTOSTASH=1; shift;;
    --no-autostash)       AUTOSTASH=0; shift;;
    --autostash-tracked)  AUTOSTASH_TRACKED=1; shift;;
    -h|--help)     usage; exit 0;;
    *) die "unknown argument: $1";;
  esac
done

[ -n "$BRANCH" ] || die "-b/--branch required"
[ "$BASE_SET" = "0" ] || [ -n "$BASE" ] || die "--base requires a branch name"
[ "$STRATEGY_SET" = "0" ] || [ -n "$STRATEGY" ] || die "--strategy requires a value (squash, merge, ff or pr)"
if [ -n "$WT" ]; then WT="$(abspath "$WT")"; fi

# Move to the main worktree so this works from inside any worktree. The list is captured
# first: piping git straight into an early-exit consumer can trip pipefail on SIGPIPE.
WT_LIST="$(git worktree list --porcelain)" || die "not a git repository"
MAIN="$(printf '%s\n' "$WT_LIST" | awk 'NR==1 && /^worktree /{print substr($0,10)}')"
[ -n "$MAIN" ] || die "could not locate the main worktree (is this a git repository?)"
cd "$MAIN"

BASE_SOURCE="--base"
if [ -z "$BASE" ]; then
  BASE="$(git config --get "branch.$BRANCH.worktreeCycleBase" 2>/dev/null)" || BASE=""
  BASE_SOURCE="the base recorded when $BRANCH was started (branch.$BRANCH.worktreeCycleBase)"
fi
if [ -z "$BASE" ]; then
  BASE="$(git config --get worktree-cycle.base 2>/dev/null)" || BASE=""
  BASE_SOURCE="git config worktree-cycle.base"
fi
if [ -z "$BASE" ]; then
  # No record: the branch predates recorded bases or was made by a plain `git worktree add`.
  # Merging into whatever the main worktree happens to be on could land it on the wrong
  # branch, so the caller names the base.
  cur_branch="$(git symbolic-ref --short -q HEAD 2>/dev/null)" || cur_branch=""
  die "no base is recorded for $BRANCH and worktree-cycle.base is unset. Pass --base <branch>${cur_branch:+ (the main worktree is on '$cur_branch')}"
fi
git show-ref --verify --quiet "refs/heads/$BASE" \
  || die "base '$BASE' from $BASE_SOURCE does not exist as a local branch. Pass --base <branch> to choose another"

[ "$BRANCH" != "$BASE" ] || die "the target branch is the same as base ($BASE)"

STRATEGY_SOURCE="--strategy"
if [ -z "$STRATEGY" ]; then
  # Per base first: one repository can squash feature → dev and fast-forward hotfix → main.
  STRATEGY="$(git config --get "branch.$BASE.worktreeCycleStrategy" 2>/dev/null)" || STRATEGY=""
  STRATEGY_SOURCE="git config branch.$BASE.worktreeCycleStrategy"
fi
if [ -z "$STRATEGY" ]; then
  STRATEGY="$(git config --get worktree-cycle.strategy 2>/dev/null)" || STRATEGY=""
  STRATEGY_SOURCE="git config worktree-cycle.strategy"
fi
if [ -z "$STRATEGY" ]; then
  # Nothing recorded. Squash is the default, but a base whose recent first-parent history has
  # merge commits lands work some other way (merge commits or pull requests); squashing there
  # would quietly break its convention, so ask instead of guessing.
  # "Recent" = the last 50 first-parent commits; a line with more than two hashes is a merge.
  recent_merge="$(git rev-list --first-parent --parents --max-count=50 "$BASE" 2>/dev/null \
                    | awk 'NF > 2 { print $1; exit }')"
  if [ -n "$recent_merge" ]; then
    die "no strategy is recorded and '$BASE' has merge commits in its recent history, so it may land work as merge commits or pull requests — not squash. Nothing was changed.
    Pass --strategy squash|merge|ff|pr, and record it: git config worktree-cycle.strategy <s>
    (or per base: git config branch.$BASE.worktreeCycleStrategy <s>)."
  fi
  STRATEGY=squash; STRATEGY_SOURCE="default"
fi
case "$STRATEGY" in
  squash|merge|ff|pr) ;;
  *) die "unknown strategy '$STRATEGY' from $STRATEGY_SOURCE — use squash, merge, ff or pr";;
esac
if [ "$STRATEGY" = "ff" ] || [ "$STRATEGY" = "pr" ]; then
  # Neither makes a commit here, so there is nothing for -m to name. Say so instead of
  # silently dropping a message the caller expected to see in the log.
  [ -z "$MSG" ] || info "strategy $STRATEGY makes no new commit — the -m message is not used"
else
  [ -n "$MSG" ] || die "-m/--message required for strategy $STRATEGY (Conventional Commits: 'feat(scope): …')"
fi

# Resolve the worktree path from the branch when it was not given.
if [ -z "$WT" ]; then
  WT="$(printf '%s\n' "$WT_LIST" | awk -v b="branch refs/heads/$BRANCH" '
    /^worktree /{p=substr($0,10)}
    $0==b && !found {print p; found=1}')"
fi
# The branch checked out in the main worktree is not a worktree to clean up — "its worktree"
# would be the main tree. Only reachable under pr (the other strategies require the main tree on
# base), but checked for every strategy so the cleanup below can never aim at $MAIN.
if [ -n "$WT" ] && [ "$(realdir "$WT")" = "$(realdir "$MAIN")" ]; then
  die "'$BRANCH' is checked out in the main worktree ($MAIN), not in a worktree of its own. Switch the main worktree to another branch first; nothing was changed"
fi

# ── guards (nothing is modified until all of them pass) ──────────────────────
# A. The caller must not be standing inside the worktree we are about to delete.
#    On Windows the removal fails outright because the OS locks a process' cwd; on POSIX it
#    succeeds and leaves the caller's shell in a directory that no longer exists.
WT_REAL="$(realdir "$WT")"
if [ -n "$WT" ] && [ -n "$WT_REAL" ]; then
  PWD_REAL="$(realdir "$PWD0")"
  [ -n "$PWD_REAL" ] || PWD_REAL="$PWD0"
  case "$PWD_REAL/" in
    "$WT_REAL"/*) die "you are inside the worktree being removed ($WT). cd to the main worktree ($MAIN) first";;
  esac
fi

# B. The main worktree is on base with a clean TRACKED tree. This keeps the squash commit
#    from swallowing someone else's staged work, and keeps conflict recovery (reset --hard)
#    from destroying it. Untracked scratch files (screenshots, plans) are fine.
#    pr merges nothing into the main worktree, so neither condition applies to it.
TRACKED_DIRTY=0
if [ "$STRATEGY" != "pr" ]; then
cur="$(git rev-parse --abbrev-ref HEAD)"
[ "$cur" = "$BASE" ] || die "the main worktree is on '$cur', not '$BASE'. Switch to '$BASE' first"
if ! { git diff --quiet && git diff --cached --quiet; }; then
  [ "$AUTOSTASH_TRACKED" = "1" ] \
    || die "the main worktree has uncommitted changes to tracked files — commit or stash them first, or pass --autostash-tracked to park them across the merge (untracked scratch files are fine)"
  TRACKED_DIRTY=1
fi
fi

# C. The branch exists and actually has something to merge — or, for pr, has already landed.
git show-ref --verify --quiet "refs/heads/$BRANCH" || die "no such branch: '$BRANCH'"

# content_in <ref> — the branch's changes are already in <ref>. Ancestry covers merge-commit and
# fast-forward PRs; a squash or rebase PR rewrites the commits, so the second test merges the
# branch into <ref> in memory and asks whether that changes anything.
#
# The in-memory merge honours .gitattributes merge drivers, and a driver that keeps "ours"
# (merge=ours on a CHANGELOG or lockfile) drops the branch's edit and still returns ref's tree —
# a false "landed" that would delete unmerged work. So every path the branch changed that has a
# merge driver must be byte-identical in ref. That can refuse a landed PR whose file base changed
# again later; refusing is the safe side, and the message says what to do.
content_in() {
  local ref="$1" tree mb path attr
  git merge-base --is-ancestor "$BRANCH" "$ref" 2>/dev/null && return 0
  tree="$(git merge-tree --write-tree "$ref" "$BRANCH" 2>/dev/null)" || return 1
  [ "$tree" = "$(git rev-parse "$ref^{tree}")" ] || return 1
  mb="$(git merge-base "$ref" "$BRANCH" 2>/dev/null)" || return 1
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    attr="$(git check-attr --source="$BRANCH" merge -- "$path" 2>/dev/null | sed 's/.*: merge: //')"
    case "$attr" in unspecified|set|unset|"") continue ;; esac
    [ "$(git rev-parse -q --verify "$ref:$path" 2>/dev/null)" = "$(git rev-parse -q --verify "$BRANCH:$path" 2>/dev/null)" ] \
      || return 1
  done <<EOF
$(git diff --name-only "$mb" "$BRANCH" 2>/dev/null)
EOF
  return 0
}
LANDED_REF=""
LANDED_ON="$BASE"   # where the result lives, for the closing messages
if [ "$STRATEGY" = "pr" ]; then
  ahead=0
  for ref in "$(upstream_counterpart "$BASE")" "$BASE"; do
    [ -n "$ref" ] || continue
    if content_in "$ref"; then LANDED_REF="$ref"; break; fi
  done
  remote_ref="$(upstream_counterpart "$BASE")"
  [ -n "$LANDED_REF" ] || die "'$BRANCH' is not in ${remote_ref:+$remote_ref or }$BASE yet, so the pull request has not landed — nothing was changed.
    Fetch first if it was merged on the server (git fetch), then re-run. If base has since changed
    the same lines again, this check cannot see the PR; remove the worktree and branch by hand."
  LANDED_ON="$LANDED_REF"
else
  ahead="$(git rev-list --count "$BASE..$BRANCH")"
  [ "$ahead" -gt 0 ] || die "'$BRANCH' has no commits beyond '$BASE' (nothing to merge)"
  # ff can only move base forward. Say so now, before the dry-run exit and before any stash,
  # instead of discovering it mid-run.
  if [ "$STRATEGY" = "ff" ] && ! git merge-base --is-ancestor "$BASE" "$BRANCH"; then
    die "fast-forward impossible — nothing was changed. '$BASE' has commits that '$BRANCH' does not.
    Rebase the branch onto '$BASE' inside its worktree (git -C \"${WT:-<worktree>}\" rebase $BASE),
    verify again, then re-run."
  fi
fi

# D. The worktree itself is clean, so nothing uncommitted is lost when it is removed.
if [ -n "$WT" ] && [ -d "$WT" ]; then
  [ -z "$(git -C "$WT" status --porcelain)" ] || die "the worktree ($WT) has uncommitted changes. Commit them first"
fi

# E. Untracked files in the main worktree that the merge would overwrite. Guard B deliberately
#    lets untracked scratch files through, but git aborts the merge when an incoming path
#    already exists untracked here — the common case being work drafted in the main tree and
#    then committed from the worktree. Detect it now so the failure is named accurately instead
#    of surfacing later as a misleading "conflict".
incoming=""
[ "$STRATEGY" = "pr" ] || incoming="$(git diff --name-only "$BASE...$BRANCH" 2>/dev/null)" \
  || die "'$BRANCH' and '$BASE' have no common ancestor, so this is not a worktree branched from '$BASE'. Nothing was changed; merge by hand if that is really what you want"
untracked="$(git ls-files --others --exclude-standard)"
collide="$(
  { printf '%s\n' "$untracked" | sed 's/^/U\t/'
    printf '%s\n' "$incoming"  | sed 's/^/I\t/'
  } | awk -F'\t' '
      $1=="U" && $2!="" { u[$2]; next }
      $1=="I" && $2!="" && ($2 in u) { print $2 }'
)"
COLLIDE_N=0
COLLIDE_LIST=()
while IFS= read -r line; do
  [ -n "$line" ] && COLLIDE_LIST+=("$line")
done <<EOF
$collide
EOF
COLLIDE_N="${#COLLIDE_LIST[@]}"

if [ "$COLLIDE_N" -gt 0 ] && [ "$AUTOSTASH" = "0" ]; then
  die "$COLLIDE_N untracked file(s) in the main worktree would be overwritten by this merge:
    $(printf '%s ' "${COLLIDE_LIST[@]}")
    Move or delete them, or drop --no-autostash to let them be stashed automatically."
fi

warn_if_base_behind "$BASE" || true

# F. Advisory: files this branch changes that another active worktree also changes. Never
#    blocks (landing first is legitimate); the other worktree has to rebase and re-check.
#    Same judgement as plan-graph's `overlap` (scripts/worktree_overlap.py is a shared copy).
#    pr already landed on the server, so there is nothing left to warn about.
if [ "$STRATEGY" != "pr" ]; then
  OVERLAP_PY=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
      OVERLAP_PY="$candidate"; break
    fi
  done
  if [ -n "$OVERLAP_PY" ]; then
    "$OVERLAP_PY" "$(cd "$(dirname "$0")" && pwd)/worktree_overlap.py" check \
      --repo "$MAIN" --branch "$BRANCH" --base "$BASE" ${WT:+--exclude "$WT"} || true
  else
    info "overlap check skipped: Python 3.10+ not found"
  fi
fi

echo "──────────────────────────────────────────────"
if [ "$STRATEGY" = "pr" ]; then
  echo " base             : $BASE  (branch content found in $LANDED_REF @ $(git rev-parse --short "$LANDED_REF"))"
  echo " branch           : $BRANCH  (landed through a pull request — cleanup only)"
else
  echo " base (main tree) : $BASE @ $(git rev-parse --short HEAD)"
  echo " merge branch     : $BRANCH  (+$ahead commit)"
fi
echo " worktree         : ${WT:-<none found>}"
echo " strategy         : $STRATEGY  ($STRATEGY_SOURCE)"
case "$STRATEGY" in ff|pr) ;; *) echo " message          : $MSG" ;; esac
echo " push             : NO  (this script never pushes)"
[ "$COLLIDE_N" -gt 0 ] && echo " autostash        : $COLLIDE_N untracked file(s) the merge would overwrite"
[ "$TRACKED_DIRTY" = "1" ] && echo " autostash        : tracked changes parked and restored after the commit"
echo "──────────────────────────────────────────────"
[ "$DRY" = "1" ] && { info "dry-run — stopping here (nothing was changed)"; exit 0; }

# ── execute ─────────────────────────────────────────────────────────────────
# Serialize against other finishes in this repository.
#
# Every worktree shares ONE index and ONE main working tree, so two finishes are not
# independent: `git merge --squash` STAGES its result without committing, and a second finish
# then sees that staged work as "local changes", fails, and its recovery discards it. Guard B
# cannot prevent that — it looks once, and the other session can stage in the window that
# follows. The mutating half therefore runs under an exclusive lock, taken in the COMMON git
# dir so every worktree of the repository contends for the same one (unlike $GIT_DIR).
LOCK="$(git rev-parse --git-common-dir)/worktree-cycle-finish.lock"
LOCK_HELD=""
release_lock() { if [ -n "${LOCK_HELD:-}" ]; then rm -rf "$LOCK"; LOCK_HELD=""; fi; }
if mkdir "$LOCK" 2>/dev/null; then
  LOCK_HELD=1
  printf '%s
' "$$" > "$LOCK/pid"
else
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  # A lock whose owner is gone is stale — a killed run must not block the repository forever.
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    info "removing a stale finish lock left by pid $holder"
    rm -rf "$LOCK"
    if mkdir "$LOCK" 2>/dev/null; then LOCK_HELD=1; printf '%s
' "$$" > "$LOCK/pid"; fi
  fi
  [ -n "$LOCK_HELD" ] || die "another worktree-cycle finish is running here (pid ${holder:-unknown}).
    Two finishes share one index and one working tree, so running them at once can destroy the
    other one's staged merge. Wait for it to finish, then re-run."
fi
trap 'release_lock' EXIT

STASHED=0; STASH_SHA=""; TSTASHED=0

# pr merged on the server: nothing to stash, merge or commit here — straight to cleanup.
if [ "$STRATEGY" = "pr" ]; then
  newsha="$(git rev-parse --short "$LANDED_REF")"
  info "'$BRANCH' is already in $LANDED_REF ($newsha) — cleaning up"
else

# Guard B again, now that the lock is held. The first check ran before the lock existed, so
# anything another session staged in between is only visible now.
if [ "$TRACKED_DIRTY" = "0" ] && ! { git diff --quiet && git diff --cached --quiet; }; then
  die "the main worktree gained uncommitted tracked changes while this run was starting —
    another session is probably mid-merge. Nothing was changed; re-run once it settles."
fi

# 0) Park the colliding untracked files in a stash. Nothing is deleted: a stash is recoverable
#    and visible in `git stash list`, unlike moving the files aside by hand.
# Stash ORDER IS A CONTRACT. `git stash pop`/`drop` reject a raw commit SHA ("is not a stash
# reference"), so entries must be addressed positionally as stash@{0} — which makes the push
# order the only thing keeping them apart. Untracked collisions go in FIRST (kept after a
# successful merge, since the merge supersedes them) and tracked changes SECOND (popped after
# the commit). So right after the commit, stash@{0} is always the tracked one, and once it is
# popped the untracked one takes its place at stash@{0} — which is what the closing report
# points at.
STASHED=0          # untracked-collision stash exists
STASH_SHA=""
TSTASHED=0         # tracked-changes stash exists (--autostash-tracked only)
if [ "$COLLIDE_N" -gt 0 ]; then
  # --pathspec-from-file keeps a large collision set off the command line, where Windows caps
  # the total argv length.
  printf '%s\0' "${COLLIDE_LIST[@]}" \
    | git stash push -u -m "worktree-cycle: untracked files overwritten by $BRANCH → $BASE" \
        --pathspec-from-file=- --pathspec-file-nul \
    || die "could not stash the colliding untracked files — nothing was merged"
  STASHED=1
  STASH_SHA="$(git rev-parse -q --verify 'stash@{0}')" || STASH_SHA=""   # display / stash show only
  info "stashed $COLLIDE_N untracked file(s) into stash@{0}${STASH_SHA:+ ($(git rev-parse --short "$STASH_SHA"))}"
fi

if [ "$TRACKED_DIRTY" = "1" ]; then
  git stash push -m "worktree-cycle: tracked changes parked across $BRANCH → $BASE" \
    || die "could not stash the tracked changes — nothing was merged"
  TSTASHED=1
  info "stashed the main worktree's tracked changes (restored after the commit)"
fi

# restore_untracked_stash — put the parked untracked files back after a failed merge, so a run
# that changed nothing really leaves nothing changed.
restore_untracked_stash() {
  [ "$STASHED" = "1" ] || return 0
  if git stash pop --index 'stash@{0}' >/dev/null 2>&1 || git stash pop 'stash@{0}' >/dev/null 2>&1; then
    STASHED=0
    info "restored the stashed untracked file(s)"
  else
    echo "⚠️  could not restore the stashed untracked file(s) automatically." >&2
    echo "    They are safe in the stash: git stash pop stash@{0}" >&2
  fi
}

# restore_tracked_stash — returns 0 when the tracked changes are back in the worktree.
restore_tracked_stash() {
  [ "$TSTASHED" = "1" ] || return 0
  if git stash pop --index 'stash@{0}' >/dev/null 2>&1 || git stash pop 'stash@{0}' >/dev/null 2>&1; then
    TSTASHED=0
    info "restored the main worktree's tracked changes"
    return 0
  fi
  echo "⚠️  could not restore the stashed tracked changes automatically." >&2
  echo "    They are safe in the stash: git stash pop stash@{0}" >&2
  return 1
}

# Undo both stashes, newest first, so each pop addresses stash@{0}.
restore_all_stashes() {
  restore_tracked_stash || true
  restore_untracked_stash
}

# 1) Merge. On conflict, restore the main worktree — safe because the tree is clean by now,
#    either because guard B proved it or because --autostash-tracked parked the changes.
#    squash and merge both stop before committing, so step 2 commits them the same way (for
#    merge, MERGE_HEAD makes that commit the merge commit). ff has nothing to commit.
case "$STRATEGY" in
  squash) merge_cmd=(git merge --squash "$BRANCH") ;;
  merge)  merge_cmd=(git merge --no-ff --no-commit "$BRANCH") ;;
  ff)     merge_cmd=(git merge --ff-only "$BRANCH") ;;
esac
if ! "${merge_cmd[@]}"; then
  # (ff divergence was refused in guard C; an ff failure here is the generic refusal below.)
  # Two very different failures land here, and only one of them may be reset.
  #
  # Unmerged index entries mean the merge really ran and left conflicts in the tree. A
  # conflicted squash records no MERGE_HEAD, so `git merge --abort` cannot be used ("no merge
  # to abort"); `reset --hard` is the recovery for both strategies — it also clears SQUASH_MSG,
  # and MERGE_HEAD for a real merge.
  if [ -n "$(git ls-files -u)" ]; then
    git reset --hard HEAD
    restore_all_stashes
    die "$STRATEGY merge conflicted → main worktree restored, nothing committed. The branch content overlaps changes already on '$BASE'; check that '$BRANCH' was branched from '$BASE' HEAD, then merge by hand"
  fi
  # Otherwise git refused BEFORE modifying anything — typically "local changes would be
  # overwritten". Resetting here would throw away exactly what made it refuse, which is not
  # ours to discard. Leave the tree as found and say so.
  restore_all_stashes
  die "$STRATEGY merge refused before modifying anything — the tree was left untouched (no reset).
    Usual cause: '$BASE' carries local changes to paths '$BRANCH' also touches, often another
    session's staged merge. Inspect with 'git -C \"$MAIN\" status', let it settle or commit
    those changes, then re-run."
fi

# 2) Commit (squash, merge). -F keeps multi-line messages intact and avoids any argv quoting
#    surprises. A fast-forward already moved base, so there is nothing to commit.
if [ "$STRATEGY" != "ff" ]; then
msgfile="$(mktemp)"
trap 'rm -f "$msgfile"; release_lock' EXIT
printf '%s\n' "$MSG" > "$msgfile"
if ! git commit -F "$msgfile"; then
  # The stash is deliberately NOT popped here: the merge already wrote those paths into the
  # working tree, so a pop would fail or clobber. Name the ref instead.
  stash_note=""
  [ "$TSTASHED" = "1" ] && stash_note="$stash_note
    Your tracked changes are parked in the newest stash: git stash pop stash@{0}"
  [ "$STASHED" = "1" ] && stash_note="$stash_note
    Your stashed untracked file(s) are parked too — see 'git stash list'."
  why="a rejecting hook"
  [ "$STRATEGY" = "squash" ] && why="a rejecting hook, or an empty diff when
    '$BRANCH' carries commits whose changes are already in '$BASE'"
  die "commit failed after a successful $STRATEGY merge ($why).
    The merged changes are STAGED in $MAIN — inspect with 'git -C \"$MAIN\" status'.
    To discard them: git -C \"$MAIN\" reset --hard HEAD.
    Nothing was removed; the worktree and branch '$BRANCH' are untouched.$stash_note"
fi
fi
newsha="$(git rev-parse --short HEAD)"
if [ "$STRATEGY" = "ff" ]; then
  info "$BASE fast-forwarded to $newsha"
else
  info "new commit on $BASE: $newsha"
fi
fi   # end of the local merge (everything but pr)

# 2b) Give the tracked changes back now that the squash commit exists. A pop conflict leaves
#     them in the stash — reported as leftover state, like any other incomplete cleanup.
tracked_restore_failed=0
if [ "$TSTASHED" = "1" ]; then
  restore_tracked_stash || tracked_restore_failed=1
fi

# 3) Remove the worktree. --force is safe here because guard D proved it clean.
#    A worktree whose node_modules is a junction/symlink can still refuse to go; that is
#    reported below rather than worked around, because deleting through a junction destroys
#    the original directory.
cleanup_failed="$tracked_restore_failed"
WT_LEFTOVER=""          # directory that survived; decides which recovery advice applies
WT_REGISTERED=0         # 1 = git still considers it a worktree (the junction case)
WT_RESIDUE=""           # empty, deregistered directory that could not be removed — not a failure
BRANCH_LEFTOVER=0
WT_GONE=0               # 1 = the directory was already missing (deleted by hand), registration stale
if [ -n "$WT" ] && [ ! -e "$WT" ]; then WT_GONE=1; fi
if [ -n "$WT" ] && [ -d "$WT" ]; then
  if git worktree remove --force "$WT"; then
    info "worktree removed: $WT"
  elif [ ! -d "$WT" ]; then
    info "worktree removed: $WT"
  elif rmdir "$WT" 2>/dev/null; then
    # Observed for real on Windows: git deregisters the worktree and deletes its contents, then
    # fails on the final rmdir because the OS keeps a directory locked while any process holds
    # it open. `git worktree remove` would now answer "is not a working tree", so the advice we
    # used to print could not work. Finish the job instead — rmdir refuses a non-empty
    # directory, so this can never delete real work. (Do not probe with `rev-parse --git-dir`:
    # from any directory inside the repository that succeeds by finding the parent repo.)
    info "worktree removed: $WT (git left an empty directory behind; removed it)"
  elif [ ! -e "$WT/.git" ] && [ -z "$(ls -A "$WT" 2>/dev/null)" ]; then
    # Same Windows leftover as above, except the empty directory refuses to go too. Measured
    # cause: a process has its current directory inside the worktree — usually the shell that
    # cd'd in, a test run, or an editor — and Windows holds a handle on that directory for the
    # life of that process. The lock is bound to that process, not to elapsed time, so nothing
    # this run can do beats it: retrying rmdir and renaming the directory were both measured to
    # fail while the holder is alive, and it clears on its own once that process exits.
    #
    # Nothing is at risk by this point. The squash landed, the branch is deleted below, git has
    # deregistered the path (no .git file), and the directory is empty. start-worktree.sh
    # reclaims an empty directory, so the residue does not even block reusing the name. Report
    # it and succeed — calling this a failed cleanup would put a red light on every Windows run
    # and train the reader to ignore the one that means something.
    WT_RESIDUE="$WT"
  else
    cleanup_failed=1; WT_LEFTOVER="$WT"
    # A linked worktree always carries a .git file; its presence separates "git could not touch
    # this at all" from "git emptied it but the directory survived".
    [ -e "$WT/.git" ] && WT_REGISTERED=1
    echo "⚠️  could not remove the worktree: $WT" >&2
  fi
fi

# 4) Delete the branch with -D: a squash merge is not recorded as a merge, so -d refuses it
#    (merge and ff would pass -d, but one command keeps the paths alike).
#    A worktree directory deleted by hand is still registered, and git will not delete a branch
#    checked out in a registered worktree. Drop that one stale registration first — `remove
#    --force` on a missing directory deregisters just it, unlike a repository-wide prune.
if [ "$WT_GONE" = "1" ]; then
  git worktree remove --force "$WT" >/dev/null 2>&1 && info "dropped the registration of the missing worktree: $WT"
fi
if git branch -D "$BRANCH"; then
  info "branch deleted: $BRANCH"
else
  cleanup_failed=1; BRANCH_LEFTOVER=1
  echo "⚠️  could not delete the branch: $BRANCH" >&2
fi

if [ -n "$WT_RESIDUE" ]; then
  echo >&2
  echo "⚠️  an empty directory is left behind: $WT_RESIDUE" >&2
  echo "    Everything that matters is done — the $STRATEGY result is on $LANDED_ON, the branch is gone, and" >&2
  echo "    git no longer tracks this path. On Windows a directory cannot be deleted while any" >&2
  echo "    process has its current directory inside it (a shell that cd'd in, a test run, an" >&2
  echo "    editor). That handle outlives this run, so retrying here cannot clear it." >&2
  echo "    Nothing is blocked: start-worktree.sh reclaims an empty directory. To remove it now," >&2
  echo "    run this from a shell that is not standing in it:  rmdir \"$WT_RESIDUE\"" >&2
fi

if [ "$cleanup_failed" -ne 0 ]; then
  echo >&2
  echo "‼️  merged, but cleanup is incomplete." >&2
  echo "    The $STRATEGY result $newsha IS on $LANDED_ON — do NOT re-run this script." >&2
  echo "    Finish by hand:" >&2
  if [ -n "$WT_LEFTOVER" ] && [ "$WT_REGISTERED" = "1" ]; then
    echo "      - the worktree is still registered. If node_modules (or similar) is a junction," >&2
    echo "        unlink it first — on Windows: cmd //c rmdir \"$WT_LEFTOVER\\node_modules\"" >&2
    echo "        (never rm -rf / Remove-Item -Recurse: those delete through the link and" >&2
    echo "        destroy the original directory), then:" >&2
    echo "          git -C \"$MAIN\" worktree remove --force \"$WT_LEFTOVER\"" >&2
  elif [ -n "$WT_LEFTOVER" ]; then
    # Content that survived deregistration is usually the worktree's own node_modules, which
    # may hold junctions. A recursive delete that follows them destroys their targets.
    wt_native="$WT_LEFTOVER"
    if command -v cygpath >/dev/null 2>&1; then wt_native="$(cygpath -w "$WT_LEFTOVER" 2>/dev/null)" || wt_native="$WT_LEFTOVER"; fi
    echo "      - git already deregistered this worktree, so 'git worktree remove' will answer" >&2
    echo "        \"is not a working tree\". Only the directory is left, with content in it." >&2
    echo "        1. confirm every link inside points into the worktree itself:" >&2
    echo "             PowerShell: Get-ChildItem -Force \"$wt_native\" -Recurse -Depth 2 -Attributes ReparsePoint | % Target" >&2
    echo "             POSIX:      find \"$WT_LEFTOVER\" -maxdepth 3 -type l -exec ls -l {} +" >&2
    echo "        2. stop anything you started there, then from a shell outside it delete it once" >&2
    echo "           with a command that does not follow links (never rm -rf / Remove-Item -Recurse on Windows):" >&2
    echo "             Windows: cmd //c rmdir //s //q \"$wt_native\"   (Git Bash; from PowerShell: cmd /c rmdir /s /q \"$wt_native\")" >&2
    echo "             POSIX:   rm -rf \"$WT_LEFTOVER\"" >&2
    echo "        3. git -C \"$MAIN\" worktree prune" >&2
  fi
  [ "$BRANCH_LEFTOVER" = "1" ] && echo "      - git -C \"$MAIN\" branch -D $BRANCH" >&2
  [ "$tracked_restore_failed" = "1" ] && echo "      - your tracked changes are still stashed: git -C \"$MAIN\" stash pop stash@{0}" >&2
  exit 1
fi

echo
case "$STRATEGY" in
  squash) landed="squash-merged" ;;
  merge)  landed="merged with a merge commit" ;;
  ff)     landed="fast-forwarded" ;;
  pr)     landed="already landed through a pull request" ;;
esac
echo "✅ done: '$BRANCH' → $LANDED_ON ($newsha), $landed and cleaned up."
if [ "$STASHED" = "1" ]; then
  # Not popped on purpose: the merged commit supersedes those drafts, and popping would
  # overwrite the merged content. Kept so the pre-merge version is never silently lost.
  echo "   $COLLIDE_N untracked file(s) were stashed and left there — the merge supersedes them:"
  echo "     inspect: git -C \"$MAIN\" stash show -p --include-untracked ${STASH_SHA:-stash@{0\}}"
  echo "     discard: git -C \"$MAIN\" stash drop stash@{0}"
fi
if [ "$STRATEGY" = "pr" ]; then
  # The server may have kept the remote branch; deleting it is a network step, so it is named
  # rather than run.
  echo "   remote branch, if the server kept it: git -C \"$MAIN\" push <remote> --delete $BRANCH"
else
  echo "   to publish: git -C \"$MAIN\" push <remote> $BASE"
fi
