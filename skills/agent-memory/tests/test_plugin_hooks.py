from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import agent_memory.integration as integration_module
from agent_memory.cli import detect_hook_harness
from agent_memory.integration import integrate

SKILL_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SKILL_ROOT.parents[1]
# (hooks file, plugin root it is loaded from, the host that loads it). Codex
# reads the file `.codex-plugin/plugin.json` names and Claude Code
# `hooks/hooks.json`, so each file names its host instead of guessing it.
PLUGIN_HOOK_FILES = (
    (REPO_ROOT / "hooks" / "hooks.json", REPO_ROOT, "claude"),
    (SKILL_ROOT / "hooks" / "hooks.json", SKILL_ROOT, "claude"),
    (REPO_ROOT / "hooks" / "hooks.codex.json", REPO_ROOT, "codex"),
    (SKILL_ROOT / "hooks" / "hooks.codex.json", SKILL_ROOT, "codex"),
)
CLAUDE_UUID = "6ad0f31a-9dbe-4291-9a5f-9ccea4690da6"
needs_bash = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None, reason="POSIX bash launcher"
)


@pytest.mark.parametrize(
    ("payload", "env", "expected"),
    [
        ({"transcript_path": "/home/u/.codex/sessions/2026/x.jsonl"}, {}, "codex"),
        ({"transcript_path": "/home/u/.claude/projects/p/x.jsonl"}, {}, "claude"),
        ({"transcript_path": "/srv/codex-home/sessions/x.jsonl"}, {"CODEX_HOME": "/srv/codex-home"}, "codex"),
        ({"turn_id": "t1"}, {}, "codex"),
        ({}, {}, "claude"),
        # One profile folder serving as both CLAUDE_CONFIG_DIR and CODEX_HOME:
        # the transcript's own layout names the host, not the folder it is in.
        (
            {"transcript_path": f"C:\p\projects\C--opt-repo\{CLAUDE_UUID}.jsonl"},
            {"CODEX_HOME": "C:\p"},
            "claude",
        ),
        (
            {"transcript_path": f"/p/projects/-srv-repo/{CLAUDE_UUID}/subagents/agent-a1.jsonl"},
            {"CODEX_HOME": "/p"},
            "claude",
        ),
        (
            {"transcript_path": "/p/sessions/2026/11/24/rollout-2026-11-24T13-14-12-01a2.jsonl"},
            {"CODEX_HOME": "/p"},
            "codex",
        ),
        ({"prompt": "<task-notification><tool-use-id>toolu_01X</tool-use-id></task-notification>"}, {}, "claude"),
    ],
)
def test_detect_hook_harness_reads_the_payload(monkeypatch, payload, env, expected):
    monkeypatch.delenv("CODEX_HOME", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    assert detect_hook_harness(payload) == expected


def test_running_from_plugin_matches_plugin_caches(tmp_path):
    claude = tmp_path / ".claude" / "plugins" / "cache" / "m" / "agent-skills" / "1.0.0"
    codex = tmp_path / ".codex" / "plugins" / "cache" / "m" / "agent-memory" / "1.0.0"
    skills = tmp_path / ".agents" / "skills" / "agent-memory"
    for path in (claude, codex, skills):
        path.mkdir(parents=True)

    assert integration_module.running_from_plugin(claude / "skills" / "agent-memory")
    assert integration_module.running_from_plugin(codex)
    assert not integration_module.running_from_plugin(skills)


def _managed_settings(command: str) -> dict:
    return {
        "hooks": {
            "UserPromptSubmit": [
                {
                    "matcher": "",
                    "hooks": [
                        {
                            "type": "command",
                            "command": command,
                            "statusMessage": "Agent Memory v2 user_prompt (agent-memory-v2-managed)",
                        }
                    ],
                },
                {"hooks": [{"type": "command", "command": "echo keep"}]},
            ]
        }
    }


def _install_plugin(home: Path, *hosts: str) -> None:
    if "claude" in hosts:
        registry = home / ".claude" / "plugins" / "installed_plugins.json"
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text(
            json.dumps(
                {"plugins": {"agent-skills@555cider-agent-skills": [{"installPath": "/x"}]}}
            ),
            encoding="utf-8",
        )
    if "codex" in hosts:
        config = home / ".codex" / "config.toml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(
            '[plugins."agent-skills@555cider-agent-skills"]\nenabled = true\n', encoding="utf-8"
        )


