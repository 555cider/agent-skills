from __future__ import annotations

import contextlib
import json
import os
import secrets
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .model import (
    GATE_SECTIONS,
    ID_RE,
    LEGACY_GRAPH,
    PLAN_DIR,
    VALID_STATUSES,
    Diagnostic,
    Plan,
    PlanGraphError,
    compile_scope,
    parse_plan,
    render_plan,
    repo_relative,
    unfilled_sections,
)


@dataclass(frozen=True)
class Store:
    root: Path
    plans: dict[str, Plan]
    diagnostics: tuple[Diagnostic, ...]

    @property
    def errors(self) -> tuple[Diagnostic, ...]:
        return tuple(item for item in self.diagnostics if item.severity == "error")

    @property
    def warnings(self) -> tuple[Diagnostic, ...]:
        return tuple(item for item in self.diagnostics if item.severity == "warning")


def _run_git(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        raise PlanGraphError(f"failed to run Git: {exc}", code="git_failed") from exc


def discover_root(explicit: Path | None, cwd: Path | None = None) -> Path:
    if explicit is not None:
        candidate = explicit.expanduser().resolve()
        result = _run_git(candidate, ["rev-parse", "--show-toplevel"])
        if result.returncode == 0 and result.stdout.strip():
            git_root = Path(result.stdout.strip()).resolve()
            if candidate != git_root:
                raise PlanGraphError(
                    f"--root must be the Git toplevel ({git_root}), not {candidate}",
                    code="root_not_toplevel",
                )
        return candidate
    base = (cwd or Path.cwd()).resolve()
    result = _run_git(base, ["rev-parse", "--show-toplevel"])
    if result.returncode != 0 or not result.stdout.strip():
        raise PlanGraphError(
            "could not discover a Git worktree root; pass --root for tests or non-Git use",
            code="root_not_found",
        )
    return Path(result.stdout.strip()).resolve()


def load_store(root: Path, *, deep: bool = False) -> Store:
    root = root.resolve()
    diagnostics: list[Diagnostic] = []
    legacy = root / LEGACY_GRAPH
    if legacy.exists() or legacy.is_symlink():
        diagnostics.append(
            Diagnostic(
                "error",
                "legacy_store",
                "unsupported v1 graph found; v2 does not read or migrate .agents/plan/graph.yaml",
                path=repo_relative(root, legacy),
            )
        )

    agents = root / ".agents"
    directory = root / PLAN_DIR
    plans: dict[str, Plan] = {}
    blocked_parent = False
    if agents.is_symlink():
        diagnostics.append(
            Diagnostic(
                "error",
                "symlink_store",
                ".agents may not be a symlink",
                path=repo_relative(root, agents),
            )
        )
        blocked_parent = True
    elif agents.exists() and not agents.is_dir():
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_store",
                ".agents exists but is not a directory",
                path=repo_relative(root, agents),
            )
        )
        blocked_parent = True

    if not blocked_parent and directory.is_symlink():
        diagnostics.append(
            Diagnostic(
                "error",
                "symlink_store",
                ".agents/plans may not be a symlink",
                path=repo_relative(root, directory),
            )
        )
    elif not blocked_parent and directory.exists() and not directory.is_dir():
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_store",
                ".agents/plans exists but is not a directory",
                path=repo_relative(root, directory),
            )
        )
    elif not blocked_parent and directory.is_dir():
        for nested in sorted(directory.iterdir()):
            if nested.is_dir():
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "nested_plan",
                        "plans must be flat Markdown files directly under .agents/plans",
                        path=repo_relative(root, nested),
                    )
                )
                continue
            if nested.suffix.casefold() != ".md":
                continue
            plan, plan_diagnostics = parse_plan(nested, root)
            diagnostics.extend(plan_diagnostics)
            if plan is not None:
                if plan.id in plans:
                    diagnostics.append(
                        Diagnostic(
                            "error",
                            "duplicate_id",
                            f"duplicate plan ID {plan.id}",
                            plan.id,
                            repo_relative(root, nested),
                        )
                    )
                else:
                    plans[plan.id] = plan

    diagnostics.extend(validate_graph(plans))
    if deep:
        diagnostics.extend(find_nested_stores(root))
    return Store(root=root, plans=plans, diagnostics=tuple(diagnostics))


