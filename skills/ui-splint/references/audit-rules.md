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

## focusTrapLeak — `Fail` — auto-measured
- **Method:** when a `[role=dialog]/[aria-modal=true]` is open and visible, enumerate focusable
  nodes outside it not `tabindex=-1`/`inert`/`aria-hidden`; any → leak. (Run with the modal open.)

## layoutShiftCLS — `Fail`(>0.25) / `Risk`(>0.1) — auto-measured
- **Method:** reads a CLS accumulator populated by a `layout-shift` PerformanceObserver. The
  observer must be installed **before navigation** — `__uiSplintInstallCLS()` (the runner does
  this via `add_init_script`). If not installed, emits a `needs-visual` note instead of a number.

## designSystemDrift — `Polish` — visual-judgment
- **Method:** histograms over visible elements: distinct `border-radius` (`>4`), `box-shadow`
  (`>4`), saturated accent hues in 30° buckets used ≥2× (`>6`), font-size/weight pairs (`>10`).
  Tolerance-gated and capped; never escalates above `Polish` on its own. Exclude data-viz/code.
