from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Iterable

from .model import Diagnostic, Plan, PlanGraphError, make_plan, plan_path, replace_title
from .routing import build_context, build_status
from .store import (
    Store,
    apply_plan_set,
    assert_new_id,
    discover_root,
    git_worktree_paths,
    load_store,
    prunable_done,
    required_closure,
    validate_graph,
)


def _common_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", type=Path, help="repository root (default: Git toplevel)")
    parser.add_argument("--json", action="store_true", help="emit one JSON result object")
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="plan-graph.py",
        description="Route and maintain repository-local persistent plan context.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    common = _common_parser()

    context = subparsers.add_parser("context", parents=[common], help="build a compact decision pack")
    context.add_argument("--plan", action="append", default=[], help="explicit seed plan ID")
    context.add_argument("--path", action="append", default=[], help="repository path to route")
    context.add_argument("--query", default="", help="natural-language routing query")
    context.add_argument(
        "--worktree",
        action="store_true",
        help="include staged, unstaged, and untracked Git paths with explicit selectors",
    )

    subparsers.add_parser("status", parents=[common], help="show ready, waiting, and retained plans")
    subparsers.add_parser("doctor", parents=[common], help="validate the store and find nested stores")

    create = subparsers.add_parser("create", parents=[common], help="create a plan template")
    create.add_argument("id")
    create.add_argument("--title", required=True)
    _add_fresh_metadata_args(create)
    _add_dry_run(create)

    update = subparsers.add_parser("update", parents=[common], help="update plan metadata or title")
    update.add_argument("id")
    update.add_argument("--title")
    for flag in ("require", "replace", "scope", "tag"):
        update.add_argument(f"--add-{flag}", action="append", default=[])
        update.add_argument(f"--remove-{flag}", action="append", default=[])
    _add_dry_run(update)

    rename = subparsers.add_parser("rename", parents=[common], help="rename an ID and its references")
    rename.add_argument("old")
    rename.add_argument("new")
    rename.add_argument("--title")
    _add_dry_run(rename)

    replace_cmd = subparsers.add_parser(
        "replace", parents=[common], help="replace one plan with a fresh independent plan"
    )
    replace_cmd.add_argument("old")
    replace_cmd.add_argument("new")
    replace_cmd.add_argument("--title", required=True)
    _add_fresh_metadata_args(replace_cmd)
    _add_dry_run(replace_cmd)

    for name, help_text in (
        ("reopen", "mark a retained done plan active again"),
        ("close", "mark a plan done and prune the closed tree"),
        ("drop", "delete an unneeded plan and prune orphaned done plans"),
    ):
        command = subparsers.add_parser(name, parents=[common], help=help_text)
        command.add_argument("id")
        _add_dry_run(command)

    gc = subparsers.add_parser("gc", parents=[common], help="prune done plans not needed by active plans")
    _add_dry_run(gc)
    return parser


def _add_fresh_metadata_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--scope", action="append", default=[])
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--require", action="append", default=[])


