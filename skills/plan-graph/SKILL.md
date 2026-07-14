---
name: plan-graph
description: Use when adding, revising, completing, dropping, or removing a persistent plan file in a repo that maintains (or should maintain) a `.agents/plan` dependency-graph index, or when a new plan may depend on, supersede, or relate to existing plan files. Not for drafting a single standalone plan with no cross-plan lineage — use a plain plan-writing skill for that.
license: MIT
compatibility: Requires Python 3.10 or newer, git for repository-root discovery, and local filesystem access.
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
- An active node may depend only on active or `done` bases. The script errors
  on a live dep into an `x: dropped` or `x: missing` node, so never wire a new
  plan to a superseded or abandoned one — grow it as an independent root
  instead.
- `x`: optional non-active state: `done`, `dropped`, or script-managed `missing`.
  `done` means completed but retained because an active plan still depends on it
  or removal is blocked.
- The graph is a machine-maintained compact YAML subset; keep comments out and
  let the script normalize quoting.
- Treat graph edits as single-writer work. Do not assign IDs in parallel.
- Removing completed nodes does not reuse IDs and does not decrement `next`.

### Plan File Frontmatter

The graph is the source of truth. Plan-file frontmatter is a readable copy
derived from the graph, and file-side frontmatter edits are overwritten from
the graph when `--fix` runs. Change plan IDs, summaries, states, and deps in
the graph first.

Every active, done, or dropped plan markdown file that exists SHOULD start with
a YAML frontmatter block. The fields inside the block match the node's
properties in the graph:

```yaml
---
id: 1
summary: "Auth/session plan"
x: "done"
deps: [2]
---
```

Omit `x` when the graph node has no state. Omit `deps` when the plan has no
base IDs. Keep the frontmatter `deps` in the same order as the graph node's
bases: `--fix` compares them order-sensitively and rewrites the file on any
reordering. (The graph's own `deps` order is separately the deterministic
tie-breaker for `--show`'s critical path, so keep the graph order intentional.)
The validation script warns
when frontmatter is absent from an existing legacy plan file and errors when
existing frontmatter conflicts with the graph. Running with `--fix` prepends or
updates frontmatter fields from the graph.

### First-time setup (existing plans, no graph)

`--fix` on a missing graph creates an **empty** `next: 1` graph; it does not
auto-discover existing markdown. To adopt a repo that already has plan files:

1. List the plan directory and pick the files worth tracking.
2. Allocate sequential IDs from `1`, add a `nodes` entry per file (relative
   path + one-line summary), and set `next` past the highest ID.
3. Read each file to infer real `deps` edges — do not leave `deps` empty just
   because the script accepts it.
4. Run plain check to catch missing-file or path errors, then run `--fix` to
   generate/synchronize frontmatter.
5. Report via `## Report Contract`.

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
| Same area, base's conclusion must be overturned   | base         | supersede   | new node; do NOT dep on the base (active plans can't depend on dropped); then mark base `x: dropped` or prune |
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

`relationship` and `decision` on the `Decisions` line MUST be tokens from the
Classification table. The report is written to the user in chat, not to a file.
Worked example:

```text
Reviewed: 1 (auth), 3 (checkout), legacy.md
Decisions: checkout.md -> base, reuse; legacy.md -> alternative, ignore
Deps: +[5->3] -[none]
Pruned: none
Propagation: 4 updated (assumption changed); 6 left, unaffected
```

## Common Mistakes

- Creating a new root before reviewing existing plans.
- Treating inspected-but-rejected plans as dependencies.
- Leaving completed closed trees as `x: done` archive entries.
- Removing a base plan without checking active dependents.
- Using the graph as a history log instead of active planning context.

## When NOT to use

- A one-off standalone plan with no cross-plan lineage — write it as a plain
  plan file; don't stand up a graph for a single node.
- Ephemeral task lists, checklists, or changelogs — the graph tracks active
  planning context and dependencies, not history or to-dos.
- Repos that already have a different planning-index convention — follow it
  rather than adding a parallel `.agents/plan/graph.yaml`.

## Cycle Resolution

If a cycle is detected during validation, the check fails with the error
`cycle detected: <chain>` (exit 1); the cyclic nodes are also dropped from the
roadmap when you run `--show`. Resolve cycles immediately:
1. Identify the circular dependency chain in the validation output (e.g., `1 -> 2 -> 1`).
2. Determine which dependency link in the cycle is invalid or redundant.
3. Edit the `deps:` block in `.agents/plan/graph.yaml` to remove the circular dependency link.
4. Run validation with `--fix` to synchronize the corrected dependencies back to the individual plan files.


