# UI Splint — Scrutiny Checklist

The detailed criteria for each failure-mode group. SKILL.md is the gate (rules,
severity, protocol, report format); this file is the checklist you apply during a
review. Read it before reviewing and apply every group that is relevant to the
screen.

Use these sections as report groups when findings exist. Skip empty groups.

## Alignment and Boundaries

- Related regions should share clear edges. Headers, actions, forms, cards,
  tables, and sidebars should not drift by a few pixels without a reason.
- Repeated items should have stable dimensions and consistent internal alignment.
- Judge composition, not only collisions. A screen can be technically aligned and
  still look unfinished if unrelated controls, filters, summaries, and lists are
  just stacked down the left edge with ragged widths, no intentional columns, no
  clear grouping, or no primary reading path. Mark that at least `Polish`, and
  `Risk` when it slows scanning or hides priority.
- Left alignment is acceptable only when it belongs to a visible layout system:
  consistent gutters, shared max widths, deliberate columns, clear section
  hierarchy, and actions placed where users naturally expect them. Full-width
  pages should not leave the main work area feeling accidentally pinned to one
  side.
- Avoid card-inside-card stacking, duplicate frames, decorative containers around
  already-framed controls, and page sections that look like accidental wrappers.
- Modals, drawers, dropdowns, and floating controls must not overlap important
  content unless that is their explicit purpose.
- Popovers, menus, tooltips, comboboxes, and date pickers must stay within the
  viewport or flip/resize intentionally. Clipped floating UI is at least `Risk`
  and `Fail` when it hides required choices or actions.

## Space and Density

- Empty space should communicate grouping or priority. Treat dead areas, oversized
  panels, sparse dashboards, and hero-scale type inside tools as defects.
- Keep primary workflows visible without unnecessary scrolling. If a screen wastes
  the first viewport, mark it at least `Polish`, often `Risk`.
- Dense operational UIs should prioritize scanning and comparison over marketing
  composition.
- For dashboard, admin, and CRUD screens, look for an intentional layout skeleton:
  header/action row, filter region, data region, detail/sidebar region, and
  footer/pagination where relevant. If those parts appear as a loose vertical
  dump of components rather than a composed workflow, report the layout issue
  even when each component is individually styled.
- Low-information data fields (name, description, status) that each occupy their
  own full-width row, leaving wide empty horizontal space and pushing primary
  content down, are a density defect. `Polish`; `Risk` when it forces primary
  content off the first viewport. Suggested fix: group related fields onto a
  shared row or multi-column line.
- Full-line helper, guidance, or secondary rows that take a dedicated row when
  they could live in an existing toolbar, header, or action row. `Polish`; `Risk`
  when they cost first-viewport space. Suggested fix: merge into the adjacent
  toolbar/header.
- Permanently expanded controls that are secondary to the current workflow
  (occasional filters, sort) consuming standing vertical space and crowding
  primary data. `Polish`; `Risk` when they delay access to primary data on the
  first viewport. Suggested fix: compact summary row plus details/drawer. Not a
  finding when filters or sort are the primary scanning controls for the screen
  (see the layout-skeleton bullet above).
- Long text-labeled secondary actions that crowd a toolbar or row where an
  unambiguous icon button would preserve meaning and target size. `Polish`.
  Suggested fix: icon-only only when the icon is unambiguous and an accessible
  name is preserved via `aria-label` or visually-hidden text (`title`/tooltip is
  supplemental only); never icon-only a primary, destructive, rare, or ambiguous
  action — see `Contrast and Affordance` and `Icon Consistency`.

## Size Stability

- Fixed-format UI elements need stable dimensions: boards, grids, toolbars,
  counters, badges, sidebars, tiles, charts, image frames, and icon buttons.
- Use constraints such as `min/max`, grid tracks, aspect ratios, wrapping rules,
  and reserved space so routine data changes do not reflow unrelated regions.
