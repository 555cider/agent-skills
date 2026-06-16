---
name: ui-splint
description: Use when building, editing, reviewing, or finishing frontend UI, web pages, components, screenshots, or visual QA with layout, contrast, affordance, focus, state, table, responsive, overflow, visual consistency, or odd-looking screen concerns before claiming frontend work is complete.
---

# UI Splint

Purpose: catch frontend UI problems that are easy to rationalize away when
reading code but obvious in the rendered screen. Treat this as an expert visual
QA gate, not a casual design pass.

Use the user's language in reports.

Group related issues by failure mode. Do not report a flat chronological list
when several findings share the same cause or user impact.

## Hard Rules

- Do not claim frontend work is complete unless you have inspected the rendered
  UI in a browser or screenshot for the relevant screens.
- If browser or screenshot verification is unavailable, say the work is blocked
  on visual verification. Do not replace that with "looks good from the code."
- Report suspicious UI issues before fixing them. Include severity and wait for
  approval unless the user explicitly asked you to fix a known list of issues.
- Prefer concrete evidence over taste words: viewport, state, data condition,
  selector/component, screenshot location, and why it will fail in use.

## Severity

- `Fail`: Cannot approve. Includes overlap, clipping, horizontal overflow,
  broken responsive layout, hidden required controls, unreadable text from poor
  foreground/background contrast, controls that cannot be distinguished from
  static text, focus escaping active overlays, pending actions that can be
  submitted repeatedly, layout shift caused by routine data changes, or
  interactions that are blocked.
- `Risk`: Not broken in the happy path, but likely to break with realistic data,
  state, permissions, localization, viewport, or content changes.
- `Polish`: Functional but visibly amateur: weak alignment, noisy hierarchy,
  wasted space, duplicate containers, awkward rhythm, inconsistent sizing, or
  layout choices that make the product feel unfinished.

Escalate severity when the issue affects primary workflows, repeated components,
or any surface the user asked you to finish.

## Inspection Protocol

1. Open the actual rendered UI: app route, Storybook story, preview build, or
   user-provided screenshot. If none exists, create the narrowest way to render
   the component before judging it.
2. Check at least one desktop and one mobile viewport. Add tablet or wide desktop
   when the layout has multi-column regions, sidebars, tables, canvases, charts,
   or dense toolbars.
3. Stress the UI with realistic variation:
   - Content and data: long labels, localized strings, large numbers,
     timestamps, prices, short and long table headers or cells, missing images,
     slow media, and varied action counts
   - Interaction states: empty, loading, error, disabled, selected, hover, focus,
     active, pending save/delete, and repeated primary or destructive clicks
   - Theme and affordance: light/dark variants, clickable controls near static
     text, disabled-looking active controls, and active-looking disabled controls
   - Overlay and viewport: modals, drawers, dropdowns, popovers, tooltips, focus
     traps, viewport edges, scrolling, and bottom-of-page content
   - System consistency: shared components, design tokens, utility classes,
     spacing, radius, typography, icons, and state treatments
   - Density and count: zero, one, many, enough items to scroll, and crowded
     adjacent targets that could be tapped by mistake
4. Watch for movement. Values, badges, filters, tabs, toasts, side panels, or
   validation errors must not resize unrelated layout regions or push critical
   controls around.
5. Scroll and interact enough to verify sticky headers, modals, menus, popovers,
   tooltips, focus rings, focus traps, viewport boundaries, and bottom-of-page
   content.

If you cannot force a state through the UI, inspect the code or fixtures to see
how it would render, then mark unverified visual behavior as `Risk`.

## What To Scrutinize

Use these sections as report groups when findings exist. Skip empty groups.

### Alignment and Boundaries

- Related regions should share clear edges. Headers, actions, forms, cards,
  tables, and sidebars should not drift by a few pixels without a reason.
- Repeated items should have stable dimensions and consistent internal alignment.
- Avoid card-inside-card stacking, duplicate frames, decorative containers around
  already-framed controls, and page sections that look like accidental wrappers.
- Modals, drawers, dropdowns, and floating controls must not overlap important
  content unless that is their explicit purpose.
- Popovers, menus, tooltips, comboboxes, and date pickers must stay within the
  viewport or flip/resize intentionally. Clipped floating UI is at least `Risk`
  and `Fail` when it hides required choices or actions.

### Space and Density

