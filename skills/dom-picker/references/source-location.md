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
