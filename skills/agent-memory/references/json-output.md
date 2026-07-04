# JSON Output

`find`, `list`, `stats`, `propose`, `review`, `session list`, and
`session resume` accept `--format json` for programmatic consumption:

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
