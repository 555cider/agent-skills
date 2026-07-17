# UI Audit — Scrutiny Checklist (judgment layer)

This is the **taste layer**, not the detector. `scripts/audit.js` already MEASURES
contrast, overflow, overlap, collapse, clipping, tap targets, focus leaks, CLS,
broken media, and design-system drift (see `references/audit-rules.md`). Do **not**
re-apply those by eye. This file covers what only judgment can settle, applied
*after* you have the audit's measured findings in hand.

Severity words and meanings come from SKILL.md (`Fail` = broken now · `Risk` =
breaks with real data/state/locale/viewport · `Polish` = unpolished but functional).
**A measured `Fail` is never downgraded by taste.** Pure visual-judgment findings
cap at `Risk` ("Risk-confirm") unless paired with a measured `Fail`.

Each bullet is tagged:

- **[auto]** — audit already measured it; only verify the call and triage.
- **[hybrid]** — audit flags candidates; you confirm intent, meaning, or severity.
- **[visual]** — no signal in code; pure judgment; capped at `Risk`.

Use these section names as report groups (SKILL.md: "group findings by failure mode").
Skip empty groups.

---

## Triage the measured findings

Do this before opening any judgment group. It turns raw audit output into a clean finding list.

- **Resolve `needs-visual`.** Any finding with `confidence: needs-visual` (text over a
  gradient/image; CLS with no observer) is unconfirmed. Pixel-sample a screenshot crop
  for the true composited contrast, or re-inject `audit.js` *before* navigation so the
  CLS observer installs early. Never assert a number you did not measure; never ship it
  unresolved.
- **Apply whitelist/baseline.** Drop findings matched by `whitelist`/`baseline` in
  `audit-config.json`. A returning baseline finding is not new noise.
- **Dedupe to root cause.** Collapse the same defect across repeated instances of one
  component into a single finding with an instance count. Fix the component, not 40 rows.
- **Cap Polish volume.** Polish is advisory. Summarize many small Polish items as one
  themed line; do not bury Fails under a Polish wall.
- **De-escalate intended patterns (the audit cannot read intent — you can):**
  - `overflow-x` on a carousel / horizontal scroller with a visible scroll affordance → not horizontal-overflow.
  - `role=dialog` / `role=tooltip` / `role=menu` overlay covering content → intended occlusion, not stickyOverlap.
  - `sr-only` / visually-hidden clip → intended, not textClip or invisibleContent.
  - a genuinely disabled control reading as disabled → correct, not disabledLookingPrimary.
  - designed `line-clamp` / ellipsis with the full value reachable (tooltip, expand, detail) → intended truncation, not silent textClip.
  - decorative/spacer/`aria-hidden` empty node → not ancestorCollapse.
- **Do NOT de-escalate a measured Fail by calling it intentional.** "Intended" removes a
  false positive; it never rewrites a real contrast ratio or a real off-viewport box.
  If the pattern is intended *and* still fails a threshold, it is still a Fail.

---

## Page composition & scan path  *(mostly [visual])*

The audit sees boxes, not a workflow. Judge whether the screen reads as a composed surface.

- **[visual]** Is there an intended skeleton for the surface type — header/action row →
  filters → summary → primary data → detail/sidebar → pagination/footer? Loose vertical
  dump of individually-styled components = `Polish`; `Risk` when it slows scanning or
  buries priority.
- **[visual]** "Controls dumped down the left edge": filters, summaries, and lists
  stacked at ragged widths with no columns, gutters, or grouping. Left alignment is fine
  only inside a visible layout system (shared max-width, deliberate columns). `Polish`;
  `Risk` when the main work area feels accidentally pinned to one side.
- **[visual]** Where does the eye start, and is that the right place? Primary actions
  should sit where users expect them (top-right action row, form bottom, etc.), not
  scattered.
- **[visual]** Card-inside-card, duplicate frames, decorative wrappers around
  already-framed controls — sections that look like accidental containers. `Polish`.

## Visual hierarchy & emphasis  *([visual])*

- **[visual]** Is the most important thing the most prominent? If a secondary action
  outweighs the primary one, or the primary CTA is quieter than surrounding chrome →
  `Risk`.
- **[visual]** Competing CTAs: two or more buttons fighting for "primary" with equal
  weight on the same surface. Pick one. `Risk` on a primary workflow, else `Polish`.
