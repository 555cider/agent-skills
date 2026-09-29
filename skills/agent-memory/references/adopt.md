# Adopting memory another agent already has

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
trust for the kind. Apply `policy trust grant` only when cross-project recall for
that repo/kind was authorized; adoption alone does not grant that trust. Otherwise
report the rules as imported but not eligible for recall in that repository.
