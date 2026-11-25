"""Adopting Claude Code's own auto-memory (`<config>/projects/<slug>/memory/*.md`).

Each folder names its checkout only by a lossy slug, and a machine can hold
several config directories (one per `CLAUDE_CONFIG_DIR` profile). What is
defended: a slug resolves to the key recall computes in that checkout, a slug
whose checkout is gone is skipped instead of widened, and the frontmatter's
`type` and the `Why`/`How to apply` convention shape the record.
"""

from __future__ import annotations

import json
import re
import sys
import subprocess
from pathlib import Path

import pytest

from agent_memory.cli import main
from agent_memory.sources import build_payload, directory_for_slug, discover
from agent_memory.util import repo_key

FEEDBACK = """\
---
name: verify-chart-interaction
description: charts are done only after hover/Tab/Escape are driven in a browser
metadata:
  type: feedback
---

Charts count as done only after hover, Tab and Escape were driven in a real browser.

**Why:** static screenshots missed a broken tooltip twice.
**How to apply:** drive the interaction before reporting a chart change; see [[ui-checks|the UI checks]].
"""

USER = """\
---
name: user-role
description: who the user is
type: user
---

The user reviews diffs in Korean and prefers short reports that lead with the result.
"""

INDEX = "- [Verify chart interaction](verify-chart-interaction.md) — drive it first\n"


def _slug(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(path.resolve()))


def _git_init(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)


def _memory_dir(config: Path, checkout: Path) -> Path:
    folder = config / "projects" / _slug(checkout) / "memory"
    folder.mkdir(parents=True)
    return folder


@pytest.fixture
def layout(tmp_path: Path):
    home = tmp_path / "home"
    repo = tmp_path / "work" / "chart-app"
    _git_init(repo)
    plain = tmp_path / "work" / "svn.checkout"
    plain.mkdir(parents=True)
    profile = tmp_path / "profiles" / "p1"

    main_memory = _memory_dir(home / ".claude", repo)
    (main_memory / "MEMORY.md").write_text(INDEX, encoding="utf-8")
    (main_memory / "verify-chart-interaction.md").write_text(FEEDBACK, encoding="utf-8")
    (main_memory / "user-role.md").write_text(USER, encoding="utf-8")

    (_memory_dir(profile, plain) / "svn-rule.md").write_text(
        "---\nname: svn-rule\ntype: project\n---\n\nCommit to SVN only after the narrow tests pass.\n",
        encoding="utf-8",
    )
    (_memory_dir(profile, tmp_path / "gone") / "lost.md").write_text(
        "---\nname: lost\ntype: project\n---\n\nThis checkout was deleted long ago, keep it out.\n",
        encoding="utf-8",
    )
    return {"home": home, "repo": repo, "plain": plain, "profile": profile, "tmp": tmp_path}


def _built(layout, *profiles: Path):
    sources = discover(home=layout["home"], claude_configs=profiles, claude_memory=True)
    return build_payload([item for item in sources if item.source == "claude-memory"])


def _find(built, fragment: str) -> dict:
    for record in built["payload"]["memories"]:
        if fragment in record["statement"]:
            return record
    raise AssertionError(f"no record contains {fragment!r}")


def test_slug_resolves_to_the_directory_it_was_made_from(layout):
    assert directory_for_slug(_slug(layout["repo"])) == layout["repo"].resolve()
    # `.` and `-` both slug to `-`; the disk decides which one is there.
    assert directory_for_slug(_slug(layout["plain"])) == layout["plain"].resolve()
    assert directory_for_slug(_slug(layout["tmp"] / "gone")) is None


def test_feedback_stays_with_its_repository(layout):
    built = _built(layout)
    record = _find(built, "Charts count as done")
    assert record["scope"] == "project"
    assert record["repo_key"] == repo_key(layout["repo"])
    assert record["conditions"] == ["verify-chart-interaction"]


def test_profile_dirs_are_read_only_when_named(layout):
    assert not any("SVN" in item["statement"] for item in _built(layout)["payload"]["memories"])
    record = _find(_built(layout, layout["profile"]), "Commit to SVN")
    # A non-git checkout gets the path identity recall uses when standing there.
    assert record["repo_key"] == repo_key(layout["plain"])


