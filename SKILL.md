---
name: plan-graph
description: Use when creating, revising, reviewing, completing, dropping, or removing persistent planning documents that may need a numeric dependency graph or may relate to existing plan files.
---

# Plan Graph

Purpose: keep only the active planning context and dependency lineage needed for
future decisions. The graph is not an archive, changelog, checklist, or task
tracker.

Use this skill whenever persistent plan files are created, revised, based on
other plans, completed, dropped, or removed. New plans are not blank roots by
default: first review existing plans and fit the work into the best current
plan tree.

Default graph file: `.agents/plan/graph.yaml`. Use another path only if the repo
already has a clear planning-index convention.

## Format

Keep the graph separate from plan files:

```yaml
next: 4

nodes:
  1: {p: ".agents/plan/auth.md", s: "Auth/session plan"}
  2: {p: ".agents/plan/errors.md", s: "Error strategy"}
  3: {p: ".agents/plan/checkout.md", s: "Checkout recovery plan"}

deps:
  3: [1, 2]
```

Rules:
- `next`: required next numeric ID. Never reuse IDs.
- `nodes`: ID to `{p:path, s:summary, x:state?}`. Use JSON-quoted strings.
- `p`: non-empty relative path inside the repo. Do not use absolute paths or
  `..` traversal.
- `deps`: dependent ID to base IDs. `3: [1, 2]` means plan `3` depends on plans
  `1` and `2`.
- `x`: optional non-active state: `done`, `dropped`, or script-managed `missing`.
  `done` means completed but retained because an active plan still depends on it
  or removal is blocked.
- The graph is a machine-maintained compact YAML subset; keep comments out and
  let the script normalize quoting.
- Treat graph edits as single-writer work. Do not assign IDs in parallel.
- Removing completed nodes does not reuse IDs and does not decrement `next`.

## Workflow

1. If a graph exists, run the command in `## Command` to validate before trusting it.
   If no graph exists, scan the repo's plan directory before creating the first graph.
2. For each candidate plan that touches the same area, classify it using the table
   below, then act per the **action** column. Only the `dependent / independent`
   row adds a `deps` entry; other rows either reuse the base in place or create
   an unrelated new tree.
3. New node only if no `reuse` or `revise` row fits. Assign `next`, add a `nodes`
   entry, and increment `next` in the same edit. Never reuse IDs.
4. Before changing or removing any base plan, reverse-search `deps` for dependents
   and apply propagation per the table.
5. Use `x:` states sparingly: `done` only if a still-active plan depends on it;
   `dropped` for rejected/abandoned that should stay visible as non-active context.
   Otherwise prune the node entirely.
6. Report using `## Report Contract`.

### Classification table

`relationship` ∈ `{base, alternative, unrelated, dependent}`.
`decision` ∈ `{reuse, revise, supersede, ignore, independent}`.
Use exactly these tokens in `Decisions` (see `## Report Contract`).

| Candidate state                                   | relationship | decision    | action                                                     |
|---------------------------------------------------|--------------|-------------|------------------------------------------------------------|
| Same area, base's assumptions still hold          | base         | reuse       | extend the existing plan; no new node, no new dep          |
| Same area, some assumptions stale                 | base         | revise      | edit the base plan in place; no new node, no new dep       |
| Same area, base's conclusion must be overturned   | base         | supersede   | new node; mark base `x: dropped` or prune (no dep on base) |
| Different approach to same goal                   | alternative  | ignore      | no node, no dep; note in `Decisions`                       |
| Unrelated to candidate area                       | unrelated    | ignore      | no node, no dep                                            |
| Depends on a base but starts fresh work           | dependent    | independent | new node, add `new -> base` dep                            |

### Propagation rules (when changing or removing a base)

| Situation                                              | what to do                                       |
|--------------------------------------------------------|--------------------------------------------------|
| Dependent still relies on the changed assumption       | update dependent in same response                |
| Dependent unaffected by the specific change            | leave dependent; note in `Propagation`           |
| Propagation cost > value of the change                 | leave base unchanged; record reason in response  |
| Base done, no active dependent, removal not blocked    | prune base (delete file + node + dep entries)    |
| Base done, active dependent still references it        | keep base, mark `x: done`                        |

A complete tree is closed only when no active outside plan depends on it; only
then delete its files and nodes together. Treat "predecessor" and "obsolete"
as notes in the response, not graph labels.

## Report Contract

Every plan-graph response must include:

```text
Reviewed: <plan ids or paths inspected>
Decisions: <candidate -> relationship, decision>
Deps: +[added] -[removed]
Pruned: <completed tree ids/paths removed, or none>
Propagation: <dependent updates, review-needed items, or none>
```

## Common Mistakes

- Creating a new root before reviewing existing plans.
- Treating inspected-but-rejected plans as dependencies.
- Leaving completed closed trees as `x: done` archive entries.
- Removing a base plan without checking active dependents.
- Using the graph as a history log instead of active planning context.

## Command

Run from the repo root. Replace `<skill-dir>` with this skill's directory.

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml --fix
```

Without `--fix`, the command only checks. With `--fix`, missing active plan
files are marked with `x: missing`; if the file returns, `x: missing` is
cleared. If the graph file does not exist yet, `--fix` creates an empty graph.
The command also deduplicates dep lists.

After removing a completed tree, run the command again. The graph is valid only
if every `deps` key/value exists in `nodes` and active plans do not depend on
`x: dropped` or `x: missing` nodes.

To view the current plans as a tree, add `--show`:

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml --show
```

Roots are top-level dependents (nodes nothing else depends on); each subtree
lists that plan's bases. Shared bases appear once and are marked `↑` on repeats.
Non-active states render inline as `(done)`, `(dropped)`, or `(missing)`.
`--show` is read-only, prints to stdout only, and exits `0` on success or `2` on
parse failure; it skips validation, so use it alongside the check/`--fix` modes
rather than as a replacement.

Example output:

```
[5] Migration plan
├── [3] Checkout recovery
│   └── [1] Auth/session
└── [4] DB schema
    ├── [1] Auth/session ↑
    └── [2] Error strategy

[6] Logging plan

[7] Legacy approach (dropped)
```

## Command Output Contract

The script writes machine-readable lines that callers (this skill, or any other
agent chaining on plan-graph) can parse. Streams are split deliberately —
state-change records go to stdout, problems go to stderr.

stdout:

```
CHANGE=<verb> <node_id> [reason]   # one line per --fix mutation
OK plan graph                       # success sentinel (exit 0)
```

`<verb>` ∈ `{mark, clear, dedup, remove}`:
- `mark <id> missing` — active plan file is gone; node marked `x: missing`
- `clear <id> missing` — previously-missing file is back; `x` cleared
- `dedup <id>` — duplicate base IDs removed from the dep list
- `remove <id> empty-deps` — dep entry became empty after dedup and was removed

stderr:

```
WARN=<message>                      # advisory (e.g. done w/o active dependent)
ERROR=<message>                     # validation error
ERROR=parse: <exception>            # graph file failed to parse (exit 2)
FAIL plan graph                     # failure sentinel (exit 1)
```

Exit codes: `0` = valid (with or without changes); `1` = validation errors;
`2` = graph file unparseable.

Write ordering with `--fix`: drift repairs (`CHANGE=` lines) are persisted
*before* validation runs, so a `--fix` invocation that exits `1` may still have
mutated the graph file. Use `--fix` only when you intend to accept the drift
repairs; run without `--fix` first if you want a pure read-only check.
Parse failure (exit `2`) is the one case where the graph is guaranteed not
touched.
