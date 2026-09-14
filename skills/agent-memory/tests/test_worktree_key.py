"""Linked git worktrees share their repository's key.

The key used to come from `--show-toplevel`, which names the linked worktree when run
inside one. Memory written there was stored under a key no other checkout computes, so
it never surfaced in the main tree, and each new worktree rediscovered and re-remembered
the same trap: on one real store a single caveat existed in seven copies across keys like
`action-color-…` and `repeat-rows-…` instead of the repository's own.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_memory.cli import main
from agent_memory.models import Candidate
from agent_memory.rekey import legacy_key, rekey
from agent_memory.retrieval import Retriever
from agent_memory.service import content_digest
from agent_memory.util import key_for, repo_key, root_identity


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )


def _repo(path: Path, *, origin: str | None = None) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init")
    if origin:
        _git(path, "remote", "add", "origin", origin)
    return path.resolve()


def _worktree(root: Path, name: str) -> Path:
    target = root / ".worktrees" / name
    _git(root, "worktree", "add", "-q", "-b", f"wt-{name}", str(target))
    return target.resolve()


def _note(statement: str) -> Candidate:
    return Candidate(
        kind="caveat", scope="project", statement=statement, authority="explicit", confidence=1.0
    )


@pytest.mark.parametrize("origin", [None, "https://example.invalid/team/widget.git"])
def test_linked_worktree_computes_the_main_tree_key(tmp_path, origin):
    root = _repo(tmp_path / "widget", origin=origin)
    worktree = _worktree(root, "feature-x")
    (worktree / "pkg").mkdir()

    main_key = repo_key(root)
    assert repo_key(worktree) == main_key
    assert repo_key(worktree / "pkg") == main_key
    # The main tree must keep the key it always had, or fixing worktrees would orphan
    # every record the main tree already holds.
    assert main_key == legacy_key(root, root_identity(root))
    assert main_key.startswith("widget-")


def test_non_ascii_worktree_name_resolves_and_is_listed(tmp_path, memory):
    # git prints this path as UTF-8; decoding it with a cp949 console codec used to
    # leave stdout as None and crash every key lookup from inside the worktree.
    _, service, _ = memory
    root = _repo(tmp_path / "widget")
    worktree = _worktree(root, "예시출처-조건보이기")

    assert repo_key(worktree) == repo_key(root)
    old = legacy_key(worktree, root_identity(root))
    service.create_memory(_note("Korean worktree names must not break lookups"), project=old)
    report = rekey(service, roots=[root], explicit={}, apply=False)
    assert [item["from"] for item in report["mappings"]] == [old]


def test_rekey_dry_run_writes_nothing_then_apply_folds_worktree_memory(tmp_path, memory):
    db, service, _ = memory
    root = _repo(tmp_path / "widget")
    worktree = _worktree(root, "feature-x")
    old = legacy_key(worktree, root_identity(root))
    new = repo_key(root)
    assert old != new
    stored = service.create_memory(_note("Copy the fixtures before running extraction"), project=old)
    service.trust_grant(old, ["caveat"])

    preview = rekey(service, roots=[root], explicit={}, apply=False)
    assert preview["dry_run"] is True
    assert [(item["from"], item["to"], item["reason"]) for item in preview["mappings"]] == [
        (old, new, "worktree:feature-x")
    ]
    assert preview["mappings"][0]["memories"] == 1
    assert preview["backup"] == ""
    assert db.conn.execute("SELECT repo_key FROM memories WHERE id=?", (stored["id"],)).fetchone()[0] == old

    applied = rekey(service, roots=[root], explicit={}, apply=True)
    assert Path(applied["backup"]).is_file()
    row = db.conn.execute("SELECT repo_key,content_hash FROM memories WHERE id=?", (stored["id"],)).fetchone()
    assert row["repo_key"] == new
    assert row["content_hash"] == content_digest(_note("Copy the fixtures before running extraction"), new)
    assert [item["memory_kind"] for item in service.trust_list(new)] == ["caveat"]
    assert service.trust_list(old) == []

    packet = Retriever(db, service.provider).recall(project=new, prompt="copy fixtures extraction")
    assert stored["id"] in {item["id"] for item in packet["items"]}
    # Remembering the same sentence from the main tree confirms the moved record instead
    # of adding a copy -- which is why the hash had to move with the key.
    again = service.create_memory(_note("Copy the fixtures before running extraction"), project=new)
    assert again["id"] == stored["id"]


def test_rekey_reproduces_a_removed_worktree_from_its_path(tmp_path, memory):
    _, service, _ = memory
    root = _repo(tmp_path / "widget")
    gone = root / ".claude" / "worktrees" / "old-work"
    (root / ".claude" / "worktrees").mkdir(parents=True)
    old = legacy_key(gone, root_identity(root))
    service.create_memory(_note("The dev port block starts at base plus two"), project=old)

    report = rekey(service, roots=[root], explicit={}, apply=False)

    assert [(item["from"], item["reason"]) for item in report["mappings"]] == [
        (old, "removed-worktree:old-work")
    ]


def test_rekey_does_not_merge_a_same_origin_key_on_hash_alone(tmp_path, memory):
    _, service, _ = memory
    origin = "https://example.invalid/team/widget.git"
    root = _repo(tmp_path / "widget", origin=origin)
    identity = root_identity(root)
    # A separate clone of the same origin shares the hash suffix; only its folder differs.
    clone_key = key_for(tmp_path / "widget-second-clone", identity)
    service.create_memory(_note("The clone has its own local database"), project=clone_key)

    report = rekey(service, roots=[root], explicit={}, apply=False)
    assert report["mappings"] == []
    assert report["unmatched_same_hash"] == [
        {"key": clone_key, "shares_hash_with": repo_key(root), "memories": 1}
    ]

    mapped = rekey(service, roots=[root], explicit={clone_key: repo_key(root)}, apply=False)
    assert [(item["from"], item["reason"]) for item in mapped["mappings"]] == [(clone_key, "map")]


def test_rekey_retracts_copies_that_become_identical_and_keeps_the_active_one(tmp_path, memory):
    db, service, _ = memory
    root = _repo(tmp_path / "widget")
    worktree = _worktree(root, "feature-x")
    old = legacy_key(worktree, root_identity(root))
    new = repo_key(root)
    statement = "Worktrees lack the ignored regulation sources"
    provisional = service.create_memory(
        Candidate(kind="caveat", scope="project", statement=statement, authority="inferred"),
        project=new,
    )
    active = service.create_memory(_note(statement), project=old)
    assert provisional["state"] != "active" and active["state"] == "active"

    preview = rekey(service, roots=[root], explicit={}, apply=False)
    assert preview["duplicates_retracted"] == 1

    rekey(service, roots=[root], explicit={}, apply=True)
    states = dict(db.conn.execute("SELECT id,state FROM memories").fetchall())
    assert states[active["id"]] == "active"
    assert states[provisional["id"]] == "retracted"
    assert db.conn.execute(
        "SELECT 1 FROM relations WHERE source_id=? AND target_id=? AND relation='supersedes'",
        (active["id"], provisional["id"]),
    ).fetchone()


def test_rekey_cli_rejects_a_malformed_map(tmp_path, capsys):
    code = main(["--memory-home", str(tmp_path / "memory"), "rekey", "--map", "no-separator"])
    assert code != 0
    assert "OLD=NEW" in capsys.readouterr().err