## Command

Run from the repo root. `<skill-dir>` is the directory holding this `SKILL.md`
(typically `~/.claude/skills/plan-graph` or the repo's `skills/plan-graph`);
substitute its path in the commands below.

**Check first — this never writes:**

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml
```

Check reports missing legacy frontmatter as a warning (exit 0) and validates the
graph. Per Workflow step 1, run this before trusting an existing graph. The
graph is valid only if every `deps` key/value exists in `nodes` and active plans
do not depend on `x: dropped` or `x: missing` nodes.

**Then `--fix` to apply repairs — this writes files:**

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml --fix
```

`--fix` marks missing active plan files `x: missing` (and clears it if the file
returns), deduplicates dep lists, creates an empty graph if none exists, and
prepends/syncs plan-file frontmatter from the graph. Run it once on an existing
graph to generate frontmatter. Structural validation finishes before writes;
the graph source of truth is atomically saved before derived plan frontmatter.
If a later plan-file write fails, fix the filesystem error and rerun `--fix` to
recover from the graph.
After removing a completed tree, run check again.

`--root <dir>` overrides the repo root used to resolve plan paths (default: the
git toplevel of the graph's directory, else a `.agents/plan` heuristic, else the
cwd). `--fix` takes an exclusive `<graph>.lock` for the duration of the write;
if you see `ERROR=graph locked by another process`, another `--fix` is running —
wait and retry. A lock is reclaimed only when it is old and its owning PID is no
longer alive; never delete a live owner's lock based on age alone. Check and
`--show` take no lock.

To view the current plans as a tree, add `--show`:

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml --show
```

Roots are top-level dependents (nodes nothing else depends on); each subtree
lists that plan's bases. Shared bases appear once and are marked `↑` on repeats.
Non-active states render inline as `(done)`, `(dropped)`, or `(missing)`.
The roadmap includes only active nodes with no `x` state; `done`, `dropped`, and
`missing` nodes still appear in the tree but are excluded from roadmap ordering.
Roadmap ordering is deterministic; when multiple dependency chains have the same
length, critical-path tie-breaking follows the dependent's `deps` order. Nodes
blocked by a cycle are printed as `(cycle, excluded from roadmap)`.
`--show` is read-only, prints to stdout only, and exits `0` on success or `2` on
parse failure; it skips validation, so use it alongside the check/`--fix` modes
rather than as a replacement. `--show` takes precedence over `--fix`: passing
both shows the tree and performs no repair — run them as separate invocations.

To scan existing plan text for missing dependency candidates without mutating
the graph, use `--suggest-deps`:

```bash
python3 <skill-dir>/scripts/plan-graph.py .agents/plan/graph.yaml --suggest-deps
```

This mode is read-only. It reports candidates such as `SUGGEST=3->1 EXTRACTED
path reference .agents/plan/auth.md`; JSON mode returns a `suggestions` array
with `dependent`, `base`, `confidence`, and `reason`. `EXTRACTED` means the
dependent plan explicitly names the base path, filename, or summary. `INFERRED`
means weaker keyword overlap around dependency language. Treat suggestions as
review input only: classify them with the normal relationship/decision table
before editing `deps:`. `--suggest-deps` takes precedence over `--fix`, so it
does not initialize, lock, or repair the graph.

Example output:

```
[5] Migration plan
├── [3] Checkout recovery
│   └── [1] Auth/session
└── [4] DB schema
    ├── [1] Auth/session ↑
    └── [2] Error strategy

Critical Path (Longest unresolved chain):
  [1] ➔ [3] ➔ [5]
```

A `Suggested Implementation Roadmap (Active Plans)` list of the active nodes in
dependency order prints after the tree; separate root trees and inline
non-active states (e.g. `[7] Legacy approach (dropped)`) render as described
above.

## Command Output Contract

The script emits machine-readable lines: `CHANGE=<verb> <id> [reason]` and
`OK plan graph` on stdout; `WARN=`, `ERROR=`, and `FAIL plan graph` on stderr.
Exit codes: `0` valid, `1` validation errors (or lock/missing-graph failure),
`2` unparseable graph. Add `--json` (any mode) for a single stdout object.

**Full contract** — verbs, JSON shapes, and the `--fix` write-ordering hazard —
is in `references/output-contract.md`. Read it when parsing the output
programmatically.
