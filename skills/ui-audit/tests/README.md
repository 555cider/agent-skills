# UI Audit — defect fixtures

These are the RED/GREEN record for `scripts/audit.js`: each broken fixture has planted
defects the audit MUST catch; clean and realistic fixtures are precision gates. The
contract checks measured findings and review advisories independently.

## Fixtures

| File | Reproduces | Must trigger |
|------|-----------|--------------|
| `login.html` | the real dark-theme auth screen | washed-out unselected tab, pale brand-button text (Google/Kakao/Naver), low-contrast placeholders, selected-state inversion, authenticated-nav-on-auth conflict |
| `dashboard.html` | the real dark dashboard | fixed bottom nav clipping the last content row (only visible at scroll-bottom) |
| `kitchensink.html` | a broad defect set | horizontal overflow, ancestor collapse, text clip, target size, off-viewport content, sticky overlap, invisible content, broken image, CLS |
| `layout.html` | layout polish regressions | lone narrow element on its own row, too many buttons in one row |
| `modal.html` / `modal-trapped.html` / `modal-wrong-wrap.html` | leaky, correct, and internally mis-wrapped modal focus | trusted initial/forward/reverse focus containment; correct trap emits no `focusTrapLeak` |
| `focus-obscured.html` | a control painted completely behind fixed UI | `focusObscured` from trusted Tab traversal |
| `state-setup-modal.html` | an interaction state closed on first load | structured click + visible expectation, followed by modal keyboard audit |
| `context-isolation.html` | storage leaking between matrix cells | fresh storage in every browser context |
| `interaction-layout.html` | screenshot-like search/count/sort control group | row inset mismatch, orphaned sort control, dense cursor-only hover |
| `hover-valid.html` | valid background, underline, child-icon, and tooltip hover treatments | no `missingHoverFeedback` |
| `target-size.html` | WCAG 24px spacing exception | 4px-gap pair passes, 2px-gap pair fails, inline/exempt targets pass |
| `focus-indicator.html` | trusted focus appearance | missing and low-contrast rings fail; complex ring requires review |
| `adaptations.html` | 200% zoom and 320px reflow | overflow appears only in adaptation cells; internal table scroll passes |
| `state-mock.html` | CDP Fetch forcing | empty/error/loading each records a real interception |
| `realistic-clean.html` | anonymized app-shell patterns | CTA pair, text descendants, skip link, and valid status tabs stay quiet |
| `clean.html` | a well-built version of the same screens | **nothing** (zero findings) |

`expected.json` uses `mustHit`, `mustNotHit`, `mustAdvise`, and `mustNotAdvise`, plus
zero-finding/advisory precision gates.

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

Then check `findings.json` and `advisories.json` against `expected.json`. Keyboard contracts require
a runner because synthetic in-page events cannot prove Tab behavior. Hover contracts likewise
require trusted runner pointer movement; dispatching `mouseover` in the page is not proof. For DOM-only rules,
inject `audit.js` via MCP/DevTools and call `__uiAudit({isMobile:true})`.

The automated suite also verifies schema v2, state interception proof, worker determinism,
browser-context isolation, suppression behavior, and honest incomplete-probe coverage.

## Gotcha (handled by the canonical runner)

Do **not** create a mobile context with `is_mobile=True` + `device_scale_factor>1` — Chromium
then reports a bogus `innerHeight` (`height × (dpr+1)`), silently breaking every geometry
rule. Use `has_touch` / CDP `mobile:false` and pass `isMobile` to the audit config instead.
