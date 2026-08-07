# UI Audit — audit rules

The exact spec of every rule in `scripts/audit.js`. Each entry: what it measures, the
method, the threshold→severity mapping, confidence, and the false-positive guards.
Keep this in sync with `audit.js`. When you add a measurable failure mode, add the rule
to `audit.js` AND an entry here; taste-only modes go in `scrutiny-checklist.md` instead.

Common exemptions (applied by rules through `isExempt`/`isVisible` as appropriate): `display:none`,
`visibility:hidden`, `opacity<0.05`, `[aria-hidden=true]`, `[inert]`, `[hidden]`,
`[disabled]`/`[aria-disabled=true]`, and the sr-only/visually-hidden 1px-clip pattern.
`whitelist` selectors and `baseline` (rule+selector) entries are dropped from output.

Output policy is independent from severity: high-confidence measurements go to
`findings.json`; `needs-visual`/`visual-judgment` Risk signals become required
advisories; every Polish signal becomes an optional advisory. Suppression runs before
caps, and optional advisory caps are distributed round-robin across rules.

---

## effectiveContrast — `Fail` — auto-measured
Text legibility vs the real rendered background.
- **Method:** TreeWalker over text nodes (skips emoji/symbol-only runs via `\p{L}\p{N}`).
  fg = computed `color`; bg resolved by walking ancestors and compositing translucent
  layers (src-over) until an opaque layer is reached (white fallback). WCAG relative
  luminance uses the current sRGB cutoff `0.04045`, then ratio `(L1+.05)/(L2+.05)`.
- **Threshold:** `< 4.5:1` normal text, `< 3.0:1` large text (`≥24px`, or `≥18.66px` bold).
  A determinate-background result below either applicable threshold is `Fail`.
- **needs-visual fallback:** a `background-image`/gradient or `backdrop-filter`, or
  element/ancestor opacity (`0.05`–`<1`), filter, blend mode, inset box-shadow, or mask makes the final
  paint chain *indeterminate* → emit `Risk/needs-visual` for required pixel
  confirmation rather than claiming a composited ratio CSSOM cannot prove.
- **FP guards:** emoji/symbol-only text skipped; disabled/aria-hidden exempt; brand fixes
  cited for known social buttons (Kakao `#191919/#FEE500`, Naver `#FFFFFF/#03C75A`).

## placeholderContrast — `Fail` / required advisory
- **Method:** inspect only a non-empty placeholder while the control matches
  `:placeholder-shown`, then read `getComputedStyle(input, '::placeholder')` color,
  opacity, size, and weight vs the input's effective background. Multiply the parsed
  color alpha by the clamped computed pseudo-element opacity before src-over compositing.
- **Threshold:** `<4.5:1` for normal placeholder text; `<3.0:1` when it is large
  (`≥24px`, or `≥18.66px` bold). A determinate result below the applicable threshold
  is `Fail`. Placeholders are still not a substitute for labels.
- **needs-visual fallback:** gradient/image/backdrop-filter backgrounds and
  element/ancestor filter, opacity, blend, inset box-shadow, or mask paint chains remain
  `Risk/needs-visual` required review instead of an invented pixel ratio. The
  placeholder pseudo-element's own simple opacity is measured, not deferred.
- **FP guards:** populated controls, empty placeholder attributes, and control types
  that do not currently render placeholder text are skipped; an outer box-shadow does
  not make the interior text backdrop indeterminate.

## nonTextContrast — `Fail` / required advisory — measured candidate
Required control boundaries and icon-only control graphics (WCAG 1.4.11).
- **Form controls:** inspect visible text fields, textareas, selects, and custom
  `appearance:none` checkboxes/radios. Compare every non-zero solid border, outline,
  and fill against the adjacent rendered background. At least one required cue must
  reach `3:1`; compare the unrounded ratio and round only report evidence.
- **Icon-only controls:** when a button/link has no visible letter or number, compare
  its symbol or SVG fill/stroke paints with the immediate control surface. A single
  solid paint below `3:1` is an auto-measured `Fail`.
- **Review fallback:** gradients, images, filters, border images, shadows, indeterminate
  backgrounds, or multiple icon paints with a low-contrast part become
  `Risk/needs-visual`, not an invented failure.
- **FP guards:** disabled/inactive controls and browser-painted native checkboxes/radios
  are exempt. Labeled controls skip icon testing because the icon is not the only
  visible identifier.

## inlineLinkAffordance — `Fail` / required advisory
Prose links that have no persistent non-color cue.
- **Method:** inspect inline anchors inside paragraphs, list items, descriptions,
  blockquotes, and captions only when surrounding non-link text exists. Underlines,
  visible borders/backgrounds/icons, or a font weight/style difference are persistent
  cues and pass.
- **Color-only failure:** if link and surrounding text colors differ by `<3:1`, emit
  `Fail/auto-measured` with WCAG 1.4.1 evidence.
- **Required review:** a color-only link at `≥3:1` must prove a non-color cue on hover
  and keyboard focus. A link that looks identical to prose is a usability
  `Risk/visual-judgment`, not mislabeled as a color-use conformance failure.
