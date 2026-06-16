---
name: ui-splint
description: Use when building, editing, reviewing, or finishing frontend UI, web pages, components, or screenshots — to catch rendered visual defects (contrast, layout, overlap, overflow, collapsed/clipped regions, state, data feedback, responsive, affordance, navigation mode) before claiming frontend work complete. Triggers on visual QA, "looks off/weird", alignment/spacing/contrast concerns, and any "is this screen done" check.
---

# UI Splint

Catch frontend defects that read fine in code but are wrong in the rendered screen.
The core principle: **measure, don't eyeball.** Most missable UI defects — contrast,
overflow, overlap, collapsed regions, tiny tap targets, layout shift — are exact,
computable properties of the live DOM. Eyeballing a downscaled screenshot is the
worst channel for them, so this skill runs a deterministic audit FIRST and reserves
human judgment for things only taste can settle.

Use the user's language in reports. Group findings by failure mode, not discovery order.

## Hard Rules

- **Run the audit before judging.** Inject `scripts/audit.js` into the rendered page
  and collect its measured findings before you form any opinion. Do not review from a
  screenshot alone — it cannot show a contrast ratio or a sub-pixel clip.
- **No completion/"looks good"/"no findings" claim** unless the audit ran across the
  recorded matrix (viewports × themes × states) and you can show the coverage ledger.
  "Looks good from the code" is never acceptable; if you cannot render, say the work is
  **blocked on visual verification**.
- **Severity is measured, not felt.** Take each finding's computed `severity`. Do not
  downgrade a measured `Fail` to taste. Auto-measured findings may be `Fail`;
  visual-judgment findings are capped at `Risk` until confirmed.
- **Report before fixing.** List findings with evidence and wait for approval, unless
  the user gave you a known list to fix.

## Detect-first-then-judge Workflow

1. **Render** the real UI (running app route, Storybook story, or preview). If none
   exists, create the narrowest way to render the screen. Cover the matrix: ≥1 mobile +
   1 desktop viewport, light **and** dark themes, and every data state the screen has
   (default, empty, error, loading, and stale/partial if remote-backed). Force states
   with mock fixtures when the UI cannot reach them; remove every mock before finishing.
2. **Detect.** Inject the audit and capture measured findings. `audit.js` is engine-agnostic
   — it runs anywhere you can evaluate JS in the page. Pick whichever path is available:
   - **Interactive (MCP):** navigate, then `browser_evaluate` (Playwright MCP) or
     `evaluate_script` (chrome-devtools MCP) the contents of `scripts/audit.js`, then
     call `window.__uiSplintAudit({route, theme, state, isMobile})`. Run it at scroll
     **top and bottom** of each long screen (sticky-bar overlaps only appear at bottom).
     For CLS, evaluate `audit.js` once before navigation so the observer installs early.
   - **Batch, zero dependencies (preferred):** `node scripts/audit-chrome.mjs <url> --config audit-config.json`
     — drives an installed Chrome/Chromium over the DevTools Protocol with Node's built-in
     WebSocket. No pip/npm install. Writes `.ui-splint/findings.json` + `coverage.json`,
     exits non-zero on any Fail. (Note: the bare `playwright`/Chrome CLI only takes
     screenshots — it cannot inject and measure, which is the whole point — so it is not enough.)
   - **Batch, Playwright (if already set up):** `python3 scripts/run-ui-splint.py <url> --config audit-config.json`
     (same outputs; needs `pip install playwright && playwright install chromium`).
3. **Resolve.** Any finding with `confidence: needs-visual` (text over a gradient/image,
   unmeasured CLS) must be confirmed by pixel-sampling a screenshot crop or installing
   the observer — never leave it unresolved or assert a number you didn't measure.
4. **Triage.** Apply `whitelist`/`baseline` from config; dedupe repeated-component
   findings to one root cause with an instance count; cap Polish volume.
5. **Judge.** NOW apply `references/scrutiny-checklist.md` — but only to what the audit
   cannot measure: page composition and scan path, density appropriateness, microcopy,
   icon/brand coherence, empty-vs-error tone. Tag these `visual-judgment`; cap at `Risk`.
6. **Report** using the template below. Every uncovered matrix cell or unrun rule
   surfaces as **Not verified** — silence is not coverage.

## Severity (computed from thresholds)

| Severity | Meaning | Examples (measured) |
|----------|---------|---------------------|
| `Fail` | Broken now in the rendered state | text contrast < 4.5:1 (3:1 large); horizontal overflow; content covered by a sticky bar; region collapsed to ~0 with content; text clipped/escaping; tap target < 24px; broken image; focus escapes an open modal; CLS > 0.25 |
| `Risk` | Will break with realistic data/state/locale/viewport, or near threshold | placeholder < 4.5:1; tap target < 44px; ambiguous empty-vs-error; auth-mode nav conflict; selected-state inversion; CLS > 0.1 |
| `Polish` | Functional but visibly unpolished | design-system drift (too many radii/shadows/accent hues); weak rhythm; wasted space |

Escalate when the issue hits a primary workflow, a repeated component, or a surface the
user asked you to finish. See `references/audit-rules.md` for each rule's exact method.

## Report Format

```text
UI review: <blocked | fixes recommended | no findings>
Coverage: routes <…> · viewports <mobile,desktop> · themes <light,dark> · states <default,empty,error,…>
Audit: ran (findings.json) | not run (BLOCKED)

Findings (grouped by failure mode):
<group, e.g. Contrast & legibility>
- [Fail · auto-measured] <area>: <problem>. Measured: <number vs threshold>. Selector: <sel>. Viewport/state: <…>. Fix: <fix>.

<group, e.g. Composition (judgment)>
- [Risk · visual-judgment] <area>: <problem>. Evidence: <what you saw>. Fix: <fix>.

Not verified: <matrix cells/states/rules not exercised>
Approval needed: <specific fix set or next action>
```

"No findings" is valid only when the audit ran and returned zero threshold violations
across the recorded matrix, and the subjective residue was judged.

## Files

- `scripts/audit.js` — the deterministic detector (source of truth). Pure DOM/CSSOM/geometry; engine-agnostic.
- `scripts/audit-chrome.mjs` — zero-dependency batch runner (drives installed Chrome via CDP / Node WebSocket).
- `scripts/run-ui-splint.py` — Playwright batch runner (same outputs; for envs that already use Playwright).
- `scripts/audit-config.default.json` — thresholds, matrix, whitelist/baseline.
- `references/audit-rules.md` — every audit rule: signal, method, threshold→severity, FP guards.
- `references/findings-schema.md` — the findings/coverage JSON contract.
- `references/scrutiny-checklist.md` — the judgment layer for the subjective residue only.
- `tests/fixtures/` + `tests/expected.json` — defect fixtures (+ a clean baseline) and the
  coverage spec: what each fixture must trigger. Point a runner at them to verify a change to `audit.js`.

When you find a new failure mode: if it is measurable, add a rule to `audit.js` (and
`audit-rules.md`); if it needs taste, add it to `scrutiny-checklist.md`. Keep detection
in code and taste in the checklist.
