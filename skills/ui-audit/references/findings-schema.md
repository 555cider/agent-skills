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
    "empty": [{ "pattern": "**/api/items", "method": "GET", "minMatches": 1, "status": 200, "contentType": "application/json", "body": [] }],
    "loading": [{ "pattern": "**/api/items", "method": "GET", "hold": true }]
  },
  "stateSetups": {
    "dialog-open": {
      "actions": [{ "type": "click", "selector": "#open" }],
      "expect": [{ "selector": "[role=dialog]", "state": "visible" }]
    },
    "import-dialog": {
      "timeoutMs": 45000,
      "actions": [
        { "type": "click", "selector": "button[aria-label='파일']" },
        { "type": "upload", "selector": "[data-testid='import-ifc']", "files": ["fixtures/two-storey.ifc"] }
      ],
      "expect": [{ "selector": "[role=dialog]", "state": "visible" }]
    }
  },
  "keyboardProbe": { "maxSteps": 120, "settleMs": 0 },
  "hoverProbe": { "maxTargets": 80, "settleMs": 0, "maxWaitMs": 250, "denseGapPx": 12 },
  "baseline": [{ "rule": "effectiveContrast", "selector": "#known" }],
  "auditConfig": {
    "contrast": { "normal": 4.5, "large": 3.0, "nonText": 3.0, "colorCue": 3.0 },
    "polish": { "bodyTextMinChars": 40, "bodyTextMinLines": 3, "bodyLineHeight": 1.5 },
    "whitelist": [".third-party"],
    "maxFindingsPerRule": 60,
    "maxPolish": 15
  }
}
```

`routes`, `viewports`, `themes`, `states`, and `scrollPositions` are required non-empty arrays after defaults and CLI overrides are merged. Routes, themes, and states contain non-empty strings; viewport dimensions and DPR are positive; `isMobile` is boolean; scroll positions are `top`, `mid`, or `bottom`. Built-in `light`/`dark` themes use media emulation. Every custom theme requires a non-empty `themeInitScripts.<theme>` script. Configuration errors exit 2 before Chrome launches.

`stateMocks.<state>` must be a non-empty array when declared. Every item has a `pattern` and exactly one of `body` or `hold: true`; `method` defaults to `any`, `minMatches` defaults to `1`, `status` defaults to 200, and `contentType` defaults to `application/json`. Methods are case-normalized HTTP tokens; `minMatches` is an integer of at least 1. Non-string bodies are JSON encoded. Empty/error/loading fallback mocks use `apiMockPattern` when no explicit rule exists.

Every explicit rule is verified independently after its URL pattern, request method, and minimum match count are satisfied. This applies to explicit mocks on `default` as well as non-default states. A successful structured setup may independently prove a custom interaction state only when no incomplete explicit mock contract remains.

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
    "rulesExpected": ["effectiveContrast", "targetSizeMinimum"],
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

The first scroll position runs all rules. Later positions run only `phase: viewport` rules, currently the scroll-dependent sticky/occlusion checks. `rulesExpected` is the applicable rule manifest for that invocation. Every report must provide array-valued `rulesExpected`, `rulesRun`, and `rulesSkipped`; the expected manifest must be non-empty. The runner validates every invocation independently before aggregating it into a cell, so a rule reported at the top cannot mask its omission from a later viewport report. Whitelist and baseline suppression happen before per-rule and advisory caps.

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

Rule identifiers are extensible within schema v2. Adding a detector changes
`coverage.rulesRun` and may add signals without changing the document shape or
schema version.

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
    "stateMock": {
      "configured": true, "explicit": true, "fallback": false,
      "driver": "configured-mock", "status": "checked",
      "rules": [{
        "pattern": "**/api/items", "method": "GET", "minMatches": 1,
        "matches": 1, "held": 0, "status": "checked"
      }]
    },
    "setupDriver": "none",
    "stateSetup": { "status": "not-configured", "actions": 0, "assertions": 0 },
    "keyboardProbe": { "status": "checked", "expected": 8, "visited": 8, "maxSteps": 120 },
    "hoverProbe": { "status": "not-applicable", "expected": 0, "checked": 0, "missing": 0 },
    "escapeProbe": { "status": "checked", "dialogs": 1, "modalSelector": "div#confirm", "probed": 1, "closed": 1 },
    "rulesExpected": ["effectiveContrast", "stickyOverlapContent"],
    "rulesRun": ["effectiveContrast", "stickyOverlapContent"],
    "ruleCoverage": [{
      "scroll": "top", "phase": "all", "status": "checked",
      "rulesExpected": ["effectiveContrast", "stickyOverlapContent"],
      "rulesRun": ["effectiveContrast", "stickyOverlapContent"],
      "rulesMissing": [], "rulesSkipped": []
    }, {
      "scroll": "bottom", "phase": "viewport", "status": "checked",
      "rulesExpected": ["stickyOverlapContent"],
      "rulesRun": ["stickyOverlapContent"],
      "rulesMissing": [], "rulesSkipped": []
    }],
    "suppressed": { "whitelist": 0, "baseline": 0, "perRuleCap": 0, "advisoryCap": 0, "byRule": {} },
    "counts": { "Fail": 0, "Risk": 0, "Polish": 0 },
    "advisoryTotals": { "required": 0, "optional": 0 },
    "timings": { "navigationMs": 800, "stateSetupMs": 0, "detectMs": 80, "keyboardMs": 300, "pointerMs": 0, "escapeMs": 10, "screenshotMs": 20, "totalMs": 1250 },
    "status": "checked"
  }],
  "totals": { "Fail": 0, "Risk": 0, "Polish": 0 },
  "advisoryTotals": { "required": 0, "optional": 0 }
}
```

Cells are sorted by configuration index even when workers run concurrently. Fresh browser contexts isolate cookies, local storage, cache, and service workers.

`ruleCoverage[]` preserves the manifest proof for each `window.__uiAudit()` invocation in configured scroll order. Each entry records `scroll`, `phase`, `rulesExpected`, `rulesRun`, `rulesMissing`, `rulesSkipped`, and `checked | error`; error entries also include `error`. Missing/non-array manifest fields, an empty expected manifest, skipped rules, or expected rules absent from that report's run list are errors. The cell-level `rulesExpected`, `rulesRun`, `rulesMissing`, and `rulesSkipped` fields remain aggregate compatibility evidence, not the completeness decision. Any error entry makes the cell an error even when the cell-level unions look complete.

`escapeProbe` records the trusted-Escape contract for the topmost modal in the cell: `checked` with `closed: 1` when the dialog dismissed, `checked` with `closed: 0` alongside a `modalEscapeUnhandled` Fail when it did not, and `not-applicable` when no modal was open or the dialog carried a non-empty `data-ui-audit-escape-exempt` reason. The probe is destructive — it closes dialogs — so the runner fires it last in the cell and reads no further evidence from the DOM afterwards. Any other status makes the cell an error.

`interceptions` remains the schema-v2 aggregate match count for existing consumers. New consumers should use `stateMock.rules[]` to prove each declared rule. Each rule object retains `pattern`, normalized `method`, `minMatches`, observed `matches`, held-request count, and `checked | not-forced` status.

Cell status:

- `checked`: intended state, every explicit mock rule, and all required probes/rules were verified.
- `not-forced`: a state lacked setup proof or at least one explicit mock rule missed its method/count contract.
- `error`: navigation, theme, mock, setup, rule, or trusted-probe failure.

Any status other than `checked`, any un-baselined Fail, or any required advisory makes the runner exit 1. All three JSON documents are still written.
