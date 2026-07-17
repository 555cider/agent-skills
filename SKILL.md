---
name: ui-audit
description: Use when building, editing, reviewing, or finishing frontend UI, web pages, components, or screenshots — to catch rendered visual and keyboard defects (contrast, layout, overlap, overflow, clipped regions, focus containment/obscuring, state, responsive behavior, affordance) before claiming frontend work complete. Triggers on visual QA, "looks off/weird", alignment/spacing/contrast concerns, modal or keyboard-focus review, and any "is this screen done" check.
license: MIT
compatibility: Requires rendered DOM access; use Node 22 or newer plus Chrome/Chromium, or Python 3 with Playwright.
---

# UI Audit

Catch frontend defects that read fine in code but are wrong in the rendered screen.
The core principle: **measure, don't eyeball.** Most missable UI defects — contrast,
overflow, overlap, collapsed regions, tiny tap targets, focus escape/obscuring, layout shift — are exact,
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
- **Use trusted input for keyboard claims.** DOM structure can identify a suspicious modal,
  but only real `Tab`/`Shift+Tab` input proves focus containment. Run the bundled keyboard
  probe through Playwright or CDP; an incomplete probe is unverified coverage.
- **Respect the request's authority.** A build/edit/finish request authorizes safe fixes to
  in-scope defects found by the audit. A review/audit-only request authorizes reporting only;
  list findings with evidence and wait before changing source.

## Detect-first-then-judge Workflow

1. **Render** the real UI (running app route, Storybook story, or preview). If none
   exists, create the narrowest way to render the screen. Cover the matrix: ≥1 mobile +
   1 desktop viewport (unless the surface is explicitly fixed-viewport), every supported
   theme, and every render state the screen has: data states (default, empty, error,
   loading, stale/partial) and interaction states (open modal/menu, expanded disclosure)
   that affect the task. Force data with mocks and interaction states with structured
   `stateSetups`; remove project-local mocks after finishing.
2. **Detect.** Inject the audit and capture measured findings. `audit.js` is engine-agnostic
   — it runs anywhere you can evaluate JS in the page. Pick whichever path is available:
   - **Interactive (MCP):** navigate, then `browser_evaluate` (Playwright MCP) or
     `evaluate_script` (chrome-devtools MCP) the contents of `scripts/audit.js`, then
     call `window.__uiAudit({route, theme, state, isMobile})`. Run it at scroll
     **top and bottom** of each long screen (sticky-bar overlaps only appear at bottom).
     CLS needs the observer installed *before* first paint: inject `audit.js` **and call
     `window.__uiAuditInstallCLS()`** via an init script that runs on the new document
     (`Page.addScriptToEvaluateOnNewDocument` / `add_init_script`) — a plain `evaluate`
     after navigation is too late and CLS will read "not measured". If your MCP can't run
     an init script, treat interactive CLS as unmeasured and rely on a batch runner for it.
   - **Batch, zero dependencies (preferred), Node ≥ 22:** `node scripts/audit-chrome.mjs <url> --config audit-config.json`
     — drives an installed Chrome/Chromium over the DevTools Protocol with Node's built-in
     WebSocket (requires **Node ≥ 22**; it exits 2 with a clear message on older Node). No
     pip/npm install. Writes `.ui-audit/findings.json` + `coverage.json`, exits non-zero on
     any Fail or unverified matrix cell. It supports structured click/fill/press/hover/check/
     select interaction setup, but **cannot mock network**, so it renders the default
     page for every state and records non-`default` cells as `not-forced` in coverage (honest:
     it did not verify them, and the runner exits non-zero).
     Use the Playwright runner to actually exercise empty/error/loading. (Note: the bare
     `playwright`/Chrome CLI only takes screenshots — it cannot inject and measure — so it is not enough.)
   - **Batch, Playwright (if already set up):** `python3 scripts/run-ui-audit.py <url> --config audit-config.json`
     — same `findings.json`/`coverage.json` shape, and additionally **forces data states**
     (mocks `**/api/**` for empty/error/loading), runs the same structured `stateSetups`,
     waits on `waitForSelector`/`document.fonts.ready`,
     using `stateMocks` (with backward-compatible empty/error/loading fallbacks). A non-default
     cell is `checked` only when a configured route actually intercepts a request; otherwise it
     is `not-forced` and blocks completion. Use `themeInitScripts` for apps driven by a class or
     data attribute instead of `prefers-color-scheme`. This is
     the runner to use when the matrix has non-`default` states.
     Needs `pip install playwright && playwright install chromium`.
   Both runners inject `scripts/keyboard-probe.js` and use trusted browser input once per
   matrix cell. They verify modal initial focus, forward/reverse boundary wrap, and whether
   keyboard-focused controls are fully hidden by the viewport or an author overlay.
