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
- legacy/nested store diagnostics and the stable JSON envelope.
