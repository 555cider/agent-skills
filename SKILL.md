---
name: dom-picker
description: Use when the user wants to fix a visible UI issue in a running web app and points at, selects, or describes a specific on-screen element ("this button", "that spacing", "fix this element I picked"), and browser automation (Playwright/CDP/MCP) plus local repository access are available. Turns the selected element into a minimal, validated unified diff against the project source. Does NOT cover backend/logic changes, blind edits with no selected element, applying patches without validation, or injecting anything permanent into the project.
---

# DOM Picker

Turn a UI issue the user points at in a **running** web app into a **minimal, validated frontend
patch**. Select the element in a controlled browser, collect its DOM / computed style / screenshot
/ page metadata, search the local repo for the source responsible, rank candidates, read the best
ones, and emit a **unified diff**. The output is a diff, not a description — and a low-confidence
diff is never applied on its own.

This skill never modifies project source to install the picker. `assets/element-picker.js` is a
skill asset injected **transiently** into the browser the agent already controls. It is
self-contained and calls no other skill.

**Use the user's language** in all prompts and reports (Korean if they speak Korean, else English).

## Assumed host capabilities

The skill is engine-agnostic; it only needs a host that can do the following. Concrete primary
path in this environment shown in parentheses.

- Evaluate JS in the target page (Playwright MCP `browser_evaluate` / `browser_run_code_unsafe`; CDP `Runtime.evaluate`).
- Navigate and screenshot (`browser_navigate`, `browser_take_screenshot`).
- Search + read repo files (`Grep`, `Glob`, `Read`).
- Validate + apply a diff (`git apply --check` then `git apply`, or the host's patch tools).

If the browser or the repo is unreachable, say the work is **blocked** — do not guess a patch from
the screenshot alone.

## Hard Rules

- **Output is a validated unified diff.** Never hand back prose-only "you could change…". If you
  cannot produce a diff that passes an apply-check, return the diagnosis + ranked candidates and
  mark `canAutoApply: false`.
- **A selected element is required.** No element picked / described → ask for one. Do not patch
  from a vague "the page looks off".
- **Minimal change.** Touch only what fixes the selected issue. No drive-by refactors, no broad
  reformatting, no new dependencies unless the user explicitly asks.
- **Never modify** (see `references/safety-policy.md`): anything outside the repo root, `.env*`,
  `.git/`, `node_modules/`, build output (`dist/`, `build/`, `.next/`, `out/`), or lock files
  (unless the user explicitly requests a dependency change).
- **Never auto-apply** unless *all* hold: confidence is `high`, the diff passes validation, and the
  user explicitly approves. Otherwise return the diff for review with `canAutoApply: false`.

## Workflow

1. **Target page.** Use the page the user is on, or open it (`browser_navigate <url>`).
2. **Inject the picker.** Evaluate the contents of `assets/element-picker.js` in the page
   (`browser_evaluate`). It is idempotent — safe to inject more than once.
3. **Select the element(s).** The injected picker supports both models:
   - **Human picks in a visible browser** — click the launcher (bottom-right "요소 선택") to arm,
     hover to highlight, click to select; repeat via "＋ 더 선택" for multiple. Read the result from
     `window.__s2p.lastPick` (last) or `window.__s2p.picks` (all).
   - **Agent picks programmatically** — `window.__s2p.snapshot('<css-selector>')` for a known target
     (works headless); returns the same payload and appends to `window.__s2p.picks`.

   The picker also carries the **fix request**: the user can type the instruction in the panel's
   input and press 보내기 (⌘/Ctrl+Enter), which stashes `window.__s2p.request = { text, picks, seq }`.
   So both the selection and the "how to fix it" instruction can come from the browser — the host
   reads `request` (e.g. a CDP watcher) instead of requiring the user to retype it in the terminal.
4. **Collect context.** From the picker payload gather: `selector`, `tagName`, `id`, `className`,
   `text`, `outerHTML`, `parentHTML`, `rect`, curated `computedStyle`, `nearbyText`. Capture a
   `browser_take_screenshot`. Record page `url`, `title`, `viewport`.
5. **Build search queries** from the strongest signals (see `references/candidate-ranking.md`):
   exact visible text, `data-testid` / `aria-label` / `id` / `name`, unique className or Tailwind
   sequence, route segment.
6. **Find candidates** with `Grep`/`Glob`, honoring the include/exclude roots in the ranking policy.
7. **Rank candidates** by the policy's signal weights; keep a scored, reasoned shortlist.
8. **Read** the top candidates (`Read`) to locate the exact lines responsible.
9. **Generate the minimal patch** per `references/patch-policy.md` as a unified diff.
10. **Validate** the diff (`git apply --check`, or dry run). Fix and re-validate on failure.
11. **Return** the result in the shape of `references/output.schema.json` (see Report Format).
12. **Apply only on explicit approval**, and only when the Hard Rules allow it.

## Report Format

Return an object matching `references/output.schema.json`:

```text
summary:      <one line: what the fix does>
confidence:   low | medium | high
diagnosis:    <why the element looks wrong; which source construct causes it>
candidateFiles:
  - path: <file>  score: <0..1>  reason: <signals that matched>
changes:
  - file: <file>  reason: <why this file/edit>
    diff: |
      <unified diff>
warnings:     [ <risks, ambiguities, unverified assumptions> ]
canAutoApply: <true only if confidence high + validated + approved>
```

If confidence is `low`, fill `diagnosis` + `candidateFiles` and set `canAutoApply: false` rather
than forcing a shaky diff.

## Files

- `assets/element-picker.js` — transiently-injected DOM picker (idempotent; self-contained; every
  node tagged `data-s2p` so it never selects its own UI). On-screen: hover inspector chip,
  persistent selection highlights, a list panel, and a full-selector tooltip. API on `window.__s2p`:
  `snapshot(selectorOrEl)` → `PickedElement` (also appended to `picks`); `lastPick`; `picks[]`
  (multi-select); `enable({multi})` / `disable()` / `clear()`; and `request` — the browser→host
  bridge set by the panel's input + 보내기 button as `{ text, picks, seq }`. A leaf click
  (icon/text) auto-promotes to the nearest meaningful ancestor (button/link/`data-testid`/labelled).
- `references/candidate-ranking.md` — signal weights and include/exclude roots for finding the
  source file behind a selected element.
- `references/patch-policy.md` — minimal-diff rules and the unified-diff / validation contract.
- `references/safety-policy.md` — the never-modify list and auto-apply gating.
- `references/io-contract.md` — input/output contract prose; points to the two JSON schemas.
- `references/input.schema.json` — input contract.
- `references/output.schema.json` — output contract.
- `references/examples.md` — worked examples: input → diagnosis → ranked candidates → diff.
