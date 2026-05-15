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

1. If the graph exists, run the command below before trusting it.
2. Before drafting a new or revised plan, inspect existing graph nodes and read
   active candidate plans. If no graph exists, scan the repo's plan directory
   before creating the first graph.
3. Classify each candidate as:
   `relationship`: `base`, `alternative`, `dependent`, or `unrelated`;
   `decision`: `reuse`, `revise`, `supersede`, `independent`, or `ignore`.
   Keep valid assumptions, call out stale or conflicting assumptions, and note
   gaps. Treat "predecessor" and "obsolete" as notes, not graph labels.
4. Only create a new plan node if `reuse` or `revise` would be worse. For a new
   node, assign `next`, add a `nodes` entry, and increment `next` in the same
   edit.
5. Add `deps` only for base plans whose assumptions, decisions, or unfinished
   work remain in force. Do not add deps for alternatives, unrelated plans, or
   plans inspected and rejected.
6. Before changing or removing a base plan, reverse-search `deps` for affected
   dependents.
7. For each affected dependent, update it, mark it for review in the response, or
   leave the base plan unchanged if propagation is too costly.
8. A plan is complete only when its tasks are resolved in the plan file and the
   user or agent has declared it done. When a complete tree is closed, remove it
   from the plan directory and graph: delete completed plan files, delete their
   `nodes` entries, delete their `deps` entries, and remove their IDs from any
   remaining dep lists. A tree is closed only when no active outside plan still
   depends on it.
9. Use `x: done` only when a completed plan must remain because an active plan
   still depends on it or removal is explicitly blocked. Use `x: dropped` for
   rejected or abandoned plans that should remain visible as non-active context.
10. Report using the contract below.

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
