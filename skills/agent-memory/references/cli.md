# CLI contract

Global option:

```text
--memory-home PATH   override AGENT_MEMORY_HOME / ~/.agents/memory
```

Place it before the command. Public terminal commands accept `--format text`
or `--format json`. Expected operational failures print one `ERROR=...` line to
stderr and exit 1; usage errors exit 2; interruption exits 130. Hooks always
exit 0 and emit valid JSON.

## Public commands

```text
remember [STATEMENT]
  --statement TEXT
  --cwd PATH
  --kind preference|constraint|decision|procedure|caveat|handoff
  --scope project|global
  --condition VALUE          repeatable
  --path-glob GLOB           repeatable
  --evidence JSON|kind:text  repeatable
  --replaces ID

forget [QUERY]
  --id ID
  --cwd PATH
  --all-projects
  --all-matches              confirm deleting >5 query matches

recall [PROMPT]
  --prompt TEXT
  --cwd PATH
  --harness claude|codex|opencode|generic
  --limit N                  default 8
  --token-budget N           default 1200
  --path PATH                repeatable condition context

review list [--state STATE] [--cwd PATH]
review show ID
review approve ID
review reject ID

policy trust grant --cwd PATH (--kind KIND ... | --all-kinds)
policy trust revoke --cwd PATH [--kind KIND ... | --all-kinds]
policy trust list [--cwd PATH] [--all-projects]

session pause|resume|status
  --cwd PATH
  --harness HARNESS
  --id SESSION_ID            optional exact session

feedback QUERY_ID MEMORY_ID (--used|--unused) [--outcome TEXT]
export [--cwd PATH] [--include-global] [--scope global|project|all]
import [FILE]
  --cwd PATH                 adopt project records into this repository
  --scope global|project|all default all
  --trust                    restore the exported state instead of queueing review
  --dry-run
gc
doctor
integrate --mode shadow|primary|off --harness all|claude|codex|opencode
  [--disable-known-conflicts] [--apply]
```

Statements/prompts may come from stdin when omitted. `forget --all-projects`
is intentionally explicit. Query-based forget matches raw statement tokens
only (no concept aliases) and exits 1 when more than five records match
unless `--all-matches` confirms the bulk deletion. `integrate` is dry-run
unless `--apply` is present.

`export` without `--scope` keeps its original contract: `--cwd` selects the
project and `--include-global` adds global memory. `--scope global` and
`--scope all` need no repository. `import` reads stdin when `FILE` is omitted;
it only adds and merges, never deletes, overwrites, or downgrades what is
already stored. Records arrive as `inferred` — visible to `review list`, never
actionable — unless `--trust` restores the exported authority and state.
Records are matched by content, not by id, so replaying an export into the
store it came from merges instead of duplicating. Its report counts
`imported`, `merged`, `remapped`, `review_queued`, and `skipped` with a reason
per record: `forgotten` (a live tombstone), `inactive` (retracted or expired at
the source), `unknown-project` (project-scoped with no repo key and no
`--cwd`), `unsafe` (redaction refused it), `malformed`.

## Internal commands

```text
hook --harness HARNESS --event EVENT [--input FILE]
worker --once [--max-jobs N]
repo-key --cwd PATH
reindex
```

Adapters own `hook`. Stop/session-end launches `worker --once`. `reindex`
reconstructs FTS/trigram from authoritative records and is used by the
installer/doctor flow.
