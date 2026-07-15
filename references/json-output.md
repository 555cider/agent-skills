# JSON Output

`recall`, `index`, `migrate`, `import-existing`, `import-native`, `integrate`,
`doctor`, `find`, `list`, `stats`, `propose`, `review`, `session list`, and `session resume`
accept `--format json` for programmatic consumption:

```bash
python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --query "test" --format json
```

`find --format json` returns `results`, `truncated`, and a `total` count for
pagination, preserving the text-mode read surface while returning normalized
ranked result records:

- `kind`: `canonical`, `explicit`, `auto`, or `topic`
- `scope`: `global` or `project`
- `path`: source file path
- `text`: source text when the result comes from canonical memory or a topic
- `score`: deterministic relevance score for ordering
- `matched_fields`: fields that matched the query
- `snippet`: compact matched context when available

Inbox note results keep their note metadata (`summary`, `type`, `priority`,
`source`, `confidence`, `created_at`, `agent_id`, `repo_key`, `tags`,
`evidence`, and `body`). Canonical `MEMORY.md` bullet entries also expose parsed
metadata when available, including `id`, `type`, `summary`, `confidence`,
`source_note`, `last_verified`, and `tags`. Topic results expose OKF-compatible
frontmatter when present, including `type`, `title`, `description`, `resource`,
`tags`, `timestamp`, and any extra scalar or simple-list fields under
`metadata`.

## Recall

`recall --format json` returns:

- `results`: ranked active records. Each includes `kind`, `scope`, `repo_key`,
  `memory_type`, `status`, provenance fields, `summary`, `aliases`, `tags`,
  `body`, `evidence`, `path`, `id`, and backend score.
- `context`: the bounded text injected into an agent prompt; empty when nothing
  matches.
- `truncated`, `total`, and `elapsed_ms`.
- `trusted` and `global_included`, making the global-memory boundary explicit.
- `index_status`: selected backend plus `path`, `exists`, `dirty`, and FTS5
  availability.

## Maintenance and Integration

- `index status` reports `backend`, `path`, `exists`, `dirty`, and `fts5`;
  `index rebuild` reports `backend`, `records`, and `rebuilt`.
- `migrate` reports `actions`, `total`, `applied`, and `backup`.
- `import-existing` reports per-harness `imports`, their combined `total`, and
  `applied`.
- `import-native` reports `harness`, `source_dir`, `scope`, `include_history`,
  `only_type`, `match`, staged `actions`, `skipped` entries with reasons,
  `total`, and `applied`.
- `integrate` reports `mode`, `harnesses`, planned/applied `changes`, detected
  `conflicts`, `blocked`, `applied`, and `backup`.
- `doctor` reports the store path, index status, trusted repo keys, per-harness
  adapter status, and known conflicts.
