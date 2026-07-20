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

test_local_install_overwrites_dirty_managed_clone() {
  local home="$WORK/local-dirty-home"
  local dest="$home/.agents/skills/peer-review"

  mkdir -p "$dest" "$home/.codex"
  git init -q "$dest"
  git -C "$dest" config user.email "test@example.com"
  git -C "$dest" config user.name "Test"
  cp "$ROOT/skills/peer-review/SKILL.md" "$dest/SKILL.md"
  printf 'stale tracked file\n' >"$dest/stale.txt"
  git -C "$dest" add SKILL.md stale.txt
  git -C "$dest" commit -qm init
  printf '\ndirty installed copy\n' >>"$dest/SKILL.md"
  printf 'stale untracked file\n' >"$dest/untracked.txt"

  HOME="$home" "$INSTALL" --local peer-review >"$WORK/local-dirty.out" 2>"$WORK/local-dirty.err"

  diff -qr --exclude=.git "$ROOT/skills/peer-review" "$dest" >/dev/null ||
    fail "expected --local to replace a dirty installed clone from the checkout"
  [ -d "$dest/.git" ] || fail "expected --local to preserve installed clone metadata"
  [ -L "$home/.codex/skills/peer-review" ] ||
    fail "expected local refresh to keep managing the harness link"
  ! grep -F "has local changes" "$WORK/local-dirty.err" >/dev/null ||
    fail "expected explicit --local refresh not to reject its dirty destination"
}

test_default_install_preserves_dirty_managed_clone() {
  local repo="$WORK/dirty-clone-repo"
  local home="$WORK/dirty-clone-home"
  local remote="$WORK/dirty-clone-remote.git"
  local dest="$home/.agents/skills/local-only"

  mkdir -p "$repo/skills/local-only" "$dest" "$home/.codex"
  cp "$INSTALL" "$repo/install.sh"
  chmod +x "$repo/install.sh"

  cat >"$repo/skills/local-only/SKILL.md" <<'SKILL'
---
name: local-only
description: Local-only test skill.
---

# Local Only
SKILL
  git init -q "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Test"
  git -C "$repo" add install.sh skills
  git -C "$repo" commit -qm init
  git init --bare -q "$remote"
  git -C "$repo" remote add origin "$remote"

  cp "$repo/skills/local-only/SKILL.md" "$dest/SKILL.md"
  git init -q "$dest"
  git -C "$dest" config user.email "test@example.com"
  git -C "$dest" config user.name "Test"
  git -C "$dest" add SKILL.md
  git -C "$dest" commit -qm init
  git -C "$dest" branch -m split/local-only
  git -C "$dest" remote add origin "$remote"
  git -C "$dest" update-ref refs/remotes/origin/split/local-only HEAD
  git -C "$dest" branch --set-upstream-to=origin/split/local-only >/dev/null
  printf 'keep this local work\n' >"$dest/local-work.txt"

  HOME="$home" "$repo/install.sh" local-only >"$WORK/dirty-clone.out" 2>"$WORK/dirty-clone.err"

  grep -Fx "keep this local work" "$dest/local-work.txt" >/dev/null ||
    fail "expected default install to preserve dirty managed clone contents"
  grep -F "already cloned" "$WORK/dirty-clone.out" >/dev/null ||
    fail "expected default install to leave its managed clone alone"
}

test_default_install_does_not_accept_an_unrelated_git_repo() {
  local home="$WORK/unrelated-git-home"
  local dest="$home/.agents/skills/agent-memory"

  mkdir -p "$dest" "$home/.codex"
  git init -q "$dest"
  git -C "$dest" config user.email "test@example.com"
  git -C "$dest" config user.name "Test"
  printf 'unrelated\n' >"$dest/keep.txt"
  git -C "$dest" add keep.txt
  git -C "$dest" commit -qm init

  HOME="$home" "$INSTALL" agent-memory >"$WORK/unrelated-git.out" 2>"$WORK/unrelated-git.err"
  grep -Fx "unrelated" "$dest/keep.txt" >/dev/null || fail "expected unrelated git repo to be preserved"
  [ ! -e "$home/.codex/skills/agent-memory" ] || fail "expected no harness link to an unrelated git repo"
  grep -F "not this skill's managed split/agent-memory clone" "$WORK/unrelated-git.err" >/dev/null ||
    fail "expected install to reject an unrelated git repo"

  HOME="$home" "$INSTALL" --local agent-memory >"$WORK/unrelated-local.out" 2>"$WORK/unrelated-local.err"
  grep -Fx "unrelated" "$dest/keep.txt" >/dev/null || fail "expected local install to preserve unrelated git repo"
  grep -F "refusing to overwrite it" "$WORK/unrelated-local.err" >/dev/null ||
    fail "expected local install to reject an unrelated git repo"
}

