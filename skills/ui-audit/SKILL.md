---
name: ui-audit
description: Use when building, editing, reviewing, or finishing frontend UI, web pages, components, or screenshots. Run it for visual QA, responsive or zoom/reflow checks, contrast and overflow defects, keyboard focus/focus-ring review, target sizing, modal containment, hover affordance, or any claim that a rendered screen is done. It measures the live DOM first and separates confirmed defects from visual-review advisories.
license: MIT
compatibility: Requires Node.js 22 or newer and an installed Chrome/Chromium browser with rendered DOM access.
---

# UI Audit

Catch frontend defects that look plausible in source but fail in the rendered screen. Measure the live DOM first; reserve visual judgment for signals that CSSOM and geometry cannot settle reliably.

Use the user's language in reports. Group results by failure mode, not discovery order.

## Hard rules

- Run `scripts/audit-chrome.mjs` before judging a rendered UI. A screenshot alone cannot prove contrast, clipping, focus traversal, target spacing, or sticky overlap.
- Do not claim completion or “no findings” unless every configured matrix cell is `checked` in `coverage.json`.
- Treat `findings.json` as measured defects. Do not downgrade a computed `Fail` by taste.
- Resolve every `required` item in `advisories.json` with a screenshot/pixel check, a corrected implementation, or a deliberate baseline entry. Optional advisories do not block completion.
- Use the trusted keyboard and pointer probes supplied by the runner. Synthetic DOM events do not prove sequential focus or `:hover` behavior.
- A review-only request authorizes reporting; a build/edit/finish request authorizes safe fixes to in-scope defects.

## Workflow

1. Render the real route, story, or preview. Configure mobile and desktop viewports, supported themes, meaningful data states, and interaction states.
2. Run the canonical Node/CDP runner:

   ```bash
   node scripts/audit-chrome.mjs http://localhost:3000 --config audit-config.json
   ```

   `run-ui-audit.py` and `capture.py` are compatibility shims that forward to this implementation. They do not require Playwright.
3. Inspect all three schema-v2 outputs:

   - `findings.json`: high-confidence measured defects.
   - `advisories.json`: `required` or `optional` review signals.
   - `coverage.json`: exact matrix, state proof, probe counts, rule coverage, suppression, and timings.
4. Resolve Fail findings and required advisories. Apply `baseline` only to an intentionally accepted `rule + selector`; do not use it to hide unverified coverage.
5. Apply `references/scrutiny-checklist.md` to composition, thumbnail/squint hierarchy, purposeful color, typography, microcopy, brand coherence, and other subjective residue.
6. Report the verified matrix, findings, advisories, and any unverified cells.

## Matrix and deterministic state setup

Copy `scripts/audit-config.default.json` and narrow it to the surface under review. The bundled full configuration includes two workers plus desktop `zoom-200` and `reflow-320` adaptations.

```jsonc
{
  "routes": ["/", "/settings"],
  "viewports": [
    { "name": "mobile", "width": 390, "height": 844, "isMobile": true, "dpr": 3 },
    { "name": "desktop", "width": 1280, "height": 900, "isMobile": false, "dpr": 1 }
  ],
  "themes": ["light", "dark"],
  "states": ["default", "empty", "error", "loading"],
  "adaptations": ["zoom-200", "reflow-320"],
  "workers": 2,
  "stateMocks": {
    "empty": [{ "pattern": "**/api/items", "body": [] }],
    "error": [{ "pattern": "**/api/items", "status": 500, "body": { "error": "forced" } }],
    "loading": [{ "pattern": "**/api/items", "hold": true }]
  },
  "stateSetups": {
    "dialog-open": {
      "actions": [{ "type": "click", "selector": "#open-dialog" }],
      "expect": [{ "selector": "[role=dialog][aria-modal=true]", "state": "visible" }]
    }
  }
}
```

Configured or fallback mocks count as coverage only when CDP Fetch actually intercepts a request. An unmatched mock produces `not-forced`. If an explicit network mock and structured setup are both configured, both must succeed.

Structured actions support `click`, `fill`, `press`, `hover`, `check`, and `selectOption`; every action selector must match exactly one element. Use `themeInitScripts` for class/data-attribute themes.

