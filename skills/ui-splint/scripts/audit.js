/*
 * ui-splint deterministic audit — the SOURCE OF TRUTH for measurable UI defects.
 *
 * Pure DOM/CSSOM/geometry. No dependencies. Safe to inject into any live page via
 * Playwright `page.evaluate`, Playwright-MCP `browser_evaluate`, chrome-devtools
 * `evaluate_script`, or DevTools console. It MEASURES defects (contrast ratios,
 * overlaps, overflow, collapsed regions, tap targets, ...) instead of asking a
 * model to eyeball a downscaled screenshot — the channel that misses them.
 *
 * Usage:
 *   1. (optional, BEFORE navigation) install the layout-shift observer so CLS is
 *      captured from first paint:  window.__uiSplintInstallCLS && __uiSplintInstallCLS()
 *      The runner injects `__uiSplintInstallCLS` via add_init_script.
 *   2. After the page reaches the state you want to check, call:
 *        const report = window.__uiSplintAudit(config)   // returns JSON-able object
 *   3. The caller scrolls (top/mid/bottom), opens overlays, switches theme/state,
 *      and calls __uiSplintAudit again per cell. Geometry rules reflect the CURRENT
 *      scroll/overlay state, so call at scroll-bottom to catch sticky-bar overlap.
 *
 * Returns: { meta, coverage, findings[] }  — see references/findings-schema.md.
 *
 * Severity is COMPUTED from thresholds, never from feel:
 *   Fail  = broken now in the rendered state (measured past threshold).
 *   Risk  = will break with realistic data/state/locale/viewport, or near threshold.
 *   Polish= functional but visibly unpolished.
 * confidence: "auto-measured" (a number backs it) vs "needs-visual" (script found a
 *   candidate but a pixel/eye confirm is required, e.g. text over a gradient/image).
 */
