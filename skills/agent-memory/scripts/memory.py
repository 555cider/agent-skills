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
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit


TYPES = {"preference", "project-fact", "decision", "command", "caveat", "handoff"}
SCOPES = {"global", "project"}
PRIORITIES = {"explicit", "auto"}
SOURCES = {"user", "repo", "command", "session"}
CONFIDENCES = {"high", "medium", "low"}
PROMOTABLE_AUTO_TYPES = {"project-fact", "command", "caveat"}
PROMOTABLE_EVIDENCE_KINDS = {"command", "repo-file", "test-result"}
SUMMARY_MAX = 240
MEMORY_MAX_LINES = 120
INBOX_MAX_FILES = 500

SENSITIVE_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*\S{8,}", re.I),
]


class MemoryError(Exception):
    pass


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
            raise MemoryError("sensitive content detected")


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
    return value


def parse_evidence_arg(raw: str) -> dict[str, str]:
    if ":" in raw:
        kind, ref = raw.split(":", 1)
    else:
        kind, ref = raw, raw
    return {"kind": kind.strip(), "ref": ref.strip()}


def parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [tag.strip() for tag in raw.split(",") if tag.strip()]


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
                age = time.time() - self.path.stat().st_mtime
                if age > self.stale_seconds:
                    shutil.rmtree(self.path, ignore_errors=True)
                    continue
                if time.time() >= deadline:
                    raise MemoryError("memory locked by another process")
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


def split_frontmatter(text: str) -> tuple[list[str], str]:
    if not text.startswith("---\n"):
        raise MemoryError("missing frontmatter")
    end = text.find("\n---", 4)
    if end < 0:
        raise MemoryError("unterminated frontmatter")
    fm = text[4:end].splitlines()
    body = text[end + 4 :].lstrip("\n")
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
        if line == "evidence:":
            i += 1
            current: dict[str, str] | None = None
            while i < len(fm) and fm[i].startswith("  "):
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
            raise MemoryError(f"malformed frontmatter line: {line}")
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
    except MemoryError as exc:
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
        raise MemoryError("project memory requires repo_key")
    return home / "projects" / repo_key / "MEMORY.md"


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
    if repo_key:
        meta["repo_key"] = repo_key

    target_dir = home / ("global" if scope == "global" else f"projects/{repo_key}") / "inbox" / priority
    stem = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    filename = f"{stem}_{meta['agent_id']}_{secrets.token_hex(4)}.md"
    target = target_dir / filename
    with Lock(home):
        atomic_write(target, note_text(meta, evidence, body))
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
        if "user correction" in lowered or "prefer" in lowered or "preference" in lowered:
            proposals.append({
                "type": "preference",
                "confidence": "medium",
                "summary": proposal_summary(line),
                "evidence": [],
                "tags": list(default_tags),
                "body": line,
            })
            continue

        if (
            "repeated failure" in lowered
            or "lesson learned" in lowered
            or "verified" in lowered
            or "run " in lowered
            or "restart " in lowered
            or "command" in lowered
        ):
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
    ensure_layout(home, compute_repo_key(cwd) if args.scope == "project" else None)
    if args.input:
        text = Path(args.input).expanduser().read_text(encoding="utf-8")
    elif not sys.stdin.isatty():
        text = sys.stdin.read()
    else:
        raise MemoryError("propose requires --input or piped stdin")

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


def build_memory_update(existing: str, title: str, bullet: str, summary: str, source_note: str) -> str:
    if summary in existing or f"source_note: {source_note}" in existing:
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
    note = Path(args.note).expanduser().resolve()
    meta, evidence, body = parse_note(note)
    errors = validate_note(meta, evidence, body, check_summary_len=True)
    if errors:
        raise MemoryError("; ".join(errors))
    if not eligible_for_promotion(meta, evidence):
        raise MemoryError("note is not eligible for promotion")

    repo_key = meta.get("repo_key") or (compute_repo_key(cwd_from_args(args)) if meta.get("scope") == "project" else None)
    ensure_layout(home, repo_key)
    dest = memory_path(home, meta["scope"], repo_key)
    title = "Global Memory" if meta["scope"] == "global" else "Project Memory"
    date = meta.get("created_at", utc_now())[:10]
    source_note = note.name
    canonical_meta = {
        "id": memory_id(date),
        "confidence": meta["confidence"],
        "source_note": source_note,
        "last_verified": date,
    }
    if meta.get("tags"):
        canonical_meta["tags"] = meta["tags"]
    bullet = (
        f"- [{meta['type']}] {meta['summary']} "
        f"({canonical_metadata_text(canonical_meta)})"
    )
    with Lock(home):
        existing = dest.read_text(encoding="utf-8") if dest.exists() else ""
        updated = build_memory_update(existing, title, bullet, meta["summary"], source_note)
        if updated != existing:
            atomic_write(dest, updated)
    print(f"PROMOTE={dest}")
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
    summary = ""
    for line in text.splitlines():
        if line.strip():
            summary = line.strip()
            break
    return {
        "kind": "topic",
        "scope": scope,
        "path": str(path),
        "summary": summary,
        "text": text,
    }


