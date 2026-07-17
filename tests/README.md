# UI Audit — defect fixtures

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
| `layout.html` | layout polish regressions | lone narrow element on its own row, too many buttons in one row |
| `modal.html` / `modal-trapped.html` / `modal-wrong-wrap.html` | leaky, correct, and internally mis-wrapped modal focus | trusted initial/forward/reverse focus containment; correct trap emits no `focusTrapLeak` |
| `focus-obscured.html` | a control painted completely behind fixed UI | `focusObscured` from trusted Tab traversal |
| `state-setup-modal.html` | an interaction state closed on first load | structured click + visible expectation, followed by modal keyboard audit |
| `context-isolation.html` | storage leaking between matrix cells | fresh storage in every browser context |
| `clean.html` | a well-built version of the same screens | **nothing** (zero findings) |

`expected.json` is the machine-readable contract: per fixture, the rules that must fire
(with optional text match), and `expectZeroFindings` for the clean baseline.

## Verify a change to `audit.js`

Serve the fixture directory and point a runner at it:

```bash
# from skills/ui-audit/tests/fixtures
python3 -m http.server 8788 &
node ../../scripts/audit-chrome.mjs http://localhost:8788 \
  --config /tmp/cfg.json --out-dir /tmp/ui-audit-check --no-screenshots
# cfg.json: { "routes": ["/login.html","/dashboard.html","/kitchensink.html","/layout.html","/clean.html"],
#             "viewports":[{"name":"mobile","width":390,"height":844,"isMobile":true,"dpr":3}],
#             "themes":["dark"], "states":["default"], "scrollPositions":["top","bottom"] }
```

Then check `findings.json` against `expected.json`: every `mustHit` rule is present, every
`mustNotHit` rule is absent, and `clean.html` has zero findings. Keyboard contracts require
a runner because synthetic in-page events cannot prove Tab behavior. For DOM-only rules,
inject `audit.js` via MCP/DevTools and call `__uiAudit({isMobile:true})`.

Validated baseline: login auth defects · dashboard sticky-overlap at bottom ·
kitchensink all defect classes · layout polish rules · clean **0**.

## Gotcha (already handled in both runners)

Do **not** create a mobile context with `is_mobile=True` + `device_scale_factor>1` — Chromium
then reports a bogus `innerHeight` (`height × (dpr+1)`), silently breaking every geometry
rule. Use `has_touch` / CDP `mobile:false` and pass `isMobile` to the audit config instead.
