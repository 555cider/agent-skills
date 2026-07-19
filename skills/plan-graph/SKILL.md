---
name: plan-graph
description: Use whenever a repository stores or should store persistent implementation or design plans that may overlap, depend on, replace, complete, or affect one another. Route the current task and changed code paths through `.agents/plans`, maintain plan lifecycle with the bundled CLI, and prune closed context. Do not use for chat-only one-off plans, checklists, package dependency diagrams, or repositories with another established planning system.
license: MIT
compatibility: Requires Python 3.10 or newer, git for default repository-root discovery, and local filesystem access.
---

# Plan Graph

Keep the smallest useful set of persistent plans in context for the next
decision. A plan is a decision document, not a task tracker or archive.

Plan Graph v2 is intentionally incompatible with the old numeric-ID
`.agents/plan/graph.yaml` format. Each Markdown plan is now the source of truth;
the CLI derives the graph, readiness, impact, and roadmap directly from the
files.

## Start with context

Run commands from anywhere inside the Git worktree. Replace `<skill-dir>` with
the directory containing this file.

For a task that has not changed files yet, route its text and any known paths:

```bash
python3 <skill-dir>/scripts/plan-graph.py context \
  --query "add retry recovery to checkout" \
  --path apps/backend/checkout/service.py
```

With no selectors, `context` uses staged, unstaged, and untracked Git paths:

```bash
python3 <skill-dir>/scripts/plan-graph.py context
```

An explicit query/path does not mix in an unrelated dirty worktree unless you
add `--worktree`. Use `--plan <id>` when the user names a plan directly.

The decision pack separates:

- `selected`: plans matched by an explicit ID, path scope, or query;
- `required`: transitive prerequisite decisions to read first;
- `affected`: active downstream plans that may need propagation review.

Read the full selected and required plan files before changing assumptions.
The compact Outcome, Decisions, and Acceptance excerpts are routing aids, not a
substitute for the source documents when editing them.

## Decide the plan action

After reviewing the routed plans, choose the smallest truthful action:

- Continue the existing plan when its outcome and assumptions still fit.
- Revise it in place when the same outcome remains valid but decisions changed.
- Create a new plan only for distinct work that should persist across sessions.
- Add `requires` only when the new plan genuinely relies on another plan's
  outcome. Scope or keyword similarity is never a dependency.
- Replace a plan when its conclusion is wrong. A replacement starts fresh and
  does not require the plan it replaces.
- Skip persistent plan changes for a one-off task that needs no future context.

The router never infers or writes dependency edges. This avoids turning shared
vocabulary into false ordering constraints.

## Maintain plans through the CLI

Create the metadata and template, then edit the Markdown decision content:

```bash
python3 <skill-dir>/scripts/plan-graph.py create checkout-recovery \
  --title "Checkout recovery" \
  --scope "apps/backend/checkout/**" \
  --tag checkout \
  --require auth-session
```

Use `update` for metadata and title changes; it preserves the plan body:

```bash
python3 <skill-dir>/scripts/plan-graph.py update checkout-recovery \
  --add-scope "apps/frontend/checkout/**" \
  --remove-require legacy-errors
```

Use `rename` to change an ID and every live `requires` reference together. Use
`replace` only after reviewing active dependents; it refuses to proceed while
any still rely on the old plan. Use `reopen` when a retained done prerequisite
needs revision.

Do not hand-edit frontmatter when a CLI operation exists. Directly edit the
Markdown body for evidence, decisions, implementation, and acceptance details.

Read [references/format.md](references/format.md) before authoring or debugging
the file format. Read [references/cli-contract.md](references/cli-contract.md)
when composing commands programmatically or consuming JSON output.

## Close context instead of archiving it

`done` plans remain only while an active plan requires them. Git is the archive.

Before a command that can delete files, inspect its exact change set:

```bash
python3 <skill-dir>/scripts/plan-graph.py close checkout-recovery --dry-run
python3 <skill-dir>/scripts/plan-graph.py close checkout-recovery
```

Apply the same dry-run-first pattern to `drop` and `gc`.

- `close` marks the target done, then removes every done plan outside the
  prerequisite closure of active plans.
- `drop` refuses active dependents, deletes the target, and removes newly
  orphaned done plans.
- `gc` removes already-prunable done plans.

Report every deleted plan path and note that Git can recover committed files.

## Validate after changes

Run structural validation after editing a plan body or completing CLI changes:

```bash
python3 <skill-dir>/scripts/plan-graph.py doctor
python3 <skill-dir>/scripts/plan-graph.py status
```

`doctor` checks strict metadata, required headings, path safety, dangling
requirements, live replacement targets, cycles, nested stores, and closed
plans ready for pruning. Fix errors before trusting `context` or `status`.

In the final response, state only the useful handoff:

- context reviewed and the chosen action;
- plans and `requires` relationships changed;
- downstream plans reviewed or updated;
- files pruned, if any;
- validation run and any remaining blocker.

## Do not use Plan Graph for

- a plan written only in chat;
- transient checklists, changelogs, or issue trackers;
- dependency diagrams for code packages or infrastructure;
- a repository that already has a different persistent planning convention.
