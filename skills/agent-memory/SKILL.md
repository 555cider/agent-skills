---
name: agent-memory
description: Use when work may depend on prior user preferences, repo-specific constraints, earlier decisions, verified procedures, recurring caveats, or handoff context; when the user asks to remember, forget, correct, review, or update memory (기억해줘, 잊어버려, 메모리 업데이트); when durable context must transfer across Codex, Claude, OpenCode, or another coding agent; or when existing memory should be brought in from CLAUDE.md, AGENTS.md, ~/.codex/memories, or a .remember directory (메모리 가져오기, import, adopt). Do not use for self-contained requests, ordinary progress, secrets or personal data, or facts cheaply derivable from code, docs, git, or current tool output.
license: MIT
compatibility: Requires Python 3.11+, SQLite FTS5, and local filesystem access. sqlite-vec and model providers are optional.
---

# Agent Memory

Use Agent Memory as evidence-aware durable work memory, not as project search or
a transcript archive. SQLite at `~/.agents/memory/agent-memory.sqlite3` is the
only source of truth. Harness adapters observe redacted semantic events and
share the same store.

Run the installed launcher:

```bash
agent-memory --help
```

Set `AGENT_MEMORY_HOME` only when an isolated store is required.

## Decide whether memory matters

Recall when prior context could change an action or decision:

- user preferences or durable constraints;
- accepted design decisions and their conditions;
- verified commands, procedures, or recurring caveats;
- a long-running handoff;
- an explicit remember, correction, forget, or review request.

Skip memory for translation, formatting, one-line answers, current file facts,
ordinary progress, and anything readily available from the repo or git.

Never store secrets, credentials, private keys, personal data, raw file
contents, or raw tool output. Do not convert a repository into memory records.

## Recall before acting

When the harness hook already injected an `<agent-memory …>` packet for the
current prompt, use that packet directly — do not run `recall` again for the
same prompt. Its `query-id` attribute is the feedback key. Otherwise use the
exact current request as the prompt:

```bash
agent-memory recall --cwd "$PWD" --prompt "<current request>" --format json
```

The result is `agent-memory.packet.v2`:

- `items` contains bounded active records that may be acted on.
- `conflicts` is non-actionable. Never follow a disputed, retracted, expired,
  or maintenance match.
- `mode=maintenance` means the current prompt negates, changes, or forgets old
  memory. The current prompt wins; matched old records are context only.
- `stale=true` on a procedure or caveat means verify it locally before use.
- `visibility.material=false` means say nothing about memory.

Treat memory as a lead, not proof. Verify drift-prone commands and facts when
verification is cheap. Mention memory only when it materially changes the
action, decision, or warning given to the user.

Global memory is blocked by default. It is eligible only when the current repo
has a user grant for that memory kind. A repo `.agent-memory.json` may tighten,
never widen, those grants.

## Apply explicit memory requests immediately

For an unambiguous, durable, non-sensitive request:

```bash
agent-memory remember \
  --cwd "$PWD" \
  --scope project \
  --kind preference \
  --statement "Prefer targeted verification for small changes" \
  --format json
```

Kinds are `preference`, `constraint`, `decision`, `procedure`, `caveat`, and
`handoff`. Use `global` only when the user clearly intends cross-project reuse.
Add `--condition harness=codex` or `--path-glob 'frontend/**'` when applicability
is conditional. Use `--replaces <id>` for an explicit correction with known
lineage.

Keep each statement one focused fact, well under ~500 tokens. Split a playbook
into separate targeted records: recall injects at most ~1,200 tokens, and an
oversized record only ever appears truncated with a `review show` pointer.
Long documents belong in the repository; remember a pointer to them instead.

Explicit remember requests become active. Inferred preferences and
assistant-only claims remain provisional. A procedure or caveat becomes active
automatically only when local command/test evidence proves it. Conflicting
inferences become disputed and are never injected.

## Forget means hard delete

Honor a targeted forget request immediately:

```bash
agent-memory forget --cwd "$PWD" --id <memory-id> --format json
# or, when the id is unknown:
agent-memory forget --cwd "$PWD" "distinctive remembered statement" --format json
```

Forget deletes the current record, immutable revisions, evidence, relations,
and embedding. A contentless HMAC tombstone blocks automatic rehydration for
seven days. A later explicit `remember` overrides the tombstone. Never replace a
forget request with a note saying to forget.

Query matching is precision-first (raw statement tokens, no concept aliases).
A query matching more than five records fails until rerun with `--all-matches`;
confirm with the user before bulk deletion. A forget phrase observed in a
prompt hook is honored only when at most two records match — broader matches
surface as non-actionable maintenance context for a targeted forget by id.

## Review uncertain memory

```bash
agent-memory review list --cwd "$PWD" --format json
agent-memory review show <id> --format json
agent-memory review approve <id> --format json
agent-memory review reject <id> --format json
```

Approval creates a new immutable revision and activates the record. Rejection
uses the same hard-delete and tombstone semantics as forget.

Filter a long queue with `--state`, `--scope`, `--kind`, `--source`, `--repo-key`,
`--batch`, and `--all-projects`. An import spanning several repositories is invisible from
inside any one of them without `--all-projects`.

## Adopt memory another agent already has