(function (root) {
  'use strict';

  var cachedElements = [];
  var _getComputedStyle = root.getComputedStyle;
  function getComputedStyle(el, pseudo) {
    if (pseudo) return _getComputedStyle(el, pseudo);
    if (!el || el.nodeType !== 1) return null;
    if (!el.__cs) {
      el.__cs = _getComputedStyle(el);
      cachedElements.push(el);
    }
    return el.__cs;
  }
  var _getBoundingClientRect = root.Element ? root.Element.prototype.getBoundingClientRect : null;

  // ----- layout-shift (CLS) observer; install BEFORE navigation for full capture -----
  function installCLS() {
    if (root.__uiSplint && root.__uiSplint.clsInstalled) return;
    root.__uiSplint = root.__uiSplint || {};
    root.__uiSplint.cls = 0;
    root.__uiSplint.clsSources = [];
    try {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.hadRecentInput) return;
          root.__uiSplint.cls += e.value;
          (e.sources || []).forEach(function (s) {
            if (s.node && root.__uiSplint.clsSources.length < 20) {
              root.__uiSplint.clsSources.push({ value: e.value, node: describe(s.node) });
            }
          });
        });
      });
      po.observe({ type: 'layout-shift', buffered: true });
      root.__uiSplint.clsInstalled = true;
    } catch (err) { /* layout-shift unsupported */ }
  }
  root.__uiSplintInstallCLS = installCLS;

  // -------------------------------- defaults --------------------------------
  var DEFAULTS = {
    contrast: { normal: 4.5, large: 3.0, washedOut: 1.3, placeholderFail: 3.0 },
    tap: { fail: 24, risk: 44, crowdGap: 8 },     // CSS px (WCAG 2.5.8 = 24, comfortable = 44)
    overflowTolerancePx: 1,
    collapsePx: 3,
    cls: { risk: 0.1, fail: 0.25 },
    mediaAspectTolerance: 0.05,
    polish: { maxRadii: 4, maxShadows: 4, maxAccentHues: 6, maxFontPairs: 10, lineLenMin: 45, lineLenMax: 95, tinyTextPx: 11 },
    layout: { loneNarrowWidth: 180, maxButtonsInRow: 4 },
    // selectors matching authenticated destinations for the auth-mode-conflict rule
    authedNavWords: ['my', 'account', 'profile', 'mypage', '마이', '계정', '프로필', '내정보'],
    isMobile: null,        // null => infer from innerWidth <= 600
    whitelist: [],         // CSS selectors to ignore entirely
    baseline: [],          // [{rule, selector}] approved/known findings to suppress
    maxFindingsPerRule: 60,
    maxPolish: 15
  };

  function audit(userConfig) {
    var cfg = merge(DEFAULTS, userConfig || {});
    var isMobile = cfg.isMobile == null ? root.innerWidth <= 600 : !!cfg.isMobile;
    var findings = [];
    var rulesRun = [];
    var rulesSkipped = [];
    var ctx = { cfg: cfg, isMobile: isMobile, findings: findings, scanned: 0 };

    if (_getBoundingClientRect) {
      root.Element.prototype.getBoundingClientRect = function () {
        if (!this.__rect) {
          this.__rect = _getBoundingClientRect.call(this);
          cachedElements.push(this);
        }
        return this.__rect;
      };
    }

    function clearCache() {
      cachedElements.forEach(function (el) {
        delete el.__cs;
        delete el.__rect;
      });
      cachedElements = [];
      if (_getBoundingClientRect) {
        root.Element.prototype.getBoundingClientRect = _getBoundingClientRect;
      }
    }

    var RULES = [
      ['effectiveContrast', ruleContrast],
      ['placeholderContrast', rulePlaceholder],
      ['horizontalOverflow', ruleHOverflow],
      ['offViewport', ruleOffViewport],
      ['stickyOverlapContent', ruleStickyOverlap],
      ['ancestorCollapse', ruleCollapse],
      ['textClip', ruleTextClip],
      ['invisibleContent', ruleInvisibleContent],
      ['tapTarget', ruleTapTarget],
      ['disabledLookingPrimary', rulePrimaryAffordance],
      ['selectedStateAmbiguity', ruleSelectedState],
      ['authModeNavConflict', ruleAuthConflict],
      ['brokenOrDistortedMedia', ruleMedia],
      ['focusTrapLeak', ruleFocusTrap],
      ['layoutShiftCLS', ruleCLS],
      ['designSystemDrift', ruleDrift],
      ['loneNarrowElement', ruleLoneNarrow],
      ['excessiveButtonsInRow', ruleExcessiveButtons],
      ['tinyText', ruleTinyText],
      ['unlabeledInput', ruleUnlabeledInput],
      ['lineLength', ruleLineLength],
      ['inconsistentSiblingsSpacing', ruleInconsistentSpacing],
      ['textLineHeightOverlap', ruleTextLineHeightOverlap],
      ['emptyInteractiveTarget', ruleEmptyInteractiveTarget],
      ['misalignedRowItems', ruleMisalignedRowItems],
      ['accidentalFlexWrap', ruleAccidentalFlexWrap],
      ['nonScrollableOverflow', ruleNonScrollableOverflow],
      ['inconsistentBorderRadius', ruleInconsistentBorderRadius],
      ['excessiveFirstViewportSpacing', ruleExcessiveFirstViewportSpacing],
      ['buttonSelfHeightMismatch', ruleButtonHeightMismatch],
      ['stretchedIconDistortion', ruleStretchedIconDistortion],
      ['missingClickableCursor', ruleMissingClickableCursor],
      ['missingModalBackdrop', ruleMissingModalBackdrop]
    ];

    try {
      RULES.forEach(function (pair) {
        var name = pair[0], fn = pair[1];
        try {
          var before = findings.length;
          fn(ctx);
          rulesRun.push(name);
          // cap volume per rule
          var added = findings.length - before;
          if (added > cfg.maxFindingsPerRule) {
            findings.splice(before + cfg.maxFindingsPerRule, added - cfg.maxFindingsPerRule);
            ctx.findings.push(mk('coverage', 'Polish', 'auto-measured', 'html',
              name + ' produced ' + added + ' findings; capped at ' + cfg.maxFindingsPerRule, {}, {}, null,
              'Fix the shared component/token; this defect repeats.'));
          }
        } catch (err) {
          rulesSkipped.push(name + ': ' + (err && err.message || err));
        }
      });
    } finally {
      clearCache();
    }

    // suppress whitelist + baseline
    var clean = findings.filter(function (f) {
      if (cfg.whitelist.some(function (s) { return whitelisted(f, s); })) return false;
      if (cfg.baseline.some(function (b) { return b.rule === f.rule && b.selector === f.selector; })) return false;
      return true;
    });
    // cap total polish volume
    var polishCount = 0;
    clean = clean.filter(function (f) {
      if (f.severity !== 'Polish') return true;
      polishCount++;
      return polishCount <= cfg.maxPolish;
    });

    var counts = { Fail: 0, Risk: 0, Polish: 0 };
    clean.forEach(function (f) { counts[f.severity] = (counts[f.severity] || 0) + 1; });

    return {
      meta: {
        url: location.href,
        route: (userConfig && userConfig.route) || location.pathname,
        viewport: { w: root.innerWidth, h: root.innerHeight, dpr: root.devicePixelRatio || 1 },
        theme: (userConfig && userConfig.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        state: (userConfig && userConfig.state) || 'default',
        isMobile: isMobile,
        scrollY: root.scrollY,
        ts: null // per-report; Date is not read in-page. Runner stamps coverage.generated_at.
      },
      coverage: {
        rulesRun: rulesRun,
        rulesSkipped: rulesSkipped,
        elementsScanned: ctx.scanned,
        counts: counts
      },
      findings: clean
    };
  }

  // ------------------------------- rules -------------------------------

  function ruleContrast(ctx) {
    var cfg = ctx.cfg;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var seen = new Set();
    var n;
    while ((n = walker.nextNode())) {
      // skip emoji/symbol/punctuation-only runs — their contrast is not meaningful
      if (!/[\p{L}\p{N}]/u.test(n.textContent)) continue;
      var el = n.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el) || isExempt(el)) continue;
      ctx.scanned++;
      var cs = getComputedStyle(el);
      var fg = parseColor(cs.color);
      if (!fg) continue;
      var bg = effectiveBg(el);
      var fgOnBg = fg[3] < 1 ? composite(fg, bg.rgb) : fg.slice(0, 3);
      var ratio = contrast(fgOnBg, bg.rgb);
      var px = parseFloat(cs.fontSize);
      var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
      var large = px >= 24 || (px >= 18.66 && bold);
      var min = large ? cfg.contrast.large : cfg.contrast.normal;
      if (ratio >= min) continue;

      var txt = el.textContent.trim().slice(0, 40);
      // normal text below its min is a real Fail; large text is Risk unless washed-out (near 1:1).
      var sev = large ? (ratio < cfg.contrast.washedOut ? 'Fail' : 'Risk') : 'Fail';
      var conf = bg.indeterminate ? 'needs-visual' : 'auto-measured';
      if (bg.indeterminate && ratio >= cfg.contrast.washedOut) {
        // can't be sure over gradient/image unless it's near 1:1
        ctx.findings.push(mk('effectiveContrast', 'Risk', 'needs-visual', cssPath(el),
          'Text "' + txt + '" may fail contrast over a gradient/image/overlapping surface — pixel-confirm needed.',
          { ratioVsResolvedBg: round2(ratio), bgIndeterminateReason: bg.reason }, { min: min }, rectOf(el),
          'Sample the text pixels from a screenshot crop; ensure ' + min + ':1 against the actual rendered background.'));
        continue;
      }
      ctx.findings.push(mk('effectiveContrast', sev, conf, cssPath(el),
        'Text "' + txt + '" contrast ' + round2(ratio) + ':1 is below ' + min + ':1.',
        { ratio: round2(ratio), fg: rgbStr(fgOnBg), bg: rgbStr(bg.rgb), fontPx: px, bold: bold, large: large },
        { min: min }, rectOf(el),
        brandFix(bg.rgb) || ('Raise foreground/background contrast to at least ' + min + ':1.')));
    }
  }

  function rulePlaceholder(ctx) {
    var cfg = ctx.cfg;
    qsa('input[placeholder], textarea[placeholder]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      ctx.scanned++;
      var ph = getComputedStyle(el, '::placeholder');
      var fg = parseColor(ph.color);
      if (!fg) return;
      var bg = effectiveBg(el);
      var fgOnBg = fg[3] < 1 ? composite(fg, bg.rgb) : fg.slice(0, 3);
      var ratio = contrast(fgOnBg, bg.rgb);
      if (ratio >= cfg.contrast.normal) return;
      var sev = ratio < cfg.contrast.placeholderFail ? 'Fail' : 'Risk';
      ctx.findings.push(mk('placeholderContrast', sev, bg.indeterminate ? 'needs-visual' : 'auto-measured', cssPath(el),
        'Placeholder "' + (el.getAttribute('placeholder') || '').slice(0, 30) + '" contrast ' + round2(ratio) + ':1 below 4.5:1.',
        { ratio: round2(ratio), fg: rgbStr(fgOnBg), bg: rgbStr(bg.rgb) }, { min: cfg.contrast.normal }, rectOf(el),
        'Darken/lighten placeholder text; placeholders are not a substitute for a visible label.'));
    });
  }

  function ruleHOverflow(ctx) {
    var de = document.documentElement;
    var tol = ctx.cfg.overflowTolerancePx;
    if (de.scrollWidth <= de.clientWidth + tol) return;
    // find widest visible offenders that cross the viewport's right edge
    var vw = de.clientWidth, offenders = [];
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX)) return; // intentional scroll container
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + tol && r.left < vw) {
        offenders.push({ el: el, over: Math.round(r.right - vw) });
      }
    });
    offenders.sort(function (a, b) { return b.over - a.over; });
    ctx.findings.push(mk('horizontalOverflow', 'Fail', 'auto-measured', 'html',
      'Page scrolls horizontally: scrollWidth ' + de.scrollWidth + ' > viewport ' + vw + '.',
      { scrollWidth: de.scrollWidth, clientWidth: vw,
        topOffenders: offenders.slice(0, 5).map(function (o) { return { selector: cssPath(o.el), overflowPx: o.over }; }) },
      { tolerancePx: tol }, null,
      'Constrain the widest offender (max-width:100%, min-width:0 on flex children, wrap/truncate text).'));
  }

  function ruleOffViewport(ctx) {
    var vw = document.documentElement.clientWidth;
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (!hasOwnText(el) && el.childElementCount) return;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // fully outside horizontally (and not a known carousel/offscreen-by-design pattern)
      if (r.left >= vw - 1 || r.right <= 1) {
        var cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(getComputedStyle(el.parentElement || el).overflowX)) return;
        if (cs.position === 'fixed') return;
        ctx.findings.push(mk('offViewport', 'Risk', 'auto-measured', cssPath(el),
          'Element renders outside the viewport horizontally (left ' + Math.round(r.left) + ', right ' + Math.round(r.right) + ', vw ' + vw + ').',
          { left: Math.round(r.left), right: Math.round(r.right), vw: vw }, {}, rectOf(el),
          'If hidden by design use display:none/visibility:hidden; otherwise bring it on-screen.'));
      }
    });
  }

  function ruleStickyOverlap(ctx) {
    var bars = qsa('body *').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var p = getComputedStyle(el).position;
      if (p !== 'fixed' && p !== 'sticky') return false;
      var role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'dialog' || role === 'tooltip' || role === 'menu' || el.getAttribute('aria-modal') === 'true') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!bars.length) return;
    var reported = new Set();
    bars.forEach(function (bar) {
      var br = bar.getBoundingClientRect();
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) { return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
      });
      var n;
      while ((n = walker.nextNode())) {
        var el = n.parentElement;
        if (!el || bar.contains(el) || reported.has(el)) continue;
        if (!isVisible(el) || isExempt(el)) continue;
        var r = el.getBoundingClientRect();
        var ix = intersect(r, br);
        if (!ix) continue;
        // sample the intersection center: if the bar (or its child) is on top, content is occluded
        var cx = ix.x + ix.w / 2, cy = ix.y + ix.h / 2;
        if (cx < 0 || cy < 0 || cx > root.innerWidth || cy > root.innerHeight) continue;
        var top = document.elementFromPoint(cx, cy);
        if (top && (top === bar || bar.contains(top))) {
          reported.add(el);
          ctx.findings.push(mk('stickyOverlapContent', 'Fail', 'auto-measured', cssPath(el),
            'Content "' + el.textContent.trim().slice(0, 30) + '" is covered by a ' + getComputedStyle(bar).position + ' bar (' + cssPath(bar) + ').',
            { contentRect: rectOf(el), barRect: rectOf(bar), overlapPx: Math.round(ix.h) }, {}, rectOf(el),
            'Reserve space for the bar (padding-bottom / scroll-padding / safe-area-inset-bottom) so content is not occluded.'));
        }
      }
    });
  }

  function ruleCollapse(ctx) {
    var px = ctx.cfg.collapsePx;
    qsa('body *').forEach(function (el) {
      if (isExempt(el)) return;
      var hasContent = el.childElementCount > 0 || hasOwnText(el);
      if (!hasContent) return;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = el.getBoundingClientRect();
      var collapsedH = r.height <= px && el.scrollHeight > px + 4;
      var collapsedW = r.width <= px && el.scrollWidth > px + 4;
      if (!collapsedH && !collapsedW) return;
      // confirm children actually want more room
      var childMax = 0;
      for (var i = 0; i < el.children.length; i++) {
        childMax = Math.max(childMax, el.children[i].scrollHeight, el.children[i].getBoundingClientRect().height);
      }
      if (collapsedH && childMax <= px + 4 && el.scrollHeight <= px + 4) return;
      // walk up to find first ancestor whose box is ~0 while its parent is large (the break point)
      var breakAt = el, p = el;
      while (p && p.parentElement) {
        var ph = p.getBoundingClientRect().height;
        var pph = p.parentElement.getBoundingClientRect().height;
        if (ph <= px && pph > 20) { breakAt = p; break; }
        p = p.parentElement;
      }
      ctx.findings.push(mk('ancestorCollapse', 'Fail', 'auto-measured', cssPath(el),
        'Region has content (scrollHeight ' + el.scrollHeight + ') but rendered box collapsed to ' + Math.round(r.height) + '×' + Math.round(r.width) + '. Likely break at ' + cssPath(breakAt) + '.',
        { renderedH: Math.round(r.height), renderedW: Math.round(r.width), scrollHeight: el.scrollHeight, breakAt: cssPath(breakAt) }, { collapsePx: px }, rectOf(el),
        'A flex/grid sizing chain broke: give the breaking ancestor a resolved height or flex:1; min-height:0; height:100%.'));
    });
  }

  function ruleTextClip(ctx) {
    var tol = ctx.cfg.overflowTolerancePx;
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el) || !hasOwnText(el)) return;
      var cs = getComputedStyle(el);
      var overX = el.scrollWidth > el.clientWidth + tol, overY = el.scrollHeight > el.clientHeight + tol;
      if (!overX && !overY) return;
      var hidX = /(hidden|clip)/.test(cs.overflowX), hidY = /(hidden|clip)/.test(cs.overflowY);
      var bg = parseColor(cs.backgroundColor);
      var controlLike = el.matches('button,[role=button],input,select,.btn,.chip,.pill,.badge,.tag') ||
        (parseFloat(cs.borderTopLeftRadius) > 0 && bg && bg[3] > 0.1);
      // escaping: content wider than the box but overflow visible on a control -> text spills out
      if (overX && /visible/.test(cs.overflowX) && controlLike) {
        ctx.findings.push(mk('textClip', 'Fail', 'auto-measured', cssPath(el),
          'Text escapes its control box: "' + el.textContent.trim().slice(0, 30) + '" (content ' + el.scrollWidth + 'px > box ' + el.clientWidth + 'px, overflow visible).',
          { scrollW: el.scrollWidth, clientW: el.clientWidth }, {}, rectOf(el),
          'Constrain/wrap/truncate the label, or size the control to its content.'));
        return;
      }
      var clippedX = hidX && overX, clippedY = hidY && overY;
      if (!clippedX && !clippedY) return;
      var ellipsis = cs.textOverflow === 'ellipsis';
      var clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
      var intentional = (ellipsis && clippedX && !clippedY) || clamp;
      ctx.findings.push(mk('textClip', intentional ? 'Risk' : 'Fail', 'auto-measured', cssPath(el),
        (intentional ? 'Text is truncated' : 'Text is silently clipped') + ': "' + el.textContent.trim().slice(0, 30) + '" (scroll ' + el.scrollWidth + '×' + el.scrollHeight + ' vs client ' + el.clientWidth + '×' + el.clientHeight + ').',
        { scrollW: el.scrollWidth, clientW: el.clientWidth, scrollH: el.scrollHeight, clientH: el.clientHeight, ellipsis: ellipsis, lineClamp: clamp }, {}, rectOf(el),
        intentional ? 'Confirm truncated content is reachable elsewhere (tooltip/expand); otherwise widen/allow wrap.' : 'Allow wrap, add ellipsis with a reveal, or widen the container — content is disappearing.'));
    });
  }

  function ruleInvisibleContent(ctx) {
    qsa('body *').forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      var hiddenVis = cs.visibility === 'hidden';
      var transparent = parseFloat(cs.opacity) === 0;
      if (!hiddenVis && !transparent) return;
      // exempt intentional hidden patterns
      if (el.closest('[aria-hidden=true],[inert],[hidden],[role=tabpanel],[role=dialog],[role=tooltip],[role=menu],[role=listbox],details:not([open])')) return;
      // skip fade-in elements (a real opacity transition or animation is declared).
      // NB: default computed transition-property is "all" with 0s duration — require duration > 0.
      var fadingIn = (/(opacity|all)/.test(cs.transitionProperty) && parseFloat(cs.transitionDuration) > 0) || cs.animationName !== 'none';
      if (transparent && fadingIn) return;
      var t = (el.textContent || '').trim();
      if (t.length < 8 || !/[\p{L}\p{N}]/u.test(t)) return;
      // report once at the outermost hidden ancestor
      var p = el.parentElement;
      if (p) { var pcs = getComputedStyle(p); if (pcs.visibility === 'hidden' || parseFloat(pcs.opacity) === 0) return; }
      ctx.findings.push(mk('invisibleContent', 'Risk', 'needs-visual', cssPath(el),
        (hiddenVis ? 'visibility:hidden' : 'opacity:0') + ' element still holds meaningful text in the DOM: "' + t.slice(0, 30) + '".',
        { textLength: t.length, reason: hiddenVis ? 'visibility:hidden' : 'opacity:0' }, {}, rectOf(el),
        'If it should show, make it visible; if intentionally hidden use display:none or aria-hidden so it is not an invisible-but-present surface.'));
    });
  }

  function ruleTapTarget(ctx) {
    if (!ctx.isMobile) return;
    var cfg = ctx.cfg.tap;
    var sel = 'button,[role=button],a[href],input:not([type=hidden]),select,textarea,[onclick],[role=tab],[role=menuitem]';
    var targets = qsa(sel).filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false; // inline text link
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    targets.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var small = Math.min(r.width, r.height);
      if (small < cfg.fail) {
        ctx.findings.push(mk('tapTarget', 'Fail', 'auto-measured', cssPath(el),
          'Tap target ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px is below the ' + cfg.fail + 'px minimum.',
          { w: Math.round(r.width), h: Math.round(r.height) }, { min: cfg.fail }, rectOf(el),
          'Increase hit area to at least ' + cfg.risk + '×' + cfg.risk + 'px (padding or min-width/height).'));
      } else if (small < cfg.risk) {
        ctx.findings.push(mk('tapTarget', 'Risk', 'auto-measured', cssPath(el),
          'Tap target ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px is under the comfortable ' + cfg.risk + 'px.',
          { w: Math.round(r.width), h: Math.round(r.height) }, { comfortable: cfg.risk }, rectOf(el),
          'Aim for ' + cfg.risk + 'px touch targets on mobile.'));
      }
      // crowding: nearest neighbor gap. Only a mis-tap risk when targets are SMALL and
      // not in a nav/tab bar where edge-to-edge adjacency is the intended design.
      if (Math.min(r.width, r.height) >= cfg.risk) return;
      if (el.closest('nav,[role=navigation],[role=tablist],[role=tabbar]')) return;
      for (var i = 0; i < targets.length; i++) {
        var o = targets[i];
        if (o === el || el.contains(o) || o.contains(el)) continue;
        var or = o.getBoundingClientRect();
        if (Math.min(or.width, or.height) >= cfg.risk) continue;
        var gap = edgeGap(r, or);
        if (gap >= 0 && gap < cfg.crowdGap) {
          ctx.findings.push(mk('tapTarget', 'Risk', 'auto-measured', cssPath(el),
            'Tap target is only ' + Math.round(gap) + 'px from an adjacent target (' + cssPath(o) + ').',
            { gapPx: Math.round(gap) }, { minGap: cfg.crowdGap }, rectOf(el),
            'Add spacing between adjacent touch targets (>=' + cfg.crowdGap + 'px).'));
          break;
        }
      }
    });
  }

  function rulePrimaryAffordance(ctx) {
    // primary submit that is NOT disabled but reads as disabled (pale, low fill contrast)
    var forms = qsa('form');
    var scopes = forms.length ? forms : [document.body];
    scopes.forEach(function (scope) {
      var btns = qsa('button,[type=submit],[role=button],input[type=submit]', scope).filter(function (b) {
        return isVisible(b) && !isExempt(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      });
      if (!btns.length) return;
      // candidate primary = submit or largest button
      var primary = btns.filter(function (b) { return b.type === 'submit' || b.getAttribute('type') === 'submit'; })[0];
      if (!primary) {
        primary = btns.slice().sort(function (a, b) { return area(b) - area(a); })[0];
      }
      if (!primary) return;
      var cs = getComputedStyle(primary);
      var fill = parseColor(cs.backgroundColor);
      if (!fill || fill[3] < 0.1) return; // ghost/outline button — different pattern
      var pageBg = effectiveBg(primary.parentElement || document.body).rgb;
      var fillContrast = contrast(fill.slice(0, 3), pageBg);
      var sat = saturation(fill.slice(0, 3));
      if (sat < 0.25 && fillContrast < 1.5) {
        ctx.findings.push(mk('disabledLookingPrimary', 'Risk', 'visual-judgment', cssPath(primary),
          'Primary action "' + primary.textContent.trim().slice(0, 24) + '" is enabled but reads as disabled (pale fill, saturation ' + round2(sat) + ', fill-vs-page contrast ' + round2(fillContrast) + ':1).',
          { saturation: round2(sat), fillVsPage: round2(fillContrast), fill: rgbStr(fill.slice(0, 3)) }, { satMin: 0.25, fillContrastMin: 1.5 }, rectOf(primary),
          'Give the primary action a saturated/filled treatment distinct from disabled and secondary buttons.'));
      }
    });
  }

  function ruleSelectedState(ctx) {
    // segmented/tab/radio groups: ambiguous or inverted selection
    var groups = [];
    qsa('[role=tablist],[role=radiogroup]').forEach(function (g) { groups.push(g); });
    // heuristic groups: a parent with 2-4 sibling buttons of similar size in a row.
    // Exclude app navigation — bottom nav / nav bars are handled by authModeNavConflict
    // and contrast; treating them as segmented controls produces noise.
    qsa('body *').forEach(function (g) {
      if (groups.indexOf(g) >= 0) return;
      if (g.matches('nav,[role=navigation]') || g.closest('nav,[role=navigation]')) return;
      var kids = Array.prototype.filter.call(g.children, function (c) {
        return /^(BUTTON|A)$/.test(c.tagName) && isVisible(c);
      });
      if (kids.length < 2 || kids.length > 4) return;
      var cs = getComputedStyle(g);
      if (cs.display.indexOf('flex') < 0 && cs.display.indexOf('grid') < 0) return;
      // similar size + horizontal
      var hs = kids.map(function (k) { return k.getBoundingClientRect(); });
      var sameRow = hs.every(function (r) { return Math.abs(r.top - hs[0].top) < 4; });
      if (sameRow) groups.push(g);
    });
    var seenG = new Set();
    groups.forEach(function (g) {
      if (seenG.has(g)) return; seenG.add(g);
      var items = Array.prototype.filter.call(g.querySelectorAll('[role=tab],[role=radio],button,a'), function (c) {
        return c.parentElement === g || g.getAttribute('role'); // direct or role-grouped
      }).filter(isVisible);
      if (items.length < 2 || items.length > 4) return;
      // prominence = how much an item's fill stands out from the group's own background.
      // This is what signals "selected" far more reliably than raw fill luminance.
      var containerBg = effectiveBg(g).rgb;
      var info = items.map(function (it) {
        var bg = effectiveBg(it).rgb;
        var selected = it.getAttribute('aria-selected') === 'true' || it.getAttribute('aria-current') != null ||
          it.getAttribute('aria-checked') === 'true' || /\b(active|selected|current|sel)\b/.test(it.className);
        return { el: it, fill: bg, prominence: contrast(bg, containerBg), selected: selected };
      });
      var sel = info.filter(function (i) { return i.selected; });
      // ambiguous: no explicit selection but one item stands out from the container -> which is active is unclear
      if (sel.length === 0) {
        var proms = info.map(function (i) { return i.prominence; });
        var spread = Math.max.apply(null, proms);
        if (spread > 1.6) {
          ctx.findings.push(mk('selectedStateAmbiguity', 'Risk', 'visual-judgment', cssPath(g),
            'Segmented/tab group has no programmatic selected state (aria-selected/current) yet one item stands out — which is active is ambiguous.',
            { maxProminence: round2(spread), items: info.length }, {}, rectOf(g),
            'Mark the active item with aria-selected/aria-current and a clear, higher-emphasis visual state.'));
        }
        return;
      }
      // inversion: an UNSELECTED item stands out from the container more than the selected one does
      var selected = sel[0];
      info.forEach(function (i) {
        if (i.selected) return;
        if (i.prominence > 1.5 && i.prominence > selected.prominence * 1.4) {
          ctx.findings.push(mk('selectedStateAmbiguity', 'Risk', 'visual-judgment', cssPath(i.el),
            'Unselected item "' + i.el.textContent.trim().slice(0, 20) + '" stands out more than the selected one (fill prominence ' + round2(i.prominence) + ':1 vs selected ' + round2(selected.prominence) + ':1).',
            { unselProminence: round2(i.prominence), selProminence: round2(selected.prominence) }, {}, rectOf(i.el),
            'Make the selected item the most prominent; keep unselected items legible but clearly secondary.'));
        }
      });
    });
  }

  function ruleAuthConflict(ctx) {
    var hasPassword = qsa('input[type=password]').some(isVisible);
    var routeAuth = /(login|signin|sign-in|signup|sign-up|register|auth)/i.test(location.href);
    var modeWords = /(로그인|회원가입|sign in|sign up|log in|login|register)/i;
    var modeSelector = qsa('[role=tablist],.seg,[class*=tab],[class*=segment]').some(function (g) {
      return isVisible(g) && modeWords.test(g.textContent || '');
    });
    var authCtx = hasPassword || routeAuth || modeSelector;
    if (!authCtx) return;
    // persistent app nav: role=navigation OR fixed bottom bar with >=3 link/tab items
    var navs = qsa('nav,[role=navigation]').concat(qsa('body *').filter(function (el) {
      var cs = getComputedStyle(el);
      return cs.position === 'fixed' && (parseFloat(cs.bottom) === 0) && isVisible(el);
    })).filter(function (el, i, arr) { return arr.indexOf(el) === i; }); // dedupe
    var words = ctx.cfg.authedNavWords;
    var reportedNav = new Set();
    navs.forEach(function (nav) {
      if (!isVisible(nav) || reportedNav.has(nav)) return;
      reportedNav.add(nav);
      var items = qsa('a,[role=tab],button', nav).filter(isVisible);
      if (items.length < 3) return;
      var active = items.filter(function (it) {
        return it.getAttribute('aria-current') != null || it.getAttribute('aria-selected') === 'true' ||
          /\b(active|selected|current)\b/.test(it.className);
      });
      var hit = active.filter(function (it) {
        var t = (it.textContent || '').toLowerCase() + ' ' + (it.getAttribute('href') || '').toLowerCase();
        return words.some(function (w) { return t.indexOf(w) >= 0; });
      });
      if (hit.length) {
        ctx.findings.push(mk('authModeNavConflict', 'Risk', 'visual-judgment', cssPath(nav),
          'Auth screen shows the authenticated app nav with an account/profile tab highlighted ("' + hit[0].textContent.trim().slice(0, 16) + '") — contradictory signed-in/signed-out state.',
          { activeAuthedItem: hit[0].textContent.trim().slice(0, 24) }, {}, rectOf(nav),
          'Hide or neutralize the authenticated nav on auth screens, or do not mark an account tab active while signed out.'));
      } else if (active.length === 0 && (hasPassword || modeSelector)) {
        ctx.findings.push(mk('authModeNavConflict', 'Risk', 'visual-judgment', cssPath(nav),
          'Auth screen shows a persistent app nav (' + items.length + ' items). Verify it does not contradict the signed-out flow.',
          { navItems: items.length }, {}, rectOf(nav),
          'Confirm browsing-while-signed-out is intended; otherwise hide app nav during auth.'));
      }
    });
  }

  function ruleMedia(ctx) {
    qsa('img').forEach(function (img) {
      if (isExempt(img)) return;
      var visible = isVisible(img);
      if (img.complete && img.naturalWidth === 0 && (img.getAttribute('src') || img.srcset)) {
        ctx.findings.push(mk('brokenOrDistortedMedia', 'Fail', 'auto-measured', cssPath(img),
          'Broken image (naturalWidth 0): ' + (img.getAttribute('src') || '').slice(0, 60),
          { src: (img.getAttribute('src') || '').slice(0, 120), alt: img.alt || null }, {}, rectOf(img),
          'Fix the src/path or provide a fallback; ensure meaningful images have alt text.'));
        return;
      }
      if (!visible || !img.naturalWidth) return;
      var r = img.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      var cs = getComputedStyle(img);
      var natAR = img.naturalWidth / img.naturalHeight, renAR = r.width / r.height;
      var diff = Math.abs(renAR - natAR) / natAR;
      if (diff > ctx.cfg.mediaAspectTolerance && (cs.objectFit === 'fill' || cs.objectFit === 'unset' || cs.objectFit === '')) {
        ctx.findings.push(mk('brokenOrDistortedMedia', 'Risk', 'auto-measured', cssPath(img),
          'Image is stretched/squished (rendered AR ' + round2(renAR) + ' vs natural ' + round2(natAR) + ').',
          { renderedAR: round2(renAR), naturalAR: round2(natAR) }, { tolerance: ctx.cfg.mediaAspectTolerance }, rectOf(img),
          'Set object-fit:cover/contain or fix width/height to preserve aspect ratio.'));
      }
      if (r.width * (root.devicePixelRatio || 1) > img.naturalWidth * 1.5) {
        ctx.findings.push(mk('brokenOrDistortedMedia', 'Risk', 'auto-measured', cssPath(img),
          'Image is upscaled (' + Math.round(r.width) + 'css×dpr vs natural ' + img.naturalWidth + 'px) and will look blurry.',
          { renderedW: Math.round(r.width), naturalW: img.naturalWidth, dpr: root.devicePixelRatio || 1 }, {}, rectOf(img),
          'Provide a higher-resolution asset (srcset) for this display size.'));
      }
    });
  }

  function ruleFocusTrap(ctx) {
    var modals = qsa('[role=dialog],[aria-modal=true]').filter(function (m) {
      return isVisible(m) && getComputedStyle(m).display !== 'none';
    });
    if (!modals.length) return;
    var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]';
    modals.forEach(function (modal) {
      var outside = qsa(FOCUSABLE).filter(function (el) {
        if (modal.contains(el) || !isVisible(el)) return false;
        if (el.getAttribute('tabindex') === '-1') return false;
        if (el.closest('[inert],[aria-hidden=true]')) return false;
        return true;
      });
      if (outside.length) {
        ctx.findings.push(mk('focusTrapLeak', 'Fail', 'auto-measured', cssPath(modal),
          'Modal is open but ' + outside.length + ' focusable element(s) remain reachable behind it (e.g. ' + cssPath(outside[0]) + ').',
          { leakedCount: outside.length, firstLeak: cssPath(outside[0]) }, {}, rectOf(modal),
          'Trap focus inside the dialog and mark the background inert/aria-hidden while it is open.'));
      }
    });
  }

  function ruleCLS(ctx) {
    var s = root.__uiSplint;
    if (!s || typeof s.cls !== 'number' || !s.clsInstalled) {
      ctx.findings.push(mk('layoutShiftCLS', 'Risk', 'needs-visual', 'html',
        'CLS not measured — the layout-shift observer was not installed before navigation.',
        { installed: false }, {}, null,
        'Install __uiSplintInstallCLS() via add_init_script before navigating so CLS is captured from first paint.'));
      return;
    }
    if (s.cls > ctx.cfg.cls.risk) {
      var sev = s.cls > ctx.cfg.cls.fail ? 'Fail' : 'Risk';
      ctx.findings.push(mk('layoutShiftCLS', sev, 'auto-measured', 'html',
        'Cumulative Layout Shift ' + round2(s.cls) + ' exceeds ' + ctx.cfg.cls.risk + '. Content jumps as it loads.',
        { cls: round2(s.cls), sources: (s.clsSources || []).slice(0, 5) }, { risk: ctx.cfg.cls.risk, fail: ctx.cfg.cls.fail }, null,
        'Reserve space for late content (image width/height, skeletons matching final size, no inserted banners above content).'));
    }
  }

  function ruleLoneNarrow(ctx) {
    var cfg = ctx.cfg.layout || { loneNarrowWidth: 180 };
    var threshold = cfg.loneNarrowWidth;
    var sel = 'button,[role=button],.btn,input,select,textarea,.chip,.badge,.pill,.tag';

    var allVisible = qsa('body *').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    var candidates = allVisible.filter(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width >= threshold) return false;
      var cs = getComputedStyle(el);
      if (cs.display === 'inline' && el.tagName === 'A') return false;

      if (el.matches(sel) || (hasOwnText(el) && r.width < threshold)) {
        return true;
      }
      return false;
    });

    candidates.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var alone = true;
      for (var i = 0; i < allVisible.length; i++) {
        var other = allVisible[i];
        if (other === el || el.contains(other) || other.contains(el)) continue;

        var or = other.getBoundingClientRect();
        var overlap = Math.min(r.bottom, or.bottom) - Math.max(r.top, or.top);
        var minH = Math.min(r.height, or.height);

        if (overlap > 0 && (overlap >= minH * 0.5 || overlap >= 10)) {
          alone = false;
          break;
        }
      }

      if (alone) {
        var text = (el.textContent || el.value || '').trim().slice(0, 20);
        ctx.findings.push(mk('loneNarrowElement', 'Polish', 'auto-measured', cssPath(el),
          'Narrow element "' + text + '" (' + Math.round(r.width) + 'px) occupies a whole row by itself. Prefer sharing the row with other elements.',
          { width: Math.round(r.width), text: text }, { threshold: threshold }, rectOf(el),
          'Place this element in the same row as other related controls, or increase its width to fill the row if it must be alone.'));
      }
    });
  }

  function ruleExcessiveButtons(ctx) {
    var cfg = ctx.cfg.layout || { maxButtonsInRow: 4 };
    var maxCount = cfg.maxButtonsInRow;

    function isButton(el) {
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.classList.contains('btn') || el.classList.contains('button')) {
        return true;
      }
      if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit')) {
        return true;
      }
      return false;
    }

    var buttons = qsa('body *').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return isButton(el);
    });

    var rows = [];
    buttons.forEach(function (b) {
      var br = b.getBoundingClientRect();
      var placed = false;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var overlaps = row.some(function (member) {
          var mr = member.rect;
          var overlap = Math.min(br.bottom, mr.bottom) - Math.max(br.top, mr.top);
          var minH = Math.min(br.height, mr.height);
          return overlap > 0 && (overlap >= minH * 0.5 || overlap >= 10);
        });
        if (overlaps) {
          row.push({ el: b, rect: br });
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push([{ el: b, rect: br }]);
      }
    });

    rows.forEach(function (row) {
      if (row.length > maxCount) {
        var commonAncestor = findCommonAncestor(row.map(function (item) { return item.el; }));
        var selectors = row.map(function (item) {
          return (item.el.textContent || '').trim().slice(0, 15) || item.el.tagName.toLowerCase();
        }).join(', ');

        ctx.findings.push(mk('excessiveButtonsInRow', 'Polish', 'auto-measured', cssPath(commonAncestor),
          'Too many buttons listed in a single row (' + row.length + ' buttons: ' + selectors + '). Consider grouping some under a menu/dropdown.',
          { count: row.length }, { max: maxCount }, rectOf(commonAncestor),
          'Group some or all of these buttons into a dropdown menu (e.g., a "More" action menu) to clean up the row.'));
      }
    });
  }

  function findCommonAncestor(elements) {
    if (!elements.length) return document.body;
    var current = elements[0];
    while (current) {
      var allContain = elements.every(function (el) {
        return current.contains(el);
      });
      if (allContain) return current;
      current = current.parentElement;
    }
    return document.body;
  }

  function ruleDrift(ctx) {
    var cfg = ctx.cfg.polish;
    var radii = {}, shadows = {}, hues = {}, fontPairs = {};
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      if (parseFloat(cs.borderTopLeftRadius) > 0) radii[cs.borderTopLeftRadius] = 1;
      if (cs.boxShadow && cs.boxShadow !== 'none') shadows[cs.boxShadow.slice(0, 40)] = 1;
      var bg = parseColor(cs.backgroundColor);
      if (bg && bg[3] > 0.2) { var h = hueBucket(bg.slice(0, 3)); if (h != null) hues[h] = (hues[h] || 0) + 1; }
      if (hasOwnText(el)) fontPairs[cs.fontSize + '/' + cs.fontWeight] = 1;
    });
    var nRadii = Object.keys(radii).length, nShadows = Object.keys(shadows).length;
    var nHues = Object.keys(hues).filter(function (h) { return hues[h] >= 2; }).length;
    var nFonts = Object.keys(fontPairs).length;
    if (nRadii > cfg.maxRadii) push('border-radius values', nRadii, cfg.maxRadii, 'Consolidate to a small radius scale (e.g. 4/8/12/full).');
    if (nShadows > cfg.maxShadows) push('box-shadow elevations', nShadows, cfg.maxShadows, 'Use a shared elevation scale instead of one-off shadows.');
    if (nHues > cfg.maxAccentHues) push('distinct saturated hues', nHues, cfg.maxAccentHues, 'Reduce accent colors; reserve hue for meaning (status/brand).');
    if (nFonts > cfg.maxFontPairs) push('font-size/weight pairs', nFonts, cfg.maxFontPairs, 'Tighten the type scale; fewer size/weight combinations read as more designed.');
    function push(what, n, max, fix) {
      ctx.findings.push(mk('designSystemDrift', 'Polish', 'visual-judgment', 'html',
        'Design-system drift: ' + n + ' ' + what + ' in use (>' + max + ').',
        { count: n }, { max: max }, null, fix));
    }
  }

  function ruleTinyText(ctx) {
    var cfg = ctx.cfg.polish || { tinyTextPx: 11 };
    var threshold = cfg.tinyTextPx || 11;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var seen = new Set();
    var n;
    while ((n = walker.nextNode())) {
      if (!/[\p{L}\p{N}]/u.test(n.textContent)) continue;
      var el = n.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el) || isExempt(el)) continue;
      if (el.closest('pre, code, svg, math, script, style')) continue;

      var cs = getComputedStyle(el);
      var px = parseFloat(cs.fontSize);
      if (isNaN(px) || px >= threshold) continue;

      var txt = el.textContent.trim().slice(0, 30);
      var sev = px < 9 ? 'Risk' : 'Polish';
      ctx.findings.push(mk('tinyText', sev, 'auto-measured', cssPath(el),
        'Text "' + txt + '" is very small (' + round2(px) + 'px) and may be hard to read.',
        { fontSize: round2(px) }, { min: threshold }, rectOf(el),
        'Increase font size to at least ' + threshold + 'px for readability.'));
    }
  }

  function ruleUnlabeledInput(ctx) {
    var inputs = qsa('input, select, textarea').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var t = el.type || '';
      if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'image' || t === 'reset') return false;
      return true;
    });
    inputs.forEach(function (el) {
      if (el.closest('label')) return;
      if (el.id) {
        var lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (lbl) return;
      }
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return;

      ctx.findings.push(mk('unlabeledInput', 'Risk', 'auto-measured', cssPath(el),
        'Form control lacks an associated label or accessible name (aria-label, aria-labelledby, title, or <label>).',
        { type: el.type, id: el.id || null }, {}, rectOf(el),
        'Provide an accessible label using a <label> element or aria-label/title attribute.'));
    });
  }

  function ruleLineLength(ctx) {
    var cfg = ctx.cfg.polish || { lineLenMax: 95 };
    var maxLen = cfg.lineLenMax || 95;
    var textEls = qsa('p, article, section, div, span').filter(function (el) {
      if (!isVisible(el) || isExempt(el) || !hasOwnText(el)) return false;
      if (el.closest('pre, code, svg, math, script, style, nav, table, form, button, [role=button]')) return false;
      return true;
    });

    textEls.forEach(function (el) {
      var text = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        var c = el.childNodes[i];
        if (c.nodeType === 3) text += c.textContent;
      }
      text = text.trim();
      if (text.length <= maxLen) return;

      var cs = getComputedStyle(el);
      var fontSize = parseFloat(cs.fontSize) || 16;
      var padLeft = parseFloat(cs.paddingLeft) || 0;
      var padRight = parseFloat(cs.paddingRight) || 0;
      var innerW = el.clientWidth - padLeft - padRight;
      if (innerW <= 0) return;

      var maxW = maxLen * (fontSize * 0.45);
      if (innerW > maxW) {
        ctx.findings.push(mk('lineLength', 'Polish', 'auto-measured', cssPath(el),
          'Line width is too wide (' + Math.round(innerW) + 'px), causing text lines to exceed ' + maxLen + ' characters.',
          { innerWidth: Math.round(innerW), fontSize: fontSize, textLen: text.length }, { max: maxLen }, rectOf(el),
          'Limit the width of the text container (e.g., max-width: 60ch or max-width: ' + Math.round(maxW) + 'px) to improve readability.'));
      }
    });
  }

  function ruleInconsistentSpacing(ctx) {
    qsa('body *').forEach(function (parent) {
      if (parent.childElementCount < 3) return;
      var groups = {};
      for (var i = 0; i < parent.children.length; i++) {
        var child = parent.children[i];
        if (!isVisible(child) || isExempt(child)) continue;
        var key = child.tagName + '[' + (child.className || '') + ']';
        groups[key] = groups[key] || [];
        groups[key].push(child);
      }
      Object.keys(groups).forEach(function (key) {
        var items = groups[key];
        if (items.length < 3) return;
        var paddings = items.map(function (el) {
          var cs = getComputedStyle(el);
          return Math.round(parseFloat(cs.paddingLeft) || 0);
        });
        var margins = items.map(function (el) {
          var cs = getComputedStyle(el);
          return Math.round(parseFloat(cs.marginLeft) || 0);
        });
        var uniqP = paddings.filter(function (v, idx, self) { return self.indexOf(v) === idx; });
        var uniqM = margins.filter(function (v, idx, self) { return self.indexOf(v) === idx; });
        if (uniqP.length > 1 || uniqM.length > 1) {
          ctx.findings.push(mk('inconsistentSiblingsSpacing', 'Polish', 'auto-measured', cssPath(items[0]),
            'Inconsistent padding/margin among sibling elements of type ' + key + '.',
            { paddings: paddings.slice(0, 5), margins: margins.slice(0, 5) }, {}, rectOf(items[0]),
            'Align the margins and paddings of sibling items to design tokens.'));
        }
      });
    });
  }

  function ruleTextLineHeightOverlap(ctx) {
    qsa('p, span, div, h1, h2, h3, h4, h5, h6, a, button').forEach(function (el) {
      if (!isVisible(el) || isExempt(el) || !hasOwnText(el)) return;
      var cs = getComputedStyle(el);
      var fs = parseFloat(cs.fontSize);
      var lh = cs.lineHeight;
      if (lh === 'normal') return;
      var lhPx = parseFloat(lh);
      if (isNaN(lhPx) || isNaN(fs)) return;
      if (lhPx < fs * 0.95) {
        ctx.findings.push(mk('textLineHeightOverlap', 'Risk', 'auto-measured', cssPath(el),
          'Line height (' + round2(lhPx) + 'px) is smaller than font size (' + round2(fs) + 'px), causing potential text overlapping.',
          { lineHeight: lhPx, fontSize: fs }, {}, rectOf(el),
          'Increase line-height to at least 1.2 or 1.5 times the font-size.'));
      }
    });
  }

  function ruleEmptyInteractiveTarget(ctx) {
    qsa('button, a[href], [role=button]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var txt = (el.textContent || '').trim();
      if (txt.length > 0) return;
      var media = qsa('img, svg', el).filter(isVisible);
      if (media.length > 0) return;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return;

      ctx.findings.push(mk('emptyInteractiveTarget', 'Fail', 'auto-measured', cssPath(el),
        'Interactive element has no text content, visible icon, or accessible name.',
        {}, {}, rectOf(el),
        'Add text content, an icon image/svg, or an aria-label attribute.'));
    });
  }

  function ruleMisalignedRowItems(ctx) {
    qsa('body *').forEach(function (parent) {
      if (parent.childElementCount < 2) return;
      var kids = Array.prototype.slice.call(parent.children).filter(function (c) {
        return isVisible(c) && !isExempt(c);
      });
      for (var i = 0; i < kids.length - 1; i++) {
        var a = kids[i], b = kids[i+1];
        var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        if (ar.width === 0 || br.width === 0 || ar.height === 0 || br.height === 0) continue;
        if (Math.abs(ar.height - br.height) > 5) continue;

        var horizAdjacent = (ar.right <= br.left + 15) && (br.left <= ar.right + 15);
        if (!horizAdjacent) continue;

        var overlap = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        if (overlap <= 0) continue;

        var centerA = ar.top + ar.height / 2;
        var centerB = br.top + br.height / 2;
        var diff = Math.abs(centerA - centerB);
        if (diff >= 1.5 && diff <= 6) {
          ctx.findings.push(mk('misalignedRowItems', 'Polish', 'auto-measured', cssPath(a),
            'Adjacent elements in row are misaligned vertically by ' + round2(diff) + 'px.',
            { alignmentOffsetPx: round2(diff) }, {}, rectOf(a),
            'Use display:flex and align-items:center to align adjacent items.'));
        }
      }
    });
  }

  function ruleAccidentalFlexWrap(ctx) {
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      if (cs.display.indexOf('flex') < 0 || cs.flexWrap !== 'wrap') return;

      var kids = Array.prototype.slice.call(el.children).filter(isVisible);
      if (kids.length < 4) return;

      var rows = {};
      kids.forEach(function (c) {
        var r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        var top = Math.round(r.top);
        var found = false;
        Object.keys(rows).forEach(function (k) {
          if (Math.abs(parseFloat(k) - top) < 5) {
            rows[k].push(c);
            found = true;
          }
        });
        if (!found) {
          rows[top] = [c];
        }
      });

      var keys = Object.keys(rows).map(parseFloat).sort(function (a, b) { return a - b; });
      if (keys.length < 2) return;

      var lastRowKey = keys[keys.length - 1];
      var lastRowItems = rows[lastRowKey];
      var prevRowKey = keys[keys.length - 2];
      var prevRowItems = rows[prevRowKey];

      if (lastRowItems.length === 1 && prevRowItems.length >= 3) {
        ctx.findings.push(mk('accidentalFlexWrap', 'Polish', 'auto-measured', cssPath(lastRowItems[0]),
          'A single item wrapped onto its own row in wrap container. Consider adjusting widths.',
          { lastRowCount: 1, prevRowCount: prevRowItems.length }, {}, rectOf(lastRowItems[0]),
          'Adjust item widths or use media queries so wrap creates balanced rows.'));
      }
    });
  }

  function ruleNonScrollableOverflow(ctx) {
    qsa('body *').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      if (cs.overflowY !== 'hidden' && cs.overflowY !== 'clip') return;
      if (el.scrollHeight <= el.clientHeight + 4) return;
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return;
      if (cs.textOverflow === 'ellipsis') return;
      if (/^(HTML|BODY|IFRAME)$/.test(el.tagName)) return;

      ctx.findings.push(mk('nonScrollableOverflow', 'Risk', 'auto-measured', cssPath(el),
        'Container has overflowing content (scrollHeight ' + el.scrollHeight + 'px > height ' + el.clientHeight + 'px) but scrolling is disabled (overflow: ' + cs.overflowY + ').',
        { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }, {}, rectOf(el),
        'Change overflow to auto/scroll or ensure content fits within container.'));
    });
  }

  function ruleInconsistentBorderRadius(ctx) {
    qsa('body *').forEach(function (parent) {
      if (parent.childElementCount < 2) return;
      var groups = {};
      for (var i = 0; i < parent.children.length; i++) {
        var child = parent.children[i];
        if (!isVisible(child) || isExempt(child)) continue;
        var key = child.tagName + '[' + (child.className || '') + ']';
        groups[key] = groups[key] || [];
        groups[key].push(child);
      }
      Object.keys(groups).forEach(function (key) {
        var items = groups[key];
        if (items.length < 2) return;
        var radii = items.map(function (el) {
          var cs = getComputedStyle(el);
          return cs.borderTopLeftRadius;
        });
        var uniq = radii.filter(function (v, idx, self) { return self.indexOf(v) === idx; });
        if (uniq.length > 1) {
          ctx.findings.push(mk('inconsistentBorderRadius', 'Polish', 'auto-measured', cssPath(items[0]),
            'Inconsistent border-radius among sibling elements of type ' + key + ' (' + uniq.join(', ') + ').',
            { radii: radii.slice(0, 5) }, {}, rectOf(items[0]),
            'Harmonize the border-radius of sibling components.'));
        }
      });
    });
  }

  function ruleExcessiveFirstViewportSpacing(ctx) {
    if (root.innerHeight < 400) return;
    var elements = qsa('h1, h2, h3, p, button, a, input').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0;
    });
    if (!elements.length) return;
    var tops = elements.map(function (el) { return el.getBoundingClientRect().top; });
    var minTop = Math.min.apply(null, tops);
    if (minTop > 200) {
      ctx.findings.push(mk('excessiveFirstViewportSpacing', 'Polish', 'auto-measured', 'html',
        'Excessive whitespace at the top of the viewport. First content element is pushed down to ' + Math.round(minTop) + 'px.',
        { firstElementTop: Math.round(minTop) }, {}, null,
        'Reduce top padding or margins to pull the primary content above the fold.'));
    }
  }

  function ruleButtonHeightMismatch(ctx) {
    qsa('body *').forEach(function (parent) {
      if (parent.childElementCount < 2) return;
      var buttons = Array.prototype.slice.call(parent.children).filter(function (c) {
        if (!isVisible(c) || isExempt(c)) return false;
        return c.tagName === 'BUTTON' || c.getAttribute('role') === 'button' || c.classList.contains('btn') || c.classList.contains('button');
      });
      if (buttons.length < 2) return;
      for (var i = 0; i < buttons.length - 1; i++) {
        var a = buttons[i], b = buttons[i+1];
        var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        if (ar.width === 0 || br.width === 0 || ar.height === 0 || br.height === 0) continue;

        var overlap = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
        if (overlap <= 0) continue;

        var diff = Math.abs(ar.height - br.height);
        if (diff > 2) {
          ctx.findings.push(mk('buttonSelfHeightMismatch', 'Polish', 'auto-measured', cssPath(a),
            'Adjacent sibling buttons have mismatched heights (' + Math.round(ar.height) + 'px vs ' + Math.round(br.height) + 'px).',
            { heightA: Math.round(ar.height), heightB: Math.round(br.height) }, {}, rectOf(a),
            'Give adjacent buttons the same height or use display:flex with stretch alignment.'));
        }
      }
    });
  }

  function ruleStretchedIconDistortion(ctx) {
    qsa('svg').forEach(function (svg) {
      if (!isVisible(svg) || isExempt(svg)) return;
      var r = svg.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return;
      var vb = svg.getAttribute('viewBox');
      if (!vb) return;
      var parts = vb.trim().split(/[\s,]+/).map(parseFloat);
      if (parts.length !== 4) return;
      var natW = parts[2], natH = parts[3];
      if (natW <= 0 || natH <= 0) return;

      var natAR = natW / natH;
      var renAR = r.width / r.height;
      var diff = Math.abs(renAR - natAR) / natAR;
      if (diff > 0.05) {
        ctx.findings.push(mk('stretchedIconDistortion', 'Risk', 'auto-measured', cssPath(svg),
          'SVG icon is stretched/squished (rendered AR ' + round2(renAR) + ' vs viewBox ' + round2(natAR) + ').',
          { renderedAR: round2(renAR), naturalAR: round2(natAR) }, { tolerance: 0.05 }, rectOf(svg),
          'Preserve the aspect ratio of the SVG or adjust width/height styles to match the viewBox.'));
      }
    });
  }

  function ruleMissingClickableCursor(ctx) {
    qsa('button, a[href], [role=button], [onclick], input[type=checkbox], input[type=radio], input[type=submit], input[type=button]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      if (!cs) return;
      if (cs.cursor !== 'pointer') {
        ctx.findings.push(mk('missingClickableCursor', 'Polish', 'auto-measured', cssPath(el),
          'Clickable element lacks "cursor: pointer" style on hover, reducing affordance.',
          { cursor: cs.cursor }, {}, rectOf(el),
          'Add "cursor: pointer" to the clickable element\'s hover state.'));
      }
    });
  }

  function ruleMissingModalBackdrop(ctx) {
    var modals = qsa('[role=dialog],[aria-modal=true]').filter(function (m) {
      return isVisible(m) && getComputedStyle(m).display !== 'none';
    });
    if (!modals.length) return;

    var vw = root.innerWidth, vh = root.innerHeight;
    modals.forEach(function (modal) {
      var mz = zIndexOf(modal, 0);
      var hasBackdrop = false;
      qsa('body *').forEach(function (el) {
        if (hasBackdrop || el === modal || modal.contains(el) || !isVisible(el)) return;
        var r = el.getBoundingClientRect();
        if (r.width < vw * 0.9 || r.height < vh * 0.9) return;
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return;
        var z = zIndexOf(el, 0);
        var beforeModal = !!(el.compareDocumentPosition(modal) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!(z < mz || (z === mz && beforeModal))) return;
        var bg = parseColor(cs.backgroundColor);
        var opaque = bg && (bg[3] > 0.05 && bg[3] < 0.95);
        var opacity = parseFloat(cs.opacity) < 0.99;
        if (opaque || opacity) {
          hasBackdrop = true;
        }
      });
      if (!hasBackdrop) {
        ctx.findings.push(mk('missingModalBackdrop', 'Risk', 'auto-measured', cssPath(modal),
          'Open modal lacks a visible semi-transparent backdrop overlay to obscure background content.',
          {}, {}, rectOf(modal),
          'Add a semi-transparent backdrop overlay behind the modal dialog to focus user attention.'));
      }
    });
  }

  // ------------------------------ helpers ------------------------------
  function qsa(sel, root2) { return Array.prototype.slice.call((root2 || document).querySelectorAll(sel)); }
  function area(el) { var r = el.getBoundingClientRect(); return r.width * r.height; }
  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.textContent.trim()) return true;
    }
    return false;
  }
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    return true;
  }
  function isExempt(el) {
    if (!el) return true;
    if (el.closest('[aria-hidden=true],[inert],[hidden]')) return true;
    if (el.matches && el.matches('[disabled],[aria-disabled=true]')) return true;
    var cs = getComputedStyle(el);
    // sr-only / visually-hidden 1px clip pattern
    var r = el.getBoundingClientRect();
    if ((cs.position === 'absolute') && r.width <= 1 && r.height <= 1 && /(hidden|clip)/.test(cs.overflow)) return true;
    if (cs.clipPath && cs.clipPath.indexOf('inset(50%)') >= 0) return true;
    return false;
  }
  function parseColor(s) {
    if (!s) return null;
    var m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var parts = m[1].split(/[,\s/]+/).map(parseFloat).filter(function (x) { return !isNaN(x); });
    if (parts.length < 3) return null;
    return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 1];
  }
  function composite(fg, bg) { // src-over, fg has alpha
    var a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)];
  }
  function effectiveBg(el) {
    var indeterminate = false, reason = null;
    var acc = null; // accumulated translucent layers from el upward
    var n = el;
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') { indeterminate = true; reason = 'background-image/gradient on ' + n.tagName.toLowerCase(); }
      if (cs.backdropFilter && cs.backdropFilter !== 'none') { indeterminate = true; reason = 'backdrop-filter'; }
      var c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0) {
        if (c[3] >= 0.999) {
          var base = c.slice(0, 3);
          return { rgb: acc ? compositeStack(acc, base) : base, indeterminate: indeterminate, reason: reason };
        } else {
          acc = acc ? acc.concat([c]) : [c];
        }
      }
      n = n.parentElement;
    }
    var white = [255, 255, 255];
    return { rgb: acc ? compositeStack(acc, white) : white, indeterminate: indeterminate, reason: reason };
  }
  function compositeStack(layers, base) {
    // layers ordered nearest-first; composite from base up
    var out = base.slice();
    for (var i = layers.length - 1; i >= 0; i--) out = composite(layers[i], out);
    return out;
  }
  function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function luminance(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
  function contrast(a, b) { var L1 = luminance(a), L2 = luminance(b), hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); }
  function saturation(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx === 0) return 0;
    var l = (mx + mn) / 2;
    var d = mx - mn;
    if (d === 0) return 0;
    return l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  }
  function hueBucket(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.12) return null; // near-gray, not an accent
    var h;
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = Math.round(h * 60); if (h < 0) h += 360;
    return Math.round(h / 30) * 30; // 30deg buckets
  }
  function intersect(a, b) {
    var x = Math.max(a.left, b.left), y = Math.max(a.top, b.top);
    var x2 = Math.min(a.right, b.right), y2 = Math.min(a.bottom, b.bottom);
    if (x2 <= x || y2 <= y) return null;
    return { x: x, y: y, w: x2 - x, h: y2 - y };
  }
  function edgeGap(a, b) {
    var dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    var dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    if (dx > 0 && dy > 0) return Math.sqrt(dx * dx + dy * dy);
    return dx + dy; // adjacent on one axis
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function round2(x) { return Math.round(x * 100) / 100; }
  function rgbStr(rgb) { return 'rgb(' + rgb.map(Math.round).join(',') + ')'; }
  function zIndexOf(el, fallback) { var z = parseInt(getComputedStyle(el).zIndex, 10); return isNaN(z) ? fallback : z; }
  function brandFix(bg) {
    // suggest brand-correct foregrounds for common social buttons
    var hex = rgbToHex(bg);
    var BRAND = { '#fee500': 'Kakao spec: #191919 text on #FEE500.', '#ffe600': 'Kakao spec: #191919 text on #FEE500.', '#03c75a': 'Naver spec: #FFFFFF text on #03C75A.' };
    return BRAND[hex] || null;
  }
  function rgbToHex(rgb) { return '#' + rgb.map(function (c) { return ('0' + Math.round(c).toString(16)).slice(-2); }).join(''); }
  function describe(node) { return node && node.nodeType === 1 ? cssPath(node) : String(node); }
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return String(el);
    if (el.id) return '#' + cssEscape(el.id);
    var parts = [];
    var n = el;
    while (n && n.nodeType === 1 && parts.length < 6) {
      var sel = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + cssEscape(n.id)); break; }
      var cls = (n.className && typeof n.className === 'string') ? n.className.trim().split(/\s+/).slice(0, 2).filter(Boolean) : [];
      if (cls.length) sel += '.' + cls.map(cssEscape).join('.');
      var parent = n.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === n.tagName; });
        if (same.length > 1) sel += ':nth-of-type(' + (Array.prototype.indexOf.call(same, n) + 1) + ')';
      }
      parts.unshift(sel);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }
  function cssEscape(s) { return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'); }
  // A finding is whitelisted when its own element matches, or sits inside, a
  // whitelist selector's subtree. We resolve the finding's specific cssPath (not
  // the generic whitelist selector) and walk up via closest(), so a whitelist of
  // `.btn` suppresses findings on every `.btn` and their contents — not just the
  // first `.btn` on the page (the old identity check). Page-level findings whose
  // selector is 'html' are only suppressed by a selector that matches <html>.
  function whitelisted(finding, sel) {
    try {
      var el = document.querySelector(finding.selector);
      return !!(el && el.closest(sel));
    } catch (e) { return false; }
  }
  function mk(rule, severity, confidence, selector, message, measured, threshold, rect, suggestedFix) {
    return { rule: rule, severity: severity, confidence: confidence, selector: selector, message: message,
      measured: measured || {}, threshold: threshold || {}, rect: rect || null, suggestedFix: suggestedFix || null };
  }
  function merge(a, b) {
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) {
      if (a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) && b[k] && typeof b[k] === 'object') out[k] = merge(a[k], b[k]);
      else out[k] = b[k];
    });
    return out;
  }

  root.__uiSplintAudit = audit;
  if (typeof module !== 'undefined' && module.exports) module.exports = { audit: audit, installCLS: installCLS };
})(typeof window !== 'undefined' ? window : this);
