# Agent Memory v2

Agent Memory is a local, evidence-aware memory layer shared by Codex, Claude,
OpenCode, and other coding agents. It remembers durable preferences,
constraints, decisions, verified procedures, caveats, and handoffs. It is not a
project RAG index and does not archive full transcripts.

SQLite is authoritative. FTS5 and trigram search always work locally;
sqlite-vec and a model provider are optional enhancements. Harness hooks fail
open, so memory cannot block a prompt or tool run.

## Breaking install

v2 has no v1 migration or compatibility layer. If the installer finds the v1
Markdown/index layout, it stops before changing anything:

```bash
./install.sh --local agent-memory --shadow --discard-v1
```

`--discard-v1` explicitly deletes the recognized v1 store without a backup. It
refuses to run when a v2 DB already exists or the resolved target is unsafe.

For a new installation, start in shadow mode:

```bash
./install.sh --local agent-memory --shadow
agent-memory doctor --format json
```

Shadow mode installs semantic hooks while leaving native memory enabled. After
validation, make v2 primary:

```bash
./install.sh --local agent-memory --primary
```

Primary mode disables recognized Claude/Codex native memory and known competing
Codex memory plugins while preserving unrelated config. Every changed config
is backed up. OpenCode loads its global plugin after restart.

The installer creates a private Python 3.11+ venv in the installed skill and
pins `openai` and `sqlite-vec`. If optional dependency installation fails, the
deterministic SQLite/FTS core remains available.

## Storage

```text
~/.agents/memory/
  agent-memory.sqlite3        # authoritative DB, WAL enabled
  .worker.lock                # one-shot worker process lock
  backups/integrations/...    # changed harness config only
```

The DB separates:

- redacted, compressed event journal entries;
- current memory records and immutable revisions;
- evidence and relation graph edges;
- leased/retryable jobs and dead letters;
- retrieval exposure/use feedback;
- per-repo, per-kind global trust grants;
- contentless seven-day forget tombstones;
- FTS5, trigram, and optional sqlite-vec indexes.

Raw prompt/final events expire after seven days; session-end handoff events
expire after fourteen. Procedures and caveats become stale after ninety days
without verification and are downranked, not deleted.

## Everyday commands

```bash
agent-memory recall --cwd "$PWD" --prompt "current request" --format json

agent-memory remember --cwd "$PWD" --kind preference \
  --statement "Prefer targeted verification for small changes"

agent-memory forget --cwd "$PWD" --id mem_...

agent-memory review list --cwd "$PWD" --format json
agent-memory review approve mem_...

agent-memory policy trust grant --cwd "$PWD" --kind preference
agent-memory session pause --cwd "$PWD" --harness codex
agent-memory session resume --cwd "$PWD" --harness codex

agent-memory doctor --format json
agent-memory gc --format json
```

Normal recall injects only active, in-scope, trusted, condition-matching
records. Negation/change/forget prompts switch to maintenance mode: old matches
are explicitly non-actionable and the current prompt wins. Provisional,
disputed, retracted, and expired records are never actionable.

## Optional provider

The deterministic core is the default:

```bash
unset AGENT_MEMORY_PROVIDER
```

Enable the built-in OpenAI provider explicitly:

```bash
export AGENT_MEMORY_PROVIDER=openai
export OPENAI_API_KEY='...'
# Optional overrides:
export AGENT_MEMORY_OPENAI_MODEL=gpt-5.6-luna
export AGENT_MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

API keys are read only from the environment. Requests use `store=false` and
send only redacted user prompts, final assistant responses, plus tool
name/command/exit status. Raw tool output and file contents never cross the
provider boundary.

To use a local or custom model executable:

```bash
export AGENT_MEMORY_PROVIDER=command
export AGENT_MEMORY_PROVIDER_COMMAND='/absolute/path/to/provider'
```

The JSON stdin/stdout protocol is documented in
[references/providers.md](references/providers.md). Set
`AGENT_MEMORY_SEMANTIC_RECALL=1` only when online/query-time embeddings are an
acceptable latency and privacy tradeoff. Without it, stored embeddings are kept
but unused and recall stays fully local. When a provider is configured, the
background worker embeds new and historical active records — explicit
remembers included. After changing `AGENT_MEMORY_EMBEDDING_MODEL`, run
`agent-memory reindex` to rebuild the vector index.

## Repository policy

Global memory is denied until the user grants individual kinds. A repository
may only tighten those grants with `.agent-memory.json`:

```json
{
  "global_memory": {
    "allow": ["preference", "constraint"],
    "deny": ["handoff"]
  }
}
```

Setting `"global_memory": false` blocks all global recall for that repo. This
file cannot create or widen user trust.

## Uninstall or disable

Remove adapters while retaining the DB:

```bash
agent-memory integrate --mode off --harness all --apply
```

`uninstall.sh agent-memory` removes the managed launcher and skill links. It
does not delete `~/.agents/memory/agent-memory.sqlite3`.

## Verification

```bash
bash skills/agent-memory/tests/run.sh
python3 skills/agent-memory/tests/benchmark.py
```

The suite covers lifecycle, hard forget, redaction, trust, hook parity,
provider failure, bilingual/paraphrase retrieval, and adapter safety. The full
benchmark gates 50,000-record recall at 100 ms p95 and prompt-hook latency at
150 ms p95.
