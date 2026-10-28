---
name: ui-audit
description: Use when asked for visual QA of a rendered web UI, or when finishing a component or screen that needs rendered verification. Not for a single selected-element fix (dom-picker), static source or content-only review, or backend work.
license: MIT
compatibility: Requires Node.js 22 or newer and an installed Chrome/Chromium browser with rendered DOM access.
---

# UI Audit

Catch frontend defects that look plausible in source but fail in the rendered screen. Measure the live DOM first; reserve visual judgment for signals that CSSOM and geometry cannot settle reliably.

This runs on two axes. **Rendering** asks whether the screen was drawn correctly — contrast, overflow, clipping, collapse, focus rings, target size, overlap, stability. **Widget contract** asks a different question: whether each standard control keeps the promise its own shape makes. A square says "pick any", a circle "pick exactly one", a toggle "this applies now", a tab strip "parallel panels whose positions stay put", a label "this text will still be here while you type". A screen can pass every pixel measurement and still lie about its own rules.

Use the user's language in reports. Group results by failure mode, not discovery order.

## Hard rules

- Run `scripts/audit-chrome.mjs` before judging a rendered UI. A screenshot alone cannot prove contrast, clipping, focus traversal, target spacing, or sticky overlap.
- Do not claim completion or “no findings” unless every configured matrix cell is `checked` in `coverage.json`.
- Treat `findings.json` as measured defects. Do not downgrade a computed `Fail` by taste.
- Resolve every `required` item in `advisories.json` with a screenshot/pixel check, a corrected implementation, or a deliberate baseline entry. Optional advisories do not block completion.
- Use the trusted keyboard and pointer probes supplied by the runner. Synthetic DOM events do not prove sequential focus or `:hover` behavior.
- A review-only request authorizes reporting; a build/edit/finish request authorizes safe fixes to in-scope defects.

## Scope before running

Choose the smallest matrix that proves the requested result. For a selected element
alone, use dom-picker's target verification; do not expand it into a page audit.
For a component, audit its real route/story and relevant interaction states and
viewports. For a whole-screen audit, cover supported viewports, themes, density,
and error/pending states that can change the result. Include the theme the user
actually works in (a large-text or field theme often breaks rows the default passes),
and the second language when labels are translated. Explicitly requested matrices
remain required. Unrelated routes or unsupported themes are not extra gates.

A change to shared chrome (navigation rail, header, page header, tab strip, drawer,
tokens) is not scoped by the route in view. Search the code for every surface that
renders it -- other app shells, an admin or settings shell, the mobile drawer that
re-hosts the same controls -- and put each of those routes in the matrix. Auditing the
one screen you were looking at misses the shell where the change breaks.

The runner measures the configured page, not an arbitrary CSS subtree. Report the
actual route and matrix inspected; a component-focused review must not claim the
whole application passed. Once a cell is in scope, keep the existing completeness
and evidence gates. Do not remove a failed cell merely to make the report green.

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
5. Apply `references/scrutiny-checklist.md` to composition, thumbnail/squint hierarchy, purposeful color, typography, microcopy, brand coherence, and other subjective residue. Judge composition on the full-height screenshot of the finished page, not a crop around the changed element: moving one block can strand a counter, collapse a grid, or make two cards touch elsewhere on the page.
6. Report the verified matrix, findings, advisories, and any unverified cells.

## Matrix and state proof

Copy `scripts/audit-config.default.json` and narrow it to the surface under review. The bundled full configuration includes two workers plus desktop `zoom-200` and `reflow-320` adaptations. Force data states with `stateMocks` (CDP Fetch interception; a mock counts only when it actually intercepts) and interaction states with `stateSetups` (structured `click`, `fill`, `press`, `hover`, `check`, `selectOption`, `upload` actions plus a visible `expect`). Configuration, authenticated routes, file-picker uploads, `timeoutMs`, and nested scroll containers are specified in `references/findings-schema.md` under "State setup and proof".

A populated fixture proves only that data reached the DOM:

- Data presence also does not prove data density. Include a credible high-density fixture (maximum item counts, longest localized strings, mixed or null values). Treat interaction reachability and content density as separate matrix requirements; prove both when the surface has both risks.
- A state below the fold in an independently scrolling pane needs the real product action, a visible post-action expectation, and a scroller you confirmed moved; document `top`/`bottom` positions scroll `window` only.
- The final response also does not prove asynchronous mutation feedback. Hold the exact mutation request, drive the real control, and require visible progress plus a single-flight control state; add a functional interaction test for request count when repeated activation could duplicate work.

Leave a cell unverified when no deterministic action can reach its state.

## Adaptations, exemptions, and rule cautions

`zoom-200` and `reflow-320` rerun layout, target, and keyboard checks at 200% zoom and a 320 CSS-px viewport. Exemption attributes (`data-ui-audit-*-exempt`), colour parsing, contrast scope, desktop-only widget rules, copy conventions, and the cautions for reading individual rules live in `references/audit-rules.md` under "Cross-rule notes"; read it before suppressing or disputing a finding.

## Output and completion gate

Each signal retains `rule`, `severity`, `confidence`, `category`, selector, measurement, threshold, rect, fix, cell evidence, and instance count. Findings may be `Fail` or `Risk`; advisories add `review: required | optional`.

The runner exits non-zero when:

- any matrix cell is not `checked`;
- any entry in `ruleCoverage[]` omits a required `rulesExpected`/`rulesRun`/`rulesSkipped` array, has an empty expected manifest, misses an expected rule in that exact scroll report, reports a skipped rule, or a trusted probe was incomplete;
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

- `scripts/audit-chrome.mjs`: canonical Node/CDP runner, network mocks, adaptations, concurrency, and v2 outputs.
- `scripts/chrome-cdp.mjs`: Chrome launch, process-tree cleanup, and CDP client, shared verbatim with dom-picker and screen-map.
- `scripts/audit.js`: DOM/CSSOM/geometry detector and finding/advisory classifier.
- `scripts/rule-coverage.mjs`: per-report rule-manifest completeness validator.
- `scripts/keyboard-probe.js`, `pointer-probe.js`: trusted-input planning and evidence helpers.
- `scripts/run-ui-audit.py`, `capture.py`: compatibility shims that forward to the Node runner.
- `scripts/audit-config.default.json`: full default matrix to copy and narrow.
- `references/audit-rules.md`: exact rules, thresholds, false-positive guards, exemptions, and per-rule cautions.
- `references/findings-schema.md`: configuration, state setup and proof, and the schema-v2 contract.
- `references/scrutiny-checklist.md`: subjective residue reviewed after the measured pass.
- `tests/fixtures/` and `tests/expected.json`: recall and precision regression corpus.

When adding a failure mode, put deterministic measurement in code and add `mustHit`/`mustNotHit` coverage. Put heuristics in the advisory channel with `mustAdvise`/`mustNotAdvise` coverage.

## Do not use for

- backend/API-only work with no rendered surface;
- terminal output, native mobile, or non-DOM canvas contents; or
- replacement for functional interaction tests.

## Common mistakes

- Treating an installed mock as proof when its interception count is zero, or one matched mock rule as proof for every declared endpoint while ignoring the request method/minimum count.
- Treating a zero-cell matrix, a custom theme without a driver, or a cell with zero reported rules as successful coverage.
- Running only the normal desktop cell and skipping 200% zoom or 320px reflow.
- Treating optional advisory volume as confirmed defects.
- Suppressing broad selectors before investigating a shared-component root cause.
- Treating document top/bottom coverage or a populated DOM fixture as proof that a nested-scroll decision state was reached.