test_uninstall_removes_local_fallback_install() {
  local home="$WORK/uninstall-home"
  local out="$WORK/uninstall.out"
  local err="$WORK/uninstall.err"

  mkdir -p "$home/.codex"

  HOME="$home" "$INSTALL" --local agent-memory >"$WORK/install-agent-memory.out" 2>"$WORK/install-agent-memory.err"
  [ -f "$home/.agents/skills/agent-memory/SKILL.md" ] ||
    fail "expected agent-memory to be installed before uninstall"
  [ -f "$home/.codex/skills/agent-memory/SKILL.md" ] ||
    fail "expected codex harness link to resolve before uninstall"
  [ -x "$home/.local/bin/agent-memory" ] ||
    fail "expected managed agent-memory launcher before uninstall"

  HOME="$home" "$UNINSTALL" agent-memory >"$out" 2>"$err"

  [ ! -e "$home/.agents/skills/agent-memory" ] ||
    fail "expected ~/.agents/skills/agent-memory to be removed"
  [ ! -e "$home/.codex/skills/agent-memory" ] && [ ! -L "$home/.codex/skills/agent-memory" ] ||
    fail "expected ~/.codex/skills/agent-memory link to be removed"
  [ ! -e "$home/.local/bin/agent-memory" ] ||
    fail "expected managed agent-memory launcher to be removed"
  grep -F "removed  $home/.agents/skills/agent-memory" "$out" >/dev/null ||
    fail "expected uninstall output to report removing agent-memory install root"
}

test_uninstall_all_removes_agent_memory_local_fallback_install() {
  local home="$WORK/uninstall-all-home"
  local out="$WORK/uninstall-all.out"
  local err="$WORK/uninstall-all.err"

  mkdir -p "$home/.codex"

  HOME="$home" "$INSTALL" --local agent-memory >"$WORK/install-agent-memory-all.out" 2>"$WORK/install-agent-memory-all.err"
  [ -f "$home/.agents/skills/agent-memory/SKILL.md" ] ||
    fail "expected agent-memory to be installed before uninstall --all"

  HOME="$home" "$UNINSTALL" --all >"$out" 2>"$err"

  [ ! -e "$home/.agents/skills/agent-memory" ] ||
    fail "expected uninstall --all to remove ~/.agents/skills/agent-memory"
  [ ! -e "$home/.codex/skills/agent-memory" ] && [ ! -L "$home/.codex/skills/agent-memory" ] ||
    fail "expected uninstall --all to remove ~/.codex/skills/agent-memory"
  [ ! -e "$home/.local/bin/agent-memory" ] ||
    fail "expected uninstall --all to remove managed launcher"
  grep -F "skill: agent-memory" "$out" >/dev/null ||
    fail "expected uninstall --all output to include agent-memory"
}

test_uninstall_preserves_clone_without_upstream() {
  local home="$WORK/no-upstream-home"
  local clone="$home/.agents/skills/test-skill"
  local link="$home/.codex/skills/test-skill"

  mkdir -p "$clone" "$(dirname "$link")"
  git init -q "$clone"
  git -C "$clone" config user.email "test@example.com"
  git -C "$clone" config user.name "Test"
  printf 'tracked\n' >"$clone/tracked.txt"
  git -C "$clone" add tracked.txt
  git -C "$clone" commit -qm init
  ln -s "$clone" "$link"

  if HOME="$home" "$UNINSTALL" test-skill >"$WORK/no-upstream.out" 2>"$WORK/no-upstream.err"; then
    fail "expected uninstall to refuse a clone without an upstream"
  fi
  [ -d "$clone/.git" ] || fail "expected uninstall to preserve a clone without an upstream"
  [ -L "$link" ] || fail "expected protected clone to keep its harness link"
  grep -F "clone has no upstream" "$WORK/no-upstream.err" >/dev/null ||
    fail "expected uninstall refusal to explain the missing upstream"
}

