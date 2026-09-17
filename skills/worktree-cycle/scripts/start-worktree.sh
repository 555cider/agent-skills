#!/usr/bin/env bash
# start-worktree.sh — create a git worktree branched from the LOCAL integration branch HEAD.
#
# The point of this script: base is the HEAD of the LOCAL integration branch, not the
# remote default (origin/<default>). Branching from the remote silently drops recent local
# commits, so the work sits on a stale base and collides at squash-merge time. The base is
# asserted right after creation so that accident cannot survive unnoticed. No network, no push.
#
# Usage (from anywhere inside the repository):
#   start-worktree.sh <name> [--base <branch>] [--path <dir>] [--branch <branch>]
#                            [--port-base <n>]
#
# Defaults:
#   base   = HEAD of the LOCAL --base branch (default: dev)
#   branch = worktree-<name>    (symmetric with finish-worktree.sh, which takes this name)
#   path   = <name> under an existing .worktrees/ or .claude/worktrees/, else .worktrees/<name>
#   ports  = a free block of 10 in 20000-29999, derived from the branch name
#
# A relative --path resolves against the directory you invoked the script from.
#
# Ports: branch isolation is not isolation while every worktree runs its dev servers on the
# same default ports. Each worktree therefore also gets a reserved block of 10 ports, written
# to <worktree git-dir>/worktree-ports as sourceable KEY=VALUE. Start only the stack you are
# changing on those ports and leave the shared instances alone. The block is derived from the
# repository path and branch name select a preferred block. A per-user registry serializes
# allocations across repositories, and current listeners are checked before assignment.
# The sockets are then released, so strict server binding remains mandatory.
#
# If the local base trails its remote counterpart, that is reported and the run continues:
# branching from the local branch is the point. Nothing here touches the network.
#
# To start working: cd <path>. Claude Code users may prefer the native EnterWorktree, but
# then check that settings.local.json sets worktree.baseRef=head — otherwise that path
# branches from the remote default and reintroduces the stale base this script prevents.

set -euo pipefail

BASE="dev"; NAME=""; WTPATH=""; BR=""; PORT_BASE=""
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PWD0="$PWD"   # captured before we move to the main worktree; relative args resolve against it

# Port block geometry. 20000-29999 sits below every common ephemeral range (Linux
# 32768-60999, Windows and macOS 49152-65535); customized ranges and other processes can
# still conflict, so the allocator probes bind availability and servers must bind strictly.
PORT_RANGE_START=20000
PORT_BLOCK=10
PORT_BLOCKS=1000
PORT_RANGE_END=$(( PORT_RANGE_START + PORT_BLOCKS * PORT_BLOCK - 1 ))

die()   { echo "‼️  $*" >&2; exit 1; }
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; }

