# Plan Graph — Command Output Contract

The script writes machine-readable lines that callers (the plan-graph skill, or
any other agent chaining on it) can parse. Streams are split deliberately:
state-change records go to stdout, problems go to stderr.

## Text mode

stdout:

```
CHANGE=<verb> <node_id> [reason]   # one line per --fix mutation
OK plan graph                       # success sentinel (exit 0)
```

`<verb>` ∈ `{mark, clear, dedup, remove, add-frontmatter, sync-frontmatter}`:
- `mark <id> missing` — active plan file is gone; node marked `x: missing`
- `clear <id> missing` — previously-missing file is back; `x` cleared
- `dedup <id>` — duplicate base IDs removed from the dep list
- `remove <id> empty-deps` — dep entry became empty after dedup and was removed
- `add-frontmatter <id> <path>` — added missing YAML frontmatter to plan file
- `sync-frontmatter <id> <path> <fields>` — synchronized mismatched frontmatter
  fields; `<fields>` is comma-separated with no spaces

stderr:

```
WARN=<message>                      # advisory (e.g. done w/o active dependent)
ERROR=<message>                     # validation error
ERROR=parse: <exception>            # graph file failed to parse (exit 2)
FAIL plan graph                     # failure sentinel (exit 1)
```

Exit codes: `0` = valid (with or without changes); `1` = validation errors (or a
lock/missing-graph failure); `2` = graph file unparseable.

## JSON mode (`--json`)

Add `--json` (works with check, `--fix`, `--show`, and `--suggest-deps`) when
another agent or script will consume the result; for your own report use text
mode. In JSON mode the `CHANGE=`/`WARN=`/`ERROR=`/`OK`/`FAIL` line contracts are
suppressed and everything goes to stdout as one object (exit codes are
unchanged).

Check / `--fix`:

```json
{"status": "OK|FAIL|ERROR", "changes": [{"verb": "...", "id": 1, "path": "...", "extra": "..."}], "errors": [], "warnings": []}
```

`status` is `OK` (exit 0), `FAIL` (exit 1, validation errors), or `ERROR`
(exit 1 for a lock/missing-graph failure, or exit 2 for a parse failure). Each
`changes[]` object carries the same verb/id as a `CHANGE=` line (`path`/`extra`
hold the trailing fields).

`--show --json` returns
`{status, tree: [...lines], roadmap: [{id, summary}], excluded: [{id, summary}], critical_path: [ids], changes: [], errors: [], warnings: []}`.

`--suggest-deps --json` returns
`{status, suggestions: [{dependent, base, confidence, reason}], changes: [], errors: [], warnings: []}`.

## Write-ordering hazard (`--fix`)

Drift repairs (`CHANGE=` lines) are persisted **before** validation runs, so a
`--fix` invocation that exits `1` may already have mutated the graph file. Use
`--fix` only when you intend to accept the drift repairs; run without `--fix`
first if you want a pure read-only check. Parse failure (exit `2`) is the one
case where the graph is guaranteed untouched.

Maintainers: `tests/run.sh` is the CLI regression suite (exit 0 = all pass);
`tests/README.md` catalogues the fixtures and the contract each guards.
