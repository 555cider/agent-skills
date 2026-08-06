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
#
# Defaults:
#   base   = HEAD of the LOCAL --base branch (default: dev)
#   branch = worktree-<name>    (symmetric with finish-worktree.sh, which takes this name)
#   path   = <name> under an existing .worktrees/ or .claude/worktrees/, else .worktrees/<name>
#
# A relative --path resolves against the directory you invoked the script from.
#
# If the local base trails its remote counterpart, that is reported and the run continues:
# branching from the local branch is the point. Nothing here touches the network.
#
# To start working: cd <path>. Claude Code users may prefer the native EnterWorktree, but
# then check that settings.local.json sets worktree.baseRef=head — otherwise that path
# branches from the remote default and reintroduces the stale base this script prevents.

set -euo pipefail

BASE="dev"; NAME=""; WTPATH=""; BR=""
PWD0="$PWD"   # captured before we move to the main worktree; relative args resolve against it

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
    -h|--help) usage; exit 0;;
    -*) die "unknown argument: $1";;
    *) if [ -z "$NAME" ]; then NAME="$1"; else die "too many arguments: $1"; fi; shift;;
  esac
done

[ -n "$NAME" ] || die "worktree name required — e.g. start-worktree.sh fix-login"
[ -n "$BASE" ] || die "--base requires a branch name"
[ -n "$BR" ] || BR="worktree-$NAME"
if [ -n "$WTPATH" ]; then WTPATH="$(abspath "$WTPATH")"; fi

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

echo
echo "✅ worktree created: $WTPATH"
echo "   branch $BR  ←  local $BASE HEAD ($BASE_SHORT)  [base asserted]"
echo "   start working: cd \"$WTPATH\""
echo "   when done:     finish-worktree.sh -b $BR -m \"<conventional commit>\""
