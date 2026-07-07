#!/usr/bin/env bash
# install.sh — install skills from this monorepo into ~/.agents/skills/<name>/
# and link them into per-harness skill dirs (~/.claude/skills, ~/.codex/skills).
#
# Usage:
#   ./install.sh                       # install every skill
#   ./install.sh <name> [<name>...]    # install only the named skill(s)
#   ./install.sh --local [<name>...]   # copy local skills into ~/.agents/skills
#   ./install.sh --list                # print available skill names and exit
#   ./install.sh -h | --help           # this help
# --- END USAGE ---
#
# Mechanism:
#   Each skill is published as its own branch (split/<name>) containing only
#   that skill's history — produced by .github/workflows/split.yml on push to
#   main. When the branch exists, install.sh `git clone`s split/<name> into
#   ~/.agents/skills/<name>/ so that directory IS its own git repo. Update with:
#       cd ~/.agents/skills/<name> && git pull
#
#   If a local skill exists before its split/<name> branch has been published,
#   install.sh syncs the checkout's skills/<name>/ instead so new skills can be
#   installed during development.
#
#   For local development, --local skips origin entirely and synchronizes the
#   current checkout's skills/<name>/ into ~/.agents/skills/<name>/.
#
#   Per-harness dirs (~/.claude/skills/<name>, ~/.codex/skills/<name>) are
#   symlinks (POSIX) or NTFS directory junctions (Windows + Git Bash / MSYS2
#   / Cygwin) pointing at ~/.agents/skills/<name>/. Junctions do NOT require
#   admin rights; they sidestep `ln -s` silently degrading to a copy on
#   Windows. UNC shares / non-NTFS volumes are unsupported and fail loudly.
#
# Idempotent: re-running is safe. If ~/.agents/skills/<name>/ already exists
# as the right git repo, it's left alone (run `git pull` there yourself). If a
# split branch is still unpublished, a matching local fallback directory is
# refreshed. Other mismatched dirs / links are reported and skipped.
#
# To uninstall: run uninstall.sh, or rm -rf the harness links and the
# ~/.agents/skills/<name>/ install directory. Both POSIX symlinks and Windows
# junctions accept `rm -rf`.
set -euo pipefail

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
  *)                    IS_WINDOWS=0 ;;
esac

if [ "$IS_WINDOWS" = "1" ]; then
  command -v cygpath >/dev/null 2>&1 || {
    echo "error: cygpath not found — required on Windows for path conversion" >&2
    echo "       cygpath ships with Git for Windows / MSYS2 / Cygwin by default;" >&2
    echo "       check that you are running install.sh from one of those shells." >&2
    exit 1
  }
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"

[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }

