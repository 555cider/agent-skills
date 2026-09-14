"""Fold repository keys minted by the pre-worktree-aware `repo_key` onto the current one.

Before `repo_root` learned about the common git dir, a linked worktree was keyed on its
own directory. Both halves of the key could differ from the main tree's: the slug is the
worktree's folder name, and a repository without an origin hashed the worktree *path*.
Those records are not lost, only unreachable -- recall looks up the key the current
directory computes, and no directory computes the old one any more.

A key is a one-way hash, so the old ones cannot be read back into paths. What can be done
is the reverse: list the directories a worktree of a known repository could have lived in,
compute the key the *old* rule gave each of them, and map a stored key only when one of
those computations reproduces it exactly. Matching on the hash suffix alone is not enough:
a separate clone of the same origin shares that suffix, and merging it would hand one
checkout's memory and trust grants to another.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Sequence

from .db import Database
from .models import Candidate
from .service import MemoryService, content_digest
from .util import MemoryError, _git_value, key_for, repo_root, root_identity, utc_now

# Where worktree tooling conventionally puts linked worktrees. A worktree that has since
# been removed no longer shows up in `git worktree list`, so its old key can only be
# reproduced by guessing the directory it lived in -- these are the guesses.
WORKTREE_PARENTS: tuple[tuple[str, ...], ...] = ((".worktrees",), (".claude", "worktrees"))

# Tables that carry a plain repo_key column and need nothing but the column moved.
# `tombstones` is among them even though its digest also folds in the repo key: the
# digest is an HMAC over a statement that forget already deleted, so it cannot be
# recomputed. The consequence is bounded by the 7-day tombstone TTL and documented.
SIMPLE_TABLES = ("events", "retrieval_queries", "sessions", "tombstones")

STATE_RANK = {"active": 0, "provisional": 1, "disputed": 2, "expired": 3}
TRUSTED_AUTHORITIES = {"explicit", "approved", "verified"}
CONTRADICTION_REPORT_LIMIT = 50


def legacy_key(directory: Path, identity: str | None) -> str:
    """The key the old rule computed for a checkout rooted at `directory`.

    A worktree reads the same `remote.origin.url` as its main tree, so when the
    repository has an origin the old identity was the origin; otherwise it was the
    worktree's own path.
    """

    if identity and identity.startswith("origin:"):
        return key_for(directory, identity)
    return key_for(directory, "path:" + str(directory))


def _stored_keys(db: Database) -> set[str]:
    keys: set[str] = set()
    for table in ("memories", "trust_grants", *SIMPLE_TABLES):
        for row in db.conn.execute(f"SELECT DISTINCT repo_key FROM {table} WHERE repo_key IS NOT NULL"):
            keys.add(str(row[0]))
    return keys


def _slug(key: str) -> str:
    # key_for appends "-" plus 16 hex digits.
    return key[:-17] if len(key) > 17 else ""


def _worktree_paths(root: Path) -> list[Path]:
    listing = _git_value(root, "worktree", "list", "--porcelain")
    paths: list[Path] = []
    for line in listing.splitlines():
        if line.startswith("worktree "):
            paths.append(Path(line[len("worktree ") :]).resolve())
    return paths


def _candidate_dirs(root: Path, identity: str, stored: Iterable[str]) -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = [(root, "main")]
    for path in _worktree_paths(root):
        if path != root:
            found.append((path, f"worktree:{path.name}"))
    for parts in WORKTREE_PARENTS:
        parent = root.joinpath(*parts)
        if parent.is_dir():
            for child in sorted(parent.iterdir()):
                if child.is_dir():
                    found.append((child.resolve(), f"worktree:{child.name}"))
        # Removed worktrees: the stored slug is the only trace of the folder name, so the
        # guess is rebuilt from the key being tested. That is evidence only when the old
        # hash covered the path. With an origin the hash is the origin's, and a directory
        # named after the key's own slug reproduces the key by construction -- a separate
        # clone would "match" too. Those are left to --map.
        if not identity.startswith("path:"):
            continue
        # The slug is lower-cased with non-ASCII runs collapsed, so a folder name that did
        # not survive that round trip will not reproduce its hash and is left to --map.
        for key in stored:
            slug = _slug(key)
            if slug:
                found.append((parent / slug, f"removed-worktree:{slug}"))
    return found


def plan_mappings(
    db: Database, roots: Sequence[Path], explicit: dict[str, str]
) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    stored = _stored_keys(db)
    proposals: dict[str, set[tuple[str, str]]] = {}
    targets: dict[str, str] = {}
    for raw in roots:
        root = repo_root(raw)
        identity = root_identity(root)
        target = key_for(root, identity)
        targets[target] = identity
        for directory, reason in _candidate_dirs(root, identity, stored):
            old = legacy_key(directory, identity)
            if old != target and old in stored:
                proposals.setdefault(old, set()).add((target, reason))

    mappings: list[dict[str, str]] = []
    for old, new in sorted(explicit.items()):
        if old == new:
            continue
        mappings.append({"from": old, "to": new, "reason": "map"})
    for old, options in sorted(proposals.items()):
        if old in explicit:
            continue
        destinations = {target for target, _ in options}
        if len(destinations) > 1:
            raise MemoryError(
                f"{old} matches more than one repository ({', '.join(sorted(destinations))}); "
                f"choose one with --map {old}=<key>"
            )
        target = destinations.pop()
        # A live worktree is stronger evidence than a guessed removed one; report that.
        reason = min(
            (reason for _, reason in options),
            key=lambda value: (value.startswith("removed-"), value),
        )
        mappings.append({"from": old, "to": target, "reason": reason})

    # Keys that share a target's hash but no candidate directory reproduced: a worktree
    # whose folder name the slug no longer spells, or a separate clone. Only a person
    # can tell which, so they are reported and left alone.
    mapped = {item["from"] for item in mappings}
    unmatched: list[dict[str, Any]] = []
    for key in sorted(stored - mapped - set(targets)):
        for target in targets:
            if key[-16:] == target[-16:]:
                count = db.conn.execute(
                    "SELECT count(*) FROM memories WHERE repo_key=?", (key,)
                ).fetchone()[0]
                unmatched.append({"key": key, "shares_hash_with": target, "memories": count})
    return mappings, unmatched


def _counts(db: Database, key: str) -> dict[str, int]:
    return {
        table: db.conn.execute(f"SELECT count(*) FROM {table} WHERE repo_key=?", (key,)).fetchone()[0]
        for table in ("memories", "trust_grants", *SIMPLE_TABLES)
    }


def _row_hash(row: sqlite3.Row, key: str) -> str:
    candidate = Candidate(
        kind=row["kind"],
        scope=row["scope"],
        statement=row["statement"],
        conditions=json.loads(row["conditions_json"] or "[]"),
        path_globs=json.loads(row["path_globs_json"] or "[]"),
    )
    return content_digest(candidate, key)


def _projected_rows(db: Database, mappings: Sequence[dict[str, str]]) -> dict[str, list[dict[str, Any]]]:
    """Every live project row that will sit under each target key, with the hash it will have."""

    by_target: dict[str, list[dict[str, Any]]] = {}
    sources: dict[str, list[str]] = {}
    for item in mappings:
        sources.setdefault(item["to"], [item["to"]]).append(item["from"])
    for target, keys in sources.items():
        rows = db.conn.execute(
            f"SELECT * FROM memories WHERE scope='project' AND state!='retracted' "
            f"AND repo_key IN ({','.join('?' for _ in keys)})",
            keys,
        ).fetchall()
        by_target[target] = [
            {
                "id": row["id"],
                "origin_key": row["repo_key"],
                "hash": _row_hash(row, target),
                "kind": row["kind"],
                "state": row["state"],
                "authority": row["authority"],
                "updated_at": row["updated_at"],
                "statement": row["statement"],
            }
            for row in rows
        ]
    return by_target


def _duplicate_losers(rows: Sequence[dict[str, Any]]) -> list[tuple[str, str]]:
    """(keeper, loser) pairs for rows whose content becomes identical under one key."""

    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(row["hash"], []).append(row)
    pairs: list[tuple[str, str]] = []
    for group in groups.values():
        if len(group) < 2:
            continue
        # Keep the record that is most actionable, then most trusted, then most recent:
        # retracting an active explicit record in favour of a provisional copy would
        # silently remove it from recall.
        ordered = sorted(group, key=lambda row: row["updated_at"], reverse=True)
        ordered.sort(
            key=lambda row: (
                STATE_RANK.get(row["state"], 9),
                0 if row["authority"] in TRUSTED_AUTHORITIES else 1,
            )
        )
        keeper = ordered[0]["id"]
        pairs.extend((keeper, row["id"]) for row in ordered[1:])
    return pairs


def _contradictions(rows: Sequence[dict[str, Any]], losers: set[str]) -> list[dict[str, str]]:
    """Pairs that `create_memory` would treat as conflicting once they share a key.

    They are reported, not resolved: after the merge the next explicit remember in the
    same kind may retract one of them, and the person running rekey should know that
    before it happens rather than find a record gone later.
    """

    live = [
        row
        for row in rows
        if row["id"] not in losers and row["state"] in {"active", "provisional", "disputed"}
    ]
    found: list[dict[str, str]] = []
    for index, left in enumerate(live):
        for right in live[index + 1 :]:
            if left["kind"] != right["kind"] or left["origin_key"] == right["origin_key"]:
                continue
            if MemoryService._contradicts(left["statement"], right["statement"]):
                # Ids alone send the reader to `review show` twice per pair; the opening
                # of each statement is usually enough to see whether it is a real conflict.
                found.append(
                    {
                        "kind": left["kind"],
                        "left": left["id"],
                        "right": right["id"],
                        "left_statement": left["statement"][:80],
                        "right_statement": right["statement"][:80],
                    }
                )
    return found


def _backup(db: Database) -> Path:
    stamp = utc_now().replace(":", "").replace("-", "").replace(".", "")
    target_dir = db.home / "backups" / "rekey" / stamp
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / db.path.name
    destination = sqlite3.connect(target)
    try:
        db.conn.backup(destination)
    finally:
        destination.close()
    return target


def rekey(
    service: MemoryService,
    *,
    roots: Sequence[Path],
    explicit: dict[str, str],
    apply: bool,
) -> dict[str, Any]:
    db = service.db
    mappings, unmatched = plan_mappings(db, roots, explicit)
    report_mappings = [{**item, **_counts(db, item["from"])} for item in mappings]
    projected = _projected_rows(db, mappings)
    duplicate_pairs = [pair for rows in projected.values() for pair in _duplicate_losers(rows)]
    losers = {loser for _, loser in duplicate_pairs}
    contradictions = [
        pair for rows in projected.values() for pair in _contradictions(rows, losers)
    ]
    report: dict[str, Any] = {
        "dry_run": not apply,
        "mappings": report_mappings,
        "duplicates_retracted": len(duplicate_pairs),
        "contradictions": {
            "count": len(contradictions),
            "pairs": contradictions[:CONTRADICTION_REPORT_LIMIT],
        },
        "unmatched_same_hash": unmatched,
        "backup": "",
    }
    if not apply or not mappings:
        return report

    report["backup"] = str(_backup(db))
    now = utc_now()
    with db.transaction(immediate=True):
        for item in mappings:
            old, new = item["from"], item["to"]
            for table in SIMPLE_TABLES:
                db.conn.execute(f"UPDATE {table} SET repo_key=? WHERE repo_key=?", (new, old))
            db.conn.execute(
                "INSERT OR IGNORE INTO trust_grants(repo_key,memory_kind,granted_at) "
                "SELECT ?,memory_kind,granted_at FROM trust_grants WHERE repo_key=?",
                (new, old),
            )
            db.conn.execute("DELETE FROM trust_grants WHERE repo_key=?", (old,))
            rows = db.conn.execute("SELECT * FROM memories WHERE repo_key=?", (old,)).fetchall()
            for row in rows:
                # The content hash folds in the repo key, and create_memory finds an
                # existing record by that hash. Moving only the column would leave the
                # old key inside the hash, and remembering the same sentence again from
                # the main tree would add a copy instead of confirming this one.
                db.conn.execute(
                    "UPDATE memories SET repo_key=?,content_hash=?,revision=revision+1 WHERE id=?",
                    (new, _row_hash(row, new), row["id"]),
                )
                service._snapshot(row["id"], f"rekey from {old}")
        for keeper, loser in duplicate_pairs:
            service._change_state(loser, "retracted", "duplicate merged by rekey")
            db.conn.execute(
                "INSERT OR IGNORE INTO relations(source_id,target_id,relation,created_at) VALUES(?,?,?,?)",
                (keeper, loser, "supersedes", now),
            )
    return report