- Buttons and controls should not change width because a count flips from `9` to
  `10`, a label becomes active, or a loading spinner appears.
- Validation errors, helper text, and inline warnings should reserve or absorb
  space predictably. Mark errors that shove primary actions, headers, or unrelated
  fields around as `Risk`; use `Fail` when the workflow becomes confusing or
  inaccessible.

## Ancestor-Driven Layout Breaks

The principle: an element's own CSS looking correct does not mean it renders
correctly. The rendered box is the product of the whole ancestor chain and
formatting context. When a region looks collapsed, empty, clipped, overlapping,
or mispositioned but the leaf code looks right, the break is usually above it, so
re-reading the leaf and concluding "the CSS is fine" misses it.

- Symptom first: if content exists in the DOM but the region renders as a thin
  line, a sliver, an empty area, a clipped edge, or in the wrong place, do not
  conclude the data is missing or the leaf CSS is wrong. Inspect computed values
  in the browser and trace up the ancestor/context chain to the first node that
  breaks the result.
- Size collapse (the common case): `height: 100%`, `flex: 1`, and percentage
  sizes resolve only when every ancestor up to the sizing root forwards a
  resolved size. One intermediate wrapper — a routed view, tab panel, route
  outlet, or plain `block`/`div` — without its own height (or
  `display: flex; flex: 1; min-height: 0; height: 100%`) silently breaks the
  chain, so scroll containers, virtual lists, flex/grid children, charts,
  canvases, maps, and editors collapse to ~0 while still rendering their children.
  A flex/grid child also needs `min-height: 0` / `min-width: 0` to shrink and
  scroll instead of overflowing or collapsing.
- Other ancestor-driven failures to chase the same way: an ancestor's
  `overflow: hidden` or fixed size clipping content; an ancestor establishing a
  containing block (`position`, `transform`, `filter`, `contain`) so absolute,
  fixed, or sticky descendants anchor wrong or stop sticking; an ancestor
  creating a stacking context so `z-index` layering breaks.
- Confirm in the browser, not from CSS. Compare the computed size / `clientHeight`
  of the affected element and each ancestor: a scroller with rendered rows but
  `clientHeight` near 0, or an ancestor whose computed size is 0 while its parent
  is large, marks the break point. Mark a primary surface broken this way as
  `Fail` (content present but invisible or unusable); `Risk` when it only breaks
  for certain data, routes, or viewports.
- Specificity collisions when restoring layout: a fix like `#view { display: flex }`
  can override the HTML `hidden` attribute (attribute styles lose to ID
  selectors), leaving a panel that should be hidden visible. Scope
  layout-restoring rules with `:not([hidden])` or an equally specific guard so
  toggled and hidden states still hide.
- Re-check after route changes, tab switches, modal/drawer open, and resize.
  These breaks often appear only in the second view or after a state toggle, not
  on first paint, so a single happy-path screenshot can miss them.

## Tables and Columns

- Table, grid, and kanban column widths must match the information hierarchy.
  Key identifiers, names, statuses, amounts, dates, and actions should be easy
  to scan without one verbose column starving the rest.
- Header and cell content need deliberate width rules: min/max widths, wrapping,
  truncation, sticky columns, alignment, or horizontal scrolling with a visible
  affordance. Accidental auto-sizing is a review finding when realistic data
  makes columns jump, collapse, or dominate the viewport.
- Numeric, date, status, and action columns should stay compact and aligned.
  Wide action columns, clipped headers, cramped primary identifiers, and repeated
  row actions that wrap unpredictably are `Risk` unless clearly intentional.
- Check zero, one, many, and horizontally scrollable states. Column proportions
  should remain understandable when rows are sparse, dense, filtered, selected,
  or expanded.

## Overflow and Text

- Long words, long labels, user-generated text, and localization must wrap, clamp,
  or truncate intentionally. Important information should not disappear silently.
- Text must not escape buttons, pills, table cells, cards, nav items, or form
  controls.
