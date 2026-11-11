#!/usr/bin/env bash
set -euo pipefail

# The scripts link into $CLAUDE_CONFIG_DIR and $CODEX_HOME when set. Tests run
# against a fake HOME, so drop the caller's values; they would point the
# installs at real config dirs.
unset CLAUDE_CONFIG_DIR CODEX_HOME

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$ROOT/install.sh"
UNINSTALL="$ROOT/uninstall.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-skills-install-tests.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# `ln -s` degrades to a directory copy on Windows without symlink privilege,
# so tests that need a real symlink report a skip instead of a bogus failure.
symlinks_supported() {
  local probe="$WORK/symlink-probe"
  rm -rf "$probe"
  mkdir -p "$probe/target"
  ln -s "$probe/target" "$probe/link" 2>/dev/null || return 1
  [ -L "$probe/link" ]
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

  diff -qr --exclude=.git --exclude=.venv --exclude=__pycache__ --exclude=.pytest_cache --exclude=node_modules "$ROOT/skills/peer-review" "$dest" >/dev/null ||
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
  [ ! -e "$home/.claude/settings.json" ] ||
    fail "expected uninstall not to create Claude settings while removing integrations"
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
  symlinks_supported || {
    echo "SKIP ${FUNCNAME[0]}: this OS does not allow creating symlinks"
    return 0
  }
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

  HOME="$home" PATH="$home/.local/bin:$PATH" "$INSTALL" --local agent-memory --shadow >"$out" 2>"$err"

  [ -f "$home/.claude/settings.json" ] || fail "expected Claude settings after shadow setup"
  [ -f "$home/.codex/hooks.json" ] || fail "expected Codex hooks after shadow setup"
  [ -f "$home/.config/opencode/plugins/agent-memory.js" ] || fail "expected OpenCode plugin after shadow setup"
  [ -x "$home/.local/bin/agent-memory" ] || fail "expected executable agent-memory launcher"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      [ -f "$home/.local/bin/agent-memory.cmd" ] || fail "expected agent-memory.cmd shim on Windows"
      grep -qF 'agent-memory-managed-launcher' "$home/.local/bin/agent-memory.cmd" ||
        fail "expected managed marker in agent-memory.cmd shim"
      ;;
  esac
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

test_agent_memory_shadow_requires_windows_launcher_on_path() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) return ;;
  esac

  local home="$WORK/shadow-missing-launcher-home"
  local out="$WORK/shadow-missing-launcher.out"
  local err="$WORK/shadow-missing-launcher.err"
  local clean_path=""
  local path_entry

  mkdir -p "$home/.codex"
  while IFS= read -r path_entry; do
    [ -n "$path_entry" ] || continue
    if [ -f "$path_entry/agent-memory" ] && grep -qF 'agent-memory-managed-launcher' "$path_entry/agent-memory"; then
      continue
    fi
    if [ -f "$path_entry/agent-memory.cmd" ] && grep -qF 'agent-memory-managed-launcher' "$path_entry/agent-memory.cmd"; then
      continue
    fi
    clean_path="${clean_path:+$clean_path:}$path_entry"
  done < <(printf '%s' "$PATH" | tr ':' '\n')

  if HOME="$home" PATH="$clean_path" "$INSTALL" --local agent-memory --shadow >"$out" 2>"$err"; then
    fail "expected Windows shadow setup without a launcher on PATH to fail"
  fi
  grep -F "managed agent-memory launcher is not on PATH" "$err" >/dev/null ||
    fail "expected a clear managed-launcher PATH error"
  [ ! -e "$home/.codex/hooks.json" ] || fail "expected no Codex hooks to be written"
}