- **FP guards:** exclude navigation, menus, toolbars, tablists, button-like ancestors,
  and headings.

## horizontalOverflow — `Fail` — auto-measured
- **Method:** `documentElement.scrollWidth > clientWidth + tol`. Offenders = visible
  elements whose `rect.right > viewport + tol` and that are not inside an `overflow-x:auto/scroll`
  carousel. Reports the widest offenders with overflow px.

## offViewport — `Risk` — auto-measured
- **Method:** visible element whose box is entirely left/right of the viewport
  (`rect.left ≥ vw` or `rect.right ≤ 0`). Excludes `position:fixed` and carousel-track children.
- Catches content accidentally pushed off-screen (vs. intentionally `display:none`).

## stickyOverlapContent — `Fail` — auto-measured
Fixed/sticky chrome covering content. This is the class `full_page` screenshots hide.
- **Method:** for each `position:fixed|sticky` bar (excluding `role=dialog/tooltip/menu`,
  `aria-modal`), intersect its rect with each content text element's rect; at the
  intersection center, `document.elementFromPoint` — if it returns the bar (or a
  descendant), the content is occluded. **Run at scroll-bottom**; overlaps only appear there.

## ancestorCollapse — `Fail` — auto-measured
Content present in the DOM but rendered box collapsed to ~0 (broken flex/height chain).
- **Method:** element with content whose `rect.height ≤ collapsePx` (or width) while
  `scrollHeight` exceeds it; confirms children want more room; walks ancestors to name the
  first node whose `clientHeight ≈ 0` while its parent is large (the break point).
- Common cause: a flex/grid child or routed view missing `min-height:0` / resolved height.

## textClip — `Fail` (clip/escape) / `Risk` (intentional truncation) — auto-measured
- **Method:** element whose `scrollWidth/Height > client + tol`. Two cases:
  (a) **escape** — `overflow:visible` on a control-like element (button/role=button/
  .btn/.chip/.badge or rounded+filled) → text spills out → `Fail`.
  (b) **clip** — `overflow:hidden/clip` hiding content → `Fail`, unless `text-overflow:ellipsis`
  (single-line) or `-webkit-line-clamp` is set → `Risk` (truncation; confirm content is reachable).

## invisibleContent — `Risk` — needs-visual
- **Method:** `visibility:hidden` or `opacity:0` element holding ≥8 chars of real text,
  not in an exempt/intentional container (`aria-hidden`, `inert`, `[hidden]`, `role=tabpanel/
  dialog/tooltip/menu/listbox`, closed `details`), with no real opacity transition/animation
  (NB: default computed `transition-property` is `all` with `0s` — duration must be `>0` to count
  as a fade-in). Reported once at the outermost hidden ancestor.

## targetSizeMinimum — `Fail` / optional `Polish` advisory — auto-measured
- **Method:** inspect interactive elements in every pointer-capable layout, not only mobile.
  A target whose minimum dimension is `<24px` passes when a 24px-diameter circle centered
  on it does not intersect another target or another sub-minimum target's circle (WCAG
  2.5.8 spacing exception); otherwise it is a `Fail`.
- **Comfort advisory:** a mobile target from 24px through 43px is an optional Polish
  advisory. It is not reported as a conformance failure.
- **FP guards:** inline text links and hidden/disabled controls are exempt. Use
  `data-ui-audit-target-exempt=true` only for documented equivalent/essential cases.

## disabledLookingPrimary — required advisory — visual-judgment
- **Method:** an enabled submit or explicitly primary-marked button; flag if its fill
  `saturation < 0.25` AND fill-vs-page contrast `< 1.5:1` (pale, blends in → reads disabled).
  Ghost/outline buttons are skipped, and arbitrary largest buttons are never assumed primary.

## selectedStateAmbiguity — `Risk` — visual-judgment
Segmented/tab/radio groups where the wrong item looks active.
- **Method:** group = `[role=tablist]/[role=radiogroup]` or an explicitly marked
  `[data-ui-audit-selection-group]`/`.seg`/`.segmented-control`/`.segment-control`.
  Arbitrary two-button flex rows are excluded because they are commonly CTA pairs.
  prominence = `contrast(itemFill, groupBg)`. **Inversion:** an
  unselected item's prominence `> 1.5` and `> 1.4×` the selected item's. **Ambiguous:** no
  programmatic selection (`aria-selected/current/checked`/active class) yet one item stands
  out (max prominence `> 1.6`).

## authModeNavConflict — `Risk` — visual-judgment
- **Method:** auth context (visible `input[type=password]`, route `/login|/signup|/auth`, or
  a mode selector with 로그인/회원가입/login/signup) co-present with a persistent app nav
  (`nav`/`role=navigation`/fixed bottom bar, ≥3 items). Strong flag when an `aria-current`/
  `.active` item points to an authenticated destination (`authedNavWords`: my/account/마이…);
  weaker flag otherwise to verify signed-out browsing is intended.

