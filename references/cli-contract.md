# Plan Graph v2 CLI contract

Invoke the entry point as:

```bash
python3 <skill-dir>/scripts/plan-graph.py <command> [options]
```

Every command accepts `--root <dir>` and `--json` after the command name.
Without `--root`, the CLI uses `git rev-parse --show-toplevel`.

## Read commands

| Command | Purpose |
|---|---|
| `context [--plan ID] [--path PATH] [--query TEXT] [--worktree]` | Select context and produce a decision pack. No selectors means current Git changes. Explicit selectors include Git changes only with `--worktree`. |
| `status` | List ready, waiting, retained-done plans and the longest active chain. |
| `doctor` | Return all format, graph, safety, nested-store, legacy-store, and pruning diagnostics. |

Read commands refuse structurally invalid stores except `doctor`, which reports
all diagnostics in one pass.

## Mutation commands

| Command | Behavior |
|---|---|
| `create ID --title TITLE [--scope GLOB] [--tag TAG] [--require ID]` | Create strict metadata plus the six-section template. Repeat list options as needed. |
| `update ID` | Preserve the body while updating metadata or title. |
| `rename OLD NEW [--title TITLE]` | Rename the file and update every current `requires` reference. Historical `replaces` strings stay unchanged. |
| `replace OLD NEW --title TITLE ...` | Refuse active dependents, create a fresh plan with `replaces: [OLD]`, delete OLD, and prune orphaned done plans. Metadata and requirements are not inherited. |
| `reopen ID` | Change a retained done plan back to active. |
| `close ID` | Mark done and prune the newly closed tree. |
| `drop ID` | Refuse active dependents, delete the target, and prune orphaned done plans. |
| `gc` | Delete all done plans outside active prerequisite closures. |

`create`, `rename`, and `replace` reject reused IDs, including IDs found in Git
history. All mutation commands support `--dry-run`; dry-run performs validation
and returns the exact change list without creating the store, lock, or files.

`update` accepts repeatable pairs:

```text
--add-require / --remove-require
--add-replace / --remove-replace
--add-scope   / --remove-scope
--add-tag     / --remove-tag
--title
```

## Output

Default output is compact text for direct agent or human reading. `--json`
emits exactly one object on stdout:

```json
{
  "ok": true,
  "command": "context",
  "root": "/repo",
  "data": {},
  "diagnostics": [],
  "changes": []
}
```

These six top-level keys are stable across commands.

- A diagnostic has `severity`, `code`, and `message`, plus optional `plan` and
  `path`.
- A change has `action` and the affected `plan`, or `from`/`to` for identity
  changes.
- `context.data` contains `selectors`, `selected`, `required`, `affected`,
  `read_order`, `decision_pack`, and fallback `candidates`.
- `status.data` contains `ready`, `waiting`, `retained_done`, and
  `critical_path`.

Exit codes are `0` for success, `1` for validation/conflict/I/O failure, and
`2` for CLI usage errors. JSON domain errors still emit the one result object.

## Write safety

Mutations take a repository-local exclusive lock, reload the store to detect
concurrent edits, validate the full proposed graph, and use same-directory
atomic replacements. A failed multi-file operation restores every touched
file from its captured bytes. Plan files, `.agents`, and `.agents/plans` may not
be symlinks, and no write may resolve outside the repository store.
