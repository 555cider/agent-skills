# Source Location

Run the deterministic locator before ad-hoc searches:

```bash
node scripts/locate-source.mjs --repo=<repo-root> --input=<request.json|->
```

It enumerates tracked plus non-ignored untracked source, excludes dependencies/build output, uses
fixed-string `rg` arguments (with a Node scan fallback), and returns scored candidates with signal
families and line previews. Page data is never interpolated into a shell command.

## Signals

- Direct CDP matched-style source and validated React source hints.
- `data-testid`, `aria-label`, id, name, and accessible name.
- Distinctive class sequences/tokens, visible and nearby text.
- React component names and route segments.

Treat a result as high confidence only when the locator reports it: score at least `0.82`, at least
two independent signal families, and at least `0.12` separation from the runner-up. `0.55+` is
medium; everything else is low. Read the top candidates and confirm the owning markup/style before
editing even at high confidence. Runtime hints are corroborating evidence, never a path bypass.

For monorepos, search the whole repository first and use route/package signals to break ties. Never
rank `.git`, `node_modules`, `dist`, `build`, `.next`, `out`, or `coverage` as source.

## Checking the thresholds

The `0.82`/`0.12` gate is hand-set. To see whether it holds up, keep results under a stable
`--artifacts=DIR` (the default session root is a temporary directory) and run:

```bash
node scripts/locator-report.mjs <artifact-dir>...
```

It reads every `fix-result.json` and reports, per score band, how often the top candidate was a file
the applied edit actually changed, with a 95% Wilson interval. Only applied edits carry an outcome,
so this is precision of the auto-apply tier, not calibration across all scores. Treat a band with
fewer than 20 results as an anecdote, and change a threshold only from a reviewed miss list, never
from the report alone.