def _validate_plan_fields(plan: Plan) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    if not ID_RE.fullmatch(plan.id):
        diagnostics.append(
            Diagnostic("error", "invalid_id", "plan ID must be lowercase kebab-case", plan.id)
        )
    if plan.status not in VALID_STATUSES:
        diagnostics.append(
            Diagnostic("error", "invalid_status", "status must be active or done", plan.id)
        )
    if not plan.scope and not plan.tags:
        diagnostics.append(
            Diagnostic("error", "unroutable_plan", "at least one scope or tag is required", plan.id)
        )
    for key, values in (
        ("requires", plan.requires),
        ("replaces", plan.replaces),
        ("scope", plan.scope),
        ("tags", plan.tags),
    ):
        if any(not value.strip() for value in values):
            diagnostics.append(
                Diagnostic("error", "invalid_metadata", f"{key} contains an empty value", plan.id)
            )
        if any("\n" in value or "\r" in value for value in values):
            diagnostics.append(
                Diagnostic("error", "invalid_metadata", f"{key} values must be single-line", plan.id)
            )
        if len({value.casefold() for value in values}) != len(values):
            diagnostics.append(
                Diagnostic("error", "duplicate_metadata", f"{key} contains duplicates", plan.id)
            )
    for relation, values in (("requires", plan.requires), ("replaces", plan.replaces)):
        for value in values:
            if not ID_RE.fullmatch(value):
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "invalid_relation_id",
                        f"{relation} contains invalid plan ID {value!r}",
                        plan.id,
                    )
                )
    for pattern in plan.scope:
        if pattern.startswith("/") or "\\" in pattern or ".." in Path(pattern).parts:
            diagnostics.append(
                Diagnostic(
                    "error",
                    "invalid_scope",
                    f"scope must be repository-relative POSIX glob: {pattern!r}",
                    plan.id,
                )
            )
            continue
        try:
            compile_scope(pattern)
        except ValueError as exc:
            diagnostics.append(Diagnostic("error", "invalid_scope", str(exc), plan.id))
    return diagnostics


def validate_graph(plans: dict[str, Plan]) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    replacement_owners: dict[str, str] = {}
    for plan_id, plan in sorted(plans.items()):
        diagnostics.extend(_validate_plan_fields(plan))
        if plan_id in plan.requires:
            diagnostics.append(
                Diagnostic("error", "self_dependency", "plan may not require itself", plan_id)
            )
        for base in plan.requires:
            if base not in plans:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "dangling_requirement",
                        f"required plan does not exist: {base}",
                        plan_id,
                    )
                )
        for old_id in plan.replaces:
            if old_id == plan_id:
                diagnostics.append(
                    Diagnostic("error", "self_replacement", "plan may not replace itself", plan_id)
                )
            if old_id in plans:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "live_replacement_target",
                        f"replaces target still exists: {old_id}",
                        plan_id,
                    )
                )
            owner = replacement_owners.get(old_id)
            if owner is not None and owner != plan_id:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "duplicate_replacement",
                        f"{old_id} is already replaced by {owner}",
                        plan_id,
                    )
                )
            replacement_owners[old_id] = plan_id

    cycle = find_cycle(plans)
    if cycle:
        diagnostics.append(
            Diagnostic(
                "error",
                "cycle",
                "requires cycle detected: " + " -> ".join(cycle),
                cycle[0],
            )
        )

    for plan_id in sorted(prunable_done(plans)):
        diagnostics.append(
            Diagnostic(
                "warning",
                "prunable_done",
                "done plan is not required by any active plan; run gc",
                plan_id,
            )
        )
    for plan_id, plan in sorted(plans.items()):
        if plan.status != "done":
            continue
        unfilled = unfilled_sections(plan, GATE_SECTIONS)
        if unfilled:
            diagnostics.append(
                Diagnostic(
                    "warning",
                    "tbd_sections",
                    "done plan has unfilled sections: " + ", ".join(unfilled),
                    plan_id,
                )
            )
    return diagnostics


def find_cycle(plans: dict[str, Plan]) -> list[str]:
    white, gray, black = 0, 1, 2
    color: dict[str, int] = {}
    for root in sorted(plans):
        if color.get(root, white) != white:
            continue
        stack: list[tuple[str, int]] = [(root, 0)]
        path: list[str] = [root]
        positions = {root: 0}
        color[root] = gray
        while stack:
            node_id, index = stack[-1]
            bases = plans[node_id].requires
            if index < len(bases):
                stack[-1] = (node_id, index + 1)
                base = bases[index]
                if base not in plans:
                    continue
                state = color.get(base, white)
                if state == gray:
                    start = positions[base]
                    return path[start:] + [base]
                if state == white:
                    color[base] = gray
                    positions[base] = len(path)
                    path.append(base)
                    stack.append((base, 0))
            else:
                color[node_id] = black
                stack.pop()
                positions.pop(node_id, None)
                path.pop()
    return []


