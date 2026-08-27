from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterator, Sequence

from .constants import (
    EVENT_KINDS,
    EVENT_SCHEMA,
    EXPORT_SCHEMA,
    EXPORT_SCOPES,
    HANDOFF_TTL_DAYS,
    HARNESSES,
    IMPORT_BATCH_EVIDENCE,
    IMPORT_EVIDENCE_PREFIX,
    MAX_EVENT_TEXT,
    MAX_JOB_ATTEMPTS,
    MEMORY_KINDS,
    MEMORY_STATES,
    PROCEDURE_STALE_DAYS,
    RAW_CHAT_TTL_DAYS,
    RECORD_SCHEMA,
    SCOPES,
    TOMBSTONE_TTL_DAYS,
    TOOL_OUTPUT_LIMIT_BYTES,
)
from .db import Database
from .models import Candidate
from .providers import NullProvider, Provider, ProviderError, provider_from_env
from .redaction import redact_text, redact_value
from .util import (
    MemoryError,
    digest_text,
    head_tail,
    jsonable_row,
    normalize_text,
    repo_key,
    semantic_tokens,
    stable_json,
    utc_after,
    utc_now,
    word_tokens,
)


def content_digest(candidate: Candidate, project: str | None) -> str:
    """Identity of a memory's content, independent of when or how it was stored.

    Import relies on this being the *only* notion of sameness: record ids are
    reissued on the way in, so an export replayed into the store it came from
    has to collapse onto the existing rows rather than duplicate them.
    """

    return digest_text(
        stable_json(
            {
                "kind": candidate.kind,
                "scope": candidate.scope,
                "repo_key": project,
                "statement": normalize_text(candidate.statement),
                "conditions": sorted(candidate.conditions),
                "paths": sorted(candidate.path_globs),
            }
        )
    )


def _json_list(raw: str | None) -> list[Any]:
    try:
        value = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def record_from_row(db: Database, row: sqlite3.Row, *, include_evidence: bool = True) -> dict[str, Any]:
    record = jsonable_row(row)
    record["schema"] = record.pop("schema_name", RECORD_SCHEMA)
    record["path_globs"] = _json_list(record.pop("path_globs_json", "[]"))
    record["conditions"] = _json_list(record.pop("conditions_json", "[]"))
    if include_evidence:
        evidence = db.conn.execute(
            "SELECT id,event_id,kind,summary,command,exit_status,created_at "
            "FROM evidence WHERE memory_id=? ORDER BY created_at",
            (record["id"],),
        ).fetchall()
        record["evidence"] = [jsonable_row(item) for item in evidence]
    return record


def remote_event(event: dict[str, Any]) -> dict[str, Any]:
    """Return the only event fields an external model may receive.

    File contents and raw tool output are intentionally impossible to select
    here: callers pass normalized events and this function constructs a new
    allowlisted object.
    """

    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    output: dict[str, Any] = {
        "id": event.get("id", ""),
        "kind": event.get("kind", ""),
        "harness": event.get("harness", ""),
    }
    if event.get("kind") == "user_prompt":
        output["prompt"] = str(payload.get("prompt", ""))
    elif event.get("kind") == "assistant_stop":
        output["assistant_response"] = str(payload.get("assistant_response", ""))
    elif event.get("kind") == "tool_completed":
        output.update(
            {
                "tool_name": str(payload.get("tool_name", "")),
                "command": str(payload.get("command", "")),
                "exit_status": payload.get("exit_status"),
            }
        )
    elif event.get("kind") == "session_end":
        output["assistant_response"] = str(payload.get("assistant_response", ""))
    return output


