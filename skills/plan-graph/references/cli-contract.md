# Plan Graph v2 CLI contract

Invoke the entry point as:

```bash
<skill-dir>/bin/plan-graph <command> [options]
```

Every command accepts `--root <dir>` and `--json` after the command name.
Without `--root`, the CLI uses `git rev-parse --show-toplevel`.

## Read commands

| Command | Purpose |
|---|---|
| `context [--plan ID] [--path PATH] [--query TEXT] [--worktree] [--no-other-worktrees]` | Select context and produce a decision pack, plus the other worktrees touching the routed paths. No selectors means this worktree's changes: uncommitted, and committed since its base. Explicit selectors include those changes only with `--worktree`. `--no-other-worktrees` skips reading other worktrees; the default selection then holds only uncommitted paths. A relative `--path` is read from the working directory when that is inside the root, else from the root; a directory (existing, or written with a trailing `/`) selects every scope that reaches into it. |
| `overlap [--path PATH]` | Other worktrees of the repository that changed, or plan to change, the given paths (default: this worktree's changes since its base). Reads their ignored plan directories too. Never fails on another worktree's state. |
| `status` | List ready, waiting, retained-done plans, `requires` edges, and the longest active chain. |
| `why ID` | Aggregate every signal about one plan: readiness, blockers, dependents, staleness, overlaps, lineage, prunability, unfilled sections. |
| `doctor [--stale-after N] [--structural-only]` | Return all format, graph, safety, nested-store, legacy-store, and pruning diagnostics plus advisory warnings. `--stale-after` sets the stale commit threshold (default 5); `--structural-only` skips git/filesystem-backed advisory checks. |

Read commands refuse structurally invalid stores except `doctor`, which reports
all diagnostics in one pass, and `overlap`, which does not load this worktree's
store.

## Mutation commands

| Command | Behavior |
|---|---|
| `create ID --title TITLE [--scope GLOB] [--tag TAG] [--require ID]` | Create strict metadata plus the six-section template. Repeat list options as needed. |
| `update ID` | Preserve the body while updating metadata or title. |
| `rename OLD NEW [--title TITLE]` | Rename the file and update every current `requires` reference. Historical `replaces` strings stay unchanged. |
| `replace OLD NEW --title TITLE ...` | Refuse active dependents, create a fresh plan with `replaces: [OLD]`, delete OLD, and prune orphaned done plans. Metadata and requirements are not inherited. |
| `reopen ID` | Change a retained done plan back to active. |
| `close ID [--force]` | Normal close marks done and prunes; refuses (`unverified_completion`) while Outcome, Decisions, or Completion is `TBD`. `--force` abandons instead, refuses active dependents, and removes the plan without satisfying prerequisites. Reports `abandoned: true`, empty `unblocked`, and a `forced_close` warning for abandonment. |
| `drop ID` | Refuse active dependents, delete the target, and prune orphaned done plans. |
| `gc` | Delete all done plans outside active prerequisite closures. |

`create` writes to the first `git config plan-graph.dir`, else `.agents/plans`;
`rename` and `replace` keep the old plan's directory. The ID history check
covers every plan directory. Every mutation of an
existing plan refuses a loose plan (`loose_plan`).

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

Default output is compact text for direct agent or human reading. In `context`
text, a pack item whose staleness is `aging` or `stale` prints a `Staleness:`
line with the anchor to diff from, and a replacement prints one `Replaced:` line
per `replaces` entry with its recovery command. `--json` emits exactly one
object on stdout:

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
  carry a `staleness` object, `kind` (`graph` or `loose`), `status_line` for a
  loose plan, and, when `replaces` is non-empty, `lineage`. Overlapping items
  omit section excerpts. `other_worktrees` lists overlap entries as in
  `overlap.data.overlaps` for the routed paths; empty when there are none or
  they cannot be read.
- `overlap.data` contains `available` (false outside a git worktree), `here`
  (`path`, `branch`, `base`, `changed`), `selectors`, `overlaps`, `worktrees`,
  and `warnings`. An overlap entry is `{"path", "branch", "base", "main",
  "changed", "area", "shared_files", "plans"}`; a plan in it is `{"id",
  "title", "path", "kind", "status", "matched"}` plus `status_line` when loose.
  `worktrees` lists every other worktree as `{"path", "branch", "main",
  "changed", "area"}`.
- `doctor.data` contains `counts` (`plans`, `active`, `done`, `loose`) and
  `dirs`, the plan directories read.
- `status.data` contains `ready`, `waiting`, `retained_done`, `critical_path`,
  and `edges` (`{"from", "to", "kind": "requires"}`).
- `why.data` contains `plan`, `readiness`, `blockers`, `dependents`
  (`active`/`done`), `staleness`, `overlaps`, `lineage`, `prunable`, and
  `unfilled_sections`.
- Mutations deleting files add `data.recovery_directory` after saving their exact
  pre-mutation bytes. Text output prints the same location. Dry-run creates no copy.
- `close.data` adds `unblocked` (dependents whose readiness flipped
  waiting→ready) and `retained` (target kept for active dependents).
- A `staleness` object is `{"state": "fresh"|"aging"|"stale"|"unknown",
  "commits_since_plan_update", "dirty_scope_paths", "anchor"}`.

Additions to `data` keys are backward compatible; the six top-level envelope
keys and the exit codes are stable.

### Advisory diagnostic codes

| Code | Severity | Meaning |
|---|---|---|
| `stale_plan` | warning | An active CLI plan's scope changed in ≥ threshold commits since the plan file last changed. Done and loose plans never warn; `context`/`why` still show their staleness. |
| `loose_plans` | warning | A plan directory holds documents without plan-graph frontmatter; they are read for routing only. One per directory. |
| `foreign_plan_dir` | warning | `create` wrote to `.agents/plans` while the repository already keeps plans in `docs/plans` or `.plans` and `plan-graph.dir` is unset. |
| `invalid_plan_dir` | warning | A `plan-graph.dir` value is absolute or leaves the repository; it is ignored. |
| `legacy_store` | warning | The v1 `.agents/plan/graph.yaml` exists at the root; it is ignored. |
| `nested_legacy_store` | warning | A v1 graph exists below the root; it is ignored. |
| `id_history_unchecked` | warning | `create`, `rename`, or `replace` could not finish the Git history ID check within 10 s; the command proceeded. |
| `scope_overlap` | warning | Two unordered active plans, at least one of them a CLI plan, currently match the same concrete files. |
| `possible_duplicate` | warning | Two active CLI plans share a tag and files or near-identical titles. |
| `tbd_sections` | warning | Sections still hold the `TBD` template (on close, or on a done plan). |
| `unverified_completion` | error | `close` refused: Outcome, Decisions, or Completion is unfilled. |
| `forced_close` | warning | `close --force` abandoned work without completing it. |
| `prunable_done` | warning | A done plan is required by no active plan; `gc` would remove it. |

### Store and plan-file errors

Reported by `doctor`, and by any command whose store fails to load (the first
error becomes the command's error).

| Code | Meaning |
|---|---|
| `nested_store` | A `.agents/plans` store exists below the Git root. Found from `git ls-files --cached --others --exclude-standard` (ignored trees and nested repositories are skipped); without Git, a walk that does not follow links or junctions. |
| `invalid_store` | `.agents` or a plan directory exists but is not a directory (a warning for directories other than `.agents/plans`). |
| `symlink_store` | `.agents`, a plan directory or one of its parents, or the recovery directory is a symlink (a warning for a directory that is only read). |
| `nested_plan` | A directory sits inside `.agents/plans`; plans must be flat files. |
| `symlink_plan` | A plan file is a symlink. |
| `read_failed` | A plan file cannot be read as UTF-8. |
| `invalid_id` | A filename or ID is not lowercase kebab-case. |
| `duplicate_id` | Two plan files resolve to the same ID; the first is kept. A warning when either is loose. |
| `invalid_json` | Frontmatter in `.agents/plans` is not strict JSON (syntax, duplicate keys, `NaN`/`Infinity`). A file without frontmatter is a loose plan, not an error. |
| `invalid_metadata` | Frontmatter is not an object, or an array field is not single-line non-empty strings. |
| `missing_metadata` | One of `status`, `requires`, `replaces`, `scope`, `tags` is absent. |
| `unknown_metadata` | Frontmatter holds a key outside those five. |
| `invalid_status` | `status` is not `active` or `done`. |
| `duplicate_metadata` | An array field repeats a value (case-insensitive). |
| `unroutable_plan` | Neither `scope` nor `tags` has an entry. |
| `invalid_scope` | A scope is absolute, `.`, contains `\` or `..`, or is not a supported glob. |
| `invalid_relation_id` | `requires` or `replaces` holds a malformed plan ID. |
| `missing_title` | The body has no `# Title` heading. |
| `title_not_first` | Content precedes the H1 title. |
| `duplicate_title` | The body has more than one H1. |
| `missing_section` | A required `##` section is absent. |
| `duplicate_section` | A required `##` section appears twice. |

### Graph errors

| Code | Meaning |
|---|---|
| `self_dependency` | A plan requires itself. |
| `dangling_requirement` | `requires` names a plan that does not exist. |
| `cycle` | `requires` edges form a cycle; the message lists the chain. |
| `self_replacement` | A plan replaces itself. |
| `live_replacement_target` | `replaces` names a plan that still exists. |
| `duplicate_replacement` | Two plans claim to replace the same ID. |

### Command errors

| Code | Meaning |
|---|---|
| `unknown_plan` | A named or required plan ID does not exist. |
| `loose_plan` | The target has no plan-graph frontmatter; edit it by hand under its directory's convention. |
| `id_reused` | The new ID for `create`, `rename`, or `replace` is live, reserved by `replaces`, or in Git history. |
| `invalid_title` | `--title` is empty or spans lines. |
| `no_changes` | The command would change nothing (`update` without effect, `reopen` on an active plan, `close` on a done plan). |
| `active_dependents` | `drop`, `replace`, or `close --force` refused while active plans rely on the target. |
| `path_escape` | A routing path or write target resolves outside the repository or store. |
| `root_not_found` | No `--root` and the working directory is not inside a Git worktree. |
| `root_not_toplevel` | `--root` points inside a Git worktree but not at its toplevel. |
| `git_failed` | Git could not be run or printed non-UTF-8 output. |
| `git_timeout` | A required Git call did not answer within 10 s. |
| `store_locked` | Another live process holds the store lock. |
| `concurrent_change` | The store changed between read and write; retry the command. |
| `recovery_failed` | Deleted plans could not be preserved first; nothing was changed. |
| `write_failed` | The transaction failed and touched files were rolled back. |
| `io_error` | Any other unexpected failure. |

Exit codes are `0` for success, `1` for validation/conflict/I/O failure, and
`2` for CLI usage errors. JSON domain errors still emit the one result object.
`--version` prints `plan-graph <version>` and exits without the envelope.

## Write safety

Mutations take a repository-local exclusive lock, reload the store to detect
concurrent edits, validate the full proposed graph, and use same-directory
atomic replacements. A failed multi-file operation restores every touched
file from its captured bytes. Plan files, plan directories, and their parents
may not be symlinks, no write may resolve outside the plan directories, and no
write or delete may touch a loose plan.

Before deleting any plan, preserve its current bytes under the common git dir's
(`git rev-parse --git-common-dir`, so a linked worktree's copies survive
`git worktree remove`) `plan-graph-recovery/<unique-id>/`, or `.agents/plan-recovery/<unique-id>/` in deliberate
non-Git use. Backup failure aborts before mutation. Successful deletion does not
remove these copies; there is no automatic retention cleanup. Copy the named Markdown
file back only after checking for a conflicting live plan and run `doctor` afterwards.