## brokenOrDistortedMedia — `Fail` (broken) / `Risk` (distortion) — auto-measured
- **Method:** `<img>` with `complete && naturalWidth===0` and a src → broken `Fail`.
  Rendered-vs-natural aspect ratio differs `> 5%` with `object-fit:fill/unset` → distortion `Risk`.
  Rendered CSS px × dpr `> 1.5× naturalWidth` → upscale-blur `Risk`.

## uninspectedSurface — required advisory — needs-visual
- **Method:** report every rendered, non-zero visible `iframe`, `canvas`, `object`,
  `embed`, and light-DOM host with an open `shadowRoot`.
- **Boundary:** the detector deliberately does not recurse into shadow roots, frames,
  or pixel-backed/plugin surfaces. A checked light-DOM rule manifest therefore cannot
  be presented as inspection of their contents.
- **Exemption:** only a non-empty `data-ui-audit-surface-exempt="<reason>"` on the exact
  surface suppresses this rule. An empty attribute does not. Global whitelist and
  rule+selector baseline suppression remain available and observable in coverage.
- **Resolution:** separately inspect the live rendered surface, including keyboard and
  accessible alternatives where applicable, or record why equivalent evidence exists.

## focusTrapLeak — `Risk` candidate / `Fail` after trusted input
- **Structural phase:** for the topmost visible `[role=dialog][aria-modal=true]` or
  `alertdialog`, focusable background controls produce only `Risk/visual-judgment`. Their
  existence cannot prove whether JavaScript prevents focus escape.
- **Keyboard phase:** the runners require initial focus inside the dialog, then focus the last
  and first tab stops and send trusted `Tab` and `Shift+Tab`. A `Fail/auto-measured` requires
  focus to escape or to wrap anywhere other than last→first and first→last.
- **FP guards:** inspect only the topmost modal; honor `whitelist` and `baseline`; record every
  visible modal in coverage while probing the active top layer.

## focusObscured — `Fail` — auto-measured
- **Method:** traverse the current document or modal tab sequence with trusted `Tab` input.
  Intersect each focused control with the viewport and sample its clipped box with
  `elementsFromPoint`. It fails only when no sampled point's top painted element is the
  control or its descendant, or the focused control is wholly outside the viewport.
- **Threshold:** fully obscured only. Partial visibility is not a failure.
- **Coverage guard:** `keyboardProbe.maxSteps` bounds traversal. Hitting the bound or leaving
  the document before all expected tab stops are visited marks the cell unverified.

## focusIndicatorMissing / focusIndicatorContrast — `Fail` — trusted auto-measurement
- **Method:** capture every tabbable element's resting fingerprint, reach it through trusted
  Tab input, then compare outline, border, shadow, background, and pseudo-element styles.
  Browser `outline:auto` and a visible text caret pass. No visible change is
  `focusIndicatorMissing` (WCAG 2.4.7).
- **Contrast:** a simple author outline/border is compared with the adjacent background;
  `<3:1` is `focusIndicatorContrast` (WCAG 1.4.11).
- **Review fallback:** gradients, shadows, and complex pseudo-element treatments emit
  `focusIndicatorReview` as a required `needs-visual` advisory instead of inventing a ratio.
- **Coverage guard:** the first programmatically positioned traversal target is not used for
  focus-visibility claims; subsequent targets require trusted keyboard input.

## layoutShiftCLS — `Fail`(>0.25) / `Risk`(>0.1) — auto-measured
- **Method:** reads a CLS accumulator populated by a `layout-shift` PerformanceObserver. The
  observer must be installed **before navigation** — `__uiAuditInstallCLS()` (the runner does
  this via `add_init_script`). If not installed, emits a `needs-visual` note instead of a number.

## designSystemDrift — optional advisory — visual-judgment
- **Method:** histograms over visible elements: distinct `border-radius` (`>4`), `box-shadow`
  (`>4`), saturated accent hues in 30° buckets used ≥2× (`>6`), font-size/weight pairs (`>10`).
  Tolerance-gated and capped; never escalates above `Polish` on its own. Exclude data-viz/code.

## loneNarrowElement — optional advisory — auto-measured
- **Method:** checks only top-level interactive controls inside a local semantic control
  group (`data-ui-audit-control-group`, form, role=group, toolbar, filters, controls). A
  narrow control must be alone on its row while an adjacent row contains at least two
  related controls.
- **Threshold:** width `< 180px` (or configured value).
- **FP guards:** ignores headings, labels, skip links, badges, text nodes, button descendants,
  unrelated page content, and `data-ui-audit-layout-exempt=true`.

## excessiveButtonsInRow — optional advisory — auto-measured
- **Method:** counts buttons within the same nearest local action container and rendered row.
- **Threshold:** count `> 4` (or configured value).
- **FP guards:** navigation, tablists, explicit valid control groups, and page-wide common
  ancestors are excluded.

