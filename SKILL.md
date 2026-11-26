---
name: plan-graph
description: Use when several agents or git worktrees change one repository at the same time and must see each other's plans and changed files before landing ("다른 워크트리와 겹치는지", "병렬 작업 충돌 확인"); before starting large multi-step work that needs a design plan kept across sessions ("큰 작업 설계", "계획 세우기"); or when writing, routing, or tidying plan documents in `.agents/plans`, `docs/plans`, or `.plans` ("계획 문서 정리", "끝난 계획 지우기"). Not for chat-only plans, checklists, or package dependency diagrams.
license: MIT
compatibility: Requires Python 3.10 or newer, git for default repository-root discovery, and local filesystem access.
---

# Plan Graph

Keep the smallest useful set of persistent plans in context for the next
decision, across every worktree of the repository. A plan is a decision
document, not a task tracker or archive.

Two jobs:

- **Parallel work**: agents in separate git worktrees cannot see each other's
  plans or edits until something lands. `overlap` reads them all.
- **Up-front design**: a multi-step change gets a plan before code, and the
  plans it touches are read first.

Run commands from anywhere inside the Git worktree. Replace `<skill-dir>` with
the directory containing this file. `bin/plan-graph` picks a working Python
3.10+ (`python3`, `python`, then `py -3`; override with `PLAN_GRAPH_PYTHON`).
From PowerShell or cmd, call `<skill-dir>\bin\plan-graph.cmd` instead.

## Plan directories

Plans are read from `git config plan-graph.dir` (repeatable; the first is where
`create` writes). Without it: `.agents/plans`, plus `docs/plans` and `.plans`
when they exist, and `create` writes to `.agents/plans`. A repository with its
own convention keeps it: set `git config plan-graph.dir docs/plans` only when
CLI-managed plans should live there too.

- A document **without plan-graph frontmatter** is a loose plan: its `# ` title,
  its first `상태:`/`Status:` line, and the existing repository paths it names
  in backticks (as scope) are read, with one `loose_plans` warning per
  directory. The CLI never rewrites or deletes it (`loose_plan`): edit it by
  hand under that directory's convention, for example its status line.
- An old v1 `.agents/plan/graph.yaml` is skipped with a `legacy_store`
  warning; every command still runs.

## Check other worktrees

Before editing in a repository with other active worktrees, and again before
reporting or landing:

```bash
<skill-dir>/bin/plan-graph overlap
<skill-dir>/bin/plan-graph overlap --path apps/backend/checkout/
```

Without `--path` it checks this worktree's own changes: committed since its
base plus uncommitted. For each other worktree it reports `shared_files` (that
worktree changed them too, committed or not) and `plans` (its own plan
documents whose scope matches, including ignored `.plans/` files and plans not
landed yet). Then:

- A shared file: read that worktree's plan or diff before editing the file;
  whoever lands second rebases and re-checks it. Tell the user which branch
  holds it.
- A matching plan: read it before writing a plan of your own; continue or
  coordinate instead of filing the same work twice.
- Nothing: proceed. The check is advice and never blocks.

worktree-cycle's `start` and `finish` run the same file-level check without
plan-graph installed.

## Start with context

For a task that has not changed files yet, route its text and any known paths:

```bash
<skill-dir>/bin/plan-graph context \
  --query "add retry recovery to checkout" \
  --path apps/backend/checkout/service.py
```

With no selectors, `context` uses this worktree's changes: staged, unstaged,
untracked, and committed since its base:

```bash
<skill-dir>/bin/plan-graph context
```

A relative `--path` is read from the current directory, and a directory path
selects every plan scoped inside it. An explicit query/path does not mix in an
unrelated dirty worktree unless you add `--worktree`. Use `--plan <id>` when the user names a plan directly.
`other_worktrees` lists the other worktrees touching the routed paths, as in
`overlap`; act on it the same way.

The decision pack separates:

- `selected`: plans matched by an explicit ID, path scope, or query;
- `ancestors`: the plans a selected plan is a piece of, read first, root first;
- `required`: transitive prerequisite decisions to read first;
- `affected`: active downstream plans that may need propagation review;
- `overlapping`: active plans that currently match the same concrete files as a
  selected plan without any `requires` ordering.

Every pack item carries a derived `staleness` signal and its `kind` (`graph`
or `loose`, with the `status_line`), and a query that selects nothing lists its
`near_misses`. Read the full selected and required plan files
before changing assumptions. The compact Outcome, Decisions, and Acceptance
excerpts are routing aids, not a substitute for the source documents when
editing them.

## Decide the plan action

After reviewing the routed plans, choose the smallest truthful action:

- Continue the existing plan when its outcome and assumptions still fit.
- Revise it in place when the same outcome remains valid but decisions changed.
- Create a new plan only for distinct work that should persist across sessions.
- Add `requires` only when the new plan genuinely relies on another plan's
  outcome. Scope or keyword similarity is never a dependency.
- Split a plan too large for one session into child plans (`--parent`, below)
  instead of growing one document.
- Replace a plan when its conclusion is wrong. A replacement starts fresh and
  does not require the plan it replaces.
- Skip persistent plan changes for a one-off task that needs no future context.

The router never infers or writes dependency edges. This avoids turning shared
vocabulary into false ordering constraints.

## Act on advisor signals

Advisory signals are derived from Git and file content at read time and are
never persisted. Each one requires a concrete response, not acknowledgement:

- `stale_plan` warning (active plans only), or `staleness.state` of `stale` on a
  pack item (`Staleness:` line in text output): the
  plan's scope changed in that many commits since the plan file itself last
  changed. Read the scope diff since `staleness.anchor`, then continue, revise,
  reopen, or replace — do not act on the plan text unread.