# The plugin channel installs the same SKILL.md files under ~/.claude/plugins/
# with no relation to ~/.agents/skills/, so nothing in the filesystem layout
# reveals the duplicate — only Claude Code's own registry does.
test_install_warns_when_the_skill_is_also_a_claude_code_plugin() {
  local home="$WORK/plugin-conflict-home"
  local out="$WORK/plugin-conflict-install.out"
  local err="$WORK/plugin-conflict-install.err"

  mkdir -p "$home/.claude/plugins" "$home/.codex"
  cat >"$home/.claude/plugins/installed_plugins.json" <<'JSON'
{
  "version": 2,
  "plugins": {
    "step-back@555cider-agent-skills": [
      { "scope": "user", "installPath": "/plugins/cache/step-back" }
    ]
  }
}
JSON

  HOME="$home" "$INSTALL" --local step-back >"$out" 2>"$err" ||
    fail "expected install to still succeed when the skill is also a plugin"

  grep -F "also installed as a Claude Code plugin" "$err" >/dev/null ||
    fail "expected install to warn about the plugin-channel duplicate"
  grep -F "step-back@555cider-agent-skills" "$err" >/dev/null ||
    fail "expected the warning to name the conflicting plugin id"
  [ -f "$home/.agents/skills/step-back/SKILL.md" ] ||
    fail "expected the warning not to block the install"
}

# The bundle plugin carries every skill under one id, so it conflicts with each
# of them individually — matching on the skill name alone would miss it.
test_uninstall_reports_the_claude_code_plugin_copy_it_cannot_remove() {
  local home="$WORK/plugin-conflict-uninstall-home"
  local out="$WORK/plugin-conflict-uninstall.out"
  local err="$WORK/plugin-conflict-uninstall.err"

  mkdir -p "$home/.claude/plugins" "$home/.codex"
  HOME="$home" "$INSTALL" --local step-back \
    >"$WORK/plugin-conflict-preinstall.out" 2>"$WORK/plugin-conflict-preinstall.err"
  cat >"$home/.claude/plugins/installed_plugins.json" <<'JSON'
{
  "version": 2,
  "plugins": {
    "agent-skills@555cider-agent-skills": [
      { "scope": "user", "installPath": "/plugins/cache/agent-skills" }
    ]
  }
}
JSON

  HOME="$home" "$UNINSTALL" step-back >"$out" 2>"$err" ||
    fail "expected uninstall to exit 0 when a plugin copy remains"

  grep -F "also installed as a Claude Code plugin" "$out" >/dev/null ||
    fail "expected uninstall to report the remaining plugin copy"
  grep -F "agent-skills@555cider-agent-skills" "$out" >/dev/null ||
    fail "expected the bundle plugin id to be reported for a single skill"
  [ ! -e "$home/.agents/skills/step-back" ] ||
    fail "expected the local install to be removed regardless"
}

# --shadow/--primary wire hooks into every harness that call into the skill.
# Removing the skill without removing them leaves each session running hooks
# that point at nothing, so uninstall has to undo the integration first.
test_uninstall_removes_agent_memory_integration_hooks() {
  local home="$WORK/uninstall-integration-home"
  local out="$WORK/uninstall-integration.out"
  local err="$WORK/uninstall-integration.err"

  mkdir -p "$home/.claude" "$home/.codex"
  printf '%s\n' '{"theme":"dark"}' >"$home/.claude/settings.json"

  HOME="$home" PATH="$home/.local/bin:$PATH" "$INSTALL" --local agent-memory --shadow \
    >"$WORK/uninstall-integration-install.out" 2>"$WORK/uninstall-integration-install.err" ||
    fail "expected shadow setup to succeed before uninstall"
  grep -qF "agent-memory-v2-managed" "$home/.claude/settings.json" ||
    fail "expected shadow setup to add Claude hooks"
  [ -f "$home/.config/opencode/plugins/agent-memory.js" ] ||
    fail "expected shadow setup to add the OpenCode plugin"

  HOME="$home" PATH="$home/.local/bin:$PATH" "$UNINSTALL" agent-memory >"$out" 2>"$err" ||
    fail "expected uninstall to succeed: $(cat "$err")"

  ! grep -qF "agent-memory" "$home/.claude/settings.json" ||
    fail "expected uninstall to remove the agent-memory hooks from Claude settings"
  grep -qF '"theme": "dark"' "$home/.claude/settings.json" ||
    fail "expected uninstall to keep unrelated Claude settings"
  ! grep -qsF "agent-memory" "$home/.codex/hooks.json" ||
    fail "expected uninstall to remove the agent-memory hooks from Codex"
  [ ! -e "$home/.config/opencode/plugins/agent-memory.js" ] ||
    fail "expected uninstall to remove the OpenCode plugin"
  [ ! -e "$home/.agents/skills/agent-memory" ] ||
    fail "expected the skill itself to be removed after its hooks"
  grep -F "agent-memory claude integration" "$out" >/dev/null ||
    fail "expected uninstall to report the removed integration"
}