def _transcript_last_assistant(path_value: Any) -> str:
    """Best-effort final assistant text from a harness transcript tail.

    Claude Code's SessionEnd hook carries no message text, only
    ``transcript_path``; without this the handoff channel stays empty.
    """

    try:
        raw_path = str(path_value or "").strip()
        if not raw_path:
            return ""
        path = Path(raw_path)
        if not path.is_file():
            return ""
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 262_144))
            text = handle.read().decode("utf-8", errors="replace")
        for line in reversed(text.splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            message = entry.get("message") if isinstance(entry.get("message"), dict) else entry
            if message.get("role") != "assistant" and entry.get("type") != "assistant":
                continue
            content = message.get("content")
            if isinstance(content, str) and content.strip():
                return content
            if isinstance(content, list):
                parts = [
                    str(part.get("text", ""))
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                ]
                joined = "\n".join(part for part in parts if part)
                if joined.strip():
                    return joined
        return ""
    except Exception:
        return ""


class MemoryService:
    def __init__(self, db: Database, provider: Provider | None = None) -> None:
        self.db = db
        self.provider = provider if provider is not None else provider_from_env()

    # ------------------------------------------------------------------ events
    def _session_paused(self, session_id: str, harness: str, project: str) -> bool:
        wildcard = f"*:{harness}:{project}"
        row = self.db.conn.execute(
            "SELECT max(paused) FROM sessions WHERE session_id IN (?,?)", (session_id, wildcard)
        ).fetchone()
        return bool(row and row[0])

    @staticmethod
    def _session_key(value: str, harness: str, project: str) -> str:
        if re.fullmatch(r"ses_[0-9a-f]{28}", value):
            return value
        identity = stable_json({"harness": harness, "repo": project, "id": value})
        return f"ses_{digest_text(identity)[:28]}"

    @classmethod
    def _session_id(cls, data: dict[str, Any], harness: str, project: str) -> str:
        for key in ("session_id", "sessionID", "conversation_id", "conversationId"):
            value = data.get(key)
            if value:
                return cls._session_key(str(value)[:500], harness, project)
        return cls._session_key("implicit", harness, project)

    @staticmethod
    def _event_id(data: dict[str, Any], session_id: str, kind: str, payload: dict[str, Any]) -> str:
        for key in (
            "event_id",
            "eventID",
            "prompt_id",
            "promptId",
            "promptID",
            "tool_use_id",
            "toolUseID",
            "call_id",
            "callID",
            "id",
            "hook_id",
            "hookId",
        ):
            value = data.get(key)
            if value:
                identity = stable_json(
                    {"session": session_id, "kind": kind, "source_id": str(value)}
                )
                return f"evt_{digest_text(identity)[:28]}"
        fingerprint = stable_json({"session": session_id, "kind": kind, "payload": payload})
        return f"evt_{digest_text(fingerprint)[:28]}"

    @staticmethod
    def normalize_hook_kind(value: str) -> str:
        compact = re.sub(r"[^a-z]", "", value.casefold())
        mapping = {
            "sessionstart": "session_start",
            "userpromptsubmit": "user_prompt",
            "userprompt": "user_prompt",
            "chatmessage": "user_prompt",
            "posttooluse": "tool_completed",
            "toolcompleted": "tool_completed",
            "toolexecuteafter": "tool_completed",
            "stop": "assistant_stop",
            "assistantstop": "assistant_stop",
            "messageupdated": "assistant_stop",
            "sessionend": "session_end",
            "sessionidle": "session_end",
        }
        return mapping.get(compact, value)

    @staticmethod
    def _exit_status(data: dict[str, Any], response: Any) -> int | None:
        keys = ("exit_status", "exit_code", "exitCode", "returncode", "status")
        values: list[Any] = [data.get(key) for key in keys]
        if isinstance(response, dict):
            values.extend(response.get(key) for key in keys)
        for value in values:
            if isinstance(value, bool):
                continue
            if isinstance(value, int):
                return value
            if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
                return int(value)
        return None

    def _normalize_payload(self, kind: str, data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        findings: list[str] = []
        if kind == "user_prompt":
            prompt = data.get("prompt") or data.get("user_prompt") or data.get("message") or ""
            if isinstance(prompt, dict):
                prompt = prompt.get("content") or prompt.get("text") or ""
            result = redact_text(head_tail(str(prompt), MAX_EVENT_TEXT))
            return {"prompt": result.value}, list(result.findings)
        if kind == "assistant_stop":
            message = (
                data.get("last_assistant_message")
                or data.get("assistant_response")
                or data.get("message")
                or ""
            )
            if isinstance(message, dict):
                message = message.get("content") or message.get("text") or ""
            result = redact_text(head_tail(str(message), MAX_EVENT_TEXT))
            return {"assistant_response": result.value}, list(result.findings)
        if kind == "tool_completed":
            tool_input = data.get("tool_input") or data.get("input") or {}
            # Claude Code delivers the result as tool_output; Codex/OpenCode
            # variants use tool_response/output/result.
            response = (
                data.get("tool_response")
                or data.get("tool_output")
                or data.get("output")
                or data.get("result")
                or ""
            )
            command = ""
            if isinstance(tool_input, dict):
                command = str(
                    tool_input.get("command")
                    or tool_input.get("cmd")
                    or tool_input.get("script")
                    or ""
                )
            if not command:
                command = str(data.get("command") or data.get("cmd") or "")
            if isinstance(response, (dict, list)):
                response_text = stable_json(response)
            else:
                response_text = str(response)
            payload = {
                "tool_name": str(data.get("tool_name") or data.get("tool") or data.get("name") or ""),
                "command": head_tail(command, 4096),
                "exit_status": self._exit_status(data, response),
                "output": head_tail(response_text, TOOL_OUTPUT_LIMIT_BYTES),
            }
            if isinstance(data.get("memory_hint"), dict):
                payload["memory_hint"] = data["memory_hint"]
            redacted, findings = redact_value(payload)
            return dict(redacted), findings
        if kind == "session_end":
            message = data.get("last_assistant_message") or data.get("summary") or ""
            if isinstance(message, dict):
                message = message.get("content") or message.get("text") or ""
            if not str(message).strip():
                message = _transcript_last_assistant(data.get("transcript_path"))
            result = redact_text(head_tail(str(message), MAX_EVENT_TEXT))
            return {"assistant_response": result.value}, list(result.findings)
        redacted, findings = redact_value(data.get("payload") or {})
        return dict(redacted) if isinstance(redacted, dict) else {}, findings

    def capture_event(
        self,
        *,
        harness: str,
        kind: str,
        data: dict[str, Any],
        cwd: Path,
    ) -> dict[str, Any]:
        harness = harness.casefold()
        if harness not in HARNESSES:
            raise MemoryError(f"unsupported harness: {harness}")
        kind = self.normalize_hook_kind(kind)
        if kind not in EVENT_KINDS:
            raise MemoryError(f"unsupported event kind: {kind}")
        project = repo_key(cwd)
        session_id = self._session_id(data, harness, project)
        if self._session_paused(session_id, harness, project):
            return {"captured": False, "paused": True, "session_id": session_id}
        payload, findings = self._normalize_payload(kind, data)
        event_id = self._event_id(data, session_id, kind, payload)
        created_at = utc_now()
        ttl = HANDOFF_TTL_DAYS if kind == "session_end" else RAW_CHAT_TTL_DAYS
        blob = self.db.encode_payload(payload)
        digest = hashlib.sha256(blob).hexdigest()
        with self.db.transaction(immediate=True):
            # Opportunistic TTL enforcement keeps retention bounded without a
            # resident daemon. Explicit `gc` remains available for idle stores.
            self.db.conn.execute("DELETE FROM events WHERE expires_at<=?", (created_at,))
            self.db.conn.execute("DELETE FROM tombstones WHERE expires_at<=?", (created_at,))
            cursor = self.db.conn.execute(
                "INSERT OR IGNORE INTO events("
                "id,schema_name,session_id,harness,kind,repo_key,payload_zlib,payload_sha256,"
                "redactions_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    event_id,
                    EVENT_SCHEMA,
                    session_id,
                    harness,
                    kind,
                    project,
                    blob,
                    digest,
                    stable_json(sorted(set(findings))),
                    created_at,
                    utc_after(days=ttl),
                ),
            )
            self.db.conn.execute(
                "INSERT INTO sessions(session_id,harness,repo_key,paused,created_at,updated_at) "
                "VALUES(?,?,?,0,?,?) ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at",
                (session_id, harness, project, created_at, created_at),
            )
            inserted = cursor.rowcount > 0
            if kind in {"assistant_stop", "session_end"}:
                self.db.conn.execute(
                    "INSERT OR IGNORE INTO jobs(kind,session_id,event_id,payload_json,state,available_at,created_at,updated_at) "
                    "VALUES('integrate_session',?,?,?,'pending',?,?,?)",
                    (session_id, event_id, "{}", created_at, created_at, created_at),
                )

        immediate: list[str] = []
        forgotten: list[str] = []
        forget_skipped = 0
        if inserted and kind == "user_prompt":
            prompt = str(payload.get("prompt", ""))
            forget_query = self.explicit_forget_query(prompt)
            if forget_query:
                scope_rows = self.db.conn.execute(
                    "SELECT * FROM memories WHERE scope='global' OR repo_key=?", (project,)
                ).fetchall()
                targets = self._forget_matches(scope_rows, forget_query)
                if 0 < len(targets) <= 2:
                    for row in targets:
                        forgotten.extend(self.forget(project=project, memory_id=str(row["id"])))
                else:
                    # An ambiguous mass-forget is never honored automatically.
                    # Maintenance-mode recall surfaces the matches so a
                    # targeted forget by id can follow.
                    forget_skipped = len(targets)
            for candidate in self.explicit_candidates(prompt):
                candidate.source_event_ids = [event_id]
                for item in candidate.evidence:
                    item["event_id"] = event_id
                memory = self.create_memory(candidate, project=project, explicit_override=True)
                if memory:
                    immediate.append(str(memory["id"]))
        return {
            "captured": inserted,
            "paused": False,
            "id": event_id,
            "session_id": session_id,
            "redactions": sorted(set(findings)),
            "immediate_memories": immediate,
            "forgotten": forgotten,
            "forget_skipped": forget_skipped,
        }

    # ------------------------------------------------------------- extraction
    @staticmethod
    def explicit_forget_query(prompt: str) -> str:
        patterns = (
            r"(?is)^\s*(?:please\s+)?forget(?:\s+that|\s+about)?\s+(.+?)\s*[.!]?\s*$",
            r"(?is)^\s*(.+?)\s*(?:은|는|을|를)?\s*(?:기억에서\s*)?(?:잊어(?:버려|줘)?|삭제해(?:줘)?)\s*[.!]?\s*$",
        )
        for pattern in patterns:
            match = re.match(pattern, prompt)
            if match and len(match.group(1).strip()) >= 3:
                return match.group(1).strip()
        return ""

    @staticmethod
    def explicit_candidates(prompt: str) -> list[Candidate]:
        patterns = (
            r"(?is)^\s*(?:please\s+)?remember(?:\s+that|\s+this)?[\s,:-]+(.+?)\s*$",
            r"(?is)^\s*기억해(?:줘|두세요|두자)?[\s,:.-]+(.+?)\s*$",
            r"(?is)^\s*(.+?)\s*(?:라고|으로|로)?\s*기억해(?:줘|두(?:세요|자)?)?\s*[.!]?\s*$",
            r"(?is)^\s*(?:메모리(?:에|로)?\s*)(?:저장|추가)(?:해|해줘)?[\s,:-]+(.+?)\s*$",
        )
        statement = ""
        for pattern in patterns:
            match = re.match(pattern, prompt)
            if match:
                statement = match.group(1).strip().rstrip(".")
                break
        if not statement:
            compact = prompt.strip()
            durable = re.search(
                r"(?i)\b(?:from now on|no longer|anymore)\b|앞으로|이제부터", compact
            )
            directive = re.search(
                r"(?i)\b(?:always|never|use|prefer|stop|don'?t|do not)\b"
                r"|말고|쓰지|하지\s*마|써\s*줘|써라|금지|유지",
                compact,
            )
            question = re.search(
                r"(?i)\?|\bwhy\b|\bwhat\b|\bhow\b|\bexplain\b|설명|알려|어떻게|무엇|왜",
                compact,
            )
            # A durable correction is explicit even without the word
            # "remember", but only when it is short and imperative — an
            # incidental "앞으로"/"from now on" in a long task prompt or a
            # question must not become a permanent memory of the whole prompt.
            if durable and directive and not question and len(compact) <= 400:
                statement = compact.rstrip(".")[:500]
        if not statement:
            return []
        normalized = normalize_text(statement)
        scope = (
            "global"
            if re.search(r"\b(?:globally|all projects|every project|across projects)\b|모든\s*프로젝트|전역", normalized)
            else "project"
        )
        if re.search(r"\b(?:prefer|preference|like to)\b|선호", normalized):
            kind = "preference"
        elif re.search(r"\b(?:decided|decision|we will|use .* instead)\b|결정|대신", normalized):
            kind = "decision"
        elif re.search(r"\b(?:must|never|always|do not|don't|required)\b|반드시|절대|금지|하지", normalized):
            kind = "constraint"
        else:
            kind = "preference"
        return [
            Candidate(
                kind=kind,
                scope=scope,
                statement=statement,
                authority="explicit",
                confidence=1.0,
                evidence=[{"kind": "user-statement", "summary": "Explicit remember request"}],
                user_approved=True,
            )
        ]

    @staticmethod
    def _event_dict(db: Database, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "session_id": row["session_id"],
            "harness": row["harness"],
            "kind": row["kind"],
            "repo_key": row["repo_key"],
            "payload": db.decode_payload(row["payload_zlib"]),
            "created_at": row["created_at"],
        }

    def local_candidates(self, events: list[dict[str, Any]]) -> list[Candidate]:
        output: list[Candidate] = []
        commands: dict[tuple[str, int | None], list[dict[str, Any]]] = defaultdict(list)
        for event in events:
            payload = event["payload"]
            if event["kind"] == "user_prompt":
                prompt = str(payload.get("prompt", ""))
                if self.explicit_candidates(prompt):
                    continue  # Already activated in the prompt hook.
                match = re.search(
                    r"(?is)(?:\bI\s+(?:strongly\s+)?prefer\b|\bmy preference is\b|나는?\s*.+?선호|선호(?:해|합니다))[\s,:-]*(.+)",
                    prompt,
                )
                if match:
                    output.append(
                        Candidate(
                            kind="preference",
                            scope="project",
                            statement=match.group(0).strip()[:500],
                            authority="inferred",
                            confidence=0.62,
                            source_event_ids=[event["id"]],
                            evidence=[{"kind": "conversation", "summary": "Inferred user preference"}],
                        )
                    )
            elif event["kind"] == "tool_completed":
                command = normalize_text(str(payload.get("command", "")))
                status = payload.get("exit_status")
                if command and len(command) <= 500 and isinstance(status, int):
                    commands[(command, status)].append(event)
                hint = payload.get("memory_hint")
                if isinstance(hint, dict) and hint.get("statement"):
                    evidence_kind = "test-result" if "test" in str(payload.get("tool_name", "")).casefold() else "command"
                    output.append(
                        Candidate(
                            kind=str(hint.get("kind", "procedure")),
                            scope=str(hint.get("scope", "project")),
                            statement=str(hint["statement"]),
                            conditions=list(hint.get("conditions") or []),
                            path_globs=list(hint.get("path_globs") or []),
                            authority="verified" if status == 0 else "inferred",
                            confidence=0.9 if status == 0 else 0.55,
                            source_event_ids=[event["id"]],
                            evidence=[
                                {
                                    "kind": evidence_kind,
                                    "summary": "Tool-backed memory hint",
                                    "command": str(payload.get("command", ""))[:500],
                                    "exit_status": status,
                                }
                            ],
                        )
                    )

        # Repetition is a high-precision local signal; a one-off command is not
        # promoted into durable memory.
        for (command, status), matched in commands.items():
            if len(matched) < 2:
                continue
            raw_command = str(matched[-1]["payload"].get("command", ""))[:500]
            if status == 0 and re.search(r"(?:^|\s)(?:test|pytest|cargo test|go test|check|lint|build)(?:\s|$)|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|build)", command):
                output.append(
                    Candidate(
                        kind="procedure",
                        scope="project",
                        statement=f"The verified project check `{raw_command}` has succeeded repeatedly.",
                        authority="verified",
                        confidence=0.92,
                        source_event_ids=[item["id"] for item in matched],
                        evidence=[
                            {
                                "kind": "test-result",
                                "summary": f"Command succeeded {len(matched)} times",
                                "command": raw_command,
                                "exit_status": 0,
                            }
                        ],
                    )
                )
            elif status != 0 and len(matched) >= 2:
                output.append(
                    Candidate(
                        kind="caveat",
                        scope="project",
                        statement=f"`{raw_command}` failed repeatedly in the observed project context; verify its prerequisites before relying on it.",
                        authority="verified",
                        confidence=0.85,
                        source_event_ids=[item["id"] for item in matched],
                        evidence=[
                            {
                                "kind": "command",
                                "summary": f"Command failed {len(matched)} times",
                                "command": raw_command,
                                "exit_status": status,
                            }
                        ],
                    )
                )
        return output

    # ----------------------------------------------------------- memory writes
    def _tombstone_digest(self, statement: str, scope: str, project: str | None) -> str:
        key = bytes.fromhex(self.db.get_meta("tombstone_key"))
        message = stable_json(
            {"statement": normalize_text(statement), "scope": scope, "repo_key": project or ""}
        ).encode("utf-8")
        return hmac.new(key, message, hashlib.sha256).hexdigest()

    @staticmethod
    def _activation(candidate: Candidate) -> tuple[str, str, float]:
        if candidate.authority in {"explicit", "approved"} or candidate.user_approved:
            return "active", candidate.authority, max(candidate.confidence, 0.95)
        evidence = candidate.evidence
        verified = any(
            item.get("kind") in {"command", "test-result"} and item.get("exit_status") is not None
            for item in evidence
            if isinstance(item, dict)
        )
        if candidate.kind in {"procedure", "caveat"} and candidate.authority == "verified" and verified:
            return "active", "verified", max(candidate.confidence, 0.8)
        return "provisional", candidate.authority, candidate.confidence

    @staticmethod
    def _subject_tokens(statement: str) -> set[str]:
        stop = {
            "the", "a", "an", "to", "for", "this", "that", "use", "using", "do", "not",
            "dont", "don't", "never", "always", "project", "prefer", "instead", "please",
            "은", "는", "이", "가", "을", "를", "에", "로", "사용", "하지", "말고", "선호",
        }
        return {token for token in semantic_tokens(statement) if token not in stop and len(token) > 1}

    @classmethod
    def _contradicts(cls, left: str, right: str) -> bool:
        a = cls._subject_tokens(left)
        b = cls._subject_tokens(right)
        if not a or not b:
            return False
        overlap = len(a & b) / max(1, min(len(a), len(b)))
        def negation(value: str) -> bool:
            return bool(
                re.search(
                    r"\b(?:not|never|don't|avoid|stop)\b|말고|하지|금지|중단",
                    normalize_text(value),
                )
            )

        return overlap >= 0.55 and negation(left) != negation(right)

    def _snapshot(self, memory_id: str, reason: str) -> None:
        row = self.db.conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            return
        snapshot = record_from_row(self.db, row)
        self.db.conn.execute(
            "INSERT INTO memory_revisions(memory_id,revision,snapshot_json,reason,created_at) "
            "VALUES(?,?,?,?,?)",
            (memory_id, row["revision"], stable_json(snapshot), reason, utc_now()),
        )

    def _change_state(self, memory_id: str, state: str, reason: str, *, authority: str | None = None) -> None:
        if state not in MEMORY_STATES:
            raise MemoryError(f"invalid state: {state}")
        current = self.db.conn.execute(
            "SELECT state,authority FROM memories WHERE id=?", (memory_id,)
        ).fetchone()
        if not current:
            raise MemoryError(f"memory not found: {memory_id}")
        if current["state"] == state and (authority is None or current["authority"] == authority):
            return
        now = utc_now()
        if authority:
            self.db.conn.execute(
                "UPDATE memories SET state=?,authority=?,revision=revision+1,updated_at=? WHERE id=?",
                (state, authority, now, memory_id),
            )
        else:
            self.db.conn.execute(
                "UPDATE memories SET state=?,revision=revision+1,updated_at=? WHERE id=?",
                (state, now, memory_id),
            )
        self._snapshot(memory_id, reason)

    def create_memory(
        self,
        candidate: Candidate,
        *,
        project: str,
        explicit_override: bool = False,
        replaces_id: str | None = None,
    ) -> dict[str, Any] | None:
        try:
            candidate.validate()
        except ValueError as exc:
            raise MemoryError(str(exc)) from exc
        redacted = redact_text(candidate.statement)
        condition_results = [redact_text(item) for item in candidate.conditions]
        path_results = [redact_text(item) for item in candidate.path_globs]
        findings = [
            *redacted.findings,
            *(finding for result in condition_results for finding in result.findings),
            *(finding for result in path_results for finding in result.findings),
        ]
        if findings:
            raise MemoryError(
                "memory contains sensitive, personal, or absolute-path data and was not stored"
            )
        candidate.statement = redacted.value
        candidate.conditions = [result.value for result in condition_results]
        candidate.path_globs = [result.value for result in path_results]
        target_project = project if candidate.scope == "project" else None
        tombstone = self._tombstone_digest(candidate.statement, candidate.scope, target_project)
        now = utc_now()
        with self.db.transaction(immediate=True):
            blocked = self.db.conn.execute(
                "SELECT 1 FROM tombstones WHERE digest=? AND expires_at>?", (tombstone, now)
            ).fetchone()
            if blocked and not explicit_override:
                return None
            if explicit_override:
                self.db.conn.execute("DELETE FROM tombstones WHERE digest=?", (tombstone,))
            content_hash = content_digest(candidate, target_project)
            existing = self.db.conn.execute(
                "SELECT * FROM memories WHERE content_hash=? AND state!='retracted' ORDER BY updated_at DESC LIMIT 1",
                (content_hash,),
            ).fetchone()
            if existing:
                if explicit_override and existing["state"] != "active":
                    self.db.conn.execute(
                        "UPDATE memories SET last_verified_at=?,updated_at=? WHERE id=?",
                        (now, now, existing["id"]),
                    )
                    self._change_state(existing["id"], "active", "explicit confirmation", authority="explicit")
                else:
                    self.db.conn.execute(
                        "UPDATE memories SET last_verified_at=?,updated_at=? WHERE id=?",
                        (now, now, existing["id"]),
                    )
                row = self.db.conn.execute("SELECT * FROM memories WHERE id=?", (existing["id"],)).fetchone()
                return record_from_row(self.db, row)

            state, authority, confidence = self._activation(candidate)
            memory_id = f"mem_{uuid.uuid4().hex[:24]}"
            stale_after = (
                (datetime.now(UTC) + timedelta(days=PROCEDURE_STALE_DAYS)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                if candidate.kind in {"procedure", "caveat"}
                else None
            )
            self.db.conn.execute(
                "INSERT INTO memories(id,schema_name,kind,scope,repo_key,path_globs_json,statement,"
                "conditions_json,state,authority,confidence,valid_from,valid_until,stale_after,revision,"
                "content_hash,created_at,updated_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    memory_id,
                    RECORD_SCHEMA,
                    candidate.kind,
                    candidate.scope,
                    target_project,
                    stable_json(candidate.path_globs),
                    candidate.statement,
                    stable_json(candidate.conditions),
                    state,
                    authority,
                    confidence,
                    now,
                    candidate.valid_until,
                    stale_after,
                    1,
                    content_hash,
                    now,
                    now,
                    now if authority in {"explicit", "approved", "verified"} else None,
                ),
            )
            for index, item in enumerate(candidate.evidence):
                if not isinstance(item, dict):
                    continue
                event_id = str(item.get("event_id") or (candidate.source_event_ids[index] if index < len(candidate.source_event_ids) else "")) or None
                if event_id and not self.db.conn.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone():
                    event_id = None
                evidence_id = f"evd_{digest_text(memory_id + stable_json(item) + str(index))[:24]}"
                summary = redact_text(str(item.get("summary") or item.get("kind") or "Evidence")).value
                command = redact_text(str(item.get("command") or "")).value or None
                evidence_kind = redact_text(str(item.get("kind") or "observation")).value
                evidence_kind = (
                    re.sub(r"[^a-zA-Z0-9_.-]+", "-", evidence_kind).strip("-")[:60]
                    or "observation"
                )
                exit_status = item.get("exit_status") if isinstance(item.get("exit_status"), int) else None
                self.db.conn.execute(
                    "INSERT OR IGNORE INTO evidence(id,memory_id,revision,event_id,kind,summary,command,exit_status,created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        evidence_id,
                        memory_id,
                        1,
                        event_id,
                        evidence_kind,
                        summary,
                        command,
                        exit_status,
                        now,
                    ),
                )
            self._snapshot(memory_id, "created")
            self.db.index_memory(
                memory_id,
                candidate.statement,
                candidate.conditions,
                candidate.path_globs,
                semantic_tokens(candidate.statement + " " + " ".join(candidate.conditions)),
            )

            peers = self.db.conn.execute(
                "SELECT id,statement,state,authority FROM memories WHERE id!=? AND kind=? AND scope=? "
                "AND coalesce(repo_key,'')=coalesce(?,'') AND state IN ('active','provisional','disputed')",
                (memory_id, candidate.kind, candidate.scope, target_project),
            ).fetchall()
            explicit = authority in {"explicit", "approved"}
            for peer in peers:
                if not self._contradicts(candidate.statement, peer["statement"]):
                    continue
                if explicit:
                    self._change_state(peer["id"], "retracted", "superseded by explicit correction")
                    self.db.conn.execute(
                        "INSERT OR IGNORE INTO relations(source_id,target_id,relation,created_at) VALUES(?,?,?,?)",
                        (memory_id, peer["id"], "supersedes", now),
                    )
                else:
                    self._change_state(memory_id, "disputed", "conflicting evidence")
                    self._change_state(peer["id"], "disputed", "conflicting evidence")
                    self.db.conn.execute(
                        "INSERT OR IGNORE INTO relations(source_id,target_id,relation,created_at) VALUES(?,?,?,?)",
                        (memory_id, peer["id"], "conflicts_with", now),
                    )
            if replaces_id:
                peer = self.db.conn.execute("SELECT id FROM memories WHERE id=?", (replaces_id,)).fetchone()
                if not peer:
                    raise MemoryError(f"replacement target not found: {replaces_id}")
                self._change_state(replaces_id, "retracted", "explicit replacement")
                self.db.conn.execute(
                    "INSERT OR IGNORE INTO relations(source_id,target_id,relation,created_at) VALUES(?,?,?,?)",
                    (memory_id, replaces_id, "supersedes", now),
                )
            row = self.db.conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
            return record_from_row(self.db, row)

    @staticmethod
    def _forget_matches(rows: Sequence[sqlite3.Row], query: str) -> list[sqlite3.Row]:
        """Precision-first forget matching on raw tokens only.

        Concept/alias expansion is banned here: with it, any statement sharing
        one verify-ish word matched any other, and a single broad query could
        hard-delete most of the store.
        """

        needle = normalize_text(query or "")
        if not needle:
            return []
        needle_tokens = [token for token in word_tokens(needle) if len(token) >= 2]

        def hit(left: str, right: str) -> bool:
            if left == right:
                return True
            return (len(left) >= 3 and right.startswith(left)) or (
                len(right) >= 3 and left.startswith(right)
            )

        matched: list[sqlite3.Row] = []
        for row in rows:
            statement = normalize_text(row["statement"])
            if needle in statement or statement in needle:
                matched.append(row)
                continue
            tokens = word_tokens(statement)
            hits = sum(
                1 for token in needle_tokens if any(hit(token, other) for other in tokens)
            )
            if len(needle_tokens) >= 2 and hits >= 2 and hits / len(needle_tokens) >= 0.6:
                matched.append(row)
        return matched

    def forget(
        self,
        *,
        project: str,
        memory_id: str | None = None,
        query: str | None = None,
        all_projects: bool = False,
        allow_bulk: bool = False,
    ) -> list[str]:
        if not memory_id and not (query or "").strip():
            raise MemoryError("forget requires a memory id or query")
        if memory_id:
            rows = self.db.conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchall()
        else:
            scope_sql = "1=1" if all_projects else "(scope='global' OR repo_key=?)"
            params: tuple[Any, ...] = () if all_projects else (project,)
            candidates = self.db.conn.execute(f"SELECT * FROM memories WHERE {scope_sql}", params).fetchall()
            rows = self._forget_matches(candidates, query or "")
            if len(rows) > 5 and not allow_bulk:
                raise MemoryError(
                    f"forget query matched {len(rows)} memories; use --id per record, "
                    "a more distinctive query, or --all-matches to confirm bulk deletion"
                )
        removed: list[str] = []
        with self.db.transaction(immediate=True):
            for row in rows:
                digest = self._tombstone_digest(row["statement"], row["scope"], row["repo_key"])
                self.db.conn.execute(
                    "INSERT INTO tombstones(digest,scope,repo_key,expires_at,created_at) VALUES(?,?,?,?,?) "
                    "ON CONFLICT(digest) DO UPDATE SET expires_at=excluded.expires_at,created_at=excluded.created_at",
                    (digest, row["scope"], row["repo_key"], utc_after(days=TOMBSTONE_TTL_DAYS), utc_now()),
                )
                self.db.unindex_memory(row["id"])
                self.db.conn.execute("DELETE FROM memories WHERE id=?", (row["id"],))
                removed.append(row["id"])
        return removed

    # ------------------------------------------------------------------ worker
    @contextmanager
    def worker_lock(self) -> Iterator[bool]:
        path = self.db.home / ".worker.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+")
        acquired = False
        unlock: Any = None
        try:
            if os.name == "nt":
                # Windows has no fcntl, and the previous fallback was
                # `acquired = os.name == "nt"` — an unconditional yes. Every worker a
                # Stop/SessionEnd hook launched therefore ran, all at once, on the one
                # machine where the store is busiest. Job leases still stop duplicate
                # *work*, but nothing stopped duplicate *processes* from piling onto the
                # write lock, which is the shape of the 41s p99 the prompt hook sees.
                # `msvcrt.locking` with LK_NBLCK is the platform's non-blocking
                # equivalent and fails with OSError when another process holds it.
                try:
                    import msvcrt

                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    acquired = True

                    def unlock() -> None:
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

                except (ImportError, OSError):
                    acquired = False
            else:
                try:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True

                    def unlock() -> None:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

                except (ImportError, BlockingIOError, OSError):
                    acquired = False
            yield acquired
        finally:
            if acquired and unlock is not None:
                try:
                    unlock()
                except OSError:
                    pass
            handle.close()

    def lease_job(self) -> sqlite3.Row | None:
        now = utc_now()
        with self.db.transaction(immediate=True):
            row = self.db.conn.execute(
                "SELECT * FROM jobs WHERE (state='pending' AND available_at<=?) "
                "OR (state='leased' AND leased_until<=?) ORDER BY id LIMIT 1",
                (now, now),
            ).fetchone()
            if not row:
                return None
            updated = self.db.conn.execute(
                "UPDATE jobs SET state='leased',attempts=attempts+1,leased_until=?,updated_at=? "
                "WHERE id=? AND ((state='pending' AND available_at<=?) OR (state='leased' AND leased_until<=?))",
                (utc_after(seconds=60), now, row["id"], now, now),
            )
            if updated.rowcount != 1:
                return None
            return self.db.conn.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()

    def _finish_job(self, job_id: int) -> None:
        self.db.conn.execute(
            "UPDATE jobs SET state='done',leased_until=NULL,last_error=NULL,updated_at=? WHERE id=?",
            (utc_now(), job_id),
        )

    def _fail_job(self, job: sqlite3.Row, exc: Exception) -> str:
        attempts = int(job["attempts"])
        state = "dead" if attempts >= MAX_JOB_ATTEMPTS else "pending"
        available = utc_after(seconds=min(300, 2**attempts))
        safe_error = redact_text(f"{type(exc).__name__}: {exc}"[:2000]).value[:1000]
        self.db.conn.execute(
            "UPDATE jobs SET state=?,available_at=?,leased_until=NULL,last_error=?,updated_at=? WHERE id=?",
            (state, available, safe_error, utc_now(), job["id"]),
        )
        return state

    def _existing_for_reconcile(self, project: str, candidate: Candidate) -> list[dict[str, Any]]:
        rows = self.db.conn.execute(
            "SELECT * FROM memories WHERE kind=? AND scope=? AND coalesce(repo_key,'')=coalesce(?,'') "
            "AND state IN ('active','provisional','disputed') ORDER BY updated_at DESC LIMIT 12",
            (candidate.kind, candidate.scope, project if candidate.scope == "project" else None),
        ).fetchall()
        return [record_from_row(self.db, row, include_evidence=False) for row in rows]

    def _constrain_candidate_authority(
        self, candidate: Candidate, events: list[dict[str, Any]]
    ) -> Candidate:
        """Prove activation signals against local events, never provider labels."""

        sources = {
            event["id"]: event
            for event in events
            if not candidate.source_event_ids or event["id"] in candidate.source_event_ids
        }
        explicit_statements = [
            directive.statement
            for event in sources.values()
            if event["kind"] == "user_prompt"
            for directive in self.explicit_candidates(
                str(event["payload"].get("prompt", ""))
            )
        ]
        candidate_terms = set(semantic_tokens(candidate.statement))
        explicit = bool(candidate.source_event_ids) and any(
            candidate_terms
            and len(candidate_terms & set(semantic_tokens(statement)))
            / max(1, min(len(candidate_terms), len(set(semantic_tokens(statement)))))
            >= 0.35
            for statement in explicit_statements
        )
        if candidate.authority in {"explicit", "approved"} or candidate.user_approved:
            if not explicit:
                candidate.authority = "inferred"
                candidate.user_approved = False
                candidate.confidence = min(candidate.confidence, 0.7)

        verified_evidence: list[dict[str, Any]] = []
        for item in candidate.evidence:
            if not isinstance(item, dict) or item.get("kind") not in {"command", "test-result"}:
                continue
            command = normalize_text(str(item.get("command", "")))
            if not command:
                continue
            status = item.get("exit_status")
            for event in sources.values():
                payload = event["payload"]
                if event["kind"] != "tool_completed":
                    continue
                if command and command != normalize_text(str(payload.get("command", ""))):
                    continue
                if isinstance(status, int) and status != payload.get("exit_status"):
                    continue
                command_terms = {
                    token
                    for token in semantic_tokens(command)
                    if len(token) >= 3 and not token.startswith("-")
                }
                if command_terms and not command_terms & candidate_terms:
                    continue
                verified_evidence.append(item)
                break
        if candidate.authority == "verified" and not verified_evidence:
            candidate.authority = "inferred"
            candidate.confidence = min(candidate.confidence, 0.7)
        return candidate

    def integrate_session(self, session_id: str) -> dict[str, Any]:
        rows = self.db.conn.execute(
            "SELECT * FROM events WHERE session_id=? AND integrated_at IS NULL ORDER BY created_at,id",
            (session_id,),
        ).fetchall()
        if not rows:
            return {"events": 0, "created": []}
        events = [self._event_dict(self.db, row) for row in rows]
        project = events[0]["repo_key"]
        candidates = self.local_candidates(events)
        provider_error: ProviderError | None = None
        if not isinstance(self.provider, NullProvider):
            try:
                candidates.extend(self.provider.extract([remote_event(item) for item in events], project))
            except ProviderError as exc:
                provider_error = exc
        created: list[dict[str, Any]] = []
        for candidate in candidates:
            # A provider may decline or rewrite a candidate, but it cannot
            # elevate authority beyond the activation policy in create_memory.
            if not isinstance(self.provider, NullProvider):
                try:
                    resolution = self.provider.reconcile(
                        candidate, self._existing_for_reconcile(project, candidate)
                    )
                    if resolution.get("action") in {"drop", "ignore"}:
                        continue
                    if isinstance(resolution.get("candidate"), dict):
                        from .providers import candidates_from_value

                        parsed = candidates_from_value([resolution["candidate"]])
                        if parsed:
                            candidate = parsed[0]
                except ProviderError as exc:
                    provider_error = provider_error or exc
            candidate = self._constrain_candidate_authority(candidate, events)
            memory = self.create_memory(candidate, project=project)
            if memory:
                created.append(memory)

        if provider_error:
            # Local candidates have already been safely deduplicated. Retrying
            # lets the optional provider contribute later without losing work.
            raise provider_error
        now = utc_now()
        self.db.conn.executemany(
            "UPDATE events SET integrated_at=? WHERE id=?", [(now, row["id"]) for row in rows]
        )
        return {"events": len(events), "created": [item["id"] for item in created]}

    def embed_missing(self, *, limit: int = 64) -> int:
        """Embed active/provisional records that lack a current-model vector.

        Runs in the background worker so explicit remembers and historical
        records are covered, not only worker-created candidates. Embeddings
        stay an optimization: any failure is recorded and recall falls back to
        FTS/trigram.
        """

        if isinstance(self.provider, NullProvider):
            return 0
        model = self.provider.embedding_model or ""
        rows = self.db.conn.execute(
            "SELECT m.id,m.statement FROM memories AS m "
            "LEFT JOIN memory_embeddings AS e ON e.memory_id=m.id "
            "WHERE m.state IN ('active','provisional') "
            "AND (e.memory_id IS NULL OR e.model!=?) "
            "ORDER BY m.updated_at DESC LIMIT ?",
            (model, limit),
        ).fetchall()
        if not rows:
            return 0
        try:
            vectors = self.provider.embed([str(row["statement"]) for row in rows])
        except ProviderError as exc:
            self.db.set_meta(
                "last_embedding_error",
                redact_text(f"{type(exc).__name__}: {exc}"[:2000]).value[:1000],
            )
            return 0
        stored = 0
        for row, vector in zip(rows, vectors, strict=False):
            if vector:
                self.db.put_embedding(str(row["id"]), model, vector)
                stored += 1
        return stored

    def worker_once(self, *, max_jobs: int = 8) -> dict[str, Any]:
        processed: list[dict[str, Any]] = []
        with self.worker_lock() as acquired:
            if not acquired:
                return {"acquired": False, "processed": [], "embedded": 0}
            for _ in range(max_jobs):
                job = self.lease_job()
                if not job:
                    break
                try:
                    if job["kind"] == "integrate_session":
                        result = self.integrate_session(str(job["session_id"]))
                    else:
                        raise MemoryError(f"unknown job kind: {job['kind']}")
                    self._finish_job(job["id"])
                    processed.append({"id": job["id"], "state": "done", "result": result})
                except Exception as exc:
                    state = self._fail_job(job, exc)
                    processed.append({"id": job["id"], "state": state, "error": str(exc)})
            embedded = self.embed_missing()
        return {"acquired": True, "processed": processed, "embedded": embedded}

    # -------------------------------------------------------------- lifecycle
    def review_list(
        self,
        project: str,
        *,
        state: str | None = None,
        batch: str | None = None,
        source: str | None = None,
        scope: str | None = None,
        kind: str | None = None,
        repo: str | None = None,
        all_projects: bool = False,
    ) -> list[dict[str, Any]]:
        """List memory awaiting a decision, narrowed the way a reviewer thinks.

        `all_projects` exists for imports: one `MEMORY.md` carries knowledge for
        several repositories, so the queue it produces cannot be seen at all from
        inside a single one.
        """
        sql = "SELECT m.* FROM memories AS m WHERE 1=1"
        params: list[Any] = []
        if not all_projects:
            sql += " AND (m.scope='global' OR m.repo_key=?)"
            params.append(project)
        if state:
            if state not in MEMORY_STATES:
                raise MemoryError(f"invalid state: {state}")
            sql += " AND m.state=?"
            params.append(state)
        else:
            sql += " AND m.state IN ('provisional','disputed')"
        if scope:
            if scope not in SCOPES:
                raise MemoryError(f"invalid scope: {scope}")
            sql += " AND m.scope=?"
            params.append(scope)
        if kind:
            if kind not in MEMORY_KINDS:
                raise MemoryError(f"invalid memory kind: {kind}")
            sql += " AND m.kind=?"
            params.append(kind)
        if repo:
            sql += " AND m.repo_key=?"
            params.append(repo)
        if batch:
            sql += (
                " AND EXISTS(SELECT 1 FROM evidence AS e WHERE e.memory_id=m.id"
                " AND e.kind=? AND e.summary=?)"
            )
            params.extend([IMPORT_BATCH_EVIDENCE, batch])
        if source:
            sql += " AND EXISTS(SELECT 1 FROM evidence AS e WHERE e.memory_id=m.id AND e.kind=?)"
            params.append(f"{IMPORT_EVIDENCE_PREFIX}{source}")
        sql += " ORDER BY m.updated_at DESC"
        rows = self.db.conn.execute(sql, params).fetchall()
        return [record_from_row(self.db, row) for row in rows]

    def resolve_batch(
        self,
        *,
        batch: str,
        decision: str,
        source: str | None = None,
        scope: str | None = None,
        kind: str | None = None,
        repo: str | None = None,
    ) -> dict[str, Any]:
        """Approve or reject one import batch in a single decision.

        The batch is the unit, not the current repository: one adoption spans
        every repository the source file spoke about, and a reviewer standing in
        one checkout still has to be able to resolve the whole thing. `repo`
        narrows it back down when they want to take one project at a time —
        those are the same groups the import report counted.

        Only `provisional` and `disputed` records are touched. A batch that
        merged onto memory already active must not be able to re-approve it, and
        rejecting must not reach past the queue into settled memory.

        Rejection is `forget`, which leaves a tombstone: a rule turned down here
        stays out for the tombstone's lifetime even if the file it came from is
        adopted again. That is the point — otherwise every re-run rebuilds the
        queue the reviewer just emptied.
        """
        if decision not in {"approve", "reject"}:
            raise MemoryError(f"invalid decision: {decision}")
        if not batch:
            raise MemoryError("a batch is required to resolve memory in bulk")
        pending = self.review_list(
            "",
            batch=batch,
            source=source,
            scope=scope,
            kind=kind,
            repo=repo,
            all_projects=True,
        )
        resolved: list[str] = []
        for record in pending:
            if decision == "approve":
                self.approve(record["id"])
            else:
                self.reject(record["id"])
            resolved.append(record["id"])
        return {"batch": batch, "decision": decision, "resolved": resolved, "count": len(resolved)}

    def get_memory(self, memory_id: str) -> dict[str, Any]:
        row = self.db.conn.execute("SELECT * FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            raise MemoryError(f"memory not found: {memory_id}")
        record = record_from_row(self.db, row)
        revisions = self.db.conn.execute(
            "SELECT revision,snapshot_json,reason,created_at FROM memory_revisions WHERE memory_id=? ORDER BY revision",
            (memory_id,),
        ).fetchall()
        record["revisions"] = [
            {
                "revision": item["revision"],
                "snapshot": json.loads(item["snapshot_json"]),
                "reason": item["reason"],
                "created_at": item["created_at"],
            }
            for item in revisions
        ]
        relations = self.db.conn.execute(
            "SELECT source_id,target_id,relation,created_at FROM relations WHERE source_id=? OR target_id=?",
            (memory_id, memory_id),
        ).fetchall()
        record["relations"] = [jsonable_row(item) for item in relations]
        return record

    def approve(self, memory_id: str) -> dict[str, Any]:
        with self.db.transaction(immediate=True):
            if not self.db.conn.execute("SELECT 1 FROM memories WHERE id=?", (memory_id,)).fetchone():
                raise MemoryError(f"memory not found: {memory_id}")
            self.db.conn.execute(
                "UPDATE memories SET confidence=max(confidence,0.95),last_verified_at=? WHERE id=?",
                (utc_now(), memory_id),
            )
            self._change_state(memory_id, "active", "user approved", authority="approved")
        return self.get_memory(memory_id)

    def reject(self, memory_id: str) -> list[str]:
        row = self.db.conn.execute("SELECT repo_key FROM memories WHERE id=?", (memory_id,)).fetchone()
        if not row:
            raise MemoryError(f"memory not found: {memory_id}")
        return self.forget(project=str(row["repo_key"] or ""), memory_id=memory_id)

    def trust_grant(self, project: str, kinds: Sequence[str]) -> None:
        now = utc_now()
        for kind in kinds:
            if kind not in MEMORY_KINDS:
                raise MemoryError(f"invalid memory kind: {kind}")
            self.db.conn.execute(
                "INSERT OR REPLACE INTO trust_grants(repo_key,memory_kind,granted_at) VALUES(?,?,?)",
                (project, kind, now),
            )

    def trust_revoke(self, project: str, kinds: Sequence[str] | None = None) -> int:
        if kinds:
            placeholders = ",".join("?" for _ in kinds)
            cursor = self.db.conn.execute(
                f"DELETE FROM trust_grants WHERE repo_key=? AND memory_kind IN ({placeholders})",
                (project, *kinds),
            )
        else:
            cursor = self.db.conn.execute("DELETE FROM trust_grants WHERE repo_key=?", (project,))
        return cursor.rowcount

    def trust_list(self, project: str | None = None) -> list[dict[str, Any]]:
        if project:
            rows = self.db.conn.execute(
                "SELECT * FROM trust_grants WHERE repo_key=? ORDER BY memory_kind", (project,)
            ).fetchall()
        else:
            rows = self.db.conn.execute(
                "SELECT * FROM trust_grants ORDER BY repo_key,memory_kind"
            ).fetchall()
        return [jsonable_row(row) for row in rows]

    def session_control(
        self, action: str, *, harness: str, project: str, session_id: str | None = None
    ) -> dict[str, Any]:
        sid = (
            self._session_key(session_id, harness, project)
            if session_id
            else f"*:{harness}:{project}"
        )
        row = self.db.conn.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()
        if action == "status":
            return {
                "session_id": sid,
                "paused": bool(row["paused"]) if row else False,
                "harness": harness,
                "repo_key": project,
            }
        paused = action == "pause"
        now = utc_now()
        self.db.conn.execute(
            "INSERT INTO sessions(session_id,harness,repo_key,paused,created_at,updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(session_id) DO UPDATE SET paused=excluded.paused,updated_at=excluded.updated_at",
            (sid, harness, project, int(paused), now, now),
        )
        return {"session_id": sid, "paused": paused, "harness": harness, "repo_key": project}

    def feedback(
        self, query_id: str, memory_id: str, *, used: bool, outcome: str | None = None
    ) -> dict[str, Any]:
        now = utc_now()
        safe_outcome = redact_text(outcome).value if outcome else None
        cursor = self.db.conn.execute(
            "UPDATE retrieval_feedback SET used=?,outcome=?,updated_at=? WHERE query_id=? AND memory_id=?",
            (int(used), safe_outcome, now, query_id, memory_id),
        )
        if cursor.rowcount != 1:
            raise MemoryError("feedback target was not exposed by that query")
        return {
            "query_id": query_id,
            "memory_id": memory_id,
            "used": used,
            "outcome": safe_outcome,
        }

    def export(
        self,
        *,
        project: str | None = None,
        include_global: bool = False,
        scope: str | None = None,
    ) -> dict[str, Any]:
        if scope is None:
            scope = "project+global" if include_global else "project"
        elif scope not in EXPORT_SCOPES:
            raise MemoryError(f"invalid scope: {scope}")
        if scope != "global" and scope != "all" and not project:
            raise MemoryError("a project is required to export project-scoped memory")

        if scope == "global":
            rows = self.db.conn.execute(
                "SELECT * FROM memories WHERE scope='global' ORDER BY created_at"
            ).fetchall()
        elif scope == "all":
            rows = self.db.conn.execute("SELECT * FROM memories ORDER BY created_at").fetchall()
        elif scope == "project+global":
            rows = self.db.conn.execute(
                "SELECT * FROM memories WHERE repo_key=? OR scope='global' ORDER BY created_at",
                (project,),
            ).fetchall()
        else:
            rows = self.db.conn.execute(
                "SELECT * FROM memories WHERE repo_key=? ORDER BY created_at", (project,)
            ).fetchall()

        memories = [record_from_row(self.db, row) for row in rows]
        return {
            "schema": EXPORT_SCHEMA,
            "scope": scope,
            "repo_key": project,
            "repo_keys": sorted({item["repo_key"] for item in memories if item["repo_key"]}),
            "exported_at": utc_now(),
            "memories": memories,
        }

    def import_records(
        self,
        payload: dict[str, Any],
        *,
        project: str | None = None,
        trust: bool = False,
        scope: str = "all",
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Replay an export into this store, adding and merging only.

        Nothing here deletes, overwrites, or downgrades an existing memory, so
        the worst a bad file can do is queue statements for review. Untrusted
        records land as `inferred`, which `_activation` can only ever turn into
        `provisional` — a stranger's file cannot mint an actionable memory.

        Every record written gets a batch tag so the queue it creates can be
        resolved as one decision. Reviewing an import one `Enter` at a time is
        how a review queue turns into a thing nobody ever empties.
        """

        if not isinstance(payload, dict) or payload.get("schema") != EXPORT_SCHEMA:
            raise MemoryError(f"not an {EXPORT_SCHEMA} export payload")
        if scope not in {"global", "project", "all"}:
            raise MemoryError(f"invalid scope: {scope}")
        records = payload.get("memories")
        if not isinstance(records, list):
            raise MemoryError("export payload carries no memories list")

        batch = self._batch_token(len(records))
        report: dict[str, Any] = {
            "dry_run": dry_run,
            "batch": batch,
            "imported": 0,
            "merged": 0,
            "remapped": 0,
            "review_queued": 0,
            "skipped": [],
        }
        known_ids = {
            row[0] for row in self.db.conn.execute("SELECT id FROM memories").fetchall()
        }

        for item in records:
            if not isinstance(item, dict):
                self._skip(report, item, "malformed")
                continue
            record_scope = str(item.get("scope") or "")
            if scope != "all" and record_scope != scope:
                continue
            if str(item.get("state") or "") in {"retracted", "expired"}:
                self._skip(report, item, "inactive")
                continue

            if record_scope == "global":
                target: str | None = None
            else:
                target = project or (str(item.get("repo_key")) if item.get("repo_key") else None)
                if not target:
                    self._skip(report, item, "unknown-project")
                    continue
                if project and item.get("repo_key") != project:
                    report["remapped"] += 1

            try:
                candidate = self._imported_candidate(item, trust=trust, batch=batch)
            except (MemoryError, ValueError):
                self._skip(report, item, "malformed")
                continue

            if self._is_forgotten(candidate, target):
                self._skip(report, item, "forgotten")
                continue

            if dry_run:
                existing = self.db.conn.execute(
                    "SELECT 1 FROM memories WHERE content_hash=? AND state!='retracted'",
                    (content_digest(candidate, target),),
                ).fetchone()
                if existing:
                    report["merged"] += 1
                else:
                    report["imported"] += 1
                    if self._activation(candidate)[0] == "provisional":
                        report["review_queued"] += 1
                continue

            try:
                stored = self.create_memory(candidate, project=target or "")
            except MemoryError:
                self._skip(report, item, "unsafe")
                continue
            if stored is None:
                self._skip(report, item, "forgotten")
                continue
            if stored["id"] in known_ids:
                report["merged"] += 1
                continue
            known_ids.add(stored["id"])
            report["imported"] += 1
            if stored["state"] == "provisional":
                report["review_queued"] += 1

        return report

    @staticmethod
    def _batch_token(count: int) -> str:
        """Name one import so its queue can be resolved as a unit.

        Derived from the clock rather than randomness: the token is written into
        evidence rows, and a value a caller can reconstruct from the report is
        easier to carry between commands than one only the database has seen.
        """
        stamp = re.sub(r"[^0-9TZ]", "", utc_now())
        return f"imp_{stamp}_{digest_text(f'{stamp}:{count}')[:6]}"

    def _imported_candidate(
        self, item: dict[str, Any], *, trust: bool, batch: str | None = None
    ) -> Candidate:
        """Turn an exported record back into a candidate for the normal write path.

        Evidence keeps its summary and exit status but loses `event_id`: those
        ids name raw events in the *source* store, and a dangling reference
        would claim provenance this store cannot show.
        """

        confidence = float(item.get("confidence") or 0.0)
        evidence = [
            {key: value for key, value in entry.items() if key not in {"id", "event_id"}}
            for entry in item.get("evidence") or []
            if isinstance(entry, dict)
        ]
        if batch:
            evidence.append({"kind": IMPORT_BATCH_EVIDENCE, "summary": batch})
        candidate = Candidate(
            kind=str(item.get("kind") or ""),
            scope=str(item.get("scope") or ""),
            statement=str(item.get("statement") or ""),
            conditions=[str(value) for value in item.get("conditions") or []],
            path_globs=[str(value) for value in item.get("path_globs") or []],
            authority=str(item.get("authority") or "inferred") if trust else "inferred",
            confidence=confidence if trust else min(confidence, 0.5),
            evidence=evidence,
            valid_until=item.get("valid_until"),
            user_approved=trust and str(item.get("state") or "") == "active",
        )
        return candidate.validate()

    def _is_forgotten(self, candidate: Candidate, project: str | None) -> bool:
        digest = self._tombstone_digest(
            candidate.statement, candidate.scope, project if candidate.scope == "project" else None
        )
        return bool(
            self.db.conn.execute(
                "SELECT 1 FROM tombstones WHERE digest=? AND expires_at>?", (digest, utc_now())
            ).fetchone()
        )

    @staticmethod
    def _skip(report: dict[str, Any], item: Any, reason: str) -> None:
        statement = item.get("statement") if isinstance(item, dict) else None
        report["skipped"].append({"statement": str(statement or ""), "reason": reason})

    def gc(self) -> dict[str, int]:
        now = utc_now()
        cutoff = (datetime.now(UTC) - timedelta(days=30)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.db.transaction(immediate=True):
            events = self.db.conn.execute("DELETE FROM events WHERE expires_at<=?", (now,)).rowcount
            tombstones = self.db.conn.execute(
                "DELETE FROM tombstones WHERE expires_at<=?", (now,)
            ).rowcount
            expiring = self.db.conn.execute(
                "SELECT id FROM memories WHERE valid_until IS NOT NULL AND valid_until<=? "
                "AND state NOT IN ('expired','retracted')",
                (now,),
            ).fetchall()
            for row in expiring:
                self._change_state(row["id"], "expired", "validity elapsed")
            expired = len(expiring)
            jobs = self.db.conn.execute(
                "DELETE FROM jobs WHERE state='done' AND updated_at<?", (cutoff,)
            ).rowcount
            self.db.conn.execute("PRAGMA optimize")
        return {"events": events, "tombstones": tombstones, "expired": expired, "jobs": jobs}