def test_claude_config_dir_env_is_read_unless_home_is_explicit(layout, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(layout["profile"]))
    assert not any("SVN" in item["statement"] for item in _built(layout)["payload"]["memories"])
    monkeypatch.setenv("HOME", str(layout["home"]))
    sources = [item for item in discover(claude_memory=True) if item.source == "claude-memory"]
    _find(build_payload(sources), "Commit to SVN")


@pytest.mark.skipif(sys.platform not in ("win32", "darwin"), reason="case-folding filesystems only")
def test_slug_case_follows_the_filesystem(layout):
    assert directory_for_slug(_slug(layout["repo"]).lower()) is not None


def test_a_deleted_checkout_is_skipped_not_widened(layout):
    built = _built(layout, layout["profile"])
    assert not any("deleted long ago" in item["statement"] for item in built["payload"]["memories"])
    assert any(
        item["reason"] == "unknown-project" and "lost" in item["statement"] for item in built["skipped"]
    )


def test_cli_adopts_a_profile_into_the_review_queue(layout, capsys):
    store = layout["tmp"] / "store"
    args = ["--memory-home", str(store), "adopt", "--source", "claude-memory",
            "--home", str(layout["home"]), "--claude-config-dir", str(layout["profile"]),
            "--format", "json"]
    assert main(args) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["imported"] == report["review_queued"] == 4
    assert {item["source"] for item in report["groups"]} == {"claude-memory"}

    assert main(args) == 0  # re-running is the sync: it merges, never duplicates
    again = json.loads(capsys.readouterr().out)
    assert again["imported"] == 0


WRAPPED = """\
---
name: no-unasked-loops
type: feedback
---

Do not start long autonomous side-quests the user did not ask for: CI polling
loops after a push, exhaustive option surveys.

**Why:** they are the sole maintainer of this repo and want the change made,
not a research narrative.

**How to apply:** make the decision, do the work, verify the thing actually
changed, report in a few lines.
- **Why:** a second, bulleted reason that wraps
  onto an indented line.
"""


def test_wrapped_why_and_how_paragraphs_stay_whole(layout):
    folder = layout["home"] / ".claude" / "projects" / _slug(layout["repo"]) / "memory"
    (folder / "no-unasked-loops.md").write_text(WRAPPED, encoding="utf-8")

    built = _built(layout)
    statements = [item["statement"] for item in built["payload"]["memories"] if item["conditions"] == ["no-unasked-loops"]]

    assert statements == [
        "Do not start long autonomous side-quests the user did not ask for: CI polling "
        "loops after a push, exhaustive option surveys.",
        "make the decision, do the work, verify the thing actually changed, report in a few lines.",
    ]
    summary = _find(built, "make the decision")["evidence"][0]["summary"]
    assert "want the change made, not a research narrative" in summary
    assert "wraps onto an indented line" in summary


def _adopt(layout, store, *extra):
    return main(
        ["--memory-home", str(store), "adopt", "--source", "claude-memory",
         "--home", str(layout["home"]), "--format", "json", *extra]
    )


def test_replace_retracts_fragments_an_earlier_adopt_left(layout, capsys):
    from agent_memory.db import Database
    from agent_memory.models import Candidate
    from agent_memory.providers import NullProvider
    from agent_memory.service import MemoryService

    store = layout["tmp"] / "store"
    label = f"~/.claude/projects/{_slug(layout['repo'])}/memory/verify-chart-interaction.md"
    project = repo_key(layout["repo"])

    def seed(statement, *evidence):
        with Database(store) as db:
            return MemoryService(db, NullProvider()).create_memory(
                Candidate(kind="preference", scope="project", statement=statement,
                          authority="inferred", confidence=0.5, evidence=list(evidence)),
                project=project,
            )

    fragment = seed("changed, report in a few lines of the chart.", {"kind": "import.claude-memory", "summary": f"{label} § x"})
    confirmed = seed("tooltip broke twice in static screenshots before.",
                     {"kind": "import.claude-memory", "summary": f"{label} § x"},
                     {"kind": "user_prompt", "summary": "the user said so"})
    other = seed("another file's fragment stays put here.", {"kind": "import.claude-memory", "summary": "~/.claude/projects/x/memory/other.md § y"})

    assert _adopt(layout, store, "--replace", "--dry-run") == 0
    preview = json.loads(capsys.readouterr().out)
    assert [item["id"] for item in preview["retracted"]] == [fragment["id"]]

    assert _adopt(layout, store, "--replace") == 0
    report = json.loads(capsys.readouterr().out)
    assert [item["id"] for item in report["retracted"]] == [fragment["id"]]

    with Database(store) as db:
        states = dict(db.conn.execute("SELECT id, state FROM memories").fetchall())
    assert states[fragment["id"]] == "retracted"
    assert states[confirmed["id"]] != "retracted" and states[other["id"]] != "retracted"

    assert _adopt(layout, store, "--replace") == 0  # what this run produced is never retracted
    assert json.loads(capsys.readouterr().out)["retracted"] == []


