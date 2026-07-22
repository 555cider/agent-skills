# JSON contracts

All public JSON objects use explicit v2 schema names. Additive fields may be
introduced, but consumers must reject a different major schema.

## `memory.record.v2`

```json
{
  "schema": "memory.record.v2",
  "id": "mem_...",
  "kind": "preference",
  "scope": "project",
  "repo_key": "repo-0123456789abcdef",
  "path_globs": ["frontend/**"],
  "statement": "Prefer rendered UI checks after layout edits.",
  "conditions": ["harness=codex"],
  "state": "active",
  "authority": "explicit",
  "confidence": 1.0,
  "valid_from": "2026-07-19T00:00:00.000Z",
  "valid_until": null,
  "stale_after": null,
  "revision": 1,
  "last_verified_at": "2026-07-19T00:00:00.000Z",
  "evidence": []
}
```

Kinds are `preference`, `constraint`, `decision`, `procedure`, `caveat`, and
`handoff`. States are `active`, `provisional`, `disputed`, `retracted`, and
`expired`. Authorities are `explicit`, `approved`, `verified`, `inferred`, and
`assistant`.

Only `state=active` can be actionable, and only after scope, trust, validity,
path, and condition filtering.

## `agent-memory.packet.v2`

`recall --format json` returns:

```json
{
  "schema": "agent-memory.packet.v2",
  "query_id": "qry_...",
  "mode": "recall",
  "items": [],
  "conflicts": [],
  "freshness": {"stale_items": 0, "generated_at": "..."},
  "visibility": {"material": false, "reason": "..."},
  "context": "",
  "trust": {"global_kinds": [], "blocked_global_candidates": 0},
  "backend": {
    "fts5": true,
    "trigram": true,
    "sqlite_vec": false,
    "remote_semantic": false
  },
  "elapsed_ms": 0.5,
  "token_estimate": 0
}
```

`mode` is `recall` or `maintenance`. In maintenance mode, `items` is empty and
matching old records appear under `conflicts` with `actionable=false`.

Each returned item includes record identity, statement, state, authority,
confidence, revision, evidence, retrieval score, `stale`, `truncated`, and
`actionable`. The rendered `context` is bounded to eight records and roughly
1,200 tokens by default; its opening tag carries `query-id`. A record whose
statement alone exceeds the budget is injected as a truncated head with
`truncated=true` and a `review show` pointer instead of being dropped.

Every exposed item creates a feedback target keyed by `query_id` and memory id.
Exposure does not set `used`; only `feedback --used` does.

## Other command results

- `remember`: one complete `memory.record.v2`.
- `forget`: `removed`, `total`, and `tombstone_days`.
- `review list`: an array of records; `show` also includes immutable revisions
  and relations.
- `policy trust list`: `repo_key`, `memory_kind`, `granted_at` rows.
- `session`: `session_id`, `harness`, `repo_key`, `paused`.
- `worker --once`: `acquired`, per-job `processed` results, and `embedded`
  (records backfilled with embeddings when a provider is configured).
- `doctor`: DB integrity/version/WAL, retrieval backends, provider, queue,
  memory states, trust, integrations, conflicts, and v1 artifact detection.
- `export`: `agent-memory.export.v2`; raw event payloads are excluded.
