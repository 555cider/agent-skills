# Patch Policy

The skill returns **unified diffs**, one per changed file, each carried in `changes[].diff`.

## Rules

- **Minimal.** Change only the lines that fix the selected issue. No refactoring of unrelated code.
- **No broad reformatting.** Preserve the file's existing indentation, quote style, and whitespace;
  do not let a formatter rewrite untouched lines.
- **No new dependencies** unless the user explicitly asks for a dependency change.
- **Explain multi-file edits.** When more than one file could hold the fix, state in each
  `changes[].reason` why that file was chosen (and why the others were not).
- **Low confidence → no forced diff.** If confidence is `low`, return `diagnosis` +
  `candidateFiles` and set `canAutoApply: false` rather than emitting a shaky patch.
- **Validate before proposing apply.** Every diff must pass an apply-check (`git apply --check`, or
  the host's dry-run) before it is offered. Re-generate and re-validate on failure.

## Diff format

- Standard unified diff with `---`/`+++` headers and `@@` hunks, paths relative to the repo root
  (e.g. `a/src/components/Button.tsx`). Include enough context lines (≥3) for a clean apply.
- One file per `changes[]` entry; split multi-file fixes into multiple entries.

## Applying

Apply without a second approval only when **all** safe-apply conditions hold (see
`safety-policy.md`): the request is authorized, confidence is `high`, the diff validated, and the
edit stays within the safe scope. Otherwise return the diff with `canAutoApply: false` and
`applyDecision.applied: false` for review.
