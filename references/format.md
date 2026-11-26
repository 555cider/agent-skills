# Plan Graph v2 format

## Store

Plans are flat Markdown files in plan directories at the Git toplevel:

```text
.agents/plans/
  auth-session.md
  checkout-recovery.md
```

The CLI always resolves the Git toplevel first. Running it from a nested
application must not create another store. `--root` exists for tests and
deliberate non-Git use.

Which directories:

| Setting | Read | `create` writes to |
|---|---|---|
| `git config plan-graph.dir <dir>` (repeatable) | the configured directories only | the first one |
| unset | `.agents/plans`, plus `docs/plans` and `.plans` when they exist | `.agents/plans` |

Without the setting, `create` in a repository that already has `docs/plans` or
`.plans` warns `foreign_plan_dir` and names the setting.

- `README.md` and `index.md` in a plan directory are not plans.
- Only `.agents/plans` is strict: a subdirectory there is `nested_plan`, and
  frontmatter that is not valid JSON is an error. Elsewhere subdirectories
  (mockups, attachments) are skipped.
- An ignored directory (`.plans/` under `.gitignore`) is read from the
  filesystem like any other.

Plan Graph v2 does not read the v1 numeric-ID `.agents/plan/graph.yaml`. Its
presence is a `legacy_store` warning: every command still runs, and the file is
never migrated or touched.

## Loose plan documents

