---
name: ui-splint
description: Use when building, editing, reviewing, or finishing frontend UI, web pages, components, screenshots, or visual QA with layout, composition, alignment, contrast, selected-state clarity, auth/navigation flow, affordance, focus, state, empty-vs-error data feedback, table, responsive, overflow, collapsed/clipped/mispositioned region, visual consistency, or odd-looking screen concerns before claiming frontend work is complete.
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
- Before reviewing, read `references/scrutiny-checklist.md` and apply every group
  that is relevant to the screen. The checklist is the substance of the review;
  do not review from the group names in this file alone.

## Severity

- `Fail`: Cannot approve. Includes overlap, clipping, horizontal overflow,
  broken responsive layout, hidden required controls, unreadable text from poor
  foreground/background contrast, controls that cannot be distinguished from
  static text, focus escaping active overlays, pending actions that can be
  submitted repeatedly, layout shift caused by routine data changes,
  interactions that are blocked, or primary content that exists in the DOM but is
  invisible or unusable because an ancestor's layout or formatting context
  collapsed, clipped, or mispositioned its rendered box. Also includes primary
  data surfaces that hide retrieval failures behind a normal empty state or make
  users think failed data was successfully loaded, current, or complete. Primary
  button labels, tab labels, nav labels, form labels, and entered values that
  are hard to read against their own surface are `Fail`, even when the colors
  appear intentional or branded.
- `Risk`: Not broken in the happy path, but likely to break with realistic data,
  state, permissions, localization, viewport, or content changes. Includes
  ambiguous data feedback where users cannot tell whether there are no records,
  filters removed all records, the query failed, or the visible data is stale or
  partial.
- `Polish`: Functional but visibly amateur: weak alignment, noisy hierarchy,
  wasted space, duplicate containers, awkward rhythm, inconsistent sizing, or
  layout choices that make the product feel unfinished, including screens that
  look like controls were simply stacked against the left edge without a designed
  grid, grouping, or reading path.

Escalate severity when the issue affects primary workflows, repeated components,
or any surface the user asked you to finish.

## Inspection Protocol

1. Open the actual rendered UI: app route, Storybook story, preview build, or
   user-provided screenshot. If none exists, create the narrowest way to render
   the component before judging it.
2. Check at least one desktop and one mobile viewport. Add tablet or wide desktop
   when the layout has multi-column regions, sidebars, tables, canvases, charts,
   or dense toolbars.
3. Before drilling into individual components, do a page-level composition pass.
   Identify the intended workflow regions: header/action row, filters, summary,
   primary data, detail/sidebar, pagination, and secondary actions where
   relevant. If you cannot name the layout skeleton or reading path, treat that
   as a finding instead of only checking whether individual components look
   styled. Re-run this composition pass on each non-happy state too: when a
   placeholder replaces a data region, check its centering, dead space, and grid
   alignment, not only its copy and stability.
4. Do a visible-label contrast scan before saying "no findings". Check every
   prominent label on its actual surface: primary and secondary buttons,
   segmented controls, selected and unselected tabs, bottom nav items, form
   labels/placeholders/values, dividers, badges, and social/brand buttons. If
   any required label is washed out, near-invisible, or readable only because you
   already know the word, report it.
5. Stress the UI with realistic variation:
   - Content and data: long labels, localized strings, large numbers,
     timestamps, prices, short and long table headers or cells, missing images,
     slow media, varied action counts, no records returned, filter results
     reduced to zero, data retrieval/query failures, stale cached data after
     refresh failure, partial responses, and unknown last-updated status
   - Interaction states: empty, loading, error, disabled, selected, hover, focus,
     active, pending save/delete, retry after failed load, failed refresh while
     old data remains visible, and repeated primary or destructive clicks
   - Theme and affordance: light/dark variants, clickable controls near static
     text, disabled-looking active controls, and active-looking disabled controls
   - Overlay and viewport: modals, drawers, dropdowns, popovers, tooltips, focus
     traps, viewport edges, scrolling, and bottom-of-page content
   - System consistency: shared components, design tokens, utility classes,
     spacing, radius, typography, icons, and state treatments
   - Density and count: zero, one, many, enough items to scroll, and crowded
     adjacent targets that could be tapped by mistake
6. Watch for movement. Values, badges, filters, tabs, toasts, side panels, or
   validation errors must not resize unrelated layout regions or push critical
   controls around.
7. Scroll and interact enough to verify sticky headers, modals, menus, popovers,
   tooltips, focus rings, focus traps, viewport boundaries, and bottom-of-page
   content.
8. Confirm that regions actually render where and at the size you expect — scroll
   regions, virtual lists, flex/grid children, charts, and canvases especially.
   If a region looks collapsed, clipped, empty, or mispositioned despite having
   content in the DOM, inspect its computed values and trace the ancestor/context
   chain for the break, rather than assuming the data is missing or the leaf CSS
   is at fault.

If you cannot force a state through the UI, inspect the code or fixtures to see
how it would render, then mark unverified visual behavior as `Risk`.

For edge cases such as very long text, missing assets, localized wrapping, or
empty/error/loading fallback containers, prefer a temporary local mock fixture or
Storybook state over guessing. Inject dummy props, mock API handlers, or local
mock data, then render and capture the extreme state. Remove every temporary
mock, test route, and prop override before declaring the code work complete.

