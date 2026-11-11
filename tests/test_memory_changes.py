"""What a command or hook changed is reported back, and only the queue is reviewable."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from agent_memory.cli import hook_change_lines, main
from agent_memory.db import Database
from agent_memory.instructions import loaded_rules
from agent_memory.models import Candidate
from agent_memory.retrieval import Retriever
from agent_memory.util import MemoryError, repo_key

SKILL_ROOT = Path(__file__).resolve().parents[1]


def candidate(statement: str, **overrides):
    values = {
        "kind": "preference",
        "scope": "project",
        "statement": statement,
        "authority": "explicit",
        "confidence": 1.0,
    }
    values.update(overrides)
    return Candidate(**values)


def _hook(tmp_path: Path, capsys, prompt: str, event_id: str) -> dict:
    payload = tmp_path / f"{event_id}.json"
    payload.write_text(
        json.dumps(
            {
                "hook_event_name": "UserPromptSubmit",
                "session_id": "s-changes",
                "event_id": event_id,
                "cwd": str(tmp_path / "repo"),
                "prompt": prompt,
            }
        ),
        encoding="utf-8",
    )
    capsys.readouterr()
    assert main(
        ["--memory-home", str(tmp_path / "store"), "hook", "--harness", "claude",
         "--event", "user_prompt", "--input", str(payload)]
    ) == 0
    return json.loads(capsys.readouterr().out)


# ------------------------------------------------------------------ prompt hook
def test_prompt_hook_says_what_it_stored(tmp_path, capsys):
    (tmp_path / "repo").mkdir()
    output = _hook(tmp_path, capsys, "remember that release notes are written in Korean", "u1")
    context = output["context"]
    assert "Stored from this prompt: [mem_" in context
    assert "release notes are written in Korean" in context
    assert output["visibility"]["material"] is True


def test_prompt_hook_says_when_the_statement_was_already_stored(tmp_path, capsys):
    (tmp_path / "repo").mkdir()
    _hook(tmp_path, capsys, "remember that release notes are written in Korean", "u1")
    context = _hook(tmp_path, capsys, "remember that release notes are written in Korean", "u2")["context"]
    assert "Already stored, confirmed by this prompt: [mem_" in context
    assert "Stored from this prompt" not in context


def test_prompt_hook_reports_forget_and_hides_leftover_matches(tmp_path, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    project = repo_key(repo)
    db = Database(tmp_path / "store")
    from agent_memory.service import MemoryService

    service = MemoryService(db)
    target = service.create_memory(candidate("Prefer pnpm for package installs."), project=project)
    neighbour = service.create_memory(
        candidate("The pnpm store lives under the repository cache."), project=project
    )
    prompt = "forget Prefer pnpm for package installs"
    # Without the fix the leftover neighbour is what maintenance mode presents.
    before = Retriever(db, service.provider).recall(project=project, prompt=prompt)
    assert neighbour["id"] in {item["id"] for item in before["conflicts"]}
    db.close()

    context = _hook(tmp_path, capsys, prompt, "u2")["context"]
    assert "Forgotten by this prompt: 1 record(s)" in context
    assert neighbour["id"] not in context and target["id"] not in context
    db = Database(tmp_path / "store")
    try:
        ids = {row[0] for row in db.conn.execute("SELECT id FROM memories")}
    finally:
        db.close()
    assert ids == {neighbour["id"]}


def test_hook_change_lines_name_an_unapplied_forget():
    lines = hook_change_lines({"forgotten": [], "forget_skipped": 4})
    assert lines and "4 records matched" in lines[0] and "forget --id" in lines[0]
    assert hook_change_lines({}) == []


# ------------------------------------------------------------------ remember
def test_replaces_applies_when_the_statement_already_exists(memory):
    db, service, project = memory
    old = service.create_memory(candidate("Lint with eslint."), project=project)
    new = service.create_memory(candidate("Format with biome."), project=project)
    again = service.create_memory(
        candidate("Format with biome."), project=project, explicit_override=True, replaces_id=old["id"]
    )
    assert again["id"] == new["id"]
    assert [item["id"] for item in again["superseded"]] == [old["id"]]
    assert db.conn.execute("SELECT state FROM memories WHERE id=?", (old["id"],)).fetchone()[0] == "retracted"
    assert db.conn.execute(
        "SELECT relation FROM relations WHERE source_id=? AND target_id=?", (new["id"], old["id"])
    ).fetchone()[0] == "supersedes"


def test_remember_reports_records_retracted_as_contradictory(tmp_path, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    base = ["--memory-home", str(tmp_path / "store"), "remember", "--cwd", str(repo),
            "--kind", "constraint", "--format", "json"]
    assert main([*base, "--statement", "Use pnpm for package installs."]) == 0
    old = json.loads(capsys.readouterr().out)
    assert old["superseded"] == []
    assert main([*base, "--statement", "Do not use pnpm for package installs."]) == 0
    new = json.loads(capsys.readouterr().out)
    assert new["superseded"] == [
        {"id": old["id"], "statement": "Use pnpm for package installs.", "reason": "contradiction"}
    ]


# ------------------------------------------------------------------ review
def test_single_id_review_refuses_settled_records_unless_forced(memory):
    db, service, project = memory
    record = service.create_memory(candidate("Ship on Fridays."), project=project)
    db.conn.execute("UPDATE memories SET state='retracted' WHERE id=?", (record["id"],))
    with pytest.raises(MemoryError, match="state is retracted"):
        service.approve(record["id"])
    with pytest.raises(MemoryError, match="state is retracted"):
        service.reject(record["id"])
    assert service.approve(record["id"], force=True)["state"] == "active"
    with pytest.raises(MemoryError, match="state is active"):
        service.reject(record["id"])
    assert service.reject(record["id"], force=True) == [record["id"]]


def test_review_cli_force_flag(tmp_path, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    home = str(tmp_path / "store")
    assert main(["--memory-home", home, "remember", "--cwd", str(repo), "--statement",
                 "Keep the changelog short.", "--format", "json"]) == 0
    memory_id = json.loads(capsys.readouterr().out)["id"]
    assert main(["--memory-home", home, "review", "reject", memory_id]) == 1
    assert "state is active" in capsys.readouterr().err
    assert main(["--memory-home", home, "review", "reject", memory_id, "--force",
                 "--format", "json"]) == 0
    assert json.loads(capsys.readouterr().out) == {"removed": [memory_id]}


# ------------------------------------------------------------------ feedback
def test_feedback_accepts_several_ids_all_or_nothing(memory):
    db, service, project = memory
    first = service.create_memory(candidate("Prefer narrow checks for parsers."), project=project)
    second = service.create_memory(candidate("Prefer narrow checks for lexers."), project=project)
    packet = Retriever(db, service.provider).recall(project=project, prompt="narrow checks parsers lexers")
    exposed = {item["id"] for item in packet["items"]}
    assert {first["id"], second["id"]} <= exposed
    with pytest.raises(MemoryError, match="mem_missing"):
        service.feedback(packet["query_id"], [first["id"], "mem_missing"], used=True)
    assert db.conn.execute("SELECT count(*) FROM retrieval_feedback WHERE used IS NOT NULL").fetchone()[0] == 0
    result = service.feedback(packet["query_id"], [first["id"], second["id"]], used=False)
    assert result["memory_ids"] == [first["id"], second["id"]]
    assert db.conn.execute("SELECT count(*) FROM retrieval_feedback WHERE used=0").fetchone()[0] == 2
    assert "<memory-id> [<memory-id> ...]" in packet["context"]


# ------------------------------------------------------------------ retention
def _old_query(db: Database, memory_id: str) -> None:
    old = "2000-01-01T00:00:00.000Z"
    db.conn.execute(
        "INSERT INTO retrieval_queries(id,repo_key,prompt_hash,mode,harness,created_at) VALUES('qry_old','r','h','recall','generic',?)",
        (old,),
    )
    db.conn.execute(
        "INSERT INTO retrieval_feedback(query_id,memory_id,exposed,created_at,updated_at) VALUES('qry_old',?,1,?,?)",
        (memory_id, old, old),
    )


def test_gc_and_stop_cleanup_prune_old_query_logs(memory, tmp_path):
    db, service, project = memory
    record = service.create_memory(candidate("Prefer narrow checks."), project=project)
    fresh = Retriever(db, service.provider).recall(project=project, prompt="narrow checks")
    _old_query(db, record["id"])
    assert service.gc()["queries"] == 1
    assert db.conn.execute("SELECT count(*) FROM retrieval_feedback WHERE query_id='qry_old'").fetchone()[0] == 0
    assert db.conn.execute("SELECT count(*) FROM retrieval_queries WHERE id=?", (fresh["query_id"],)).fetchone()[0] == 1

    _old_query(db, record["id"])
    service.capture_event(
        harness="claude", kind="assistant_stop",
        data={"session_id": "s", "event_id": "stop1", "last_assistant_message": "done"}, cwd=tmp_path,
    )
    assert db.conn.execute("SELECT count(*) FROM retrieval_queries WHERE id='qry_old'").fetchone()[0] == 0
    assert db.conn.execute("SELECT count(*) FROM retrieval_feedback WHERE query_id='qry_old'").fetchone()[0] == 0


# ------------------------------------------------------------------ instructions
def test_relocated_host_homes_are_read(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    codex = tmp_path / "codex"
    profile.mkdir()
    codex.mkdir()
    (profile / "CLAUDE.md").write_text("- Profile rule about release branches here.\n", encoding="utf-8")
    (codex / "AGENTS.md").write_text("- Codex home rule about deploy windows.\n", encoding="utf-8")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(profile))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    cwd = tmp_path / "work"
    cwd.mkdir()
    assert any("release branches" in rule for rule in loaded_rules("claude", cwd, home=tmp_path / "h"))
    assert any("deploy windows" in rule for rule in loaded_rules("codex", cwd, home=tmp_path / "h"))


# ------------------------------------------------------------------ Windows shim
def _cmd_env(tmp_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    # No ~/.agents install: the shim must find the skill from its own location.
    env["HOME"] = str(tmp_path / "home")
    env["USERPROFILE"] = str(tmp_path / "home")
    env["AGENT_MEMORY_HOME"] = str(tmp_path / "store")
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    return env


@pytest.mark.skipif(sys.platform != "win32", reason="Windows cmd shim")
def test_shipped_cmd_shim_runs_from_its_own_skill(tmp_path):
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", str(SKILL_ROOT / "bin" / "agent-memory.cmd"), "--version"],
        capture_output=True, text=True, env=_cmd_env(tmp_path), stdin=subprocess.DEVNULL, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()[:1].isdigit()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows cmd shim")
def test_cmd_shim_on_path_falls_back_to_the_bash_plugin_lookup(tmp_path):
    git_bash = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "bash.exe"
    if not git_bash.exists() or subprocess.run(
        [str(git_bash), "-c", "command -v python3"], capture_output=True, stdin=subprocess.DEVNULL
    ).returncode != 0:
        pytest.skip("Git Bash with python3 is required for the plugin lookup")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shutil.copy(SKILL_ROOT / "bin" / "agent-memory.cmd", bin_dir)
    shutil.copy(SKILL_ROOT / "bin" / "agent-memory", bin_dir)
    config = tmp_path / "claude"
    (config / "plugins").mkdir(parents=True)
    (config / "plugins" / "installed_plugins.json").write_text(
        json.dumps({"plugins": {"agent-memory@555cider-agent-skills": [
            {"scope": "user", "installPath": str(SKILL_ROOT)}]}}),
        encoding="utf-8",
    )
    env = _cmd_env(tmp_path)
    env["CLAUDE_CONFIG_DIR"] = str(config)
    env["CODEX_HOME"] = str(tmp_path / "codex")
    env["PATH"] = str(git_bash.parent) + os.pathsep + env["PATH"]
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", str(bin_dir / "agent-memory.cmd"), "--version"],
        capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip()[:1].isdigit()


def test_integration_follows_claude_config_dir_and_codex_home(tmp_path, monkeypatch):
    from agent_memory.integration import harness_dirs, integration_paths

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "profile"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    assert harness_dirs() == (tmp_path / "profile", tmp_path / "codex")
    assert integration_paths()["claude"] == tmp_path / "profile" / "settings.json"
    assert integration_paths()["codex_hooks"] == tmp_path / "codex" / "hooks.json"
    # An explicit home is a tool acting for that home, not for this session's harness.
    assert integration_paths(tmp_path / "h")["claude"] == tmp_path / "h" / ".claude" / "settings.json"
