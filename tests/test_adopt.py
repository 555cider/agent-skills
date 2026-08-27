"""Adopting another agent's memory files.

Two things are being defended here. The first is routing: one `MEMORY.md` holds
knowledge for several repositories and for the machine as a whole, and a record
that lands in the wrong scope is either invisible where it matters or injected
everywhere it does not. The second is the durability line — agent-memory is a
rule store read into a bounded recall budget, so a file's record of what happened
must not arrive alongside its rules about what to do.

The trust boundary itself is covered by `test_portability.py`; what matters here
is that `adopt` goes through it rather than around it.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from agent_memory.cli import main
from agent_memory.db import Database
from agent_memory.models import Candidate
from agent_memory.providers import NullProvider
from agent_memory.service import MemoryService
from agent_memory.sources import build_payload, discover
from agent_memory.util import repo_key

CLAUDE_MD = """\
# ~/.claude/CLAUDE.md — machine notes

Keep only machine-level discipline here.

## Never push without asking

`git push`, PR creation and deploys leave the machine, so ask right before running one.

- Approval of a plan is not approval of a push.
"""

AGENTS_MD = """\
# ~/.codex/AGENTS.md — machine notes

Keep only machine-level discipline here.

## Never push without asking

`git push`, PR creation and deploys leave the machine, so ask right before running one.

- Codex asks the same question before it publishes anything.
"""

MEMORY_MD = """\
# Task Group: Guide fidelity audit

scope: Audit generated Markdown against source PDFs.
applies_to: cwd={repo}; reuse_rule=use for docs/guides conversion work.

## Task 1: Audit and correct guide fidelity, success

### rollout_summary_files
- rollout_summaries/2026-08-25T05-43-21-Cqv3-audit.md (thread_id=01a03771)

### keywords
- docs/guides, PyMuPDF, verify.py

## User preferences
- When the work is document correction only, stay in the current workspace. [Task 1]

## Reusable knowledge
- `docs/guides/**/*.md` are generated outputs of the conversion tool, so edit the source. [Task 1]

# Task Group: Somebody else's checkout

applies_to: cwd={missing}; reuse_rule=use for their machine only.

## User preferences
- Their rule that should never reach this store at all. [Task 1]

# Task Group: Machine-wide notes

## User preferences
- Configuration lives under {home_path} and is reread on every launch.
"""

MEMORY_SUMMARY_MD = """\
v1

## User Profile
- Prefers short answers with the command shown before the explanation.

## Rollout log
- Did the thing on Tuesday and it worked out fine.
"""

CORE_MEMORIES_MD = """\
# Core memories

- The integration branch is what actually runs, so never publish from a cleanup step.
"""

RECENT_MD = """\
# Recent