test_directory_without_skill_md_is_not_a_skill() {
  local repo="$WORK/stray-repo"
  local home="$WORK/stray-home"

  mkdir -p "$repo/skills/real-skill" "$repo/skills/leftover/scripts/__pycache__" "$home/.codex"
  cp "$INSTALL" "$repo/install.sh"
  chmod +x "$repo/install.sh"
  cat >"$repo/skills/real-skill/SKILL.md" <<'SKILL'
---
name: real-skill
description: Real test skill.
---
SKILL
  printf 'bytecode
' >"$repo/skills/leftover/scripts/__pycache__/stale.cpython-314.pyc"

  HOME="$home" "$repo/install.sh" --local >"$WORK/stray.out" 2>"$WORK/stray.err" ||
    fail "expected a directory without SKILL.md to leave the exit status clean"

  [ -f "$home/.agents/skills/real-skill/SKILL.md" ] || fail "expected the declared skill to install"
  [ ! -e "$home/.agents/skills/leftover" ] ||
    fail "expected a directory without SKILL.md to never be installed"
  [ ! -e "$home/.codex/skills/leftover" ] && [ ! -L "$home/.codex/skills/leftover" ] ||
    fail "expected no harness link for a directory without SKILL.md"
  grep -F "skills/leftover" "$WORK/stray.err" >/dev/null ||
    fail "expected the ignored directory to be reported rather than silently skipped"
  [ -d "$repo/skills/leftover" ] ||
    fail "expected install.sh to never delete from the source checkout"

  "$repo/install.sh" --list >"$WORK/stray-list.out" 2>/dev/null
  assert_contains_line "real-skill" "$WORK/stray-list.out"
  ! grep -Fx "leftover" "$WORK/stray-list.out" >/dev/null ||
    fail "expected --list to omit a directory without SKILL.md"

  if HOME="$home" "$repo/install.sh" --local leftover >"$WORK/stray-select.out" 2>"$WORK/stray-select.err"; then
    fail "expected selecting a directory without SKILL.md to fail"
  fi
  grep -F "has no SKILL.md" "$WORK/stray-select.err" >/dev/null ||
    fail "expected the selection error to distinguish a stray directory from a typo"
  grep -F "skill not found: nope" <(HOME="$home" "$repo/install.sh" --local nope 2>&1 || true) >/dev/null ||
    fail "expected an unknown name to still report a plain not-found error"
}

test_agent_memory_shadow_one_command_setup() {
  local home="$WORK/shadow-home"
  local out="$WORK/shadow.out"
  local err="$WORK/shadow.err"

  mkdir -p "$home/.claude" "$home/.codex"
  printf '%s\n' '{"autoMemoryEnabled":true}' >"$home/.claude/settings.json"
  printf '%s\n' \
    '[features]' \
    'memories = true' \
    '' \
    '[plugins."remember-codex-bridge@personal"]' \
    'enabled = true' >"$home/.codex/config.toml"

  HOME="$home" "$INSTALL" --local agent-memory --shadow >"$out" 2>"$err"

  [ -f "$home/.claude/settings.json" ] || fail "expected Claude settings after shadow setup"
  [ -f "$home/.codex/hooks.json" ] || fail "expected Codex hooks after shadow setup"
  [ -f "$home/.config/opencode/plugins/agent-memory.js" ] || fail "expected OpenCode plugin after shadow setup"
  [ -x "$home/.local/bin/agent-memory" ] || fail "expected executable agent-memory launcher"
  HOME="$home" "$home/.local/bin/agent-memory" doctor --format json >"$WORK/shadow-doctor.json"
  python3 - "$home" <<'PY'
import json
import pathlib
import sys
import tomllib

home = pathlib.Path(sys.argv[1])
claude = json.loads((home / ".claude/settings.json").read_text())
codex = tomllib.loads((home / ".codex/config.toml").read_text())
assert claude["autoMemoryEnabled"] is True
assert codex["features"]["memories"] is True
assert codex["plugins"]["remember-codex-bridge@personal"]["enabled"] is True
PY
  grep -F "agent-memory integration: shadow" "$out" >/dev/null || fail "expected shadow integration summary"
  grep -F "integration applied and self-check passed" "$out" >/dev/null || fail "expected successful shadow setup"
}

test_default_install_falls_back_to_local_skill_when_split_branch_is_missing
test_default_fallback_does_not_overwrite_mismatched_plain_directory
test_local_install_overwrites_dirty_managed_clone
test_default_install_preserves_dirty_managed_clone
test_default_install_does_not_accept_an_unrelated_git_repo
test_uninstall_removes_local_fallback_install
test_uninstall_all_removes_agent_memory_local_fallback_install
test_uninstall_preserves_clone_without_upstream
test_directory_without_skill_md_is_not_a_skill
test_agent_memory_shadow_one_command_setup

echo "install tests passed"