# HOME with no ~/.claude or ~/.codex leaves HARNESSES empty, and duplicate
# names start the de-duplication from an empty list. Both are empty-array
# expansions that macOS /bin/bash 3.2 rejects under `set -u`.
test_install_with_no_harness_dirs_and_duplicate_names() {
  local home="$WORK/no-harness-home"

  mkdir -p "$home"
  HOME="$home" "$INSTALL" --local step-back step-back >"$WORK/no-harness.out" 2>"$WORK/no-harness.err" ||
    fail "expected install without harness dirs to succeed: $(cat "$WORK/no-harness.err")"
  [ -f "$home/.agents/skills/step-back/SKILL.md" ] || fail "expected step-back to install"
  [ "$(grep -c '^skill: step-back$' "$WORK/no-harness.out")" = "1" ] ||
    fail "expected a duplicated name to install once"
  HOME="$home" "$UNINSTALL" step-back >"$WORK/no-harness-un.out" 2>"$WORK/no-harness-un.err" ||
    fail "expected uninstall without harness dirs to succeed"
  [ ! -e "$home/.claude" ] || fail "expected uninstall not to create ~/.claude"
}


# make_skill_repo <repo> <name>...: a git checkout holding install.sh and one
# minimal skill per name, with an origin remote at <repo>.remote.git.
make_skill_repo() {
  local repo="$1" name
  shift
  mkdir -p "$repo/skills"
  cp "$INSTALL" "$repo/install.sh"
  chmod +x "$repo/install.sh"
  for name in "$@"; do
    mkdir -p "$repo/skills/$name"
    printf -- '---\nname: %s\ndescription: Test skill %s.\n---\n' "$name" "$name" >"$repo/skills/$name/SKILL.md"
  done
  git init -q "$repo"
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Test"
  git -C "$repo" add install.sh skills
  git -C "$repo" commit -qm init
  git init --bare -q "$repo.remote.git"
  git -C "$repo" remote add origin "$repo.remote.git"
}