A populated fixture proves only that data reached the DOM. It does not prove a decision or action state that sits below the fold in an independently scrolling pane. Document `top`/`bottom` positions scroll the document, not nested scroll containers. For those surfaces:

- drive the real primary product action through `stateSetups`;
- require a visible post-action expectation inside the target state;
- inspect the post-action screenshots as well as setup proof; and
- leave the cell unverified when no deterministic product action can reach the state instead of using arbitrary page JavaScript or DOM presence as proof.

## Adaptability and exemptions

- `zoom-200` halves the desktop CSS viewport and doubles its scale, then reruns layout, target, and keyboard checks.
- `reflow-320` uses a 320 CSS-px desktop viewport and fails page-level horizontal scrolling. An intentionally two-dimensional surface must scroll internally or use `data-ui-audit-reflow-exempt="true"` with a documented reason.
- Target size is checked in every pointer-capable layout. A target below 24×24 CSS px fails only when the WCAG spacing exception also fails. Inline text links are exempt; essential/equivalent cases may use `data-ui-audit-target-exempt="true"` or a whitelist entry.
- The 24–44px mobile comfort range is an optional advisory, not a conformance failure.

## Output and completion gate

Each signal retains `rule`, `severity`, `confidence`, `category`, selector, measurement, threshold, rect, fix, cell evidence, and instance count. Findings may be `Fail` or `Risk`; advisories add `review: required | optional`.

The runner exits non-zero when:

- any matrix cell is not `checked`;
- any rule was skipped or trusted probe was incomplete;
- an un-baselined `Fail` remains; or
- a `required` advisory remains unresolved.

`coverage.json` is always written, including on navigation, mock, setup, or rule failure.

## Report format

```text
UI review: <blocked | fixes recommended | no findings>
Coverage: routes <…> · viewports <…> · themes <…> · states <…> · adaptations <…>
Audit: schema v2 · <N> checked / <N> total cells

Findings:
- [Fail · auto-measured] <area>: <problem>. Measured: <value vs threshold>. Selector: <…>. Cell: <…>. Fix: <…>.

Required review:
- [Risk · needs-visual] <area>: <candidate>. Evidence: <…>. Resolution: <pixel check/fix/baseline>.

Optional advisories:
- [Polish] <area>: <heuristic signal>. Evidence: <…>.

Not verified: <cells/rules, or none>
```

“No findings” is valid only when findings are empty, required advisories are resolved, every cell is checked, and the subjective checklist was reviewed.

## Files

- `scripts/audit.js`: DOM/CSSOM/geometry detector and finding/advisory classifier.
- `scripts/keyboard-probe.js`, `pointer-probe.js`: trusted-input planning and evidence helpers.
- `scripts/audit-chrome.mjs`: canonical Node/CDP runner, network mocks, adaptations, concurrency, and v2 outputs.
- `references/audit-rules.md`: exact rules, thresholds, and false-positive guards.
- `references/findings-schema.md`: configuration and schema-v2 contract.
- `tests/fixtures/` and `tests/expected.json`: recall and precision regression corpus.

When adding a failure mode, put deterministic measurement in code and add `mustHit`/`mustNotHit` coverage. Put heuristics in the advisory channel with `mustAdvise`/`mustNotAdvise` coverage.

## Do not use for

- backend/API-only work with no rendered surface;
- terminal output, native mobile, or non-DOM canvas contents; or
- replacement for functional interaction tests.

## Common mistakes

- Treating an installed mock as proof when its interception count is zero.
- Running only the normal desktop cell and skipping 200% zoom or 320px reflow.
- Treating optional advisory volume as confirmed defects.
- Treating a typography recommendation such as 1.5 body line-height or one sans-serif family as a WCAG failure.
- Suppressing broad selectors before investigating a shared-component root cause.
- Claiming a modal trap from DOM structure without trusted forward and reverse Tab input.
- Evaluating `audit.js` after navigation and assuming CLS was measured; install `__uiAuditInstallCLS()` on the new document as the runner does.
- Treating document top/bottom coverage or a populated DOM fixture as proof that a nested-scroll decision state was reached.
