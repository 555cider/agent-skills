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

git_repo_with() {
  local dir="$1" file="$2"
  mkdir -p "$dir"
  git init -q "$dir"
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test"
  [ -f "$dir/$file" ] || printf 'tracked\n' >"$dir/$file"
  git -C "$dir" add "$file"
  git -C "$dir" commit -qm init
}

# An install must never overwrite a directory it did not create: a plain
# directory with another skill's files, an unrelated git repo (default and
# --local), or its own managed clone with local work in it.
test_install_never_overwrites_a_directory_it_did_not_create() {
  local repo="$WORK/guard-repo"
  local home="$WORK/guard-home"
  local skills="$home/.agents/skills"

  make_skill_repo "$repo" plain-dir unrelated dirty
  mkdir -p "$skills/plain-dir" "$home/.codex"
  printf 'do not delete\n' >"$skills/plain-dir/existing.txt"
  printf 'unrelated\n' >"$WORK/keep.txt"
  mkdir -p "$skills/unrelated" && cp "$WORK/keep.txt" "$skills/unrelated/keep.txt"
  git_repo_with "$skills/unrelated" keep.txt
  cp "$repo/skills/dirty/SKILL.md" "$WORK/dirty-SKILL.md"
  mkdir -p "$skills/dirty" && cp "$WORK/dirty-SKILL.md" "$skills/dirty/SKILL.md"
  git_repo_with "$skills/dirty" SKILL.md
  git -C "$skills/dirty" branch -m split/dirty
  git -C "$skills/dirty" remote add origin "$repo.remote.git"
  git -C "$skills/dirty" update-ref refs/remotes/origin/split/dirty HEAD
  git -C "$skills/dirty" branch --set-upstream-to=origin/split/dirty >/dev/null
  printf 'keep this local work\n' >"$skills/dirty/local-work.txt"

  HOME="$home" "$repo/install.sh" plain-dir unrelated dirty >"$WORK/guard.out" 2>"$WORK/guard.err" || true
  grep -Fx "do not delete" "$skills/plain-dir/existing.txt" >/dev/null ||
    fail "expected a mismatched plain directory to be preserved"
  [ ! -f "$skills/plain-dir/SKILL.md" ] || fail "expected a mismatched plain directory not to be synced over"
  grep -Fx "unrelated" "$skills/unrelated/keep.txt" >/dev/null || fail "expected an unrelated git repo to be preserved"
  [ ! -e "$home/.codex/skills/unrelated" ] || fail "expected no harness link to an unrelated git repo"
  grep -Fx "keep this local work" "$skills/dirty/local-work.txt" >/dev/null ||
    fail "expected default install to leave a dirty managed clone alone"

  HOME="$home" "$repo/install.sh" --local unrelated >"$WORK/guard-local.out" 2>"$WORK/guard-local.err" || true
  grep -Fx "unrelated" "$skills/unrelated/keep.txt" >/dev/null ||
    fail "expected --local to preserve an unrelated git repo"
  [ ! -f "$skills/unrelated/SKILL.md" ] || fail "expected --local not to sync over an unrelated git repo"
}

test_uninstall_preserves_clone_without_upstream() {
  local home="$WORK/no-upstream-home"
  local clone="$home/.agents/skills/test-skill"

  git_repo_with "$clone" tracked.txt
  if HOME="$home" "$UNINSTALL" test-skill >"$WORK/no-upstream.out" 2>"$WORK/no-upstream.err"; then
    fail "expected uninstall to refuse a clone without an upstream"
  fi
  [ -f "$clone/tracked.txt" ] && [ -d "$clone/.git" ] ||
    fail "expected uninstall to preserve a clone without an upstream"
}

# A stray skills/<dir> with only a __pycache__ in it used to be installed as a skill.
test_directory_without_skill_md_is_not_a_skill() {
  local repo="$WORK/stray-repo"
  local home="$WORK/stray-home"

  make_skill_repo "$repo" real-skill
  mkdir -p "$repo/skills/leftover/scripts/__pycache__" "$home/.codex"
  printf 'bytecode\n' >"$repo/skills/leftover/scripts/__pycache__/stale.cpython-314.pyc"

  HOME="$home" "$repo/install.sh" --local >"$WORK/stray.out" 2>"$WORK/stray.err" ||
    fail "expected a directory without SKILL.md to leave the exit status clean"
  [ -f "$home/.agents/skills/real-skill/SKILL.md" ] || fail "expected the declared skill to install"
  [ ! -e "$home/.agents/skills/leftover" ] || fail "expected a directory without SKILL.md to never be installed"
  [ -d "$repo/skills/leftover" ] || fail "expected install.sh to never delete from the source checkout"
  if HOME="$home" "$repo/install.sh" --local leftover >/dev/null 2>&1; then
    fail "expected selecting a directory without SKILL.md to fail"
  fi
}