def test_plugin_integrate_removes_settings_hooks_and_still_disables_native_memory(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(integration_module, "running_from_plugin", lambda *a: True)
    home = tmp_path / "home"
    stale = "/gone/.venv/bin/python /gone/scripts/memory.py hook --harness claude --event user_prompt"
    claude = home / ".claude" / "settings.json"
    codex_hooks = home / ".codex" / "hooks.json"
    claude.parent.mkdir(parents=True)
    codex_hooks.parent.mkdir(parents=True)
    claude.write_text(json.dumps(_managed_settings(stale)), encoding="utf-8")
    codex_hooks.write_text(
        json.dumps(_managed_settings(stale.replace("claude", "codex"))), encoding="utf-8"
    )
    _install_plugin(home, "claude", "codex")

    result = integrate(
        memory_home=tmp_path / "memory",
        mode="primary",
        harness="all",
        apply=True,
        user_home=home,
    )

    assert result["plugin_hooks"] is True
    assert result["harnesses"] == ["claude", "codex"]
    settings = json.loads(claude.read_text(encoding="utf-8"))
    assert settings["autoMemoryEnabled"] is False
    assert settings["hooks"]["UserPromptSubmit"] == [
        {"hooks": [{"type": "command", "command": "echo keep"}]}
    ]
    codex = json.loads(codex_hooks.read_text(encoding="utf-8"))
    assert "memory.py" not in json.dumps(codex)
    assert "memories = false" in (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert not (home / ".config" / "opencode" / "plugins" / "agent-memory.js").exists()


def test_plugin_integrate_refuses_the_opencode_adapter(tmp_path, monkeypatch):
    monkeypatch.setattr(integration_module, "running_from_plugin", lambda *a: True)

    with pytest.raises(integration_module.MemoryError, match="OpenCode adapter"):
        integrate(
            memory_home=tmp_path / "memory",
            mode="shadow",
            harness="opencode",
            apply=False,
            user_home=tmp_path / "home",
        )


@pytest.mark.parametrize(("hooks_file", "plugin_root", "host"), PLUGIN_HOOK_FILES)
def test_plugin_hooks_file_targets_the_shipped_launcher(hooks_file, plugin_root, host):
    data = json.loads(hooks_file.read_text(encoding="utf-8"))
    events = {
        name: entry["hooks"][0]["command"]
        for name, entries in data["hooks"].items()
        for entry in entries
    }

    assert set(events) == {"UserPromptSubmit", "Stop", "SessionEnd"}
    for command in events.values():
        assert f"--harness {host} " in command
        relative = command.split('"')[1].rsplit("}", 1)[1]
        assert (plugin_root / relative.lstrip("/")).resolve() == SKILL_ROOT / "bin" / "agent-memory"
    # Codex substitutes `${PLUGIN_ROOT}` into the text and runs it through
    # PowerShell on Windows, where a shell default (`${A:-${B}}`) is a variable
    # name and comes out empty.
    if host == "codex":
        assert all('"${PLUGIN_ROOT}/' in command for command in events.values())


@pytest.mark.parametrize("plugin_root", [REPO_ROOT, SKILL_ROOT])
def test_codex_manifest_points_at_the_codex_hooks(plugin_root):
    manifest = json.loads((plugin_root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))

    assert manifest["hooks"] == "./hooks/hooks.codex.json"
    assert (plugin_root / "hooks" / "hooks.codex.json").is_file()


def _run_hook(command: str, env: dict[str, str], payload: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "-c", command],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env=env,
        check=False,
        timeout=60,
    )


@needs_bash
@pytest.mark.parametrize("variable", ["CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"])
@pytest.mark.parametrize(("hooks_file", "plugin_root", "host"), PLUGIN_HOOK_FILES)
def test_plugin_prompt_hook_runs_under_either_host_variable(
    tmp_path, hooks_file, plugin_root, host, variable
):
    if host == "codex" and variable != "PLUGIN_ROOT":
        pytest.skip("Codex sets PLUGIN_ROOT")
    command = json.loads(hooks_file.read_text(encoding="utf-8"))["hooks"]["UserPromptSubmit"][0][
        "hooks"
    ][0]["command"]
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"}
    }
    env.update(
        {
            variable: str(plugin_root),
            "HOME": str(tmp_path / "home"),
            "AGENT_MEMORY_HOME": str(tmp_path / "memory"),
            "AGENT_MEMORY_SYNC_WORKER": "1",
            "PATH": str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", ""),
        }
    )
    payload = {
        "cwd": str(tmp_path),
        "prompt": "hello",
        "transcript_path": str(tmp_path / ".codex" / "sessions" / "x.jsonl"),
    }

    result = _run_hook(command, env, payload)

    assert result.returncode == 0, result.stderr
    assert isinstance(json.loads(result.stdout), dict)
    db = sqlite3.connect(tmp_path / "memory" / "agent-memory.sqlite3")
    try:
        rows = db.execute("SELECT harness, kind FROM events").fetchall()
    finally:
        db.close()
    # The transcript sits under `.codex`, yet the file's own host wins.
    assert rows == [(host, "user_prompt")]