`adopt` reads the memory files Claude Code and Codex keep as plain markdown and
puts them through the same trust boundary as `import`: everything arrives
`inferred`/`provisional` for review, tombstones still block rehydration, and
replaying an adoption merges instead of duplicating.

```bash
agent-memory adopt list --cwd "$PWD" --format json          # what this machine has
agent-memory adopt --cwd "$PWD" --dry-run --format json     # what would be adopted
agent-memory adopt --cwd "$PWD" --format json               # adopt into the queue
```

Sources are `claude-md` (`~/.claude/CLAUDE.md`, `<repo>/CLAUDE.md`,
`<repo>/CLAUDE.local.md`), `codex-agents` (`AGENTS.md`), `codex-memory`
(`~/.codex/memories/MEMORY.md`, `memory_summary.md`), and `remember`
(`.remember/core-memories.md`). Pass `--source` to narrow, `--scan <repo>` to
read another checkout's project files, and `--llm` to let the configured
provider classify and restate what the parser delimited.

**Scope is decided per record, never in bulk.** Home files are global; repo
files are keyed to that repository; a Codex `Task Group` is routed by its
`applies_to: cwd=` line to the repository it names. A `cwd` that is not a git
repository on this machine is skipped as `unknown-project` — it is never widened
to global. Do not pass `--cwd` expecting it to re-home someone else's records;
it selects which repository's own files are read.

**The durability line.** Memory is a rule store read into a ~1,200-token recall
budget, so `adopt` carries statements about how work should be done and leaves
records of what was done once. Session transcripts, `rollout_summaries/`,
`raw_memories.md`, `.remember/now.md`/`today-*.md`/`recent.md`/`archive.md`, and
the `Task Group`/`Task N`/`keywords` scaffolding inside `MEMORY.md` are all
excluded; `--include-episodic` opens the narrative files when the user asks.

**Review the whole adoption as one decision.** The report carries a `batch`
token and a `groups` table counting records by source, scope, repository, and
kind. Render that table, ask the user once which groups to accept, then resolve
each accepted group with a single command:

```bash
agent-memory review approve --batch <token> --scope global --format json
agent-memory review approve --batch <token> --repo-key <key> --format json
agent-memory review reject  --batch <token> --scope project --format json
```

Never walk an adopted queue one `Enter` at a time. Bulk resolution requires
`--batch`; there is no bare `--all`. Rejection tombstones the statement, so a
rule turned down here stays out of the next adoption — say so before rejecting.

Adopted global rules stay invisible to a repository until that repository grants
trust for the kind, so finish with `policy trust grant` (below) or the adoption
will look like it did nothing.

## Trust and observation controls

Grant global recall narrowly by repo and kind:

```bash
agent-memory policy trust grant --cwd "$PWD" --kind preference
agent-memory policy trust list --cwd "$PWD" --format json
agent-memory policy trust revoke --cwd "$PWD" --kind preference
```

Pause automatic observation without deleting memory:

```bash
agent-memory session pause --cwd "$PWD" --harness codex
agent-memory session resume --cwd "$PWD" --harness codex
agent-memory session status --cwd "$PWD" --harness codex --format json
```

Prompt, tool, stop, and session hooks capture events automatically. Do not dump
transcripts into `remember`. Stop hooks enqueue a leased one-shot worker;
provider or vector failures must fail open and leave local lexical recall usable.

## Record actual use

Exposure is not assumed to be useful. When a recalled item materially affected
the work, record it:

```bash
agent-memory feedback <query-id> <memory-id> --used --outcome helpful
```

The query id is the `query-id` attribute of the injected `<agent-memory …>`
packet (also `query_id` in JSON output). Use `--unused` when the exposed record
was irrelevant. Never fabricate feedback for a record that was not in that
query packet.

## Operations

```bash
agent-memory doctor --format json
agent-memory gc --format json
agent-memory export --scope global --format json > global-memory.json
agent-memory import global-memory.json --dry-run --format json
agent-memory adopt --cwd "$PWD" --dry-run --format json
agent-memory integrate --mode off --harness all --apply
```

`export` excludes raw events; `--scope global|project|all` picks what to carry,
and without it the original `--cwd`/`--include-global` contract still holds.
`import` replays an export into this store, adding and merging only — records
land in the review queue unless `--trust` says the file is your own backup.
`adopt` does the same for another agent's markdown memory and never trusts.
Both report a `batch` token that resolves their queue in one decision.
`gc` enforces TTLs. `integrate off` removes only
managed adapters and keeps the v2 DB. Configure optional providers only through
environment variables; API keys never belong in memory or config files.

For complete contracts, read only the reference needed:

- [references/cli.md](references/cli.md) — command and exit contract
- [references/event-protocol.md](references/event-protocol.md) — normalized events and adapters
- [references/lifecycle-policy.md](references/lifecycle-policy.md) — activation, revisions, TTL, trust
- [references/providers.md](references/providers.md) — OpenAI and command provider boundary
- [references/json-output.md](references/json-output.md) — v2 record and packet schemas
- [references/architecture.md](references/architecture.md) — DB, worker, retrieval, failure model

Verify the implementation with:

```bash
bash skills/agent-memory/tests/run.sh
python3 skills/agent-memory/tests/benchmark.py
```