- Empty space should communicate grouping or priority. Treat dead areas, oversized
  panels, sparse dashboards, and hero-scale type inside tools as defects.
- Keep primary workflows visible without unnecessary scrolling. If a screen wastes
  the first viewport, mark it at least `Polish`, often `Risk`.
- Dense operational UIs should prioritize scanning and comparison over marketing
  composition.

### Size Stability

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

### Tables and Columns

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

### Overflow and Text

- Long words, long labels, user-generated text, and localization must wrap, clamp,
  or truncate intentionally. Important information should not disappear silently.
- Text must not escape buttons, pills, table cells, cards, nav items, or form
  controls.
- Horizontal scrolling is a defect unless the surface is explicitly designed for
  it, such as a data table with a clear scroll affordance.

### Contrast and Affordance

- Text, icons, placeholders, badges, and form values must stay legible against
  their backgrounds in both light and dark modes. Dark text on dark surfaces,
  light text on light surfaces, low-opacity labels, and theme tokens that do not
  switch together are review findings.
- Check layered surfaces in each theme: pages, cards, modals, popovers, inputs,
  table rows, selected states, disabled states, code blocks, and toasts.
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

### System Consistency

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

### Interaction Safety

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

### Responsive Behavior

- Mobile layouts must preserve task order and tap targets. Do not accept squashed
  toolbars, cramped nav, two-column remnants, hidden primary actions, or cards
  that become mostly whitespace.
- Wide desktop layouts must not stretch text, controls, or images until they look
  disconnected. Use max widths or meaningful columns.

### States and Feedback

- Loading, empty, error, disabled, focus, hover, selected, and validation states
  are part of the UI, not extras.
- State-specific content must preserve layout rhythm. Error banners, skeletons,
  and empty states should not cause surprising jumps or push controls off-screen.
- Focus and hover affordances should be visible without changing component size.
- One-item and many-item states should both look intentional. Watch for lonely
  cards stretched across large spaces, single rows with broken borders, dense
  lists that lose rhythm, pagination that appears too early, and action bars that
  become unbalanced as item counts change.

### Icon Consistency

- The same action or status should use the same icon across screens unless there
  is a clear contextual reason. Different icons for the same meaning make users
  relearn the interface and should be reported.
- The same icon should not mean different things in nearby screens, menus, or
  toolbars. If reuse is unavoidable, labels, tooltips, or surrounding copy must
  remove the ambiguity.

### Visual Assets

- Images, icons, charts, and canvases must render as intended. Broken media,
  blurry previews, unreadable charts, poor cropping, and placeholder-looking
  assets are review findings.
- The primary visual should reveal the thing the user needs to inspect, not hide
  it behind dark overlays, blur, or decorative framing.

## Report Format

Start with findings. Keep it short when possible, but include enough evidence
that the user can decide whether to approve fixes. Group findings by failure
mode, not by the order you noticed them.

```text
UI review: <blocked | fixes recommended | no findings>
Checked: <routes/components>, <viewports>, <states/data varied>

Findings:
<group name, for example Contrast and affordance>
- [Fail] <area>: <problem>. Evidence: <viewport/state/data>. Why it matters: <reason>. Suggested fix: <fix>.

<group name, for example Interaction safety>
- [Risk] <area>: <problem>. Evidence: <viewport/state/data>. Why it matters: <reason>. Suggested fix: <fix>.

<group name, for example Layout stability>
- [Polish] <area>: <problem>. Evidence: <viewport/state/data>. Suggested fix: <fix>.

Not verified: <anything relevant that could not be rendered or stressed>
Approval needed: <specific fix set or next action>
```

If there are no findings, still state what was checked. "No findings" without
viewports, states, and data variation is not a valid result.

## Common Mistakes

- Judging from JSX/CSS alone and assuming the browser will look fine.
- Checking only the seeded happy path with short labels and one viewport.
- Checking only one color theme and missing unreadable text in the other theme.
- Listing findings in discovery order instead of grouping related problems by
  failure mode and user impact.
- Ignoring existing shared components, tokens, or utility classes and accepting
  one-off UI that does not match the surrounding product.
- Treating wasted space, unstable dimensions, or almost-aligned regions as taste
  instead of product quality problems.
- Accepting text-like buttons or link-like static labels because the event handler
  is obvious from code.
- Fixing visual issues silently when the user asked to review what looks weird.
- Reporting "responsive works" without naming the tested widths and observed
  layout behavior.
