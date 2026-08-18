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
from .util import MemoryError, memory_home, repo_key, resolve_cwd


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
            result: Any = service.review_list(_project(args), state=args.state)
        elif args.review_action == "show":
            result = service.get_memory(args.id)
        elif args.review_action == "approve":
            result = service.approve(args.id)
        else:
            result = {"removed": service.reject(args.id)}
        _emit(result, args.format)
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
        _emit(
            service.export(project=_project(args), include_global=args.include_global),
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
    review_list = review_sub.add_parser("list")
    review_list.add_argument("--cwd")
    review_list.add_argument("--state", choices=sorted(MEMORY_STATES))
    _format(review_list)
    review_list.set_defaults(func=command_review)
    for action in ("show", "approve", "reject"):
        target = review_sub.add_parser(action)
        target.add_argument("id")
        target.add_argument("--cwd")
        _format(target)
        target.set_defaults(func=command_review)

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
    _format(export)
    export.set_defaults(func=command_export)

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
