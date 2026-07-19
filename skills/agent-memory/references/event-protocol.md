# Event and adapter protocol

All harness input is normalized to `agent-memory.event.v2` with one of five
kinds: `session_start`, `user_prompt`, `tool_completed`, `assistant_stop`, or
`session_end`.

Common envelope fields are id, session id, harness, repo key, created/expiry
timestamps, compressed payload, payload digest, and redaction findings.

## Harness mapping

| Meaning | Claude | Codex | OpenCode |
|---|---|---|---|
| user prompt + recall | `UserPromptSubmit` | `UserPromptSubmit` | `chat.message` |
| completed tool | `PostToolUse` | `PostToolUse` | `tool.execute.after` |
| assistant final | `Stop` | `Stop` | `message.updated` |
| session end | `SessionEnd` | stop is terminal signal | `session.idle` |

Adapters pass the native JSON object to:

```bash
agent-memory hook --harness <harness> --event <normalized-kind>
```

The hook tolerates unknown native fields. Event ids are derived from native
event/tool/message ids plus session and kind; duplicate deliveries use
`INSERT OR IGNORE`.

## Stored payloads

- `user_prompt`: redacted prompt, at most 32 KiB.
- `assistant_stop`: redacted final response, at most 32 KiB.
- `tool_completed`: tool name, redacted command, numeric exit status, and a
  redacted 8 KiB head/tail of output for local evidence only.
- `session_end`: redacted final/handoff summary, at most 32 KiB.

Prompts, assistant finals, and tool events expire after seven days. Session-end
events expire after fourteen days.

## Hook output

Prompt hooks emit `{}` when no material memory exists. Otherwise they emit
`hookSpecificOutput.additionalContext`, plus the same `context`, `query_id`,
and visibility fields for OpenCode and diagnostics.

Other hooks emit `{}`. Stop/session-end hooks enqueue work and launch a detached
`worker --once`; the host does not wait for model consolidation. Set
`AGENT_MEMORY_SYNC_WORKER=1` only in deterministic tests.

All exceptions at this boundary are swallowed after emitting `{}`. The host
prompt, tool, or stop sequence must continue.
