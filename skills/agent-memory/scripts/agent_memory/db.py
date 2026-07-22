from __future__ import annotations

import json
import os
import sqlite3
import struct
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from .constants import DB_FILENAME, SCHEMA_VERSION, VECTOR_DIMENSIONS
from .util import MemoryError, stable_json, utc_now


SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  payload_zlib BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  redactions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  integrated_at TEXT
);
CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, created_at);
CREATE INDEX IF NOT EXISTS events_expiry_idx ON events(expires_at);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  repo_key TEXT,
  path_globs_json TEXT NOT NULL DEFAULT '[]',
  statement TEXT NOT NULL,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  authority TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  stale_after TEXT,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  CHECK(scope IN ('project','global')),
  CHECK(state IN ('active','provisional','disputed','retracted','expired'))
);
CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope, repo_key, state, kind);
CREATE INDEX IF NOT EXISTS memories_hash_idx ON memories(content_hash);

CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id, revision),
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  command TEXT,
  exit_status INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS evidence_memory_idx ON evidence(memory_id, revision);

CREATE TABLE IF NOT EXISTS relations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, target_id, relation),
  FOREIGN KEY(source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  session_id TEXT,
  event_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  leased_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, event_id)
);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, available_at, leased_until);

CREATE TABLE IF NOT EXISTS retrieval_queries (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  mode TEXT NOT NULL,
  harness TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  query_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  exposed INTEGER NOT NULL DEFAULT 1,
  used INTEGER,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(query_id, memory_id),
  FOREIGN KEY(query_id) REFERENCES retrieval_queries(id) ON DELETE CASCADE,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trust_grants (
  repo_key TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY(repo_key, memory_kind)
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  digest TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  repo_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tombstones_expiry_idx ON tombstones(expires_at);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_blob BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS memory_vector_map (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
"""


class Database:
    def __init__(self, home: Path, *, readonly: bool = False) -> None:
        self.home = home
        self.path = home / DB_FILENAME
        if readonly:
            if not self.path.exists():
                raise MemoryError(f"memory database does not exist: {self.path}")
            uri = f"file:{self.path}?mode=ro"
            self.conn = sqlite3.connect(uri, uri=True, timeout=5)
        else:
            home.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(home, 0o700)
            except OSError:
                pass
            self.conn = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute("PRAGMA secure_delete=ON")
        if not readonly:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self._initialize()
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        self.fts5 = self._table_exists("memory_fts")
        self.trigram = self._table_exists("memory_trigram")
        self.vector = self._load_vector() if not readonly else False

    def _initialize(self) -> None:
        self.conn.executescript(SCHEMA)
        row = self.conn.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
        if row and int(row[0]) != SCHEMA_VERSION:
            raise MemoryError(
                f"unsupported database schema {row[0]}; Agent Memory v2 does not migrate older stores"
            )
        self.conn.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version',?)",
            (str(SCHEMA_VERSION),),
        )
        self.conn.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('created_at',?)", (utc_now(),)
        )
        self.conn.execute(
            "INSERT OR IGNORE INTO metadata(key,value) VALUES('tombstone_key',lower(hex(randomblob(32))))"
        )
        try:
            self.conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5("
                "memory_id UNINDEXED, statement, conditions, paths, semantic, tokenize='unicode61 remove_diacritics 2')"
            )
        except sqlite3.OperationalError:
            pass
        try:
            self.conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memory_trigram USING fts5("
                "memory_id UNINDEXED, text, tokenize='trigram')"
            )
        except sqlite3.OperationalError:
            pass

    def _table_exists(self, name: str) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')", (name,)
        ).fetchone()
        return bool(row)

    def _load_vector(self) -> bool:
        try:
            import sqlite_vec  # type: ignore

            self.conn.enable_load_extension(True)
            sqlite_vec.load(self.conn)
            self.conn.enable_load_extension(False)
            self.conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[{VECTOR_DIMENSIONS}])"
            )
            return True
        except (ImportError, AttributeError, sqlite3.Error, OSError):
            try:
                self.conn.enable_load_extension(False)
            except (AttributeError, sqlite3.Error):
                pass
            return False

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        self.conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield self.conn
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        else:
            self.conn.execute("COMMIT")

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.conn.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO metadata(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def index_memory(
        self,
        memory_id: str,
        statement: str,
        conditions: Sequence[str],
        paths: Sequence[str],
        semantic: Sequence[str],
        *,
        replace: bool = False,
    ) -> None:
        if self.fts5:
            if replace:
                self.conn.execute("DELETE FROM memory_fts WHERE memory_id=?", (memory_id,))
            self.conn.execute(
                "INSERT INTO memory_fts(memory_id,statement,conditions,paths,semantic) VALUES(?,?,?,?,?)",
                (memory_id, statement, " ".join(conditions), " ".join(paths), " ".join(semantic)),
            )
        if self.trigram:
            if replace:
                self.conn.execute("DELETE FROM memory_trigram WHERE memory_id=?", (memory_id,))
            self.conn.execute(
                "INSERT INTO memory_trigram(memory_id,text) VALUES(?,?)",
                (memory_id, " ".join([statement, *conditions, *paths, *semantic])),
            )

    def unindex_memory(self, memory_id: str) -> None:
        if self.fts5:
            self.conn.execute("DELETE FROM memory_fts WHERE memory_id=?", (memory_id,))
        if self.trigram:
            self.conn.execute("DELETE FROM memory_trigram WHERE memory_id=?", (memory_id,))
        if self.vector:
            row = self.conn.execute(
                "SELECT rowid FROM memory_vector_map WHERE memory_id=?", (memory_id,)
            ).fetchone()
            if row:
                self.conn.execute("DELETE FROM memory_vec WHERE rowid=?", (row[0],))

    def put_embedding(self, memory_id: str, model: str, vector: Sequence[float]) -> None:
        blob = struct.pack(f"<{len(vector)}f", *[float(item) for item in vector])
        self.conn.execute(
            "INSERT INTO memory_embeddings(memory_id,model,dimensions,vector_blob,updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,"
            "vector_blob=excluded.vector_blob,updated_at=excluded.updated_at",
            (memory_id, model, len(vector), blob, utc_now()),
        )
        if self.vector and len(vector) == VECTOR_DIMENSIONS:
            self.conn.execute(
                "INSERT OR IGNORE INTO memory_vector_map(memory_id) VALUES(?)", (memory_id,)
            )
            rowid = self.conn.execute(
                "SELECT rowid FROM memory_vector_map WHERE memory_id=?", (memory_id,)
            ).fetchone()[0]
            self.conn.execute("DELETE FROM memory_vec WHERE rowid=?", (rowid,))
            self.conn.execute("INSERT INTO memory_vec(rowid,embedding) VALUES(?,?)", (rowid, blob))

    @staticmethod
    def encode_payload(payload: dict[str, Any]) -> bytes:
        return zlib.compress(stable_json(payload).encode("utf-8"), level=6)

    @staticmethod
    def decode_payload(blob: bytes) -> dict[str, Any]:
        value = json.loads(zlib.decompress(blob).decode("utf-8"))
        return value if isinstance(value, dict) else {}

    def integrity(self) -> str:
        row = self.conn.execute("PRAGMA quick_check").fetchone()
        return str(row[0]) if row else "unknown"

    def rebuild_indexes(self, embedding_model: str | None = None) -> int:
        if self.fts5:
            self.conn.execute("DELETE FROM memory_fts")
        if self.trigram:
            self.conn.execute("DELETE FROM memory_trigram")
        rows = self.conn.execute(
            "SELECT id,statement,conditions_json,path_globs_json FROM memories"
        ).fetchall()
        from .util import semantic_tokens

        for row in rows:
            self.index_memory(
                row["id"],
                row["statement"],
                json.loads(row["conditions_json"]),
                json.loads(row["path_globs_json"]),
                semantic_tokens(row["statement"]),
            )
        if self.vector:
            # The vector table is an index over memory_embeddings, so a late
            # sqlite-vec install or a reindex must be able to reconstruct it.
            self.conn.execute("DELETE FROM memory_vec")
            self.conn.execute("DELETE FROM memory_vector_map")
            sql = "SELECT memory_id,vector_blob FROM memory_embeddings WHERE dimensions=?"
            params: tuple[Any, ...] = (VECTOR_DIMENSIONS,)
            if embedding_model:
                sql += " AND model=?"
                params += (embedding_model,)
            for row in self.conn.execute(sql, params).fetchall():
                self.conn.execute(
                    "INSERT OR IGNORE INTO memory_vector_map(memory_id) VALUES(?)",
                    (row["memory_id"],),
                )
                rowid = self.conn.execute(
                    "SELECT rowid FROM memory_vector_map WHERE memory_id=?",
                    (row["memory_id"],),
                ).fetchone()[0]
                self.conn.execute(
                    "INSERT INTO memory_vec(rowid,embedding) VALUES(?,?)",
                    (rowid, row["vector_blob"]),
                )
        return len(rows)
