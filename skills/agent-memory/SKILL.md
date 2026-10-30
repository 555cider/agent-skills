---
name: agent-memory
description: Use when work may depend on durable context from past sessions or other agents (preferences, repo rules, decisions, procedures, handoffs), or the user asks to remember, forget, review, import, or manage memory. Not for self-contained requests, secrets, or facts derivable from code, git, or tool output.
license: MIT
compatibility: Requires Python 3.11+, SQLite FTS5, and local filesystem access. sqlite-vec and model providers are optional.
---

# Agent Memory

Use Agent Memory as evidence-aware durable work memory, not as project search or
a transcript archive. SQLite at `~/.agents/memory/agent-memory.sqlite3` is the
only source of truth; Claude, Codex, and OpenCode hooks share it. Run the
installed `agent-memory` launcher (`agent-memory <command> --help` for flags);
inside a plugin install it is `bin/agent-memory` beside this file.
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
same prompt. Otherwise use the exact current request as the prompt:

```bash
agent-memory recall --cwd "$PWD" --prompt "<current request>" --format json
```

The packet (`agent-memory.packet.v2`):

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

Global memory reaches a repo only for kinds the user granted there
(`agent-memory policy trust grant --cwd "$PWD" --kind preference`); grant only
when cross-project recall for that repo and kind was authorized.

## Remember explicit requests immediately

For an unambiguous, durable, non-sensitive request:

```bash
agent-memory remember --cwd "$PWD" --scope project --kind preference \
  --statement "Prefer targeted verification for small changes" --format json
```

Kinds are `preference`, `constraint`, `decision`, `procedure`, `caveat`, and
`handoff`. Use `global` only when the user clearly intends cross-project reuse.
Add `--condition harness=codex` or `--path-glob 'frontend/**'` when applicability
is conditional. Use `--replaces <id>` for an explicit correction.

Keep each statement one focused fact, well under ~500 tokens; recall injects at
most ~1,200 tokens. Split a playbook into separate records, and keep long
documents in the repository with a pointer in memory.

Explicit requests become active. Inferred preferences and assistant-only claims
stay provisional; a procedure or caveat activates automatically only when local
command evidence proves it.

## Forget means hard delete

Honor a targeted forget request immediately, never with a note saying to forget:

```bash
agent-memory forget --cwd "$PWD" --id <memory-id> --format json
agent-memory forget --cwd "$PWD" "distinctive remembered statement" --format json
```

A query matching more than five records fails until `--all-matches`; confirm
with the user before any bulk deletion. Report the CLI's `deletion_scope`: it
deletes structured memory and blocks rehydration for seven days, but source
events stay until their TTL and backups or exports are not modified.

## Review and adopt

```bash
agent-memory review list --cwd "$PWD" --format json   # uncertain records
agent-memory review approve|reject <id> --format json
```

Rejection hard-deletes like forget. To bring in memory Claude Code, Codex, or a
`.remember` directory already hold, follow references/adopt.md: preview, show
the grouped table, and resolve accepted groups by `--batch`, never one by one.

To stop automatic observation without deleting memory, use
`agent-memory session pause --cwd "$PWD" --harness <harness>`.

## Record actual use

When a recalled item materially affected the work, record it against the
packet's `query-id`:

```bash
agent-memory feedback <query-id> <memory-id> --used --outcome helpful
```

Use `--unused` when an exposed record was irrelevant: a record marked unused in
most of its votes must match twice as strongly to be shown again. Never
fabricate feedback for a record that was not in that query packet.

## References

Read only the one you need:

- references/cli.md — every command, flag, and exit contract
- references/adopt.md — adopting Claude/Codex/.remember memory in reviewed batches
- references/lifecycle-policy.md — activation, forget, TTL, trust, import, worktrees and `rekey`
- references/json-output.md — record, packet, and command output schemas
- references/event-protocol.md — hook events and harness adapters
- references/providers.md — optional OpenAI/command provider and its payload boundary
- references/architecture.md — DB, worker, retrieval, failure model
