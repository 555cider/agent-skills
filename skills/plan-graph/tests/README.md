# Plan Graph — regression suite

The RED/GREEN record for `scripts/plan-graph.py`. The script's contract is its
CLI — exit code plus the `CHANGE=` / `WARN=` / `ERROR=` / `OK` / `FAIL` lines
(and the `--json` object) — so every case asserts exactly that. The suite both
locks in the committed fixes and guards the bugs fixed alongside it.

## Run

```bash
bash skills/plan-graph/tests/run.sh     # exit 0 = all pass
```

No pytest, no dependencies. `run.sh` generates each fixture into a throwaway
`mktemp -d`, runs the script with an explicit `--root`, asserts, and cleans up.

## Fixtures

Fixtures are generated in `run.sh` (not committed) because several need bytes or
permissions git can't store portably — a UTF-8 BOM, a `0444` file, a
stale-mtime lockfile. `expected.json` is the human-readable catalogue of what
each case proves.

| Case | Mode | Guards |
|------|------|--------|
| `normal` | `--show` / check / `--json` | golden tree + roadmap + critical path reproduce; excluded wording only on real exclusions; `--json` shape |
| `single` | `--show` | lone node prints **no** Critical Path (depth>1 gate) |
| `cycle` | `--show` / check | `--show` exits 0 and lists all nodes (no crash); check errors `cycle detected` |
| `legacy` | check → `--fix` → check | missing frontmatter is `WARN` (exit 0), `--fix` adds it, recheck clean |
| `comment` / `comment-hash` | check | inline `# ...` tolerated; `#` inside a quoted value preserved |
| `done` / `dropped` / `missingnode` | `--fix` / check | non-active states sync to file; absent `x:missing` file is not a sync error |
| `sync` | `--fix` | `CHANGE=sync-frontmatter … summary,x` single-token format; blank line after `---` preserved |
| `readonly` | `--fix` | a frontmatter write failure surfaces `ERROR=` + exit 1 (no traceback) |
| `dedup` | `--fix` → check | duplicate bases collapse; rewritten graph re-parses |
| `badparse` | check / `--fix` | malformed graph exits 2 and `--fix` leaves it byte-identical |
| `missinggraph` | check / `--fix` | check exits 1; `--fix` initializes a `next: 1` graph |
| `bomplan` / `bomgraph` | `--fix` / check | a UTF-8 BOM neither corrupts a plan file (duplicate frontmatter) nor breaks graph parsing |
| `dupbase` | `--show` | a repeated base does not drop the dependent from the roadmap as a phantom cycle |
| `traversal` | `--fix` | `--fix` never writes frontmatter to a `..`/absolute path outside root |
| `forestrepeat` | `--show` | a cycle/forest node is never printed twice |
| `lockfresh` / `lockstale` | `--fix` | a fresh foreign lock blocks and survives; a stale lock is overtaken and our lock released |
| `writefail` | `--fix` | a graph-write failure surfaces `ERROR=failed to write graph` + exit 1, no traceback |
| `showfixlock` | `--show --fix` | `--show` never locks: it prints the tree (exit 0) even under a fresh foreign lock |

Plus one unit-style check that calls `release_lock` directly on a foreign-pid
lockfile and asserts it survives — the contention path can't exercise the
"our lock overtaken mid-run" branch.

## Gotchas (handled in `run.sh`; keep them when editing)

1. **Always pass `--root <fixture>`.** `default_root()` shells out to
   `git rev-parse --show-toplevel`; run inside this repo it resolves to the
   repo root, not the fixture, silently breaking every file-existence check.
2. **Node `p:` paths are relative to `--root`.** A node `p: "a.md"` needs the
   file at `<root>/a.md`; placing it under `.agents/plan/` unless `p:` says so
   gets it wrongly marked `x: missing`.
3. **`readonly` / `lockfresh` are skipped or weakened under root** (0444 is
   writable as root). `lockfresh` also costs ~3s (the script's retry loop) — do
   not add more locked-`--fix` cases that pay that cost.

The deeper lock race in `#9` (our own lock overtaken as stale *during* a run)
is not shell-reproducible end-to-end; the `release_lock` unit check covers the
ownership branch directly, with `lockfresh`/`lockstale` as the behavioral guards.
