#!/usr/bin/env bash
# install.sh — install skills from this monorepo into ~/.agents/skills/<name>/
# and link them into per-harness skill dirs (~/.claude/skills, ~/.codex/skills).
#
# Usage:
#   ./install.sh                       # install every skill
#   ./install.sh <name> [<name>...]    # install only the named skill(s)
#   ./install.sh list                  # print available skill names and exit
#   ./install.sh -h | --help           # this help
#
# Mechanism:
#   Each skill is published as its own branch (split/<name>) containing only
#   that skill's history — produced by .github/workflows/split.yml on push to
#   main. install.sh `git clone`s split/<name> into ~/.agents/skills/<name>/
#   so that directory IS its own git repo. Update with:
#       cd ~/.agents/skills/<name> && git pull
#
#   Per-harness dirs (~/.claude/skills/<name>, ~/.codex/skills/<name>) are
#   symlinks (POSIX) or NTFS directory junctions (Windows + Git Bash / MSYS2
#   / Cygwin) pointing at ~/.agents/skills/<name>/. Junctions do NOT require
#   admin rights; they sidestep `ln -s` silently degrading to a copy on
#   Windows. UNC shares / non-NTFS volumes are unsupported and fail loudly.
#
# Idempotent: re-running is safe. If ~/.agents/skills/<name>/ already exists
# as the right git repo, it's left alone (run `git pull` there yourself).
# Mismatched dirs / links are reported and skipped, never overwritten.
#
# To uninstall: rm -rf the harness links and the ~/.agents/skills/<name>/
# clone. Both POSIX symlinks and Windows junctions accept `rm -rf`.
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

# Origin URL of this monorepo — split/<name> branches live here.
REMOTE_URL="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
[ -n "$REMOTE_URL" ] || { echo "error: no 'origin' remote configured in $REPO_ROOT" >&2; exit 1; }

# Subcommand dispatch (first positional arg). Subcommands are reserved words and
# cannot also be skill names — `list` would shadow a skill called "list". The
# default action (no first arg, or first arg is a skill name) is install.
if [ $# -gt 0 ] && [ "$1" = "list" ]; then
  shift
  [ $# -eq 0 ] || { echo "error: 'list' takes no arguments" >&2; exit 2; }
  for d in "$SKILLS_SRC"/*/; do basename "$d"; done
  exit 0
fi

# Parse args: --help / positional skill names.
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
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
    if [ ! -d "$SKILLS_SRC/$name" ]; then
      echo "error: skill not found: $name" >&2
      echo "       available:" >&2
      for d in "$SKILLS_SRC"/*/; do echo "         - $(basename "$d")" >&2; done
      exit 2
    fi
  done
fi

AGENTS_DIR="$HOME/.agents/skills"
mkdir -p "$AGENTS_DIR"

# Detect harnesses: skip those not installed.
HARNESSES=()
for h in "$HOME/.claude" "$HOME/.codex"; do
  [ -d "$h" ] && HARNESSES+=("$h/skills")
done
if [ ${#HARNESSES[@]} -eq 0 ]; then
  echo "warning: no harness dirs (~/.claude, ~/.codex) found; cloning to ~/.agents/skills/ only" >&2
fi

# resolve_phys <path>: print the physical (symlink/junction-followed) absolute
# path in POSIX form. Used to compare "where does this link actually point"
# without parsing `dir /AL` (locale-dependent) or `readlink` (does not see
# Windows junctions).
resolve_phys() {
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null
}

# clone_skill <name>: ensure ~/.agents/skills/<name>/ is a clone of
# split/<name> from origin. If it already exists as that clone, leave it.
clone_skill() {
  local name="$1"
  local dest="$AGENTS_DIR/$name"
  local branch="split/$name"

  if [ -e "$dest" ]; then
    if [ -d "$dest/.git" ] || [ -f "$dest/.git" ]; then
      printf '  ok   %s (already cloned — `cd %s && git pull` to update)\n' "$dest" "$dest"
      return 0
    fi
    if [ -L "$dest" ]; then
      printf '  WARN %s is a symlink (legacy install) — remove with `rm -rf %s` and re-run\n' "$dest" "$dest" >&2
      return 1
    fi
    printf '  WARN %s exists but is not a git clone — remove with `rm -rf %s` and re-run\n' "$dest" "$dest" >&2
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

  # Tier 1: clone split/<name> into ~/.agents/skills/<name>/
  if ! clone_skill "$name"; then
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
