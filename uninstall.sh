#!/usr/bin/env bash
# uninstall.sh — remove this monorepo's skills from harness dirs and ~/.agents/skills.
#
# Usage:
#   ./uninstall.sh <name> [<name>...]    # remove the named skill(s)
#   ./uninstall.sh --all                 # remove every skill defined in this monorepo
#   ./uninstall.sh --list                # print this monorepo's skill names and exit
#   ./uninstall.sh -h | --help           # this help
#
# Removes, for each <name>:
#   ~/.claude/skills/<name>        (harness link/junction only)
#   ~/.codex/skills/<name>         (harness link/junction only)
#   ~/.agents/skills/<name>/       (the installed skill directory)
#
# Safety:
#  - Harness paths are removed only when they are a symlink or a junction that
#    resolves into ~/.agents/skills — i.e. a link install.sh created. A real
#    directory there (a third-party skill sharing the name, or an old copy) is
#    skipped with a warning; remove it manually.
#  - Refuses to delete a ~/.agents/skills/<name>/ git clone that has uncommitted
#    changes, unpushed commits, or no configured upstream. Plain synced
#    directories are removed.
# Commit/push or `rm -rf` manually to override a protected clone.
#
# `--list` and `--all` enumerate this monorepo's skills/<name>/SKILL.md entries,
# never the union of whatever else lives under the harness skill dirs. Plugin-
# managed or third-party skills sharing those dirs are out of scope by design;
# remove them with their own tooling, or pass an explicit <name>.
#
# Idempotent: targets that are already absent are reported and skipped.
# Works on POSIX symlinks and NTFS junctions; real harness directories are
# left untouched (see Safety above).
# --- END USAGE ---
set -euo pipefail

AGENTS_ROOT="$HOME/.agents/skills"
HARNESS_ROOTS=("$HOME/.claude/skills" "$HOME/.codex/skills")
ROOTS=("${HARNESS_ROOTS[@]}" "$AGENTS_ROOT")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"

# resolve_phys <path>: print the physical (symlink/junction-followed) absolute
# path in POSIX form, or nothing if the path can't be entered. Mirrors
# install.sh so junction detection stays consistent across the two scripts.
resolve_phys() {
  ( cd "$1" 2>/dev/null && pwd -P ) 2>/dev/null
}

# points_into_agents <path>: true when <path> is a symlink/junction that
# resolves under ~/.agents/skills — i.e. a link install.sh created, not a real
# third-party directory that merely shares a skill name.
points_into_agents() {
  local phys agents_phys
  agents_phys="$(resolve_phys "$AGENTS_ROOT")"
  [ -n "$agents_phys" ] || return 1
  phys="$(resolve_phys "$1")"
  [ -n "$phys" ] || return 1
  case "$phys" in
    "$agents_phys"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Check the stateful clone before removing any harness links, so a protected
# clone leaves the whole installation usable instead of producing a partial
# uninstall.
clone_removal_safe() {
  local path="$1" upstream
  if [ ! -d "$path/.git" ] && [ ! -f "$path/.git" ]; then
    return 0
  fi
  if ! git -C "$path" diff --quiet 2>/dev/null \
     || ! git -C "$path" diff --cached --quiet 2>/dev/null \
     || [ -n "$(git -C "$path" ls-files --others --exclude-standard 2>/dev/null)" ]; then
    printf '  SKIP %s (refusing — clone has local changes; commit/discard or rm -rf manually)\n' "$path" >&2
    return 1
  fi
  upstream="$(git -C "$path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    printf '  SKIP %s (refusing — clone has no upstream; configure one or rm -rf manually)\n' "$path" >&2
    return 1
  fi
  if [ -n "$(git -C "$path" log "$upstream..HEAD" --oneline 2>/dev/null)" ]; then
    printf '  SKIP %s (refusing — clone has unpushed commits ahead of %s; push or rm -rf manually)\n' "$path" "$upstream" >&2
    return 1
  fi
}

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

# compute_monorepo_skills: print every skill defined in this monorepo,
# one name per line, sorted. A skill is any skills/<name>/SKILL.md.
# Empty output means the monorepo declares no skills.
compute_monorepo_skills() {
  local entry
  [ -d "$SKILLS_SRC" ] || return 0
  for entry in "$SKILLS_SRC"/*/SKILL.md; do
    [ -f "$entry" ] || continue
    basename "$(dirname "$entry")"
  done | sort -u
}

if [ "$LIST" = "1" ]; then
  [ "$ALL" = "0" ] && [ ${#SELECTED[@]} -eq 0 ] \
    || { echo "error: --list takes no other arguments" >&2; exit 2; }
  compute_monorepo_skills
  exit 0
fi

# --all expands to every skill this monorepo defines.
if [ "$ALL" = "1" ]; then
  [ ${#SELECTED[@]} -eq 0 ] \
    || { echo "error: --all takes no skill names" >&2; exit 2; }
  while IFS= read -r name; do
    [ -n "$name" ] && SELECTED+=("$name")
  done < <(compute_monorepo_skills)
  if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "no skills declared under $SKILLS_SRC"
    exit 0
  fi
fi

if [ ${#SELECTED[@]} -eq 0 ]; then
  echo "error: no skill names given (use --all to remove this monorepo's skills, or --list to see them)" >&2
  exit 2
fi

# remove_path <path>: rm -rf the path if present, reporting either
# `removed` or `not present`. Sanity-checks that the path is under one
# of the known skill roots before deleting. For ~/.agents/skills/<name>/
# entries that are git clones, also refuse to delete if the clone has
# uncommitted changes or unpushed commits.
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

  # Harness roots hold only links/junctions that install.sh created. A real
  # directory here belongs to something else (a third-party skill, or an old
  # privilege-less `ln -s` copy) — refuse to delete it, symmetric with
  # install.sh's refuse-to-overwrite. A symlink or agents-pointing junction is
  # ours and is safe to unlink.
  case "$path" in
    "$AGENTS_ROOT"/*) : ;;  # the real skill directory — handled below
    *)
      if [ ! -L "$path" ] && ! points_into_agents "$path"; then
        printf '  SKIP %s (refusing — real directory, not a link this tool created; rm -rf manually)\n' "$path" >&2
        return 1
      fi
      rm -rf -- "$path"
      printf '  removed  %s\n' "$path"
      return 0
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
  if ! clone_removal_safe "$AGENTS_ROOT/$name"; then
    errors=$((errors + 1))
    continue
  fi
  for root in "${ROOTS[@]}"; do
    remove_path "$root/$name" || errors=$((errors + 1))
  done
done

if [ "$errors" -gt 0 ]; then
  printf '\ndone with %d issue(s).\n' "$errors" >&2
  exit 1
fi
printf '\ndone.\n'
