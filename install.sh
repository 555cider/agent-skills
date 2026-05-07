#!/usr/bin/env bash
# install.sh — wire skills in this repo into ~/.agents/skills/ and per-harness skill dirs.
#
# Usage:
#   ./install.sh                       # install every skill under skills/
#   ./install.sh <name> [<name>...]    # install only the named skill(s)
#   ./install.sh list                  # print available skill names and exit
#   ./install.sh -h | --help           # this help
#
# Idempotent: re-running is safe. Existing real dirs / mismatched links are warned about,
# never overwritten. Remove them manually if you want this script to manage them.
#
# Linking mechanism:
#   - macOS / Linux: POSIX symlinks via `ln -s`.
#   - Windows + Git Bash / MSYS2 / Cygwin: NTFS directory junctions via `cmd //c mklink /J`.
#     Junctions behave like a directory symlink for read access and do NOT require admin
#     rights or Developer Mode (which is the failure mode of plain `ln -s` on Windows —
#     it silently copies the directory contents instead of linking, leaving the install
#     out of sync with the source repo). Junctions are local-NTFS only; if `$HOME` is on
#     a UNC share or non-NTFS volume, junction creation will fail and install.sh exits
#     with an error rather than silently degrading to a copy.
#
# To uninstall a skill, remove its links under ~/.agents/skills/<name>,
# ~/.claude/skills/<name>, ~/.codex/skills/<name> — `rm -rf` works for both POSIX
# symlinks and Windows junctions.
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

# Subcommand dispatch (first positional arg). Subcommands are reserved words and cannot
# also be skill names — `list` would shadow a skill called "list". The default action
# (no first arg, or first arg is a skill name) is install.
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

# Validate selected names against skills/ — fail fast on typos rather than silently
# installing nothing.
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
  echo "warning: no harness dirs (~/.claude, ~/.codex) found; wiring ~/.agents/skills/ only" >&2
fi

# resolve_phys <path>: print the physical (symlink/junction-followed) absolute path
# in POSIX form. Used to compare "where does this link actually point" without parsing
# `dir /AL` (locale-dependent) or `readlink` (does not see Windows junctions).
resolve_phys() {
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null
}

# ensure_symlink <target> <link-path>
# Creates a directory link at <link-path> pointing at <target>. Uses POSIX symlinks on
# macOS/Linux and NTFS directory junctions on Windows (Git Bash / MSYS2 / Cygwin).
#
# Idempotency check is by resolved physical path comparison rather than `readlink`,
# because junctions are invisible to `readlink` / `[ -L ]` in Git Bash but the linked
# directory's contents still resolve correctly via `cd … && pwd -P`.
#
# Behavior:
#   - if link exists and resolves to <target>: noop ("ok")
#   - if link exists and resolves elsewhere: warn, return 1
#   - if link path is a real file or stale-copy directory (resolves to itself): warn
#     with stale-copy hint on Windows, return 1
#   - else: create the link
ensure_symlink() {
  local target="$1" link="$2"
  local target_phys link_phys
  target_phys="$(resolve_phys "$target")"

  if [ -L "$link" ]; then
    # POSIX symlink path (also catches symlinks created on Windows when Developer Mode
    # was on at install time).
    if [ "$(readlink "$link")" = "$target" ]; then
      printf '  ok   %s\n' "$link"
      return 0
    fi
    printf '  WARN %s -> %s (expected %s) — skipping\n' "$link" "$(readlink "$link")" "$target" >&2
    return 1
  fi

  if [ -e "$link" ]; then
    # Could be: (a) Windows junction (invisible to -L), (b) real dir / stale copy, (c) file.
    if [ -d "$link" ]; then
      link_phys="$(resolve_phys "$link")"
      if [ -n "$link_phys" ] && [ "$link_phys" = "$target_phys" ]; then
        # Junction (or bind mount) already pointing at target — idempotent ok.
        printf '  ok   %s (junction)\n' "$link"
        return 0
      fi
      if [ "$IS_WINDOWS" = "1" ]; then
        printf '  WARN %s exists as a real directory (likely a stale copy from a previous install) — skipping\n' "$link" >&2
        printf '       to fix: rm -rf "%s" && re-run install.sh\n' "$link" >&2
      else
        printf '  WARN %s exists and is not a symlink — skipping\n' "$link" >&2
      fi
      return 1
    fi
    printf '  WARN %s exists and is not a directory — skipping\n' "$link" >&2
    return 1
  fi

  # Create the link.
  if [ "$IS_WINDOWS" = "1" ]; then
    local target_win link_win
    target_win="$(cygpath -w "$target")"
    link_win="$(cygpath -w "$link")"
    # MSYS2_ARG_CONV_EXCL='*' disables MSYS path-conversion of arguments — required so
    # `cmd /c mklink /J ...` sees the Windows paths verbatim. Without it, MSYS rewrites
    # `\` to `/` in arguments and `mklink` fails parsing. `cmd /c` (single slash) is the
    # form that works here; `cmd //c` does not.
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

  # If specific skills were requested, skip the rest.
  if [ ${#SELECTED[@]} -gt 0 ]; then
    skip=1
    for sel in "${SELECTED[@]}"; do
      [ "$sel" = "$name" ] && { skip=0; break; }
    done
    [ "$skip" -eq 0 ] || continue
  fi

  target="${skill_dir%/}"
  printf '\nskill: %s\n' "$name"

  # Tier 1: agent-spec runtime path
  if ! ensure_symlink "$target" "$AGENTS_DIR/$name"; then
    warnings=$((warnings + 1))
    continue
  fi

  # Tier 2: per-harness skill dirs
  for harness in "${HARNESSES[@]}"; do
    mkdir -p "$harness"
    ensure_symlink "$AGENTS_DIR/$name" "$harness/$name" || warnings=$((warnings + 1))
  done
done

if [ "$warnings" -gt 0 ]; then
  printf '\ndone with %d warning(s). Resolve manually if you want every link managed by this script.\n' "$warnings"
else
  printf '\ndone.\n'
fi
