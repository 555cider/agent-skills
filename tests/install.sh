#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$ROOT/install.sh"
UNINSTALL="$ROOT/uninstall.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-skills-install-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains_line() {
  local needle="$1" file="$2"
  grep -Fx "$needle" "$file" >/dev/null || fail "expected '$needle' in $file"
}

test_list_includes_agent_memory() {
  local out="$WORK/list.out"
  "$INSTALL" --list >"$out"
  assert_contains_line "agent-memory" "$out"
}

test_uninstall_list_includes_agent_memory() {
  local out="$WORK/uninstall-list.out"
  "$UNINSTALL" --list >"$out"
  assert_contains_line "agent-memory" "$out"
}

test_default_install_falls_back_to_local_skill_when_split_branch_is_missing() {
  local repo="$WORK/repo"
  local home="$WORK/home"
  local remote="$WORK/remote.git"
  local out="$WORK/install.out"
  local err="$WORK/install.err"

  mkdir -p "$repo/skills/local-only/scripts" "$home/.codex"
  cp "$INSTALL" "$repo/install.sh"
  chmod +x "$repo/install.sh"

  cat >"$repo/skills/local-only/SKILL.md" <<'SKILL'
---
name: local-only
description: Local-only test skill.
---

# Local Only
SKILL
  printf 'marker\n' >"$repo/skills/local-only/scripts/marker.txt"

  git init -q "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Test"
  git -C "$repo" add install.sh skills
  git -C "$repo" commit -qm init
  git init --bare -q "$remote"
  git -C "$repo" remote add origin "$remote"

  HOME="$home" "$repo/install.sh" local-only >"$out" 2>"$err"

  [ -f "$home/.agents/skills/local-only/SKILL.md" ] ||
    fail "expected local-only SKILL.md to be synced into ~/.agents/skills"
  [ -f "$home/.agents/skills/local-only/scripts/marker.txt" ] ||
    fail "expected nested skill resources to be synced"
  [ -f "$home/.codex/skills/local-only/SKILL.md" ] ||
    fail "expected codex harness link to resolve to installed skill"
  grep -F "split/local-only is not published" "$out" >/dev/null ||
    fail "expected output to explain local fallback"

  printf 'updated\n' >"$repo/skills/local-only/scripts/marker.txt"
  HOME="$home" "$repo/install.sh" local-only >"$WORK/reinstall.out" 2>"$WORK/reinstall.err"
  grep -Fx "updated" "$home/.agents/skills/local-only/scripts/marker.txt" >/dev/null ||
    fail "expected repeated default install to refresh local fallback while split branch is missing"
}

test_default_fallback_does_not_overwrite_mismatched_plain_directory() {
  local repo="$WORK/mismatch-repo"
  local home="$WORK/mismatch-home"
  local remote="$WORK/mismatch-remote.git"
  local out="$WORK/mismatch-install.out"
  local err="$WORK/mismatch-install.err"

  mkdir -p "$repo/skills/local-only" "$home/.agents/skills/local-only"
  cp "$INSTALL" "$repo/install.sh"
  chmod +x "$repo/install.sh"

  cat >"$repo/skills/local-only/SKILL.md" <<'SKILL'
---
name: local-only
description: Local-only test skill.
---

# Local Only
SKILL
  printf 'do not delete\n' >"$home/.agents/skills/local-only/existing.txt"

  git init -q "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Test"
  git -C "$repo" add install.sh skills
  git -C "$repo" commit -qm init
  git init --bare -q "$remote"
  git -C "$repo" remote add origin "$remote"

  HOME="$home" "$repo/install.sh" local-only >"$out" 2>"$err"

  grep -Fx "do not delete" "$home/.agents/skills/local-only/existing.txt" >/dev/null ||
    fail "expected mismatched plain directory contents to be preserved"
  [ ! -f "$home/.agents/skills/local-only/SKILL.md" ] ||
    fail "expected mismatched plain directory not to be overwritten by fallback sync"
  grep -F "exists but is not a recognized local local-only skill" "$err" >/dev/null ||
    fail "expected warning for mismatched plain directory"
}

test_uninstall_removes_local_fallback_install() {
  local home="$WORK/uninstall-home"
  local out="$WORK/uninstall.out"
  local err="$WORK/uninstall.err"

  mkdir -p "$home/.codex"

  HOME="$home" "$INSTALL" agent-memory >"$WORK/install-agent-memory.out" 2>"$WORK/install-agent-memory.err"
  [ -f "$home/.agents/skills/agent-memory/SKILL.md" ] ||
    fail "expected agent-memory to be installed before uninstall"
  [ -f "$home/.codex/skills/agent-memory/SKILL.md" ] ||
    fail "expected codex harness link to resolve before uninstall"

  HOME="$home" "$UNINSTALL" agent-memory >"$out" 2>"$err"

  [ ! -e "$home/.agents/skills/agent-memory" ] ||
    fail "expected ~/.agents/skills/agent-memory to be removed"
  [ ! -e "$home/.codex/skills/agent-memory" ] && [ ! -L "$home/.codex/skills/agent-memory" ] ||
    fail "expected ~/.codex/skills/agent-memory link to be removed"
  grep -F "removed  $home/.agents/skills/agent-memory" "$out" >/dev/null ||
    fail "expected uninstall output to report removing agent-memory install root"
}

test_uninstall_all_removes_agent_memory_local_fallback_install() {
  local home="$WORK/uninstall-all-home"
  local out="$WORK/uninstall-all.out"
  local err="$WORK/uninstall-all.err"

  mkdir -p "$home/.codex"

  HOME="$home" "$INSTALL" agent-memory >"$WORK/install-agent-memory-all.out" 2>"$WORK/install-agent-memory-all.err"
  [ -f "$home/.agents/skills/agent-memory/SKILL.md" ] ||
    fail "expected agent-memory to be installed before uninstall --all"

  HOME="$home" "$UNINSTALL" --all >"$out" 2>"$err"

  [ ! -e "$home/.agents/skills/agent-memory" ] ||
    fail "expected uninstall --all to remove ~/.agents/skills/agent-memory"
  [ ! -e "$home/.codex/skills/agent-memory" ] && [ ! -L "$home/.codex/skills/agent-memory" ] ||
    fail "expected uninstall --all to remove ~/.codex/skills/agent-memory"
  grep -F "skill: agent-memory" "$out" >/dev/null ||
    fail "expected uninstall --all output to include agent-memory"
}

test_list_includes_agent_memory
test_uninstall_list_includes_agent_memory
test_default_install_falls_back_to_local_skill_when_split_branch_is_missing
test_default_fallback_does_not_overwrite_mismatched_plain_directory
test_uninstall_removes_local_fallback_install
test_uninstall_all_removes_agent_memory_local_fallback_install

echo "install tests passed"
