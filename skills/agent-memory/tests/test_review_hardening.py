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

from agent_memory.db import Database
from agent_memory.integration import INTEGRATION_MARKER, integration_status
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


# ------------------------------------------------------- claude event capture


def test_claude_tool_output_field_and_camel_exit_code(memory, tmp_path):
    db, service, _ = memory
    service.capture_event(
        harness="claude",
        kind="tool_completed",
        data={
            "session_id": "s",
            "event_id": "t1",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest -q"},
            "tool_output": {"stdout": "1 passed", "exitCode": 0},
        },
        cwd=tmp_path,
    )
    row = db.conn.execute("SELECT payload_zlib FROM events WHERE kind='tool_completed'").fetchone()
    payload = db.decode_payload(row["payload_zlib"])
    assert "1 passed" in str(payload.get("output", ""))
    assert payload.get("exit_status") == 0


def test_stop_events_with_distinct_prompt_ids_are_separate(memory, tmp_path):
    db, service, _ = memory
    for prompt_id in ("p1", "p2"):
        service.capture_event(
            harness="claude",
            kind="assistant_stop",
            data={"session_id": "s", "prompt_id": prompt_id, "last_assistant_message": ""},
            cwd=tmp_path,
        )
    assert db.conn.execute(
        "SELECT count(*) FROM events WHERE kind='assistant_stop'"
    ).fetchone()[0] == 2


def test_session_end_reads_transcript_tail_for_handoff(memory, tmp_path):
    db, service, _ = memory
    transcript = tmp_path / "transcript.jsonl"
    lines = [
        json.dumps({"type": "user", "message": {"role": "user", "content": "안녕"}}),
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "핸드오프 요약: 다음 단계는 마이그레이션 검증."}
                    ],
                },
            }
        ),
    ]
    transcript.write_text("\n".join(lines), encoding="utf-8")
    service.capture_event(
        harness="claude",
        kind="session_end",
        data={"session_id": "s", "event_id": "e1", "transcript_path": str(transcript)},
        cwd=tmp_path,
    )
    row = db.conn.execute("SELECT payload_zlib FROM events WHERE kind='session_end'").fetchone()
    payload = db.decode_payload(row["payload_zlib"])
    assert "핸드오프 요약" in str(payload.get("assistant_response", ""))


# ------------------------------------------------ explicit inference guardrail


def test_from_now_on_fallback_is_bounded_and_conservative():
    long_prompt = "앞으로 " + ("이 파일의 구조를 자세히 살펴보고 리팩터링 계획을 세운 다음 " * 30)
    assert MemoryService.explicit_candidates(long_prompt) == []
    assert MemoryService.explicit_candidates("앞으로 사용될 API 설명해줘") == []
    matched = MemoryService.explicit_candidates("앞으로 커밋 메시지는 한국어로 써줘")
    assert len(matched) == 1
    assert len(matched[0].statement) <= 500


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


def test_correction_with_change_and_time_marker_is_maintenance(memory):
    db, service, project = memory
    service.create_memory(candidate("패키지는 pnpm 을 쓴다.", kind="decision"), project=project)
    packet = Retriever(db, service.provider).recall(
        project=project, prompt="이제 pnpm 말고 npm 써줘"
    )
    assert packet["mode"] == "maintenance"


# ------------------------------------------------------------------ embeddings


def test_embed_missing_covers_explicit_memories(tmp_path):
    db = Database(tmp_path / "memory")
    service = MemoryService(db, EmbedOnlyProvider())
    record = service.create_memory(candidate("Prefer narrow verification."), project="test-repo")
    stored = service.embed_missing()
    assert stored == 1
    row = db.conn.execute(
        "SELECT model,dimensions FROM memory_embeddings WHERE memory_id=?", (record["id"],)
    ).fetchone()
    assert row["model"] == "fake-embed"
    assert row["dimensions"] == 4
    assert service.embed_missing() == 0
    db.close()


def test_reindex_rebuilds_vector_index_from_stored_embeddings(memory):
    db, service, project = memory
    if not db.vector:
        pytest.skip("sqlite-vec unavailable in this environment")
    record = service.create_memory(candidate("Vector rebuild target."), project=project)
    db.put_embedding(record["id"], "text-embedding-3-small", [0.0] * 1536)
    assert db.conn.execute("SELECT count(*) FROM memory_vec").fetchone()[0] == 1
    db.conn.execute("DELETE FROM memory_vec")
    db.conn.execute("DELETE FROM memory_vector_map")
    db.rebuild_indexes()
    assert db.conn.execute("SELECT count(*) FROM memory_vec").fetchone()[0] == 1


# ------------------------------------------------------------- feedback bridge


def test_render_context_carries_query_id(memory):
    db, service, project = memory
    service.create_memory(candidate("Prefer targeted verification."), project=project)
    packet = Retriever(db, service.provider).recall(
        project=project, prompt="targeted verification preference"
    )
    assert packet["items"]
    assert packet["query_id"] in packet["context"]


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
