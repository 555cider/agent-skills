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

## Import

An export file is data from somewhere else, so `import` is a trust boundary,
not a restore. By default every record enters as `inferred`, which activation
can only ever turn into `provisional`: a file from another person cannot mint
an actionable memory, only fill the review queue. `--trust` is the explicit
statement "this came from me" and replays the exported authority, confidence,
and state.

Either way import only adds and merges. It never deletes, never overwrites,
and never lowers the state of a memory already stored, so the worst outcome of
a wrong file is a review queue to reject. A live tombstone still blocks
rehydration, so importing a backup does not resurrect what was forgotten, and
records the source had already retracted or expired are not carried over.

Identity is content, not id: kind, scope, repo key, normalized statement,
conditions, and path globs. Ids are reissued on the way in. Project records
keep their original repo key, which is derived from the git origin and is
therefore the same key the repository will compute once it is cloned on the new
machine; `--cwd` overrides it to adopt someone else's project memory into a
local checkout.

## Adoption

`adopt` reads memory another agent already holds — CLAUDE.md, AGENTS.md,
`~/.codex/memories`, `.remember/core-memories.md` — and hands it to `import`
without `--trust`. It has no separate policy: adopted records enter `inferred`,
activation caps them at `provisional`, tombstones still block them, and identity
is still content. A file the user wrote themselves is treated exactly like a
stranger's, because the parser that split it into statements can be wrong even
when the file is not.

Two decisions are made before the write path sees a record.

**Scope is per record.** A home file is global. A repository file is keyed to
that repository. A Codex `Task Group` follows its `applies_to: cwd=` line to the
repository it names, taking the first path that is a git repository on this
machine when the line names more than one. A line naming no local repository is
skipped as `unknown-project`; it is never widened to global, because a rule that
was true of one checkout injected into every repository is worse than a rule
that arrives nowhere.

**The durability line.** Memory is read into a bounded recall budget, so a
statement about how work should be done is adopted and a record of what was done
once is not. Session transcripts, `rollout_summaries/`, `raw_memories.md`, the
`.remember` daily and weekly narrative, and the `Task Group`/`Task N`/`keywords`
scaffolding inside `MEMORY.md` stay out unless `--include-episodic` asks for
them. `MEMORY.md`'s scaffolding is still read — it is where scope comes from —
but it never becomes a statement.

Home directories are rewritten to `~` before the record is built. `create_memory`
refuses a statement containing one outright, and Codex writes absolute rollout
paths into its reusable-knowledge entries, so without the rewrite the most useful
records would be the ones that silently failed.

## Resolving a review queue in bulk

Every import stamps a `batch` token onto each record it writes, as an
`import.batch` evidence row beside an `import.<source>` row. `review` matches on
those, so one adoption can be approved or rejected as one decision instead of
one keystroke per record — a queue nobody can empty is a queue that gets
approved unread.

Bulk resolution requires `--batch`. There is deliberately no bare `--all`:
rejection is a hard delete, and the queue is the only thing between an external
file and the store. `--source`, `--scope` and `--kind` narrow within a batch.
Only `provisional` and `disputed` records are touched, so a batch that merged
onto memory already active can neither re-approve nor delete it.

Rejecting tombstones the statement like any other forget. That is the intended
asymmetry: a rule turned down stays out of the next adoption instead of
rebuilding the queue the reviewer just emptied.