def required_closure(plans: dict[str, Plan], seeds: Iterable[str]) -> set[str]:
    closure: set[str] = set()
    stack = list(seeds)
    while stack:
        plan_id = stack.pop()
        plan = plans.get(plan_id)
        if plan is None:
            continue
        for base in plan.requires:
            if base in plans and base not in closure:
                closure.add(base)
                stack.append(base)
    return closure


def reverse_dependents(plans: dict[str, Plan], seeds: Iterable[str], *, active_only: bool) -> set[str]:
    reverse: dict[str, set[str]] = {plan_id: set() for plan_id in plans}
    for dependent, plan in plans.items():
        for base in plan.requires:
            if base in reverse:
                reverse[base].add(dependent)
    found: set[str] = set()
    visited: set[str] = set(seeds)
    stack = list(seeds)
    while stack:
        current = stack.pop()
        for dependent in sorted(reverse.get(current, ())):
            if dependent in visited:
                continue
            visited.add(dependent)
            stack.append(dependent)
            if not active_only or plans[dependent].status == "active":
                found.add(dependent)
    return found


def prunable_done(plans: dict[str, Plan]) -> set[str]:
    active = {plan_id for plan_id, plan in plans.items() if plan.status == "active"}
    retained = active | required_closure(plans, active)
    return {
        plan_id
        for plan_id, plan in plans.items()
        if plan.status == "done" and plan_id not in retained
    }


def find_nested_stores(root: Path) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    canonical = (root / PLAN_DIR).resolve(strict=False)
    skip = {
        ".git",
        ".worktrees",
        "node_modules",
        "vendor",
        ".venv",
        "venv",
        "__pycache__",
    }
    for current, dirs, files in os.walk(root):
        current_path = Path(current)
        if current_path != root and (current_path / ".git").exists():
            dirs[:] = []
            continue
        dirs[:] = [name for name in dirs if name not in skip]
        if current_path.resolve(strict=False) == canonical:
            dirs[:] = []
            continue
        if current_path.name == "plans" and current_path.parent.name == ".agents":
            diagnostics.append(
                Diagnostic(
                    "error",
                    "nested_store",
                    "only the Git-root .agents/plans store is allowed",
                    path=repo_relative(root, current_path),
                )
            )
            dirs[:] = []
        if "graph.yaml" in files and current_path.name == "plan" and current_path.parent.name == ".agents":
            candidate = current_path / "graph.yaml"
            if candidate != root / LEGACY_GRAPH:
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "nested_legacy_store",
                        "nested v1 graph is unsupported",
                        path=repo_relative(root, candidate),
                    )
                )
    return diagnostics


def git_worktree_paths(root: Path) -> list[str]:
    paths: set[str] = set()
    commands = (
        ["diff", "--name-only", "-z"],
        ["diff", "--cached", "--name-only", "-z"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )
    for args in commands:
        try:
            result = subprocess.run(
                ["git", "-C", str(root), *args],
                check=False,
                capture_output=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise PlanGraphError(f"failed to inspect Git worktree: {exc}", code="git_failed") from exc
        if result.returncode != 0:
            continue
        for raw in result.stdout.split(b"\0"):
            if raw:
                paths.add(raw.decode("utf-8", errors="replace").replace("\\", "/"))
    return sorted(paths)


def id_seen_in_git(root: Path, plan_id: str) -> bool:
    relative = (PLAN_DIR / f"{plan_id}.md").as_posix()
    indexed = _run_git(root, ["ls-files", "--error-unmatch", "--", relative])
    if indexed.returncode == 0:
        return True
    result = _run_git(root, ["log", "--all", "--format=%H", "--", relative])
    return result.returncode == 0 and bool(result.stdout.strip())


def reserved_ids(plans: dict[str, Plan]) -> set[str]:
    return set(plans) | {old for plan in plans.values() for old in plan.replaces}


def assert_new_id(root: Path, plans: dict[str, Plan], plan_id: str) -> None:
    if not ID_RE.fullmatch(plan_id):
        raise PlanGraphError("plan ID must be lowercase kebab-case", code="invalid_id")
    if plan_id in reserved_ids(plans):
        raise PlanGraphError(f"plan ID is already used or reserved: {plan_id}", code="id_reused")
    if id_seen_in_git(root, plan_id):
        raise PlanGraphError(f"plan ID appears in Git history and may not be reused: {plan_id}", code="id_reused")


def lock_path_for(root: Path) -> Path:
    result = _run_git(root, ["rev-parse", "--git-path", "plan-graph.lock"])
    if result.returncode == 0 and result.stdout.strip():
        candidate = Path(result.stdout.strip())
        return candidate if candidate.is_absolute() else root / candidate
    return root / ".plan-graph.lock"


class FileLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.token = secrets.token_hex(16)
        self.acquired = False

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"pid": os.getpid(), "token": self.token})
        for _ in range(2):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                if not self._reclaim_stale():
                    raise PlanGraphError(
                        f"plan store is locked: {self.path}", code="store_locked"
                    )
                continue
            try:
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            self.acquired = True
            return self
        raise PlanGraphError(f"plan store is locked: {self.path}", code="store_locked")

    def _reclaim_stale(self) -> bool:
        stat = None
        try:
            stat = self.path.stat()
            data = json.loads(self.path.read_text(encoding="utf-8"))
            pid = int(data.get("pid"))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pid = None
            with contextlib.suppress(OSError):
                stat = self.path.stat()
        if pid is not None:
            try:
                os.kill(pid, 0)
                return False
            except PermissionError:
                return False
            except ProcessLookupError:
                pass
        if pid is None and stat is not None and time.time() - stat.st_mtime < 30:
            return False
        with contextlib.suppress(FileNotFoundError):
            self.path.unlink()
        return True

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if not self.acquired:
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if data.get("pid") == os.getpid() and data.get("token") == self.token:
                self.path.unlink()
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass


def _assert_safe_store(root: Path) -> Path:
    agents = root / ".agents"
    directory = root / PLAN_DIR
    if agents.is_symlink() or directory.is_symlink():
        raise PlanGraphError(".agents and .agents/plans may not be symlinks", code="symlink_store")
    root_resolved = root.resolve()
    agents.mkdir(parents=True, exist_ok=True)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        directory.resolve().relative_to(root_resolved)
    except ValueError as exc:
        raise PlanGraphError("plan store resolves outside repository root", code="path_escape") from exc
    return directory


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    temp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with temp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


def apply_plan_set(root: Path, before: dict[str, Plan], after: dict[str, Plan]) -> None:
    graph_errors = [item for item in validate_graph(after) if item.severity == "error"]
    if graph_errors:
        raise PlanGraphError(graph_errors[0].message, code=graph_errors[0].code)
    if before == after:
        return
    with FileLock(lock_path_for(root)):
        current = load_store(root)
        if current.errors:
            raise PlanGraphError(current.errors[0].message, code=current.errors[0].code)
        if current.plans != before:
            raise PlanGraphError(
                "plan store changed after it was read; retry the command",
                code="concurrent_change",
            )
        directory = _assert_safe_store(root)
        before_paths = {plan.path for plan in before.values()}
        after_paths = {plan.path for plan in after.values()}
        writes = {
            plan.path: render_plan(plan).encode("utf-8")
            for plan in after.values()
            if plan.id not in before or plan != before[plan.id]
        }
        deletes = before_paths - after_paths
        touched = sorted(set(writes) | deletes, key=lambda item: item.as_posix())
        snapshots: dict[Path, bytes | None] = {}
        for path in touched:
            try:
                path.resolve(strict=False).relative_to(directory.resolve())
            except ValueError as exc:
                raise PlanGraphError(f"plan path escapes store: {path}", code="path_escape") from exc
            if path.is_symlink():
                raise PlanGraphError(f"refusing to modify symlink plan: {path}", code="symlink_plan")
            snapshots[path] = path.read_bytes() if path.exists() else None
        try:
            for path, data in sorted(writes.items(), key=lambda item: item[0].as_posix()):
                _atomic_write_bytes(path, data)
            for path in sorted(deletes, key=lambda item: item.as_posix()):
                with contextlib.suppress(FileNotFoundError):
                    path.unlink()
        except Exception as exc:
            rollback_errors: list[str] = []
            for path, original in reversed(list(snapshots.items())):
                try:
                    if original is None:
                        with contextlib.suppress(FileNotFoundError):
                            path.unlink()
                    else:
                        _atomic_write_bytes(path, original)
                except Exception as rollback_exc:  # pragma: no cover - catastrophic filesystem failure
                    rollback_errors.append(f"{path}: {rollback_exc}")
            detail = f"; rollback failed: {'; '.join(rollback_errors)}" if rollback_errors else ""
            raise PlanGraphError(f"failed to apply plan transaction: {exc}{detail}", code="write_failed") from exc