# Absolute already? Accept POSIX (/x), MSYS (/c/x) and Windows drive (C:/x, C:\x) forms.
abspath() {
  case "$1" in
    /*|[A-Za-z]:[\\/]*) printf '%s\n' "$1" ;;
    *)                  printf '%s\n' "$PWD0/$1" ;;
  esac
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

# warn_if_base_behind <branch> — advisory only. Branching from the LOCAL branch is the whole
# point of this script, so a behind base is reported, never blocked.
warn_if_base_behind() {
  local b="$1" ref n
  ref="$(upstream_counterpart "$b")"
  [ -n "$ref" ] || return 0
  n="$(git rev-list --count "$b..$ref" 2>/dev/null)" || return 0
  [ -n "$n" ] && [ "$n" -gt 0 ] || return 0
  echo "⚠️  local '$b' is $n commit(s) behind $ref (read from refs you already have; no fetch)." >&2
  echo "    Branching from local '$b' anyway, by design. Pull first if this worktree needs those commits." >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --base)    [ $# -ge 2 ] || die "--base requires a value";   BASE="$2";   shift 2;;
    --path)    [ $# -ge 2 ] || die "--path requires a value";   WTPATH="$2"; shift 2;;
    --branch)  [ $# -ge 2 ] || die "--branch requires a value"; BR="$2";     shift 2;;
    --port-base) [ $# -ge 2 ] || die "--port-base requires a value"; PORT_BASE="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    -*) die "unknown argument: $1";;
    *) if [ -z "$NAME" ]; then NAME="$1"; else die "too many arguments: $1"; fi; shift;;
  esac
done

[ -n "$NAME" ] || die "worktree name required — e.g. start-worktree.sh fix-login"
[ -n "$BASE" ] || die "--base requires a branch name"
[ -n "$BR" ] || BR="worktree-$NAME"
if [ -n "$WTPATH" ]; then WTPATH="$(abspath "$WTPATH")"; fi

# An explicit --port-base has to land on the same grid as an allocated one, or the two schemes
# would hand out overlapping blocks.
if [ -n "$PORT_BASE" ]; then
  case "$PORT_BASE" in
    ''|*[!0-9]*) die "--port-base must be a number";;
  esac
  [ "$PORT_BASE" -ge "$PORT_RANGE_START" ] && [ "$PORT_BASE" -le $(( PORT_RANGE_END - PORT_BLOCK + 1 )) ] \
    || die "--port-base must be between $PORT_RANGE_START and $(( PORT_RANGE_END - PORT_BLOCK + 1 )) (outside that, the OS can hand the port out as an ephemeral one)"
  [ $(( PORT_BASE % PORT_BLOCK )) -eq 0 ] \
    || die "--port-base must be a multiple of $PORT_BLOCK, so blocks cannot overlap"
fi

# Move to the main worktree so this works from inside any worktree. The list is captured
# first: piping git straight into a head/exit consumer can trip pipefail on SIGPIPE.
WT_LIST="$(git worktree list --porcelain)" || die "not a git repository"
MAIN="$(printf '%s\n' "$WT_LIST" | awk 'NR==1 && /^worktree /{print substr($0,10)}')"
[ -n "$MAIN" ] || die "could not locate the main worktree"
cd "$MAIN"

# base = HEAD of the LOCAL integration branch. If that branch does not exist locally, stop.
# Falling back to the remote is exactly the accident this script exists to prevent.
git show-ref --verify --quiet "refs/heads/$BASE" \
  || die "no local branch '$BASE' (branching from the remote defeats the purpose of this script)"
BASE_SHA="$(git rev-parse "refs/heads/$BASE")"
BASE_SHORT="$(git rev-parse --short "refs/heads/$BASE")"

# Path: existing .worktrees > existing .claude/worktrees > default .worktrees.
if [ -z "$WTPATH" ]; then
  if   [ -d "$MAIN/.worktrees" ];        then WTPATH="$MAIN/.worktrees/$NAME"
  elif [ -d "$MAIN/.claude/worktrees" ]; then WTPATH="$MAIN/.claude/worktrees/$NAME"
  else WTPATH="$MAIN/.worktrees/$NAME"; fi
fi
# An empty directory here is the residue finish leaves on Windows when it could not remove the
# worktree directory itself (see finish-worktree.sh). That lock belongs to whichever process had
# its current directory inside the worktree and outlives the finish run, so finish cannot clear
# it. Refusing the path would let that residue block this worktree name for good, so reclaim it.
# rmdir refuses a non-empty directory, which is exactly the guarantee needed here: real work
# can never be destroyed by this, and anything else still falls through to the guard below.
if [ -d "$WTPATH" ] && rmdir "$WTPATH" 2>/dev/null; then
  echo "· reclaimed an empty leftover directory: $WTPATH"
fi
[ -e "$WTPATH" ] && die "already exists: $WTPATH"
git show-ref --verify --quiet "refs/heads/$BR" && die "branch already exists: $BR"

parent="$(dirname "$WTPATH")"
if ! git check-ignore -q "$parent" 2>/dev/null && ! git check-ignore -q "$WTPATH" 2>/dev/null; then
  echo "⚠️  $parent is not gitignored — the worktree will show up as untracked in the main tree." >&2
  echo "    Consider adding it to .gitignore or .git/info/exclude." >&2
fi

warn_if_base_behind "$BASE" || true

git worktree add "$WTPATH" -b "$BR" "refs/heads/$BASE"

# Assert the base: the new worktree HEAD must equal the local integration branch HEAD.
# This catches a stale base at creation time instead of at squash-merge time.
NEW_SHA="$(git -C "$WTPATH" rev-parse HEAD)"
[ "$NEW_SHA" = "$BASE_SHA" ] \
  || die "base mismatch: worktree $NEW_SHA != $BASE $BASE_SHA (unexpected — investigate before working)"

# Reserve a port block for this worktree. The record goes in the worktree's git directory, NOT
# in the worktree itself: finish-worktree.sh requires `git status --porcelain` to be completely
# empty there (untracked included), so a file in the tree would block every finish for the life
# of the worktree. In the git directory it is invisible to status and `git worktree remove`
# deletes it along with everything else it owns.
#
# A failure here is never fatal. The worktree is the point; the ports are a convenience, and
# refusing to create a worktree because a block could not be reserved would be the wrong trade.
PORTS_FILE=""
WT_GITDIR="$(git -C "$WTPATH" rev-parse --absolute-git-dir)"
PORT_ARGS=(--repo "$MAIN" --branch "$BR" --git-dir "$WT_GITDIR")
[ -z "$PORT_BASE" ] || PORT_ARGS+=(--port-base "$PORT_BASE")
PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3, 10)' 2>/dev/null; then
    PYTHON="$candidate"; break
  fi
done
if [ -n "$PYTHON" ] && ASSIGNED="$("$PYTHON" "$SCRIPT_DIR/reserve-ports.py" "${PORT_ARGS[@]}")"; then
  PORT_BASE="$ASSIGNED"
  PORTS_FILE="$WT_GITDIR/worktree-ports"
else
  echo "⚠️  worktree created at $WTPATH, but no verified port reservation (Python 3.10+ required)." >&2
  echo "    Retry reserve-ports.py for this git-dir; do not rerun worktree creation." >&2
  [ -z "$PORT_BASE" ] || exit 1
  PORT_BASE=""
fi

echo
echo "✅ worktree created: $WTPATH"
echo "   branch $BR  ←  local $BASE HEAD ($BASE_SHORT)  [base asserted]"
if [ -n "$PORT_BASE" ]; then
  echo "   ports  $PORT_BASE-$(( PORT_BASE + PORT_BLOCK - 1 ))  →  $PORTS_FILE"
  echo "          run only the stack you are changing on these; point the rest at the shared"
  echo "          instances and never restart a server you did not start."
fi
echo "   start working: cd \"$WTPATH\""
echo "   when done:     finish-worktree.sh -b $BR -m \"<conventional commit>\""