## What To Scrutinize

The detailed criteria for each failure-mode group live in
`references/scrutiny-checklist.md`. You MUST read that file and apply every group
relevant to the screen before reporting — this is the substance of the review,
not optional reference. Use the group names below as report groups; skip empty
groups.

- Alignment and Boundaries
- Space and Density
- Size Stability
- Ancestor-Driven Layout Breaks
- Tables and Columns
- Overflow and Text
- Contrast and Affordance
- Forms and Inputs
- System Consistency
- Navigation and Mode Clarity
- Interaction Safety
- Scroll, Sticky, and Layering
- Responsive Behavior
- States and Feedback
- Charts and Metrics
- Icon Consistency
- Visual Assets

When you add a newly discovered failure mode, add it as a group (or a bullet
under the closest existing group) in `references/scrutiny-checklist.md`, and add
its name to this list if it is a new group.

## Report Format

Start with findings. Keep it short when possible, but include enough evidence
that the user can decide whether to approve fixes. Group findings by failure
mode, not by the order you noticed them.

```text
UI review: <blocked | fixes recommended | no findings>
Checked: <routes/components>, <viewports>, <states/data varied>
Contrast checked: <buttons, tabs/segmented controls, nav, form labels/values, placeholders, brand buttons>
Mode/navigation checked: <current route/mode and any auth, modal, wizard, or bottom-nav context>
Data states checked: <loaded, loading, true-empty, filter-empty, error, retry, stale/partial if relevant>

Findings:
<group name, for example Contrast and affordance>
- [Fail] <area>: <problem>. Evidence: <viewport/state/data>. Why it matters: <reason>. Suggested fix: <fix>.

<group name, for example Interaction safety>
- [Risk] <area>: <problem>. Evidence: <viewport/state/data>. Why it matters: <reason>. Suggested fix: <fix>.

<group name, for example Layout stability>
- [Polish] <area>: <problem>. Evidence: <viewport/state/data>. Suggested fix: <fix>.

Not verified: <anything relevant that could not be rendered or stressed, including untested data states>
Approval needed: <specific fix set or next action>
```

If there are no findings, still state what was checked. "No findings" without
viewports, states, visible-label contrast, selected-state clarity, navigation
mode, and data variation is not a valid result. If the UI depends on remote
data, "No findings" is not valid unless empty, error, and relevant stale or
partial data states were checked or explicitly listed as not verified.

## Common Mistakes

- Judging from JSX/CSS alone and assuming the browser will look fine.
- Checking only the seeded happy path with short labels and one viewport.
- Checking only one color theme and missing unreadable text in the other theme.
- Treating pastel, low-opacity, or "brand" colors as automatically acceptable
  while required button, tab, nav, or form text is hard to read.
- Approving a segmented control or tab group because one side is selected,
  without checking whether both the selected state and label contrast are clear.
- Treating forms as generic spacing blocks and missing unreadable entered
  values, covered validation errors, keyboard-covered submit buttons, or
  ambiguous required/disabled/saved states.
- Ignoring an auth screen's surrounding navigation and missing that a bottom nav
  or highlighted account tab conflicts with the login/signup flow.
- Listing findings in discovery order instead of grouping related problems by
  failure mode and user impact.
- Ignoring existing shared components, tokens, or utility classes and accepting
  one-off UI that does not match the surrounding product.
- Treating wasted space, unstable dimensions, or almost-aligned regions as taste
  instead of product quality problems.
- Accepting a screen that merely stacks controls and content on the left without
  checking whether the overall composition, grouping, and scan path feel designed.
- Treating no data and data load failure as the same empty state, especially when
  the UI says "No data" after an API/query error.
- Treating stale cached data, partial responses, or failed refreshes as a normal
  success state because some data is still visible.
- Judging an empty/error/loading state only by its copy, retry affordance, and
  stability while skipping its composition within the region — a placeholder
  pinned to the left or top with a large dead area is a layout defect even when
  the message and button are correct.
- Reporting only component-level polish and missing the page-level composition:
  where the user starts, what they scan next, and where primary actions belong.
- Accepting text-like buttons or link-like static labels because the event handler
  is obvious from code.
- Fixing visual issues silently when the user asked to review what looks weird.
- Reporting "responsive works" without naming the tested widths and observed
  layout behavior.
- Seeing a region rendered as a thin line, empty, clipped, or mispositioned and
  concluding the data is missing or the leaf CSS is wrong, instead of tracing the
  ancestor/context chain where the layout actually breaks.
- Trusting that an element is sized or positioned correctly because its own CSS
  looks right, without verifying every ancestor actually forwards the size,
  containing block, overflow, and stacking context it depends on.
- Restoring a broken layout with an ID/class rule that overrides the `hidden`
  attribute, leaving panels that should be hidden visible.
- Approving charts or metric cards because they render without checking units,
  time range, legend contrast, tooltip reachability, stale/partial data states,
  and large/localized number formatting.
- Checking only first paint and missing sticky headers, fixed footers, nested
  scroll areas, or mobile safe-area issues that appear after scrolling.
