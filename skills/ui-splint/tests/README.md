# UI Splint — defect fixtures

These are the RED/GREEN record for `scripts/audit.js`: each broken fixture has planted
defects the audit MUST catch; `clean.html` is the precision gate (the audit must stay
silent on good UI — no cry-wolf). They double as a compact, runnable spec of what the
detector covers.

## Fixtures

| File | Reproduces | Must trigger |
|------|-----------|--------------|
| `login.html` | the real dark-theme auth screen | washed-out unselected tab, pale brand-button text (Google/Kakao/Naver), low-contrast placeholders, selected-state inversion, authenticated-nav-on-auth conflict |
| `dashboard.html` | the real dark dashboard | fixed bottom nav clipping the last content row (only visible at scroll-bottom) |
| `kitchensink.html` | a broad defect set | horizontal overflow, ancestor-collapsed scroll region, text escape + clamp, tiny/crowded tap targets, off-viewport element, content under a fixed bar, opacity:0 content, broken image, CLS |
| `clean.html` | a well-built version of the same screens | **nothing** (zero findings) |

`expected.json` is the machine-readable contract: per fixture, the rules that must fire
(with optional text match), and `expectZeroFindings` for the clean baseline.

## Verify a change to `audit.js`

Serve the fixture directory and point a runner at it:

```bash
# from skills/ui-splint/tests/fixtures
python3 -m http.server 8788 &
node ../../scripts/audit-chrome.mjs http://localhost:8788 \
  --config /tmp/cfg.json --out-dir /tmp/ui-splint-check --no-screenshots
# cfg.json: { "routes": ["/login.html","/dashboard.html","/kitchensink.html","/clean.html"],
#             "viewports":[{"name":"mobile","width":390,"height":844,"isMobile":true,"dpr":3}],
#             "themes":["dark"], "states":["default"], "scrollPositions":["top","bottom"] }
```

Then check `findings.json` against `expected.json`: every `mustHit` rule present for its
fixture, and `clean.html` with zero findings. (Or inject `audit.js` via the MCP/DevTools
console and call `__uiSplintAudit({isMobile:true})` — see `../SKILL.md`.)

Validated baseline (mobile/dark): login 7 Fail / 2 Risk · dashboard sticky-overlap at
bottom · kitchensink all defect classes · clean **0**.

## Gotcha (already handled in both runners)

Do **not** create a mobile context with `is_mobile=True` + `device_scale_factor>1` — Chromium
then reports a bogus `innerHeight` (`height × (dpr+1)`), silently breaking every geometry
rule. Use `has_touch` / CDP `mobile:false` and pass `isMobile` to the audit config instead.
