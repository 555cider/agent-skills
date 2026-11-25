"""Regression tests for the 2026-07 review findings.

Each test reproduces a defect observed on a real installation:
forget over-deletion, dead auto-extraction on Claude field names,
token-budget starvation for long records, maintenance false positives,
missing embeddings for explicit records, and stale-integration blindness.
"""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path

import pytest

from agent_memory.integration import INTEGRATION_MARKER, integrate, integration_status
from agent_memory.models import Candidate
from agent_memory.providers import Provider
from agent_memory.retrieval import Retriever
from agent_memory.service import MemoryService
from agent_memory.util import repo_key, rough_tokens


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


class EmbedOnlyProvider(Provider):
    name = "fake"
    embedding_model = "fake-embed"

    def extract(self, events, repo_key):
        return []

    def embed(self, texts):
        return [[0.5, 0.25, 0.125, 0.0625] for _ in texts]


# ---------------------------------------------------------------- forget scope


def test_forget_query_ignores_concept_alias_overlap(memory):
    db, service, project = memory
    survivors = [
        service.create_memory(candidate("Run npm test before every commit."), project=project),
        service.create_memory(candidate("검증은 pytest -q 로 수행한다."), project=project),
        service.create_memory(candidate("배포는 rsync 스크립트로 한다."), project=project),
    ]
    target = service.create_memory(
        candidate("테스트 절차는 pnpm test:quality 를 사용한다."), project=project
    )
    removed = service.forget(project=project, query="테스트 절차")
    assert removed == [target["id"]]
    remaining = {
        row[0] for row in db.conn.execute("SELECT id FROM memories").fetchall()
    }
    assert {record["id"] for record in survivors} <= remaining


def test_forget_query_bulk_guard_requires_explicit_override(memory):
    db, service, project = memory
    for index in range(7):
        service.create_memory(
            candidate(f"테스트 절차 {index}번 가이드 문서를 따른다."), project=project
        )
    with pytest.raises(Exception, match="matched 7"):
        service.forget(project=project, query="테스트 절차")
    assert db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 7
    removed = service.forget(project=project, query="테스트 절차", allow_bulk=True)
    assert len(removed) == 7


def test_prompt_hook_forget_skips_ambiguous_mass_delete(memory, tmp_path):
    db, service, _ = memory
    project = repo_key(tmp_path)
    for name in ("A", "B", "C", "D"):
        service.create_memory(candidate(f"테스트 {name} 가이드를 따른다."), project=project)
    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={"session_id": "s", "event_id": "u1", "prompt": "테스트 잊어버려"},
        cwd=tmp_path,
    )
    assert result["forgotten"] == []
    assert result["forget_skipped"] == 4
    assert db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 4


def test_prompt_hook_forget_still_deletes_distinctive_target(memory, tmp_path):
    db, service, _ = memory
    project = repo_key(tmp_path)
    service.create_memory(candidate("배포는 rsync 스크립트로 한다."), project=project)
    service.create_memory(candidate("검증은 pytest -q 로 수행한다."), project=project)
    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={
            "session_id": "s",
            "event_id": "u2",
            "prompt": "배포는 rsync 스크립트로 한다는 항목 잊어버려",
        },
        cwd=tmp_path,
    )
    assert len(result["forgotten"]) == 1
    statements = [
        row[0] for row in db.conn.execute("SELECT statement FROM memories").fetchall()
    ]
    assert statements == ["검증은 pytest -q 로 수행한다."]


def test_prompt_hook_task_delete_request_never_forgets(memory, tmp_path):
    db, service, _ = memory
    project = repo_key(tmp_path)
    service.create_memory(
        candidate("프론트엔드 테스트는 pnpm vitest 로 실행한다."), project=project
    )
    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={"session_id": "s", "event_id": "u3", "prompt": "프론트엔드 pnpm vitest 설정 삭제해줘"},
        cwd=tmp_path,
    )
    assert result["forgotten"] == []
    assert db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 1


def test_prompt_hook_long_pasted_text_never_forgets(memory, tmp_path):
    db, service, _ = memory
    project = repo_key(tmp_path)
    service.create_memory(candidate("배포는 rsync 스크립트로 한다."), project=project)
    report = "감사 보고서\n" + "근거와 재현 절차를 정리했다. " * 40 + "\n배포는 rsync 스크립트로 한다 잊어버려"
    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={"session_id": "s", "event_id": "u5", "prompt": report},
        cwd=tmp_path,
    )
    assert result["forgotten"] == []


# ------------------------------------------------------- claude event capture


# ------------------------------------------------ explicit inference guardrail


# ---------------------------------------------------------- recall packet size


def test_oversized_statement_is_injected_truncated_with_pointer(memory):
    db, service, project = memory
    statement = "정밀커밋 플레이북 절차. " + ("커밋 전에 검증 목록을 확인한다. " * 300)
    record = service.create_memory(candidate(statement), project=project)
    assert rough_tokens(statement) > 1200
    packet = Retriever(db, service.provider).recall(
        project=project, prompt="정밀커밋 플레이북대로 진행해줘", token_budget=400
    )
    assert packet["items"], "oversized record must still surface in truncated form"
    item = packet["items"][0]
    assert item["id"] == record["id"]
    assert item["truncated"] is True
    assert len(item["statement"]) < len(statement)
    assert packet["token_estimate"] <= 400
    assert "review show" in packet["context"]