- `scope_overlap` warning or an `overlapping` pack entry: another active plan
  owns the same files with no declared ordering. Read that plan before editing
  shared files. Add `requires` only for a genuine ordering. Independent changes
  may legitimately share a file: record the coordination decision rather than
  narrowing truthful scopes just to silence an advisory.
- `possible_duplicate` warning: two active plans look like one piece of work
  filed twice. Merge them with `update`, or differentiate scope and title.
- Empty `selected` with non-empty `near_misses`: read the near-miss plans
  before creating a new plan; the most common routing failure is a duplicate
  plan created over a weak query match.

`why <id>` aggregates readiness, blockers, parent and children, dependents,
staleness, overlaps, replacement lineage, and unfilled sections for one plan — run it before
deciding whether to trust, revise, or replace a specific plan:

```bash
<skill-dir>/bin/plan-graph why checkout-recovery
```

## Maintain plans through the CLI

Create the metadata and template, then edit the Markdown decision content:

```bash
<skill-dir>/bin/plan-graph create checkout-recovery \
  --title "Checkout recovery" \
  --scope "apps/backend/checkout/**" \
  --tag checkout \
  --require auth-session
```

Use `update` for metadata and title changes; it preserves the plan body:

```bash
<skill-dir>/bin/plan-graph update checkout-recovery \
  --add-scope "apps/frontend/checkout/**" \
  --remove-require legacy-errors
```

Use `rename` to change an ID and every live `requires` and `parent` reference
together. Use `replace` only after reviewing active dependents; it refuses to
proceed while any still rely on the old plan. Use `reopen` when a retained done
prerequisite needs revision.

## Split large work into a plan tree

When one outcome needs several sessions of work, keep it as a parent plan and
create each piece under it with `--parent`. Order sibling pieces with
`requires`; never make a parent require its child or a child require its
ancestor:

```bash
<skill-dir>/bin/plan-graph create checkout-retry-api \
  --title "Checkout retry API" --parent checkout-recovery \
  --scope "apps/backend/checkout/retry/**" --tag checkout
<skill-dir>/bin/plan-graph tree checkout-recovery
```

- A parent stays `waiting` while any child is active and cannot be closed,
  dropped, or abandoned until its children are done (`active_children`). Close
  the pieces, then fill and close the parent.
- `tree [<id>]` shows the tree with readiness and marks `unexpanded` plans: no
  children and Implementation still `TBD`. Split those further or implement
  them.
- `update --parent ID` moves a plan; `update --clear-parent` makes it top-level.
- When a parent's design turns out wrong, `replace OLD NEW --subtree` deletes
  it and every piece under it (saved to the recovery directory) and puts NEW in
  its place. Without `--subtree`, `replace` refuses a plan with active children.

Do not hand-edit frontmatter when a CLI operation exists. Directly edit the
Markdown body for evidence, decisions, implementation, and acceptance details.
Do not add frontmatter to a loose document to make the CLI manage it unless the
repository adopts plan-graph for that directory; follow its own convention.

Read [references/format.md](references/format.md) before authoring or debugging
the file format. Read [references/cli-contract.md](references/cli-contract.md)
when composing commands programmatically or consuming JSON output.

## Close context instead of archiving it

`done` plans remain only while an active plan requires them. Git preserves committed
history; deletion also saves the exact current bytes in a recovery directory.

Before a command that can delete files, inspect its exact change set:

```bash
<skill-dir>/bin/plan-graph close checkout-recovery --dry-run
<skill-dir>/bin/plan-graph close checkout-recovery
```

Apply the same dry-run-first pattern to `drop` and `gc`. Loose plans are never
closed or pruned by the CLI: when one is finished, update or delete it the way
its directory's README says.

- `close` refuses while Outcome, Decisions, or Completion still hold the `TBD`
  template (`unverified_completion`): fill them with what actually happened
  first. `--force` abandons and removes the plan; it refuses active dependents
  and never satisfies their prerequisites. Revise dependencies explicitly first.
  A successful close reports `unblocked` dependents and whether the plan was
  `retained` for active dependents.
- `close` marks the target done, then removes every done plan that is not a
  prerequisite, ancestor, or descendant of an active plan. Closed pieces of a
  tree stay until its active ancestors close.
- `drop` refuses active dependents, deletes the target, and removes newly
  orphaned done plans.
- `gc` removes already-prunable done plans.

Report every deleted plan path and the returned `recovery_directory`. Its files
preserve uncommitted edits too. Recovery copies are not live plans; inspect and
restore only the intended file. Retention is manual, never automatic deletion.

## Validate after changes

Run structural validation after editing a plan body or completing CLI changes:

```bash
<skill-dir>/bin/plan-graph doctor
<skill-dir>/bin/plan-graph status
```

`doctor` checks strict metadata, required headings, path safety, dangling
requirements and parents, live replacement targets, `requires` and parent
cycles, nested stores, and closed
plans ready for pruning, lists the plan directories it read (`dirs`) and how
many loose documents they hold, plus the advisory checks above (staleness, scope
overlap, near-duplicates; tune with `--stale-after N`, skip with
`--structural-only`). Fix errors before trusting `context` or `status`.

In the final response, state only the useful handoff:

- context reviewed and the chosen action;
- other worktrees that overlap (branch, shared files, plan), or none;
- plans and `requires` relationships changed;
- downstream plans reviewed or updated;
- files pruned, if any;
- validation run and any remaining blocker.

## Do not use Plan Graph for

- a plan written only in chat;
- transient checklists, changelogs, or issue trackers;
- dependency diagrams for code packages or infrastructure;
- moving or reformatting another convention's plan documents.