# List mode is a flag so every positional argument remains available as a skill
# name, including a skill literally named "list".
if [ $# -gt 0 ] && [ "$1" = "--list" ]; then
  shift
  [ $# -eq 0 ] || { echo "error: '--list' takes no arguments" >&2; exit 2; }
  for d in "$SKILLS_SRC"/*/; do basename "$d"; done
  exit 0
fi

# Parse args: --help / flags / positional skill names.
LOCAL_MODE=0
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      # Extract from first comment after shebang up to the END USAGE sentinel.
      # Sentinel keeps the help output stable across header edits.
      sed -n '2,/^# --- END USAGE ---$/{/^# --- END USAGE ---$/d;p;}' "${BASH_SOURCE[0]}" \
        | sed 's/^# \?//'
      exit 0
      ;;
    --local)
      LOCAL_MODE=1
      ;;
    --*)
      echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
    *)
      SELECTED+=("$arg") ;;
  esac
done

# Validate selected names against skills/ — fail fast on typos rather than
# silently installing nothing.
if [ ${#SELECTED[@]} -gt 0 ]; then
  for name in "${SELECTED[@]}"; do
    # Reject empty / path-traversal / nested names up front: `[ -d "$SKILLS_SRC/../x" ]`
    # can be true yet the install loop only matches basenames of skills/*/, so such
    # a name would pass validation and then silently install nothing.
    case "$name" in
      ""|*/*|.|..)
        echo "error: invalid skill name: '$name'" >&2
        exit 2
        ;;
    esac
    if [ ! -d "$SKILLS_SRC/$name" ]; then
      echo "error: skill not found: $name" >&2
      echo "       available:" >&2
      for d in "$SKILLS_SRC"/*/; do echo "         - $(basename "$d")" >&2; done
      exit 2
    fi
  done
fi

if [ "$LOCAL_MODE" = "0" ]; then
  # Origin URL of this monorepo — split/<name> branches live here.
  REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  [ -n "$REMOTE_URL" ] || { echo "error: no 'origin' remote configured in $REPO_ROOT" >&2; exit 1; }
fi

AGENTS_DIR="$HOME/.agents/skills"
mkdir -p "$AGENTS_DIR"

# Detect harnesses: skip those not installed.
HARNESSES=()
for h in "$HOME/.claude" "$HOME/.codex"; do
  [ -d "$h" ] && HARNESSES+=("$h/skills")
done
if [ ${#HARNESSES[@]} -eq 0 ]; then
  echo "warning: no harness dirs (~/.claude, ~/.codex) found; installing to ~/.agents/skills/ only" >&2
fi

# resolve_phys <path>: print the physical (symlink/junction-followed) absolute
# path in POSIX form. Used to compare "where does this link actually point"
# without parsing `dir /AL` (locale-dependent) or `readlink` (does not see
# Windows junctions).
resolve_phys() {
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null
}

split_branch_status() {
  local branch="$1"
  local status
  if git ls-remote --exit-code --heads "$REMOTE_URL" "$branch" >/dev/null 2>&1; then
    return 0
  else
    status=$?
    return "$status"
  fi
}

local_skill_dir_matches() {
  local dir="$1" name="$2"
  [ -f "$dir/SKILL.md" ] || return 1
  grep -Eq "^[[:space:]]*name:[[:space:]]*['\"]?${name}['\"]?[[:space:]]*$" "$dir/SKILL.md"
}

# clone_skill <name>: ensure ~/.agents/skills/<name>/ is a clone of
# split/<name> from origin. If it already exists as that clone, leave it. If
# the split branch is not published yet, sync the local checkout instead.
clone_skill() {
  local name="$1"
  local dest="$AGENTS_DIR/$name"
  local branch="split/$name"
  local branch_status

  if [ -e "$dest" ]; then
    if [ -d "$dest/.git" ] || [ -f "$dest/.git" ]; then
      printf '  ok   %s (already cloned — `cd %s && git pull` to update)\n' "$dest" "$dest"
      return 0
    fi
    if [ -L "$dest" ]; then
      printf '  WARN %s is a symlink — remove with `rm -rf %s` and re-run\n' "$dest" "$dest" >&2
      return 1
    fi
    if split_branch_status "$branch"; then
      branch_status=0
    else
      branch_status=$?
    fi
    if [ "$branch_status" = "2" ]; then
      if local_skill_dir_matches "$dest" "$name"; then
        printf '  note %s is not published; syncing local %s instead\n' "$branch" "$SKILLS_SRC/$name"
        sync_local_skill "$name"
        return $?
      fi
      printf '  WARN %s exists but is not a recognized local %s skill — remove with `rm -rf %s` and re-run\n' "$dest" "$name" "$dest" >&2
      return 1
    fi
    printf '  WARN %s exists but is not a git clone — remove with `rm -rf %s` and re-run\n' "$dest" "$dest" >&2
    return 1
  fi

  if split_branch_status "$branch"; then
    branch_status=0
  else
    branch_status=$?
  fi
  if [ "$branch_status" = "2" ]; then
    printf '  note %s is not published; syncing local %s instead\n' "$branch" "$SKILLS_SRC/$name"
    sync_local_skill "$name"
    return $?
  elif [ "$branch_status" != "0" ]; then
    # git ls-remote: 0 = ref found, 2 = ref absent (unpublished). Anything else
    # (e.g. 128) is a network/auth failure — do NOT misdiagnose it as unpublished.
    printf '  WARN could not reach %s to check for %s (git ls-remote exit %s).\n' "$REMOTE_URL" "$branch" "$branch_status" >&2
    printf '       Check your network/credentials, or run `./install.sh --local %s` to install from this checkout.\n' "$name" >&2
    return 1
  fi

  # `--single-branch -b split/<name>` fetches only that branch's history,
  # which is the whole point of split: the user's clone is small and only
  # contains commits that touched this skill.
  if ! git clone --single-branch -b "$branch" "$REMOTE_URL" "$dest" 2>&1; then
    printf '  WARN failed to clone %s from %s\n' "$branch" "$REMOTE_URL" >&2
    printf '       this usually means the split branch has not been published yet.\n' >&2
    printf '       split branches are produced by .github/workflows/split.yml on push\n' >&2
    printf '       to main; check the Actions tab on GitHub.\n' >&2
    return 1
  fi
  printf '  +    cloned %s into %s\n' "$branch" "$dest"
}

# sync_local_skill <name>: copy the current checkout's skills/<name>/ into
# ~/.agents/skills/<name>/. Only .git metadata is preserved; every other file in
# the destination working tree is removed and replaced from the checkout, so any
# UNCOMMITTED edits made directly in an installed split clone are destroyed. Edit
# in the monorepo checkout, not the installed clone.
sync_local_skill() {
  local name="$1"
  local src="$SKILLS_SRC/$name"
  local dest="$AGENTS_DIR/$name"
  local entry base

  if [ -L "$dest" ]; then
    printf '  WARN %s is a symlink — remove with `rm -rf %s` and re-run\n' "$dest" "$dest" >&2
    return 1
  fi

  if [ -e "$dest" ] && [ ! -d "$dest" ]; then
    printf '  WARN %s exists and is not a directory — skipping\n' "$dest" >&2
    return 1
  fi

  # If the destination is a clone with uncommitted work, warn before we wipe it.
  if [ -d "$dest/.git" ] || [ -f "$dest/.git" ]; then
    if ! git -C "$dest" diff --quiet 2>/dev/null \
       || ! git -C "$dest" diff --cached --quiet 2>/dev/null \
       || [ -n "$(git -C "$dest" ls-files --others --exclude-standard 2>/dev/null)" ]; then
      printf '  WARN %s has uncommitted changes; local sync will overwrite its working tree\n' "$dest" >&2
    fi
  fi

  mkdir -p "$dest"

  while IFS= read -r -d '' entry; do
    rm -rf -- "$entry"
  done < <(find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -print0)

  while IFS= read -r -d '' entry; do
    base="$(basename "$entry")"
    [ "$base" = ".git" ] && continue
    cp -a "$entry" "$dest/"
  done < <(find "$src" -mindepth 1 -maxdepth 1 -print0)

  printf '  +    synced %s into %s\n' "$src" "$dest"
}

# ensure_link <target> <link-path>: create a directory link at <link-path>
# pointing at <target>. POSIX symlink on macOS/Linux, NTFS directory junction
# on Windows (Git Bash / MSYS2 / Cygwin).
#
# Idempotency check is by resolved physical path comparison rather than
# `readlink`, because junctions are invisible to `readlink` / `[ -L ]` in Git
# Bash but the linked directory's contents still resolve correctly via
# `cd … && pwd -P`.
ensure_link() {
  local target="$1" link="$2"
  local target_phys link_phys
  target_phys="$(resolve_phys "$target")"

  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$target" ]; then
      printf '  ok   %s\n' "$link"
      return 0
    fi
    printf '  WARN %s -> %s (expected %s) — skipping\n' "$link" "$(readlink "$link")" "$target" >&2
    return 1
  fi

  if [ -e "$link" ]; then
    if [ -d "$link" ]; then
      link_phys="$(resolve_phys "$link")"
      if [ -n "$link_phys" ] && [ "$link_phys" = "$target_phys" ]; then
        printf '  ok   %s (junction)\n' "$link"
        return 0
      fi
      if [ "$IS_WINDOWS" = "1" ]; then
        printf '  WARN %s exists as a real directory (likely a stale copy) — skipping\n' "$link" >&2
        printf '       to fix: rm -rf "%s" && re-run install.sh\n' "$link" >&2
      else
        printf '  WARN %s exists and is not a symlink — skipping\n' "$link" >&2
      fi
      return 1
    fi
    printf '  WARN %s exists and is not a directory — skipping\n' "$link" >&2
    return 1
  fi

  if [ "$IS_WINDOWS" = "1" ]; then
    local target_win link_win
    target_win="$(cygpath -w "$target")"
    link_win="$(cygpath -w "$link")"
    # MSYS2_ARG_CONV_EXCL='*' disables MSYS path-conversion of arguments — required
    # so `cmd /c mklink /J ...` sees the Windows paths verbatim. `cmd /c` (single
    # slash) is the form that works here; `cmd //c` does not.
    if ! MSYS2_ARG_CONV_EXCL='*' cmd /c mklink /J "$link_win" "$target_win" >/dev/null 2>&1; then
      printf '  WARN failed to create junction: %s -> %s\n' "$link" "$target" >&2
      printf '       `mklink /J` requires the link path to be on a local NTFS volume.\n' >&2
      printf '       UNC shares (\\\\server\\share\\...), redirected home dirs, or non-NTFS\n' >&2
      printf '       filesystems are not supported by junctions.\n' >&2
      return 1
    fi
    printf '  +    %s -> %s (junction)\n' "$link" "$target"
  else
    ln -s "$target" "$link"
    printf '  +    %s -> %s\n' "$link" "$target"
  fi
}

warnings=0
for skill_dir in "$SKILLS_SRC"/*/; do
  name="$(basename "$skill_dir")"

  if [ ${#SELECTED[@]} -gt 0 ]; then
    skip=1
    for sel in "${SELECTED[@]}"; do
      [ "$sel" = "$name" ] && { skip=0; break; }
    done
    [ "$skip" -eq 0 ] || continue
  fi

  printf '\nskill: %s\n' "$name"

  # Tier 1: install into ~/.agents/skills/<name>/
  if [ "$LOCAL_MODE" = "1" ]; then
    install_ok=1
    sync_local_skill "$name" || install_ok=0
  else
    install_ok=1
    clone_skill "$name" || install_ok=0
  fi
  if [ "$install_ok" = "0" ]; then
    warnings=$((warnings + 1))
    continue
  fi

  # Tier 2: per-harness link → ~/.agents/skills/<name>/
  for harness in "${HARNESSES[@]}"; do
    mkdir -p "$harness"
    ensure_link "$AGENTS_DIR/$name" "$harness/$name" || warnings=$((warnings + 1))
  done
done

if [ "$warnings" -gt 0 ]; then
  printf '\ndone with %d warning(s). Resolve manually if you want every step managed by this script.\n' "$warnings"
else
  printf '\ndone.\n'
fi