## tinyText — `Polish` / `Risk` — auto-measured
- **Method:** TreeWalker scans visible text nodes. Checks computed `fontSize` of parent elements.
- **Threshold:** computed `fontSize < 11px` (configurable via `tinyTextPx`) is `Polish`; `< 9px` is `Risk` (extremely illegible).
- **FP guards:** skips hidden/exempt elements; ignores elements inside `pre`, `code`, `svg`, `math`, `script`, or `style`.

## unlabeledInput — `Risk` — auto-measured
- **Method:** Finds visible, non-exempt form controls (`input`, `select`, `textarea`). Flags controls that lack a `<label>` wrapper, a `<label>` associated via `id`/`for`, or accessible labeling attributes (`aria-label`, `aria-labelledby`, `title`). Excludes non-labeled input types like `hidden`, `submit`, `button`, `image`, `reset`.
- **Threshold:** presence of form control without accessible label/name.

## lineLength — `Polish` — auto-measured
- **Method:** Finds visible block-level text containers (`p`, `article`, `section`, `div`, `span`) with direct text content longer than `lineLenMax` (default `95` characters). Checks if the inner rendered width exceeds the readable limit (`lineLenMax * fontSize * 0.45`).
- **Threshold:** text length `> 95` characters and inner width `> maxLinePixels`.
- **FP guards:** ignores hidden/exempt elements; ignores elements inside formatting/interactive scopes like code blocks, nav, tables, forms, or buttons.

## controlGroupSpacing — `Polish` — auto-measured
- **Method:** inspects multi-row forms and search/toolbar/navigation/pagination control groups with a visible surface (border, radius, or distinct background). It groups controls and direct metadata text by rendered row, then measures every row's left/right inset from the group boundary.
- **Threshold:** any row inset `< 8px`, or left/right inset spread across rows `> 12px` (configurable through `layout.controlGroupMinInset` and `layout.controlGroupRowInsetDelta`).
- **FP guards:** requires at least two active controls and two rendered rows; skips tab/menu groups plus explicit `[data-ui-audit-edge-to-edge=true]` and `[data-ui-audit-layout-exempt=true]` patterns.

## orphanedControlRow — `Polish` — auto-measured
- **Method:** within the same semantic multi-row control group, finds a row containing one narrow interactive control when an adjacent row contains at least two related controls.
- **Threshold:** lone control width `≤ 180px` and `≤ 25%` of group width (configurable through `layout.orphanControlMaxWidth` and `layout.orphanControlMaxRatio`).
- **FP guards:** metadata such as result counts does not count as an interactive peer; explicit `[data-ui-audit-stacked=true]` groups are skipped.

## inconsistentSiblingsSpacing — `Polish` — auto-measured
- **Method:** Groups sibling elements by tag name and classes under a parent (minimum 3 items). Compares computed horizontal margins/paddings.
- **Threshold:** padding/margin differs among sibling elements of the same type.
- **FP guards:** ignores hidden/exempt elements.

## textLineHeightOverlap — `Risk` — auto-measured
- **Method:** Scans text-containing elements to check if computed `line-height` is smaller than computed `font-size * 0.95`.
- **Threshold:** computed `lineHeight < fontSize * 0.95`.
- **FP guards:** ignores elements with `lineHeight === 'normal'`; ignores hidden/exempt elements.

## bodyTextAlignment — optional advisory — auto-measured
- **Method:** inspect prose elements with at least `40` letters/numbers and `3`
  rendered line boxes. Centered or justified long-form text emits `Polish`.
- **FP guards:** short centered copy, headings, navigation, forms, tables, and code
  are excluded. Recommend logical-start alignment rather than assuming every
  writing system reads left-to-right.

## bodyTextLineHeight — optional advisory — auto-measured
- **Method:** on the same long-form candidates, calculate explicit computed
  `line-height / font-size`.
- **Threshold:** ratios from `0.95` through `<1.5` emit `Polish`. Ratios `<0.95`
  remain the stronger `textLineHeightOverlap` Risk; `normal` is skipped because
  CSSOM does not expose a reliable numeric used value.
- This is readability guidance, not a WCAG AA failure. WCAG text-spacing
  conformance requires content to survive user overrides, not every authored
  paragraph to start at `1.5`.

## emptyInteractiveTarget — `Fail` — auto-measured
- **Method:** Finds visible interactive elements (`button`, `a`, `[role=button]`) with zero text content, no visible child images/SVGs, and no accessible name (`aria-label`, `title`).
- **Threshold:** presence of empty, unlabeled interactive control.
- **FP guards:** ignores hidden/exempt elements.

## misalignedRowItems — `Polish` — auto-measured
- **Method:** Finds horizontally adjacent siblings with similar heights. Compares vertical center values.
- **Threshold:** vertical centers differ by `1.5px` to `6px`.
- **FP guards:** ignores elements with height difference `> 5px`; ignores non-adjacent elements.

## accidentalFlexWrap — `Polish` — auto-measured
- **Method:** Detects flex containers with `flex-wrap: wrap` where a single item wraps onto its own row.
- **Threshold:** last row has exactly `1` item while the previous row has `≥ 3` items.
- **FP guards:** ignores containers with `< 4` visible items.

