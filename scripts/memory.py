#!/usr/bin/env python3
"""Local-file helper for the agent-memory skill."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import random
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


TYPES = {"preference", "project-fact", "decision", "command", "caveat", "handoff"}
SCOPES = {"global", "project"}
PRIORITIES = {"explicit", "auto"}
SOURCES = {"user", "repo", "command", "session", "claude", "codex", "opencode", "remember"}
CONFIDENCES = {"high", "medium", "low"}
PROMOTABLE_AUTO_TYPES = {"project-fact", "command", "caveat"}
PROMOTABLE_EVIDENCE_KINDS = {"command", "repo-file", "test-result"}
SUMMARY_MAX = 240
MEMORY_MAX_LINES = 120
INBOX_MAX_FILES = 500
TOPIC_SUPPORT_FILENAMES = {"index.md", "log.md"}
RECORD_TOPIC_TYPE = "AgentMemoryRecord"
INDEX_SCHEMA_VERSION = 1
RECALL_CONTEXT_MAX_BYTES = 6144
DEFAULT_RECALL_RESULTS = 40

SENSITIVE_PATTERNS = [
    re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    re.compile(r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{8,}", re.I),
]


class MemoryStoreError(Exception):
    pass


def non_negative_int(value: str) -> int:
    """Parse an integer CLI value that must not be negative."""
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a non-negative integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def calendar_date(value: str) -> str:
    """Parse a real calendar date in the exact YYYY-MM-DD wire format."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise argparse.ArgumentTypeError("must be a real date in YYYY-MM-DD format")
    try:
        dt.date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a real date in YYYY-MM-DD format") from exc
    return value


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def memory_home(args: argparse.Namespace) -> Path:
    raw = getattr(args, "memory_home", None) or os.environ.get("AGENT_MEMORY_HOME")
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".agents" / "memory").resolve()


def cwd_from_args(args: argparse.Namespace) -> Path:
    return Path(getattr(args, "cwd", None) or os.getcwd()).expanduser().resolve()


def run_git(cwd: Path, *git_args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *git_args],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "memory"


def strip_dot_git(path: str) -> str:
    path = path.rstrip("/")
    if path.lower().endswith(".git"):
        path = path[:-4]
    return path.rstrip("/")


def normalize_remote_url(url: str) -> tuple[str, str]:
    raw = url.strip().rstrip("/")
    if not raw:
        return "", "repo"

    scp_match = re.match(r"^(?:[^@/]+@)?([^:/]+):(.+)$", raw)
    if scp_match and "://" not in raw:
        host = scp_match.group(1).lower()
        path = strip_dot_git(scp_match.group(2)).lstrip("/")
        normalized = f"{host}/{path.lower()}"
        return normalized, Path(path).name or "repo"

    split = urlsplit(raw)
    if split.scheme:
        host = (split.hostname or "").lower()
        if split.port:
            host = f"{host}:{split.port}"
        path = strip_dot_git(split.path).lstrip("/")
        normalized = f"{host}/{path.lower()}" if host else path.lower()
        return normalized, Path(path).name or "repo"

    path = strip_dot_git(raw)
    return str(Path(path).expanduser().resolve()), Path(path).name or "repo"


def compute_repo_key(cwd: Path) -> str:
    origin = run_git(cwd, "config", "--get", "remote.origin.url")
    if origin:
        normalized, name = normalize_remote_url(origin)
        basis = f"remote:{normalized}"
        label = name
    else:
        top = run_git(cwd, "rev-parse", "--show-toplevel")
        if top:
            path = str(Path(top).resolve())
            basis = f"gitpath:{path}"
            label = Path(path).name
        else:
            path = str(cwd.resolve())
            basis = f"path:{path}"
            label = cwd.name or "project"
    digest = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:12]
    return f"{safe_slug(label)}-{digest}"


def ensure_layout(home: Path, repo_key: str | None = None) -> None:
    for base in [home / "global"]:
        (base / "topics").mkdir(parents=True, exist_ok=True)
        (base / "inbox" / "explicit").mkdir(parents=True, exist_ok=True)
        (base / "inbox" / "auto").mkdir(parents=True, exist_ok=True)
    if repo_key:
        project = home / "projects" / repo_key
        (project / "topics").mkdir(parents=True, exist_ok=True)
        (project / "sessions").mkdir(parents=True, exist_ok=True)
        (project / "inbox" / "explicit").mkdir(parents=True, exist_ok=True)
        (project / "inbox" / "auto").mkdir(parents=True, exist_ok=True)


def check_sensitive(*parts: str) -> None:
    text = "\n".join(part for part in parts if part)
    for pattern in SENSITIVE_PATTERNS:
        if pattern.search(text):
            raise MemoryStoreError("sensitive content detected")


def quote_if_needed(value: str) -> str:
    if value == "":
        return '""'
    if re.search(r":\s|#|\n|\r|[\"']", value) or value.strip() != value:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def unquote_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        inner = value[1:-1]
        return inner.replace('\\"', '"').replace("\\\\", "\\")
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def parse_evidence_arg(raw: str) -> dict[str, str]:
    if ":" in raw:
        kind, ref = raw.split(":", 1)
    else:
        kind, ref = raw, raw
    return {"kind": kind.strip(), "ref": ref.strip()}


def parse_tags(raw: str | list[str] | None) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, list):
        return [tag.strip() for tag in raw if tag.strip()]
    text = raw.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [tag.strip().strip("\"'") for tag in text.split(",") if tag.strip().strip("\"'")]


def format_tags(tags: list[str]) -> str:
    return ",".join(tag.strip() for tag in tags if tag.strip())


def memory_id(date: str | None = None) -> str:
    raw_date = (date or utc_now())[:10].replace("-", "")
    return f"mem_{raw_date}_{secrets.token_hex(4)}"


def agent_id() -> str:
    explicit = os.environ.get("AGENT_MEMORY_AGENT_ID")
    if explicit:
        return safe_slug(explicit)
    harness = os.environ.get("CLAUDECODE") and "claude"
    if not harness and os.environ.get("CODEX_SANDBOX"):
        harness = "codex"
    if not harness and (os.environ.get("OPENCODE") or os.environ.get("OPENCODE_BIN")):
        harness = "opencode"
    if not harness:
        harness = "agent"
    return f"{harness}-{os.getpid()}-{random.randint(1000, 9999)}"