def record_date(record: dict[str, object]) -> str:
    value = str(record.get("created_at") or record.get("last_verified") or "")
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
    kind_weight = {"canonical": 40, "explicit": 35, "topic": 20, "auto": 10}.get(str(record.get("kind")), 0)
    scope_weight = 15 if record.get("scope") == "project" else 0
    fields = {
        "summary": str(record.get("summary", "")),
        "tags": " ".join(record.get("tags", [])) if isinstance(record.get("tags"), list) else str(record.get("tags", "")),
        "body": str(record.get("body", "")),
        "text": str(record.get("text", "")),
        "evidence": evidence_text(record),
        "type": str(record.get("type", "")),
        "source": str(record.get("source", "")),
    }
    boosts = {
        "summary": 100,
        "tags": 80,
        "body": 45,
        "text": 45,
        "evidence": 30,
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
    ensure_layout(home, repo_key)
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
            text = path.read_text(encoding="utf-8", errors="replace")
            if keyword_match(text, queries):
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


def command_check(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)
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

    for mem in home.glob("**/MEMORY.md"):
        text = mem.read_text(encoding="utf-8", errors="replace")
        try:
            check_sensitive(text)
        except MemoryError as exc:
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


def command_forget(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)

    if getattr(args, "id", None):
        removed: list[str] = []
        with Lock(home):
            for mem in home.glob("**/MEMORY.md"):
                if not mem.exists():
                    continue
                lines = mem.read_text(encoding="utf-8").splitlines()
                new_lines = [line for line in lines if f"id: {args.id}" not in line]
                if len(new_lines) < len(lines):
                    atomic_write(mem, "\n".join(new_lines) + "\n")
                    removed.append(str(mem))
        for path in removed:
            print(f"FORGET={path}")
        if not removed:
            raise MemoryError(f"no canonical entry found for id: {args.id}")
        return 0

    if args.note:
        target = Path(args.note).expanduser().resolve()
        if not target.exists():
            raise MemoryError(f"note not found: {target}")
        if not str(target).startswith(str(home)):
            raise MemoryError("note is not in memory store")
        with Lock(home):
            target.unlink()
            if args.summary:
                for mem in home.glob("**/MEMORY.md"):
                    if mem.exists():
                        existing = mem.read_text(encoding="utf-8")
                        updated = existing.replace(f"- ", f"- ", 1)
                        lines = existing.splitlines()
                        new_lines = [l for l in lines if args.summary not in l]
                        if len(new_lines) < len(lines):
                            atomic_write(mem, "\n".join(new_lines) + "\n")
        print(f"FORGET={target}")
        return 0

    if args.summary:
        removed: list[str] = []
        with Lock(home):
            for inbox_dir in home.glob("**/inbox/**"):
                if not inbox_dir.is_dir():
                    continue
                for path in iter_note_files(inbox_dir):
                    try:
                        meta, _, _ = parse_note(path)
                        if args.summary in meta.get("summary", ""):
                            path.unlink()
                            removed.append(str(path))
                    except Exception:
                        continue
            if args.canonical:
                for mem in home.glob("**/MEMORY.md"):
                    if mem.exists():
                        existing = mem.read_text(encoding="utf-8")
                        lines = existing.splitlines()
                        new_lines = [l for l in lines if args.summary not in l]
                        if len(new_lines) < len(lines):
                            atomic_write(mem, "\n".join(new_lines) + "\n")
                            removed.append(str(mem))
        for r in removed:
            print(f"FORGET={r}")
        if not removed:
            raise MemoryError(f"no matching notes found for summary: {args.summary}")
        return 0

    raise MemoryError("must specify --note, --summary, or --id")


def command_verify(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)
    date = args.date or utc_now()[:10]
    updated: list[str] = []

    with Lock(home):
        for mem in home.glob("**/MEMORY.md"):
            if not mem.exists():
                continue
            changed = False
            new_lines: list[str] = []
            for line in mem.read_text(encoding="utf-8").splitlines():
                if f"id: {args.id}" not in line:
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

    for path in updated:
        print(f"VERIFY={path}")
    if not updated:
        raise MemoryError(f"no canonical entry found for id: {args.id}")
    return 0


def command_list(args: argparse.Namespace) -> int:
    home = memory_home(args)
    cwd = cwd_from_args(args)
    repo_key = compute_repo_key(cwd)
    ensure_layout(home, repo_key)

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
    ensure_layout(home, repo_key)

    stats: dict[str, object] = {
        "global": {"notes": 0, "types": {}, "priorities": {}},
        "project": {"notes": 0, "types": {}, "priorities": {}},
        "total_memory_bytes": 0,
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
                stats[scope_key]["notes"] = stats[scope_key].get("notes", 0) + 1  # type: ignore
                t = meta.get("type", "unknown")
                stats[scope_key]["types"][t] = stats[scope_key]["types"].get(t, 0) + 1  # type: ignore
                p = meta.get("priority", "unknown")
                stats[scope_key]["priorities"][p] = stats[scope_key]["priorities"].get(p, 0) + 1  # type: ignore
        for topics_file in iter_note_files(scope_dir / "topics"):
            stats["total_memory_bytes"] = stats.get("total_memory_bytes", 0) + topics_file.stat().st_size

    fmt = getattr(args, "format", "text")
    if fmt == "json":
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    else:
        for scope in ["global", "project"]:
            s = stats[scope]
            print(f"{scope}: {s['notes']} notes, types={s['types']}, priorities={s['priorities']}")
        print(f"total_memory_bytes: {stats['total_memory_bytes']}")
    return 0


def source_note_exists(home: Path, source_note: str) -> bool:
    return any(path.name == source_note for path in home.glob("**/inbox/**/*.md"))


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
    ensure_layout(home, repo_key)
    findings: list[dict[str, str]] = []
    summaries: dict[str, list[dict[str, object]]] = {}
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
                if not errors and eligible_for_promotion(meta, evidence):
                    findings.append(review_finding("promotion_candidate", path, meta.get("summary", path.name)))

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


def parse_simple_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)
    meta: dict[str, str] = {}
    for line in fm:
        if not line.strip():
            continue
        if ":" not in line:
            raise MemoryError(f"malformed frontmatter line: {line}")
        key, value = line.split(":", 1)
        meta[key.strip()] = unquote_value(value)
    return meta, body


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
        for path in files:
            try:
                meta, _ = parse_simple_frontmatter(path)
            except Exception:
                continue
            if meta.get("session_id") == wanted or path.stem == wanted:
                return path
        raise MemoryError(f"session not found: {wanted}")
    if latest and files:
        return max(files, key=lambda path: path.stat().st_mtime)
    raise MemoryError("must specify --id or --latest")


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
    ensure_layout(home, repo_key)
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
    ensure_layout(home, repo_key)
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
    ensure_layout(home, repo_key)

    cutoff = time.time() - (args.older_than_days * 86400)
    removed: list[str] = []

    with Lock(home):
        for inbox_dir in home.glob("**/inbox/**"):
            if not inbox_dir.is_dir():
                continue
            for path in iter_note_files(inbox_dir):
                try:
                    mtime = path.stat().st_mtime
                    if mtime < cutoff:
                        if args.dry_run:
                            print(f"DRY_RUN={path}")
                        else:
                            path.unlink()
                            removed.append(str(path))
                except OSError:
                    continue

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
    find.add_argument("--budget-lines", type=int, default=40)
    find.add_argument("--scope", choices=sorted(SCOPES), default=None, help="Filter by scope")
    find.add_argument("--type", choices=sorted(TYPES), default=None, help="Filter by type")
    find.add_argument("--priority", choices=sorted(PRIORITIES), default=None, help="Filter by priority")
    find.add_argument("--source", choices=sorted(SOURCES), default=None, help="Filter by source")
    find.add_argument("--since", help="Filter records on or after YYYY-MM-DD")
    find.add_argument("--format", choices=["text", "json"], default="text", help="Output format")
    find.set_defaults(func=command_find)

    forget = sub.add_parser("forget", help="Remove a memory note or canonical entry")
    forget.add_argument("--cwd", help="Project directory")
    forget.add_argument("--note", help="Path to the note file to delete")
    forget.add_argument("--summary", help="Summary text to match for deletion")
    forget.add_argument("--id", help="Canonical memory id to remove")
    forget.add_argument("--canonical", action="store_true", help="Also remove matching entries from MEMORY.md")
    forget.set_defaults(func=command_forget)

    verify = sub.add_parser("verify", help="Update last_verified on a canonical memory entry")
    verify.add_argument("--cwd", help="Project directory")
    verify.add_argument("--id", required=True, help="Canonical memory id to verify")
    verify.add_argument("--date", help="Verification date in YYYY-MM-DD format; defaults to today")
    verify.set_defaults(func=command_verify)

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
    review.add_argument("--stale-days", type=int, default=90, help="Report canonical entries older than N days")
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
    cleanup.add_argument("--older-than-days", type=int, default=90, help="Remove notes older than N days")
    cleanup.add_argument("--dry-run", action="store_true", help="Show what would be removed without deleting")
    cleanup.set_defaults(func=command_cleanup)

    check = sub.add_parser("check", help="Validate memory store")
    check.add_argument("--cwd", help="Project directory")
    check.add_argument("--stale-lock-seconds", type=int, default=600)
    check.set_defaults(func=command_check)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except MemoryError as exc:
        print(f"ERROR={exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("ERROR=interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
