"""Advisory signals derived from git and file content at read time.

Nothing in this module is persisted or load-bearing: every function degrades to
`None`/empty results when git or the filesystem cannot answer, so advisory
computation can never fail a command or block a mutation.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .model import (
    PLAN_DIR,
    Diagnostic,
    Plan,
    compile_scope,
    repo_relative,
    scope_matches,
    unfilled_sections,
)
from .routing import blockers, readiness, tokens
from .store import prunable_done, required_closure, reverse_dependents

WALK_SKIP = {
    ".git",
    ".worktrees",
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
}
WALK_CAP = 50_000
OVERLAP_SAMPLES = 3
STALE_AFTER_DEFAULT = 5
DUPLICATE_TITLE_JACCARD = 0.5


def repo_files(root: Path) -> list[str] | None:
    """Tracked plus untracked repository files, or None when unlistable."""
    paths: set[str] = set()
    listed = False
    for args in (
        ["ls-files", "-z"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
    ):
        try:
            result = subprocess.run(
                ["git", "-C", str(root), *args],
                check=False,
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode != 0:
            continue
        listed = True
        for raw in result.stdout.split(b"\0"):
            if raw:
                paths.add(raw.decode("utf-8", errors="replace").replace("\\", "/"))
    if listed:
        return sorted(paths)
    return _walk_files(root)


def _walk_files(root: Path) -> list[str] | None:
    paths: list[str] = []
    try:
        for current, dirs, files in os.walk(root):
            dirs[:] = [name for name in dirs if name not in WALK_SKIP]
            current_path = Path(current)
            for name in files:
                paths.append((current_path / name).relative_to(root).as_posix())
                if len(paths) >= WALK_CAP:
                    return sorted(paths)
    except OSError:
        return None
    return sorted(paths)


def _git_stdout(root: Path, args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def staleness(
    root: Path,
    plans: dict[str, Plan],
    *,
    dirty_paths: list[str],
    stale_after: int = STALE_AFTER_DEFAULT,
) -> dict[str, dict[str, object]]:
    """Per-plan scope churn since the plan file itself last changed."""
    dirty = set(dirty_paths)
    return {
        plan_id: _plan_staleness(root, plan, dirty, stale_after)
        for plan_id, plan in plans.items()
    }


def _plan_staleness(
    root: Path, plan: Plan, dirty: set[str], stale_after: int
) -> dict[str, object]:
    dirty_scope = sum(
        1
        for path in dirty
        if any(scope_matches(pattern, path) for pattern in plan.scope)
    )
    report: dict[str, object] = {
        "state": "unknown",
        "commits_since_plan_update": None,
        "dirty_scope_paths": dirty_scope,
        "anchor": None,
    }
    if repo_relative(root, plan.path) in dirty:
        return {**report, "state": "fresh", "commits_since_plan_update": 0}
    if not plan.scope:
        return report
    anchor = _git_stdout(root, ["log", "-1", "--format=%H", "--", repo_relative(root, plan.path)])
    if not anchor:
        return report
    pathspecs = [f":(glob){pattern}" for pattern in plan.scope]
    counted = _git_stdout(root, ["rev-list", "--count", f"{anchor}..HEAD", "--", *pathspecs])
    try:
        count = int(counted) if counted is not None else None
    except ValueError:
        count = None
    if count is None:
        return report
    state = "stale" if count >= stale_after else "aging" if count else "fresh"
    return {
        "state": state,
        "commits_since_plan_update": count,
        "dirty_scope_paths": dirty_scope,
        "anchor": anchor,
    }


def stale_warnings(report: dict[str, dict[str, object]]) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    for plan_id in sorted(report):
        item = report[plan_id]
        if item["state"] != "stale":
            continue
        diagnostics.append(
            Diagnostic(
                "warning",
                "stale_plan",
                f"scope changed in {item['commits_since_plan_update']} commit(s) since"
                " this plan was last updated; re-read the diff and revise, reopen, or"
                " replace before relying on it",
                plan_id,
            )
        )
    return diagnostics


def _literal_prefix(pattern: str) -> str:
    for index, char in enumerate(pattern):
        if char in "*?[":
            return pattern[:index]
    return pattern


def file_index(plans: dict[str, Plan], files: list[str]) -> dict[str, set[str]]:
    """Concrete files each active plan's scope matches right now."""
    index: dict[str, set[str]] = {}
    for plan_id, plan in plans.items():
        if plan.status != "active" or not plan.scope:
            continue
        matched: set[str] = set()
        for pattern in plan.scope:
            try:
                regex = compile_scope(pattern)
            except ValueError:
                continue
            prefix = _literal_prefix(pattern)
            for path in files:
                if prefix and not path.startswith(prefix):
                    continue
                if regex.fullmatch(path):
                    matched.add(path)
        if matched:
            index[plan_id] = matched
    return index