def test_replace_retracts_a_batch_approved_fragment_but_not_an_explicit_record(layout, capsys):
    from agent_memory.db import Database
    from agent_memory.models import Candidate
    from agent_memory.providers import NullProvider
    from agent_memory.service import MemoryService

    store = layout["tmp"] / "store"
    label = f"~/.claude/projects/{_slug(layout['repo'])}/memory/verify-chart-interaction.md"
    evidence = {"kind": "import.claude-memory", "summary": f"{label} § x"}
    with Database(store) as db:
        service = MemoryService(db, NullProvider())
        approved = service.create_memory(
            Candidate(kind="preference", scope="project", statement="changed, report in a few lines of it.",
                      authority="inferred", confidence=0.5, evidence=[evidence]),
            project=repo_key(layout["repo"]),
        )
        service.approve(approved["id"], force=True)
        explicit = service.create_memory(
            Candidate(kind="preference", scope="project", statement="An explicit rule that names this file.",
                      authority="explicit", confidence=1.0, evidence=[evidence]),
            project=repo_key(layout["repo"]),
        )

    assert _adopt(layout, store, "--replace") == 0
    retracted = {item["id"] for item in json.loads(capsys.readouterr().out)["retracted"]}

    # Approving an adopted batch accepts the file's content, not this wording.
    assert approved["id"] in retracted
    assert explicit["id"] not in retracted


def test_replace_keeps_a_codex_group_whose_checkout_is_gone(tmp_path, capsys):
    from agent_memory.db import Database
    from agent_memory.models import Candidate
    from agent_memory.providers import NullProvider
    from agent_memory.service import MemoryService

    home = tmp_path / "home"
    memory = home / ".codex" / "memories" / "MEMORY.md"
    memory.parent.mkdir(parents=True)
    memory.write_text(
        "# Task Group: gone\napplies_to: cwd=" + (tmp_path / "gone").as_posix() + "\n\n## User preferences\n\n"
        "- Keep the release notes short and lead with the result.\n",
        encoding="utf-8",
    )
    store = tmp_path / "store"
    with Database(store) as db:
        kept = MemoryService(db, NullProvider()).create_memory(
            Candidate(kind="preference", scope="project", statement="A rule from the moved checkout stays.",
                      authority="inferred", confidence=0.5,
                      evidence=[{"kind": "import.codex-memory", "summary": "~/.codex/memories/MEMORY.md § gone"}]),
            project="moved-repo",
        )

    assert main(["--memory-home", str(store), "adopt", "--source", "codex-memory", "--home", str(home),
                 "--replace", "--format", "json"]) == 0
    report = json.loads(capsys.readouterr().out)

    assert any(item["reason"] == "unknown-project" for item in report["skipped"])
    assert report["retracted"] == []
    assert kept["id"]


def test_replace_keeps_what_a_file_with_a_moved_checkout_gave(layout, capsys):
    from agent_memory.db import Database
    from agent_memory.models import Candidate
    from agent_memory.providers import NullProvider
    from agent_memory.service import MemoryService

    store = layout["tmp"] / "store"
    lost = layout["profile"] / "projects" / _slug(layout["tmp"] / "gone") / "memory" / "lost.md"
    with Database(store) as db:
        kept = MemoryService(db, NullProvider()).create_memory(
            Candidate(kind="preference", scope="project", statement="A rule from a checkout that moved away.",
                      authority="inferred", confidence=0.5,
                      evidence=[{"kind": "import.claude-memory", "summary": f"{lost.as_posix()} § lost"}]),
            project="moved-repo",
        )

    assert _adopt(layout, store, "--claude-config-dir", str(layout["profile"]), "--replace") == 0
    report = json.loads(capsys.readouterr().out)

    assert any(item.get("path") == lost.as_posix() for item in report["skipped"])
    assert report["retracted"] == []
    with Database(store) as db:
        assert db.conn.execute("SELECT state FROM memories WHERE id=?", (kept["id"],)).fetchone()[0] != "retracted"
