# Plan Graph v2 regression suite

Run:

```bash
bash skills/plan-graph/tests/run.sh
```

The thin shell entry point runs standard-library `unittest` cases. Tests use
temporary repositories and the real CLI; no third-party test dependency is
required.

Coverage includes:

- strict JSON frontmatter and required decision sections;
- path, Unicode query, prerequisite, and reverse-impact routing;
- Git-root discovery and dirty-worktree selection without nested stores;
- ready/waiting status and long iterative DAG traversal;
- create, update, rename, replace, reopen, close, drop, and garbage collection;
- ID tombstones, active-dependent refusal, dry-run, locks, rollback, and path
  or symlink escape prevention;
- legacy/nested store diagnostics and the stable JSON envelope;
- plan trees (`PlanTreeTests`): the optional `parent` key and its invalid forms,
  a parent waiting on active children, `close`/`drop` refusing them, `gc`
  keeping done ancestors, `dangling_parent`/`parent_cycle`/child-requires-ancestor
  `cycle`/`redundant_parent_require`, `tree` (depth, readiness, unexpanded,
  detached branches of a broken store), ancestors in `context` and `why`,
  `create`/`update --parent`, `--clear-parent`, `rename` relinking children,
  and `replace --subtree` with recovery copies;
- loose plan documents in `docs/plans` and `.agents/plans` (status line forms,
  backtick scope, read-only refusal), `git config plan-graph.dir`, and the v1
  store skipped with a warning;
- other worktrees: committed and uncommitted overlap, ignored `.plans/` read
  from disk, inherited plans not reported, and the same judgement as
  worktree-cycle's `worktree_overlap.py check` (`test_loose_and_worktrees.py`).