- **[visual]** Emphasis spent on the wrong target (hero-scale type on a label, loud color
  on a rarely-used control). `Polish`.

## Density appropriateness  *([visual])*

- **[visual]** Match density to surface type. Marketing/landing can breathe; dense
  operational / admin / CRUD screens should prioritize scanning and comparison, not
  marketing whitespace.
- **[visual]** Operational screen wasting the first viewport (oversized panels, sparse
  dashboard, low-information fields each on their own full-width row) → `Polish`; `Risk`
  when it pushes primary content/actions off the first viewport.
- **[visual]** Full-line helper/guidance/secondary rows or permanently-expanded secondary
  controls (occasional filters/sort) that could collapse into an existing toolbar →
  `Polish`; `Risk` when they cost first-viewport space. Not a finding when those controls
  are the primary scanning tool for the screen.
- **[auto]** Narrow elements (buttons, inputs, badges, etc.) occupying a full row by themselves → `loneNarrowElement` (`Polish`). Prefer sharing the row with other elements.
- **[auto]** Too many buttons listed in a single row → `excessiveButtonsInRow` (`Polish`). Prefer grouping some under a dropdown/menu.


## Spacing rhythm & alignment  *([visual], beyond drift histograms)*

- **[visual]** Optical alignment the audit's numeric drift check misses: icon vs text
  baselines, mixed-size elements that align by box but not by eye, ragged right edges in
  a column that should align. `Polish`.
- **[visual]** Grouping / gestalt: related controls separated, unrelated ones crowded;
  inconsistent gaps that imply the wrong grouping. `Polish`; `Risk` when grouping
  miscommunicates which fields/actions belong together.
- **[visual]** Rhythm breaks across repeated items (uneven internal padding, one card
  taller for no reason) even when each item individually passes. `Polish`.

## Data feedback: empty / error / stale / partial  *([hybrid])*

Some structure is measurable (a placeholder exists, a region collapsed), but whether the
states are *meaningfully distinct* is judgment.

- **[hybrid]** Distinguish the states — they need different copy, tone, icon, and recovery:
  - **Empty** = query completed, zero records → explain what's absent + how to add/import/clear filters/broaden.
  - **Load failed** = couldn't fetch/authorize/parse → say so + retry/refresh/reconnect/permission/support path.
  - **Filtered to zero** = data exists but filters exclude all → offer "clear filters", not "create your first item".
  - **Stale after failed refresh** = old data still shown → label what's old, when it last updated, that refresh failed, how to recover.
  - **Partial** = some panels/rows/metrics failed independently → localized error/retry per region, not a whole-page reset.
- **[hybrid]** A shared "No data" placeholder reused for query failure / permission denial
  / server error / offline / timeout hides system failure → `Fail` on a primary data
  workflow, `Risk` elsewhere.
- **[hybrid]** Stale or partial data visually indistinguishable from fresh complete data →
  `Risk`; `Fail` when a user could act on wrong data.
- **[visual]** Empty/error tone: blaming the user, dead-end copy with no next step, or a
  cheery message on a real failure. `Polish`–`Risk` by surface.