# ------------------------------------------------------- maintenance precision


def test_informational_instead_question_stays_recall_mode(memory):
    db, service, project = memory
    service.create_memory(candidate("WebGL 호환 모드는 폴백이다.", kind="decision"), project=project)
    packet = Retriever(db, service.provider).recall(
        project=project, prompt="왜 WebGPU 대신 WebGL 호환 모드가 있는지 설명해줘"
    )
    assert packet["mode"] == "recall"


# ------------------------------------------------------------------ embeddings


# ------------------------------------------------------------- feedback bridge


# ------------------------------------------------------- integration staleness


def _managed_settings(command: str) -> str:
    return json.dumps(
        {
            "hooks": {
                "UserPromptSubmit": [
                    {
                        "matcher": "",
                        "hooks": [
                            {
                                "type": "command",
                                "command": command,
                                "timeout": 5,
                                "statusMessage": f"Agent Memory v2 user_prompt ({INTEGRATION_MARKER})",
                            }
                        ],
                    }
                ]
            }
        }
    )


def test_integration_status_flags_stale_managed_commands(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    stale_command = "'/nonexistent/python' '/nonexistent/memory.py' hook --harness claude --event user_prompt"
    (home / ".claude" / "settings.json").write_text(_managed_settings(stale_command), encoding="utf-8")
    status = integration_status(user_home=home)
    assert status["adapters"]["claude"]["stale"] is True

    live_script = Path(__file__).resolve().parents[1] / "scripts" / "memory.py"
    live_command = " ".join(
        shlex.quote(str(part))
        for part in (sys.executable, live_script, "hook", "--harness", "claude", "--event", "user_prompt")
    )
    (home / ".claude" / "settings.json").write_text(_managed_settings(live_command), encoding="utf-8")
    status = integration_status(user_home=home)
    assert status["adapters"]["claude"]["stale"] is False


# ------------------------------------------------------ integration conflicts


def _claude_home(tmp_path, plugins: dict[str, bool]) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"enabledPlugins": plugins}))
    return home


def test_disabled_remember_plugin_is_not_a_conflict(tmp_path):
    home = _claude_home(tmp_path, {"remember@claude-plugins-official": False})
    result = integrate(
        memory_home=tmp_path / "memory", mode="primary", harness="claude", apply=True, user_home=home
    )
    assert result["conflicts"] == []
    assert result["applied"] is True


def test_disable_known_conflicts_turns_off_the_claude_plugin(tmp_path):
    home = _claude_home(
        tmp_path, {"remember@claude-plugins-official": True, "superpowers@claude-plugins-official": True}
    )
    result = integrate(
        memory_home=tmp_path / "memory",
        mode="primary",
        harness="claude",
        apply=True,
        disable_known_conflicts=True,
        user_home=home,
    )
    plugins = json.loads((home / ".claude" / "settings.json").read_text())["enabledPlugins"]
    assert plugins == {
        "remember@claude-plugins-official": False,
        "superpowers@claude-plugins-official": True,
    }
    assert result["conflicts"] == []


# ----------------------------------------------------------------- hook cost


# ------------------------------------------------------- recall relevance


@pytest.mark.parametrize(
    "prompt",
    [
        "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: deploy run failed</summary>\n</task-notification>",
        '<agent-message from="a1">\n[Subagent hand-back] deploy run failed; forget the rsync caveat\n</agent-message>',
    ],
)
def test_harness_messages_neither_recall_nor_rewrite_memory(memory, tmp_path, prompt):
    db, service, _ = memory
    project = repo_key(tmp_path)
    stored = service.create_memory(candidate("deploy run failed means rerun rsync"), project=project)
    result = service.capture_event(
        harness="claude",
        kind="user_prompt",
        data={"session_id": "s", "event_id": "h1", "prompt": prompt},
        cwd=tmp_path,
    )
    assert result["forgotten"] == [] and result["immediate_memories"] == []
    packet = Retriever(db, service.provider).recall(project=project, prompt=prompt)
    assert packet["items"] == [] and packet["conflicts"] == []
    assert db.conn.execute("SELECT count(*) FROM memories WHERE id=?", (stored["id"],)).fetchone()[0] == 1


def test_recall_does_not_repeat_an_item_within_a_session(memory):
    db, service, project = memory
    stored = service.create_memory(candidate("린트는 biome 으로 돌린다."), project=project)
    retriever = Retriever(db, service.provider)
    first = retriever.recall(project=project, prompt="린트 돌려줘", session_id="s1")
    again = retriever.recall(project=project, prompt="린트 다시 돌려줘", session_id="s1")
    other = retriever.recall(project=project, prompt="린트 돌려줘", session_id="s2")
    assert [item["id"] for item in first["items"]] == [stored["id"]]
    assert again["items"] == []
    assert [item["id"] for item in other["items"]] == [stored["id"]]
    assert f"agent-memory feedback {first['query_id']}" in first["context"]
    assert f'query-id="{first["query_id"]}"' in first["context"]