def _add_dry_run(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dry-run", action="store_true", help="show changes without writing")


def _diagnostic_text(item: Diagnostic) -> str:
    subject = f" [{item.plan}]" if item.plan else ""
    location = f" ({item.path})" if item.path else ""
    return f"{item.severity.upper()} {item.code}{subject}: {item.message}{location}"


def _emit(
    *,
    ok: bool,
    command: str,
    root: Path | None,
    data: dict[str, object] | None = None,
    diagnostics: Iterable[Diagnostic] = (),
    changes: Iterable[dict[str, object]] = (),
    json_mode: bool,
) -> int:
    diagnostic_list = list(diagnostics)
    change_list = list(changes)
    payload = {
        "ok": ok,
        "command": command,
        "root": str(root) if root is not None else None,
        "data": data or {},
        "diagnostics": [item.as_dict() for item in diagnostic_list],
        "changes": change_list,
    }
    if json_mode:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for item in diagnostic_list:
            print(_diagnostic_text(item), file=sys.stderr if item.severity == "error" else sys.stdout)
        if ok:
            if command == "context":
                _print_context(data or {})
            elif command == "status":
                _print_status(data or {})
            elif command == "doctor":
                counts = (data or {}).get("counts", {})
                print(f"OK plan store ({counts.get('plans', 0)} plans)")
            else:
                prefix = "DRY-RUN" if (data or {}).get("dry_run") else "OK"
                print(f"{prefix} {command}")
                for change in change_list:
                    target = change.get("plan") or change.get("from") or ""
                    detail = f" -> {change['to']}" if "to" in change else ""
                    print(f"  {change['action']}: {target}{detail}")
        elif not diagnostic_list:
            print(f"ERROR {command} failed", file=sys.stderr)
    return 0 if ok else 1


def _print_context(data: dict[str, object]) -> None:
    selected = data.get("selected", [])
    required = data.get("required", [])
    affected = data.get("affected", [])
    print("Plan Context")
    print("  Selected: " + (", ".join(selected) if selected else "none"))
    print("  Required: " + (", ".join(required) if required else "none"))
    print("  Affected: " + (", ".join(affected) if affected else "none"))
    read_order = data.get("read_order", [])
    if read_order:
        print("  Read order: " + " -> ".join(read_order))
    for item in data.get("decision_pack", []):
        print(f"\n[{item['role']}] {item['id']} — {item['title']}")
        if item.get("matched_by"):
            print("Matched: " + "; ".join(item["matched_by"]))
        print("Outcome:\n" + str(item.get("outcome", "")))
        print("Decisions:\n" + str(item.get("decisions", "")))
        print("Acceptance:\n" + str(item.get("acceptance", "")))
    candidates = data.get("candidates", [])
    if candidates:
        print("\nNo plan matched; active candidates:")
        for item in candidates:
            print(f"  - {item['id']} ({item['readiness']}): {item['title']}")
    elif not selected:
        print("\nNo active plans matched.")


def _print_status(data: dict[str, object]) -> None:
    print("Plan Status")
    for key, label in (("ready", "Ready"), ("waiting", "Waiting"), ("retained_done", "Retained done")):
        items = data.get(key, [])
        print(f"\n{label}:")
        if not items:
            print("  none")
        for item in items:
            suffix = f"; blockers={','.join(item['blockers'])}" if item.get("blockers") else ""
            print(f"  - {item['id']}: {item['title']}{suffix}")
    path = data.get("critical_path", [])
    if path:
        print("\nCritical path: " + " -> ".join(path))


def _error_diagnostic(exc: Exception) -> Diagnostic:
    if isinstance(exc, PlanGraphError):
        return Diagnostic("error", exc.code, str(exc))
    return Diagnostic("error", "io_error", str(exc))


def _load_valid(root: Path, *, deep: bool = False) -> Store:
    store = load_store(root, deep=deep)
    if store.errors:
        raise PlanGraphError(store.errors[0].message, code=store.errors[0].code)
    return store


def _normalize_paths(root: Path, values: Iterable[str]) -> list[str]:
    normalized: list[str] = []
    for value in values:
        candidate = Path(value)
        if candidate.is_absolute():
            try:
                relative = candidate.resolve(strict=False).relative_to(root.resolve())
            except ValueError as exc:
                raise PlanGraphError(f"routing path is outside repository root: {value}", code="path_escape") from exc
            path = relative.as_posix()
        else:
            pure = PurePosixPath(value.replace("\\", "/"))
            if ".." in pure.parts:
                raise PlanGraphError(f"routing path escapes repository root: {value}", code="path_escape")
            path = pure.as_posix()
            while path.startswith("./"):
                path = path[2:]
        if path and path != "." and path not in normalized:
            normalized.append(path)
    return normalized


def _apply_list_changes(
    current: tuple[str, ...], additions: Iterable[str], removals: Iterable[str]
) -> tuple[str, ...]:
    remove_set = set(removals)
    values = [value for value in current if value not in remove_set]
    for value in additions:
        if value not in values:
            values.append(value)
    return tuple(values)


def _validated_title(value: str) -> str:
    title = value.strip()
    if not title or "\n" in title or "\r" in title:
        raise PlanGraphError("title must be one non-empty line", code="invalid_title")
    return title


def _active_dependents(plans: dict[str, Plan], target: str) -> list[str]:
    return sorted(
        plan_id
        for plan_id, plan in plans.items()
        if plan.status == "active" and target in required_closure(plans, [plan_id])
    )


def _finish_mutation(
    *,
    command: str,
    root: Path,
    before: dict[str, Plan],
    after: dict[str, Plan],
    changes: list[dict[str, object]],
    dry_run: bool,
    json_mode: bool,
) -> int:
    errors = [item for item in validate_graph(after) if item.severity == "error"]
    if errors:
        return _emit(
            ok=False,
            command=command,
            root=root,
            diagnostics=errors,
            changes=changes,
            json_mode=json_mode,
        )
    if not dry_run:
        apply_plan_set(root, before, after)
    diagnostics = [item for item in validate_graph(after) if item.severity == "warning"]
    return _emit(
        ok=True,
        command=command,
        root=root,
        data={"dry_run": dry_run},
        diagnostics=diagnostics,
        changes=changes,
        json_mode=json_mode,
    )


def _handle_context(args: argparse.Namespace, root: Path, store: Store) -> int:
    unknown = sorted(set(args.plan) - set(store.plans))
    if unknown:
        raise PlanGraphError("unknown plan IDs: " + ", ".join(unknown), code="unknown_plan")
    selectors_given = bool(args.plan or args.path or args.query.strip())
    paths = _normalize_paths(root, args.path)
    if args.worktree or not selectors_given:
        paths = list(dict.fromkeys([*paths, *git_worktree_paths(root)]))
    data = build_context(
        root,
        store.plans,
        explicit_plans=args.plan,
        paths=paths,
        query=args.query,
    )
    return _emit(
        ok=True,
        command="context",
        root=root,
        data=data,
        diagnostics=store.warnings,
        json_mode=args.json,
    )


def _handle_create(args: argparse.Namespace, root: Path, store: Store) -> int:
    assert_new_id(root, store.plans, args.id)
    title = _validated_title(args.title)
    unknown = sorted(set(args.require) - set(store.plans))
    if unknown:
        raise PlanGraphError("unknown required plans: " + ", ".join(unknown), code="unknown_plan")
    plan = make_plan(
        root=root,
        plan_id=args.id,
        title=title,
        requires=args.require,
        scope=args.scope,
        tags=args.tag,
    )
    after = {**store.plans, args.id: plan}
    return _finish_mutation(
        command="create",
        root=root,
        before=store.plans,
        after=after,
        changes=[{"action": "create", "plan": args.id, "path": plan.path.relative_to(root).as_posix()}],
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _require_plan(store: Store, plan_id: str) -> Plan:
    try:
        return store.plans[plan_id]
    except KeyError as exc:
        raise PlanGraphError(f"unknown plan ID: {plan_id}", code="unknown_plan") from exc


def _handle_update(args: argparse.Namespace, root: Path, store: Store) -> int:
    plan = _require_plan(store, args.id)
    updated = plan
    if args.title is not None:
        updated = replace_title(updated, _validated_title(args.title))
    mappings = (
        ("requires", args.add_require, args.remove_require),
        ("replaces", args.add_replace, args.remove_replace),
        ("scope", args.add_scope, args.remove_scope),
        ("tags", args.add_tag, args.remove_tag),
    )
    for field, additions, removals in mappings:
        updated = replace(
            updated,
            **{field: _apply_list_changes(getattr(updated, field), additions, removals)},
        )
    if updated == plan:
        raise PlanGraphError("update contains no effective changes", code="no_changes")
    after = {**store.plans, args.id: updated}
    return _finish_mutation(
        command="update",
        root=root,
        before=store.plans,
        after=after,
        changes=[{"action": "update", "plan": args.id}],
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_rename(args: argparse.Namespace, root: Path, store: Store) -> int:
    original = _require_plan(store, args.old)
    assert_new_id(root, store.plans, args.new)
    renamed = replace(original, id=args.new, path=plan_path(root, args.new))
    if args.title is not None:
        renamed = replace_title(renamed, _validated_title(args.title))
    after = {plan_id: plan for plan_id, plan in store.plans.items() if plan_id != args.old}
    after[args.new] = renamed
    relinked: list[str] = []
    for plan_id, plan in list(after.items()):
        if args.old in plan.requires:
            after[plan_id] = replace(
                plan,
                requires=tuple(args.new if base == args.old else base for base in plan.requires),
            )
            relinked.append(plan_id)
    changes: list[dict[str, object]] = [
        {"action": "rename", "from": args.old, "to": args.new}
    ]
    changes.extend({"action": "relink", "plan": plan_id} for plan_id in sorted(relinked))
    return _finish_mutation(
        command="rename",
        root=root,
        before=store.plans,
        after=after,
        changes=changes,
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_replace(args: argparse.Namespace, root: Path, store: Store) -> int:
    _require_plan(store, args.old)
    title = _validated_title(args.title)
    dependents = _active_dependents(store.plans, args.old)
    if dependents:
        raise PlanGraphError(
            f"cannot replace {args.old}; active dependents require review: {', '.join(dependents)}",
            code="active_dependents",
        )
    assert_new_id(root, store.plans, args.new)
    unknown = sorted(set(args.require) - (set(store.plans) - {args.old}))
    if unknown:
        raise PlanGraphError("unknown required plans: " + ", ".join(unknown), code="unknown_plan")
    replacement = make_plan(
        root=root,
        plan_id=args.new,
        title=title,
        requires=args.require,
        replaces=[args.old],
        scope=args.scope,
        tags=args.tag,
    )
    after = {plan_id: plan for plan_id, plan in store.plans.items() if plan_id != args.old}
    after[args.new] = replacement
    pruned = sorted(prunable_done(after))
    for plan_id in pruned:
        after.pop(plan_id)
    changes: list[dict[str, object]] = [
        {"action": "replace", "from": args.old, "to": args.new}
    ]
    changes.extend({"action": "prune", "plan": plan_id} for plan_id in pruned)
    return _finish_mutation(
        command="replace",
        root=root,
        before=store.plans,
        after=after,
        changes=changes,
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_reopen(args: argparse.Namespace, root: Path, store: Store) -> int:
    plan = _require_plan(store, args.id)
    if plan.status == "active":
        raise PlanGraphError(f"{args.id} is already active", code="no_changes")
    after = {**store.plans, args.id: replace(plan, status="active")}
    return _finish_mutation(
        command="reopen",
        root=root,
        before=store.plans,
        after=after,
        changes=[{"action": "reopen", "plan": args.id}],
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_close(args: argparse.Namespace, root: Path, store: Store) -> int:
    plan = _require_plan(store, args.id)
    after = {**store.plans, args.id: replace(plan, status="done")}
    pruned = sorted(prunable_done(after))
    for plan_id in pruned:
        after.pop(plan_id)
    changes: list[dict[str, object]] = [{"action": "close", "plan": args.id}]
    changes.extend({"action": "prune", "plan": plan_id} for plan_id in pruned)
    return _finish_mutation(
        command="close",
        root=root,
        before=store.plans,
        after=after,
        changes=changes,
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_drop(args: argparse.Namespace, root: Path, store: Store) -> int:
    _require_plan(store, args.id)
    dependents = _active_dependents(store.plans, args.id)
    if dependents:
        raise PlanGraphError(
            f"cannot drop {args.id}; active dependents: {', '.join(dependents)}",
            code="active_dependents",
        )
    after = {plan_id: plan for plan_id, plan in store.plans.items() if plan_id != args.id}
    pruned = sorted(prunable_done(after))
    for plan_id in pruned:
        after.pop(plan_id)
    changes: list[dict[str, object]] = [{"action": "drop", "plan": args.id}]
    changes.extend({"action": "prune", "plan": plan_id} for plan_id in pruned)
    return _finish_mutation(
        command="drop",
        root=root,
        before=store.plans,
        after=after,
        changes=changes,
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def _handle_gc(args: argparse.Namespace, root: Path, store: Store) -> int:
    pruned = sorted(prunable_done(store.plans))
    after = {plan_id: plan for plan_id, plan in store.plans.items() if plan_id not in pruned}
    return _finish_mutation(
        command="gc",
        root=root,
        before=store.plans,
        after=after,
        changes=[{"action": "prune", "plan": plan_id} for plan_id in pruned],
        dry_run=args.dry_run,
        json_mode=args.json,
    )


def run(args: argparse.Namespace) -> int:
    root = discover_root(args.root)
    if args.command == "doctor":
        store = load_store(root, deep=True)
        return _emit(
            ok=not store.errors,
            command="doctor",
            root=root,
            data={
                "counts": {
                    "plans": len(store.plans),
                    "active": sum(plan.status == "active" for plan in store.plans.values()),
                    "done": sum(plan.status == "done" for plan in store.plans.values()),
                }
            },
            diagnostics=store.diagnostics,
            json_mode=args.json,
        )

    store = _load_valid(root)
    if args.command == "context":
        return _handle_context(args, root, store)
    if args.command == "status":
        return _emit(
            ok=True,
            command="status",
            root=root,
            data=build_status(root, store.plans),
            diagnostics=store.warnings,
            json_mode=args.json,
        )
    handlers = {
        "create": _handle_create,
        "update": _handle_update,
        "rename": _handle_rename,
        "replace": _handle_replace,
        "reopen": _handle_reopen,
        "close": _handle_close,
        "drop": _handle_drop,
        "gc": _handle_gc,
    }
    return handlers[args.command](args, root, store)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except Exception as exc:
        return _emit(
            ok=False,
            command=args.command,
            root=args.root.absolute() if args.root else None,
            diagnostics=[_error_diagnostic(exc)],
            json_mode=args.json,
        )