- *(Placeholder pinned to a corner of an empty data region, or load-jump CLS, is measured —
  see `ancestorCollapse` / `layoutShiftCLS`. Triage, don't re-eyeball.)*

## Microcopy & content  *([visual])*

- **[visual]** Label clarity: ambiguous, jargon, or truncated-meaning labels; verbs that
  don't say what the action does. `Risk` on primary actions, else `Polish`.
- **[visual]** Casing consistency (Title Case vs sentence case mixed across peers),
  punctuation, terminology drift (same concept named two ways). `Polish`.
- **[visual]** Placeholder used as the only label (disappears on input). `Risk`.
- **[visual]** Locale data formatting: numbers, dates, currency, percentages, units shown
  in the wrong or inconsistent locale format (1,000 vs 1.000; MM/DD vs DD/MM; missing
  currency symbol/grouping). `Risk` when values are decision-relevant.

## Icon consistency  *([visual])*

- **[visual]** Same action/status → same icon across the screen and product. Different
  icons for one meaning forces relearning. `Polish`; `Risk` when it misleads.
- **[visual]** Same icon reused for different meanings in nearby menus/toolbars without
  disambiguating label/tooltip. `Risk`.

## System & brand coherence  *([visual]/[hybrid])*

- **[hybrid]** Does new UI reuse existing shared components / design tokens / utilities,
  or reinvent them? One-off CSS, bespoke button variants, custom spacing that duplicate
  established primitives → `Risk` for repeated components, `Polish` if isolated.
- **[visual]** Does it feel like the same product? Radius, border weight, spacing scale,
  type, icon size, shadows, hover/focus/disabled treatment should align with nearby
  screens. (Raw radius/shadow/hue *counts* are measured as `designSystemDrift`; this is
  the "does it belong" call on top.)
- **[visual]** Repeated controls with the same role looking like they came from separate
  design systems. `Risk`.

## Motion & affordance nuance  *([visual], not measured)*

- **[visual]** Does motion respect `prefers-reduced-motion` intent — large/looping/parallax
  motion with no reduced path? `Risk`. (Often must be checked by toggling the media query.)
- **[visual]** Clickable-looks-static: a real action with no shape/border/fill/underline/
  state affordance, so users won't find it. `Risk`; `Fail` if required for a primary flow.
- **[visual]** Static-looks-clickable: plain text or decoration styled like a button/link
  with no action behind it. `Risk`. (Distinct from contrast, which the audit handles.)
- **[visual]** Hover/focus/active/selected affordance that resizes the component or relies
  on a color-only shift that vanishes in one theme. `Polish`–`Risk`.

## Charts & metrics interpretability  *([hybrid])*

- **[hybrid]** Can the chart be read without context — title, units, axes/scale cues,
  legend meaning, series labels, time range? A pretty chart hiding units or range is a
  finding. `Risk`; `Fail` when it drives a primary decision.
- **[hybrid]** Color-blind ambiguity: series/status/positive-negative distinguished by hue
  alone; would grayscale still parse? `Risk`. (Per-pair contrast is measured; *semantic*
  ambiguity is judgment.)
- **[hybrid]** Tooltip/crosshair reachability: critical values only on hover with no
  touch/keyboard path. `Risk`; `Fail` when the value is needed to decide.
- **[hybrid]** Realistic extremes: very large/negative/decimal/missing values, localized
  formats wrapping into unreadable stacks, overlapping trend badges, or resizing cards so
  comparison breaks. `Risk`.

## Tables: column hierarchy & scan-ability  *([hybrid])*

- **[hybrid]** Do column widths match information hierarchy at *realistic* data — key
  identifiers/names/status/amount/date/actions scannable, not one verbose column starving
  the rest? `Risk` when realistic data makes columns jump, collapse, or dominate.
- **[hybrid]** Numeric/date/status/action columns compact and aligned (numbers
  right-aligned, currency aligned). Wide action columns, cramped identifiers, row actions
  wrapping unpredictably → `Risk` unless intentional.
- **[hybrid]** Proportions hold across zero / one / many / filtered / selected / expanded
  rows. (Render those states; the audit only sees the rows present.)

## Responsive / i18n / zoom judgment  *([hybrid])*

- **[hybrid]** Does the mobile layout preserve **task order** and not just shrink — primary
  action still reachable, no squashed toolbars, two-column remnants, or cards reduced to
  whitespace? `Risk`. (Overflow/tap-size/overlap on mobile are measured per viewport;
  task-order preservation is judgment.)
- **[hybrid]** 200% zoom and text-expansion (DE/FR ~30% longer): does layout reflow without
  clipping or losing actions? `Risk`. (Run the audit zoomed / with long-locale fixtures,
  then judge the result.)
- **[hybrid]** RTL: does the layout mirror correctly — directional icons, alignment,
  start/end logical properties — rather than break? `Risk`.

---

## Adding a new failure mode

- **Measurable from the DOM/CSSOM/geometry?** Add a rule to `scripts/audit.js` and document
  it in `references/audit-rules.md`. Do not add it here as an eyeball instruction.
- **Needs taste** (composition, tone, copy, coherence, interpretability)? Add a tagged
  bullet to the right group here, with concrete symptoms and a severity (visual caps at
  `Risk`).
- Keep detection in code and taste in this file. If you find yourself writing "look for X
  pixels of Y" here, it belongs in the audit.
