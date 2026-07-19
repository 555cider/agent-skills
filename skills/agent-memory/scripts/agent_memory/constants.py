from __future__ import annotations

SCHEMA_VERSION = 2
DB_FILENAME = "agent-memory.sqlite3"
EVENT_SCHEMA = "agent-memory.event.v2"
RECORD_SCHEMA = "memory.record.v2"
PACKET_SCHEMA = "agent-memory.packet.v2"
PROVIDER_REQUEST_SCHEMA = "agent-memory.provider.request.v2"
PROVIDER_RESPONSE_SCHEMA = "agent-memory.provider.response.v2"

EVENT_KINDS = {
    "session_start",
    "user_prompt",
    "tool_completed",
    "assistant_stop",
    "session_end",
}
MEMORY_KINDS = {
    "preference",
    "constraint",
    "decision",
    "procedure",
    "caveat",
    "handoff",
}
MEMORY_STATES = {"active", "provisional", "disputed", "retracted", "expired"}
AUTHORITIES = {"explicit", "approved", "verified", "inferred", "assistant"}
SCOPES = {"project", "global"}
HARNESSES = {"claude", "codex", "opencode", "generic"}

RAW_CHAT_TTL_DAYS = 7
HANDOFF_TTL_DAYS = 14
TOMBSTONE_TTL_DAYS = 7
PROCEDURE_STALE_DAYS = 90
TOOL_OUTPUT_LIMIT_BYTES = 8 * 1024
MAX_EVENT_TEXT = 32 * 1024
DEFAULT_LIMIT = 8
DEFAULT_TOKEN_BUDGET = 1200
MAX_JOB_ATTEMPTS = 5
LEASE_SECONDS = 60
VECTOR_DIMENSIONS = 1536

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
