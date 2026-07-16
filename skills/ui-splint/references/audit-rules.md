# UI Splint — audit rules

The exact spec of every rule in `scripts/audit.js`. Each entry: what it measures, the
method, the threshold→severity mapping, confidence, and the false-positive guards.
Keep this in sync with `audit.js`. When you add a measurable failure mode, add the rule
to `audit.js` AND an entry here; taste-only modes go in `scrutiny-checklist.md` instead.

Global exemptions (applied by every rule via `isExempt`/`isVisible`): `display:none`,
`visibility:hidden`, `opacity<0.05`, `[aria-hidden=true]`, `[inert]`, `[hidden]`,
`[disabled]`/`[aria-disabled=true]`, and the sr-only/visually-hidden 1px-clip pattern.
`whitelist` selectors and `baseline` (rule+selector) entries are dropped from output.

---

## effectiveContrast — `Fail` — auto-measured
Text legibility vs the real rendered background.
- **Method:** TreeWalker over text nodes (skips emoji/symbol-only runs via `\p{L}\p{N}`).
  fg = computed `color`; bg resolved by walking ancestors and compositing translucent
  layers (src-over) until an opaque layer is reached (white fallback). WCAG relative
  luminance → ratio `(L1+.05)/(L2+.05)`.
- **Threshold:** `< 4.5:1` normal text, `< 3.0:1` large text (`≥24px`, or `≥18.66px` bold).
  Normal-size failures are `Fail`; large-text failures `Risk` unless `< 1.3:1` (washed-out) → `Fail`.
- **needs-visual fallback:** if any ancestor has a `background-image`/gradient or
  `backdrop-filter`, the bg is *indeterminate* → emit `Risk/needs-visual` (pixel-confirm)
  unless the ratio vs the resolved layer is already `< 1.3`.
- **FP guards:** emoji/symbol-only text skipped; disabled/aria-hidden exempt; brand fixes
  cited for known social buttons (Kakao `#191919/#FEE500`, Naver `#FFFFFF/#03C75A`).

## placeholderContrast — `Fail`(<3.0) / `Risk`(<4.5) — auto-measured
- **Method:** `getComputedStyle(input, '::placeholder').color` vs the input's effective bg.
- Placeholders are not labels; low-contrast placeholder text is at most `Risk`, `Fail` if `< 3.0`.

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

## tapTarget — `Fail`(<24px) / `Risk`(<44px, crowding) — auto-measured (mobile only)
- **Method:** interactive elements (button, role=button, input, select, textarea, a[href]
  non-inline, [onclick], role=tab/menuitem). Min dimension `< 24` → `Fail` (WCAG 2.5.8);
  `< 44` → `Risk`. Crowding: only for small targets (`min < 44`) NOT inside a
  `nav/[role=navigation]/[role=tablist]/[role=tabbar]` (edge-to-edge adjacency is intended
  there), nearest-neighbor edge gap `< 8px` → `Risk`.

## disabledLookingPrimary — `Risk` — visual-judgment
- **Method:** the primary submit (or largest enabled button) per form; flag if its fill
  `saturation < 0.25` AND fill-vs-page contrast `< 1.5:1` (pale, blends in → reads disabled).
  Ghost/outline buttons (fill alpha `< 0.1`) skipped.

## selectedStateAmbiguity — `Risk` — visual-judgment
Segmented/tab/radio groups where the wrong item looks active.
- **Method:** group = `[role=tablist]/[role=radiogroup]` or a flex/grid row of 2–4 sibling
  buttons (NOT inside `nav`). prominence = `contrast(itemFill, groupBg)`. **Inversion:** an
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

## layoutShiftCLS — `Fail`(>0.25) / `Risk`(>0.1) — auto-measured
- **Method:** reads a CLS accumulator populated by a `layout-shift` PerformanceObserver. The
  observer must be installed **before navigation** — `__uiSplintInstallCLS()` (the runner does
  this via `add_init_script`). If not installed, emits a `needs-visual` note instead of a number.

## designSystemDrift — `Polish` — visual-judgment
- **Method:** histograms over visible elements: distinct `border-radius` (`>4`), `box-shadow`
  (`>4`), saturated accent hues in 30° buckets used ≥2× (`>6`), font-size/weight pairs (`>10`).
  Tolerance-gated and capped; never escalates above `Polish` on its own. Exclude data-viz/code.

## loneNarrowElement — `Polish` — auto-measured
- **Method:** checks if any button, input, select, badge, chip, tag or narrow content element with rendered width `< loneNarrowWidth` (default `180px`) occupies a whole row by itself (i.e. no other visible non-ancestor, non-descendant element overlaps it vertically).
- **Threshold:** width `< 180px` (or configured value).
- **FP guards:** ignores inline text links, hidden/exempt elements, and elements that share a row with other elements (e.g. sidebars sharing row with main content).

## excessiveButtonsInRow — `Polish` — auto-measured
- **Method:** finds all visible button-like elements, groups them into rows based on vertical overlap (sharing at least 50% height or 10px vertically), and flags any row containing more than `maxButtonsInRow` (default `4`).
- **Threshold:** count `> 4` (or configured value).
- **FP guards:** ignores hidden/exempt elements; groups using vertical bounding rect intersection to prevent false groupings.

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

## inconsistentSiblingsSpacing — `Polish` — auto-measured
- **Method:** Groups sibling elements by tag name and classes under a parent (minimum 3 items). Compares computed horizontal margins/paddings.
- **Threshold:** padding/margin differs among sibling elements of the same type.
- **FP guards:** ignores hidden/exempt elements.

## textLineHeightOverlap — `Risk` — auto-measured
- **Method:** Scans text-containing elements to check if computed `line-height` is smaller than computed `font-size * 0.95`.
- **Threshold:** computed `lineHeight < fontSize * 0.95`.
- **FP guards:** ignores elements with `lineHeight === 'normal'`; ignores hidden/exempt elements.

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

## missingClickableCursor — `Polish` — auto-measured
- **Method:** Finds visible interactive elements (`button`, `a[href]`, `[role=button]`, `[onclick]`, checkboxes/radios, submit inputs). Checks if their computed style has `cursor: pointer`.
- **Threshold:** clickable element lacks `cursor: pointer`.
- **FP guards:** ignores hidden/exempt elements.

## missingModalBackdrop — `Risk` — auto-measured
- **Method:** Detects open modals (`[role=dialog]`, `[aria-modal=true]`) that lack a full-screen, semi-transparent z-index backdrop overlay to obscure background content.
- **Threshold:** presence of open modal without a fixed/absolute full-screen overlay behind it. A backdrop candidate must cover at least 90% of the viewport, have semi-transparent background/opacity, and sit below the modal by z-index (or same z-index but earlier DOM order).
- **FP guards:** ignores closed or invisible modals.