- Horizontal scrolling is a defect unless the surface is explicitly designed for
  it, such as a data table with a clear scroll affordance.

## Contrast and Affordance

- Start with actual foreground/background pairs visible in the screenshot or
  browser, not the intended design tokens. Pale text on white, pale text on
  bright brand fills, low-opacity placeholders on dark inputs, and light labels
  on light selected tabs are review findings even if there is no overlap.
- Text, icons, placeholders, badges, and form values must stay legible against
  their backgrounds in both light and dark modes. Dark text on dark surfaces,
  light text on light surfaces, low-opacity labels, and theme tokens that do not
  switch together are review findings.
- Check layered surfaces in each theme: pages, cards, modals, popovers, inputs,
  table rows, selected states, disabled states, code blocks, and toasts.
- Brand or social-auth colors do not excuse weak contrast. If a Google, Kakao,
  Naver, Apple, SSO, or payment button uses recognizable brand color but its
  text/icon is hard to read, mark it `Fail` for primary auth/payment actions and
  at least `Risk` elsewhere. Suggest changing the foreground color, adding an
  icon, or using the platform's standard button treatment.
- Segmented controls, tabs, bottom nav, and toggle groups must make the selected
  item unambiguous before interaction. If the selected item is readable but the
  unselected item is washed out, or if the unselected item looks more active
  than the selected item, report it. Mark it `Fail` when the control switches a
  primary workflow such as login/signup, checkout, destructive confirmation, or
  permission mode; otherwise mark at least `Risk`.
- Clickable controls must look interactive before hover or focus. Buttons, links,
  tabs, menu items, icon buttons, row actions, and clickable chips need a clear
  affordance such as shape, border, fill, underline, icon treatment, or visible
  state styling.
- Plain text without a click event must not look like a button or link. If
  clickable text and non-clickable text are visually indistinguishable, mark it
  at least `Risk`; mark it `Fail` when the action is required for a primary
  workflow.
- Hover, focus, active, selected, and disabled states must preserve contrast and
  should not rely on subtle color-only differences that disappear in one theme.

## Forms and Inputs

- Labels, placeholders, entered values, helper text, errors, units, and suffixes
  must be readable on the actual input surface in every theme. Low-contrast
  placeholder text is `Risk`; low-contrast entered values, required labels, or
  errors are `Fail` for primary forms.
- Required, optional, disabled, read-only, invalid, loading, and saved states
  should be visually distinct before the user interacts. Do not accept forms
  where a disabled field looks editable, a required field looks optional, or a
  successful save is indistinguishable from unsaved edits.
- Inputs need stable dimensions and predictable wrapping. Long values, currency
  symbols, units, password managers, validation icons, clear buttons, and
  autocomplete chips must not cover text or push adjacent controls out of line.
- Mobile forms need keyboard-aware layout. The focused field, validation error,
  submit action, and any sticky footer should remain reachable when the software
  keyboard is open; bottom nav or fixed action bars should not cover fields.
- Validation should point to the field or group it describes. A generic banner is
  not enough when the user cannot tell which field failed or how to recover.
- Auth and payment forms deserve stricter scrutiny: mode selectors, provider
  buttons, credential fields, consent checkboxes, recovery links, and submit
  actions should read as one coherent flow with clear priority and no conflicting
  navigation state.

## System Consistency

- Prefer existing shared UI components, design tokens, utility classes, and local
  helper APIs when the codebase already has them. One-off CSS, bespoke button
  variants, custom spacing, or hand-rolled controls are review findings when they
  duplicate established primitives.
- If no common primitive exists, new UI should still feel like the same product:
  align radius, border weight, spacing scale, typography, icon size, shadows,
  motion, hover/focus/disabled states, and density with nearby screens.
- Repeated controls with the same role should share the same structure and visual
  treatment. Primary buttons, secondary actions, filters, empty states, cards,
  tables, tabs, and form rows should not look like they came from separate design
  systems.