3. **Resolve.** Any finding with `confidence: needs-visual` (text over a gradient/image,
   unmeasured CLS) must be confirmed by pixel-sampling a screenshot crop or installing
   the observer. A structural `focusTrapLeak` Risk must be resolved with the trusted
   keyboard probe, not by checking whether background controls merely exist.
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
| `Fail` | Broken now in the rendered state | text contrast < 4.5:1 (3:1 large); horizontal overflow; content covered by a sticky bar; region collapsed to ~0 with content; text clipped/escaping; tap target < 24px; broken image; trusted Tab escapes an open modal; focused control fully obscured; CLS > 0.25 |
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

- `scripts/audit.js` — the deterministic detector. Pure DOM/CSSOM/geometry; engine-agnostic.
- `scripts/keyboard-probe.js` — shared focus-order and paint-occlusion helpers; runners supply trusted key events.
- `scripts/audit-chrome.mjs` — zero-dependency batch runner (drives installed Chrome via CDP / Node WebSocket, **Node ≥ 22**). No network mocking: non-`default` states are recorded `not-forced`.
- `scripts/run-ui-audit.py` — Playwright batch runner (same JSON shape, **plus** explicit state mocking and theme init scripts; for envs that already use Playwright).
- `scripts/audit-config.default.json` — thresholds, matrix, whitelist/baseline.
- `references/audit-rules.md` — every audit rule: signal, method, threshold→severity, FP guards.
- `references/findings-schema.md` — the findings/coverage JSON contract.
- `references/scrutiny-checklist.md` — the judgment layer for the subjective residue only.
- `tests/fixtures/` + `tests/expected.json` — defect fixtures (+ a clean baseline) and the
  coverage spec: what each fixture must trigger. Point a runner at them to verify a change to `audit.js`.

When you find a new failure mode: if it is measurable, add a rule to `audit.js` (and
`audit-rules.md`); if it needs taste, add it to `scrutiny-checklist.md`. Keep detection
in code and taste in the checklist.

## When NOT to use

- Backend/logic/API-only changes with no rendered surface — there is nothing to measure.
- Terminal/CLI output, native mobile, or non-DOM canvases — the detector is DOM/CSSOM only.
- As a substitute for functional/interaction tests — it audits the rendered frame, not behavior.

## Common Mistakes

- **Trusting `not-forced` as coverage.** The zero-dependency runner labels non-`default`
  data states `not-forced` because it cannot mock network. That is *not* a verified cell,
  and it blocks the runner's completion gate — use the Playwright runner (or MCP with route
  mocks) to actually force empty/error/loading.
- **Claiming "no findings" from one cell.** "No findings" holds only across the recorded
  matrix (viewports × themes × states); a single default-desktop pass is not coverage.
- **`isMobile:true` with `dpr>1` in interactive mode.** CDP mobile emulation + a device
  pixel ratio distorts `innerHeight`/geometry and breaks the layout rules. The batch runners
  keep `mobile:false` and pass `isMobile` to the audit instead — do the same if you drive
  the audit by hand.
- **Downgrading a measured `Fail` to taste.** Severity is computed from thresholds; only
  `visual-judgment` findings are yours to weigh, and they are already capped at `Risk`.
- **Evaluating `audit.js` and expecting CLS.** That only defines the observer installer —
  you must call `__uiAuditInstallCLS()` via an init script before navigation (see step 2).
- **Calling outside focusables a proven trap leak.** `aria-modal` pages often leave background
  controls in the DOM while JavaScript correctly wraps focus. Require trusted forward and
  reverse boundary input before emitting `Fail`.
- **Using a non-default state label without proof.** Add a matching `stateMocks` rule or a
  `stateSetups.<state>` block whose expectations pass; a label by itself is not coverage.