def _copy_launcher(directory: Path) -> Path:
    directory.mkdir(parents=True)
    launcher = directory / "agent-memory"
    shutil.copy2(SKILL_ROOT / "bin" / "agent-memory", launcher)
    return launcher


@needs_bash
def test_path_launcher_finds_the_plugin_through_the_claude_registry(tmp_path):
    home = tmp_path / "home"
    install = tmp_path / "cache" / "agent-skills" / "9.9.9"
    (install / "skills").mkdir(parents=True)
    os.symlink(SKILL_ROOT, install / "skills" / "agent-memory")
    registry = home / ".claude" / "plugins" / "installed_plugins.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(
        json.dumps(
            {"plugins": {"agent-skills@555cider-agent-skills": [{"installPath": str(install)}]}}
        ),
        encoding="utf-8",
    )
    launcher = _copy_launcher(home / ".local" / "bin")
    env = {
        "HOME": str(home),
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        "AGENT_MEMORY_HOME": str(tmp_path / "memory"),
    }

    result = subprocess.run(
        ["bash", str(launcher), "--version"], text=True, capture_output=True, env=env, check=False
    )

    assert result.returncode == 0, result.stderr


@needs_bash
def test_path_launcher_finds_the_newest_codex_plugin_cache(tmp_path):
    home = tmp_path / "home"
    cache = home / ".codex" / "plugins" / "cache" / "555cider-agent-skills" / "agent-memory"
    cache.mkdir(parents=True)
    os.symlink(SKILL_ROOT, cache / "1.0.0")
    launcher = _copy_launcher(home / ".local" / "bin")
    env = {
        "HOME": str(home),
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        "AGENT_MEMORY_HOME": str(tmp_path / "memory"),
    }

    result = subprocess.run(
        ["bash", str(launcher), "--version"], text=True, capture_output=True, env=env, check=False
    )

    assert result.returncode == 0, result.stderr


