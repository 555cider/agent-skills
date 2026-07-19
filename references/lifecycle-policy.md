# Lifecycle and policy

## Activation matrix

| Signal | Initial state | Authority |
|---|---|---|
| explicit user remember/correction | active | explicit |
| user approves review candidate | active | approved |
| repeated successful test/check command | active | verified |
| repeated failed command caveat | active | verified |
| inferred user preference | provisional | inferred |
| assistant-only claim | provisional | assistant |
| incompatible non-explicit claims | disputed | original authority |

Provider labels are never proof. `explicit` must point to a local user event
that contains an explicit remember request. `verified` procedure/caveat evidence
must match a local tool event's command and exit status. Unproven labels are
demoted before writing.

## Revisions and conflicts

`memories` contains current state. Every create or state transition writes a
complete immutable `memory_revisions` snapshot. An explicit correction retracts
the old record and adds a `supersedes` edge. Ambiguous inferred conflicts make
both sides disputed. Neither retracted nor disputed state is actionable.

Current prompts always outrank stored memory. Negation, replacement, and forget
language forces maintenance mode before ranking; all matching old records are
non-actionable.

## Forget

Hard forget deletes the current record, all revisions, evidence, relations,
vector mapping, and index entries in one transaction. It writes only an HMAC of
normalized content, scope, and repo key. The HMAC expires after seven days and
prevents background workers from recreating the memory. An explicit user
remember deletes the matching tombstone and creates a new record.

## Retention

- prompt/final/tool events: 7 days;
- session-end/handoff events: 14 days;
- forget tombstones: 7 days;
- completed job metadata: 30 days;
- procedure/caveat verification horizon: 90 days.

Structured memory has no arbitrary TTL unless `valid_until` is set. `gc` marks
past-valid records expired and deletes elapsed short-term data.

## Trust

Project memory is isolated by a stable repo key derived from normalized git
origin, falling back to a hash of the git root/cwd. Global memory is denied by
default. `trust_grants` records explicit repo+kind grants.

A repo `.agent-memory.json` is an additional ceiling:

```json
{"global_memory": {"allow": ["preference"], "deny": ["handoff"]}}
```

It can intersect or remove user grants. It cannot add one. A malformed policy
fails closed for global memory.