## nonScrollableOverflow — `Risk` — auto-measured
- **Method:** Detects containers with overflowing content (`scrollHeight > clientHeight + 4px`) but scrolling is disabled (`overflow-y: hidden|clip`).
- **Threshold:** overflowing content present with scrolling disabled.
- **FP guards:** ignores elements with `webkitLineClamp` or single-line text ellipsis; ignores `html`, `body`, and `iframe`.

## inconsistentBorderRadius — `Polish` — auto-measured
- **Method:** Groups sibling elements under a parent. Compares computed `border-radius` values.
- **Threshold:** different `border-radius` values among similar sibling elements.
- **FP guards:** ignores hidden/exempt elements.

## excessiveFirstViewportSpacing — `Polish` — auto-measured
- **Method:** Measures the vertical position of the first visible content element.
- **Threshold:** first visible content element is pushed down past `200px` from the top of the viewport.
- **FP guards:** ignores viewport heights `< 400px`; ignores absolute/fixed elements.

## buttonSelfHeightMismatch — `Polish` — auto-measured
- **Method:** Compares rendered heights of horizontally adjacent button-like siblings.
- **Threshold:** adjacent buttons have heights differing by `> 2px`.
- **FP guards:** ignores non-adjacent buttons or buttons not sharing a row.

## stretchedIconDistortion — `Risk` — auto-measured
- **Method:** Finds visible SVG elements with a `viewBox` and compares their rendered aspect ratio with the natural aspect ratio defined in the viewBox.
- **Threshold:** rendered aspect ratio differs from natural aspect ratio by `> 5%`.
- **FP guards:** ignores icons smaller than `5px` in width/height.

## missingClickableCursor — optional advisory — auto-measured
- **Method:** checks custom non-native `[role=button]`, `[role=link]`, and `[onclick]`
  elements. Native buttons, links, checkboxes, radios, and inputs do not require
  `cursor:pointer` and are excluded.
- **Threshold:** clickable element lacks `cursor: pointer`.
- **FP guards:** ignores hidden/exempt elements.

## zoom-200 / reflow-320 — adaptation matrix checks
- `zoom-200` halves the selected desktop CSS viewport and doubles its device scale, then
  reruns document/layout/keyboard rules to catch 200% text loss and clipping.
- `reflow-320` uses a 320 CSS-px desktop viewport. Page-level horizontal overflow fails;
  internally scrollable data surfaces pass. A documented essential two-dimensional surface
  may use `data-ui-audit-reflow-exempt=true`.
- Adaptations are cell dimensions recorded in coverage rather than detector rule names;
  every signal's `cell.adaptation` identifies the failing mode.

## missingHoverFeedback — required advisory — trusted-input heuristic
- **Method:** the CDP runner moves a trusted fine pointer onto each visible enabled button,
  link, menu/tab action, button-like input, `summary`, or click target. It compares rendered
  target/descendant/near-ancestor and pseudo-element styles; a tooltip also counts.
- **Threshold:** no change in color, background, border, shadow, outline, text decoration, opacity, filter, transform, or font weight after the configured settle/retry window. A cursor-only change does not count.
- **Aggregation:** report one Risk advisory per semantic form/search/toolbar/nav/menu/tab
  group, with every affected target selector as evidence. Standalone and merely adjacent
  controls are still probed for coverage but do not generate noisy advisories.
- **FP guards:** desktop fine-pointer cells only; ignores disabled, hidden, pointer-disabled,
  nested duplicate, whitelist, and baseline targets. `maxTargets` truncation or a probe
  error makes coverage incomplete instead of silently skipping targets.

## multiRowTabs — `Risk` — auto-measured
Wrapped tab strip. A standard widget promises a rule by its shape; a tab strip promises
parallel panels whose positions stay put.
- **Method:** for each `[role=tablist]`, bucket the visible `[role=tab]` rects by `rect.top`
  with a 4px tolerance. Two or more buckets is a wrapped strip. Selecting a back-row tab
  reshuffles the rows, so every other tab moves.
- **Threshold:** `rows > 1` with at least one row holding two or more tabs.
- **FP guards:** mobile cells and the `reflow-320` adaptation are exempt — wrapping is the
  correct answer on a narrow screen. `aria-orientation=vertical` and a one-tab-per-row stack
  (a vertical rail) are exempt. Fewer than three visible tabs is not reported.

## placeholderAsOnlyLabel — `Risk` — auto-measured
A field whose only visible naming text is its placeholder (WCAG 3.3.2).
- **Method:** inspect visible controls with a non-empty `placeholder`. Pass when a visible
  `<label>` wraps or references the control, or `aria-labelledby` resolves to a visible
  non-empty element. Otherwise report when the control still carries an accessible name
  (`aria-label`, `aria-labelledby`, `title`) — the placeholder is then the only label the
  eye ever gets, and it disappears at the first keystroke.
