# Architecture

## Data flow

```text
harness semantic event
  -> normalize and redact
  -> compressed short-term event journal
  -> stop/session-end job
  -> leased one-shot worker
  -> local extraction + optional provider
  -> evidence validation and reconciliation
  -> current record + immutable revision + evidence + indexes

current prompt
  -> maintenance detection
  -> scope/state/trust/condition filter
  -> FTS5 + trigram + optional sqlite-vec candidates
  -> reciprocal-rank fusion and bounded boosts
  -> <=8 record / ~1200 token packet
```

Maintenance mode requires an explicit memory operation, or a change word
("instead of", "대신") combined with a durability marker ("from now on",
"이제"); a change word alone never suppresses recall. A record whose statement
alone exceeds the token budget is injected truncated with a pointer rather
than dropped. After queued jobs, the worker embeds active records missing a
current-model vector when a provider is configured.

SQLite at `~/.agents/memory/agent-memory.sqlite3` is authoritative. WAL,
foreign keys, `busy_timeout`, and `secure_delete` are enabled. FTS5, trigram,
and vector tables are indexes, not alternate stores.

## Tables

- `events`: redacted zlib payload, digest, TTL, integration timestamp.
- `memories`: current durable state.
- `memory_revisions`: immutable snapshots for each revision.
- `evidence`: local event/command/test evidence.
- `relations`: `supersedes` and `conflicts_with` graph edges.
- `jobs`: pending/leased/done/dead work with retry metadata.
- `retrieval_queries` and `retrieval_feedback`: exposure and actual-use signals.
- `trust_grants`: repo+kind global-memory grants.
- `sessions`: exact or repo/harness wildcard pause state.
- `tombstones`: contentless HMAC digests for forgotten statements.
- `memory_embeddings`, `memory_vector_map`, `memory_vec`: optional vectors.

## Retrieval

Exact user tokens are queried first to keep selective retrieval cheap.
Bilingual concept expansion is used only when exact terms miss. Trigram search
handles typos. When explicitly enabled, sqlite-vec candidates join those lists.
Reciprocal-rank fusion avoids incomparable backend scores.

Project scope, active state, user trust, repository ceiling, validity,
conditions, and paths are filters. Project, explicit authority, and verified
evidence receive bounded boosts. A stale procedure/caveat is downranked 45%
but retained for possible verification.

## Failure model

- Hook exceptions return `{}` and exit zero.
- Prompt-time recall never requires a provider.
- Missing/broken sqlite-vec leaves FTS/trigram active.
- Provider failures retry with an expiring DB lease and exponential delay.
- Five failed attempts produce a visible dead letter.
- One process lock plus transactional job claims prevent concurrent workers
  from processing the same lease.
- Duplicate semantic events are idempotent by normalized event id.
- Exact-content memory dedupe makes worker retries safe.
- Forget matches raw statement tokens only; a query matching more than five
  records requires explicit bulk confirmation, and hook-observed forgets apply
  only to at most two matches.
- `doctor`/`integrate` status marks a managed hook stale when its python or
  script path no longer exists.

The worker never mutates harness configuration. Integration changes are a
separate dry-run/apply operation with backups.