# A resync used to delete everything but .git and copy every file in the
# checkout, so agent-memory lost its private .venv (and pip reinstalled it) on
# each --local run, while gitignored caches were shipped.
test_local_resync_keeps_venv_and_copies_only_unignored_files() {
  local repo="$WORK/resync-repo"
  local home="$WORK/resync-home"
  local src="$repo/skills/sync-me"
  local dest="$home/.agents/skills/sync-me"

  make_skill_repo "$repo" sync-me
  mkdir -p "$src/scripts/__pycache__" "$src/.venv/bin" "$src/node_modules/pkg" "$src/gone" "$home"
  printf '__pycache__/\n*.log\n' >"$src/.gitignore"
  printf 'tracked\n' >"$src/scripts/tool.py"
  printf 'non-ascii\n' >"$src/scripts/café.txt"
  printf 'old\n' >"$src/gone/stale.txt"
  git -C "$repo" add skills
  git -C "$repo" commit -qm files
  printf 'new, not ignored\n' >"$src/scripts/untracked.txt"
  printf 'bytecode\n' >"$src/scripts/__pycache__/tool.cpython-312.pyc"
  printf 'log\n' >"$src/debug.log"
  printf 'dev venv\n' >"$src/.venv/bin/marker"
  printf 'dep\n' >"$src/node_modules/pkg/index.js"

  HOME="$home" "$repo/install.sh" --local sync-me >"$WORK/resync1.out" 2>"$WORK/resync1.err" ||
    fail "expected first local sync to succeed: $(cat "$WORK/resync1.err")"
  [ -f "$dest/scripts/tool.py" ] || fail "expected tracked files to be synced"
  [ -f "$dest/scripts/café.txt" ] || fail "expected a non-ASCII file name to be synced"
  [ -f "$dest/scripts/untracked.txt" ] || fail "expected untracked, non-ignored files to be synced"
  [ -f "$dest/.gitignore" ] || fail "expected the skill's .gitignore to be synced"
  [ ! -e "$dest/scripts/__pycache__" ] || fail "expected gitignored caches not to be synced"
  [ ! -e "$dest/debug.log" ] || fail "expected gitignored files not to be synced"
  [ ! -e "$dest/.venv" ] || fail "expected the checkout's dev .venv not to be synced"
  [ ! -e "$dest/node_modules" ] || fail "expected node_modules not to be synced"

  mkdir -p "$dest/.venv/bin" "$dest/scripts/__pycache__"
  printf 'installed venv\n' >"$dest/.venv/bin/python-marker"
  printf 'old cache\n' >"$dest/scripts/__pycache__/old.pyc"
  git -C "$repo" rm -q -r skills/sync-me/gone
  git -C "$repo" commit -qm "drop gone"
  rm -f "$src/scripts/untracked.txt"
  printf 'changed\n' >"$src/scripts/tool.py"

  HOME="$home" "$repo/install.sh" --local sync-me >"$WORK/resync2.out" 2>"$WORK/resync2.err" ||
    fail "expected local resync to succeed: $(cat "$WORK/resync2.err")"
  grep -Fx "installed venv" "$dest/.venv/bin/python-marker" >/dev/null ||
    fail "expected the installed .venv to survive a resync"
  grep -Fx "changed" "$dest/scripts/tool.py" >/dev/null || fail "expected resync to refresh changed files"
  [ ! -e "$dest/gone" ] || fail "expected resync to remove files and directories no longer in the checkout"
  [ ! -e "$dest/scripts/untracked.txt" ] || fail "expected resync to remove a deleted untracked file"
  [ ! -e "$dest/scripts/__pycache__" ] || fail "expected resync to remove caches an older sync left behind"
  [ -f "$dest/SKILL.md" ] || fail "expected SKILL.md to remain"
}

# Outside a git checkout there is no ignore list; the sync falls back to every
# file except the well-known caches and the venv.
test_local_sync_without_git_skips_caches() {
  local repo="$WORK/plain-sync-repo"
  local home="$WORK/plain-sync-home"

  mkdir -p "$repo/skills/plain/scripts/__pycache__" "$repo/skills/plain/.venv" "$home"
  if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "SKIP ${FUNCNAME[0]}: $repo is inside a git work tree"
    return 0
  fi
  cp "$INSTALL" "$repo/install.sh"
  printf -- '---\nname: plain\ndescription: Plain test skill.\n---\n' >"$repo/skills/plain/SKILL.md"
  printf 'x\n' >"$repo/skills/plain/scripts/run.sh"
  printf 'x\n' >"$repo/skills/plain/scripts/__pycache__/run.pyc"
  printf 'x\n' >"$repo/skills/plain/.venv/pyvenv.cfg"

  HOME="$home" bash "$repo/install.sh" --local plain >"$WORK/plain-sync.out" 2>"$WORK/plain-sync.err" ||
    fail "expected plain sync to succeed: $(cat "$WORK/plain-sync.err")"
  [ -f "$home/.agents/skills/plain/scripts/run.sh" ] || fail "expected plain sync to copy files"
  [ ! -e "$home/.agents/skills/plain/scripts/__pycache__" ] || fail "expected plain sync to skip __pycache__"
  [ ! -e "$home/.agents/skills/plain/.venv" ] || fail "expected plain sync to skip .venv"
}