A Markdown file in a plan directory without plan-graph frontmatter is a loose
plan: another planning convention's document. Outside `.agents/plans`, a file
whose frontmatter is neither a JSON object with all five plan-graph keys nor
an unparsable `{` block (YAML, another tool's JSON keys) is loose too; a `{`
block that no longer parses is reported as `invalid_json`, since it is a
hand-edited CLI plan. Each directory holding any reports one
`loose_plans` warning.

| Field | Derived from |
|---|---|
| ID | the filename stem (no format rule) |
| title | the first `# ` heading, else the stem |
| status line | the first `상태`/`Status` line between the title and the first `## ` |
| status | `done` when the status line starts with 완료, 대체됨, 취소, or 폐기 (any suffix: 완료됨), or with the word done, complete(d), landed, finished, superseded, or cancel(l)ed, and names nothing left outside backticks (남은, 잔여, 열린, 미결, 미착수, 보류, or the word remaining, open, todo, pending); otherwise `active` |
| scope | paths in backticks that exist in the repository |
| Outcome | the text between the title and the first `## `, unless the document has an `## Outcome` |

Recognized status lines (blockquote, list item, bold, a parenthesized note
before the colon):

```markdown
> **상태 (코드 대조 2026-11-16)**: 남은 것 5건: …
> **상태: 완료** (근거 — `src/x.ts`, 확인 2026-11-16)
상태: dev 반영(2026-11-18, squash). 남은 것: …
- 상태: 초안, 결정 전 착수 없음
Status: done
```

Scope extraction, per backtick span:

- Line suffixes (`:12`, `#L4-L9`) are dropped and one `{a,b}` brace group is
  expanded. Spans with spaces, URLs, absolute paths, or `..` are skipped.
- An existing file is scoped as written; an existing directory as `dir/**`,
  unless it holds more than 50 files (a passing mention of `src/backend` is
  context, not ownership).
- A path with a slash that is not at the root matches files ending in it, at
  most three. A bare file name (`Toolbar.tsx`) matches only a unique file name.
- Code inside fenced blocks is ignored, as for headings.

The CLI never rewrites or deletes a loose plan. `update`, `rename`, `replace`,
`reopen`, `close`, and `drop` refuse one with `loose_plan`, and `gc` and pruning
never select one. A CLI plan may `requires` a loose plan; it waits until the
document's status line reads done. Two loose plans never produce a
`scope_overlap`, `possible_duplicate`, or `overlapping` signal, and `doctor`
does not warn `stale_plan` for them: their scopes are inferred from prose.
`context` and `why` still report their staleness.

## Document schema

A plan the CLI manages starts with `---` delimiters containing a strict JSON
object:

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
constants are errors. One optional key, `parent`, places the plan in a tree:

```json
{
  "status": "active",
  "parent": "checkout",
  "requires": [],
  "replaces": [],
  "scope": ["apps/backend/checkout/retry/**"],
  "tags": ["checkout", "retry"]
}
```

A plan without `parent` is top-level and reads exactly as before the key
existed. A top-level plan omits the key: `"parent": null` and `"parent": ""`
are `invalid_metadata`, so the file has one spelling for "no parent". The CLI
writes `parent` right after `status`.

- The filename stem is the plan ID. It must be lowercase kebab-case and is not
  duplicated in metadata.
- The single H1 is the title and must be the first body content. Lines inside
  ```` ``` ```` or `~~~` fenced code blocks are never headings, so a `# comment`
  in a shell snippet is neither a title nor a section.
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
- `parent`, when present, is the ID of the plan this one is a piece of. It must
  exist (`dangling_parent`), and no plan may be its own ancestor
  (`parent_cycle`).

IDs are never reused. Creation checks current IDs, all `replaces` tombstones,
and the file's Git history when available.

## Relationship and readiness semantics

For `A requires B`, B is read and completed before A becomes ready.

- An active plan with no active prerequisite in its transitive closure is
  `ready`.
- An active plan with any active prerequisite is `waiting`; those active
  prerequisites are its blockers.
- A done plan is retained only when it is in the transitive prerequisite
  closure of at least one active plan, or in its plan tree (see below).
- Reverse traversal through both active and done nodes identifies active plans
  affected by a change to a prerequisite.

## Plan trees

`C` with `"parent": "P"` is one piece of P's work.

- Active children are implicit prerequisites: P is `waiting` while any plan
  below it is active (an active piece under a done child counts too), and
  `status` lists them as `active_children` (`children=a,b` in text).
  They are not `blockers`, which stay the active `requires` closure.
- `requires` between siblings orders the pieces. A parent listing its own child
  in `requires` is redundant (`redundant_parent_require` warning). A child
  requiring its ancestor, directly or through other plans, waits for a plan
  that waits for it: `cycle` error.
- A parent's `requires` does not pass to its children; a child that builds on
  the same prerequisite lists it itself.
- An active plan under a done parent is a `done_parent` warning: reopen the
  parent or close the piece.
- Unexpanded: an active CLI plan with no children whose Implementation is still
  `TBD`. `tree` and `why` mark it; it is the next plan to split or implement.
- Overlap and near-duplicate advisories, and `context`'s `overlapping`, skip
  ancestor/descendant pairs: a parent's scope covers its pieces on purpose.
- `context` reads the selected plans' ancestors first, root first.

## Context routing

Selection is deterministic and read-only:

1. Explicit `--plan` IDs are selected.
2. Every plan whose `scope` matches an input path is selected. A directory
   path selects every plan whose scope reaches into it (`apps/` selects
   `apps/checkout/**`) or contains it (`apps/checkout/src/` selects
   `apps/checkout/**`).
3. A query scores title phrases, title tokens, tags, scope segments, then tokens
   from Outcome and Decisions. Query-only matches require a title/tag/scope hit
   or at least two body tokens; at most the top three are selected.
4. The router adds the selected plans' ancestors as `ancestor`, transitive
   prerequisites as `required`, and active reverse dependents as `affected`.
5. The decision pack lists ancestors first (root first), then the rest
   prerequisite-first, and includes Outcome,
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
  `doctor` warns only for active plans; a done plan's staleness appears only
  when `context` or `why` reads it.
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

## Other worktrees

Parallel agents each work in their own git worktree, so before anything lands
one worktree cannot see another's plans or edits. `overlap` and `context` read
every worktree in `git worktree list --porcelain`:

- **Changes**: the files a worktree's branch changed since its merge base with
  its base (`git diff --no-renames base...HEAD`), plus everything uncommitted
  (`git status --porcelain=v1 --untracked-files=all --no-renames`). The base is
  `branch.<branch>.worktreeCycleBase` (recorded by worktree-cycle), else
  `git config worktree-cycle.base`, else the branch checked out in the main
  worktree. Git calls: one `worktree list`, one `config`, then one `status` and
  at most one `diff` per worktree, run concurrently. Bare and prunable entries
  are skipped.
- **Plans**: each worktree's plan directories are read from its directory,
  ignored ones included. A document counts as that worktree's own only when
  that worktree changed it since its base, or its base branch does not track it
  (an ignored `.plans/` file; one `git ls-tree` per base). A plan inherited
  unchanged from the base is already here, and editing your own copy does not
  make the siblings' unchanged copies look like theirs. Only active plans count.
  A worktree whose plans cannot be read is listed under `warnings`; the others
  are still reported.
- **Nested worktrees**: when `.worktrees/` is not ignored, a worktree's status
  lists the worktrees inside it as untracked; those paths are dropped.
- **Overlap**: another worktree overlaps when it changed a file the selectors
  cover (a selector ending in `/` covers everything below it), or when one of
  its own plans has a scope matching a selector. The selectors are explicit
  `--path` values, else this worktree's own changes.

The file-level judgement is shared with worktree-cycle's `start`/`finish`:
`scripts/plan_graph/worktree_overlap.py` is a byte-identical copy of
`skills/worktree-cycle/scripts/worktree_overlap.py`, and the repository's
`tests/check-shared-copies.sh` fails when they drift. Overlap is advice: it never
fails a command, and a worktree git cannot read is listed under `warnings`.

## Closing and garbage collection

After marking a plan done, compute the keep set as all active plans and every
done plan below one, then add prerequisites and parents of every kept plan
until nothing changes. A tree stays whole while any ancestor is active: closed
pieces remain under an active parent (it does not read as unexpanded again), a
done ancestor of an active plan stays, and so do their own prerequisites, so
pruning never leaves a dangling `requires` or `parent`. Delete every done plan
outside that set. `replaces` does not retain a plan. As a result, closing the
last active plan of a tree, its root included, removes the entire completed tree. `close`, `close --force`,
and `drop` refuse a plan with active descendants (`active_children`); done
children still needed move up to the removed plan's parent (to the replacement
for `replace`). Git archives committed history; the mutation also preserves
the current bytes, including uncommitted changes, outside the live plan store and
reports the recovery directory. `close --force` means abandonment: active dependents
block it, and it removes the target rather than marking a prerequisite complete.
