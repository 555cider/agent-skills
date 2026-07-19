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

The verifier reacquires the target using its unique locator ladder, captures `after.png`, evaluates
the assertions, and records `verification.json`. Also inspect the before/after screenshots for
subjective requests and run the narrowest relevant project check.

Never report completion unless the target was reacquired and verification passed. Continue fixing
when it fails. If the work must be abandoned, reverse only session-owned hunks and only when they do
not overlap newer user edits; never reset a whole dirty file.

Use `fix-result.schema.json` for the final internal record. Auto-apply requires trusted
authorization, locator `high` confidence, validated safe scope, no dirty-hunk overlap, and a
verification plan. Medium/low confidence returns diagnosis and candidates for review.
