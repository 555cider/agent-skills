# UI Splint — findings & coverage JSON contract

`window.__uiSplintAudit(config)` returns one **report** object per render state.
Either batch runner — `run-ui-splint.py` (Playwright) or `audit-chrome.mjs` (CDP) —
aggregates per-cell reports into `findings.json` (a flat array of findings) and
`coverage.json` (the matrix that was actually exercised).

## `config` (input, all optional)

```jsonc
{
  "route": "/login",        // label only, for the report
  "theme": "dark",          // label; falls back to prefers-color-scheme
  "state": "default",       // label, e.g. default|empty|error|loading
  "isMobile": true,         // run tap-target rules; default = innerWidth <= 600
  "contrast": { "normal": 4.5, "large": 3.0, "washedOut": 1.3, "placeholderFail": 3.0 },
  "tap": { "fail": 24, "risk": 44, "crowdGap": 8 },
  "cls": { "risk": 0.1, "fail": 0.25 },
  "layout": { "loneNarrowWidth": 180, "maxButtonsInRow": 4 },
  "overflowTolerancePx": 1,
  "collapsePx": 3,
  "mediaAspectTolerance": 0.05,
  "authedNavWords": ["my", "account", "마이", "..."],
  "whitelist": ["#known-ok", ".third-party-widget"], // suppress findings on elements matching these OR inside their subtree
  "baseline": [{ "rule": "effectiveContrast", "selector": "..." }], // approved findings to suppress
  "maxFindingsPerRule": 60,
  "maxPolish": 15
}
```

## report (output of `__uiSplintAudit`)

```jsonc
{
  "meta": {
    "url": "http://localhost:3000/login",
    "route": "/login", "theme": "dark", "state": "default",
    "viewport": { "w": 390, "h": 844, "dpr": 3 },
    "isMobile": true, "scrollY": 0, "ts": null   // per-report meta; Date is deliberately not read in-page.
    // Runners discard report meta and stamp coverage.generated_at once in coverage.json.
  },
  "coverage": {
    "rulesRun": ["effectiveContrast", "..."],
    "rulesSkipped": ["ruleName: error message"],  // a rule that threw; investigate, do not ignore
    "elementsScanned": 142,
    "counts": { "Fail": 3, "Risk": 2, "Polish": 0 }
  },
  "findings": [ /* finding objects, see below */ ]
}
```

## finding object

```jsonc
{
  "rule": "effectiveContrast",          // which detector fired (see audit-rules.md)
  "severity": "Fail",                    // Fail | Risk | Polish — COMPUTED, do not downgrade by taste
  "confidence": "auto-measured",         // auto-measured | needs-visual | visual-judgment
  "selector": "html > body > button.kakao",  // CSS path to the element
  "message": "Text \"카카오 로그인\" contrast 1.02:1 is below 4.5:1.",
  "measured": { "ratio": 1.02, "fg": "rgb(...)", "bg": "rgb(...)", "fontPx": 17 },
  "threshold": { "min": 4.5 },
  "rect": { "x": 16, "y": 320, "w": 358, "h": 56 },  // viewport coords for an evidence crop; may be null
  "suggestedFix": "Kakao spec: #191919 text on #FEE500.",
  "scroll": "bottom",      // added by the runner: which scroll position surfaced it
  "cell": { "route": "/", "viewport": "mobile", "theme": "dark", "state": "default" },  // runner adds; points to the highest-severity evidence
  "cells": [               // runner adds: distinct matrix cells that surfaced this aggregate
    { "route": "/", "viewport": "mobile", "theme": "dark", "state": "default" }
  ],
  "instances": 1           // runner adds: how many cell/scroll findings were aggregated
}
```

Batch runners aggregate matching `rule+selector` findings only within the same route.
When several cells on that route produce the same aggregate, the representative finding
and backward-compatible `cell` field come from the worst severity (`Fail` > `Risk` >
`Polish`), while `cells` retains every affected matrix cell.

### `confidence` — how to treat each tier

| confidence | meaning | how to report |
|------------|---------|---------------|
| `auto-measured` | a number past a threshold backs it | report at its computed severity, including `Fail` |
| `needs-visual` | candidate found, but the measurement is uncertain (text over a gradient/image; CLS observer not installed) | **must resolve** — pixel-sample a screenshot crop or install the observer; never assert a number you didn't measure |
| `visual-judgment` | a heuristic/structural signal, not a hard number (auth-mode conflict, disabled-looking primary, selected-state inversion, design drift) | cap at `Risk` until visually confirmed; pair with a measured `Fail` to escalate |

## `coverage.json` (runner)

```jsonc
{
  "base_url": "http://localhost:3000",
  "generated_at": "2026-07-07T03:00:00.000Z",   // runner stamps run time (UTC ISO-8601)
  "matrix": [
    { "route": "/", "viewport": "mobile", "theme": "dark", "state": "default",
      "status": "checked", "counts": { "Fail": 1, "Risk": 0, "Polish": 0 } },
    { "route": "/", "viewport": "desktop", "theme": "light", "state": "error",
      "status": "error", "error": "TimeoutError: ..." },  // surfaces as "Not verified"
    { "route": "/", "viewport": "mobile", "theme": "dark", "state": "empty",
      "status": "not-forced", "reason": "data state not forced ..." }  // audit-chrome.mjs can't mock network
  ],
  "totals": { "Fail": 1, "Risk": 0, "Polish": 0 }
}
```

### the synthetic `coverage` rule

When a single rule produces more than `maxFindingsPerRule` findings, the extras are dropped
and one bookkeeping finding is emitted with `rule: "coverage"`, `severity: "Polish"`, noting how
many were capped. It is not a UI defect — it flags a repeated defect worth fixing at the
shared-component level. Consumers filtering by the detector rules in `audit-rules.md` should
expect this extra rule name.

Cell `status` values: `checked` (audit ran on the intended state), `not-forced` (the CDP
runner cannot mock this data state, or the Playwright runner installed a mock but no request
matched `apiMockPattern` — honest, but **not verified**), `error` (navigation/HTTP failure,
or an audit rule threw and was recorded in `rulesSkipped`). A cell that is anything other
than `checked`, or any rule in `rulesSkipped`, must be reported as **Not verified** and
blocks the runner's completion gate. Re-run `not-forced` cells with a matching Playwright
route mock or MCP route mocks to actually exercise them.