- **Threshold:** no visible label element + an accessible name present.
- **FP guards:** `type=search` and controls inside `[role=search]` are exempt (the
  magnifying-glass convention). Input types that render no placeholder are skipped.
  Mutually exclusive with `unlabeledInput`, which owns the case where nothing names the
  control at all. A visually-hidden label does not count as a visible label.

## modalEscapeUnhandled — `Fail` — trusted auto-measurement
Escape is the exit users try before reading anything.
- **Method:** runner probe, not an in-page rule. After every rule pass, screenshot, and
  other probe in the cell, focus the first tab stop inside the topmost visible
  `[aria-modal=true]` dialog, send trusted `Escape` via CDP, settle, and re-read the visible
  modal list. The dialog still being visible is a `Fail`.
- **Destructive by design:** the probe closes dialogs, so it runs last and nothing reads the
  post-Escape DOM as evidence. Cells are isolated browser contexts, so it cannot leak.
- **Exemption:** `data-ui-audit-escape-exempt="<reason>"` on the dialog itself. An empty
  attribute does not exempt it.
- **Coverage guard:** `coverage.matrix[].escapeProbe` records status, dialog count, and
  whether the dialog closed. A probe error marks the cell unverified rather than passing.

## stackedDialogs — `Risk` — auto-measured
- **Method:** count visible, non-exempt `[aria-modal=true]` dialogs (`role=dialog`,
  `role=alertdialog`, `<dialog open>`). Two or more is a signal reported once on the
  topmost, listing the others.
- **Threshold:** `dialogs ≥ 2`.
- **FP guards:** an outer dialog marked `inert` or `aria-hidden=true` is a correct handoff
  and does not count. Closed `<dialog>` elements and hidden dialogs are skipped.

## singleRadioInGroup — `Risk` — auto-measured
A circle promises "pick exactly one of these"; a group of one cannot be deselected.
- **Method:** group every `input[type=radio]` in the document — visible or not — by
  (form scope, `name`). A visible enabled radio whose group has exactly one member is a
  signal. An unnamed radio is its own group as far as the browser is concerned.
- **Threshold:** `groupSize === 1`.
- **FP guards:** a `[role=radiogroup]` ancestor holding more than one radio (a custom widget
  managing selection) is exempt. Hidden siblings still count toward group size, so a
  transient render is not reported.

## toggleInsideSubmitForm — `Risk` — auto-measured
A switch promises a light switch: it applies the moment it is flipped.
- **Method:** a visible `[role=switch]` inside a `form`/`[role=form]` that also contains a
  visible enabled submit control (`type === 'submit'` or `'image'`, so a bare `<button>`
  counts). The screen then contradicts itself about when the setting takes effect.
- **FP guards:** search forms, forms with no visible submit control, and
  `data-ui-audit-toggle-exempt` are skipped.

## orphanedFieldError — `Risk` — auto-measured
An error message is a one-sentence recovery plan; "something is wrong" is not one (WCAG 3.3.1).
- **Method:** a visible control with `aria-invalid="true"` and no error text of its own —
  no `aria-errormessage`/`aria-describedby` resolving to a visible non-empty element, and no
  visible `[role=alert]`/`.error`/`.field-error`/`.invalid-feedback`/`[data-ui-audit-error]`
  inside its nearest field wrapper.
- **Scope limit:** presence only. Whether the message sits *next to* the field is left to the
  scrutiny checklist — wrapper structures vary too much to measure the distance reliably.
- **FP guards:** hidden/disabled controls and `aria-invalid` absent or `false` are skipped.

## desktopHiddenNav — optional advisory — auto-measured
- **Method:** in a non-mobile, non-`reflow-320` cell with no visible
  `nav`/`[role=navigation]`/`[role=menubar]` carrying three or more visible links, look for a
  visible disclosure control whose `aria-controls` resolves to a hidden one of those
  containers, or — when such a hidden container exists — whose label/class matches a
  hamburger vocabulary (`hamburger`, `menu`, `nav-toggle`, `메뉴`, …) while not expanded.
  Either way the container must hold at least three links: a small utility popup is not
  top-level navigation. `[role=menu]` is deliberately excluded, because a closed dropdown
  sits on almost every page and would make the vocabulary match fire everywhere.
- **Threshold:** hidden top-level navigation on a pointer-capable desktop layout.
- **FP guards:** mobile cells and `reflow-320` are exempt — that is where the hamburger
  belongs. Any visible nav with three or more links suppresses it. Intent varies for app
  rails and canvas tools, so it never escalates above `Polish`; `data-ui-audit-nav-exempt`
  suppresses it explicitly.

## imageMissingAlt — `Fail` — auto-measured
An image with no alternative text (WCAG 1.1.1).
- **Method:** visible `img` and `input[type=image]` that do not carry an `alt` **attribute**
  at all, plus inline `svg[role=img]` with neither a non-empty `<title>` nor an
  `aria-label`/`aria-labelledby` resolving to visible text.
