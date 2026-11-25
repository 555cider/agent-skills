"""Other worktrees of the repository: their changes and their plans, read without merging.

Agents work in parallel git worktrees, and before anything lands nobody sees another
worktree's plans or edits. This reads both straight from each worktree's directory:
changed files from `worktree_overlap.snapshot` (shared with worktree-cycle, same
judgement), plan documents from the filesystem, so an ignored `.plans/` counts too.

A plan document another worktree holds is reported only when it is that worktree's
own: missing here, or different from the copy here. Plans inherited unchanged from
the base are already in this worktree's own store.
"""

from __future__ import annotations

from pathlib import Path

from . import worktree_overlap
from .loose import FileIndex
from .model import Plan, scope_matches
from .store import configured_dirs, plan_dirs, read_plan_documents

PLAN_MATCH_SAMPLES = 3


def _tracked_in_base(
    root: Path, base: str, dirs: list[str], cache: dict[tuple[str, ...], set[str] | None]
) -> set[str] | None:
    """Plan-directory files the base branch tracks, one `ls-tree` per base."""
    key = (base, *dirs)
    if key not in cache:
        code, out = worktree_overlap._git(
            str(root), ["ls-tree", "-r", "-z", "--name-only", f"refs/heads/{base}", "--", *dirs]
        )
        cache[key] = set(worktree_overlap._split_z(out)) if code == 0 else None
    return cache[key]


def _own_documents(
    other: Path, plans: list[Plan], changed: set[str], tracked: set[str] | None
) -> list[Plan]:
    """The worktree's own plans: changed there since its base, or not tracked by the base.

    Comparing against this worktree's copy instead made every sibling look like it owned
    a plan as soon as this worktree edited or deleted it.
    """
    own: list[Plan] = []
    for plan in plans:
        try:
            relative = plan.path.relative_to(other).as_posix()
        except ValueError:
            continue
        if relative in changed or (tracked is not None and relative not in tracked):
            own.append(plan)
    return own


def _matches(plan: Plan, selectors: list[str]) -> list[str]:
    matched: list[str] = []
    for path in selectors:
        for pattern in plan.scope:
            try:
                if scope_matches(pattern, path):
                    matched.append(path)
                    break
            except ValueError:  # an invalid scope in someone else's plan
                continue
    return matched


def _plan_entry(other: Path, plan: Plan, matched: list[str]) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": plan.id,
        "title": plan.title,
        "path": plan.path.relative_to(other).as_posix(),
        "kind": plan.kind,
        "status": plan.status,
        "matched": matched[:PLAN_MATCH_SAMPLES],
    }
    if plan.is_loose:
        entry["status_line"] = plan.status_line
    return entry


Collected = tuple[list[worktree_overlap.Worktree], list[str]]


def collect(root: Path) -> Collected:
    return worktree_overlap.snapshot(str(root))


def _here(root: Path, worktrees: list[worktree_overlap.Worktree]) -> worktree_overlap.Worktree | None:
    return next((item for item in worktrees if worktree_overlap.same_path(item.path, str(root))), None)


def here_files(root: Path, collected: Collected) -> list[str]:
    here = _here(root, collected[0])
    return list(here.files) if here else []


def report(
    root: Path,
    selectors: list[str] | None = None,
    *,
    index: FileIndex | None = None,
    collected: Collected | None = None,
) -> dict[str, object]:
    """Overlap between this worktree and every other one.

    `selectors` are repository paths (a trailing `/` is a directory); None means this
    worktree's own changes, committed since its base plus uncommitted.
    """
    worktrees, warnings = collected if collected is not None else collect(root)
    warnings = list(warnings)
    here = _here(root, worktrees)
    if here is None:
        return {
            "available": False,
            "here": None,
            "selectors": selectors or [],
            "overlaps": [],
            "worktrees": [],
            "warnings": warnings or ["this directory is not a worktree git lists"],
        }
    chosen = list(here.files) if selectors is None else list(selectors)
    configured = configured_dirs(root)
    overlaps: list[dict[str, object]] = []
    listed: list[dict[str, object]] = []
    base_trees: dict[tuple[str, ...], set[str] | None] = {}
    for item in worktrees:
        if item is here:
            continue
        other = Path(item.path)
        plans: list[dict[str, object]] = []
        try:
            dirs, _ = plan_dirs(other, configured)
            documents, _ = read_plan_documents(other, dirs, index_provider=lambda: index)
            tracked = (
                _tracked_in_base(root, item.base, [d.as_posix() for d in dirs.read], base_trees)
                if item.base else None
            )
            for plan in _own_documents(other, documents, set(item.files), tracked):
                if plan.status != "active":
                    continue
                matched = _matches(plan, chosen)
                if matched:
                    plans.append(_plan_entry(other, plan, matched))
        except Exception as exc:  # noqa: BLE001 - one unreadable worktree must not hide the rest
            warnings.append(f"{item.path}: plans not read ({exc})")
        files = worktree_overlap.shared(chosen, item.files)
        listed.append({
            "path": item.path,
            "branch": item.branch,
            "main": item.main,
            "changed": len(item.files),
            "area": worktree_overlap.area(item.files),
        })
        if files or plans:
            overlaps.append({
                "path": item.path,
                "branch": item.branch,
                "base": item.base,
                "main": item.main,
                "changed": len(item.files),
                "area": worktree_overlap.area(item.files),
                "shared_files": files,
                "plans": plans,
            })
    return {
        "available": True,
        "here": {
            "path": here.path,
            "branch": here.branch,
            "base": here.base,
            "changed": list(here.files),
        },
        "selectors": chosen,
        "overlaps": overlaps,
        "worktrees": listed,
        "warnings": warnings,
    }
