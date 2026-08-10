# Plan Graph v2 format

## Store

One Git worktree owns one flat plan store:

```text
.agents/plans/
  auth-session.md
  checkout-recovery.md
```

The CLI always resolves the Git toplevel before looking for `.agents/plans`.
Running it from a nested application must not create another store. `--root`
exists for tests and deliberate non-Git use.

The v1 `.agents/plan/graph.yaml` file is unsupported. Its presence is a doctor
error rather than a migration signal.

## Document schema

Every file starts with `---` delimiters containing a strict JSON object:

```markdown
---
{
  "status": "active",
  "requires": ["auth-session"],
  "replaces": [],
  "scope": ["apps/backend/checkout/**"],
  "tags": ["checkout", "recovery"]
}
---
# Checkout recovery

## Outcome
...

## Evidence
...

## Decisions
...

## Implementation
...

## Acceptance
...

## Completion
...
```

All five keys are required; unknown or duplicate keys and non-standard JSON
constants are errors.

- The filename stem is the plan ID. It must be lowercase kebab-case and is not
  duplicated in metadata.
- The single H1 is the title and must be the first body content.
- Each of the six H2 sections above occurs exactly once.
- `status` is `active` or `done`. Readiness is derived, never persisted.
- `requires` lists prerequisite plan IDs. Every target must exist, self-links
  and duplicates are invalid, and the resulting graph must be acyclic.
- `replaces` lists removed plan IDs. These targets normally do not exist; a
  live target is an error. `replaces` records lineage but never blocks work or
  retains a file.
- `scope` contains repository-relative POSIX globs. Supported operators are
  `*` within one path segment, `**` across segments, and `?` for one character.
  Absolute paths, `..`, backslashes, and character classes are invalid.
- `tags` contains routing phrases. Matching is Unicode-aware and case-folded.
- At least one `scope` or `tags` value is required so the plan is routable.

IDs are never reused. Creation checks current IDs, all `replaces` tombstones,
and the file's Git history when available.

## Relationship and readiness semantics

For `A requires B`, B is read and completed before A becomes ready.

- An active plan with no active prerequisite in its transitive closure is
  `ready`.
- An active plan with any active prerequisite is `waiting`; those active
  prerequisites are its blockers.
- A done plan is retained only when it is in the transitive prerequisite
  closure of at least one active plan.
- Reverse traversal through both active and done nodes identifies active plans
  affected by a change to a prerequisite.

## Context routing

Selection is deterministic and read-only:

1. Explicit `--plan` IDs are selected.
2. Every plan whose `scope` matches an input path is selected.
3. A query scores title phrases, title tokens, tags, scope segments, then tokens
   from Outcome and Decisions. Query-only matches require a title/tag/scope hit
   or at least two body tokens; at most the top three are selected.
4. The router adds transitive prerequisites as `required` and active reverse
   dependents as `affected`.
5. The decision pack is ordered prerequisite-first and includes Outcome,
   Decisions, and Acceptance excerpts capped at 1,200 characters per section.

Routing never changes `requires`. A matched plan is related context, not proof
of a dependency.

## Advisory signals

Advisory signals are computed from Git and file content on every read; nothing
about them is stored in frontmatter, so they can never drift.

- **Staleness**: the anchor is the last commit touching the plan file. The
  churn count is `git rev-list --count <anchor>..HEAD` over the plan's scope as
  `:(glob)` pathspecs. `0` commits is `fresh`, `1`–`4` is `aging`, and the
  threshold (default `5`, `doctor --stale-after N`) makes it `stale`. A plan
  file that is itself dirty or untracked is `fresh` — it is being revised right
  now. No scope, no anchor, or no usable git means `unknown`, never a warning.
  Git `:(glob)` semantics approximate the scope matcher; treat the count as a
  heuristic, not an exact file diff.
- **Overlap**: two active plans conflict only when their scopes match at least
  one identical existing file (tracked or untracked). Pattern intersection
  alone is deliberately not a conflict — a phantom overlap over files that do
  not exist would train the reader to ignore the warning. A `requires`
  relationship in either direction makes the overlap an intentional layering
  and suppresses it.
- **Near-duplicates**: two active plans that share a tag and either share
  matched files or have title token Jaccard ≥ 0.5.
- **Completion gate**: a section whose entire content is the literal `TBD`
  template counts as unfilled. `close` refuses while Outcome, Decisions, or
  Completion is unfilled; Evidence, Implementation, and Acceptance produce
  only a `tbd_sections` warning.

When git or the filesystem cannot answer (no repository, unreadable tree),
advisory checks silently degrade: staleness reports `unknown` and overlap and
duplicate checks are skipped. Structural validation never depends on them.

## Closing and garbage collection

After marking a plan done, compute the keep set as all active plans plus their
transitive prerequisites. Delete every done plan outside that set. `replaces`
does not retain a plan. As a result, closing the last active leaf removes its
entire completed tree, leaving Git as the only archive.
