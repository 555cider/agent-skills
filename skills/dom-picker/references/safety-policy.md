# Safety Policy

## Never modify

- Any path **outside the repo root**.
- `.env*` and any secrets / credential files.
- `.git/`.
- `node_modules/`.
- Build output: `dist/`, `build/`, `.next/`, `out/`, `coverage/`.
- Lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, etc.) — **unless** the user
  explicitly requests a dependency change.

A candidate that resolves to one of these paths is discarded, not patched. If the only plausible
source lives under an excluded path (e.g. a generated bundle), say so in `warnings` and stop rather
than editing generated output.

## Never inject permanently

The element picker is injected **transiently** into the controlled browser via the host's JS-eval
tool. Do not add the picker (or any overlay/import) to project source, `index.html`, or a bundler
config.

## Auto-apply gating

Apply a patch automatically **only when all** of the following hold:

1. `confidence` is `high`.
2. The diff passed validation (apply-check / dry run).
3. The user explicitly approved applying it.

If any is missing, return the diff with `canAutoApply: false` and wait. When in doubt, do not apply.