# One agent-memory install (the only skill with a venv, launcher and harness
# hooks) covers --shadow setup and uninstall: existing harness settings are
# kept, and uninstall removes the hooks before the skill so no session runs
# hooks that point at nothing.
test_agent_memory_shadow_install_and_uninstall() {
  local home="$WORK/shadow-home"
  local out="$WORK/shadow.out"
  local err="$WORK/shadow.err"

  mkdir -p "$home/.claude" "$home/.codex"
  printf '%s\n' '{"autoMemoryEnabled":true,"theme":"dark"}' >"$home/.claude/settings.json"
  printf '%s\n' \
    '[features]' \
    'memories = true' \
    '' \
    '[plugins."remember-codex-bridge@personal"]' \
    'enabled = true' >"$home/.codex/config.toml"

  HOME="$home" PATH="$home/.local/bin:$PATH" "$INSTALL" --local agent-memory --shadow >"$out" 2>"$err" ||
    fail "expected shadow setup to succeed: $(cat "$err")"
  grep -qF "agent-memory-v2-managed" "$home/.claude/settings.json" || fail "expected Claude hooks after shadow setup"
  [ -f "$home/.codex/hooks.json" ] || fail "expected Codex hooks after shadow setup"
  [ -f "$home/.config/opencode/plugins/agent-memory.js" ] || fail "expected OpenCode plugin after shadow setup"
  [ -f "$home/.codex/skills/agent-memory/SKILL.md" ] || fail "expected the codex harness link to resolve"
  [ -x "$home/.local/bin/agent-memory" ] || fail "expected executable agent-memory launcher"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      grep -qsF 'agent-memory-managed-launcher' "$home/.local/bin/agent-memory.cmd" ||
        fail "expected managed agent-memory.cmd shim on Windows"
      ;;
  esac
  HOME="$home" "$home/.local/bin/agent-memory" doctor --format json >"$WORK/shadow-doctor.json" ||
    fail "expected the installed launcher to run"
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

  HOME="$home" PATH="$home/.local/bin:$PATH" "$UNINSTALL" agent-memory >"$WORK/shadow-un.out" 2>"$WORK/shadow-un.err" ||
    fail "expected uninstall to succeed: $(cat "$WORK/shadow-un.err")"
  ! grep -qF "agent-memory" "$home/.claude/settings.json" ||
    fail "expected uninstall to remove the agent-memory hooks from Claude settings"
  grep -qF '"theme": "dark"' "$home/.claude/settings.json" || fail "expected uninstall to keep unrelated Claude settings"
  ! grep -qsF "agent-memory" "$home/.codex/hooks.json" || fail "expected uninstall to remove the Codex hooks"
  [ ! -e "$home/.config/opencode/plugins/agent-memory.js" ] || fail "expected uninstall to remove the OpenCode plugin"
  [ ! -e "$home/.agents/skills/agent-memory" ] || fail "expected the skill itself to be removed after its hooks"
  [ ! -e "$home/.codex/skills/agent-memory" ] && [ ! -L "$home/.codex/skills/agent-memory" ] ||
    fail "expected the codex harness link to be removed"
  [ ! -e "$home/.local/bin/agent-memory" ] || fail "expected the managed launcher to be removed"
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
  [ -f "$repo/skills/plain/scripts/__pycache__/keep.pyc" ] || fail "expected self-sync to delete nothing"
  [ -f "$repo/skills/plain/SKILL.md" ] || fail "expected self-sync to keep SKILL.md"
}

count_lines() {
  wc -l <"$1" | tr -d ' '
}

