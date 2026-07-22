from __future__ import annotations

import fnmatch
import math
import os
import re
import sqlite3
import struct
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any, Iterable, Sequence

from .constants import DEFAULT_LIMIT, DEFAULT_TOKEN_BUDGET, PACKET_SCHEMA
from .db import Database
from .providers import NullProvider, Provider, ProviderError
from .redaction import redact_text
from .service import record_from_row
from .util import (
    digest_text,
    fts_query,
    normalize_text,
    rough_tokens,
    semantic_tokens,
    utc_now,
)


# Maintenance mode suppresses actionable memory, so a false positive silently
# hides relevant records. Change words like "대신/instead of" alone are common
# in ordinary coding questions; they only signal maintenance when combined
# with a durability marker, while explicit memory operations always do.
MAINTENANCE_OPS_RE = re.compile(
    r"(?i)\bforget\b"
    r"|remove .{0,24}from memory"
    r"|delete .{0,24}memor"
    r"|update .{0,40}\b(?:memory|memories|decision|preference|constraint)\b"
    r"|기억.{0,8}(?:삭제|지워|잊)"
    r"|잊어"
    r"|메모리.{0,8}(?:삭제|업데이트|정리|수정)"
    r"|(?:기억|메모리|결정).{0,20}(?:바꿔|변경|업데이트|정정)"
)
MAINTENANCE_CHANGE_RE = re.compile(
    r"(?i)\bdo not use\b|\bdon'?t use\b|\bnever use\b|\bstop using\b|\bno longer\b|\binstead of\b"
    r"|대신|말고|쓰지\s*마|사용하지\s*마"
)
MAINTENANCE_DURABLE_RE = re.compile(
    r"(?i)\bfrom now on\b|\bgoing forward\b|\banymore\b|이제부터|이제는|이제\b|앞으로"
)

TRUNCATED_MIN_TOKENS = 160


def is_maintenance_prompt(prompt: str) -> bool:
    return bool(
        MAINTENANCE_OPS_RE.search(prompt)
        or (MAINTENANCE_CHANGE_RE.search(prompt) and MAINTENANCE_DURABLE_RE.search(prompt))
    )


