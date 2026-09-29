from __future__ import annotations

import fnmatch
import math
import os
import re
import sqlite3
import struct
import uuid
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable, Sequence

from .constants import DEFAULT_LIMIT, DEFAULT_TOKEN_BUDGET, PACKET_SCHEMA, REEXPOSE_AFTER_MINUTES
from .db import Database
from .providers import NullProvider, Provider, ProviderError
from .redaction import redact_text
from .service import record_from_row
from .util import (
    TRANSLATIONS,
    base_tokens,
    concepts_in,
    digest_text,
    fts_query,
    is_harness_message,
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

STOP_WORDS = frozenset(
    {
        "the", "a", "an", "i", "we", "do", "how", "what", "which", "for", "to", "of", "in",
        "on", "and", "or", "is", "are", "was", "were", "it", "this", "that", "please",
        "all", "done", "can", "you", "me", "my", "with", "be", "not", "if", "then",
        "해줘", "어떻게", "뭐", "무엇", "인가", "하는", "해야", "하지", "이거", "그거", "좀",
        "진행", "계속", "전에", "후에", "다음", "때", "것", "수",
    }
)
# A lexical or trigram hit is only a candidate. It is shown when the prompt's
# matched words carry enough evidence: rarity-weighted (idf normalized to 0..1,
# so one word unique to the record counts 1.0) with shared concepts and
# near-miss spellings counting less. One common word shared by chance -- "all",
# "step", "continue" -- stays below the floor.
RELEVANCE_FLOOR = 0.6
# Words this common add nothing: in long records they would otherwise sum
# past the floor on their own.
COMMON_TERM_IDF = 0.5
SHORT_PROMPT_TERMS = 4
CONCEPT_WEIGHT = 0.3
TRANSLATION_WEIGHT = 0.6
FUZZY_WEIGHT = 0.4


def is_maintenance_prompt(prompt: str) -> bool:
    return bool(
        MAINTENANCE_OPS_RE.search(prompt)
        or (MAINTENANCE_CHANGE_RE.search(prompt) and MAINTENANCE_DURABLE_RE.search(prompt))
    )


HANGUL_RE = re.compile(r"[가-힣]{2}")


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
        # FTS already splits identifiers inside documents; querying their parts
        # too would OR a common piece like "token" across the whole store.
        specific = [
            token
            for token in base_tokens(prompt, parts=False)
            if token not in STOP_WORDS and (len(token) >= 3 or HANGUL_RE.search(token))
        ]

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

    def _idf(self, terms: Iterable[str]) -> dict[str, float]:
        """Normalized inverse document frequency over the FTS vocabulary."""

        terms = list(dict.fromkeys(terms))
        if not terms or not self.db.fts5:
            return {term: 1.0 for term in terms}
        pieces = {term: [part for part in re.split(r"[^\w]+", term) if part] or [term] for term in terms}
        wanted = sorted({part for parts in pieces.values() for part in parts})
        try:
            # max(rowid) is O(log n) where count(*) scans; deletions only make
            # it overestimate N slightly, which idf tolerates.
            total = self.db.conn.execute("SELECT max(rowid) FROM memory_fts").fetchone()[0] or 0
            frequency: dict[str, int] = {}
            for chunk in _chunks(wanted):
                rows = self.db.conn.execute(
                    f"SELECT term,doc FROM memory_fts_vocab WHERE term IN ({','.join('?' for _ in chunk)})",
                    tuple(chunk),
                ).fetchall()
                frequency.update({str(row[0]): int(row[1]) for row in rows})
        except sqlite3.OperationalError:
            return {term: 1.0 for term in terms}
        ceiling = math.log(1 + max(total, 1))
        weights: dict[str, float] = {}
        for term, parts in pieces.items():
            # An identifier is as distinctive as its rarest part; a part the
            # index never saw is treated as unique.
            df = min(frequency.get(part, 1) for part in parts)
            weights[term] = math.log(1 + max(total, 1) / max(df, 1)) / ceiling if ceiling else 1.0
        return weights

    @staticmethod
    def _grams(token: str) -> set[str]:
        return {token[index : index + 3] for index in range(len(token) - 2)}

    def _relevance(self, prompt: str, records: dict[str, dict[str, Any]]) -> dict[str, float]:
        """Evidence each record's text gives for the prompt; see RELEVANCE_FLOOR."""

        terms = [
            token
            for token in dict.fromkeys(base_tokens(prompt))
            if token not in STOP_WORDS and (len(token) >= 3 or HANGUL_RE.search(token))
        ]
        concepts = set(concepts_in(prompt))
        translations = set(concepts_in(prompt, TRANSLATIONS))
        idf = self._idf(terms)
        # The common-word cutoff guards long prompts, where many common words
        # would sum past the floor. In a short prompt every word is the point:
        # "커밋 푸시하고" is about committing however common "커밋" is.
        cutoff = COMMON_TERM_IDF if len(terms) > SHORT_PROMPT_TERMS else 0.0
        scores: dict[str, float] = {}
        for memory_id, record in records.items():
            text = " ".join([record["statement"], *record.get("conditions", []), *record.get("path_globs", [])])
            words = set(base_tokens(text))
            score = sum(idf[term] for term in terms if term in words and idf[term] >= cutoff)
            score += CONCEPT_WEIGHT * len(concepts & set(concepts_in(text)))
            # A translation pair counts only across languages: same-language
            # use is already an exact word match.
            for concept in translations & set(concepts_in(text, TRANSLATIONS)):
                if not any(alias in words for alias in TRANSLATIONS[concept] if alias in set(base_tokens(prompt))):
                    score += TRANSLATION_WEIGHT
            for term in terms:
                if term in words or len(term) < 5:
                    continue
                grams = self._grams(term)
                if any(len(grams & self._grams(word)) >= 0.6 * len(grams) for word in words):
                    score += FUZZY_WEIGHT
            scores[memory_id] = score
        return scores

    def _recently_shown(self, session_id: str | None) -> set[str]:
        if not session_id:
            return set()
        cutoff = (datetime.now(UTC) - timedelta(minutes=REEXPOSE_AFTER_MINUTES)).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
        try:
            rows = self.db.conn.execute(
                "SELECT memory_id FROM session_exposures WHERE session_id=? AND exposed_at>?",
                (session_id, cutoff),
            ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {str(row[0]) for row in rows}

    def _clearing_floor(
        self, prompt: str, records: dict[str, dict[str, Any]], semantic: set[str]
    ) -> set[str]:
        scores = self._relevance(prompt, {key: value for key, value in records.items() if key not in semantic})
        return {key for key in records if key in semantic or scores.get(key, 0.0) >= RELEVANCE_FLOOR}

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
        session_id: str | None = None,
    ) -> dict[str, Any]:
        started = datetime.now(UTC)
        mode = "maintenance" if is_maintenance_prompt(prompt) and not is_harness_message(prompt) else "recall"
        query_id = f"qry_{uuid.uuid4().hex[:24]}"
        harness_message = is_harness_message(prompt)
        vector = [] if harness_message else self._vector(prompt)
        lexical = [] if harness_message else self._lexical(prompt)
        records = self._records(list(dict.fromkeys([*lexical, *vector])))
        # A vector hit is semantic evidence in itself; lexical and trigram hits
        # must clear the floor. Trigram (typos, spelling variants) is the
        # expensive OR scan, so it runs only when no lexical hit in this scope
        # cleared the floor -- not merely when lexical found nothing, which let
        # one chance word hide every spelling variant.
        semantic = set(vector)
        relevant = self._clearing_floor(prompt, records, semantic)
        trigram: list[str] = []
        if not harness_message and not any(
            record["scope"] == "global" or record.get("repo_key") == project
            for key, record in records.items()
            if key in relevant and key not in semantic
        ):
            trigram = self._trigram(prompt)
            extra = self._records([key for key in trigram if key not in records])
            records.update(extra)
            relevant |= self._clearing_floor(prompt, extra, semantic)
        ranks = [lexical, trigram, vector]
        if not any(ranks) and not harness_message:
            fallback = self._fallback(project, prompt)
            ranks.append(fallback)
            extra = self._records(fallback)
            records.update(extra)
            relevant |= self._clearing_floor(prompt, extra, semantic)
        combined: dict[str, float] = defaultdict(float)
        for ranked in ranks:
            for index, memory_id in enumerate(ranked):
                combined[memory_id] += 1.0 / (60 + index + 1)
        ordered_ids = sorted(combined, key=combined.get, reverse=True)
        records = {key: value for key, value in records.items() if key in relevant}
        trusted = self._trusted_kinds(project)
        if global_kind_ceiling is not None:
            # Repository policy can only tighten the user-level grant.
            trusted &= global_kind_ceiling
        path_context = self._path_context(prompt, paths)
        now = utc_now()
        exclude_ids = set(exclude_ids or ()) | self._recently_shown(session_id)
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
                "remote_semantic": bool(vector),
            },
            "elapsed_ms": round(elapsed_ms, 3),
            "token_estimate": consumed,
        }
        if not material:
            # Nothing was shown, so there is nothing to give feedback on.
            return packet
        # One lock acquisition, not 1+N. The connection is in autocommit mode
        # (`isolation_level=None`, db.py), so every bare `execute` is its own
        # implicit transaction — this log used to take and release the write lock
        # once for the query row plus once per exposed memory. That is what made
        # the prompt hook contend: several agents (Claude worktrees, Codex,
        # OpenCode) share one store, so acquisitions serialize across processes
        # and a `UserPromptSubmit` hook averaged 3.4s against its own 5s timeout.
        # Batching preserves every row and every guarantee; only the lock traffic
        # changes.
        # The answer is already built. Logging that we produced it is bookkeeping for
        # `feedback`, and bookkeeping must never cost the caller the answer — under a
        # busy store this write can fail, and an exception here would throw the packet
        # away and leave the prompt with no memory at all. Losing a feedback row only
        # costs that one query its usefulness score.
        try:
            with self.db.transaction(immediate=True):
                self.db.conn.execute(
                    "INSERT INTO retrieval_queries(id,repo_key,prompt_hash,mode,harness,created_at) VALUES(?,?,?,?,?,?)",
                    (query_id, project, digest_text(prompt), mode, harness, now),
                )
                exposures = [(query_id, item["id"], now, now) for item in [*items, *conflicts]]
                if exposures:
                    self.db.conn.executemany(
                        "INSERT OR IGNORE INTO retrieval_feedback(query_id,memory_id,exposed,created_at,updated_at) "
                        "VALUES(?,?,1,?,?)",
                        exposures,
                    )
                if session_id:
                    self.db.conn.executemany(
                        "INSERT INTO session_exposures(session_id,memory_id,exposed_at) VALUES(?,?,?) "
                        "ON CONFLICT(session_id,memory_id) DO UPDATE SET exposed_at=excluded.exposed_at",
                        [(session_id, memory_id, now) for _, memory_id, _, _ in exposures],
                    )
        except sqlite3.Error:
            packet["logged"] = False
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
        lines.append("</agent-memory>")
        return "\n".join(lines)