- **Threshold:** attribute absent, no accessible name, rendered box at least 2×2 px.
- **FP guards:** `alt=""` is an explicit declaration that the image carries no information
  and passes — a missing attribute and an empty one are different promises. `role=presentation`,
  `role=none`, `aria-hidden`, and the shared exemptions are skipped. CSS `background-image`
  is out of scope, because CSSOM cannot tell decoration from content there.

## skipLinkMissing — `Risk` — auto-measured
No way past repeated navigation (WCAG 2.4.1).
- **Method:** fires only when the page has **no visible `main`/`[role=main]` landmark** — that
  landmark is itself a bypass mechanism — and a visible `nav`/`[role=navigation]` carries three
  or more visible links. It then reads the first three tab stops in DOM order and looks for a
  same-document anchor (`a[href^="#"]`).
- **Two branches:** no such anchor → the bypass is missing; an anchor whose target id does not
  exist or is `display:none` → the bypass is broken and moves focus nowhere.
- **FP guards:** visibility is deliberately *not* required when searching for the skip link,
  because a skip link is normally hidden until focused. Negative `tabindex` and
  `input[type=hidden]` are excluded from the tab-stop scan.

## selectAutoSubmit — `Risk` — auto-measured
Changing a value executes the form (WCAG 3.2.2 On Input).
- **Method:** `select`, `input[type=radio]`, and `input[type=checkbox]` whose **inline**
  `onchange` attribute calls `submit(`, `.submit(`, or `.requestSubmit(`.
- **Scope limit:** a handler attached with `addEventListener` is invisible to the DOM pass and
  is **not** covered. Absence of this finding is not proof the surface never auto-submits;
  the behavior belongs to a functional interaction test.
- **FP guards:** `data-ui-audit-autosubmit-exempt` on the control suppresses a deliberate case.

## missingIndeterminateState — `Risk` — auto-measured
A select-all box reporting a selection the list does not have.
- **Method:** identify a master checkbox by `aria-controls` resolving to two or more
  checkboxes, by sitting in a `thead` of a table whose body rows hold checkboxes, or by a
  select-all/전체 선택 vocabulary match within its nearest form/table/fieldset/list/group scope.
  Fire when the scope is **partially** selected while the master is neither
  `indeterminate === true` nor `aria-checked="mixed"`.
- **Threshold:** `0 < checked < total`.
- **FP guards:** empty and complete selections are skipped, and a scope smaller than two
  checkboxes is not a select-all relationship.

## modalActionsOutOfView — `Fail` — auto-measured
Dialog actions the user cannot see when the dialog opens.
- **Method:** for the topmost visible `[aria-modal=true]` dialog, find each visible action
  control whose nearest scrolling ancestor **inside the dialog** (`overflow-y:auto|scroll` with
  `scrollHeight > clientHeight + 4`) currently clips it — the control's rect lies entirely below
  that scroller's bottom edge or above its top edge. Reported once per dialog.
- **FP guards:** a dialog with no internal scrolling, an action already on screen, and any
  action pinned with `position:sticky|fixed` between itself and the scroller all pass. Measured
  at the pristine rule pass, before the keyboard and Escape probes move focus.

## emptyDataCell — `Polish` — auto-measured
- **Method:** in a visible data table (has `th`, at least two body rows), a `td` with no text,
  no control, and no image. Reported once per table with the offending cell count and samples.
- **FP guards:** cells spanning columns, `[data-ui-audit-empty-ok]` subtrees, and layout tables
  without header cells are skipped. A blank cell cannot say whether the value is missing, zero,
  not applicable, or still loading, which is why the placeholder is the fix rather than the cell.

## numericColumnAlignment — `Polish` — auto-measured
- **Method:** per column of a data table with three or more uniform body rows, parse the visible
  cell values. When at least `80%` are quantitative the column's computed `text-align` must
  resolve to the end edge. Anchored on the header cell so two offending columns stay distinct.
- **Locale coverage:** the parser accepts all three common grouping conventions —
  `1,240,000.50` (en/ko/ja), `1.240.000,50` (de/es/it/pt), and `1 240 000,50`
  (fr/ru/sv/pl, including NBSP, narrow NBSP, thin space, and the Swiss apostrophe). Currency is
  matched with the Unicode `\p{Sc}` property, so every single-character sign counts, plus a list
  of letter-written codes (`USD`, `CHF`, `kr`, `zł`, `Kč`, …). The unit list carries Korean and
  English/SI suffixes symmetrically, so an English column is recognized on the same terms as a
  Korean one.
- **Threshold:** numeric ratio `≥ 0.8` and computed alignment of `left`/`start` in an LTR column.
- **FP guards:** columns containing any date- or time-shaped value are skipped, as are
  `center`-aligned columns, rows with column spans, and RTL columns whose `start` is already the
  end edge for digits.

## unlinkedContactInfo — `Polish` — auto-measured
- **Method:** TreeWalker over visible text nodes for email addresses and phone numbers. Reported
  once per containing element.