def _chunks(values: Sequence[str], size: int = 500) -> Iterable[Sequence[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _char_ngrams(text: str, *, n: int = 3, maximum: int = 24) -> list[str]:
    compact = re.sub(r"\s+", " ", normalize_text(text))
    output: list[str] = []
    for token in compact.split():
        if len(token) < n:
            continue
        for index in range(len(token) - n + 1):
            gram = token[index : index + n]
            if gram not in output:
                output.append(gram)
            if len(output) >= maximum:
                return output
    return output


class Retriever:
    def __init__(self, db: Database, provider: Provider) -> None:
        self.db = db
        self.provider = provider

    def _lexical(self, prompt: str, maximum: int = 120) -> list[str]:
        if not self.db.fts5:
            return []
        raw = re.findall(r"[\w가-힣][\w가-힣.:/+_-]*", normalize_text(prompt))
        stop = {
            "the", "a", "an", "i", "we", "do", "how", "what", "which", "for", "to",
            "is", "are", "was", "were", "it", "this", "that", "please", "해줘", "어떻게",
            "뭐", "무엇", "인가", "하는", "해야", "하지",
        }
        specific = [token for token in raw if len(token) >= 3 and token not in stop]

        def execute(tokens: Sequence[str]) -> list[str]:
            query = fts_query(tokens, limit=24)
            if not query:
                return []
            try:
                rows = self.db.conn.execute(
                    "SELECT memory_id,bm25(memory_fts,0.0,5.0,2.0,1.0,0.65) AS score "
                    "FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?",
                    (query, maximum),
                ).fetchall()
                return [str(row["memory_id"]) for row in rows]
            except sqlite3.OperationalError:
                return []

        # Exact user terms are both cheaper and more discriminating. Expanded
        # bilingual concepts are a fallback, avoiding a broad OR scan when a
        # command, path, or identifier already pins the target.
        primary = execute(specific)
        return primary or execute(semantic_tokens(prompt))

    def _trigram(self, prompt: str, maximum: int = 120) -> list[str]:
        if not self.db.trigram:
            return []
        grams = _char_ngrams(prompt)
        if not grams:
            return []
        query = " OR ".join(f'"{gram.replace(chr(34), "")}"' for gram in grams)
        try:
            rows = self.db.conn.execute(
                "SELECT memory_id,bm25(memory_trigram) AS score FROM memory_trigram "
                "WHERE memory_trigram MATCH ? ORDER BY score LIMIT ?",
                (query, maximum),
            ).fetchall()
            return [str(row["memory_id"]) for row in rows]
        except sqlite3.OperationalError:
            return []

    def _vector(self, prompt: str, maximum: int = 80) -> list[str]:
        if (
            not self.db.vector
            or isinstance(self.provider, NullProvider)
            or os.environ.get("AGENT_MEMORY_SEMANTIC_RECALL", "0") not in {"1", "true", "yes"}
        ):
            return []
        try:
            redacted = redact_text(prompt)
            if redacted.findings and not redacted.value.strip():
                return []
            vectors = self.provider.embed([redacted.value])
            if not vectors:
                return []
            vector = vectors[0]
            blob = struct.pack(f"<{len(vector)}f", *vector)
            rows = self.db.conn.execute(
                "SELECT map.memory_id,vec.distance FROM memory_vec AS vec "
                "JOIN memory_vector_map AS map ON map.rowid=vec.rowid "
                "WHERE vec.embedding MATCH ? AND k=? ORDER BY vec.distance",
                (blob, maximum),
            ).fetchall()
            return [str(row["memory_id"]) for row in rows]
        except (ProviderError, sqlite3.Error, struct.error) as exc:
            self.db.set_meta(
                "last_vector_recall_error",
                redact_text(f"{type(exc).__name__}: {exc}"[:2000]).value[:1000],
            )
            return []

    def _fallback(self, project: str, prompt: str, maximum: int = 120) -> list[str]:
        # This bounded path is for SQLite builds without FTS, not a full scan.
        rows = self.db.conn.execute(
            "SELECT id,statement FROM memories WHERE (repo_key=? OR scope='global') "
            "AND state IN ('active','provisional','disputed') ORDER BY updated_at DESC LIMIT 500",
            (project,),
        ).fetchall()
        query = set(semantic_tokens(prompt))
        scored: list[tuple[float, str]] = []
        for row in rows:
            terms = set(semantic_tokens(row["statement"]))
            if not query or not terms:
                continue
            score = len(query & terms) / math.sqrt(len(query) * len(terms))
            if score > 0:
                scored.append((score, str(row["id"])))
        scored.sort(reverse=True)
        return [item[1] for item in scored[:maximum]]

    def _records(self, ids: Sequence[str]) -> dict[str, dict[str, Any]]:
        output: dict[str, dict[str, Any]] = {}
        for chunk in _chunks(ids):
            placeholders = ",".join("?" for _ in chunk)
            rows = self.db.conn.execute(
                f"SELECT * FROM memories WHERE id IN ({placeholders})", tuple(chunk)
            ).fetchall()
            for row in rows:
                output[str(row["id"])] = record_from_row(self.db, row)
        return output

    def _trusted_kinds(self, project: str) -> set[str]:
        rows = self.db.conn.execute(
            "SELECT memory_kind FROM trust_grants WHERE repo_key=?", (project,)
        ).fetchall()
        return {str(row[0]) for row in rows}

    @staticmethod
    def _path_context(prompt: str, extra: Sequence[str]) -> list[str]:
        paths = list(extra)
        paths.extend(
            match.group(0).strip("`'\"")
            for match in re.finditer(r"(?:[\w.-]+/)+[\w.*+-]+", prompt)
        )
        return list(dict.fromkeys(paths))

    @staticmethod
    def _condition_matches(
        record: dict[str, Any], prompt: str, harness: str, paths: Sequence[str]
    ) -> bool:
        for condition in record.get("conditions", []):
            value = str(condition).strip()
            lower = value.casefold()
            if lower.startswith("harness=") and lower.split("=", 1)[1].strip() != harness:
                return False
            if lower.startswith(("path=", "path:")):
                glob = value.split("=", 1)[1] if "=" in value else value.split(":", 1)[1]
                if paths and not any(fnmatch.fnmatch(path, glob.strip()) for path in paths):
                    return False
            if lower.startswith(("prompt=", "prompt:")):
                needle = value.split("=", 1)[1] if "=" in value else value.split(":", 1)[1]
                if normalize_text(needle) not in normalize_text(prompt):
                    return False
        globs = [str(item) for item in record.get("path_globs", [])]
        if globs and paths and not any(
            fnmatch.fnmatch(path, glob) for path in paths for glob in globs
        ):
            return False
        return True

    @staticmethod
    def _is_valid(record: dict[str, Any], now: str) -> bool:
        return not record.get("valid_until") or str(record["valid_until"]) > now

    @staticmethod
    def _stale(record: dict[str, Any], now: str) -> bool:
        return bool(record.get("stale_after") and str(record["stale_after"]) <= now)

    def recall(
        self,
        *,
        project: str,
        prompt: str,
        harness: str = "generic",
        limit: int = DEFAULT_LIMIT,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
        paths: Sequence[str] = (),
        global_kind_ceiling: set[str] | None = None,
        exclude_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        started = datetime.now(UTC)
        mode = "maintenance" if is_maintenance_prompt(prompt) else "recall"
        query_id = f"qry_{uuid.uuid4().hex[:24]}"
        lexical = self._lexical(prompt)
        trigram = [] if lexical else self._trigram(prompt)
        ranks = [lexical, trigram, self._vector(prompt)]
        if not any(ranks):
            ranks.append(self._fallback(project, prompt))
        combined: dict[str, float] = defaultdict(float)
        for ranked in ranks:
            for index, memory_id in enumerate(ranked):
                combined[memory_id] += 1.0 / (60 + index + 1)
        ordered_ids = sorted(combined, key=combined.get, reverse=True)
        records = self._records(ordered_ids)
        trusted = self._trusted_kinds(project)
        if global_kind_ceiling is not None:
            # Repository policy can only tighten the user-level grant.
            trusted &= global_kind_ceiling
        path_context = self._path_context(prompt, paths)
        now = utc_now()
        eligible: list[tuple[float, dict[str, Any]]] = []
        rejected_global = 0
        for memory_id in ordered_ids:
            if exclude_ids and memory_id in exclude_ids:
                continue
            record = records.get(memory_id)
            if not record:
                continue
            if record["scope"] == "project" and record.get("repo_key") != project:
                continue
            if record["scope"] == "global" and record["kind"] not in trusted:
                rejected_global += 1
                continue
            if not self._is_valid(record, now):
                continue
            if not self._condition_matches(record, prompt, harness, path_context):
                continue
            score = combined[memory_id]
            if record["scope"] == "project":
                score *= 1.18
            if record["authority"] in {"explicit", "approved"}:
                score *= 1.12
            elif record["authority"] == "verified":
                score *= 1.06
            if self._stale(record, now):
                score *= 0.55
            eligible.append((score, record))
        eligible.sort(key=lambda item: (item[0], item[1]["updated_at"]), reverse=True)

        items: list[dict[str, Any]] = []
        conflicts: list[dict[str, Any]] = []
        consumed = 0
        for score, record in eligible:
            stale = self._stale(record, now)
            view = {
                key: record[key]
                for key in (
                    "schema",
                    "id",
                    "kind",
                    "scope",
                    "repo_key",
                    "path_globs",
                    "statement",
                    "conditions",
                    "state",
                    "authority",
                    "confidence",
                    "valid_from",
                    "valid_until",
                    "revision",
                    "last_verified_at",
                    "evidence",
                )
            }
            view.update(
                {
                    "score": round(score, 8),
                    "stale": stale,
                    "truncated": False,
                    "actionable": record["state"] == "active" and mode == "recall",
                }
            )
            if mode == "maintenance" or record["state"] == "disputed":
                view["actionable"] = False
                view["reason"] = (
                    "current prompt is changing or removing this memory"
                    if mode == "maintenance"
                    else "conflicting evidence is unresolved"
                )
                conflicts.append(view)
                if len(conflicts) >= limit:
                    break
                continue
            if record["state"] != "active":
                continue
            cost = rough_tokens(record["statement"] + " " + " ".join(record["conditions"])) + 20
            if consumed + cost > token_budget:
                remaining = token_budget - consumed
                if cost > token_budget and len(items) < limit and remaining >= TRUNCATED_MIN_TOKENS:
                    # A record that can never fit the budget still surfaces as
                    # a truncated head with a pointer instead of silently
                    # vanishing from every packet.
                    allowed_bytes = max(0, (remaining - 24) * 4)
                    head = (
                        record["statement"]
                        .encode("utf-8")[:allowed_bytes]
                        .decode("utf-8", errors="ignore")
                        .rstrip()
                    )
                    view["statement"] = head + " …"
                    view["truncated"] = True
                    consumed += remaining
                    items.append(view)
                    if len(items) >= limit:
                        break
                continue
            consumed += cost
            items.append(view)
            if len(items) >= limit:
                break

        material = bool(items or conflicts)
        context = self.render_context(mode, items, conflicts, query_id) if material else ""
        elapsed_ms = (datetime.now(UTC) - started).total_seconds() * 1000
        packet = {
            "schema": PACKET_SCHEMA,
            "query_id": query_id,
            "mode": mode,
            "items": items,
            "conflicts": conflicts,
            "freshness": {
                "stale_items": sum(bool(item["stale"]) for item in items),
                "generated_at": now,
            },
            "visibility": {
                "material": material,
                "reason": "memory changes the action or exposes a conflict" if material else "no relevant actionable memory",
            },
            "context": context,
            "trust": {
                "global_kinds": sorted(trusted),
                "blocked_global_candidates": rejected_global,
            },
            "backend": {
                "fts5": self.db.fts5,
                "trigram": self.db.trigram,
                "sqlite_vec": self.db.vector,
                "remote_semantic": bool(ranks[2]) if len(ranks) >= 3 else False,
            },
            "elapsed_ms": round(elapsed_ms, 3),
            "token_estimate": consumed,
        }
        self.db.conn.execute(
            "INSERT INTO retrieval_queries(id,repo_key,prompt_hash,mode,harness,created_at) VALUES(?,?,?,?,?,?)",
            (query_id, project, digest_text(prompt), mode, harness, now),
        )
        for item in [*items, *conflicts]:
            self.db.conn.execute(
                "INSERT OR IGNORE INTO retrieval_feedback(query_id,memory_id,exposed,created_at,updated_at) "
                "VALUES(?,?,1,?,?)",
                (query_id, item["id"], now, now),
            )
        return packet

    @staticmethod
    def render_context(
        mode: str,
        items: Sequence[dict[str, Any]],
        conflicts: Sequence[dict[str, Any]],
        query_id: str = "",
    ) -> str:
        opening = f'<agent-memory schema="{PACKET_SCHEMA}" mode="{mode}"'
        if query_id:
            opening += f' query-id="{query_id}"'
        lines = [opening + ">"]
        if mode == "maintenance":
            lines.append(
                "The current prompt changes or removes prior memory. Treat the current prompt as authoritative; the records below are non-actionable maintenance matches."
            )
        else:
            lines.append("Relevant durable memory (the current user prompt always has higher authority):")
        for item in items:
            markers = [item["kind"], item["authority"]]
            if item.get("stale"):
                markers.append("stale-unverified")
            lines.append(f"- [{item['id']} | {' | '.join(markers)}] {item['statement']}")
            if item.get("conditions"):
                lines.append("  Conditions: " + "; ".join(item["conditions"]))
            if item.get("truncated"):
                lines.append(
                    f"  (truncated — full record: agent-memory review show {item['id']})"
                )
        for item in conflicts:
            lines.append(
                f"- [NON-ACTIONABLE {item['id']} | {item['state']}] {item['statement']} ({item['reason']})"
            )
        lines.append("Mention memory only if it materially changes your action or decision.")
        if query_id and items:
            lines.append(
                f"Record actual use with: agent-memory feedback {query_id} <memory-id> --used|--unused"
            )
        lines.append("</agent-memory>")
        return "\n".join(lines)