# Default install: published skills are cloned from split/<name>, unpublished
# ones fall back to (and are refreshed from) the checkout, all with one
# `git ls-remote`. An unreachable origin is never treated as unpublished.
test_default_install_clones_published_and_falls_back_for_unpublished() {
  local repo="$WORK/split-lookup-repo"
  local home="$WORK/split-lookup-home"
  local shim="$WORK/split-lookup-shim"
  local log="$WORK/split-lookup.log"
  local publish="$WORK/split-lookup-publish"
  local real_git

  make_skill_repo "$repo" published unpublished other
  mkdir -p "$home/.codex" "$shim"
  cp "$repo/skills/published/SKILL.md" "$WORK/published-SKILL.md"
  mkdir -p "$publish" && cp "$WORK/published-SKILL.md" "$publish/SKILL.md"
  git_repo_with "$publish" SKILL.md
  git -C "$publish" push -q "$repo.remote.git" HEAD:refs/heads/split/published
  real_git="$(command -v git)"
  {
    echo '#!/usr/bin/env bash'
    echo "[ \"\$1\" = ls-remote ] && echo ls-remote >>'$log'"
    echo "exec '$real_git' \"\$@\""
  } >"$shim/git"
  chmod +x "$shim/git"
  : >"$log"

  PATH="$shim:$PATH" HOME="$home" "$repo/install.sh" >"$WORK/split-lookup.out" 2>"$WORK/split-lookup.err" ||
    fail "expected default install to succeed: $(cat "$WORK/split-lookup.err")"
  [ "$(count_lines "$log")" = "1" ] ||
    fail "expected one git ls-remote for three skills, got $(count_lines "$log")"
  [ -d "$home/.agents/skills/published/.git" ] || fail "expected the published split branch to be cloned"
  [ -f "$home/.agents/skills/unpublished/SKILL.md" ] || fail "expected an unpublished skill to fall back to the checkout"
  [ -f "$home/.codex/skills/unpublished/SKILL.md" ] || fail "expected the codex harness link to resolve"

  # Repeated install: fallback installs are refreshed, still with one lookup.
  printf 'updated\n' >"$repo/skills/unpublished/marker.txt"
  : >"$log"
  PATH="$shim:$PATH" HOME="$home" "$repo/install.sh" >"$WORK/split-lookup2.out" 2>"$WORK/split-lookup2.err" ||
    fail "expected repeated default install to succeed: $(cat "$WORK/split-lookup2.err")"
  [ "$(count_lines "$log")" = "1" ] ||
    fail "expected one git ls-remote on a repeated install, got $(count_lines "$log")"
  grep -Fx "updated" "$home/.agents/skills/unpublished/marker.txt" >/dev/null ||
    fail "expected repeated default install to refresh a local fallback"

  git -C "$repo" remote set-url origin "$WORK/no-such-remote.git"
  : >"$log"
  PATH="$shim:$PATH" HOME="$WORK/split-offline-home" "$repo/install.sh" unpublished other \
    >"$WORK/split-offline.out" 2>"$WORK/split-offline.err" || true
  [ "$(count_lines "$log")" = "1" ] || fail "expected one git ls-remote while offline"
  [ ! -e "$WORK/split-offline-home/.agents/skills/other" ] ||
    fail "expected no local fallback when the origin cannot be reached"
}

# Claude Code run with CLAUDE_CONFIG_DIR reads skills from that dir, and Codex
# from $CODEX_HOME; a profile setup often points both at one dir. Windows
# shells hand both over as native paths.
test_install_links_into_claude_config_dir_and_codex_home() {
  local home="$WORK/env-dirs-home"
  local profile="$WORK/env-dirs-profile"
  local codex="$WORK/env-dirs-codex"
  local profile_env="$profile/" codex_env="$codex" link

  mkdir -p "$home/.claude" "$profile" "$codex"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
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
}

test_install_never_overwrites_a_directory_it_did_not_create
test_uninstall_preserves_clone_without_upstream
test_directory_without_skill_md_is_not_a_skill
test_agent_memory_shadow_install_and_uninstall
test_install_with_no_harness_dirs_and_duplicate_names
test_local_resync_keeps_venv_and_copies_only_unignored_files
test_local_sync_refuses_the_checkout_itself
test_default_install_clones_published_and_falls_back_for_unpublished
test_install_links_into_claude_config_dir_and_codex_home

echo "install tests passed"
