from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .constants import (
    ADOPT_SOURCES,
    BUSY_TIMEOUT_MS,
    DEFAULT_LIMIT,
    DEFAULT_TOKEN_BUDGET,
    HARNESSES,
    HOOK_BUSY_TIMEOUT_MS,
    MEMORY_KINDS,
    MEMORY_STATES,
    SCOPES,
)
from .db import Database
from .integration import integrate, integration_status
from .models import Candidate
from .providers import NullProvider, ProviderError, UnavailableProvider, provider_from_env
from .redaction import redact_text
from .retrieval import Retriever
from .service import MemoryService
from .sources import (
    build_payload,
    discover,
    group_counts,
    refine_with_provider,
    select,
)
from .util import MemoryError, expand_user_path, memory_home, repo_key, resolve_cwd


def _emit(value: Any, output_format: str = "text") -> None:
    if output_format == "json":
        print(json.dumps(value, indent=2, ensure_ascii=False))
        return
    if isinstance(value, str):
        print(value)
    elif isinstance(value, list):
        for item in value:
            print(json.dumps(item, ensure_ascii=False) if isinstance(item, (dict, list)) else item)
    elif isinstance(value, dict):
        for key, item in value.items():
            rendered = json.dumps(item, ensure_ascii=False) if isinstance(item, (dict, list)) else item
            print(f"{key}={rendered}")
    else:
        print(value)


def _format(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=("text", "json"), default="text")


def _cwd(args: argparse.Namespace) -> Path:
    return resolve_cwd(getattr(args, "cwd", None))


def _project(args: argparse.Namespace) -> str:
    return repo_key(_cwd(args))


def _statement(args: argparse.Namespace) -> str:
    value = getattr(args, "statement_option", None) or getattr(args, "statement", None) or ""
    if not value and not sys.stdin.isatty():
        value = sys.stdin.read()
    value = value.strip()
    if not value:
        raise MemoryError("memory statement is required")
    return value


def _evidence(values: Sequence[str] | None) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for value in values or []:
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                output.append(parsed)
                continue
        except json.JSONDecodeError:
            pass
        kind, separator, summary = value.partition(":")
        output.append({"kind": kind if separator else "user-statement", "summary": summary if separator else value})
    return output


def _repo_global_ceiling(cwd: Path) -> set[str] | None:
    path = cwd / ".agent-memory.json"
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    policy = value.get("global_memory") if isinstance(value, dict) else None
    if policy is False:
        return set()
    if not isinstance(policy, dict):
        return None
    allowed = set(MEMORY_KINDS)
    deny = policy.get("deny", [])
    if isinstance(deny, list):
        allowed -= {str(item) for item in deny}
    ceiling = policy.get("allow")
    if isinstance(ceiling, list):
        allowed &= {str(item) for item in ceiling}
    return allowed


def _open(
    args: argparse.Namespace, *, provider: bool = True, busy_timeout_ms: int = BUSY_TIMEOUT_MS
) -> tuple[Database, MemoryService]:
    db = Database(memory_home(getattr(args, "memory_home", None)), busy_timeout_ms=busy_timeout_ms)
    if not provider:
        selected = NullProvider()
    else:
        try:
            selected = provider_from_env()
        except ProviderError as exc:
            safe_error = redact_text(f"{type(exc).__name__}: {exc}"[:2000]).value[:1000]
            db.set_meta("last_provider_error", safe_error)
            selected = UnavailableProvider(
                os.environ.get("AGENT_MEMORY_PROVIDER", "unavailable"), safe_error
            )
    return db, MemoryService(db, selected)


def command_remember(args: argparse.Namespace) -> int:
    db, service = _open(args)
    try:
        candidate = Candidate(
            kind=args.kind,
            scope=args.scope,
            statement=_statement(args),
            conditions=args.condition or [],
            path_globs=args.path_glob or [],
            authority="explicit",
            confidence=1.0,
            evidence=_evidence(args.evidence)
            or [{"kind": "user-statement", "summary": "Explicit CLI remember request"}],
            user_approved=True,
        )
        record = service.create_memory(
            candidate,
            project=_project(args),
            explicit_override=True,
            replaces_id=args.replaces,
        )
        if record is None:
            raise MemoryError("memory was blocked by a recent forget tombstone")
        _emit(record, args.format)
        return 0
    finally:
        db.close()


