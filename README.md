# plan-graph

Repository-local persistent plan store with derived routing, readiness, and
advisory signals. `SKILL.md` is the agent-facing workflow; this file is for
contributors changing the skill itself.

## Module map

```text
scripts/plan-graph.py      entry point (delegates to plan_graph.cli)
scripts/plan_graph/
  model.py                 Plan/Diagnostic dataclasses, strict-JSON frontmatter,
                           section parsing, scope glob compiler
  store.py                 load/validate/persist, requires-graph algorithms,
                           git integration, file lock, transactional writes
  routing.py               query scoring, decision pack, readiness, critical path
  advice.py                derived advisory signals: staleness, scope overlap,
                           near-duplicates, per-plan explanation (why)
  cli.py                   argparse surface, text/JSON emitters
```

## Design invariants

- **Files are the source of truth.** One Markdown file per plan under
  `<git-toplevel>/.agents/plans/`; there is no index to drift.
- **Derive, never store.** Readiness, staleness, overlap, impact, and pruning
  are computed on every read. Frontmatter holds exactly five keys
  (`status`, `requires`, `replaces`, `scope`, `tags`); adding a key is a
  format break, so advisory features must not require one.
- **Strict JSON frontmatter.** Duplicate keys and non-standard constants are
  parse errors, not tolerated input.
- **Stable envelope.** `--json` always emits
  `{ok, command, root, data, diagnostics, changes}` with exit codes 0/1/2.
  New behavior lands as additive `data` keys or new diagnostic codes.
- **Advisory checks degrade, never fail.** Everything in `advice.py` returns
  `unknown`/empty when git or the filesystem cannot answer; structural
  validation and mutations never depend on it.
- **Mutations are transactional.** Exclusive lock in `.git/`, re-read
  comparison against the snapshot, atomic writes, byte-level rollback.

Diagnostic codes and `data` shapes are cataloged in
[references/cli-contract.md](references/cli-contract.md); file-format and
signal semantics in [references/format.md](references/format.md).

## Tests

```bash
bash tests/run.sh                      # unittest suite, stdlib only
python3 ../../tests/validate-skill-evals.py   # eval schema check (repo root)
```

The CLI tests drive the real script as a subprocess with `--json` and assert
the full envelope on every call. Git-dependent behavior gets a throwaway
`git init` per test; everything else runs against a plain temp directory to
prove the degraded paths.
