# Harness pages

A harness page mounts the screen's own module with fixture data, and the runner audits it like any
route. Use one when the real route sits behind login, an app shell, or a backend that cannot be
seeded per cell. This skill ships no harness server: the project serves its harness pages itself,
usually from a project-specific skill or test folder outside the module's source.

A harness page is evidence only while it renders the way the app does:

- **Take the head from the app entry at serve time.** The project's harness server copies the app
  entry's stylesheet and classic-script tags, in order, into a `<!-- ui-audit:app-head -->` marker
  in each harness page. A head copied by hand drifts: a base widget sheet goes missing (so button
  heights differ), or a theme sheet moves ahead of the component sheets (so other rules win). The
  harness then measures a screen the app never draws.
- **Use the width the module gets, not the window width.** Inside the shell, a rail or sidebar
  takes part of the window, so a 1000 px window leaves the content roughly 760 px. Add those
  content widths as viewports alongside the window widths.
- **Make fixtures cover the states and the density at once.** Include every status chip and badge,
  the longest names, the second language, and an empty variant as its own route.
- **Drive a data-attribute theme with `themeInitScripts`** (`data-style="field"`,
  `data-theme="dark"`), not with a query parameter the harness reads by itself. The theme then
  stays a matrix axis, and `coverage.json` records which theme driver ran.
- **Name the harness as the route in the report.** The report says the harness was audited; it does
  not cover the shell itself or the live data path.