# A checkout cloned at ~/.agents is its own sync destination; syncing it would
# delete whatever the file listing leaves out (caches, ignored state).
test_local_sync_refuses_the_checkout_itself() {
  local home="$WORK/self-sync-home"
  local repo="$home/.agents"

  mkdir -p "$repo/skills/plain/scripts/__pycache__"
  if git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "SKIP ${FUNCNAME[0]}: $repo is inside a git work tree"
    return 0
  fi
  cp "$INSTALL" "$repo/install.sh"
  printf -- '---\nname: plain\ndescription: Plain test skill.\n---\n' >"$repo/skills/plain/SKILL.md"
  printf 'x\n' >"$repo/skills/plain/scripts/__pycache__/keep.pyc"

  HOME="$home" bash "$repo/install.sh" --local plain >"$WORK/self-sync.out" 2>"$WORK/self-sync.err" || true
  grep -q 'is the checkout itself' "$WORK/self-sync.err" ||
    fail "expected self-sync to be refused: $(cat "$WORK/self-sync.err")"
  [ -f "$repo/skills/plain/scripts/__pycache__/keep.pyc" ] || fail "expected self-sync to delete nothing"
  [ -f "$repo/skills/plain/SKILL.md" ] || fail "expected self-sync to keep SKILL.md"
}

# git_counting_shim <dir> <log>: put a `git` on PATH that logs each ls-remote.
git_counting_shim() {
  local dir="$1" log="$2" real
  real="$(command -v git)"
  mkdir -p "$dir"
  {
    echo '#!/usr/bin/env bash'
    echo "[ \"\$1\" = ls-remote ] && echo ls-remote >>'$log'"
    echo "exec '$real' \"\$@\""
  } >"$dir/git"
  chmod +x "$dir/git"
  : >"$log"
}

count_lines() {
  wc -l <"$1" | tr -d ' '
}

test_install_reads_split_branches_with_one_ls_remote() {
  local repo="$WORK/split-lookup-repo"
  local home="$WORK/split-lookup-home"
  local shim="$WORK/split-lookup-shim"
  local log="$WORK/split-lookup.log"
  local publish="$WORK/split-lookup-publish"

  make_skill_repo "$repo" published unpublished other
  mkdir -p "$publish" "$home/.codex"
  git init -q "$publish"
  git -C "$publish" config user.email "test@example.com"
  git -C "$publish" config user.name "Test"
  cp "$repo/skills/published/SKILL.md" "$publish/SKILL.md"
  git -C "$publish" add SKILL.md
  git -C "$publish" commit -qm split
  git -C "$publish" push -q "$repo.remote.git" HEAD:refs/heads/split/published
  git_counting_shim "$shim" "$log"

  PATH="$shim:$PATH" HOME="$home" "$repo/install.sh" >"$WORK/split-lookup.out" 2>"$WORK/split-lookup.err" ||
    fail "expected default install to succeed: $(cat "$WORK/split-lookup.err")"
  [ "$(count_lines "$log")" = "1" ] ||
    fail "expected one git ls-remote for three skills, got $(count_lines "$log")"
  [ -d "$home/.agents/skills/published/.git" ] || fail "expected the published split branch to be cloned"
  grep -F "split/unpublished is not published" "$WORK/split-lookup.out" >/dev/null ||
    fail "expected an unpublished skill to fall back to the checkout"
  [ -f "$home/.agents/skills/other/SKILL.md" ] || fail "expected the other unpublished skill to sync"

  # Existing fallback installs need the lookup too; still one call.
  : >"$log"
  PATH="$shim:$PATH" HOME="$home" "$repo/install.sh" >"$WORK/split-lookup2.out" 2>"$WORK/split-lookup2.err" ||
    fail "expected repeated default install to succeed: $(cat "$WORK/split-lookup2.err")"
  [ "$(count_lines "$log")" = "1" ] ||
    fail "expected one git ls-remote on a repeated install, got $(count_lines "$log")"
  grep -F "already cloned" "$WORK/split-lookup2.out" >/dev/null || fail "expected the clone to be left alone"

  # Unreachable origin: reported per skill, never treated as unpublished.
  git -C "$repo" remote set-url origin "$WORK/no-such-remote.git"
  : >"$log"
  PATH="$shim:$PATH" HOME="$WORK/split-offline-home" "$repo/install.sh" unpublished other \
    >"$WORK/split-offline.out" 2>"$WORK/split-offline.err" || true
  [ "$(count_lines "$log")" = "1" ] || fail "expected one git ls-remote while offline"
  [ "$(grep -c "could not reach" "$WORK/split-offline.err")" = "2" ] ||
    fail "expected each skill to report the unreachable origin"
  [ ! -e "$WORK/split-offline-home/.agents/skills/other" ] ||
    fail "expected no local fallback when the origin cannot be reached"
}

