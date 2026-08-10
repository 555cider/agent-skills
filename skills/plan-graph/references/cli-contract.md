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
| `status` | List ready, waiting, retained-done plans, `requires` edges, and the longest active chain. |
| `why ID` | Aggregate every signal about one plan: readiness, blockers, dependents, staleness, overlaps, lineage, prunability, unfilled sections. |
| `doctor [--stale-after N] [--structural-only]` | Return all format, graph, safety, nested-store, legacy-store, and pruning diagnostics plus advisory warnings. `--stale-after` sets the stale commit threshold (default 5); `--structural-only` skips git/filesystem-backed advisory checks. |

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
| `close ID [--force]` | Mark done and prune the newly closed tree. Refuses (`unverified_completion`) while Outcome, Decisions, or Completion is still `TBD`; `--force` overrides with a `forced_close` warning. Reports `unblocked` dependents and `retained`. |
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
  `overlapping`, `read_order`, `decision_pack`, fallback `candidates`, and
  `near_misses` (query-only sub-threshold matches, at most three). Pack items
  carry a `staleness` object and, when `replaces` is non-empty, `lineage`.
  Overlapping items omit section excerpts.
- `status.data` contains `ready`, `waiting`, `retained_done`, `critical_path`,
  and `edges` (`{"from", "to", "kind": "requires"}`).
- `why.data` contains `plan`, `readiness`, `blockers`, `dependents`
  (`active`/`done`), `staleness`, `overlaps`, `lineage`, `prunable`, and
  `unfilled_sections`.
- `close.data` adds `unblocked` (dependents whose readiness flipped
  waiting→ready) and `retained` (target kept for active dependents).
- A `staleness` object is `{"state": "fresh"|"aging"|"stale"|"unknown",
  "commits_since_plan_update", "dirty_scope_paths", "anchor"}`.

Additions to `data` keys are backward compatible; the six top-level envelope
keys and the exit codes are stable.

### Advisory diagnostic codes

| Code | Severity | Meaning |
|---|---|---|
| `stale_plan` | warning | Scope changed in ≥ threshold commits since the plan file last changed. |
| `scope_overlap` | warning | Two unordered active plans currently match the same concrete files. |
| `possible_duplicate` | warning | Two active plans share a tag and files or near-identical titles. |
| `tbd_sections` | warning | Sections still hold the `TBD` template (on close, or on a done plan). |
| `unverified_completion` | error | `close` refused: Outcome, Decisions, or Completion is unfilled. |
| `forced_close` | warning | `close --force` proceeded past unfilled sections. |

Exit codes are `0` for success, `1` for validation/conflict/I/O failure, and
`2` for CLI usage errors. JSON domain errors still emit the one result object.
`--version` prints `plan-graph <version>` and exits without the envelope.

## Write safety

Mutations take a repository-local exclusive lock, reload the store to detect
concurrent edits, validate the full proposed graph, and use same-directory
atomic replacements. A failed multi-file operation restores every touched
file from its captured bytes. Plan files, `.agents`, and `.agents/plans` may not
be symlinks, and no write may resolve outside the repository store.