- Report visual drift as `Risk` when it affects repeated components or user
  recognition, and `Polish` when it is isolated but makes the product feel
  patched together.

## Navigation and Mode Clarity

- Current route and current mode should be clear from the visible navigation.
  Tabs, segmented controls, bottom nav, breadcrumbs, and sidebars should not
  leave users guessing where they are or what state they are editing.
- Authentication screens need special scrutiny. A login/signup form that leaves
  the app's authenticated bottom nav, account tab, or unrelated primary
  navigation active can make the flow feel contradictory. Mark it at least
  `Risk` unless the product clearly supports browsing while signed out and the
  navigation labels/states make that clear.
- Primary auth flows should have a coherent hierarchy: auth mode selector,
  provider buttons, divider, credentials, and submit action should read as one
  flow. If app navigation, highlighted account tabs, or unrelated actions compete
  with the form, report the mode conflict instead of treating it as taste.

## Interaction Safety

- Modal, drawer, dropdown, popover, and command-menu focus must stay inside the
  active layer until it closes. Tab, Shift+Tab, Escape, Enter, and Space should
  behave consistently; focus falling into the dimmed page behind an overlay is a
  review finding.
- Disabled, read-only, loading, and pending controls must look and behave the
  same way. If something looks disabled but still clicks, or looks clickable but
  is disabled, mark it as confusing interaction state.
- Save, delete, submit, and destructive actions must prevent accidental duplicate
  execution while pending. Repeated clicks should not create duplicate requests,
  duplicate records, or repeated destructive operations.
- Adjacent buttons, icon buttons, segmented controls, and row actions need enough
  spacing and target size for touch. Mark crowded action clusters as `Risk` when
  routine use could trigger the wrong action.

## Scroll, Sticky, and Layering

- Scroll containers should be obvious and usable. Watch for nested scrolling that
  traps the wheel/touch gesture, hidden scrollbars on scrollable data, body
  scroll leaking behind modals, and content that can be reached only with a
  precise trackpad gesture.
- Sticky headers, sticky columns, bottom bars, and floating action rows must not
  cover content, table rows, form fields, toasts, or pagination. Check the top,
  middle, and bottom of long content, not only first paint.
- Layer order should match user intent. Menus, popovers, tooltips, date pickers,
  command palettes, toasts, modals, drawers, and focus rings need a coherent
  stacking order; a high `z-index` alone is not proof.
- Safe areas and fixed mobile chrome matter. Bottom navigation, sticky CTAs, chat
  inputs, and cookie banners should respect mobile safe-area insets and not
  obscure final rows, legal text, destructive confirmations, or submit buttons.
- Programmatic scrolling, anchor links, route changes, and validation focus
  should land with the target visible below sticky chrome. If the page scrolls to
  a hidden or half-covered element, mark it `Risk` or `Fail` for required flows.

## Responsive Behavior

- Mobile layouts must preserve task order and tap targets. Do not accept squashed
  toolbars, cramped nav, two-column remnants, hidden primary actions, or cards
  that become mostly whitespace.
- Wide desktop layouts must not stretch text, controls, or images until they look
  disconnected. Use max widths or meaningful columns.

## States and Feedback

- Loading, empty, error, disabled, focus, hover, selected, and validation states
  are part of the UI, not extras.
- Data-backed UI must distinguish successful empty results from data retrieval
  errors. Empty means the query completed and returned no records; error means
  data could not be fetched, authorized, parsed, or computed. These states need
  different copy, tone, icon/status treatment, and actions.
- Empty states should explain what is absent and, when useful, how to create,
  import, clear filters, or broaden the search. Error states should say that
  loading failed and provide a retry, refresh, reconnect, permission, or support
  path appropriate to the product.
- Do not accept a shared "No data" placeholder for query failures, permission
  failures, server errors, offline states, or timeouts. Mark it `Fail` for
  primary data workflows and at least `Risk` elsewhere because it hides system
  failure from the user.