# Claude Code run with CLAUDE_CONFIG_DIR reads skills from that dir, and Codex
# from $CODEX_HOME; a profile setup often points both at one dir.
test_install_links_into_claude_config_dir_and_codex_home() {
  local home="$WORK/env-dirs-home"
  local profile="$WORK/env-dirs-profile"
  local codex="$WORK/env-dirs-codex"
  local profile_env="$profile/" codex_env="$codex" link

  mkdir -p "$home/.claude" "$profile" "$codex"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # Windows shells hand these over as native paths.
      profile_env="$(cygpath -w "$profile")\\"
      codex_env="$(cygpath -w "$codex")"
      ;;
  esac

  CLAUDE_CONFIG_DIR="$profile_env" CODEX_HOME="$codex_env" HOME="$home" "$INSTALL" --local step-back \
    >"$WORK/env-dirs.out" 2>"$WORK/env-dirs.err" ||
    fail "expected install with CLAUDE_CONFIG_DIR/CODEX_HOME to succeed: $(cat "$WORK/env-dirs.err")"
  [ -f "$home/.claude/skills/step-back/SKILL.md" ] || fail "expected ~/.claude to stay linked"
  [ -f "$profile/skills/step-back/SKILL.md" ] || fail "expected a link in \$CLAUDE_CONFIG_DIR/skills"
  [ -f "$codex/skills/step-back/SKILL.md" ] || fail "expected a link in \$CODEX_HOME/skills"
  [ ! -e "$home/.codex" ] || fail "expected ~/.codex not to be used when CODEX_HOME is set"

  CLAUDE_CONFIG_DIR="$profile_env" CODEX_HOME="$codex_env" HOME="$home" "$UNINSTALL" step-back \
    >"$WORK/env-dirs-un.out" 2>"$WORK/env-dirs-un.err" ||
    fail "expected uninstall with CLAUDE_CONFIG_DIR/CODEX_HOME to succeed: $(cat "$WORK/env-dirs-un.err")"
  for link in "$home/.claude/skills/step-back" "$profile/skills/step-back" "$codex/skills/step-back"; do
    [ ! -e "$link" ] && [ ! -L "$link" ] || fail "expected uninstall to remove $link"
  done

  # One dir named by both variables gets one link and no warning.
  CLAUDE_CONFIG_DIR="$profile_env" CODEX_HOME="$profile_env" HOME="$home" "$INSTALL" --local step-back \
    >"$WORK/env-same.out" 2>"$WORK/env-same.err" ||
    fail "expected install with one shared profile dir to succeed: $(cat "$WORK/env-same.err")"
  [ "$(grep -c "skills/step-back ->" "$WORK/env-same.out")" = "2" ] ||
    fail "expected two harness links (~/.claude and the shared profile): $(cat "$WORK/env-same.out")"
  ! grep -F "WARN" "$WORK/env-same.err" >/dev/null || fail "expected no warning for a shared profile dir"
  CLAUDE_CONFIG_DIR="$profile_env" CODEX_HOME="$profile_env" HOME="$home" "$UNINSTALL" step-back \
    >"$WORK/env-same-un.out" 2>"$WORK/env-same-un.err" ||
    fail "expected uninstall of the shared profile link to succeed: $(cat "$WORK/env-same-un.err")"
  [ ! -e "$profile/skills/step-back" ] && [ ! -L "$profile/skills/step-back" ] ||
    fail "expected uninstall to remove the shared profile link"
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
test_agent_memory_shadow_requires_windows_launcher_on_path
test_install_warns_when_the_skill_is_also_a_claude_code_plugin
test_uninstall_reports_the_claude_code_plugin_copy_it_cannot_remove
test_uninstall_removes_agent_memory_integration_hooks
test_install_with_no_harness_dirs_and_duplicate_names
test_local_resync_keeps_venv_and_copies_only_unignored_files
test_local_sync_without_git_skips_caches
test_local_sync_refuses_the_checkout_itself
test_install_reads_split_branches_with_one_ls_remote
test_install_links_into_claude_config_dir_and_codex_home

echo "install tests passed"
