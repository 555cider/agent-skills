from __future__ import annotations

SCHEMA_VERSION = 2
DB_FILENAME = "agent-memory.sqlite3"
EVENT_SCHEMA = "agent-memory.event.v2"
RECORD_SCHEMA = "memory.record.v2"
PACKET_SCHEMA = "agent-memory.packet.v2"
EXPORT_SCHEMA = "agent-memory.export.v2"
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
# What `export --scope` accepts; "project+global" is the legacy --include-global pair.
EXPORT_SCOPES = {"project", "project+global", "global", "all"}
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

# How long a connection waits for another process's write lock.
#
# One store is shared by every agent on the machine — several Claude worktrees,
# Codex and OpenCode — so writes serialize across processes and the wait is real.
# A CLI command the user typed (`remember`, `forget`, `gc`) should wait: losing an
# explicit save to a transient lock is worse than a slow one.
BUSY_TIMEOUT_MS = 5000
# A hook must not wait that long. It blocks the host's prompt loop and is
# fail-open by contract (`command_hook` swallows the error and prints `{}`), so
# giving up early costs one prompt's memory injection while waiting costs the
# user seconds of dead time on every prompt. Measured before this bound existed:
# `UserPromptSubmit` averaged 3,380ms against its own 5s hook timeout, and 16 runs
# in six days hit that timeout — spending the full wait AND losing the injection.
HOOK_BUSY_TIMEOUT_MS = 1000

DEFAULT_OPENAI_MODEL = "gpt-5.6-luna"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