def command_forget(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        removed = service.forget(
            project=_project(args),
            memory_id=args.id,
            query=args.query,
            all_projects=args.all_projects,
            allow_bulk=args.all_matches,
        )
        output = {"removed": removed, "total": len(removed), "tombstone_days": 7}
        _emit(output, args.format)
        return 0
    finally:
        db.close()


def command_recall(args: argparse.Namespace) -> int:
    db, service = _open(args)
    try:
        prompt = (args.prompt_option or args.prompt or "").strip()
        if not prompt and not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        if not prompt:
            raise MemoryError("recall prompt is required")
        cwd = _cwd(args)
        packet = Retriever(db, service.provider).recall(
            project=repo_key(cwd),
            prompt=prompt,
            harness=args.harness,
            limit=args.limit,
            token_budget=args.token_budget,
            paths=args.path or [],
            global_kind_ceiling=_repo_global_ceiling(cwd),
        )
        if args.format == "json":
            _emit(packet, "json")
        elif packet["context"]:
            print(packet["context"])
        return 0
    finally:
        db.close()


def command_review(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        if args.review_action == "list":
            result: Any = service.review_list(
                _project(args),
                state=args.state,
                batch=args.batch,
                source=args.source,
                scope=args.scope,
                kind=args.kind,
                repo=args.repo_key,
                all_projects=args.all_projects,
            )
        elif args.review_action == "show":
            result = service.get_memory(args.id)
        elif args.review_action == "approve":
            result = (
                service.resolve_batch(batch=args.batch, decision="approve", **_batch_filters(args))
                if args.batch
                else service.approve(_one_id(args))
            )
        else:
            result = (
                service.resolve_batch(batch=args.batch, decision="reject", **_batch_filters(args))
                if args.batch
                else {"removed": service.reject(_one_id(args))}
            )
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def _batch_filters(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "source": args.source,
        "scope": args.scope,
        "kind": args.kind,
        "repo": args.repo_key,
    }


def _one_id(args: argparse.Namespace) -> str:
    """Require an explicit target when no batch narrows the decision.

    Bulk resolution is reachable only through `--batch`; there is deliberately no
    bare `--all`, because rejecting is a delete and the queue is the only thing
    standing between an imported file and this store.
    """
    value = getattr(args, "id", None)
    if not value:
        raise MemoryError("a memory id is required, or --batch to resolve an import at once")
    return str(value)


def command_adopt(args: argparse.Namespace) -> int:
    home = expand_user_path(args.home).resolve() if args.home else None
    sources = discover(home=home, cwd=_cwd(args), scan_roots=[Path(item) for item in args.scan or []])
    selected = select(sources, args.source or [])

    if args.action == "list":
        _emit(
            [
                {
                    "source": item.source,
                    "path": item.label,
                    "scope": item.scope,
                    "episodic": item.episodic,
                    "repo_key": item.project,
                }
                for item in selected
            ],
            args.format,
        )
        return 0

    built = build_payload(selected, include_episodic=args.include_episodic)
    db, service = _open(args, provider=args.llm)
    try:
        if args.llm:
            built["payload"]["memories"] = refine_with_provider(
                service.provider, built["payload"]["memories"]
            )
            built["groups"] = group_counts(built["payload"]["memories"])
        report = service.import_records(
            built["payload"], project=None, trust=False, scope="all", dry_run=args.dry_run
        )
        # Records the converter refused never reached the store, but they are the
        # same kind of outcome as the ones it refused, and a reviewer comparing a
        # dry run against a real run should see one list, not two.
        report["skipped"] = built["skipped"] + report["skipped"]
        report["read"] = built["read"]
        report["groups"] = built["groups"]
        _emit(report, args.format)
        return 0
    finally:
        db.close()


def command_policy(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        project = _project(args)
        if args.trust_action == "list":
            result: Any = service.trust_list(None if args.all_projects else project)
        elif args.trust_action == "grant":
            kinds = list(MEMORY_KINDS) if args.all_kinds else args.kind
            if not kinds:
                raise MemoryError("trust grant requires --kind or --all-kinds")
            service.trust_grant(project, kinds)
            result = {"repo_key": project, "granted": sorted(kinds)}
        else:
            kinds = None if args.all_kinds or not args.kind else args.kind
            result = {"repo_key": project, "revoked": service.trust_revoke(project, kinds)}
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def command_session(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        result = service.session_control(
            args.session_action,
            harness=args.harness,
            project=_project(args),
            session_id=args.id,
        )
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def command_feedback(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        result = service.feedback(
            args.query_id, args.memory_id, used=args.used, outcome=args.outcome
        )
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def command_export(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        # A global-only export must not need a repository to stand in.
        project = None if args.scope in {"global", "all"} else _project(args)
        _emit(
            service.export(
                project=project, include_global=args.include_global, scope=args.scope
            ),
            args.format,
        )
        return 0
    finally:
        db.close()


def command_import(args: argparse.Namespace) -> int:
    raw = Path(args.file).read_text(encoding="utf-8") if args.file else sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MemoryError(f"export payload is not valid JSON: {exc}") from exc
    db, service = _open(args, provider=False)
    try:
        _emit(
            service.import_records(
                payload,
                project=_project(args) if args.cwd else None,
                trust=args.trust,
                scope=args.scope,
                dry_run=args.dry_run,
            ),
            args.format,
        )
        return 0
    finally:
        db.close()


def command_gc(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        _emit(service.gc(), args.format)
        return 0
    finally:
        db.close()


def _provider_status() -> dict[str, Any]:
    try:
        return provider_from_env().status()
    except ProviderError as exc:
        return {"name": os.environ.get("AGENT_MEMORY_PROVIDER", "off"), "configured": False, "error": str(exc)}


def command_doctor(args: argparse.Namespace) -> int:
    db, service = _open(args, provider=False)
    try:
        counts = {
            row["state"]: row["count"]
            for row in db.conn.execute("SELECT state,count(*) AS count FROM jobs GROUP BY state")
        }
        memories = {
            row["state"]: row["count"]
            for row in db.conn.execute("SELECT state,count(*) AS count FROM memories GROUP BY state")
        }
        v1_paths = [
            db.home / ".index" / "memory.sqlite3",
            db.home / "global" / "MEMORY.md",
            db.home / "projects",
        ]
        output = {
            "healthy": db.integrity() == "ok",
            "version": __version__,
            "database": {
                "path": str(db.path),
                "integrity": db.integrity(),
                "schema_version": db.get_meta("schema_version"),
                "wal": db.conn.execute("PRAGMA journal_mode").fetchone()[0],
            },
            "retrieval": {
                "fts5": db.fts5,
                "trigram": db.trigram,
                "sqlite_vec": db.vector,
                "last_embedding_error": db.get_meta("last_embedding_error"),
                "embeddings": {
                    "stored": db.conn.execute(
                        "SELECT count(*) FROM memory_embeddings"
                    ).fetchone()[0],
                    "active_missing": db.conn.execute(
                        "SELECT count(*) FROM memories AS m "
                        "LEFT JOIN memory_embeddings AS e ON e.memory_id=m.id "
                        "WHERE m.state IN ('active','provisional') AND e.memory_id IS NULL"
                    ).fetchone()[0],
                    "models": [
                        row[0]
                        for row in db.conn.execute(
                            "SELECT DISTINCT model FROM memory_embeddings ORDER BY model"
                        )
                    ],
                },
            },
            "provider": _provider_status(),
            "last_provider_error": db.get_meta("last_provider_error"),
            "queue": counts,
            "memories": memories,
            "trust": service.trust_list(),
            "integrations": integration_status(),
            "v1_artifacts": [str(path) for path in v1_paths if path.exists()],
        }
        _emit(output, args.format)
        return 0 if output["healthy"] else 1
    finally:
        db.close()


def _read_hook_input(args: argparse.Namespace) -> dict[str, Any]:
    raw = Path(args.input).read_text(encoding="utf-8") if args.input else sys.stdin.read()
    if not raw.strip():
        return {}
    value = json.loads(raw)
    return value if isinstance(value, dict) else {}


def _launch_worker(args: argparse.Namespace) -> None:
    if os.environ.get("AGENT_MEMORY_SYNC_WORKER") in {"1", "true", "yes"}:
        db, service = _open(args)
        try:
            service.worker_once()
        finally:
            db.close()
        return
    command = [sys.executable, str(Path(__file__).resolve().parents[1] / "memory.py")]
    if args.memory_home:
        command.extend(["--memory-home", args.memory_home])
    command.extend(["worker", "--once"])
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(command, **kwargs)


def command_hook(args: argparse.Namespace) -> int:
    # Hooks are a fail-open isolation boundary. Never block a host prompt.
    try:
        data = _read_hook_input(args)
        event_name = args.event or str(data.get("hook_event_name") or data.get("event") or "")
        kind = MemoryService.normalize_hook_kind(event_name)
        cwd = resolve_cwd(str(data.get("cwd") or args.cwd or os.getcwd()))
        # A hook blocks the host's prompt loop, so it waits on the shared store's
        # write lock for a bounded moment and then gives up — see
        # HOOK_BUSY_TIMEOUT_MS. The `except` below already turns that into a
        # silent, empty result, which is the right failure for a hook.
        db, service = _open(args, busy_timeout_ms=HOOK_BUSY_TIMEOUT_MS)
        try:
            capture = service.capture_event(
                harness=args.harness, kind=kind, data=data, cwd=cwd
            )
            if kind == "user_prompt" and not capture.get("paused"):
                prompt = str(data.get("prompt") or data.get("user_prompt") or data.get("message") or "")
                if isinstance(data.get("message"), dict):
                    prompt = str(data["message"].get("content") or data["message"].get("text") or prompt)
                packet = Retriever(db, service.provider).recall(
                    project=repo_key(cwd),
                    prompt=prompt,
                    harness=args.harness,
                    global_kind_ceiling=_repo_global_ceiling(cwd),
                    exclude_ids=set(capture.get("immediate_memories") or []),
                )
                context = packet["context"]
                if context:
                    print(
                        json.dumps(
                            {
                                "hookSpecificOutput": {
                                    "hookEventName": "UserPromptSubmit",
                                    "additionalContext": context,
                                },
                                "context": context,
                                "query_id": packet["query_id"],
                                "visibility": packet["visibility"],
                            },
                            ensure_ascii=False,
                        )
                    )
                else:
                    print("{}")
            else:
                print("{}")
        finally:
            db.close()
        if kind in {"assistant_stop", "session_end"} and capture.get("captured"):
            _launch_worker(args)
    except Exception:
        print("{}")
    return 0


def command_worker(args: argparse.Namespace) -> int:
    db, service = _open(args)
    try:
        result = service.worker_once(max_jobs=args.max_jobs)
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def command_integrate(args: argparse.Namespace) -> int:
    result = integrate(
        memory_home=memory_home(args.memory_home),
        mode=args.mode,
        harness=args.harness,
        apply=args.apply,
        disable_known_conflicts=args.disable_known_conflicts,
    )
    _emit(result, args.format)
    return 0


def command_repo_key(args: argparse.Namespace) -> int:
    _emit({"repo_key": _project(args)}, args.format)
    return 0


def command_reindex(args: argparse.Namespace) -> int:
    db, _ = _open(args, provider=False)
    try:
        result = {"records": db.rebuild_indexes(), "fts5": db.fts5, "trigram": db.trigram}
        _emit(result, args.format)
        return 0
    finally:
        db.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evidence-aware local memory shared by coding agents"
    )
    parser.add_argument("--memory-home", help="Override AGENT_MEMORY_HOME")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    remember = sub.add_parser("remember", help="Store an explicit durable memory immediately")
    remember.add_argument("statement", nargs="?")
    remember.add_argument("--statement", dest="statement_option")
    remember.add_argument("--cwd")
    remember.add_argument("--kind", choices=sorted(MEMORY_KINDS), default="preference")
    remember.add_argument("--scope", choices=sorted(SCOPES), default="project")
    remember.add_argument("--condition", action="append")
    remember.add_argument("--path-glob", action="append")
    remember.add_argument("--evidence", action="append", help="JSON object or kind:summary")
    remember.add_argument("--replaces", help="Explicitly supersede this memory id")
    _format(remember)
    remember.set_defaults(func=command_remember)

    forget = sub.add_parser("forget", help="Hard-delete memory and add a contentless 7-day tombstone")
    forget.add_argument("query", nargs="?")
    forget.add_argument("--id")
    forget.add_argument("--cwd")
    forget.add_argument("--all-projects", action="store_true")
    forget.add_argument(
        "--all-matches",
        action="store_true",
        help="Confirm deleting more than five query matches at once",
    )
    _format(forget)
    forget.set_defaults(func=command_forget)

    recall = sub.add_parser("recall", help="Build a bounded prompt-relevant memory packet")
    recall.add_argument("prompt", nargs="?")
    recall.add_argument("--prompt", dest="prompt_option")
    recall.add_argument("--cwd")
    recall.add_argument("--harness", choices=sorted(HARNESSES), default="generic")
    recall.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    recall.add_argument("--token-budget", type=int, default=DEFAULT_TOKEN_BUDGET)
    recall.add_argument("--path", action="append")
    _format(recall)
    recall.set_defaults(func=command_recall)

    review = sub.add_parser("review", help="Inspect and resolve provisional or disputed memory")
    review_sub = review.add_subparsers(dest="review_action", required=True)

    def _review_filters(target: argparse.ArgumentParser) -> None:
        target.add_argument("--batch", help="Import batch token from an adopt/import report")
        target.add_argument("--source", choices=sorted(ADOPT_SOURCES))
        target.add_argument("--scope", choices=sorted(SCOPES))
        target.add_argument("--kind", choices=sorted(MEMORY_KINDS))
        target.add_argument("--repo-key", help="Narrow to one repository, as the report names it")

    review_list = review_sub.add_parser("list")
    review_list.add_argument("--cwd")
    review_list.add_argument("--state", choices=sorted(MEMORY_STATES))
    review_list.add_argument("--all-projects", action="store_true")
    _review_filters(review_list)
    _format(review_list)
    review_list.set_defaults(func=command_review)

    show = review_sub.add_parser("show")
    show.add_argument("id")
    show.add_argument("--cwd")
    _format(show)
    show.set_defaults(
        func=command_review, batch=None, source=None, scope=None, kind=None, repo_key=None
    )

    for action in ("approve", "reject"):
        target = review_sub.add_parser(action)
        # Optional so `--batch` can stand in for it; `_one_id` refuses the case
        # where neither is given rather than letting a bare command act on
        # everything in the queue.
        target.add_argument("id", nargs="?")
        target.add_argument("--cwd")
        _review_filters(target)
        _format(target)
        target.set_defaults(func=command_review)

    adopt = sub.add_parser(
        "adopt", help="Read another agent's memory files into this store for review"
    )
    adopt.add_argument("action", nargs="?", choices=("run", "list"), default="run")
    adopt.add_argument(
        "--source", action="append", choices=[*sorted(ADOPT_SOURCES), "all"],
        help="Repeatable; default all",
    )
    adopt.add_argument("--cwd", help="Repository whose project-scoped files are read")
    adopt.add_argument("--scan", action="append", help="Additional repository root, repeatable")
    adopt.add_argument("--home", help="Override the home directory the global files are read from")
    adopt.add_argument("--llm", action="store_true", help="Let the provider classify and restate")
    adopt.add_argument(
        "--include-episodic",
        action="store_true",
        help="Also read session narrative that records what happened, not what to do",
    )
    adopt.add_argument("--dry-run", action="store_true")
    _format(adopt)
    adopt.set_defaults(func=command_adopt)

    policy = sub.add_parser("policy", help="Manage cross-scope policy")
    policy_sub = policy.add_subparsers(dest="policy_area", required=True)
    trust = policy_sub.add_parser("trust", help="Grant global memory by repo and kind")
    trust_sub = trust.add_subparsers(dest="trust_action", required=True)
    for action in ("grant", "revoke", "list"):
        target = trust_sub.add_parser(action)
        target.add_argument("--cwd")
        target.add_argument("--kind", action="append", choices=sorted(MEMORY_KINDS))
        target.add_argument("--all-kinds", action="store_true")
        target.add_argument("--all-projects", action="store_true")
        _format(target)
        target.set_defaults(func=command_policy)

    session = sub.add_parser("session", help="Pause or resume automatic observation")
    session_sub = session.add_subparsers(dest="session_action", required=True)
    for action in ("pause", "resume", "status"):
        target = session_sub.add_parser(action)
        target.add_argument("--id", help="Harness session id; default applies to this repo/harness")
        target.add_argument("--harness", choices=sorted(HARNESSES), default="generic")
        target.add_argument("--cwd")
        _format(target)
        target.set_defaults(func=command_session)

    feedback = sub.add_parser("feedback", help="Record whether exposed memory actually influenced work")
    feedback.add_argument("query_id")
    feedback.add_argument("memory_id")
    used = feedback.add_mutually_exclusive_group(required=True)
    used.add_argument("--used", action="store_true", dest="used")
    used.add_argument("--unused", action="store_false", dest="used")
    feedback.add_argument("--outcome")
    _format(feedback)
    feedback.set_defaults(func=command_feedback)

    export = sub.add_parser("export", help="Export structured memory without raw events")
    export.add_argument("--cwd")
    export.add_argument("--include-global", action="store_true")
    export.add_argument("--scope", choices=("global", "project", "all"))
    _format(export)
    export.set_defaults(func=command_export)

    importer = sub.add_parser("import", help="Replay an export into this store, adding and merging only")
    importer.add_argument("file", nargs="?", help="Export file; stdin when omitted")
    importer.add_argument("--cwd", help="Adopt project-scoped records into this repository")
    importer.add_argument("--scope", choices=("global", "project", "all"), default="all")
    importer.add_argument(
        "--trust",
        action="store_true",
        help="Restore the exported state instead of queueing everything for review",
    )
    importer.add_argument("--dry-run", action="store_true")
    _format(importer)
    importer.set_defaults(func=command_import)

    gc = sub.add_parser("gc", help="Apply TTLs and compact lifecycle metadata")
    _format(gc)
    gc.set_defaults(func=command_gc)

    doctor = sub.add_parser("doctor", help="Check DB, provider, retrieval, queue, hooks, and trust")
    _format(doctor)
    doctor.set_defaults(func=command_doctor)

    hook = sub.add_parser("hook", help="Process a fail-open host hook event")
    hook.add_argument("--harness", choices=sorted(HARNESSES), required=True)
    hook.add_argument("--event")
    hook.add_argument("--cwd")
    hook.add_argument("--input")
    hook.set_defaults(func=command_hook)

    worker = sub.add_parser("worker", help="Process queued extraction and reconciliation jobs")
    worker.add_argument("--once", action="store_true", required=True)
    worker.add_argument("--max-jobs", type=int, default=8)
    _format(worker)
    worker.set_defaults(func=command_worker)

    integration = sub.add_parser("integrate", help="Install, inspect, or remove harness adapters")
    integration.add_argument("--mode", choices=("shadow", "primary", "off"), required=True)
    integration.add_argument("--harness", choices=("all", "claude", "codex", "opencode"), default="all")
    integration.add_argument("--disable-known-conflicts", action="store_true")
    integration.add_argument("--apply", action="store_true")
    _format(integration)
    integration.set_defaults(func=command_integrate)

    key = sub.add_parser("repo-key", help="Print the privacy-preserving repository key")
    key.add_argument("--cwd")
    _format(key)
    key.set_defaults(func=command_repo_key)

    reindex = sub.add_parser("reindex", help="Rebuild local retrieval indexes")
    _format(reindex)
    reindex.set_defaults(func=command_reindex)
    return parser


def _force_utf8_streams() -> None:
    """Emit UTF-8 regardless of the console codepage.

    Python picks the *locale* encoding for a redirected stdout on Windows — cp949, cp1252
    — while everything written here is `ensure_ascii=False`. A memory recalled in Korean
    then reaches the caller as mojibake, and a caller reading it with
    `subprocess.run(..., encoding="utf-8")` gets `stdout=None`: the decode error dies in
    a reader thread and is reported as no output at all.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            # A stream we did not open and cannot reconfigure; leave it alone.
            pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_streams()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (MemoryError, ProviderError, OSError, sqlite3.Error, ValueError) as exc:
        print(f"ERROR={exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR=interrupted", file=sys.stderr)
        return 130
