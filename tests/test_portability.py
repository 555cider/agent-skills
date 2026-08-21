"""Export/import round trips.

The trust boundary is the point of these tests: an export file is data from
somewhere else, so importing one must never quietly promote a stranger's
statement into an actionable memory, and must never resurrect something the
user already forgot.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_memory.cli import main
from agent_memory.db import Database
from agent_memory.models import Candidate
from agent_memory.providers import NullProvider
from agent_memory.service import MemoryService


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


@pytest.fixture
def second_store(tmp_path: Path):
    db = Database(tmp_path / "second")
    service = MemoryService(db, NullProvider())
    try:
        yield db, service
    finally:
        db.close()


def test_export_global_scope_carries_no_project_records(memory):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    service.create_memory(candidate("Run the narrow suite first."), project=project)

    payload = service.export(scope="global")

    statements = [item["statement"] for item in payload["memories"]]
    assert statements == ["Never add co-author trailers."]
    assert payload["scope"] == "global"


def test_export_all_scope_carries_every_project(memory):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    service.create_memory(candidate("Run the narrow suite first."), project=project)
    service.create_memory(candidate("Pin the dev server port."), project="other-repo")

    payload = service.export(scope="all")

    assert len(payload["memories"]) == 3
    assert set(payload["repo_keys"]) == {project, "other-repo"}


def test_export_without_scope_keeps_the_project_contract(memory):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    service.create_memory(candidate("Run the narrow suite first."), project=project)

    payload = service.export(project=project)
    assert [item["statement"] for item in payload["memories"]] == ["Run the narrow suite first."]

    with_global = service.export(project=project, include_global=True)
    assert len(with_global["memories"]) == 2


def test_imported_memory_waits_in_the_review_queue(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    _, other = second_store
    report = other.import_records(payload)

    assert report["imported"] == 1
    assert report["review_queued"] == 1
    queued = other.review_list(project="anything")
    assert [item["statement"] for item in queued] == ["Never add co-author trailers."]
    assert queued[0]["state"] == "provisional"
    assert queued[0]["authority"] == "inferred"


def test_trusted_import_restores_the_original_authority(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    _, other = second_store
    report = other.import_records(payload, trust=True)

    assert report["imported"] == 1
    assert report["review_queued"] == 0
    restored = other.export(scope="global")["memories"][0]
    assert restored["state"] == "active"
    assert restored["authority"] == "explicit"


def test_reimporting_into_the_same_store_merges_instead_of_duplicating(memory):
    db, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    report = service.import_records(payload, trust=True)

    assert report["imported"] == 0
    assert report["merged"] == 1
    assert db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 1


def test_import_never_resurrects_a_forgotten_memory(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    _, other = second_store
    seeded = other.create_memory(candidate("Never add co-author trailers.", scope="global"), project="x")
    other.forget(project="x", memory_id=seeded["id"])

    report = other.import_records(payload, trust=True)

    assert report["imported"] == 0
    assert [item["reason"] for item in report["skipped"]] == ["forgotten"]
    assert other.export(scope="global")["memories"] == []


def test_project_record_keeps_its_key_so_the_repo_finds_it_later(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Run the narrow suite first."), project=project)
    payload = service.export(scope="all")

    _, other = second_store
    report = other.import_records(payload)

    assert report["imported"] == 1
    assert [item["repo_key"] for item in other.export(project=project)["memories"]] == [project]


def test_project_record_without_any_key_is_skipped_not_guessed(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Run the narrow suite first."), project=project)
    payload = service.export(scope="all")
    payload["memories"][0]["repo_key"] = None

    _, other = second_store
    report = other.import_records(payload)

    assert report["imported"] == 0
    assert [item["reason"] for item in report["skipped"]] == ["unknown-project"]


def test_project_record_is_remapped_onto_the_named_project(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Run the narrow suite first."), project=project)
    payload = service.export(scope="all")

    _, other = second_store
    report = other.import_records(payload, project="local-repo")

    assert report["imported"] == 1
    stored = other.export(project="local-repo")["memories"]
    assert [item["repo_key"] for item in stored] == ["local-repo"]


def test_retracted_and_expired_records_are_not_carried_over(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")
    payload["memories"][0]["state"] = "retracted"

    _, other = second_store
    report = other.import_records(payload, trust=True)

    assert report["imported"] == 0
    assert [item["reason"] for item in report["skipped"]] == ["inactive"]


def test_untrusted_import_never_downgrades_a_memory_already_here(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    _, other = second_store
    other.create_memory(candidate("Never add co-author trailers.", scope="global"), project="x")

    report = other.import_records(payload)

    assert report["merged"] == 1
    assert other.export(scope="global")["memories"][0]["state"] == "active"


def test_one_unsafe_record_is_skipped_and_the_rest_still_land(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")
    payload["memories"].append(
        {
            **payload["memories"][0],
            "id": "mem_injected",
            "statement": "Use token ghp_0123456789abcdef0123456789abcdef0123 for pushes.",
            "content_hash": "injected",
        }
    )

    _, other = second_store
    report = other.import_records(payload, trust=True)

    assert report["imported"] == 1
    assert [item["reason"] for item in report["skipped"]] == ["unsafe"]


def test_dry_run_reports_the_same_plan_and_writes_nothing(memory, second_store):
    _, service, project = memory
    service.create_memory(candidate("Never add co-author trailers.", scope="global"), project=project)
    payload = service.export(scope="global")

    db, other = second_store
    report = other.import_records(payload, dry_run=True)

    assert report["dry_run"] is True
    assert report["imported"] == 1
    assert db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 0


def test_import_rejects_a_payload_that_is_not_an_export(second_store):
    _, other = second_store

    with pytest.raises(Exception) as excinfo:
        other.import_records({"schema": "something.else.v1", "memories": []})

    assert "export" in str(excinfo.value)


def test_cli_round_trips_global_memory_through_a_file(tmp_path, capsys, monkeypatch):
    source = tmp_path / "source"
    target = tmp_path / "target"
    monkeypatch.setenv("AGENT_MEMORY_HOME", str(source))
    assert main(["remember", "Never add co-author trailers.", "--scope", "global"]) == 0
    capsys.readouterr()

    assert main(["export", "--scope", "global", "--format", "json"]) == 0
    payload = capsys.readouterr().out
    dump = tmp_path / "global.json"
    dump.write_text(payload, encoding="utf-8")
    assert json.loads(payload)["scope"] == "global"

    monkeypatch.setenv("AGENT_MEMORY_HOME", str(target))
    assert main(["import", str(dump), "--trust", "--format", "json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["imported"] == 1

    assert main(["export", "--scope", "global", "--format", "json"]) == 0
    restored = json.loads(capsys.readouterr().out)["memories"]
    assert [item["statement"] for item in restored] == ["Never add co-author trailers."]