## 2026-08-12
Fixed the port isolation bug and merged it after 141 tests passed.
"""


def _git_init(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q"], cwd=path, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    _git_init(root)
    (root / "CLAUDE.md").write_text(
        "# Project notes\n\n## Tests\n\nRun the narrow suite before the whole one.\n",
        encoding="utf-8",
    )
    (root / "CLAUDE.local.md").write_text(
        "# Local notes\n\n## Ports\n\nThe backend for this checkout listens on 20430.\n",
        encoding="utf-8",
    )
    remember = root / ".remember"
    remember.mkdir()
    (remember / "core-memories.md").write_text(CORE_MEMORIES_MD, encoding="utf-8")
    (remember / "recent.md").write_text(RECENT_MD, encoding="utf-8")
    return root


@pytest.fixture
def home(tmp_path: Path, repo: Path) -> Path:
    root = tmp_path / "home"
    (root / ".claude").mkdir(parents=True)
    (root / ".claude" / "CLAUDE.md").write_text(CLAUDE_MD, encoding="utf-8")
    (root / ".codex").mkdir(parents=True)
    (root / ".codex" / "AGENTS.md").write_text(AGENTS_MD, encoding="utf-8")
    memories = root / ".codex" / "memories"
    memories.mkdir(parents=True)
    (memories / "MEMORY.md").write_text(
        MEMORY_MD.format(
            repo=str(repo),
            missing=str(tmp_path / "not-on-this-machine"),
            home_path="C:\\Users\\someone\\.codex",
        ),
        encoding="utf-8",
    )
    (memories / "memory_summary.md").write_text(MEMORY_SUMMARY_MD, encoding="utf-8")
    (memories / "raw_memories.md").write_text(
        "## Thread `019f`\ndescription: Did a thing once and it went fine overall.\n", encoding="utf-8"
    )
    rollouts = memories / "rollout_summaries"
    rollouts.mkdir()
    (rollouts / "2026-08-25T05-43-21-Cqv3-audit.md").write_text(
        "# Audit\n\nThe audit ran and found four mismatches in the guides.\n", encoding="utf-8"
    )
    return root


@pytest.fixture
def adopted(home: Path, repo: Path):
    return build_payload(discover(home=home, cwd=repo))


def statements(payload) -> list[str]:
    return [item["statement"] for item in payload["payload"]["memories"]]


def find(payload, fragment: str) -> dict:
    for item in payload["payload"]["memories"]:
        if fragment in item["statement"]:
            return item
    raise AssertionError(f"no adopted record contains {fragment!r}")


# ------------------------------------------------------------------- routing


def test_global_claude_md_stays_global(adopted):
    record = find(adopted, "Approval of a plan is not approval of a push")
    assert record["scope"] == "global"
    assert record["repo_key"] is None


def test_repo_local_file_is_scoped_to_that_repository(adopted, repo):
    record = find(adopted, "listens on 20430")
    assert record["scope"] == "project"
    assert record["repo_key"] == repo_key(repo)


def test_applies_to_routes_a_task_group_to_its_repository(adopted, repo):
    record = find(adopted, "stay in the current workspace")
    assert record["scope"] == "project"
    assert record["repo_key"] == repo_key(repo)


def test_task_group_for_a_missing_checkout_is_skipped_not_widened(adopted):
    # The dangerous failure is not dropping it, it is quietly calling it global.
    assert not any("never reach this store" in item for item in statements(adopted))
    assert "unknown-project" in [item["reason"] for item in adopted["skipped"]]


def test_task_group_without_applies_to_is_global(adopted):
    record = find(adopted, "Configuration lives under")
    assert record["scope"] == "global"
    assert record["repo_key"] is None


def test_backticked_paths_become_path_globs(adopted):
    record = find(adopted, "generated outputs of the conversion tool")
    assert "docs/guides/**/*.md" in record["path_globs"]


# ----------------------------------------------------------- durability line


def test_task_scaffolding_never_becomes_a_statement(adopted):
    joined = "\n".join(statements(adopted))
    assert "rollout_summaries/" not in joined
    assert "PyMuPDF" not in joined
    assert "Audit and correct guide fidelity" not in joined


def test_codex_sections_outside_the_durable_set_are_ignored(adopted):
    assert not any("Tuesday" in item for item in statements(adopted))
    assert any("short answers" in item for item in statements(adopted))


def test_episodic_files_need_an_explicit_flag(home: Path, repo: Path):
    sources = discover(home=home, cwd=repo)
    default = "\n".join(statements(build_payload(sources)))
    assert "141 tests" not in default
    assert "found four mismatches" not in default

    opened = "\n".join(statements(build_payload(sources, include_episodic=True)))
    assert "141 tests" in opened
    assert "found four mismatches" in opened


def test_core_memories_are_durable_and_kept_by_default(adopted):
    record = find(adopted, "never publish from a cleanup step")
    assert record["scope"] == "project"


# -------------------------------------------------------------- sanitization


def test_home_paths_are_rewritten_instead_of_refused(adopted, memory):
    _, service, _ = memory
    record = find(adopted, "Configuration lives under")
    assert "C:\\Users\\someone" not in record["statement"]
    assert "~" in record["statement"]

    # The point of rewriting: `create_memory` refuses the record outright when a
    # home directory survives, so this is the difference between the rule being
    # adopted and it vanishing as `unsafe`.
    report = service.import_records(adopted["payload"], project=None)
    assert not [item for item in report["skipped"] if item["reason"] == "unsafe"]


def test_a_record_that_still_carries_personal_data_is_dropped_with_a_reason(home: Path, repo: Path):
    (home / ".claude" / "CLAUDE.md").write_text(
        "# Notes\n\n## Contact\n\nEscalate to someone@example.com whenever the build breaks.\n",
        encoding="utf-8",
    )
    payload = build_payload(discover(home=home, cwd=repo))
    assert not any("example.com" in item for item in statements(payload))
    assert any(item["reason"] == "unsafe" for item in payload["skipped"])


# ------------------------------------------------------------------ merging


def test_the_same_rule_in_claude_md_and_agents_md_merges(adopted, memory):
    _, service, _ = memory
    shared = "leave the machine, so ask right before running one"
    assert sum(shared in item for item in statements(adopted)) == 1

    service.import_records(adopted["payload"], project=None)
    rows = service.db.conn.execute(
        "SELECT count(*) FROM memories WHERE statement LIKE ?", (f"%{shared}%",)
    ).fetchone()
    assert rows[0] == 1


def test_adopting_twice_merges_instead_of_duplicating(adopted, memory):
    _, service, _ = memory
    first = service.import_records(adopted["payload"], project=None)
    before = service.db.conn.execute("SELECT count(*) FROM memories").fetchone()[0]

    second = service.import_records(adopted["payload"], project=None)
    after = service.db.conn.execute("SELECT count(*) FROM memories").fetchone()[0]

    assert first["imported"] > 0
    assert second["imported"] == 0
    assert second["merged"] == first["imported"]
    assert before == after


def test_adoption_never_resurrects_a_forgotten_rule(adopted, memory):
    _, service, project = memory
    stored = service.create_memory(
        Candidate(
            kind="constraint",
            scope="global",
            statement="Approval of a plan is not approval of a push.",
            authority="explicit",
            confidence=1.0,
        ),
        project=project,
    )
    service.forget(project=project, memory_id=stored["id"])

    report = service.import_records(adopted["payload"], project=None)

    assert any(item["reason"] == "forgotten" for item in report["skipped"])


# ------------------------------------------------------------- trust ceiling


def test_adopted_records_are_never_actionable_on_arrival(adopted, memory):
    _, service, _ = memory
    service.import_records(adopted["payload"], project=None)
    rows = service.db.conn.execute("SELECT state,authority FROM memories").fetchall()
    assert rows
    assert {row["authority"] for row in rows} == {"inferred"}
    assert {row["state"] for row in rows} <= {"provisional", "disputed"}


# ------------------------------------------------------------- batch review


def test_a_batch_can_be_approved_in_one_decision(adopted, memory):
    db, service, project = memory
    report = service.import_records(adopted["payload"], project=None)

    result = service.resolve_batch(batch=report["batch"], decision="approve")

    assert result["count"] == report["imported"]
    assert not service.review_list(project, all_projects=True)


@pytest.mark.parametrize("axis", ["scope", "repo"])
def test_a_batch_approval_can_be_narrowed_to_one_group(adopted, memory, repo, axis):
    """The groups the report counts are the groups that can be resolved.

    Showing a reviewer a table split by scope and repository and then only
    letting them take the whole batch is the same as not asking.
    """
    _, service, project = memory
    report = service.import_records(adopted["payload"], project=None)
    narrowing = {"scope": "global"} if axis == "scope" else {"repo": repo_key(repo)}

    service.resolve_batch(batch=report["batch"], decision="approve", **narrowing)

    remaining = service.review_list(project, all_projects=True)
    approved = service.review_list(project, state="active", all_projects=True)
    assert remaining and approved
    if axis == "scope":
        assert {item["scope"] for item in approved} == {"global"}
        assert "global" not in {item["scope"] for item in remaining}
    else:
        assert {item["repo_key"] for item in approved} == {repo_key(repo)}
        assert repo_key(repo) not in {item["repo_key"] for item in remaining}


def test_a_batch_never_reaches_memory_from_another_batch(adopted, memory):
    _, service, project = memory
    outsider = service.create_memory(
        Candidate(
            kind="preference",
            scope="global",
            statement="An unrelated provisional statement nobody imported.",
            authority="inferred",
            confidence=0.4,
        ),
        project=project,
    )
    report = service.import_records(adopted["payload"], project=None)

    service.resolve_batch(batch=report["batch"], decision="approve")

    assert service.get_memory(outsider["id"])["state"] == "provisional"


def test_rejecting_a_batch_keeps_it_out_on_the_next_adoption(adopted, memory):
    _, service, project = memory
    report = service.import_records(adopted["payload"], project=None)

    service.resolve_batch(batch=report["batch"], decision="reject")
    replay = service.import_records(adopted["payload"], project=None)

    assert replay["imported"] == 0
    assert all(item["reason"] == "forgotten" for item in replay["skipped"] if item["statement"])


def test_bulk_resolution_requires_a_batch(memory):
    _, service, project = memory
    with pytest.raises(Exception):
        service.resolve_batch(batch="", decision="approve")


def test_review_list_filters_by_source(adopted, memory):
    _, service, project = memory
    service.import_records(adopted["payload"], project=None)

    only_claude = service.review_list(project, source="claude-md", all_projects=True)

    assert only_claude
    # Every hit carries the source tag, and nothing from another file does.
    assert all(
        any(entry["kind"] == "import.claude-md" for entry in item["evidence"])
        for item in only_claude
    )
    assert any("narrow suite" in item["statement"] for item in only_claude)
    assert not any("stay in the current workspace" in item["statement"] for item in only_claude)
    assert len(only_claude) < len(service.review_list(project, all_projects=True))


# ---------------------------------------------------------------- dry run


def test_dry_run_reports_the_same_plan_and_writes_nothing(adopted, memory):
    _, service, _ = memory
    planned = service.import_records(adopted["payload"], project=None, dry_run=True)
    assert planned["dry_run"] is True
    assert service.db.conn.execute("SELECT count(*) FROM memories").fetchone()[0] == 0

    real = service.import_records(adopted["payload"], project=None)
    assert real["imported"] == planned["imported"]


# -------------------------------------------------------------------- CLI


def test_cli_lists_then_adopts_then_shows_the_batch(tmp_path, home, repo, capsys):
    store = tmp_path / "store"

    assert main(["--memory-home", str(store), "adopt", "list", "--home", str(home),
                 "--cwd", str(repo), "--format", "json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert {item["source"] for item in listed} >= {"claude-md", "codex-agents", "codex-memory"}
    assert any(item["episodic"] for item in listed)

    assert main(["--memory-home", str(store), "adopt", "--home", str(home),
                 "--cwd", str(repo), "--dry-run", "--format", "json"]) == 0
    planned = json.loads(capsys.readouterr().out)
    assert planned["dry_run"] is True
    assert planned["groups"]

    assert main(["--memory-home", str(store), "adopt", "--home", str(home),
                 "--cwd", str(repo), "--format", "json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["imported"] == planned["imported"]

    assert main(["--memory-home", str(store), "review", "list", "--cwd", str(repo),
                 "--all-projects", "--batch", report["batch"], "--format", "json"]) == 0
    queued = json.loads(capsys.readouterr().out)
    assert len(queued) == report["imported"]


def test_cli_can_select_a_single_source(tmp_path, home, repo, capsys):
    store = tmp_path / "store"
    assert main(["--memory-home", str(store), "adopt", "list", "--home", str(home),
                 "--cwd", str(repo), "--source", "codex-memory", "--format", "json"]) == 0
    listed = json.loads(capsys.readouterr().out)
    assert {item["source"] for item in listed} == {"codex-memory"}


def test_cli_refuses_a_bare_bulk_approval(tmp_path, capsys):
    store = tmp_path / "store"
    assert main(["--memory-home", str(store), "review", "approve", "--format", "json"]) == 1
    assert "ERROR=" in capsys.readouterr().err