@needs_bash
def test_path_launcher_without_any_install_fails_open_for_hooks_only(tmp_path):
    home = tmp_path / "home"
    launcher = _copy_launcher(home / ".local" / "bin")
    env = {"HOME": str(home), "PATH": os.environ.get("PATH", "")}

    hook = subprocess.run(
        ["bash", str(launcher), "hook", "--harness", "auto"],
        input="{}",
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    other = subprocess.run(
        ["bash", str(launcher), "doctor"], text=True, capture_output=True, env=env, check=False
    )

    assert (hook.returncode, hook.stdout.strip()) == (0, "{}")
    assert other.returncode == 127
    assert "skill not found" in other.stderr


def test_plugin_integrate_leaves_a_host_without_the_plugin_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(integration_module, "running_from_plugin", lambda *a: True)
    home = tmp_path / "home"
    stale = "/gone/python /gone/scripts/memory.py hook --harness codex --event user_prompt"
    codex_hooks = home / ".codex" / "hooks.json"
    codex_hooks.parent.mkdir(parents=True)
    codex_hooks.write_text(json.dumps(_managed_settings(stale)), encoding="utf-8")
    codex_config = home / ".codex" / "config.toml"
    codex_config.write_text(
        '[plugins."agent-skills@555cider-agent-skills"]\nenabled = false\n', encoding="utf-8"
    )
    before = (codex_hooks.read_text(encoding="utf-8"), codex_config.read_text(encoding="utf-8"))
    _install_plugin(home, "claude")

    result = integrate(
        memory_home=tmp_path / "memory", mode="primary", harness="all", apply=True, user_home=home
    )

    assert result["harnesses"] == ["claude"]
    assert result["skipped"] == ["codex"]
    after = (codex_hooks.read_text(encoding="utf-8"), codex_config.read_text(encoding="utf-8"))
    assert after == before
    with pytest.raises(integration_module.MemoryError, match="codex does not have"):
        integrate(
            memory_home=tmp_path / "memory",
            mode="primary",
            harness="codex",
            apply=False,
            user_home=home,
        )


@needs_bash
def test_settings_hook_with_a_deleted_skill_does_not_block_the_prompt(tmp_path, monkeypatch):
    monkeypatch.setattr(integration_module.sys, "platform", "linux")
    command = integration_module._hook_command("codex", "user_prompt").replace(
        str(SKILL_ROOT), str(tmp_path / "deleted")
    )

    result = subprocess.run(["sh", "-c", command], input="{}", text=True, capture_output=True)

    assert "deleted" in command and "No such file" in result.stderr
    assert result.returncode == 0


@needs_bash
def test_path_launcher_prefers_the_highest_codex_version_and_user_scope(tmp_path):
    home = tmp_path / "home"
    cache = home / ".codex" / "plugins" / "cache" / "555cider-agent-skills" / "agent-memory"
    cache.mkdir(parents=True)
    os.symlink(SKILL_ROOT, cache / "1.10.0")
    (cache / "1.9.0" / "scripts").mkdir(parents=True)
    (cache / "1.9.0" / "scripts" / "memory.py").write_text("raise SystemExit(9)\n")
    launcher = _copy_launcher(home / ".local" / "bin")
    env = {
        "HOME": str(home),
        "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        "AGENT_MEMORY_HOME": str(tmp_path / "memory"),
    }

    codex = subprocess.run(["bash", str(launcher), "--version"], text=True, capture_output=True, env=env)
    assert codex.returncode == 0, codex.stderr

    project = tmp_path / "project-install"
    (project / "scripts").mkdir(parents=True)
    (project / "scripts" / "memory.py").write_text("raise SystemExit(8)\n")
    registry = home / ".claude" / "plugins" / "installed_plugins.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(
        json.dumps(
            {
                "plugins": {
                    "agent-memory@555cider-agent-skills": [
                        {"scope": "project", "installPath": str(project)},
                        {"scope": "user", "installPath": str(SKILL_ROOT)},
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    claude = subprocess.run(["bash", str(launcher), "--version"], text=True, capture_output=True, env=env)
    assert claude.returncode == 0, claude.stderr


@needs_bash
def test_checkout_launcher_still_prefers_the_install_sh_copy(tmp_path):
    home = tmp_path / "home"
    installed = home / ".agents" / "skills" / "agent-memory" / "scripts"
    installed.mkdir(parents=True)
    (installed / "memory.py").write_text("raise SystemExit(7)\n")

    result = subprocess.run(
        ["bash", str(SKILL_ROOT / "bin" / "agent-memory"), "--version"],
        text=True,
        capture_output=True,
        env={"HOME": str(home), "PATH": os.environ.get("PATH", "")},
    )

    assert result.returncode == 7


def _git_bash() -> str | None:
    git = shutil.which("git")
    if not git:
        return None
    roots = Path(git).parents[1:3]
    for candidate in (root / sub / "bash.exe" for root in roots for sub in ("bin", "usr/bin")):
        if candidate.is_file():
            return str(candidate)
    return None


@pytest.mark.skipif(sys.platform != "win32" or _git_bash() is None, reason="Git Bash on Windows")
def test_launcher_hands_windows_python_a_windows_path_under_msys_no_pathconv(tmp_path):
    # MSYS_NO_PATHCONV=1 stops Git Bash from rewriting `/c/...` arguments, so a
    # Windows python was handed `/c/opt/...` and opened `C:\c\opt\...`.
    shim = tmp_path / "bin"
    shim.mkdir()
    (shim / "python3").write_text(f'#!/bin/sh\nexec "{Path(sys.executable).as_posix()}" "$@"\n', newline="\n")
    env = dict(os.environ)
    env.update({"HOME": str(tmp_path / "home"), "MSYS_NO_PATHCONV": "1"})
    env.pop("CLAUDE_CONFIG_DIR", None)
    env.pop("CODEX_HOME", None)
    script = f'export PATH="$(cygpath -u "{shim}"):$PATH"; exec bash "$(cygpath -u "{SKILL_ROOT / "bin" / "agent-memory"}")" --version'

    result = subprocess.run([_git_bash(), "-c", script], text=True, capture_output=True, env=env, timeout=60)

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()
