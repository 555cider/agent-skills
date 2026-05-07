#!/usr/bin/env bash
# install.sh — wire skills in this repo into ~/.agents/skills/ and per-harness skill dirs.
#
# Usage:
#   ./install.sh                       # install every skill under skills/
#   ./install.sh <name> [<name>...]    # install only the named skill(s)
#   ./install.sh --list                # print available skill names and exit
#   ./install.sh -h | --help           # this help
#
# Idempotent: re-running is safe. Existing real dirs / mismatched symlinks are warned about,
# never overwritten. Remove them manually if you want this script to manage them.
#
# To uninstall a skill, remove its symlinks under ~/.agents/skills/<name>,
# ~/.claude/skills/<name>, ~/.codex/skills/<name> — they are plain symlinks.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"

[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }

# Parse args: --help / --list / positional skill names.
SELECTED=()
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    --list)
      for d in "$SKILLS_SRC"/*/; do basename "$d"; done
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

# ensure_symlink <target> <link-path>
# - if link exists and points at target: noop ("ok")
# - if link exists pointing elsewhere: warn, return 1
# - if link path is a real file/dir: warn, return 1
# - else: create symlink
ensure_symlink() {
  local target="$1" link="$2"
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$target" ]; then
      printf '  ok   %s\n' "$link"
      return 0
    fi
    printf '  WARN %s -> %s (expected %s) — skipping\n' "$link" "$(readlink "$link")" "$target" >&2
    return 1
  fi
  if [ -e "$link" ]; then
    printf '  WARN %s exists and is not a symlink — skipping\n' "$link" >&2
    return 1
  fi
  ln -s "$target" "$link"
  printf '  +    %s -> %s\n' "$link" "$target"
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