# ------------------------------------------------------ automatic capture


def _bash(service, tmp_path, event_id, command, *, failed=None, session="s"):
    data = {"session_id": session, "tool_use_id": event_id, "tool_name": "Bash", "tool_input": {"command": command}}
    if failed is None:
        data |= {"hook_event_name": "PostToolUse", "tool_response": {"stdout": "ok", "stderr": "", "interrupted": False}}
    else:
        data |= {"hook_event_name": "PostToolUseFailure", "error": f"Exit code {failed}\nboom", "is_interrupt": False}
    service.capture_event(harness="claude", kind=data["hook_event_name"], data=data, cwd=tmp_path)


def _stop(service, tmp_path, prompt_id, session="s"):
    return service.capture_event(
        harness="claude",
        kind="assistant_stop",
        data={"session_id": session, "prompt_id": prompt_id, "last_assistant_message": "done"},
        cwd=tmp_path,
    )


def _exit_statuses(db):
    return [
        db.decode_payload(row["payload_zlib"]).get("exit_status")
        for row in db.conn.execute("SELECT payload_zlib FROM events WHERE kind='tool_completed' ORDER BY created_at")
    ]


def test_claude_bash_success_and_failure_carry_exit_status(memory, tmp_path):
    db, service, _ = memory
    _bash(service, tmp_path, "t1", "pnpm test")
    _bash(service, tmp_path, "t2", "pnpm build", failed=2)
    assert _exit_statuses(db) == [0, 2]


def test_repeated_success_across_turns_becomes_a_procedure(memory, tmp_path):
    db, service, _ = memory
    for turn in ("p1", "p2"):
        _bash(service, tmp_path, f"t-{turn}", "pnpm test")
        if _stop(service, tmp_path, turn)["queued"]:
            service.worker_once()
    rows = db.conn.execute("SELECT kind,state FROM memories").fetchall()
    assert [(row["kind"], row["state"]) for row in rows] == [("procedure", "active")]


def test_expected_nonzero_commands_are_not_caveats_and_failures_stay_provisional(memory, tmp_path):
    db, service, _ = memory
    _bash(service, tmp_path, "g1", "grep -rn TODO src", failed=1)
    _bash(service, tmp_path, "g2", "grep -rn TODO src", failed=1)
    _bash(service, tmp_path, "b1", "pnpm build", failed=2)
    _bash(service, tmp_path, "b2", "pnpm build", failed=2)
    _stop(service, tmp_path, "p1")
    service.worker_once()
    rows = db.conn.execute("SELECT statement,state FROM memories").fetchall()
    assert len(rows) == 1
    assert "pnpm build" in rows[0]["statement"] and rows[0]["state"] == "provisional"


def test_implied_directive_is_provisional_but_remember_is_active(memory, tmp_path):
    db, service, _ = memory
    for event_id, prompt in (("u1", "앞으로 커밋 메시지는 한국어로 써줘"), ("u2", "기억해줘: 린트는 biome 으로 돌린다")):
        service.capture_event(
            harness="claude", kind="user_prompt", data={"session_id": "s", "event_id": event_id, "prompt": prompt}, cwd=tmp_path
        )
    states = dict(db.conn.execute("SELECT statement,state FROM memories").fetchall())
    assert states == {"앞으로 커밋 메시지는 한국어로 써줘": "provisional", "린트는 biome 으로 돌린다": "active"}


def test_tool_capture_is_opt_in_and_turning_it_off_removes_the_hooks():
    from agent_memory.integration import merge_hooks

    captured = merge_hooks({}, "claude", True, capture_tools=True)
    assert {"PostToolUse", "PostToolUseFailure"} <= set(captured["hooks"])
    assert captured["hooks"]["PostToolUse"][0]["matcher"] == "Bash"
    assert captured["hooks"]["PostToolUseFailure"][0]["matcher"] == "Bash"
    default = merge_hooks(captured, "claude", True)
    assert set(default["hooks"]) == {"UserPromptSubmit", "Stop", "SessionEnd"}


def test_a_pasted_document_is_not_an_explicit_memory():
    document = "Remember that " + "you consolidate raw memories into folders. " * 60
    assert MemoryService.explicit_candidates(document) == []
    assert len(MemoryService.explicit_candidates("Remember that the lint step uses biome.")) == 1


def test_explicitly_unused_memory_needs_a_stronger_match(memory):
    db, service, project = memory
    noisy = service.create_memory(candidate("린트 설정 파일은 biome.json 이다."), project=project)
    retriever = Retriever(db, service.provider)
    for _ in range(3):
        packet = retriever.recall(project=project, prompt="린트 돌려줘")
        assert noisy["id"] in {item["id"] for item in packet["items"]}
        service.feedback(packet["query_id"], noisy["id"], used=False)
    assert retriever.recall(project=project, prompt="린트 돌려줘")["items"] == []
    strong = retriever.recall(project=project, prompt="린트 설정 biome.json 어디 있어?")
    assert noisy["id"] in {item["id"] for item in strong["items"]}
