# UI Audit v2 — configuration and output contract

`audit-chrome.mjs` is the canonical runner. It aggregates one `window.__uiAudit()` report per rendered matrix cell into three JSON documents. Schema v2 is intentionally not compatible with the former flat `findings.json` array.

## Runner configuration

```jsonc
{
  "routes": ["/"],
  "viewports": [{ "name": "desktop", "width": 1280, "height": 900, "isMobile": false, "dpr": 1 }],
  "themes": ["light", "dark"],
  "states": ["default", "empty", "error", "loading"],
  "adaptations": ["zoom-200", "reflow-320"],
  "workers": 2,
  "scrollPositions": ["top", "bottom"],
  "settleMs": 400,
  "waitForSelector": null,
  "themeInitScripts": { "app-dark": "document.documentElement.dataset.theme='dark'" },
  "apiMockPattern": "**/api/**",
  "stateMocks": {
    "empty": [{ "pattern": "**/api/items", "status": 200, "contentType": "application/json", "body": [] }],
    "loading": [{ "pattern": "**/api/items", "hold": true }]
  },
  "stateSetups": {
    "dialog-open": {
      "actions": [{ "type": "click", "selector": "#open" }],
      "expect": [{ "selector": "[role=dialog]", "state": "visible" }]
    }
  },
  "keyboardProbe": { "maxSteps": 120, "settleMs": 0 },
  "hoverProbe": { "maxTargets": 80, "settleMs": 0, "maxWaitMs": 250, "denseGapPx": 12 },
  "baseline": [{ "rule": "effectiveContrast", "selector": "#known" }],
  "auditConfig": {
    "whitelist": [".third-party"],
    "maxFindingsPerRule": 60,
    "maxPolish": 15
  }
}
```

`stateMocks.<state>` must be an array. Every item has a `pattern` and exactly one of `body` or `hold: true`; `status` defaults to 200 and `contentType` to `application/json`. Non-string bodies are JSON encoded. Empty/error/loading fallback mocks use `apiMockPattern` when no explicit rule exists.

The state is verified only after at least one request is intercepted. A successful structured setup may independently prove a custom interaction state; if an explicit mock is also configured, its interception is still required.

## In-page report

```jsonc
{
  "meta": {
    "url": "http://localhost:3000/",
    "route": "/", "theme": "dark", "state": "default",
    "viewport": { "w": 390, "h": 844, "dpr": 3 },
    "isMobile": true, "scrollY": 0, "ts": null
  },
  "coverage": {
    "rulesRun": ["effectiveContrast", "targetSizeMinimum"],
    "rulesSkipped": [],
    "elementsScanned": 142,
    "counts": { "Fail": 1, "Risk": 0, "Polish": 0 },
    "advisoryCounts": { "required": 0, "optional": 2 },
    "suppressed": {
      "whitelist": 0, "baseline": 1, "perRuleCap": 0, "advisoryCap": 4,
      "byRule": { "designSystemDrift": 4 }
    }
  },
  "findings": [],
  "advisories": []
}
```

The first scroll position runs all rules. Later positions run only `phase: viewport` rules, currently the scroll-dependent sticky/occlusion checks. Whitelist and baseline suppression happen before per-rule and advisory caps.

## Signal shape

```jsonc
{
  "rule": "targetSizeMinimum",
  "severity": "Fail",
  "confidence": "auto-measured",
  "category": "accessibility",
  "standard": "WCAG 2.5.8",
  "selector": "button#compact",
  "message": "Pointer target 20×20px is below 24px and its spacing exception fails.",
  "measured": { "w": 20, "h": 20, "nearestGapPx": -2, "nearestSelector": "button#peer" },
  "threshold": { "min": 24, "spacingCircleDiameter": 24 },
  "rect": { "x": 16, "y": 120, "w": 20, "h": 20 },
  "suggestedFix": "Increase the hit area or provide enough separation.",
  "scroll": "top",
  "cell": { "route": "/", "viewport": "desktop", "theme": "light", "state": "default", "adaptation": "none" },
  "cells": [],
  "instances": 1
}
```

Advisories use the same evidence shape and add `review`:

- `required`: uncertain Risk that must be visually resolved or baselined.
- `optional`: Polish heuristic that does not affect the exit code.

`confidence` values are `auto-measured`, `needs-visual`, and `visual-judgment`. `needs-visual` and non-Polish `visual-judgment` signals are required advisories; Polish signals are optional advisories.

## `findings.json`

```json
{
  "schemaVersion": 2,
  "findings": [],
  "totals": { "Fail": 0, "Risk": 0, "Polish": 0 }
}
```

Only high-confidence measured signals appear here. `Polish` remains in the totals shape for stable consumers but normally stays zero because Polish signals belong to advisories.

## `advisories.json`

```json
{
  "schemaVersion": 2,
  "advisories": [],
  "totals": { "required": 0, "optional": 0 }
}
```

## `coverage.json`

```jsonc
{
  "schemaVersion": 2,
  "base_url": "http://localhost:3000",
  "generated_at": "2026-07-20T00:00:00.000Z",
  "runner": { "name": "audit-chrome", "version": 2, "workers": 2, "durationMs": 4120 },
  "matrix": [{
    "index": 0,
    "route": "/", "viewport": "desktop", "theme": "light", "state": "empty", "adaptation": "reflow-320",
    "themeDriver": "media", "stateDriver": "configured-mock", "interceptions": 1,
    "setupDriver": "none",
    "stateSetup": { "status": "not-configured", "actions": 0, "assertions": 0 },
    "keyboardProbe": { "status": "checked", "expected": 8, "visited": 8, "maxSteps": 120 },
    "hoverProbe": { "status": "not-applicable", "expected": 0, "checked": 0, "missing": 0 },
    "rulesRun": ["effectiveContrast", "horizontalOverflow"],
    "suppressed": { "whitelist": 0, "baseline": 0, "perRuleCap": 0, "advisoryCap": 0, "byRule": {} },
    "counts": { "Fail": 0, "Risk": 0, "Polish": 0 },
    "advisoryTotals": { "required": 0, "optional": 0 },
    "timings": { "navigationMs": 800, "stateSetupMs": 0, "detectMs": 80, "keyboardMs": 300, "pointerMs": 0, "screenshotMs": 20, "totalMs": 1250 },
    "status": "checked"
  }],
  "totals": { "Fail": 0, "Risk": 0, "Polish": 0 },
  "advisoryTotals": { "required": 0, "optional": 0 }
}
```

Cells are sorted by configuration index even when workers run concurrently. Fresh browser contexts isolate cookies, local storage, cache, and service workers.

Cell status:

- `checked`: intended state and all required probes/rules were verified.
- `not-forced`: a non-default state lacked interception/setup proof.
- `error`: navigation, theme, mock, setup, rule, or trusted-probe failure.

Any status other than `checked`, any un-baselined Fail, or any required advisory makes the runner exit 1. All three JSON documents are still written.