- **Phone shapes:** a union of the real international forms, not the Korean one alone — a `+`
  country code with any grouping, the NANP `555-123-4567` / `(555) 123-4567`, and a national
  trunk-`0` number with either grouped (`02-1234-5678`, `020 7946 0958`, `01 42 68 53 00`) or
  single-block (`030 12345678`, `010-12345678`) subscriber digits. Every match must then hold
  `7`–`15` digits, the E.164 range.
- **Email:** Unicode-aware (`\p{L}`/`\p{N}`), so internationalized addresses with non-ASCII local
  parts and IDN domains are recognized, not only ASCII ones. A bare `@handle` has no local part
  and a host without a dotted TLD does not match.
- **FP guards:** digit boundaries on both ends stop the pattern starting inside a longer run — a
  bank account number such as `1002-123-456789` otherwise contains a phone-shaped substring — and
  a trailing-colon guard stops an opening-hours `09:00` being absorbed as another group. ISO and
  European dates, grouped amounts, ISBNs, IPs, semver strings, US ZIP+4, and SSN-shaped `3-2-4`
  runs are all excluded by the shapes plus the digit-count filter.
- **FP guards:** any text already inside an `a[href]`, plus `pre`, `code`, `kbd`, `samp`,
  `textarea`, and `option` scopes, are excluded. Placeholder attributes are never scanned because
  they are not text nodes.

## popupExceedsViewport — `Risk` — auto-measured
- **Method:** a visible `[role=menu]`, `[role=listbox]`, `[popover]`, `.dropdown-menu`, or
  `[data-ui-audit-popup]` panel at least 40px tall whose box extends past the viewport edge while
  neither the panel nor an ancestor scrolls vertically.
- **Reachability guard:** a panel that moves with the document is still reachable while the page
  has scroll room left, so the finding requires either a `position:fixed` ancestor chain or a
  remaining page scroll distance smaller than the overshoot. This is what separates it from
  `nonScrollableOverflow`, which requires `overflow:hidden|clip`.

## navCurrentUnmarked — `Risk` — auto-measured
- **Method:** a visible `nav`/`[role=navigation]` with three or more visible links where exactly
  one link's `pathname` equals `location.pathname`, and no link in that nav carries
  `aria-current`, `aria-selected="true"`, or an active/current/selected class on itself or its
  list item.
- **FP guards:** navs inside `footer`/`[role=contentinfo]` are excluded; more than one matching
  link means the comparison is not conclusive. A purely visual highlight with no programmatic
  marker is still reported — the state has to reach assistive technology too.

## disabledTab — `Risk` — auto-measured
- **Method:** a visible `[role=tab]` matching `[disabled]` or `[aria-disabled=true]`.
- **Note:** the shared `isExempt` helper drops disabled controls by design, so this rule reads the
  disabled state directly. Here it is the finding, not a reason to skip.
- **FP guards:** tabs inside `aria-hidden`/`inert`/`hidden` subtrees are skipped.

## nestedTabs — `Polish` — auto-measured
- **Method:** a visible `[role=tablist]` inside a `[role=tabpanel]`.
- **Threshold:** presence. Two levels of one widget make it ambiguous which layer a click changes.

## flagAsLanguageIndicator — `Polish` — auto-measured
- **Method:** a control whose label, `aria-label`, `name`, `id`, or class matches a language
  vocabulary and that contains either a regional-indicator flag emoji pair or an `img`/`svg`/`use`
  whose `src`/`alt`/`href`/class matches `flag`/`국기`.
- **Vocabulary:** the defect is universal, so the vocabulary is too — `lang`/`language`/`locale`/
  `i18n` plus `langue`, `sprache`, `idioma`, `lingua`, `taal`, `språk`, `kieli`, `nyelv`, `język`,
  `jazyk`, `bahasa`, `ngôn`, `язык`, `мова`, `言語`, `语言`, `語言`, `언어`, `다국어`, `ภาษา`,
  `لغة`. An English-and-Korean list would only ever report English and Korean products.
  Word-boundary guards keep `landing`, `slang`, and `label` from matching.
- **Threshold:** presence of a flag cue in a language control. A flag names a country, not a
  language, so a shared language across countries leaves some readers without a flag of their own.

## accordionPanelScroll — `Polish` — auto-measured
- **Method:** an `[aria-expanded=true][aria-controls]` header whose referenced panel is visible,
  has `overflow-y:auto|scroll`, and overflows (`scrollHeight > clientHeight + 4`).
- **FP guards:** panels that are themselves dialogs, menus, or listboxes are excluded — a bounded
  scroller is correct there. A panel that grows to its content passes.

## missingModalBackdrop — `Risk` — auto-measured
- **Method:** Detects open modals (`[role=dialog]`, `[aria-modal=true]`) that lack a full-screen, semi-transparent z-index backdrop overlay to obscure background content.
- **Threshold:** presence of open modal without a fixed/absolute full-screen overlay behind it. A backdrop candidate must cover at least 90% of the viewport, have semi-transparent background/opacity, and sit below the modal by z-index (or same z-index but earlier DOM order).
- **FP guards:** ignores closed or invisible modals.