- Filter-empty, permission-empty, first-use empty, and true empty states may also
  need distinct treatment. If the same UI makes users guess why no rows appear,
  report it.
- Failed refresh with stale data still visible needs explicit treatment. The UI
  should make clear what is old, whether new data failed to load, when the data
  was last updated, and what action can recover. Do not accept stale or partial
  data that is visually indistinguishable from fresh complete data.
- Partial data should be labeled as partial when the product can act on it. If
  some panels, rows, metrics, or charts failed independently, the UI should show
  localized error/retry affordances instead of collapsing the entire page into a
  generic empty or success state.
- State-specific content must preserve layout rhythm. Error banners, skeletons,
  and empty states should not cause surprising jumps or push controls off-screen.
- **Skeleton-to-Loaded CLS (Cumulative Layout Shift) Gate**: Compare the height and layout footprint of a skeleton component with its final loaded state. If the skeleton's height is significantly different from the final loaded content (e.g., a skeleton card is 100px tall but the loaded card is 350px tall), causing content below it to suddenly jump when data arrives, report it.
  - Skeletons should approximate the final dimensions, counts, and spacing of the content they represent.
  - Do not accept generic full-width spinner bars that collapse upon loading.
  - Mark major layout jumps during load transition as `Risk`, and `Fail` if the jump pushes critical action controls (like "Submit" or "Cancel") away from under the cursor right before a click.
- Empty, error, and loading placeholders that replace a data region must be
  positioned deliberately within that region — centered or spanning the column
  grid — not pinned to the left or top with the rest of the region left as dead
  space. A placeholder crammed into one corner of a full-width container reads as
  a half-rendered layout. Mark it `Risk`, and `Fail` when it makes the screen
  look broken or when table column headers remain above an off-grid placeholder.
- Focus and hover affordances should be visible without changing component size.
- One-item and many-item states should both look intentional. Watch for lonely
  cards stretched across large spaces, single rows with broken borders, dense
  lists that lose rhythm, pagination that appears too early, and action bars that
  become unbalanced as item counts change.

## Charts and Metrics

- Charts, sparklines, maps, gauges, and metric cards need legible titles, units,
  axes or scale cues, legends, series labels, and date ranges where the product
  depends on comparison. A beautiful chart that hides units or time range is a
  review finding.
- Color is not enough to distinguish series, status, positive/negative movement,
  or selected data. Check legend contrast, color-blind ambiguity, hover/focus
  states, and whether a printed or grayscale view would still be interpretable.
- Tooltips and crosshairs should be reachable and readable in desktop and touch
  contexts. If critical values appear only on hover and there is no mobile or
  keyboard path, mark it `Risk`; `Fail` when the value is needed for a primary
  decision.
- Loading, empty, error, stale, partial, and filtered states for charts need
  distinct treatment just like tables. Do not accept an empty chart area or zero
  metric when the real state is query failure, permission failure, or partial
  data.
- Metric numbers should handle realistic extremes: very large values, decimals,
  currency, percentages, negative numbers, missing values, and localized formats.
  Values must not wrap into unreadable stacks, overlap trend badges, or resize
  cards in a way that breaks comparison.

## Icon Consistency

- The same action or status should use the same icon across screens unless there
  is a clear contextual reason. Different icons for the same meaning make users
  relearn the interface and should be reported.
- The same icon should not mean different things in nearby screens, menus, or
  toolbars. If reuse is unavoidable, labels, tooltips, or surrounding copy must
  remove the ambiguity.

## Visual Assets

- Images, icons, charts, and canvases must render as intended. Broken media,
  blurry previews, unreadable charts, poor cropping, and placeholder-looking
  assets are review findings.
- The primary visual should reveal the thing the user needs to inspect, not hide
  it behind dark overlays, blur, or decorative framing.