class Lock:
    def __init__(self, home: Path, stale_seconds: int = 600, timeout_seconds: float = 5.0):
        self.home = home
        self.path = home / ".lock"
        self.stale_seconds = stale_seconds
        self.timeout_seconds = timeout_seconds
        self.acquired = False

    def __enter__(self) -> "Lock":
        self.home.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + self.timeout_seconds
        while True:
            try:
                os.mkdir(self.path)
                (self.path / "owner").write_text(f"pid={os.getpid()} at={utc_now()}\n", encoding="utf-8")
                self.acquired = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except FileNotFoundError:
                    # Another process removed the lock between mkdir and stat; retry.
                    continue
                if age > self.stale_seconds:
                    shutil.rmtree(self.path, ignore_errors=True)
                    continue
                if time.time() >= deadline:
                    raise MemoryStoreError("memory locked by another process")
                time.sleep(0.1)

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.acquired:
            shutil.rmtree(self.path, ignore_errors=True)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    tmp_path = Path(tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_path, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp_path.unlink()


def index_dir(home: Path) -> Path:
    return home / ".index"


def index_path(home: Path) -> Path:
    return index_dir(home) / "memory.sqlite3"


def index_dirty_path(home: Path) -> Path:
    return index_dir(home) / "dirty"


def mark_index_dirty(home: Path) -> None:
    marker = index_dirty_path(home)
    atomic_write(marker, f"dirty_at={utc_now()}\n")


def trust_path(home: Path) -> Path:
    return home / "config" / "trust.json"


def read_trust(home: Path) -> set[str]:
    path = trust_path(home)
    if not path.exists() and (home / "trust.json").exists():
        path = home / "trust.json"
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    repos = data.get("trusted_repo_keys", []) if isinstance(data, dict) else []
    return {str(item) for item in repos if isinstance(item, str)}


def write_trust(home: Path, repos: set[str]) -> None:
    payload = {"version": 1, "trusted_repo_keys": sorted(repos)}
    atomic_write(trust_path(home), json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def fts_available() -> bool:
    if os.environ.get("AGENT_MEMORY_DISABLE_FTS5") == "1":
        return False
    try:
        db = sqlite3.connect(":memory:")
        db.execute("CREATE VIRTUAL TABLE probe USING fts5(value)")
        db.close()
        return True
    except sqlite3.Error:
        return False


def indexed_memory_entries(home: Path) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    bases: list[tuple[Path, str, str]] = [(home / "global", "global", "")]
    projects = home / "projects"
    if projects.exists():
        bases.extend((path, "project", path.name) for path in sorted(projects.iterdir()) if path.is_dir())

    durable_ids: set[str] = set()
    promoted_notes_by_base: dict[Path, set[str]] = {}
    for base, scope, repo_key_value in bases:
        for path in iter_durable_records(base):
            try:
                meta, evidence, body = parse_durable_record(path)
            except Exception:
                continue
            record_id = meta.get("id", "")
            durable_ids.add(record_id)
            source_note = meta.get("source_note", "")
            if source_note:
                promoted_notes_by_base.setdefault(base, set()).add(source_note)
            entries.append({
                "key": f"record:{record_id}",
                "kind": "record",
                "scope": meta.get("scope", scope),
                "repo_key": meta.get("repo_key", repo_key_value),
                "memory_type": meta.get("memory_type", ""),
                "status": meta.get("status", "active"),
                "priority": meta.get("priority", ""),
                "source": meta.get("source", ""),
                "confidence": meta.get("confidence", ""),
                "created_at": meta.get("created_at", ""),
                "updated_at": meta.get("updated_at", ""),
                "last_verified": meta.get("last_verified", ""),
                "summary": meta.get("summary", ""),
                "aliases": " ".join(parse_tags(meta.get("aliases"))),
                "tags": " ".join(parse_tags(meta.get("tags"))),
                "body": body,
                "evidence": " ".join(item.get("ref", "") for item in evidence),
                "path": str(path),
                "id": record_id,
            })

    for base, scope, repo_key_value in bases:
        mem = base / "MEMORY.md"
        for record in canonical_records(mem, scope):
            record_id = str(record.get("id", ""))
            if record_id and record_id in durable_ids:
                continue
            entries.append({
                "key": f"canonical:{mem}:{record_id or record.get('summary', '')}",
                "kind": "canonical",
                "scope": scope,
                "repo_key": repo_key_value,
                "memory_type": str(record.get("type", "")),
                "status": "active",
                "priority": "",
                "source": "",
                "confidence": str(record.get("confidence", "")),
                "created_at": "",
                "updated_at": "",
                "last_verified": str(record.get("last_verified", "")),
                "summary": str(record.get("summary", "")),
                "aliases": "",
                "tags": " ".join(record.get("tags", [])) if isinstance(record.get("tags"), list) else str(record.get("tags", "")),
                "body": str(record.get("text", "")),
                "evidence": "",
                "path": str(mem),
                "id": record_id,
            })

        for priority in ("explicit", "auto"):
            for path in iter_note_files(base / "inbox" / priority):
                if path.name in promoted_notes_by_base.get(base, set()):
                    continue
                try:
                    meta, evidence, body = parse_note(path)
                except Exception:
                    continue
                entries.append({
                    "key": f"inbox:{path}",
                    "kind": priority,
                    "scope": meta.get("scope", scope),
                    "repo_key": meta.get("repo_key", repo_key_value),
                    "memory_type": meta.get("type", ""),
                    "status": "candidate",
                    "priority": priority,
                    "source": meta.get("source", ""),
                    "confidence": meta.get("confidence", ""),
                    "created_at": meta.get("created_at", ""),
                    "updated_at": meta.get("created_at", ""),
                    "last_verified": "",
                    "summary": meta.get("summary", ""),
                    "aliases": " ".join(parse_tags(meta.get("aliases"))),
                    "tags": " ".join(parse_tags(meta.get("tags"))),
                    "body": body,
                    "evidence": " ".join(item.get("ref", "") for item in evidence),
                    "path": str(path),
                    "id": "",
                })

        for path in iter_note_files(base / "topics"):
            if path.name in TOPIC_SUPPORT_FILENAMES or "topics/memory" in path.as_posix():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            record = topic_result(path, scope, text)
            entries.append({
                "key": f"topic:{path}",
                "kind": "topic",
                "scope": scope,
                "repo_key": repo_key_value,
                "memory_type": str(record.get("type", "")),
                "status": "active",
                "priority": "",
                "source": "",
                "confidence": "",
                "created_at": str(record.get("timestamp", "")),
                "updated_at": str(record.get("timestamp", "")),
                "last_verified": "",
                "summary": str(record.get("summary", "")),
                "aliases": "",
                "tags": " ".join(record.get("tags", [])) if isinstance(record.get("tags"), list) else "",
                "body": str(record.get("text", "")),
                "evidence": "",
                "path": str(path),
                "id": "",
            })
    return entries


INDEX_COLUMNS = [
    "key", "kind", "scope", "repo_key", "memory_type", "status", "priority",
    "source", "confidence", "created_at", "updated_at", "last_verified",
    "summary", "aliases", "tags", "body", "evidence", "path", "id",
]


def rebuild_index(home: Path) -> dict[str, object]:
    if not fts_available():
        return {"backend": "filesystem", "records": 0, "rebuilt": False, "reason": "fts5 unavailable"}
    idx_dir = index_dir(home)
    idx_dir.mkdir(parents=True, exist_ok=True)
    entries = indexed_memory_entries(home)
    fd, tmp = tempfile.mkstemp(prefix="memory-index-", suffix=".sqlite3", dir=str(idx_dir))
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        db = sqlite3.connect(tmp_path)
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute(
            "CREATE VIRTUAL TABLE memory_fts USING fts5("
            "key UNINDEXED, kind UNINDEXED, scope UNINDEXED, repo_key UNINDEXED, "
            "memory_type UNINDEXED, status UNINDEXED, priority UNINDEXED, source UNINDEXED, "
            "confidence UNINDEXED, created_at UNINDEXED, updated_at UNINDEXED, "
            "last_verified UNINDEXED, summary, aliases, tags, body, evidence, path UNINDEXED, id UNINDEXED, "
            "tokenize='unicode61 remove_diacritics 2')"
        )
        db.execute("INSERT INTO metadata VALUES ('schema_version', ?)", (str(INDEX_SCHEMA_VERSION),))
        placeholders = ",".join("?" for _ in INDEX_COLUMNS)
        db.executemany(
            f"INSERT INTO memory_fts ({','.join(INDEX_COLUMNS)}) VALUES ({placeholders})",
            [tuple(entry.get(column, "") for column in INDEX_COLUMNS) for entry in entries],
        )
        db.commit()
        db.close()
        os.replace(tmp_path, index_path(home))
        with contextlib.suppress(FileNotFoundError):
            index_dirty_path(home).unlink()
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp_path.unlink()
    return {"backend": "sqlite_fts5", "records": len(entries), "rebuilt": True}


def index_status(home: Path) -> dict[str, object]:
    path = index_path(home)
    available = fts_available()
    schema_version: int | None = None
    if path.exists():
        try:
            db = sqlite3.connect(path)
            row = db.execute("SELECT value FROM metadata WHERE key = 'schema_version'").fetchone()
            db.close()
            if row:
                schema_version = int(row[0])
        except (sqlite3.Error, ValueError):
            schema_version = None
    stale_schema = path.exists() and schema_version != INDEX_SCHEMA_VERSION
    return {
        "backend": "sqlite_fts5" if path.exists() and available else "filesystem",
        "path": str(path),
        "exists": path.exists(),
        "dirty": index_dirty_path(home).exists() or stale_schema,
        "fts5": available,
        "schema_version": schema_version,
        "expected_schema_version": INDEX_SCHEMA_VERSION,
    }


def note_text(meta: dict[str, str], evidence: list[dict[str, str]], body: str) -> str:
    order = [
        "type",
        "scope",
        "priority",
        "source",
        "confidence",
        "summary",
        "created_at",
        "agent_id",
        "repo_key",
        "tags",
        "aliases",
    ]
    lines = ["---"]
    for key in order:
        value = meta.get(key)
        if value:
            lines.append(f"{key}: {quote_if_needed(value)}")
    if evidence:
        lines.append("evidence:")
        for item in evidence:
            lines.append(f"  - kind: {quote_if_needed(item['kind'])}")
            lines.append(f"    ref: {quote_if_needed(item['ref'])}")
    lines.append("---")
    lines.append("")
    lines.append(body.rstrip())
    lines.append("")
    return "\n".join(lines)


def record_topic_text(meta: dict[str, str], evidence: list[dict[str, str]], body: str) -> str:
    """Serialize a durable promoted record.

    Durable records deliberately use the same small frontmatter subset as
    inbox notes so the store remains readable without SQLite or a YAML
    dependency. MEMORY.md is only a bounded summary view; this file owns the
    full body and evidence.
    """
    order = [
        "type",
        "memory_type",
        "scope",
        "status",
        "priority",
        "source",
        "confidence",
        "summary",
        "id",
        "created_at",
        "updated_at",
        "last_verified",
        "agent_id",
        "repo_key",
        "tags",
        "aliases",
        "source_note",
        "supersedes",
    ]
    lines = ["---"]
    for key in order:
        value = meta.get(key)
        if value:
            lines.append(f"{key}: {quote_if_needed(value)}")
    if evidence:
        lines.append("evidence:")
        for item in evidence:
            lines.append(f"  - kind: {quote_if_needed(item['kind'])}")
            lines.append(f"    ref: {quote_if_needed(item['ref'])}")
    lines.extend(["---", "", body.rstrip(), ""])
    return "\n".join(lines)


def durable_topic_path(home: Path, scope: str, repo_key: str | None, memory_id_value: str) -> Path:
    if scope == "global":
        base = home / "global"
    elif repo_key:
        base = home / "projects" / repo_key
    else:
        raise MemoryStoreError("project memory requires repo_key")
    return base / "topics" / "memory" / f"{memory_id_value}.md"


def parse_durable_record(path: Path) -> tuple[dict[str, str], list[dict[str, str]], str]:
    meta, evidence, body = parse_note(path)
    if meta.get("type") != RECORD_TOPIC_TYPE:
        raise MemoryStoreError("not an AgentMemoryRecord")
    if not meta.get("id") or not meta.get("memory_type") or not meta.get("summary"):
        raise MemoryStoreError("durable record missing id, memory_type, or summary")
    return meta, evidence, body


def iter_durable_records(base: Path) -> list[Path]:
    return iter_note_files(base / "topics" / "memory")


def split_frontmatter(text: str) -> tuple[list[str], str]:
    text_norm = text.replace("\r\n", "\n")
    if not text_norm.startswith("---\n"):
        raise MemoryStoreError("missing frontmatter")
    end = text_norm.find("\n---", 4)
    if end < 0:
        raise MemoryStoreError("unterminated frontmatter")
    fm = text_norm[4:end].splitlines()
    body = text_norm[end + 4 :].lstrip("\n")
    return fm, body


def parse_note(path: Path) -> tuple[dict[str, str], list[dict[str, str]], str]:
    text = path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)
    meta: dict[str, str] = {}
    evidence: list[dict[str, str]] = []
    i = 0
    while i < len(fm):
        line = fm[i]
        if not line.strip():
            i += 1
            continue
        if line.strip().startswith("#"):
            i += 1
            continue
        if line == "evidence:":
            i += 1
            current: dict[str, str] | None = None
            while i < len(fm) and (fm[i].startswith("  ") or fm[i].strip().startswith("#")):
                if fm[i].strip().startswith("#"):
                    i += 1
                    continue
                stripped = fm[i].strip()
                if stripped.startswith("- kind:"):
                    if current:
                        evidence.append(current)
                    current = {"kind": unquote_value(stripped.split(":", 1)[1]), "ref": ""}
                elif stripped.startswith("ref:") and current is not None:
                    current["ref"] = unquote_value(stripped.split(":", 1)[1])
                i += 1
            if current:
                evidence.append(current)
            continue
        if ":" not in line:
            raise MemoryStoreError(f"malformed frontmatter line: {line}")
        key, value = line.split(":", 1)
        meta[key.strip()] = unquote_value(value)
        i += 1
    return meta, evidence, body


def validate_note(meta: dict[str, str], evidence: list[dict[str, str]], body: str, *, check_summary_len: bool) -> list[str]:
    errors: list[str] = []
    required = ["type", "scope", "priority", "source", "confidence", "summary", "created_at", "agent_id"]
    for key in required:
        if not meta.get(key):
            errors.append(f"missing {key}")
    if meta.get("type") and meta["type"] not in TYPES:
        errors.append(f"invalid type {meta['type']}")
    if meta.get("scope") and meta["scope"] not in SCOPES:
        errors.append(f"invalid scope {meta['scope']}")
    if meta.get("priority") and meta["priority"] not in PRIORITIES:
        errors.append(f"invalid priority {meta['priority']}")
    if meta.get("source") and meta["source"] not in SOURCES:
        errors.append(f"invalid source {meta['source']}")
    if meta.get("confidence") and meta["confidence"] not in CONFIDENCES:
        errors.append(f"invalid confidence {meta['confidence']}")
    if meta.get("scope") == "project" and not meta.get("repo_key"):
        errors.append("missing repo_key")
    if check_summary_len and len(meta.get("summary", "")) > SUMMARY_MAX:
        errors.append("summary too long")
    try:
        check_sensitive(meta.get("summary", ""), body, "\n".join(item.get("ref", "") for item in evidence))
    except MemoryStoreError as exc:
        errors.append(str(exc))
    if (
        meta.get("priority") == "auto"
        and meta.get("scope") == "project"
        and meta.get("confidence") == "high"
        and meta.get("type") in PROMOTABLE_AUTO_TYPES
        and not has_promotable_evidence(evidence)
    ):
        errors.append("auto promotion candidate missing evidence")
    return errors


def has_promotable_evidence(evidence: list[dict[str, str]]) -> bool:
    return any(item.get("kind") in PROMOTABLE_EVIDENCE_KINDS and item.get("ref") for item in evidence)


def eligible_for_promotion(meta: dict[str, str], evidence: list[dict[str, str]]) -> bool:
    if meta.get("priority") == "auto":
        return (
            meta.get("scope") == "project"
            and meta.get("confidence") == "high"
            and meta.get("type") in PROMOTABLE_AUTO_TYPES
            and has_promotable_evidence(evidence)
        )
    if meta.get("priority") == "explicit":
        return meta.get("source") == "user" and meta.get("confidence") in {"high", "medium"}
    return False


def memory_path(home: Path, scope: str, repo_key: str | None) -> Path:
    if scope == "global":
        return home / "global" / "MEMORY.md"
    if not repo_key:
        raise MemoryStoreError("project memory requires repo_key")
    return home / "projects" / repo_key / "MEMORY.md"


def scoped_bases(home: Path, repo_key: str | None, all_projects: bool) -> list[Path]:
    """Base directories a scoped destructive op should touch. Default: the current
    project plus global. With all_projects: every project plus global. Prevents
    `cleanup`/`forget` run inside project A from silently pruning projects B, C."""
    bases: list[Path] = [home / "global"]
    if all_projects:
        projects = home / "projects"
        if projects.exists():
            bases.extend(sorted(p for p in projects.iterdir() if p.is_dir()))
    elif repo_key:
        bases.append(home / "projects" / repo_key)
    return [base for base in bases if base.exists()]


def scoped_memory_files(home: Path, repo_key: str | None, all_projects: bool) -> list[Path]:
    return [
        base / "MEMORY.md"
        for base in scoped_bases(home, repo_key, all_projects)
        if (base / "MEMORY.md").exists()
    ]


def command_repo_key(args: argparse.Namespace) -> int:
    print(compute_repo_key(cwd_from_args(args)))
    return 0


def command_note(args: argparse.Namespace) -> int:
    home = memory_home(args)
    evidence = [parse_evidence_arg(raw) for raw in (args.evidence or [])]
    body = args.body
    if body is None and not sys.stdin.isatty():
        body = sys.stdin.read()
    body = body or ""
    target, _ = write_note(
        home,
        cwd=cwd_from_args(args),
        scope=args.scope,
        priority=args.priority,
        note_type=args.type,
        source=args.source,
        confidence=args.confidence,
        summary=args.summary,
        evidence=evidence,
        tags=args.tag or [],
        aliases=args.alias or [],
        body=body,
    )
    print(f"NOTE={target}")
    return 0


def write_note(
    home: Path,
    *,
    cwd: Path,
    scope: str,
    priority: str,
    note_type: str,
    source: str,
    confidence: str,
    summary: str,
    evidence: list[dict[str, str]],
    tags: list[str],
    aliases: list[str],
    body: str,
) -> tuple[Path, dict[str, str]]:
    repo_key = compute_repo_key(cwd) if scope == "project" else None
    ensure_layout(home, repo_key)
    check_sensitive(summary, body, "\n".join(item.get("ref", "") for item in evidence))
    meta = {
        "type": note_type,
        "scope": scope,
        "priority": priority,
        "source": source,
        "confidence": confidence,
        "summary": summary,
        "created_at": utc_now(),
        "agent_id": agent_id(),
    }
    tag_text = format_tags(tags)
    if tag_text:
        meta["tags"] = tag_text
    alias_text = format_tags(aliases)
    if alias_text:
        meta["aliases"] = alias_text
    if repo_key:
        meta["repo_key"] = repo_key

    target_dir = home / ("global" if scope == "global" else f"projects/{repo_key}") / "inbox" / priority
    stem = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{stem}_{meta['agent_id']}_{secrets.token_hex(4)}.md"
    target = target_dir / filename
    with Lock(home):
        atomic_write(target, note_text(meta, evidence, body))
        mark_index_dirty(home)
    return target, meta


def clean_proposal_text(value: str) -> str:
    text = re.sub(
        r"^\s*(repeated failure|lesson learned|user correction|correction|preference)\s*:\s*",
        "",
        value,
        flags=re.I,
    )
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text


def proposal_summary(line: str) -> str:
    text = clean_proposal_text(line)
    match = re.search(r"\bafter\s+(.+?),\s*(.+?)\s+before\s+(.+)", text, flags=re.I)
    if match:
        before = match.group(1).strip()
        action = match.group(2).strip()
        condition = match.group(3).strip()
        text = f"{action} before {condition} after {before}"
    return text[:SUMMARY_MAX]


def command_ref_from_line(line: str) -> str:
    match = re.search(r"verified with command:\s*(.+)$", line, flags=re.I)
    if match:
        return match.group(1).strip()
    return ""


def infer_proposals(text: str, default_tags: list[str]) -> list[dict[str, object]]:
    proposals: list[dict[str, object]] = []
    pending_evidence: list[dict[str, str]] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        command_ref = command_ref_from_line(line)
        if command_ref:
            if proposals:
                evidence = proposals[-1].setdefault("evidence", [])
                if isinstance(evidence, list):
                    evidence.append({"kind": "command", "ref": command_ref})
                proposals[-1]["confidence"] = "high"
            else:
                pending_evidence.append({"kind": "command", "ref": command_ref})
            continue

        lowered = line.lower()
        # Anchor signals to the start of the line so an incidental "prefer" or
        # "command" mid-sentence does not stage a spurious candidate.
        if lowered.startswith(("user correction", "prefer", "preference")):
            proposals.append({
                "type": "preference",
                "confidence": "medium",
                "summary": proposal_summary(line),
                "evidence": [],
                "tags": list(default_tags),
                "body": line,
            })
            continue

        if lowered.startswith((
            "repeated failure",
            "lesson learned",
            "verified",
            "run ",
            "restart ",
            "command",
        )):
            evidence = pending_evidence
            pending_evidence = []
            proposals.append({
                "type": "command",
                "confidence": "high" if evidence else "medium",
                "summary": proposal_summary(line),
                "evidence": evidence,
                "tags": list(default_tags),
                "body": line,
            })

    return [
        proposal
        for proposal in proposals
        if str(proposal.get("summary", "")).strip()
    ]


def command_propose(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    if args.input:
        text = Path(args.input).expanduser().read_text(encoding="utf-8")
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        raise MemoryStoreError("propose requires --input or piped stdin")

    proposals = infer_proposals(text, args.tag or [])
    candidates: list[dict[str, object]] = []
    for proposal in proposals:
        evidence = proposal.get("evidence", [])
        if not isinstance(evidence, list):
            evidence = []
        path, meta = write_note(
            home,
            cwd=cwd,
            scope=args.scope,
            priority="auto",
            note_type=str(proposal["type"]),
            source=args.source,
            confidence=str(proposal["confidence"]),
            summary=str(proposal["summary"]),
            evidence=[item for item in evidence if isinstance(item, dict)],
            tags=(
                [str(tag) for tag in proposal.get("tags", []) if isinstance(tag, str)]
                if isinstance(proposal.get("tags"), list)
                else []
            ),
            aliases=[],
            body=str(proposal.get("body", "")),
        )
        candidates.append({
            "path": str(path),
            "type": meta["type"],
            "scope": meta["scope"],
            "priority": meta["priority"],
            "source": meta["source"],
            "confidence": meta["confidence"],
            "summary": meta["summary"],
            "evidence": evidence,
            "tags": parse_tags(meta.get("tags")),
        })

    if args.format == "json":
        print(json.dumps(
            {"candidates": candidates, "total": len(candidates)},
            indent=2,
            ensure_ascii=False,
        ))
    else:
        for candidate in candidates:
            print(f"PROPOSE={candidate['path']}: {candidate['summary']}")
    return 0


def canonical_metadata_text(values: dict[str, str]) -> str:
    return "; ".join(f"{key}: {value}" for key, value in values.items() if value)


def is_duplicate_canonical(existing: str, summary: str, source_note: str) -> bool:
    """A promotion is a duplicate only if the same source note is already
    recorded, or an existing canonical bullet carries the exact same summary.
    (A raw ``summary in existing`` substring test silently dropped distinct
    entries whose summary happened to be a substring of another line.)"""
    if f"source_note: {source_note}" in existing:
        return True
    for line in existing.splitlines():
        stripped = line.lstrip()
        if stripped.startswith("- [") and f"] {summary} (" in stripped:
            return True
    return False


def build_memory_update(existing: str, title: str, bullet: str, summary: str, source_note: str) -> str:
    if is_duplicate_canonical(existing, summary, source_note):
        return existing
    start = "<!-- agent-memory:start -->"
    end = "<!-- agent-memory:end -->"
    if not existing.strip():
        return f"# {title}\n\n{start}\n{bullet}\n{end}\n"
    if start in existing and end in existing:
        before, rest = existing.split(end, 1)
        if not before.endswith("\n"):
            before += "\n"
        return f"{before}{bullet}\n{end}{rest}"
    text = existing.rstrip() + f"\n\n{start}\n{bullet}\n{end}\n"
    return text


def command_promote(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    lexical_note = Path(args.note).expanduser().absolute()
    note = lexical_note.resolve()
    if lexical_note != note:
        raise MemoryStoreError("note path must not contain symlinks")
    try:
        note.relative_to(home)
    except ValueError as exc:
        raise MemoryStoreError("note must be inside the memory store") from exc
    meta, evidence, body = parse_note(note)
    errors = validate_note(meta, evidence, body, check_summary_len=True)
    if errors:
        raise MemoryStoreError("; ".join(errors))
    if not eligible_for_promotion(meta, evidence):
        raise MemoryStoreError("note is not eligible for promotion")

    priority = meta.get("priority", "")
    if meta.get("scope") == "global":
        expected_parent = home / "global" / "inbox" / priority
        target_repo_key = None
        if meta.get("repo_key"):
            raise MemoryStoreError("global note must not declare repo_key")
    else:
        if meta.get("repo_key") != repo_key:
            raise MemoryStoreError("project note repo_key does not match --cwd")
        expected_parent = home / "projects" / repo_key / "inbox" / priority
        target_repo_key = repo_key
    if note.parent != expected_parent:
        raise MemoryStoreError("note path does not match its scope and priority metadata")

    ensure_layout(home, target_repo_key)
    dest = memory_path(home, meta["scope"], target_repo_key)
    title = "Global Memory" if meta["scope"] == "global" else "Project Memory"
    date = meta.get("created_at", utc_now())[:10]
    source_note = note.name
    record_id = memory_id(date)
    record_path = durable_topic_path(home, meta["scope"], target_repo_key, record_id)
    resource = str(record_path.relative_to(dest.parent))
    canonical_meta = {
        "id": record_id,
        "confidence": meta["confidence"],
        "source_note": source_note,
        "last_verified": date,
        "resource": resource,
    }
    if meta.get("tags"):
        canonical_meta["tags"] = meta["tags"]
    bullet = (
        f"- [{meta['type']}] {meta['summary']} "
        f"({canonical_metadata_text(canonical_meta)})"
    )
    now = utc_now()
    record_meta = {
        "type": RECORD_TOPIC_TYPE,
        "memory_type": meta["type"],
        "scope": meta["scope"],
        "status": "active",
        "priority": meta["priority"],
        "source": meta["source"],
        "confidence": meta["confidence"],
        "summary": meta["summary"],
        "id": record_id,
        "created_at": meta.get("created_at", now),
        "updated_at": now,
        "last_verified": date,
        "agent_id": meta.get("agent_id", ""),
        "repo_key": meta.get("repo_key", ""),
        "tags": meta.get("tags", ""),
        "aliases": meta.get("aliases", ""),
        "source_note": source_note,
    }
    topic_text = record_topic_text(record_meta, evidence, body)
    with Lock(home):
        existing = dest.read_text(encoding="utf-8") if dest.exists() else ""
        if is_duplicate_canonical(existing, meta["summary"], source_note):
            print(f"SKIPPED=duplicate {dest}")
            return 0
        updated = build_memory_update(existing, title, bullet, meta["summary"], source_note)
        # MEMORY.md is a bounded convenience index. The durable topic is still
        # written when the summary view is full, so promotion never loses data
        # merely because a startup index reached its context budget.
        if len(updated.splitlines()) > MEMORY_MAX_LINES:
            updated = existing
        atomic_write(record_path, topic_text)
        if updated != existing:
            atomic_write(dest, updated)
        mark_index_dirty(home)
    print(f"PROMOTE={dest}")
    print(f"RECORD={record_path}")
    return 0


def keyword_match(text: str, queries: list[str]) -> bool:
    if not queries:
        return True
    lowered = text.lower()
    return any(query.lower() in lowered for query in queries)


def iter_note_files(base: Path) -> list[Path]:
    if not base.exists():
        return []
    return sorted(path for path in base.rglob("*.md") if path.is_file())


def note_summary_line(path: Path) -> str:
    try:
        meta, _, _ = parse_note(path)
        summary = meta.get("summary", "")
    except Exception:
        summary = path.read_text(encoding="utf-8", errors="replace").splitlines()[0:1]
        summary = summary[0] if summary else ""
    return f"{path}: {summary}"


def note_to_dict(path: Path) -> dict[str, object]:
    try:
        meta, evidence, body = parse_note(path)
        return {
            "path": str(path),
            "summary": meta.get("summary", ""),
            "type": meta.get("type", ""),
            "scope": meta.get("scope", ""),
            "priority": meta.get("priority", ""),
            "source": meta.get("source", ""),
            "confidence": meta.get("confidence", ""),
            "created_at": meta.get("created_at", ""),
            "agent_id": meta.get("agent_id", ""),
            "repo_key": meta.get("repo_key", ""),
            "tags": parse_tags(meta.get("tags")),
            "aliases": parse_tags(meta.get("aliases")),
            "evidence": evidence,
            "body": body,
        }
    except Exception:
        return {"path": str(path), "summary": "", "error": "parse failed"}


def metadata_key(value: str) -> str:
    key = re.sub(r"[^a-z0-9_]+", "_", value.lower()).strip("_")
    return key or "metadata"


def parse_canonical_line(line: str) -> dict[str, object]:
    result: dict[str, object] = {"summary": line}
    match = re.match(r"^-\s+\[([^\]]+)\]\s+(.*?)\s+\((.*)\)\s*$", line)
    if not match:
        return result

    result["type"] = match.group(1).strip()
    result["summary"] = match.group(2).strip()
    for part in match.group(3).split(";"):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        meta_key = metadata_key(key.strip())
        meta_value = value.strip()
        if meta_key == "tags":
            result[meta_key] = parse_tags(meta_value)
        else:
            result[meta_key] = meta_value
    return result


def canonical_records(path: Path, scope: str) -> list[dict[str, object]]:
    if not path.exists():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("<!--") and not stripped.startswith("#") and stripped != "---":
            record = {
                "kind": "canonical",
                "scope": scope,
                "path": str(path),
                "text": stripped,
            }
            record.update(parse_canonical_line(stripped))
            records.append(record)
    return records


def note_result(path: Path, kind: str, scope: str) -> dict[str, object]:
    result = note_to_dict(path)
    result["kind"] = kind
    result["scope"] = result.get("scope") or scope
    return result


def topic_result(path: Path, scope: str, text: str) -> dict[str, object]:
    meta: dict[str, object] = {}
    text_norm = text.replace("\r\n", "\n")
    body = text_norm
    if f"type: {RECORD_TOPIC_TYPE}" in text_norm[:512]:
        try:
            record_meta, evidence, body = parse_durable_record(path)
            return {
                "kind": "record",
                "scope": record_meta.get("scope", scope),
                "path": str(path),
                "summary": record_meta.get("summary", ""),
                "text": body,
                "body": body,
                "type": record_meta.get("memory_type", ""),
                "status": record_meta.get("status", "active"),
                "id": record_meta.get("id", ""),
                "priority": record_meta.get("priority", ""),
                "source": record_meta.get("source", ""),
                "confidence": record_meta.get("confidence", ""),
                "created_at": record_meta.get("created_at", ""),
                "updated_at": record_meta.get("updated_at", ""),
                "last_verified": record_meta.get("last_verified", ""),
                "repo_key": record_meta.get("repo_key", ""),
                "tags": parse_tags(record_meta.get("tags")),
                "aliases": parse_tags(record_meta.get("aliases")),
                "evidence": evidence,
                "resource": str(path),
                "supersedes": record_meta.get("supersedes", ""),
            }
        except MemoryStoreError:
            pass
    if text_norm.startswith("---\n"):
        try:
            meta, body = parse_simple_frontmatter_text(text_norm)
        except MemoryStoreError:
            meta = {}
            body = text_norm

    summary = ""
    for line in body.splitlines():
        if line.strip():
            summary = line.strip()
            break
    metadata = {
        key: value
        for key, value in meta.items()
        if key not in {"type", "title", "description", "resource", "tags", "timestamp"} and value not in ("", [])
    }
    title = str(meta.get("title", "")) if isinstance(meta.get("title"), str) else ""
    description = str(meta.get("description", "")) if isinstance(meta.get("description"), str) else ""
    result: dict[str, object] = {
        "kind": "topic",
        "scope": scope,
        "path": str(path),
        "summary": title or description or summary,
        "text": body,
    }
    for key in ["type", "title", "description", "resource", "timestamp"]:
        value = meta.get(key)
        if isinstance(value, str) and value:
            result[key] = value
    if meta.get("tags"):
        result["tags"] = parse_tags(meta.get("tags"))
    if metadata:
        result["metadata"] = metadata
    return result


def record_date(record: dict[str, object]) -> str:
    # topic records carry `timestamp` rather than created_at/last_verified;
    # include it so `find --since` does not silently drop every topic.
    value = str(
        record.get("created_at")
        or record.get("last_verified")
        or record.get("timestamp")
        or ""
    )
    return value[:10]


def evidence_text(record: dict[str, object]) -> str:
    evidence = record.get("evidence")
    if not isinstance(evidence, list):
        return ""
    return " ".join(
        str(item.get("ref", ""))
        for item in evidence
        if isinstance(item, dict)
    )


def record_matches_filters(record: dict[str, object], args: argparse.Namespace) -> bool:
    if getattr(args, "scope", None) and record.get("scope") != args.scope:
        return False
    if getattr(args, "type", None) and record.get("type") != args.type:
        return False
    if getattr(args, "priority", None) and record.get("priority") != args.priority:
        return False
    if getattr(args, "source", None) and record.get("source") != args.source:
        return False
    if getattr(args, "since", None):
        date = record_date(record)
        if not date or date < args.since:
            return False
    return True


def first_snippet(fields: dict[str, str], queries: list[str]) -> str:
    if not queries:
        for key in ["summary", "body", "text"]:
            if fields.get(key):
                return fields[key][:240]
        return ""
    for query in queries:
        lowered_query = query.lower()
        for value in fields.values():
            lowered = value.lower()
            pos = lowered.find(lowered_query)
            if pos >= 0:
                start = max(0, pos - 60)
                end = min(len(value), pos + len(query) + 120)
                return value[start:end].strip()
    return ""


def score_record(record: dict[str, object], queries: list[str]) -> dict[str, object]:
    kind_weight = {"record": 45, "canonical": 40, "explicit": 35, "topic": 20, "auto": 10}.get(str(record.get("kind")), 0)
    scope_weight = 15 if record.get("scope") == "project" else 0
    fields = {
        "summary": str(record.get("summary", "")),
        "title": str(record.get("title", "")),
        "description": str(record.get("description", "")),
        "tags": " ".join(record.get("tags", [])) if isinstance(record.get("tags"), list) else str(record.get("tags", "")),
        "aliases": " ".join(record.get("aliases", [])) if isinstance(record.get("aliases"), list) else str(record.get("aliases", "")),
        "body": str(record.get("body", "")),
        "text": str(record.get("text", "")),
        "evidence": evidence_text(record),
        "resource": str(record.get("resource", "")),
        "type": str(record.get("type", "")),
        "source": str(record.get("source", "")),
    }
    boosts = {
        "summary": 100,
        "title": 100,
        "description": 60,
        "tags": 80,
        "aliases": 90,
        "body": 45,
        "text": 45,
        "evidence": 30,
        "resource": 20,
        "type": 15,
        "source": 15,
    }
    matched: list[str] = []
    query_score = 0
    for query in queries:
        lowered_query = query.lower()
        for field, value in fields.items():
            if lowered_query and lowered_query in value.lower():
                if field not in matched:
                    matched.append(field)
                query_score += boosts[field]
    ranked = dict(record)
    ranked["score"] = kind_weight + scope_weight + query_score
    ranked["matched_fields"] = matched
    ranked["snippet"] = first_snippet(fields, queries)
    return ranked


def text_line(record: dict[str, object]) -> str:
    path = record.get("path", "")
    if record.get("kind") == "canonical":
        return f"{path}: {record.get('text', record.get('summary', ''))}"
    return f"{path}: {record.get('summary', '')}"


def command_find(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    queries = args.query or []
    bases = [(home / "global", "global"), (home / "projects" / repo_key, "project")]
    fmt = getattr(args, "format", "text")
    candidates: list[dict[str, object]] = []

    for base, scope in bases:
        for record in canonical_records(base / "MEMORY.md", scope):
            candidates.append(record)
        for path in iter_note_files(base / "inbox" / "explicit"):
            candidates.append(note_result(path, "explicit", scope))
        for path in iter_note_files(base / "topics"):
            if path.name in TOPIC_SUPPORT_FILENAMES:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            # Topics load only when a query (or --include-topics) selects them,
            # so a bare `find` does not dump the entire topic corpus.
            if args.include_topics or (queries and keyword_match(text, queries)):
                candidates.append(topic_result(path, scope, text))
        for path in iter_note_files(base / "inbox" / "auto"):
            text = path.read_text(encoding="utf-8", errors="replace")
            if args.include_auto or (queries and keyword_match(text, queries)):
                candidates.append(note_result(path, "auto", scope))

    results = [
        score_record(record, queries)
        for record in candidates
        if record_matches_filters(record, args)
    ]
    results.sort(key=lambda record: (-int(record.get("score", 0)), str(record.get("path", "")), str(record.get("summary", ""))))

    if fmt == "json":
        budget = args.budget_lines
        output = {"results": results[:budget], "truncated": len(results) > budget, "total": len(results)}
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        for record in results[: args.budget_lines]:
            print(text_line(record))
    return 0


RECALL_STOPWORDS = {
    "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "with",
    "is", "are", "this", "that", "it", "we", "you", "please", "use", "using",
    "그리고", "또는", "이", "그", "저", "것", "수", "좀", "해주세요", "해줘",
}


def recall_terms(prompt: str) -> list[str]:
    raw = re.findall(r"[\w./:@+\-]{2,}", prompt.lower(), flags=re.UNICODE)
    terms: list[str] = []
    for value in raw:
        value = value.strip("._:/@+-")
        if len(value) < 2 or value in RECALL_STOPWORDS or value.isdigit():
            continue
        if value not in terms:
            terms.append(value)
        if len(terms) >= 24:
            break
    return terms


def fts_query(terms: list[str]) -> str:
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms)


def recall_scope_allowed(entry: dict[str, str], repo_key: str, include_global: bool) -> bool:
    if entry.get("scope") == "global":
        return include_global
    return entry.get("scope") == "project" and entry.get("repo_key") == repo_key


def filesystem_recall(home: Path, repo_key: str, terms: list[str], include_global: bool, limit: int) -> list[dict[str, object]]:
    results: list[dict[str, object]] = []
    for entry in indexed_memory_entries(home):
        if not recall_scope_allowed(entry, repo_key, include_global):
            continue
        if entry.get("status") == "superseded" or entry.get("kind") == "auto":
            continue
        fields = {
            "summary": entry.get("summary", ""),
            "aliases": entry.get("aliases", ""),
            "tags": entry.get("tags", ""),
            "body": entry.get("body", ""),
            "evidence": entry.get("evidence", ""),
        }
        score = 0
        matched: list[str] = []
        for term in terms:
            for field, value in fields.items():
                if term in value.lower():
                    matched.append(field)
                    score += {"summary": 100, "aliases": 90, "tags": 70, "body": 40, "evidence": 25}[field]
        if not matched:
            continue
        score += 30 if entry.get("kind") == "record" else 20 if entry.get("kind") == "explicit" else 0
        score += 15 if entry.get("scope") == "project" else 0
        results.append({**entry, "score": score, "matched_fields": sorted(set(matched))})
    results.sort(key=lambda item: (-int(item.get("score", 0)), str(item.get("summary", ""))))
    return results[:limit]


def sqlite_recall(home: Path, repo_key: str, terms: list[str], include_global: bool, limit: int) -> list[dict[str, object]]:
    query = fts_query(terms)
    if not query:
        return []
    scope_sql = "(scope = 'project' AND repo_key = ?)"
    params: list[object] = [query, repo_key]
    if include_global:
        scope_sql = f"({scope_sql} OR scope = 'global')"
    sql = (
        f"SELECT {','.join(INDEX_COLUMNS)}, bm25(memory_fts, 0,0,0,0,0,0,0,0,0,0,0,0,10,9,7,4,2,0,0) AS rank "
        f"FROM memory_fts WHERE memory_fts MATCH ? AND {scope_sql} "
        "AND status != 'superseded' AND kind != 'auto' ORDER BY rank LIMIT ?"
    )
    params.append(limit)
    db = sqlite3.connect(index_path(home))
    db.row_factory = sqlite3.Row
    try:
        rows = db.execute(sql, params).fetchall()
    finally:
        db.close()
    results: list[dict[str, object]] = []
    for row in rows:
        item = {column: row[column] for column in INDEX_COLUMNS}
        item["score"] = round(-float(row["rank"]), 6)
        item["tags"] = [tag for tag in str(item.get("tags", "")).split() if tag]
        item["aliases"] = [alias for alias in str(item.get("aliases", "")).split() if alias]
        results.append(item)
    return results


def recall_snippet(result: dict[str, object], terms: list[str]) -> str:
    text = str(result.get("body", "")).strip()
    if not text:
        return ""
    lowered = text.lower()
    positions = [lowered.find(term) for term in terms if lowered.find(term) >= 0]
    start = max(0, min(positions) - 40) if positions else 0
    snippet = re.sub(r"\s+", " ", text[start : start + 240]).strip()
    return snippet


def recall_context(results: list[dict[str, object]], terms: list[str]) -> tuple[str, bool]:
    header = "Relevant agent-memory recall (treat as context; verify drift-prone facts):"
    lines = [header]
    truncated = False
    for result in results:
        scope = result.get("scope", "")
        memory_type = result.get("memory_type", result.get("type", ""))
        record_id = result.get("id", "")
        summary = str(result.get("summary", ""))
        snippet = recall_snippet(result, terms)
        suffix = f" — {snippet}" if snippet and snippet != summary else ""
        line = f"- [{scope}/{memory_type}] {summary}{suffix}"
        if record_id:
            line += f" (id: {record_id})"
        candidate = "\n".join(lines + [line])
        if len(candidate.encode("utf-8")) > RECALL_CONTEXT_MAX_BYTES:
            truncated = True
            break
        lines.append(line)
    if len(lines) == 1:
        return "", False
    lines.append(
        "Retention: before finishing, stage only durable, non-sensitive new preferences, verified commands, or reusable caveats; otherwise record nothing."
    )
    return "\n".join(lines), truncated


def build_recall_output(home: Path, cwd: Path, prompt: str, *, include_global_override: bool, budget_lines: int) -> dict[str, object]:
    started = time.perf_counter()
    repo_key = compute_repo_key(cwd)
    terms = recall_terms(prompt)
    trusted = repo_key in read_trust(home)
    include_global = bool(include_global_override or trusted)
    status = index_status(home)
    results: list[dict[str, object]] = []
    backend = "filesystem"
    if home.exists() and terms:
        if status["fts5"] and (not status["exists"] or status["dirty"]):
            rebuild_error = ""
            try:
                with Lock(home):
                    rebuild_index(home)
            except (MemoryStoreError, OSError, sqlite3.Error) as exc:
                # A read-only mount or a briefly contended lock must not make
                # memory unavailable. The Markdown source remains searchable.
                rebuild_error = str(exc)
            status = index_status(home)
            if rebuild_error:
                status["rebuild_error"] = rebuild_error
        if status["backend"] == "sqlite_fts5" and status["exists"] and not status["dirty"]:
            try:
                results = sqlite_recall(home, repo_key, terms, include_global, budget_lines)
                backend = "sqlite_fts5"
            except sqlite3.Error:
                results = filesystem_recall(home, repo_key, terms, include_global, budget_lines)
        else:
            results = filesystem_recall(home, repo_key, terms, include_global, budget_lines)
    context, truncated = recall_context(results, terms)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    return {
        "results": results,
        "context": context,
        "truncated": truncated,
        "total": len(results),
        "index_status": {**status, "backend": backend},
        "trusted": trusted,
        "global_included": include_global,
        "elapsed_ms": elapsed_ms,
    }


def command_recall(args: argparse.Namespace) -> int:
    output = build_recall_output(
        memory_home(args),
        cwd_from_args(args),
        args.prompt,
        include_global_override=bool(args.include_global),
        budget_lines=args.budget_lines,
    )
    if args.format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
    elif output["context"]:
        print(output["context"])
    return 0


def command_index(args: argparse.Namespace) -> int:
    home = memory_home(args)
    if args.index_command == "status":
        status = index_status(home)
        if args.format == "json":
            print(json.dumps(status, indent=2, ensure_ascii=False))
        else:
            print(" ".join(f"{key}={value}" for key, value in status.items()))
        return 0
    if args.index_command == "rebuild":
        if not home.exists():
            result = {"backend": "filesystem", "records": 0, "rebuilt": False, "reason": "store absent"}
        else:
            with Lock(home):
                result = rebuild_index(home)
        if args.format == "json":
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            print(" ".join(f"{key}={value}" for key, value in result.items()))
        return 0
    raise MemoryStoreError(f"unknown index command: {args.index_command}")


def command_trust(args: argparse.Namespace) -> int:
    home = memory_home(args)
    repos = read_trust(home)
    if args.trust_command == "list":
        data = sorted(repos)
        if args.format == "json":
            print(json.dumps({"trusted_repo_keys": data}, indent=2))
        else:
            for item in data:
                print(item)
        return 0
    repo_key = compute_repo_key(cwd_from_args(args))
    with Lock(home):
        if args.trust_command == "add":
            repos.add(repo_key)
        elif args.trust_command == "remove":
            repos.discard(repo_key)
        else:
            raise MemoryStoreError(f"unknown trust command: {args.trust_command}")
        write_trust(home, repos)
    print(f"TRUST={args.trust_command} {repo_key}")
    return 0


def backup_files(home: Path, paths: list[Path], label: str) -> Path | None:
    existing = [path for path in paths if path.exists()]
    if not existing:
        return None
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = home / "backups" / label / stamp
    for path in existing:
        try:
            rel = path.relative_to(home)
        except ValueError:
            rel = Path(safe_slug(str(path)))
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        with contextlib.suppress(OSError):
            os.chmod(target, 0o600)
    return root


def command_migrate(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    bases = scoped_bases(home, repo_key, args.all_projects)
    actions: list[dict[str, str]] = []
    planned: list[tuple[Path, str, Path, str]] = []

    for base in bases:
        mem = base / "MEMORY.md"
        if not mem.exists():
            continue
        scope = "global" if base.name == "global" else "project"
        target_repo_key = "" if scope == "global" else base.name
        new_lines: list[str] = []
        changed = False
        for line in mem.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped.startswith("- ["):
                new_lines.append(line)
                continue
            parsed = parse_canonical_line(stripped)
            if parsed.get("resource"):
                new_lines.append(line)
                continue
            record_id = str(parsed.get("id") or memory_id())
            record_path = durable_topic_path(home, scope, target_repo_key or None, record_id)
            source_note = str(parsed.get("source_note", ""))
            note_path = next(iter(base.glob(f"inbox/*/{source_note}")), None) if source_note else None
            note_meta: dict[str, str] = {}
            evidence: list[dict[str, str]] = []
            body = str(parsed.get("summary", ""))
            if note_path and note_path.exists():
                try:
                    note_meta, evidence, body = parse_note(note_path)
                except Exception:
                    note_meta = {}
            now = utc_now()
            record_meta = {
                "type": RECORD_TOPIC_TYPE,
                "memory_type": str(parsed.get("type", note_meta.get("type", "project-fact"))),
                "scope": scope,
                "status": "active",
                "priority": note_meta.get("priority", "explicit"),
                "source": note_meta.get("source", "repo"),
                "confidence": str(parsed.get("confidence", note_meta.get("confidence", "medium"))),
                "summary": str(parsed.get("summary", note_meta.get("summary", ""))),
                "id": record_id,
                "created_at": note_meta.get("created_at", now),
                "updated_at": now,
                "last_verified": str(parsed.get("last_verified", now[:10])),
                "agent_id": note_meta.get("agent_id", "migration"),
                "repo_key": target_repo_key,
                "tags": format_tags(parsed.get("tags", [])) if isinstance(parsed.get("tags"), list) else str(parsed.get("tags", note_meta.get("tags", ""))),
                "aliases": note_meta.get("aliases", ""),
                "source_note": source_note,
            }
            resource = str(record_path.relative_to(base))
            if line.rstrip().endswith(")"):
                migrated_line = line.rstrip()[:-1] + f"; resource: {resource})"
            else:
                migrated_line = line + f" (resource: {resource})"
            if not record_path.exists():
                planned.append((record_path, record_topic_text(record_meta, evidence, body), mem, migrated_line))
            actions.append({"memory": str(mem), "record": str(record_path), "id": record_id, "summary": record_meta["summary"]})
            new_lines.append(migrated_line)
            changed = True
        if changed:
            planned.append((mem, "\n".join(new_lines) + "\n", mem, ""))

    backup: Path | None = None
    if args.apply and planned:
        touched = sorted({item[2] for item in planned})
        backup = backup_files(home, touched, "migration")
        with Lock(home):
            for target, content, _, _ in planned:
                atomic_write(target, content)
            mark_index_dirty(home)
    output = {"actions": actions, "total": len(actions), "applied": bool(args.apply), "backup": str(backup) if backup else ""}
    if args.format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        for action in actions:
            prefix = "MIGRATE" if args.apply else "DRY_RUN"
            print(f"{prefix}={action['memory']} -> {action['record']}")
        if backup:
            print(f"BACKUP={backup}")
    return 0


def native_memory_root(harness: str, cwd: Path, source_dir: str | None) -> Path:
    if source_dir:
        return Path(source_dir).expanduser().resolve()
    if harness == "claude":
        project_root = run_git(cwd, "rev-parse", "--show-toplevel") or str(cwd.resolve())
        encoded = str(Path(project_root).resolve()).replace("/", "-")
        return Path.home() / ".claude" / "projects" / encoded / "memory"
    if harness == "codex":
        codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
        return codex_home / "memories"
    if harness == "remember":
        return cwd / ".remember"
    raise MemoryStoreError(f"unsupported native memory harness: {harness}")


def native_import_files(harness: str, root: Path, include_history: bool) -> list[Path]:
    """Select useful native-memory files without sweeping in noisy history."""
    if not root.exists():
        return []
    markdown = sorted(path for path in root.rglob("*.md") if path.is_file())
    if harness == "claude":
        return markdown
    if harness == "codex":
        if include_history:
            return [path for path in markdown if not any(part.startswith(".") for part in path.relative_to(root).parts)]
        selected: list[Path] = []
        for path in markdown:
            relative = path.relative_to(root)
            if len(relative.parts) == 1 and relative.name not in {"raw_memories.md"}:
                selected.append(path)
            elif relative.parts[:3] == ("extensions", "ad_hoc", "notes"):
                selected.append(path)
        return selected
    if harness == "remember":
        selected = []
        for path in markdown:
            relative = path.relative_to(root)
            if len(relative.parts) != 1:
                continue
            name = relative.name
            if name in {"core-memories.md", "now.md"}:
                selected.append(path)
            elif re.fullmatch(r"today-\d{4}-\d{2}-\d{2}\.md", name):
                selected.append(path)
            elif include_history and (name in {"recent.md", "archive.md"} or re.fullmatch(r"today-.*\.done\.md", name)):
                selected.append(path)
        return selected
    raise MemoryStoreError(f"unsupported native memory harness: {harness}")


def remember_import_entries(path: Path, text: str) -> list[tuple[str, str]]:
    """Split remember's rolling Markdown files into reviewable entry-sized units."""
    matches = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", text))
    if not matches:
        body = text.strip()
        return [(str(path), body)] if body else []
    entries: list[tuple[str, str]] = []
    for index, match in enumerate(matches, start=1):
        end = matches[index].start() if index < len(matches) else len(text)
        body = text[match.start():end].strip()
        if body:
            entries.append((f"{path}#{index}-{safe_slug(match.group(1))}", body))
    return entries


def native_import_entries(harness: str, path: Path) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    if harness == "remember":
        return remember_import_entries(path, text)
    body = text.strip()
    return [(str(path), body)] if body else []


def native_import_type(harness: str, path: Path, text: str) -> str:
    if harness == "remember":
        return "project-fact" if path.name == "core-memories.md" else "handoff"
    if harness == "codex":
        if path.name in {"MEMORY.md", "memory_summary.md"}:
            return "project-fact"
        frontmatter_type = re.search(r"(?im)^type:\s*([a-z-]+)\s*$", text[:1000])
        if frontmatter_type and frontmatter_type.group(1) in TYPES:
            return frontmatter_type.group(1)
        preference_cues = f"{path.stem}\n{text[:1000]}"
        if re.search(r"(?i)\buser preference\b|\bprefer(?:ence|s|red)?\b", preference_cues):
            return "preference"
    return "project-fact"


def imported_note_exists(base: Path, source: str, ref: str, body: str) -> bool:
    digest = hashlib.sha256(body.rstrip().encode("utf-8")).hexdigest()
    for path in iter_note_files(base / "inbox"):
        try:
            meta, evidence, existing_body = parse_note(path)
        except Exception:
            continue
        if meta.get("source") != source:
            continue
        refs = {item.get("ref", "") for item in evidence}
        if ref in refs and hashlib.sha256(existing_body.rstrip().encode("utf-8")).hexdigest() == digest:
            return True
    return False


def import_summary(path: Path, text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped and stripped != "---" and not stripped.startswith(("type:", "title:", "description:")):
            return stripped[:SUMMARY_MAX]
    return path.stem.replace("-", " ")[:SUMMARY_MAX]


def native_import_summary(harness: str, path: Path, text: str) -> str:
    if harness == "remember" and path.name != "core-memories.md":
        lines = text.splitlines()[1:]
        for line in lines:
            stripped = line.strip().lstrip("-*# ").strip()
            if stripped:
                return stripped[:SUMMARY_MAX]
    return import_summary(path, text)


def build_native_import(args: argparse.Namespace) -> dict[str, object]:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    root = native_memory_root(args.harness, cwd, args.source_dir)
    files = native_import_files(args.harness, root, args.include_history)
    base = home / "global" if args.scope == "global" else home / "projects" / repo_key
    actions: list[dict[str, str]] = []
    skipped: list[dict[str, str]] = []
    seen_bodies: set[str] = set()
    for path in files:
        for ref, text in native_import_entries(args.harness, path):
            digest = hashlib.sha256(text.rstrip().encode("utf-8")).hexdigest()
            if digest in seen_bodies:
                skipped.append({"source": ref, "reason": "duplicate-content"})
                continue
            seen_bodies.add(digest)
            summary = native_import_summary(args.harness, path, text)
            try:
                check_sensitive(summary, text, ref)
            except MemoryStoreError:
                skipped.append({"source": ref, "reason": "sensitive-content"})
                continue
            note_type = native_import_type(args.harness, path, text)
            if args.only_type and note_type != args.only_type:
                skipped.append({"source": ref, "reason": "type-filter"})
                continue
            if args.match and not any(term.casefold() in f"{ref}\n{text}".casefold() for term in args.match):
                skipped.append({"source": ref, "reason": "match-filter"})
                continue
            if imported_note_exists(base, args.harness, ref, text):
                skipped.append({"source": ref, "reason": "already-imported"})
                continue
            action = {"source": ref, "summary": summary, "type": note_type, "scope": args.scope, "note": ""}
            if args.apply:
                try:
                    target, _ = write_note(
                        home,
                        cwd=cwd,
                        scope=args.scope,
                        priority="auto",
                        note_type=note_type,
                        source=args.harness,
                        confidence="medium",
                        summary=summary,
                        evidence=[{"kind": "repo-file", "ref": ref}],
                        tags=["native-import", args.harness],
                        aliases=[],
                        body=text,
                    )
                except MemoryStoreError as exc:
                    if str(exc) != "sensitive content detected":
                        raise
                    skipped.append({"source": ref, "reason": "sensitive-content"})
                    continue
                action["note"] = str(target)
            actions.append(action)
    return {
        "harness": args.harness,
        "source_dir": str(root),
        "scope": args.scope,
        "include_history": bool(args.include_history),
        "only_type": args.only_type or "",
        "match": args.match or [],
        "actions": actions,
        "skipped": skipped,
        "total": len(actions),
        "applied": bool(args.apply),
    }


def print_native_import(output: dict[str, object], output_format: str) -> None:
    if output_format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
        return
    for action in output["actions"]:
        prefix = "IMPORT" if output["applied"] else "DRY_RUN"
        print(f"{prefix}={action['source']}: {action['summary']}")


def command_import_native(args: argparse.Namespace) -> int:
    output = build_native_import(args)
    if args.format == "json":
        print_native_import(output, args.format)
    else:
        print_native_import(output, args.format)
    return 0


def command_import_existing(args: argparse.Namespace) -> int:
    """Import the useful default subset from every supported existing store."""
    shared = vars(args).copy()
    specs = [
        {"harness": "claude", "scope": "project", "only_type": None, "match": None},
        {"harness": "remember", "scope": "project", "only_type": None, "match": None},
        {"harness": "codex", "scope": "global", "only_type": "preference", "match": ["user preference"]},
    ]
    imports: list[dict[str, object]] = []
    for spec in specs:
        native_args = argparse.Namespace(
            **shared,
            **spec,
            source_dir=None,
            include_history=False,
        )
        imports.append(build_native_import(native_args))
    output = {
        "imports": imports,
        "total": sum(int(item["total"]) for item in imports),
        "applied": bool(args.apply),
    }
    if args.format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        for item in imports:
            print(f"[{item['harness']}] total={item['total']}")
            print_native_import(item, "text")
        print(f"TOTAL={output['total']}")
    return 0


def command_hook(args: argparse.Namespace) -> int:
    """Fail-open prompt hook used by Claude Code and Codex.

    Hook protocols evolve independently from the memory store. Keep this
    boundary deliberately small: tolerate unknown input fields, emit an empty
    object on any failure, and never prevent the host prompt from running.
    """
    try:
        raw = sys.stdin.read() if not args.input else Path(args.input).read_text(encoding="utf-8")
        event = json.loads(raw) if raw.strip() else {}
        if not isinstance(event, dict):
            print("{}")
            return 0
        prompt = str(event.get("prompt") or event.get("user_prompt") or event.get("message") or "")
        cwd = Path(str(event.get("cwd") or os.getcwd())).expanduser().resolve()
        output = build_recall_output(
            memory_home(args),
            cwd,
            prompt,
            include_global_override=False,
            budget_lines=args.budget_lines,
        )
        context = str(output.get("context", ""))
        if not context:
            print("{}")
            return 0
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": context,
                    }
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        print("{}")
    return 0


INTEGRATION_MARKER = "agent-memory-managed"
KNOWN_CONFLICT_TOKENS = ("remember-codex-bridge", "remember@")


def read_json_object(path: Path) -> dict[str, object]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise MemoryStoreError(f"cannot safely merge JSON config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MemoryStoreError(f"JSON config root must be an object: {path}")
    return value


def hook_command(harness: str) -> str:
    helper = shlex.quote(str(Path(__file__).resolve()))
    return f"python3 {helper} hook --harness {harness}"


def managed_hook_entry(harness: str) -> dict[str, object]:
    return {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": hook_command(harness),
                "timeout": 5,
                "statusMessage": f"Recalling shared memory ({INTEGRATION_MARKER})",
            }
        ],
    }


def hook_entry_is_managed(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    hooks = value.get("hooks")
    if not isinstance(hooks, list):
        return False
    return any(
        isinstance(item, dict)
        and INTEGRATION_MARKER in str(item.get("statusMessage", ""))
        and "memory.py" in str(item.get("command", ""))
        for item in hooks
    )


def merge_prompt_hook(config: dict[str, object], harness: str, enabled: bool) -> dict[str, object]:
    updated = json.loads(json.dumps(config))
    hooks = updated.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise MemoryStoreError("hooks config must be an object")
    current = hooks.get("UserPromptSubmit", [])
    if not isinstance(current, list):
        raise MemoryStoreError("hooks.UserPromptSubmit must be a list")
    kept = [entry for entry in current if not hook_entry_is_managed(entry)]
    if enabled:
        kept.append(managed_hook_entry(harness))
    if kept:
        hooks["UserPromptSubmit"] = kept
    else:
        hooks.pop("UserPromptSubmit", None)
    if not hooks:
        updated.pop("hooks", None)
    return updated


def set_toml_feature(text: str, key: str, enabled: bool) -> str:
    """Set one boolean in [features] while preserving all unrelated TOML."""
    lines = text.splitlines()
    start: int | None = None
    end = len(lines)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[features]":
            start = index
            continue
        if start is not None and index > start and re.fullmatch(r"\s*\[[^]]+\]\s*", line):
            end = index
            break
    rendered = f"{key} = {'true' if enabled else 'false'}"
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(["[features]", rendered])
    else:
        replaced = False
        for index in range(start + 1, end):
            if re.match(rf"\s*{re.escape(key)}\s*=", lines[index]):
                indent = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
                lines[index] = indent + rendered
                replaced = True
                break
        if not replaced:
            lines.insert(end, rendered)
    return "\n".join(lines).rstrip() + "\n"


def known_plugin_token(header: str) -> str:
    if not header.strip().startswith("[plugins."):
        return ""
    return next((token for token in KNOWN_CONFLICT_TOKENS if token in header), "")


def enabled_toml_conflicts(text: str) -> set[str]:
    """Return enabled known memory integrations from Codex TOML.

    Plugin trust-state sections may retain the plugin name after a plugin is
    disabled, so substring matching the whole file creates false conflicts.
    """
    lines = text.splitlines()
    conflicts: set[str] = set()
    index = 0
    while index < len(lines):
        token = known_plugin_token(lines[index])
        if token:
            end = index + 1
            enabled = True
            while end < len(lines) and not re.fullmatch(r"\s*\[[^]]+\]\s*", lines[end]):
                match = re.fullmatch(r"\s*enabled\s*=\s*(true|false)\s*(?:#.*)?", lines[end], re.I)
                if match:
                    enabled = match.group(1).lower() == "true"
                end += 1
            if enabled:
                conflicts.add(token)
            index = end
            continue
        match = re.fullmatch(r"\s*[A-Za-z0-9_.-]+\s*=\s*\[(.*)\]\s*(?:#.*)?", lines[index])
        if match:
            for candidate in KNOWN_CONFLICT_TOKENS:
                if candidate in match.group(1):
                    conflicts.add(candidate)
        index += 1
    return conflicts


def remove_known_conflicts_from_toml(text: str) -> str:
    """Disable known plugin tables and remove known one-line hook entries."""
    source = text.splitlines()
    lines: list[str] = []
    index = 0
    while index < len(source):
        line = source[index]
        token = known_plugin_token(line)
        if token:
            end = index + 1
            block = source[index:end]
            while end < len(source) and not re.fullmatch(r"\s*\[[^]]+\]\s*", source[end]):
                block.append(source[end])
                end += 1
            replaced = False
            for block_index in range(1, len(block)):
                if re.match(r"\s*enabled\s*=", block[block_index]):
                    indent = block[block_index][: len(block[block_index]) - len(block[block_index].lstrip())]
                    block[block_index] = indent + "enabled = false"
                    replaced = True
                    break
            if not replaced:
                block.insert(1, "enabled = false")
            lines.extend(block)
            index = end
            continue

        match = re.fullmatch(r"(\s*[A-Za-z0-9_.-]+\s*=\s*)\[(.*)\](\s*(?:#.*)?)", line)
        if match and any(token in match.group(2) for token in KNOWN_CONFLICT_TOKENS):
            items = re.findall(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'', match.group(2))
            kept = [item for item in items if not any(token in item for token in KNOWN_CONFLICT_TOKENS)]
            line = match.group(1) + "[" + ", ".join(kept) + "]" + match.group(3)
        lines.append(line)
        index += 1
    return "\n".join(lines).rstrip() + ("\n" if text else "")


def known_conflicts(paths: list[Path]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for path in paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        tokens = enabled_toml_conflicts(text) if path.name == "config.toml" else {
            token for token in KNOWN_CONFLICT_TOKENS if token in text
        }
        for token in KNOWN_CONFLICT_TOKENS:
            if token not in tokens:
                continue
            findings.append({"path": str(path), "token": token})
    return findings


def adapter_source() -> str:
    path = Path(__file__).resolve().parent.parent / "adapters" / "opencode.js"
    if not path.exists():
        raise MemoryStoreError(f"OpenCode adapter missing: {path}")
    return path.read_text(encoding="utf-8")


def command_integrate(args: argparse.Namespace) -> int:
    home = memory_home(args)
    user_home = Path.home()
    selected = ["claude", "codex", "opencode"] if args.harness == "all" else [args.harness]
    claude_settings = user_home / ".claude" / "settings.json"
    codex_hooks = user_home / ".codex" / "hooks.json"
    codex_config = user_home / ".codex" / "config.toml"
    opencode_plugin = user_home / ".config" / "opencode" / "plugins" / "agent-memory.js"
    conflict_paths = [claude_settings, codex_hooks, codex_config, opencode_plugin]
    conflicts = known_conflicts(conflict_paths)
    blocked = bool(args.mode == "primary" and conflicts and not args.disable_known_conflicts)
    if args.apply and blocked:
        raise MemoryStoreError("known memory integration conflict found; rerun with --disable-known-conflicts after reviewing doctor output")

    planned: dict[Path, str | None] = {}
    enabled = args.mode != "off"
    if "claude" in selected:
        value = merge_prompt_hook(read_json_object(claude_settings), "claude", enabled)
        if args.mode == "primary":
            value["autoMemoryEnabled"] = False
        planned[claude_settings] = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if "codex" in selected:
        value = merge_prompt_hook(read_json_object(codex_hooks), "codex", enabled)
        planned[codex_hooks] = json.dumps(value, indent=2, ensure_ascii=False) + "\n" if value else None
        if args.mode == "primary":
            config_text = codex_config.read_text(encoding="utf-8") if codex_config.exists() else ""
            if args.disable_known_conflicts:
                config_text = remove_known_conflicts_from_toml(config_text)
            planned[codex_config] = set_toml_feature(config_text, "memories", False)
    if "opencode" in selected:
        source = adapter_source()
        if enabled:
            planned[opencode_plugin] = source
        elif opencode_plugin.exists() and opencode_plugin.read_text(encoding="utf-8", errors="replace") == source:
            planned[opencode_plugin] = None

    changes = [
        {"path": str(path), "action": "remove" if content is None else "write"}
        for path, content in planned.items()
        if (content is None and path.exists()) or (content is not None and (not path.exists() or path.read_text(encoding="utf-8", errors="replace") != content))
    ]
    backup: Path | None = None
    if args.apply and changes:
        changed_paths = [Path(item["path"]) for item in changes]
        backup = backup_files(home, changed_paths, "integrations")
        for path, content in planned.items():
            if not any(item["path"] == str(path) for item in changes):
                continue
            if content is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, content)

    output = {
        "mode": args.mode,
        "harnesses": selected,
        "changes": changes,
        "conflicts": conflicts,
        "blocked": blocked,
        "applied": bool(args.apply),
        "backup": str(backup) if backup else "",
    }
    if args.format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        for item in changes:
            print(f"{'APPLY' if args.apply else 'DRY_RUN'}={item['action']} {item['path']}")
        for item in conflicts:
            print(f"CONFLICT={item['path']}: {item['token']}")
        if blocked:
            print("BLOCKED=primary apply requires reviewed conflict handling")
        if backup:
            print(f"BACKUP={backup}")
    return 0


def command_doctor(args: argparse.Namespace) -> int:
    home = memory_home(args)
    user_home = Path.home()
    paths = {
        "claude": user_home / ".claude" / "settings.json",
        "codex_hooks": user_home / ".codex" / "hooks.json",
        "codex_config": user_home / ".codex" / "config.toml",
        "opencode": user_home / ".config" / "opencode" / "plugins" / "agent-memory.js",
    }
    integrations: dict[str, object] = {}
    for name, path in paths.items():
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        integrations[name] = {
            "path": str(path),
            "exists": path.exists(),
            "managed": INTEGRATION_MARKER in text or (name == "opencode" and "AGENT_MEMORY_OPENCODE_ADAPTER" in text),
        }
    output = {
        "memory_home": str(home),
        "index": index_status(home),
        "trusted_repo_keys": sorted(read_trust(home)),
        "integrations": integrations,
        "conflicts": known_conflicts(list(paths.values())),
    }
    if args.format == "json":
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        print(f"memory_home={home}")
        print("index=" + " ".join(f"{key}:{value}" for key, value in output["index"].items()))
        for name, item in integrations.items():
            print(f"integration={name} exists:{item['exists']} managed:{item['managed']} path:{item['path']}")
        for item in output["conflicts"]:
            print(f"conflict={item['path']}: {item['token']}")
    return 0


def command_check(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    errors: list[str] = []
    lock = home / ".lock"
    if lock.exists():
        age = time.time() - lock.stat().st_mtime
        if age > args.stale_lock_seconds:
            errors.append(f"stale lock {lock}")

    for inbox in home.glob("**/inbox"):
        for priority_dir in [inbox / "explicit", inbox / "auto"]:
            files = iter_note_files(priority_dir)
            if len(files) > INBOX_MAX_FILES:
                errors.append(f"too many inbox files {priority_dir}")
            for path in files:
                try:
                    meta, evidence, body = parse_note(path)
                    errors.extend(f"{err} in {path}" for err in validate_note(meta, evidence, body, check_summary_len=True))
                except Exception as exc:
                    errors.append(f"{exc} in {path}")

    for topics_dir in home.glob("**/topics"):
        files = iter_note_files(topics_dir)
        for path in files:
            if path.name in TOPIC_SUPPORT_FILENAMES:
                continue
            errors.extend(f"{err} in topic {path}" for err in validate_topic(path))

    for mem in home.glob("**/MEMORY.md"):
        text = mem.read_text(encoding="utf-8", errors="replace")
        try:
            check_sensitive(text)
        except MemoryStoreError as exc:
            errors.append(f"{exc} in {mem}")
        if len(text.splitlines()) > MEMORY_MAX_LINES:
            errors.append(f"MEMORY.md too long {mem}")

    if errors:
        for err in errors:
            print(f"ERROR={err}", file=sys.stderr)
        print("FAIL agent memory", file=sys.stderr)
        return 1
    print("OK agent memory")
    return 0


def line_has_canonical_id(line: str, wanted: str) -> bool:
    """Match ``id: <wanted>`` only at a token boundary so a truncated id like
    ``mem_2026`` never matches ``id: mem_20260627_ab12cd34``."""
    return re.search(rf"\bid:\s*{re.escape(wanted)}(?![\w])", line) is not None


def strip_canonical_lines(mem: Path, predicate) -> list[str]:
    """Remove canonical MEMORY.md lines matching ``predicate`` and return the
    removed lines so the caller can report exactly what was deleted."""
    lines = mem.read_text(encoding="utf-8").splitlines()
    kept = [line for line in lines if not predicate(line)]
    removed = [line for line in lines if predicate(line)]
    if removed:
        atomic_write(mem, "\n".join(kept) + "\n")
    return removed


def command_forget(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)

    if getattr(args, "id", None):
        removed_files: list[str] = []
        removed_lines: list[str] = []
        with Lock(home):
            for path in home.glob("**/topics/memory/*.md"):
                try:
                    meta, _, _ = parse_durable_record(path)
                except Exception:
                    continue
                if meta.get("id") == args.id:
                    path.unlink()
                    removed_files.append(str(path))
            for mem in home.glob("**/MEMORY.md"):
                if not mem.exists():
                    continue
                gone = strip_canonical_lines(mem, lambda line: line_has_canonical_id(line, args.id))
                if gone:
                    removed_files.append(str(mem))
                    removed_lines.extend(gone)
            if removed_files:
                mark_index_dirty(home)
        for path in removed_files:
            print(f"FORGET={path}")
        for line in removed_lines:
            print(f"REMOVED={line.strip()}")
        if not removed_files:
            raise MemoryStoreError(f"no canonical entry found for id: {args.id}")
        return 0

    all_projects = getattr(args, "all_projects", False)

    if args.note:
        target = Path(args.note).expanduser().resolve()
        if not target.exists():
            raise MemoryStoreError(f"note not found: {target}")
        # Confine to the store: relative_to compares path components, so a sibling
        # like <home>-backup is correctly rejected (a str.startswith prefix check
        # would let it through).
        try:
            target.relative_to(home)
        except ValueError:
            raise MemoryStoreError("note is not in memory store")
        removed_lines = []
        with Lock(home):
            target.unlink()
            # Canonical MEMORY.md is only scrubbed with an explicit --canonical,
            # matching the --summary-only branch below.
            if args.summary and args.canonical:
                for mem in scoped_memory_files(home, repo_key, all_projects):
                    removed_lines.extend(
                        strip_canonical_lines(mem, lambda line: args.summary in line)
                    )
            mark_index_dirty(home)
        print(f"FORGET={target}")
        for line in removed_lines:
            print(f"REMOVED={line.strip()}")
        return 0

    if args.summary:
        removed: list[str] = []
        removed_lines = []
        with Lock(home):
            for base in scoped_bases(home, repo_key, all_projects):
                for path in iter_note_files(base / "inbox"):
                    try:
                        meta, _, _ = parse_note(path)
                        if args.summary in meta.get("summary", ""):
                            path.unlink()
                            removed.append(str(path))
                    except Exception:
                        continue
            if args.canonical:
                for base in scoped_bases(home, repo_key, all_projects):
                    for path in iter_durable_records(base):
                        try:
                            meta, _, _ = parse_durable_record(path)
                        except Exception:
                            continue
                        if args.summary in meta.get("summary", ""):
                            path.unlink()
                            removed.append(str(path))
                for mem in scoped_memory_files(home, repo_key, all_projects):
                    gone = strip_canonical_lines(mem, lambda line: args.summary in line)
                    if gone:
                        removed.append(str(mem))
                        removed_lines.extend(gone)
                if removed:
                    mark_index_dirty(home)
            elif removed:
                mark_index_dirty(home)
        for r in removed:
            print(f"FORGET={r}")
        for line in removed_lines:
            print(f"REMOVED={line.strip()}")
        if not removed:
            raise MemoryStoreError(f"no matching notes found for summary: {args.summary}")
        return 0

    raise MemoryStoreError("must specify --note, --summary, or --id")


def command_verify(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)
    date = args.date or utc_now()[:10]
    updated: list[str] = []

    with Lock(home):
        for path in home.glob("**/topics/memory/*.md"):
            try:
                meta, evidence, body = parse_durable_record(path)
            except Exception:
                continue
            if meta.get("id") != args.id:
                continue
            meta["last_verified"] = date
            meta["updated_at"] = utc_now()
            atomic_write(path, record_topic_text(meta, evidence, body))
            updated.append(str(path))
        for mem in home.glob("**/MEMORY.md"):
            if not mem.exists():
                continue
            changed = False
            new_lines: list[str] = []
            for line in mem.read_text(encoding="utf-8").splitlines():
                if not line_has_canonical_id(line, args.id):
                    new_lines.append(line)
                    continue
                if "last_verified:" in line:
                    line = re.sub(r"last_verified:\s*[^;)]+", f"last_verified: {date}", line)
                elif line.rstrip().endswith(")"):
                    line = line.rstrip()[:-1] + f"; last_verified: {date})"
                else:
                    line = f"{line} (last_verified: {date})"
                changed = True
                new_lines.append(line)
            if changed:
                atomic_write(mem, "\n".join(new_lines) + "\n")
                updated.append(str(mem))
        if updated:
            mark_index_dirty(home)

    for path in updated:
        print(f"VERIFY={path}")
    if not updated:
        raise MemoryStoreError(f"no canonical entry found for id: {args.id}")
    return 0


def command_update(args: argparse.Namespace) -> int:
    """Create a new active version and retain the previous record as superseded."""
    home = memory_home(args)
    wanted: Path | None = None
    old_meta: dict[str, str] | None = None
    old_evidence: list[dict[str, str]] = []
    old_body = ""
    for path in home.glob("**/topics/memory/*.md"):
        try:
            meta, evidence, body = parse_durable_record(path)
        except Exception:
            continue
        if meta.get("id") == args.id:
            wanted, old_meta, old_evidence, old_body = path, meta, evidence, body
            break
    if wanted is None or old_meta is None:
        raise MemoryStoreError(f"no durable record found for id: {args.id}")

    body = args.body
    if body is None and not sys.stdin.isatty():
        body = sys.stdin.read()
    body = old_body if body is None else body
    summary = args.summary or old_meta["summary"]
    confidence = args.confidence or old_meta.get("confidence", "medium")
    aliases = format_tags(args.alias) if args.alias is not None else old_meta.get("aliases", "")
    tags = format_tags(args.tag) if args.tag is not None else old_meta.get("tags", "")
    check_sensitive(summary, body, aliases, tags)

    new_id = memory_id()
    new_path = wanted.with_name(f"{new_id}.md")
    now = utc_now()
    new_meta = dict(old_meta)
    new_meta.update({
        "status": "active",
        "summary": summary,
        "confidence": confidence,
        "id": new_id,
        "created_at": now,
        "updated_at": now,
        "last_verified": now[:10],
        "aliases": aliases,
        "tags": tags,
        "supersedes": args.id,
    })
    old_meta["status"] = "superseded"
    old_meta["updated_at"] = now

    base = wanted.parents[2]
    mem = base / "MEMORY.md"
    title = "Global Memory" if old_meta.get("scope") == "global" else "Project Memory"
    resource = str(new_path.relative_to(base))
    canonical_meta = {
        "id": new_id,
        "confidence": confidence,
        "source_note": old_meta.get("source_note", ""),
        "last_verified": now[:10],
        "resource": resource,
    }
    if tags:
        canonical_meta["tags"] = tags
    bullet = f"- [{old_meta['memory_type']}] {summary} ({canonical_metadata_text(canonical_meta)})"

    with Lock(home):
        atomic_write(wanted, record_topic_text(old_meta, old_evidence, old_body))
        atomic_write(new_path, record_topic_text(new_meta, old_evidence, body))
        existing = mem.read_text(encoding="utf-8") if mem.exists() else ""
        if existing:
            lines = [line for line in existing.splitlines() if not line_has_canonical_id(line, args.id)]
            existing = "\n".join(lines) + "\n"
        updated = build_memory_update(existing, title, bullet, summary, new_path.name)
        if len(updated.splitlines()) <= MEMORY_MAX_LINES:
            atomic_write(mem, updated)
        mark_index_dirty(home)
    print(f"SUPERSEDE={args.id}->{new_id}")
    print(f"RECORD={new_path}")
    return 0


def command_list(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)

    bases = [home / "global"]
    if args.scope == "project":
        bases = [home / "projects" / repo_key]
    elif args.scope is None:
        bases = [home / "global", home / "projects" / repo_key]

    results: list[dict[str, str]] = []
    lines: list[str] = []

    for base in bases:
        for inbox_dir in [base / "inbox" / "explicit", base / "inbox" / "auto"]:
            for path in iter_note_files(inbox_dir):
                try:
                    meta, _, _ = parse_note(path)
                except Exception:
                    continue
                if args.type and meta.get("type") != args.type:
                    continue
                if args.priority and meta.get("priority") != args.priority:
                    continue
                if args.source and meta.get("source") != args.source:
                    continue
                if getattr(args, "format", "text") == "json":
                    results.append(note_to_dict(path))
                else:
                    lines.append(note_summary_line(path))

    fmt = getattr(args, "format", "text")
    if fmt == "json":
        print(json.dumps({"results": results, "total": len(results)}, indent=2, ensure_ascii=False))
    else:
        for line in lines:
            print(line)
    return 0


def command_stats(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)

    stats: dict[str, object] = {
        "global": {"notes": 0, "records": 0, "types": {}, "priorities": {}},
        "project": {"notes": 0, "records": 0, "types": {}, "priorities": {}},
        "total_memory_bytes": 0,
        "index": index_status(home),
    }

    for scope_dir, scope_key in [(home / "global", "global"), (home / "projects" / repo_key, "project")]:
        if not scope_dir.exists():
            continue
        for mem in scope_dir.glob("MEMORY.md"):
            if mem.exists():
                stats["total_memory_bytes"] = stats.get("total_memory_bytes", 0) + mem.stat().st_size
        for inbox_dir in [scope_dir / "inbox" / "explicit", scope_dir / "inbox" / "auto"]:
            for path in iter_note_files(inbox_dir):
                try:
                    meta, _, _ = parse_note(path)
                except Exception:
                    continue
                stats["total_memory_bytes"] = stats.get("total_memory_bytes", 0) + path.stat().st_size
                stats[scope_key]["notes"] = stats[scope_key].get("notes", 0) + 1  # type: ignore
                t = meta.get("type", "unknown")
                stats[scope_key]["types"][t] = stats[scope_key]["types"].get(t, 0) + 1  # type: ignore
                p = meta.get("priority", "unknown")
                stats[scope_key]["priorities"][p] = stats[scope_key]["priorities"].get(p, 0) + 1  # type: ignore
        for topics_file in iter_note_files(scope_dir / "topics"):
            stats["total_memory_bytes"] = stats.get("total_memory_bytes", 0) + topics_file.stat().st_size
            if "topics/memory" in topics_file.as_posix():
                with contextlib.suppress(Exception):
                    meta, _, _ = parse_durable_record(topics_file)
                    if meta.get("status") == "active":
                        stats[scope_key]["records"] = stats[scope_key].get("records", 0) + 1  # type: ignore

    fmt = getattr(args, "format", "text")
    if fmt == "json":
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    else:
        for scope in ["global", "project"]:
            s = stats[scope]
            print(f"{scope}: {s['notes']} notes, {s['records']} active records, types={s['types']}, priorities={s['priorities']}")
        print(f"total_memory_bytes: {stats['total_memory_bytes']}")
    return 0


def source_note_exists(home: Path, source_note: str) -> bool:
    return any(path.name == source_note for path in home.glob("**/inbox/**/*.md"))


def promoted_source_notes(home: Path) -> set[str]:
    promoted: set[str] = set()
    for path in home.glob("**/topics/memory/*.md"):
        try:
            meta, _, _ = parse_durable_record(path)
        except Exception:
            continue
        source_note = meta.get("source_note", "")
        if source_note:
            promoted.add(source_note)
    # Legacy stores may not yet have durable record topics.
    for mem in home.glob("**/MEMORY.md"):
        scope = "global" if mem.parent.name == "global" else "project"
        for record in canonical_records(mem, scope):
            source_note = str(record.get("source_note", ""))
            if source_note:
                promoted.add(source_note)
    return promoted


def review_finding(kind: str, path: Path | str, summary: str, detail: str = "") -> dict[str, str]:
    return {
        "kind": kind,
        "path": str(path),
        "summary": summary,
        "detail": detail,
    }


def command_review(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    findings: list[dict[str, str]] = []
    summaries: dict[str, list[dict[str, object]]] = {}
    promoted_notes = promoted_source_notes(home)
    cutoff = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=args.stale_days)

    for scope_dir, scope in [(home / "global", "global"), (home / "projects" / repo_key, "project")]:
        mem = scope_dir / "MEMORY.md"
        if mem.exists():
            lines = mem.read_text(encoding="utf-8", errors="replace").splitlines()
            if len(lines) > MEMORY_MAX_LINES:
                findings.append(review_finding("overgrown_file", mem, mem.name, f"{len(lines)} lines"))
            for record in canonical_records(mem, scope):
                summary = str(record.get("summary", ""))
                summaries.setdefault(summary, []).append(record)
                if not record.get("id"):
                    findings.append(review_finding("missing_id", mem, summary))
                source_note = str(record.get("source_note", ""))
                if source_note and not source_note_exists(home, source_note):
                    findings.append(review_finding("missing_source_note", mem, summary, source_note))
                last_verified = str(record.get("last_verified", ""))
                if last_verified:
                    with contextlib.suppress(ValueError):
                        verified = dt.date.fromisoformat(last_verified[:10])
                        if verified < cutoff:
                            findings.append(review_finding("stale_canonical", mem, summary, last_verified[:10]))

        for inbox in [scope_dir / "inbox" / "explicit", scope_dir / "inbox" / "auto"]:
            files = iter_note_files(inbox)
            if len(files) > INBOX_MAX_FILES:
                findings.append(review_finding("inbox_pressure", inbox, inbox.name, f"{len(files)} files"))
            for path in files:
                try:
                    meta, evidence, body = parse_note(path)
                except Exception as exc:
                    findings.append(review_finding("invalid_note", path, path.name, str(exc)))
                    continue
                errors = validate_note(meta, evidence, body, check_summary_len=True)
                for err in errors:
                    findings.append(review_finding("invalid_candidate", path, meta.get("summary", path.name), err))
                if not errors and path.name not in promoted_notes and eligible_for_promotion(meta, evidence):
                    findings.append(review_finding("promotion_candidate", path, meta.get("summary", path.name)))

        topics_dir = scope_dir / "topics"
        if topics_dir.exists():
            files = iter_note_files(topics_dir)
            for path in files:
                if path.name in TOPIC_SUPPORT_FILENAMES:
                    continue
                for err in validate_topic(path):
                    findings.append(review_finding("invalid_topic", path, path.name, err))

    for summary, records in summaries.items():
        if summary and len(records) > 1:
            for record in records:
                findings.append(review_finding("duplicate_summary", str(record.get("path", "")), summary))

    if args.format == "json":
        print(json.dumps({"findings": findings, "total": len(findings)}, indent=2, ensure_ascii=False))
    else:
        for item in findings:
            detail = f" {item['detail']}" if item.get("detail") else ""
            print(f"{item['kind']} {item['path']}: {item['summary']}{detail}")
    return 0


def session_id(value: str | None = None) -> str:
    if value:
        return safe_slug(value)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"session-{stamp}-{secrets.token_hex(4)}"


def session_text(meta: dict[str, str], body: str) -> str:
    order = ["session_id", "status", "summary", "created_at", "updated_at", "agent_id", "repo_key"]
    lines = ["---"]
    for key in order:
        value = meta.get(key)
        if value:
            lines.append(f"{key}: {quote_if_needed(value)}")
    lines.extend(["---", "", body.rstrip(), ""])
    return "\n".join(lines)


def parse_frontmatter_value(raw: str) -> str | list[str]:
    value = raw.strip()
    if value.startswith("[") and value.endswith("]"):
        return parse_tags(value)
    return unquote_value(value)


def parse_simple_frontmatter_text(text: str) -> tuple[dict[str, object], str]:
    fm, body = split_frontmatter(text)
    meta: dict[str, object] = {}
    i = 0
    while i < len(fm):
        line = fm[i]
        if not line.strip():
            i += 1
            continue
        if line.strip().startswith("#"):
            i += 1
            continue
        if line.startswith((" ", "\t")):
            raise MemoryStoreError(f"malformed frontmatter line: {line}")
        if ":" not in line:
            raise MemoryStoreError(f"malformed frontmatter line: {line}")
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value:
            meta[key] = parse_frontmatter_value(value)
            i += 1
            continue

        items: list[str] = []
        j = i + 1
        while j < len(fm):
            child = fm[j]
            if not child.strip():
                j += 1
                continue
            if child.strip().startswith("#"):
                j += 1
                continue
            stripped = child.strip()
            if child.startswith((" ", "\t")) and stripped.startswith("- "):
                items.append(unquote_value(stripped[2:]))
                j += 1
                continue
            if child.startswith((" ", "\t")):
                raise MemoryStoreError(f"unsupported frontmatter block line: {child}")
            break
        meta[key] = items if items else ""
        i = j if items else i + 1
    return meta, body


def parse_simple_frontmatter(path: Path) -> tuple[dict[str, object], str]:
    text = path.read_text(encoding="utf-8")
    return parse_simple_frontmatter_text(text)


def validate_topic(path: Path) -> list[str]:
    errors: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        check_sensitive(text)
    except MemoryStoreError as exc:
        errors.append(str(exc))
    try:
        # Durable records carry structured evidence, which is intentionally
        # richer than the simple OKF topic subset.
        if re.search(rf"(?m)^type:\s*{re.escape(RECORD_TOPIC_TYPE)}\s*$", text):
            meta, evidence, body = parse_durable_record(path)
            shadow = dict(meta)
            shadow["type"] = meta.get("memory_type", "")
            errors.extend(validate_note(shadow, evidence, body, check_summary_len=True))
            if meta.get("status") not in {"active", "superseded"}:
                errors.append(f"invalid status {meta.get('status', '')}")
            if not meta.get("updated_at") or not meta.get("last_verified"):
                errors.append("durable record missing updated_at or last_verified")
        else:
            meta, _ = parse_simple_frontmatter_text(text)
            if not meta.get("type"):
                errors.append("missing type")
    except Exception as exc:
        errors.append(str(exc))
    return errors


def session_to_dict(path: Path) -> dict[str, str]:
    meta, body = parse_simple_frontmatter(path)
    return {
        "path": str(path),
        "session_id": meta.get("session_id", path.stem),
        "status": meta.get("status", ""),
        "summary": meta.get("summary", ""),
        "created_at": meta.get("created_at", ""),
        "updated_at": meta.get("updated_at", ""),
        "agent_id": meta.get("agent_id", ""),
        "repo_key": meta.get("repo_key", ""),
        "body": body,
    }


def session_dir(home: Path, repo_key: str) -> Path:
    return home / "projects" / repo_key / "sessions"


def find_session_file(base: Path, wanted: str | None, latest: bool = False) -> Path:
    files = iter_note_files(base)
    if wanted:
        # `save` slugs the id before storing it (session_id -> safe_slug); apply the
        # same slug to the lookup so an id with spaces/uppercase is resumable by the
        # exact string the user passed to save.
        wanted_slug = safe_slug(wanted)
        for path in files:
            try:
                meta, _ = parse_simple_frontmatter(path)
            except Exception:
                continue
            sid = meta.get("session_id")
            if sid == wanted or sid == wanted_slug or path.stem in (wanted, wanted_slug):
                return path
        raise MemoryStoreError(f"session not found: {wanted}")
    if latest and files:
        return max(files, key=lambda path: path.stat().st_mtime)
    raise MemoryStoreError("must specify --id or --latest")


def command_session_save(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)
    body = args.body
    if body is None and not sys.stdin.isatty():
        body = sys.stdin.read()
    body = body or ""
    check_sensitive(args.summary, body)
    now = utc_now()
    sid = session_id(args.id)
    meta = {
        "session_id": sid,
        "status": "active",
        "summary": args.summary,
        "created_at": now,
        "updated_at": now,
        "agent_id": agent_id(),
        "repo_key": repo_key,
    }
    target = session_dir(home, repo_key) / f"{sid}.md"
    with Lock(home):
        atomic_write(target, session_text(meta, body))
    print(f"SESSION={target}")
    return 0


def command_session_list(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    results = []
    for path in iter_note_files(session_dir(home, repo_key)):
        try:
            record = session_to_dict(path)
        except Exception:
            continue
        if args.status and record.get("status") != args.status:
            continue
        results.append(record)
    results.sort(key=lambda item: (item.get("updated_at", ""), item.get("session_id", "")), reverse=True)
    if args.format == "json":
        print(json.dumps({"results": results, "total": len(results)}, indent=2, ensure_ascii=False))
    else:
        for item in results:
            print(f"{item['path']}: [{item['status']}] {item['summary']}")
    return 0


def command_session_resume(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    path = find_session_file(session_dir(home, repo_key), args.id, args.latest)
    record = session_to_dict(path)
    if args.format == "json":
        print(json.dumps(record, indent=2, ensure_ascii=False))
    else:
        print(f"{record['path']}: [{record['status']}] {record['summary']}")
        if record.get("body"):
            print(record["body"].rstrip())
    return 0


def command_session_close(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)
    base = session_dir(home, repo_key)
    path = find_session_file(base, args.id, False)
    meta, body = parse_simple_frontmatter(path)
    meta["status"] = "closed"
    meta["updated_at"] = utc_now()
    with Lock(home):
        atomic_write(path, session_text(meta, body))
    print(f"SESSION={path}")
    return 0


def command_cleanup(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    cutoff = time.time() - (args.older_than_days * 86400)
    removed: list[str] = []
    all_projects = getattr(args, "all_projects", False)
    protected = promoted_source_notes(home)

    def scan() -> None:
        for base in scoped_bases(home, repo_key, all_projects):
            for path in iter_note_files(base / "inbox"):
                try:
                    if path.name in protected:
                        continue
                    if path.stat().st_mtime < cutoff:
                        if args.dry_run:
                            print(f"DRY_RUN={path}")
                        else:
                            path.unlink()
                            removed.append(str(path))
                except OSError:
                    continue

    if args.dry_run or not home.exists():
        scan()
    else:
        with Lock(home):
            scan()
            if removed:
                mark_index_dirty(home)

    if not args.dry_run:
        for r in removed:
            print(f"CLEANUP={r}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local-file agent memory helper")
    parser.add_argument("--memory-home", help="Override memory store root (default: AGENT_MEMORY_HOME or ~/.agents/memory)")
    sub = parser.add_subparsers(dest="command", required=True)

    repo_key = sub.add_parser("repo-key", help="Print stable project key")
    repo_key.add_argument("--cwd", help="Project directory")
    repo_key.set_defaults(func=command_repo_key)

    note = sub.add_parser("note", help="Create an inbox note")
    note.add_argument("--cwd", help="Project directory")
    note.add_argument("--scope", choices=sorted(SCOPES), required=True)
    note.add_argument("--priority", choices=sorted(PRIORITIES), required=True)
    note.add_argument("--type", choices=sorted(TYPES), required=True)
    note.add_argument("--source", choices=sorted(SOURCES), required=True)
    note.add_argument("--confidence", choices=sorted(CONFIDENCES), required=True)
    note.add_argument("--summary", required=True)
    note.add_argument("--evidence", action="append", help="Evidence as kind:reference")
    note.add_argument("--tag", action="append", help="Tag to attach to the note; can be repeated")
    note.add_argument("--alias", action="append", help="Retrieval alias; repeat for Korean/English variants")
    note.add_argument("--body", help="Note body; stdin is used when omitted and piped")
    note.set_defaults(func=command_note)

    promote = sub.add_parser("promote", help="Promote an eligible note to MEMORY.md")
    promote.add_argument("--cwd", help="Project directory")
    promote.add_argument("--note", required=True)
    promote.set_defaults(func=command_promote)

    find = sub.add_parser("find", help="Budgeted memory search")
    find.add_argument("--cwd", help="Project directory")
    find.add_argument("--query", action="append", help="Keyword to search for")
    find.add_argument("--include-auto", action="store_true", help="Include auto inbox notes even without keyword matches")
    find.add_argument("--include-topics", action="store_true", help="Include all topic files even without keyword matches")
    find.add_argument("--budget-lines", type=non_negative_int, default=40)
    find.add_argument("--scope", choices=sorted(SCOPES), default=None, help="Filter by scope")
    find.add_argument("--type", default=None, help="Filter by memory note type or OKF topic type")
    find.add_argument("--priority", choices=sorted(PRIORITIES), default=None, help="Filter by priority")
    find.add_argument("--source", choices=sorted(SOURCES), default=None, help="Filter by source")
    find.add_argument("--since", type=calendar_date, help="Filter records on or after YYYY-MM-DD")
    find.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    find.set_defaults(func=command_find)

    recall = sub.add_parser("recall", help="Retrieve prompt-relevant memory using the rebuildable local index")
    recall.add_argument("--cwd", help="Project directory")
    recall.add_argument("--prompt", required=True, help="Current user prompt")
    recall.add_argument("--harness", choices=["claude", "codex", "opencode", "generic"], default="generic")
    recall.add_argument("--include-global", action="store_true", help="Include global memory even when the repo is not trusted")
    recall.add_argument("--budget-lines", type=non_negative_int, default=DEFAULT_RECALL_RESULTS)
    recall.add_argument("--format", choices=["text", "json"], default="text")
    recall.set_defaults(func=command_recall)

    index = sub.add_parser("index", help="Inspect or rebuild the derived SQLite FTS index")
    index_sub = index.add_subparsers(dest="index_command", required=True)
    for action in ("status", "rebuild"):
        index_action = index_sub.add_parser(action)
        index_action.add_argument("--format", choices=["text", "json"], default="text")
        index_action.set_defaults(func=command_index)

    trust = sub.add_parser("trust", help="Manage repos allowed to receive global-memory recall")
    trust_sub = trust.add_subparsers(dest="trust_command", required=True)
    for action in ("add", "remove", "list"):
        trust_action = trust_sub.add_parser(action)
        trust_action.add_argument("--cwd", help="Project directory")
        trust_action.add_argument("--format", choices=["text", "json"], default="text")
        trust_action.set_defaults(func=command_trust)

    migrate = sub.add_parser("migrate", help="Migrate legacy canonical entries to durable topic records")
    migrate.add_argument("--cwd", help="Project directory")
    migrate.add_argument("--all-projects", action="store_true")
    migrate.add_argument("--apply", action="store_true", help="Apply migration; default is dry-run")
    migrate.add_argument("--format", choices=["text", "json"], default="text")
    migrate.set_defaults(func=command_migrate)

    import_existing = sub.add_parser("import-existing", help="Stage useful existing Claude, Codex, and .remember memory in one pass")
    import_existing.add_argument("--cwd", help="Target project directory")
    import_existing.add_argument("--apply", action="store_true", help="Create all selected candidates; default is dry-run")
    import_existing.add_argument("--format", choices=["text", "json"], default="text")
    import_existing.set_defaults(func=command_import_existing)

    import_native = sub.add_parser("import-native", help="Stage existing agent memory as reviewable candidates")
    import_native.add_argument("--cwd", help="Target project directory")
    import_native.add_argument("--harness", choices=["claude", "codex", "remember"], required=True)
    import_native.add_argument("--source-dir", help="Override native memory directory")
    import_native.add_argument("--scope", choices=sorted(SCOPES), default="project", help="Target scope; default is project")
    import_native.add_argument("--include-history", action="store_true", help="Also consider raw, rollout, or archived history")
    import_native.add_argument("--only-type", choices=sorted(TYPES), help="Stage only candidates classified as this type")
    import_native.add_argument("--match", action="append", help="Stage sources whose path or content contains any repeated match term")
    import_native.add_argument("--apply", action="store_true", help="Create candidates; default is dry-run")
    import_native.add_argument("--format", choices=["text", "json"], default="text")
    import_native.set_defaults(func=command_import_native)

    hook = sub.add_parser("hook", help="Fail-open prompt hook for supported agent harnesses")
    hook.add_argument("--harness", choices=["claude", "codex"], required=True)
    hook.add_argument("--input", help="Read hook JSON from a file instead of stdin")
    hook.add_argument("--budget-lines", type=non_negative_int, default=DEFAULT_RECALL_RESULTS)
    hook.set_defaults(func=command_hook)

    integrate = sub.add_parser("integrate", help="Install or remove prompt-time memory adapters")
    integrate.add_argument("--mode", choices=["shadow", "primary", "off"], required=True)
    integrate.add_argument("--harness", choices=["all", "claude", "codex", "opencode"], default="all")
    integrate.add_argument("--disable-known-conflicts", action="store_true", help="Disable recognized one-line Codex memory hooks in primary mode")
    integrate.add_argument("--apply", action="store_true", help="Apply changes; default is dry-run")
    integrate.add_argument("--format", choices=["text", "json"], default="text")
    integrate.set_defaults(func=command_integrate)

    doctor = sub.add_parser("doctor", help="Report index, trust, adapter, and integration-conflict status")
    doctor.add_argument("--format", choices=["text", "json"], default="text")
    doctor.set_defaults(func=command_doctor)

    forget = sub.add_parser("forget", help="Remove a memory note or canonical entry")
    forget.add_argument("--cwd", help="Project directory")
    forget.add_argument("--note", help="Path to the note file to delete")
    forget.add_argument("--summary", help="Summary text to match for deletion")
    forget.add_argument("--id", help="Canonical memory id to remove")
    forget.add_argument("--canonical", action="store_true", help="Also remove matching entries from MEMORY.md")
    forget.add_argument("--all-projects", action="store_true", help="Match across every project (default: current repo + global only)")
    forget.set_defaults(func=command_forget)

    verify = sub.add_parser("verify", help="Update last_verified on a canonical memory entry")
    verify.add_argument("--cwd", help="Project directory")
    verify.add_argument("--id", required=True, help="Canonical memory id to verify")
    verify.add_argument("--date", type=calendar_date, help="Verification date in YYYY-MM-DD format; defaults to today")
    verify.set_defaults(func=command_verify)

    for command_name in ("update", "supersede"):
        update = sub.add_parser(command_name, help="Create a new version that supersedes a durable memory record")
        update.add_argument("--id", required=True)
        update.add_argument("--summary")
        update.add_argument("--confidence", choices=sorted(CONFIDENCES))
        update.add_argument("--tag", action="append")
        update.add_argument("--alias", action="append")
        update.add_argument("--body", help="Replacement body; stdin is used when omitted and piped")
        update.set_defaults(func=command_update)

    list_cmd = sub.add_parser("list", help="List memory notes")
    list_cmd.add_argument("--cwd", help="Project directory")
    list_cmd.add_argument("--scope", choices=["global", "project"], default=None, help="Filter by scope")
    list_cmd.add_argument("--type", choices=sorted(TYPES), default=None, help="Filter by type")
    list_cmd.add_argument("--priority", choices=sorted(PRIORITIES), default=None, help="Filter by priority")
    list_cmd.add_argument("--source", choices=sorted(SOURCES), default=None, help="Filter by source")
    list_cmd.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    list_cmd.set_defaults(func=command_list)

    stats = sub.add_parser("stats", help="Show memory store statistics")
    stats.add_argument("--cwd", help="Project directory")
    stats.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    stats.set_defaults(func=command_stats)

    review = sub.add_parser("review", help="Review memory health and maintenance candidates without mutating")
    review.add_argument("--cwd", help="Project directory")
    review.add_argument("--stale-days", type=non_negative_int, default=90, help="Report canonical entries older than N days")
    review.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    review.set_defaults(func=command_review)

    propose = sub.add_parser("propose", help="Stage automatic memory candidates from session text")
    propose.add_argument("--cwd", help="Project directory")
    propose.add_argument("--scope", choices=sorted(SCOPES), default="project")
    propose.add_argument("--source", choices=sorted(SOURCES), default="session")
    propose.add_argument("--tag", action="append", help="Tag to attach to proposed notes; can be repeated")
    propose.add_argument("--input", help="Text file to scan; stdin is used when omitted and piped")
    propose.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    propose.set_defaults(func=command_propose)

    session = sub.add_parser("session", help="Manage project session handoff notes")
    session_sub = session.add_subparsers(dest="session_command", required=True)

    session_save = session_sub.add_parser("save", help="Save or replace a session handoff")
    session_save.add_argument("--cwd", help="Project directory")
    session_save.add_argument("--id", help="Stable session id; generated when omitted")
    session_save.add_argument("--summary", required=True)
    session_save.add_argument("--body", help="Session body; stdin is used when omitted and piped")
    session_save.set_defaults(func=command_session_save)

    session_list = session_sub.add_parser("list", help="List project session handoffs")
    session_list.add_argument("--cwd", help="Project directory")
    session_list.add_argument("--status", choices=["active", "closed"], default=None)
    session_list.add_argument("--format", choices=["text", "json"], default="text")
    session_list.set_defaults(func=command_session_list)

    session_resume = session_sub.add_parser("resume", help="Read a project session handoff")
    session_resume.add_argument("--cwd", help="Project directory")
    session_resume.add_argument("--id", help="Session id to read")
    session_resume.add_argument("--latest", action="store_true", help="Read the newest session")
    session_resume.add_argument("--format", choices=["text", "json"], default="text")
    session_resume.set_defaults(func=command_session_resume)

    session_close = session_sub.add_parser("close", help="Mark a project session handoff closed")
    session_close.add_argument("--cwd", help="Project directory")
    session_close.add_argument("--id", required=True, help="Session id to close")
    session_close.set_defaults(func=command_session_close)

    cleanup = sub.add_parser("cleanup", help="Remove old inbox notes")
    cleanup.add_argument("--cwd", help="Project directory")
    cleanup.add_argument("--older-than-days", type=non_negative_int, default=90, help="Remove notes older than N days")
    cleanup.add_argument("--dry-run", action="store_true", help="Show what would be removed without deleting")
    cleanup.add_argument("--all-projects", action="store_true", help="Prune across every project (default: current repo + global only)")
    cleanup.set_defaults(func=command_cleanup)

    check = sub.add_parser("check", help="Validate memory store")
    check.add_argument("--cwd", help="Project directory")
    check.add_argument("--stale-lock-seconds", type=non_negative_int, default=600)
    check.set_defaults(func=command_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except MemoryStoreError as exc:
        print(f"ERROR={exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        # Missing files, permission errors, etc. must surface as a one-line
        # ERROR= for agents driving this tool blindly, not a raw traceback.
        print(f"ERROR={exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR=interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
