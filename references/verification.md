# Fix and Verification Contract

Declare observable assertions before editing. Choose metrics already present in the pick evidence:

- computed style (`computedStyle.gap`, color, size, display, overflow);
- geometry and overflow (`rect.width`, `metrics.horizontalOverflow`, clipping);
- accessibility (`role`, `accessibleName`, state attributes);
- visible text or stable attributes.

Represent each assertion as `{ pickIndex, metric, operator, expected }`. Supported operators are
`==`, `!=`, `>`, `>=`, `<`, `<=`, `contains`, and `matches`. Numeric expectations parse CSS numeric
values such as `8px` before comparison.

After applying the minimal change, wait for HMR or reload and run:

```bash
node scripts/dom-picker.mjs verify --request=<request.json> --assertions=<assertions.json|->
```

The verifier does not equate “a selector still matches once” with target identity. Reacquisition
requires:

- the same tag name; and
- either a currently unique high-strength id, test id, or ARIA locator; or at least two independent
  corroborators, including a distinguishing stable attribute or name/text signal.

A positional `:nth-child`/`:nth-of-type` CSS path alone is insufficient, especially after siblings
move. Inspect `matchedLocator`, `identityEvidence`, and `reacquisitionConfidence` in the verifier
output. Only `currentPick` from an accepted identity match is eligible for assertions.

The verifier hides picker hosts across frames, captures clean `after.png` plus a 24px-padded
`after-pick-N.png` for each target, evaluates the assertions, and records `verification.json`.
Request capture similarly produces clean `before.png` and `before-pick-N.png`. Inspect both the full
screen and crops for subjective requests and run the narrowest relevant project check.

Never report completion unless the target was reacquired and verification passed. Continue fixing
when it fails. If the work must be abandoned, reverse only session-owned hunks and only when they do
not overlap newer user edits; never reset a whole dirty file.

Use `fix-result.schema.json` for the final internal record. Auto-apply requires trusted
authorization, locator `high` confidence, validated safe scope, no dirty-hunk overlap, and a
verification plan. Medium/low confidence returns diagnosis and candidates for review.

Before publishing `applied_verified`, re-check the request ledger. If cancellation arrived, follow
the rollback contract instead. `cancelled` is allowed only when no change remains or session-owned
hunks were completely and safely reversed. Otherwise use `review_required` or `blocked`.
