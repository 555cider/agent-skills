#!/usr/bin/env bash
# uninstall.sh — remove installed skills from harness dirs and ~/.agents/skills.
#
# Usage:
#   ./uninstall.sh <name> [<name>...]    # remove the named skill(s)
#   ./uninstall.sh --all                 # remove every installed skill
#   ./uninstall.sh --list                # print installed skill names and exit
#   ./uninstall.sh -h | --help           # this help
#
# Removes, for each <name>:
#   ~/.claude/skills/<name>        (harness link or directory)
#   ~/.codex/skills/<name>         (harness link or directory)
#   ~/.agents/skills/<name>/       (the git clone itself)
#
# Safety: refuses to delete a ~/.agents/skills/<name>/ clone that has
# uncommitted changes or unpushed commits — reported as SKIP, not removed.
# Commit/push or `rm -rf` manually to override.
#
# `--list` and `--all` operate on the *installed* set — the union of
# entries actually present under those three roots — not on this
# monorepo's skills/ dir. uninstall.sh works even if the monorepo
# has been deleted.
#
# Idempotent: targets that are already absent are reported and skipped.
# Works on POSIX symlinks, NTFS junctions, and plain directories.
# --- END USAGE ---
set -euo pipefail

ROOTS=("$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.agents/skills")

usage() {
  # Extract from first comment after shebang up to the END USAGE sentinel.
  # Sentinel keeps the help output stable across header edits.
  sed -n '2,/^# --- END USAGE ---$/{/^# --- END USAGE ---$/d;p;}' "${BASH_SOURCE[0]}" \
    | sed 's/^# \?//'
}

# Parse args.
ALL=0
SELECTED=()
LIST=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --all)     ALL=1 ;;
    --list)    LIST=1 ;;
    --*)       echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
    *)         SELECTED+=("$arg") ;;
  esac
done

# compute_installed: print the union of skill names present under any of
# the three roots, deduplicated and sorted. Output is one name per line.
# Empty output is normal (nothing installed).
compute_installed() {
  local root entry
  {
    for root in "${ROOTS[@]}"; do
      [ -d "$root" ] || continue
      # `ls -1` would mis-handle dotfiles and odd names; iterate the
      # directory directly. Skip if the glob matched nothing.
      for entry in "$root"/*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        basename "$entry"
      done
    done
  } | sort -u
}

if [ "$LIST" = "1" ]; then
  [ "$ALL" = "0" ] && [ ${#SELECTED[@]} -eq 0 ] \
    || { echo "error: --list takes no other arguments" >&2; exit 2; }
  compute_installed
  exit 0
fi

# --all expands to every currently-installed skill.
if [ "$ALL" = "1" ]; then
  [ ${#SELECTED[@]} -eq 0 ] \
    || { echo "error: --all takes no skill names" >&2; exit 2; }
  while IFS= read -r name; do
    [ -n "$name" ] && SELECTED+=("$name")
  done < <(compute_installed)
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "no installed skills found under ${ROOTS[*]}"
    exit 0
  fi
fi

if [ ${#SELECTED[@]} -eq 0 ]; then
  echo "error: no skill names given (use --all to remove everything, or --list to see what is installed)" >&2
  exit 2
fi

# remove_path <path>: rm -rf the path if present, reporting either
# `removed` or `not present`. Sanity-checks that the path is under one
# of the known skill roots before deleting. For ~/.agents/skills/<name>/
# entries (the actual git clone), also refuse to delete if the clone has
# uncommitted changes or unpushed commits — symmetric with install.sh,
# which warns and skips on mismatched destinations.
remove_path() {
  local path="$1"
  local under=0 root
  for root in "${ROOTS[@]}"; do
    case "$path" in
      "$root"/*) under=1; break ;;
    esac
  done
  if [ "$under" -eq 0 ]; then
    printf '  SKIP %s (refusing — not under a known skill root)\n' "$path" >&2
    return 1
  fi

  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    printf '  -        %s (not present)\n' "$path"
    return 0
  fi

  # Protect against silent loss of user work in the per-skill clone.
  # Harness links (~/.claude/skills, ~/.codex/skills) hold no state of
  # their own, so we only check the clone path.
  case "$path" in
    "$HOME/.agents/skills/"*)
      if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
        if ! git -C "$path" diff --quiet 2>/dev/null \
           || ! git -C "$path" diff --cached --quiet 2>/dev/null \
           || [ -n "$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null)" ]; then
          printf '  SKIP %s (refusing — clone has local changes; commit/discard or rm -rf manually)\n' "$path" >&2
          return 1
        fi
        # Unpushed commits on the tracked branch (split/<name>).
        local upstream
        upstream="$(git -C "$path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
        if [ -n "$upstream" ] \
           && [ -n "$(git -C "$path" log "$upstream..HEAD" --oneline 2>/dev/null)" ]; then
          printf '  SKIP %s (refusing — clone has unpushed commits ahead of %s; push or rm -rf manually)\n' "$path" "$upstream" >&2
          return 1
        fi
      fi
      ;;
  esac

  rm -rf -- "$path"
  printf '  removed  %s\n' "$path"
}

errors=0
for name in "${SELECTED[@]}"; do
  # Refuse empty / path-traversal names — defensive, never expected from
  # a well-formed CLI but the cost of the check is zero.
  case "$name" in
    ""|*/*|.|..)
      printf 'skill: %s\n  SKIP (invalid name)\n' "$name" >&2
      errors=$((errors + 1))
      continue
      ;;
  esac

  printf '\nskill: %s\n' "$name"
  for root in "${ROOTS[@]}"; do
    remove_path "$root/$name" || errors=$((errors + 1))
  done
done

if [ "$errors" -gt 0 ]; then
  printf '\ndone with %d issue(s).\n' "$errors" >&2
  exit 1
fi
printf '\ndone.\n'
