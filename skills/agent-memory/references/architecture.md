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
  -> harness messages (<task-notification>, <agent-message>) stop here: no recall
  -> maintenance detection
  -> FTS5 + optional sqlite-vec candidates; trigram only when no lexical hit
     in scope clears the relevance floor
  -> relevance floor (see below)
  -> scope/state/trust/condition filter, minus records this session saw
     in the last 2 hours, minus records restating a rule the host already
     loads (CLAUDE.md for Claude, AGENTS.md for Codex/OpenCode; home file and
     every directory up from cwd; instructions.py)
  -> reciprocal-rank fusion and bounded boosts
  -> <=8 record / ~1200 token packet

another agent's memory files            (sources.py)
  -> discover CLAUDE.md / AGENTS.md / ~/.codex/memories / .remember
  -> markdown blocks under their heading path
  -> durability line: rules kept, session narrative dropped
  -> scope routed per record (home / repo / applies_to cwd)
  -> home directories rewritten to ~
  -> agent-memory.export.v2 payload
  -> import_records, untrusted            (the ordinary write path)
```

`sources.py` reads files and never touches the database. Adoption reaches the
store only through `import_records`, so redaction, tombstones, content-hash
merging, and the `inferred`/`provisional` ceiling are enforced in one place for
hooks, export files, and foreign memory alike. Its two judgements — which scope
a record belongs to, and whether a statement is a rule or a record of what
happened once — are made before the payload exists, because neither can be
recovered downstream.

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
- `evidence`: local event/command/test evidence, and the `import.batch` /
  `import.<source>` rows that make one import addressable for bulk review.
- `relations`: `supersedes` and `conflicts_with` graph edges.
- `jobs`: pending/leased/done/dead work with retry metadata.
- `retrieval_queries` and `retrieval_feedback`: exposure and actual-use signals,
  written only for a recall that showed something.
- `session_exposures`: what each session was shown, so a long conversation is
  not re-sent the same records on every prompt.
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

## Relevance floor

A lexical or trigram hit is a candidate, not a result. Each candidate is scored
by the prompt words its text contains, weighted by rarity (idf over the FTS
vocabulary, normalized so a word unique to one record counts 1.0), plus 0.3 per
shared broad concept (`verify`, `commit`, ...), 0.6 per cross-language
translation pair (`빌드`/`build`), and 0.4 per near-miss spelling. Only
candidates scoring at least 0.6 are shown. In prompts with more than four
content words, words with idf under 0.5 count zero, so common words cannot sum
past the floor. Tokens include Korean stems (`배포가` -> `배포`) and the parts
of compound identifiers (`gemini-3.1-flash-lite` -> `flash`, `lite`, ...), and
concept aliases match whole tokens only. A record with at least three explicit
feedback votes in the last 60 days, fewer than a third of them `--used`, must
score twice the floor. `tests/golden_retrieval.json` holds
the positive and noise cases the floor is tuned against.