def explain_plan(
    root: Path,
    plans: dict[str, Plan],
    plan_id: str,
    *,
    index: dict[str, set[str]] | None = None,
    staleness_report: dict[str, dict[str, object]] | None = None,
) -> dict[str, object]:
    """Every signal about one plan, aggregated for a trust/continue/revise decision."""
    plan = plans[plan_id]
    dependents = reverse_dependents(plans, [plan_id], active_only=False)
    overlaps: list[dict[str, object]] = []
    if index:
        mine = index.get(plan_id, set())
        closure = required_closure(plans, [plan_id])
        for other in sorted(index):
            if other == plan_id:
                continue
            shared = mine & index[other]
            if not shared:
                continue
            if other in closure or plan_id in required_closure(plans, [other]):
                continue
            overlaps.append(
                {"plan": other, "shared_files": sorted(shared)[:OVERLAP_SAMPLES]}
            )
    return {
        "plan": plan.as_summary(),
        "readiness": readiness(plans, plan_id),
        "blockers": blockers(plans, plan_id),
        "dependents": {
            "active": sorted(d for d in dependents if plans[d].status == "active"),
            "done": sorted(d for d in dependents if plans[d].status == "done"),
        },
        "staleness": (staleness_report or {}).get(
            plan_id,
            {
                "state": "unknown",
                "commits_since_plan_update": None,
                "dirty_scope_paths": 0,
                "anchor": None,
            },
        ),
        "overlaps": overlaps,
        "lineage": [
            {
                "replaced": old,
                "recover": f"git log --all -- {(PLAN_DIR / f'{old}.md').as_posix()}",
            }
            for old in plan.replaces
        ],
        "prunable": plan_id in prunable_done(plans),
        "unfilled_sections": list(unfilled_sections(plan)),
    }


def near_duplicates(plans: dict[str, Plan], index: dict[str, set[str]]) -> list[Diagnostic]:
    """Active pairs that look like one piece of work filed twice.

    Deliberately conservative — a shared tag alone never qualifies — because false
    duplicate alarms teach the reader to ignore diagnostics.
    """
    diagnostics: list[Diagnostic] = []
    active = sorted(
        plan_id for plan_id, plan in plans.items() if plan.status == "active"
    )
    for position, first in enumerate(active):
        first_tags = {tag.casefold() for tag in plans[first].tags}
        first_title = tokens(plans[first].title)
        first_closure = required_closure(plans, [first])
        for second in active[position + 1 :]:
            shared_tags = first_tags & {tag.casefold() for tag in plans[second].tags}
            if not shared_tags:
                continue
            if second in first_closure or first in required_closure(plans, [second]):
                continue
            shared_files = index.get(first, set()) & index.get(second, set())
            second_title = tokens(plans[second].title)
            union = first_title | second_title
            jaccard = len(first_title & second_title) / len(union) if union else 0.0
            if not shared_files and jaccard < DUPLICATE_TITLE_JACCARD:
                continue
            evidence = f"shared tag '{sorted(shared_tags)[0]}'"
            if shared_files:
                evidence += f", {len(shared_files)} shared file(s)"
            else:
                evidence += f", title similarity {jaccard:.2f}"
            diagnostics.append(
                Diagnostic(
                    "warning",
                    "possible_duplicate",
                    f"resembles {second} ({evidence}); merge them with update, or"
                    " make one require the other only if genuinely ordered",
                    first,
                )
            )
    return diagnostics


def scope_overlaps(plans: dict[str, Plan], index: dict[str, set[str]]) -> list[Diagnostic]:
    """Active plan pairs that own the same concrete files with no declared ordering."""
    diagnostics: list[Diagnostic] = []
    ids = sorted(index)
    for position, first in enumerate(ids):
        first_closure = required_closure(plans, [first])
        for second in ids[position + 1 :]:
            shared = index[first] & index[second]
            if not shared:
                continue
            if second in first_closure or first in required_closure(plans, [second]):
                continue
            samples = ", ".join(sorted(shared)[:OVERLAP_SAMPLES])
            diagnostics.append(
                Diagnostic(
                    "warning",
                    "scope_overlap",
                    f"shares {len(shared)} file(s) with {second} (e.g. {samples});"
                    " read that plan before editing shared files, add requires only"
                    " for a genuine ordering, or narrow one scope",
                    first,
                )
            )
    return diagnostics
