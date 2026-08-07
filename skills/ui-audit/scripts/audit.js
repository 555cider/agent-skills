/*
 * ui-audit deterministic audit — the SOURCE OF TRUTH for measurable UI defects.
 *
 * Pure DOM/CSSOM/geometry. No dependencies. Safe to inject into any live page via
 * Playwright `page.evaluate`, Playwright-MCP `browser_evaluate`, chrome-devtools
 * `evaluate_script`, or DevTools console. It MEASURES defects (contrast ratios,
 * overlaps, overflow, collapsed regions, tap targets, ...) instead of asking a
 * model to eyeball a downscaled screenshot — the channel that misses them.
 *
 * Usage:
 *   1. (optional, BEFORE navigation) install the layout-shift observer so CLS is
 *      captured from first paint:  window.__uiAuditInstallCLS && __uiAuditInstallCLS()
 *      The runner injects `__uiAuditInstallCLS` via add_init_script.
 *   2. After the page reaches the state you want to check, call:
 *        const report = window.__uiAudit(config)   // returns JSON-able object
 *   3. The caller scrolls (top/mid/bottom), opens overlays, switches theme/state,
 *      and calls __uiAudit again per cell. Geometry rules reflect the CURRENT
 *      scroll/overlay state, so call at scroll-bottom to catch sticky-bar overlap.
 *
 * Returns: { meta, coverage, findings[], advisories[] } — see
 * references/findings-schema.md. Findings are high-confidence measured defects;
 * heuristics and unresolved visual measurements are kept in a separate channel.
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
    if (root.__uiAuditState && root.__uiAuditState.clsInstalled) return;
    root.__uiAuditState = root.__uiAuditState || {};
    root.__uiAuditState.cls = 0;
    root.__uiAuditState.clsSources = [];
    try {
      var po = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          if (e.hadRecentInput) return;
          root.__uiAuditState.cls += e.value;
          (e.sources || []).forEach(function (s) {
            if (s.node && root.__uiAuditState.clsSources.length < 20) {
              root.__uiAuditState.clsSources.push({ value: e.value, node: describe(s.node) });
            }
          });
        });
      });
      po.observe({ type: 'layout-shift', buffered: true });
      root.__uiAuditState.clsInstalled = true;
    } catch (err) { /* layout-shift unsupported */ }
  }
  root.__uiAuditInstallCLS = installCLS;

  // -------------------------------- defaults --------------------------------
  var DEFAULTS = {
    contrast: { normal: 4.5, large: 3.0, nonText: 3.0, colorCue: 3.0 },
    tap: { fail: 24, risk: 44, crowdGap: 8 },     // CSS px (WCAG 2.5.8 = 24, comfortable = 44)
    overflowTolerancePx: 1,
    collapsePx: 3,
    cls: { risk: 0.1, fail: 0.25 },
    mediaAspectTolerance: 0.05,
    polish: {
      maxRadii: 4,
      maxShadows: 4,
      maxAccentHues: 6,
      maxFontPairs: 10,
      lineLenMin: 45,
      lineLenMax: 95,
      tinyTextPx: 11,
      bodyTextMinChars: 40,
      bodyTextMinLines: 3,
      bodyLineHeight: 1.5
    },
    layout: {
      loneNarrowWidth: 180,
      maxButtonsInRow: 4,
      controlGroupMinInset: 8,
      controlGroupRowInsetDelta: 12,
      orphanControlMaxWidth: 180,
      orphanControlMaxRatio: 0.25
    },
    // selectors matching authenticated destinations for the auth-mode-conflict rule
    authedNavWords: ['my', 'account', 'profile', 'mypage', '마이', '계정', '프로필', '내정보'],
    isMobile: null,        // null => infer from innerWidth <= 600
    whitelist: [],         // CSS selectors to ignore entirely
    baseline: [],          // [{rule, selector}] approved/known findings to suppress
    maxFindingsPerRule: 60,
    maxPolish: 15,
    rulePhase: 'all'
  };

  // Central rule metadata keeps execution cost and output policy explicit. Rules
  // that depend on the current scroll position are the only rules repeated by the
  // runner after the top-of-page pass.
  var RULES = [
    ruleDef('effectiveContrast', ruleContrast, 'document', 'contrast', 'WCAG 1.4.3'),
    ruleDef('placeholderContrast', rulePlaceholder, 'document', 'contrast', 'WCAG 1.4.3'),
    ruleDef('nonTextContrast', ruleNonTextContrast, 'document', 'contrast', 'WCAG 1.4.11'),
    ruleDef('inlineLinkAffordance', ruleInlineLinkAffordance, 'document', 'affordance'),
    ruleDef('horizontalOverflow', ruleHOverflow, 'document', 'layout', 'WCAG 1.4.10'),
    ruleDef('offViewport', ruleOffViewport, 'document', 'layout'),
    ruleDef('stickyOverlapContent', ruleStickyOverlap, 'viewport', 'layout'),
    ruleDef('ancestorCollapse', ruleCollapse, 'document', 'layout'),
    ruleDef('textClip', ruleTextClip, 'document', 'layout'),
    ruleDef('invisibleContent', ruleInvisibleContent, 'document', 'visibility'),
    ruleDef('targetSizeMinimum', ruleTapTarget, 'document', 'accessibility', 'WCAG 2.5.8'),
    ruleDef('disabledLookingPrimary', rulePrimaryAffordance, 'document', 'affordance'),
    ruleDef('selectedStateAmbiguity', ruleSelectedState, 'document', 'state'),
    ruleDef('authModeNavConflict', ruleAuthConflict, 'document', 'state'),
    ruleDef('brokenOrDistortedMedia', ruleMedia, 'document', 'media'),
    ruleDef('uninspectedSurface', ruleUninspectedSurface, 'document', 'coverage'),
    ruleDef('focusTrapLeak', ruleFocusTrap, 'document', 'keyboard', 'WCAG 2.1.2'),
    ruleDef('layoutShiftCLS', ruleCLS, 'document', 'stability'),
    ruleDef('designSystemDrift', ruleDrift, 'document', 'heuristic'),
    ruleDef('loneNarrowElement', ruleLoneNarrow, 'document', 'heuristic'),
    ruleDef('excessiveButtonsInRow', ruleExcessiveButtons, 'document', 'heuristic'),
    ruleDef('tinyText', ruleTinyText, 'document', 'typography'),
    ruleDef('unlabeledInput', ruleUnlabeledInput, 'document', 'accessibility', 'WCAG 4.1.2'),
    ruleDef('lineLength', ruleLineLength, 'document', 'heuristic'),
    ruleDef('controlGroupSpacing', ruleControlGroupSpacing, 'document', 'heuristic'),
    ruleDef('orphanedControlRow', ruleOrphanedControlRow, 'document', 'heuristic'),
    ruleDef('inconsistentSiblingsSpacing', ruleInconsistentSpacing, 'document', 'heuristic'),
    ruleDef('textLineHeightOverlap', ruleTextLineHeightOverlap, 'document', 'typography'),
    ruleDef('bodyTextAlignment', ruleBodyTextAlignment, 'document', 'typography'),
    ruleDef('bodyTextLineHeight', ruleBodyTextLineHeight, 'document', 'typography'),
    ruleDef('emptyInteractiveTarget', ruleEmptyInteractiveTarget, 'document', 'accessibility', 'WCAG 4.1.2'),
    ruleDef('misalignedRowItems', ruleMisalignedRowItems, 'document', 'heuristic'),
    ruleDef('accidentalFlexWrap', ruleAccidentalFlexWrap, 'document', 'heuristic'),
    ruleDef('nonScrollableOverflow', ruleNonScrollableOverflow, 'document', 'layout'),
    ruleDef('inconsistentBorderRadius', ruleInconsistentBorderRadius, 'document', 'heuristic'),
    ruleDef('excessiveFirstViewportSpacing', ruleExcessiveFirstViewportSpacing, 'document', 'heuristic'),
    ruleDef('buttonSelfHeightMismatch', ruleButtonHeightMismatch, 'document', 'heuristic'),
    ruleDef('stretchedIconDistortion', ruleStretchedIconDistortion, 'document', 'media'),
    ruleDef('missingClickableCursor', ruleMissingClickableCursor, 'document', 'heuristic'),
    ruleDef('missingModalBackdrop', ruleMissingModalBackdrop, 'document', 'visibility'),
    // Widget contract: does the control keep the promise its own shape makes?
    ruleDef('multiRowTabs', ruleMultiRowTabs, 'document', 'widget-contract'),
    ruleDef('placeholderAsOnlyLabel', rulePlaceholderAsOnlyLabel, 'document', 'widget-contract', 'WCAG 3.3.2'),
    ruleDef('stackedDialogs', ruleStackedDialogs, 'document', 'widget-contract'),
    ruleDef('singleRadioInGroup', ruleSingleRadioInGroup, 'document', 'widget-contract'),
    ruleDef('toggleInsideSubmitForm', ruleToggleInsideSubmitForm, 'document', 'widget-contract'),
    ruleDef('orphanedFieldError', ruleOrphanedFieldError, 'document', 'widget-contract', 'WCAG 3.3.1'),
    ruleDef('desktopHiddenNav', ruleDesktopHiddenNav, 'document', 'widget-contract'),
    ruleDef('imageMissingAlt', ruleImageMissingAlt, 'document', 'accessibility', 'WCAG 1.1.1'),
    ruleDef('skipLinkMissing', ruleSkipLinkMissing, 'document', 'keyboard', 'WCAG 2.4.1'),
    ruleDef('selectAutoSubmit', ruleSelectAutoSubmit, 'document', 'widget-contract', 'WCAG 3.2.2'),
    ruleDef('missingIndeterminateState', ruleMissingIndeterminateState, 'document', 'widget-contract'),
    ruleDef('modalActionsOutOfView', ruleModalActionsOutOfView, 'document', 'widget-contract'),
    ruleDef('emptyDataCell', ruleEmptyDataCell, 'document', 'widget-contract'),
    ruleDef('numericColumnAlignment', ruleNumericColumnAlignment, 'document', 'typography'),
    ruleDef('unlinkedContactInfo', ruleUnlinkedContactInfo, 'document', 'affordance'),
    ruleDef('popupExceedsViewport', rulePopupExceedsViewport, 'document', 'layout'),
    ruleDef('navCurrentUnmarked', ruleNavCurrentUnmarked, 'document', 'widget-contract'),
    ruleDef('disabledTab', ruleDisabledTab, 'document', 'widget-contract'),
    ruleDef('nestedTabs', ruleNestedTabs, 'document', 'widget-contract'),
    ruleDef('flagAsLanguageIndicator', ruleFlagAsLanguageIndicator, 'document', 'widget-contract'),
    ruleDef('accordionPanelScroll', ruleAccordionPanelScroll, 'document', 'widget-contract')
  ];

  function ruleDef(name, fn, phase, category, standard) {
    return { name: name, fn: fn, phase: phase, category: category, standard: standard || null };
  }

  function audit(userConfig) {
    var cfg = merge(DEFAULTS, userConfig || {});
    var isMobile = cfg.isMobile == null ? root.innerWidth <= 600 : !!cfg.isMobile;
    var findings = [];
    var rulesExpected = [];
    var rulesRun = [];
    var rulesSkipped = [];
    var elementIndex = qsa('body *');
    var ctx = { cfg: cfg, isMobile: isMobile, findings: findings, scanned: elementIndex.length, elements: elementIndex };

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
        delete el.__uiAuditControlGroupData;
      });
      cachedElements = [];
      if (_getBoundingClientRect) {
        root.Element.prototype.getBoundingClientRect = _getBoundingClientRect;
      }
    }

    try {
      RULES.forEach(function (rule) {
        if (cfg.rulePhase === 'viewport' && rule.phase !== 'viewport') return;
        if (cfg.rulePhase === 'document' && rule.phase !== 'document') return;
        var name = rule.name, fn = rule.fn;
        rulesExpected.push(name);
        try {
          fn(ctx);
          rulesRun.push(name);
        } catch (err) {
          rulesSkipped.push(name + ': ' + (err && err.message || err));
        }
      });
    } finally {
      clearCache();
    }

    // Suppress before any cap so approved instances do not starve real defects.
    var suppressed = { whitelist: 0, baseline: 0, perRuleCap: 0, advisoryCap: 0, byRule: {} };
    var clean = findings.filter(function (f) {
      if (cfg.whitelist.some(function (s) { return whitelisted(f, s); })) { suppressed.whitelist++; return false; }
      if (cfg.baseline.some(function (b) { return b.rule === f.rule && b.selector === f.selector; })) { suppressed.baseline++; return false; }
      return true;
    });
    clean = dedupeSignals(clean);

    var metaByName = {};
    RULES.forEach(function (rule) { metaByName[rule.name] = rule; });
    clean.forEach(function (f) {
      var meta = metaByName[f.rule] || { category: 'coverage', standard: null };
      f.category = meta.category;
      if (meta.standard) f.standard = meta.standard;
    });
    clean = capPerRule(clean, cfg.maxFindingsPerRule, suppressed);

    var findingSignals = [];
    var advisorySignals = [];
    clean.forEach(function (f) {
      if (f.severity === 'Polish' || f.confidence === 'visual-judgment' || f.confidence === 'needs-visual') {
        f.review = f.severity === 'Polish' ? 'optional' : 'required';
        advisorySignals.push(f);
      } else {
        findingSignals.push(f);
      }
    });
    var required = advisorySignals.filter(function (f) { return f.review === 'required'; });
    var optional = advisorySignals.filter(function (f) { return f.review === 'optional'; });
    optional = fairCap(optional, cfg.maxPolish, suppressed);
    advisorySignals = required.concat(optional);

    var counts = countSeverities(findingSignals);
    var advisoryCounts = { required: required.length, optional: optional.length };

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
        rulesExpected: rulesExpected,
        rulesRun: rulesRun,
        rulesSkipped: rulesSkipped,
        elementsScanned: ctx.scanned,
        counts: counts,
        advisoryCounts: advisoryCounts,
        suppressed: suppressed
      },
      findings: findingSignals,
      advisories: advisorySignals
    };
  }

  function dedupeSignals(items) {
    var seen = {};
    return items.filter(function (f) {
      var key = f.rule + '|' + f.selector + '|' + f.message;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function capPerRule(items, max, suppressed) {
    if (!Number.isFinite(max) || max < 1) return items;
    var counts = {};
    return items.filter(function (f) {
      counts[f.rule] = (counts[f.rule] || 0) + 1;
      if (counts[f.rule] <= max) return true;
      suppressed.perRuleCap++;
      suppressed.byRule[f.rule] = (suppressed.byRule[f.rule] || 0) + 1;
      return false;
    });
  }

  // Round-robin across rules prevents one noisy heuristic from consuming the
  // entire optional-advisory budget.
  function fairCap(items, max, suppressed) {
    if (!Number.isFinite(max) || max < 0 || items.length <= max) return items;
    var buckets = {}, order = [];
    items.forEach(function (item) {
      if (!buckets[item.rule]) { buckets[item.rule] = []; order.push(item.rule); }
      buckets[item.rule].push(item);
    });
    var out = [], index = 0;
    while (out.length < max && order.length) {
      var rule = order[index % order.length];
      if (buckets[rule].length) out.push(buckets[rule].shift());
      if (!buckets[rule].length) {
        order.splice(index % order.length, 1);
        if (!order.length) break;
      } else index++;
    }
    suppressed.advisoryCap += items.length - out.length;
    items.forEach(function (item) {
      if (out.indexOf(item) < 0) suppressed.byRule[item.rule] = (suppressed.byRule[item.rule] || 0) + 1;
    });
    return out;
  }

  function countSeverities(items) {
    var counts = { Fail: 0, Risk: 0, Polish: 0 };
    items.forEach(function (f) { counts[f.severity] = (counts[f.severity] || 0) + 1; });
    return counts;
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
      var cs = getComputedStyle(el);
      var fg = parseColor(cs.color);
      if (!fg) continue;
      var bg = contrastBg(el);
      var fgOnBg = fg[3] < 1 ? composite(fg, bg.rgb) : fg.slice(0, 3);
      var ratio = contrast(fgOnBg, bg.rgb);
      var px = parseFloat(cs.fontSize);
      var bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
      var large = px >= 24 || (px >= 18.66 && bold);
      var min = large ? cfg.contrast.large : cfg.contrast.normal;
      var txt = el.textContent.trim().slice(0, 40);
      if (bg.indeterminate) {
        ctx.findings.push(mk('effectiveContrast', 'Risk', 'needs-visual', cssPath(el),
          'Text "' + txt + '" uses unresolved background or paint compositing — rendered-pixel contrast review is required.',
          { ratioVsResolvedBg: round2(ratio), bgIndeterminateReason: bg.reason }, { min: min }, rectOf(el),
          'Sample the text pixels from a screenshot crop; ensure ' + min + ':1 against the actual rendered background.'));
        continue;
      }
      if (ratio >= min) continue;
      ctx.findings.push(mk('effectiveContrast', 'Fail', 'auto-measured', cssPath(el),
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
      var placeholderText = el.getAttribute('placeholder') || '';
      if (!placeholderText.trim() || !el.matches(':placeholder-shown')) return;
      var ph = getComputedStyle(el, '::placeholder');
      var fg = parseColor(ph.color);
      if (!fg) return;
      var placeholderOpacity = parseFloat(ph.opacity);
      if (Number.isFinite(placeholderOpacity)) fg[3] *= Math.max(0, Math.min(1, placeholderOpacity));
      var bg = contrastBg(el, ph);
      var fgOnBg = fg[3] < 1 ? composite(fg, bg.rgb) : fg.slice(0, 3);
      var ratio = contrast(fgOnBg, bg.rgb);
      var px = parseFloat(ph.fontSize || getComputedStyle(el).fontSize);
      var bold = (parseInt(ph.fontWeight || getComputedStyle(el).fontWeight, 10) || 400) >= 700;
      var large = px >= 24 || (px >= 18.66 && bold);
      var min = large ? cfg.contrast.large : cfg.contrast.normal;
      var confidence = bg.indeterminate ? 'needs-visual' : 'auto-measured';
      if (!bg.indeterminate && ratio >= min) return;
      ctx.findings.push(mk('placeholderContrast', confidence === 'needs-visual' ? 'Risk' : 'Fail', confidence, cssPath(el),
        bg.indeterminate
          ? 'Placeholder "' + placeholderText.slice(0, 30) + '" uses unresolved background or paint compositing — rendered-pixel contrast review is required.'
          : 'Placeholder "' + placeholderText.slice(0, 30) + '" contrast ' + round2(ratio) + ':1 below ' + min + ':1.',
        { ratio: round2(ratio), fg: rgbStr(fgOnBg), bg: rgbStr(bg.rgb), fontPx: px, bold: bold, large: large,
          bgIndeterminateReason: bg.reason || null }, { min: min }, rectOf(el),
        'Darken/lighten placeholder text; placeholders are not a substitute for a visible label.'));
    });
  }

  function ruleNonTextContrast(ctx) {
    var min = Number(ctx.cfg.contrast.nonText || 3);
    var fieldSelector = 'textarea,select,' +
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset])' +
      ':not([type=image]):not([type=range]):not([type=color]):not([type=file])';

    qsa(fieldSelector).forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      var type = (el.getAttribute('type') || '').toLowerCase();
      var appearance = cs.appearance || cs.webkitAppearance || '';
      if ((type === 'checkbox' || type === 'radio') && appearance !== 'none') return;

      var adjacent = effectiveBg(el.parentElement || document.body);
      var cues = boundaryContrastCues(cs, adjacent.rgb);
      var best = cues.reduce(function (current, cue) {
        return !current || cue.ratio > current.ratio ? cue : current;
      }, null);
      var complex = adjacent.indeterminate ||
        (cs.backgroundImage && cs.backgroundImage !== 'none') ||
        (cs.borderImageSource && cs.borderImageSource !== 'none') ||
        (cs.boxShadow && cs.boxShadow !== 'none') ||
        (cs.filter && cs.filter !== 'none');
      if (best && best.ratio >= min) return;

      var confidence = complex ? 'needs-visual' : 'auto-measured';
      var finding = mk('nonTextContrast', confidence === 'auto-measured' ? 'Fail' : 'Risk', confidence, cssPath(el),
        'Form control boundary has no confirmed visual cue at or above ' + min + ':1 against its adjacent background.',
        {
          bestCue: best ? best.kind : 'none',
          bestRatio: best ? round2(best.ratio) : 1,
          cues: contrastEvidence(cues, 6),
          backgroundIndeterminateReason: adjacent.reason || null
        },
        { min: min }, rectOf(el),
        'Raise a required border, underline, or fill cue to at least ' + min + ':1; keep complex effects only when pixel review proves the boundary remains visible.');
      ctx.findings.push(finding);
    });

    qsa('button,a[href],[role=button],[role=link]').forEach(function (control) {
      if (!isVisible(control) || isExempt(control)) return;
      if (/[\p{L}\p{N}]/u.test((control.innerText || '').trim())) return;
      var hasSvg = qsa('svg', control).some(isVisible);
      var symbolText = (control.innerText || '').trim();
      if (!hasSvg && !symbolText) return;

      var surface = effectiveBg(control);
      var paints = iconContrastPaints(control, surface.rgb);
      if (!paints.length) return;
      var low = paints.filter(function (paint) { return paint.ratio < min; });
      if (!low.length && !surface.indeterminate) return;

      var simple = paints.length === 1 && !surface.indeterminate;
      ctx.findings.push(mk('nonTextContrast', simple ? 'Fail' : 'Risk', simple ? 'auto-measured' : 'needs-visual', cssPath(control),
        'Icon-only control has no confirmed icon paint at or above ' + min + ':1 against its immediate surface.',
        {
          paints: contrastEvidence(paints, 8),
          backgroundIndeterminateReason: surface.reason || null
        },
        { min: min }, rectOf(control),
        'Increase the required icon or state indicator contrast to at least ' + min + ':1; pixel-check multi-color icons and icons over imagery.'));
    });
  }

  function ruleInlineLinkAffordance(ctx) {
    var min = Number(ctx.cfg.contrast.colorCue || 3);
    qsa('a[href]').forEach(function (link) {
      if (!isVisible(link) || isExempt(link)) return;
      if (link.closest('nav,[role=navigation],[role=menu],[role=toolbar],[role=tablist],button,[role=button],h1,h2,h3,h4,h5,h6')) return;
      var prose = link.closest('p,li,dd,dt,blockquote,figcaption');
      if (!prose) return;
      var peer = surroundingTextElement(prose, link);
      if (!peer || hasPersistentLinkCue(link, peer)) return;

      var linkColor = renderedForeground(link);
      var peerColor = renderedForeground(peer);
      if (!linkColor || !peerColor) return;
      var ratio = contrast(linkColor, peerColor);
      var sameColor = rgbDistance(linkColor, peerColor) < 1;
      var message;
      var finding;

      if (sameColor) {
        message = 'Inline link has no persistent non-color cue and looks the same as surrounding text.';
        finding = mk('inlineLinkAffordance', 'Risk', 'visual-judgment', cssPath(link), message,
          { linkVsText: round2(ratio), sameColor: true }, { colorCueMin: min }, rectOf(link),
          'Underline the link or add another persistent non-color cue that distinguishes it from prose.');
      } else if (ratio < min) {
        message = 'Inline link is distinguished only by color, but its color differs from surrounding text by only ' + round2(ratio) + ':1.';
        finding = mk('inlineLinkAffordance', 'Fail', 'auto-measured', cssPath(link), message,
          { linkVsText: round2(ratio), sameColor: false }, { colorCueMin: min }, rectOf(link),
          'Add a persistent underline or other non-color cue; do not rely on a sub-' + min + ':1 text-color difference.');
        finding.standard = 'WCAG 1.4.1';
      } else {
        message = 'Inline link relies on a ' + round2(ratio) + ':1 color difference alone; verify a non-color cue appears on hover and keyboard focus.';
        finding = mk('inlineLinkAffordance', 'Risk', 'visual-judgment', cssPath(link), message,
          { linkVsText: round2(ratio), sameColor: false }, { colorCueMin: min }, rectOf(link),
          'Prefer a persistent underline; otherwise prove a non-color cue on both hover and keyboard focus.');
        finding.standard = 'WCAG 1.4.1';
      }
      ctx.findings.push(finding);
    });
  }

  function ruleHOverflow(ctx) {
    var de = document.documentElement;
    var tol = ctx.cfg.overflowTolerancePx;
    if (de.scrollWidth <= de.clientWidth + tol) return;
    // find widest visible offenders that cross the viewport's right edge
    var vw = de.clientWidth, offenders = [], exemptOverflow = false;
    ctx.elements.forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (ctx.cfg.adaptation === 'reflow-320' && el.closest('[data-ui-audit-reflow-exempt=true]')) {
        var exemptRect = el.getBoundingClientRect();
        if (exemptRect.right > vw + tol) exemptOverflow = true;
        return;
      }
      var cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) || insideHorizontalScroller(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + tol && r.left < vw) {
        offenders.push({ el: el, over: Math.round(r.right - vw) });
      }
    });
    if (!offenders.length && exemptOverflow) return;
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
    ctx.elements.forEach(function (el) {
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
    var bars = ctx.elements.filter(function (el) {
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
    ctx.elements.forEach(function (el) {
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
    ctx.elements.forEach(function (el) {
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
    ctx.elements.forEach(function (el) {
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
    var cfg = ctx.cfg.tap;
    var sel = 'button,[role=button],a[href],input:not([type=hidden]),select,textarea,[onclick],[role=tab],[role=menuitem]';
    var targets = qsa(sel).filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      if (el.closest('[data-ui-audit-target-exempt=true]')) return false;
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false; // inline text link
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    targets.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var small = Math.min(r.width, r.height);
      if (small < cfg.fail) {
        var spacing = targetSpacingProof(el, targets, cfg.fail);
        if (!spacing.passes) {
          ctx.findings.push(mk('targetSizeMinimum', 'Fail', 'auto-measured', cssPath(el),
            'Pointer target ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px is below ' + cfg.fail + 'px and its spacing exception fails.',
            { w: Math.round(r.width), h: Math.round(r.height), nearestGapPx: round2(spacing.nearestGapPx), nearestSelector: spacing.nearestSelector },
            { min: cfg.fail, spacingCircleDiameter: cfg.fail }, rectOf(el),
            'Increase the hit area to at least ' + cfg.fail + '×' + cfg.fail + 'px, or provide enough separation for the WCAG spacing exception.'));
        }
      }
      if (ctx.isMobile && small >= cfg.fail && small < cfg.risk) {
        ctx.findings.push(mk('targetSizeMinimum', 'Polish', 'auto-measured', cssPath(el),
          'Pointer target ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px meets the minimum but is under the comfortable ' + cfg.risk + 'px mobile size.',
          { w: Math.round(r.width), h: Math.round(r.height) }, { comfortable: cfg.risk }, rectOf(el),
          'Aim for ' + cfg.risk + 'px touch targets on mobile.'));
      }
    });
  }

  // WCAG 2.5.8 spacing exception: a 24 CSS-px diameter circle centered on a
  // sub-minimum target must not intersect another target (or another such circle).
  function targetSpacingProof(el, targets, diameter) {
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2, radius = diameter / 2;
    var proof = { passes: true, nearestGapPx: Infinity, nearestSelector: null };
    targets.forEach(function (other) {
      if (other === el || el.contains(other) || other.contains(el)) return;
      var o = other.getBoundingClientRect();
      var ocx = o.left + o.width / 2, ocy = o.top + o.height / 2;
      var otherSmall = Math.min(o.width, o.height) < diameter;
      var distance;
      if (otherSmall) {
        distance = Math.sqrt(Math.pow(cx - ocx, 2) + Math.pow(cy - ocy, 2)) - diameter;
      } else {
        var dx = Math.max(o.left - cx, 0, cx - o.right);
        var dy = Math.max(o.top - cy, 0, cy - o.bottom);
        distance = Math.sqrt(dx * dx + dy * dy) - radius;
      }
      if (distance < proof.nearestGapPx) {
        proof.nearestGapPx = distance;
        proof.nearestSelector = cssPath(other);
      }
      if (distance < 0) proof.passes = false;
    });
    if (!Number.isFinite(proof.nearestGapPx)) proof.nearestGapPx = null;
    return proof;
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
      // Candidate primary must carry actual submit/primary semantics. Picking the
      // largest arbitrary button on a page mistakes filters and tabs for CTAs.
      var primary = btns.filter(function (b) {
        return !!b.form && (b.type === 'submit' || b.getAttribute('type') === 'submit');
      })[0];
      if (!primary) primary = btns.filter(function (b) {
        return b.matches('[data-primary=true],.primary,.primary-action,[class*=primary]');
      })[0];
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
    // Non-ARIA custom segmented controls must opt in with an explicit semantic
    // marker. Arbitrary two-button flex rows are normally primary/secondary CTAs.
    qsa('[data-ui-audit-selection-group],.segmented-control,.segment-control,.seg').forEach(function (g) {
      if (groups.indexOf(g) < 0 && !g.closest('nav,[role=navigation]')) groups.push(g);
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
    var navs = qsa('nav,[role=navigation]').concat(ctx.elements.filter(function (el) {
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

  function ruleUninspectedSurface(ctx) {
    function renderedSurface(el) {
      var node = el;
      while (node && node.nodeType === 1) {
        var style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || parseFloat(style.opacity) < 0.05) return false;
        node = node.parentElement;
      }
      var bounds = el.getBoundingClientRect();
      return bounds.width >= 1 && bounds.height >= 1;
    }
    var candidates = qsa('iframe,canvas,object,embed');
    ctx.elements.forEach(function (el) {
      if (el.shadowRoot && candidates.indexOf(el) < 0) candidates.push(el);
    });
    candidates.forEach(function (el) {
      if (!renderedSurface(el)) return;
      var exemption = el.getAttribute('data-ui-audit-surface-exempt');
      if (typeof exemption === 'string' && exemption.trim()) return;
      var kind = el.shadowRoot ? 'open-shadow-root' : el.tagName.toLowerCase();
      ctx.findings.push(mk('uninspectedSurface', 'Risk', 'needs-visual', cssPath(el),
        'Visible ' + kind + ' content is outside this light-DOM audit and needs separate rendered inspection.',
        { surface: kind, openShadowRoot: !!el.shadowRoot, exemptionReason: exemption || null },
        { separateInspectionRequired: true }, rectOf(el),
        'Inspect the rendered surface separately, or add data-ui-audit-surface-exempt="<reason>" only when equivalent evidence already exists.'));
    });
  }

  function ruleFocusTrap(ctx) {
    var modals = qsa('[role=dialog][aria-modal=true],[role=alertdialog][aria-modal=true]').filter(function (m) {
      return isVisible(m) && getComputedStyle(m).display !== 'none';
    });
    if (!modals.length) return;
    modals = [modals.map(function (modal, order) {
      var rect = modal.getBoundingClientRect();
      var x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      var y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      var hit = document.elementsFromPoint(x, y).some(function (el) {
        return el === modal || modal.contains(el);
      });
      var z = parseInt(getComputedStyle(modal).zIndex, 10);
      return { modal: modal, hit: hit, z: isFinite(z) ? z : 0, order: order };
    }).sort(function (a, b) {
      if (a.hit !== b.hit) return a.hit ? 1 : -1;
      if (a.z !== b.z) return a.z - b.z;
      return a.order - b.order;
    }).pop().modal];
    var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]';
    modals.forEach(function (modal) {
      var outside = qsa(FOCUSABLE).filter(function (el) {
        if (modal.contains(el) || !isVisible(el)) return false;
        if (el.getAttribute('tabindex') === '-1') return false;
        if (el.closest('[inert],[aria-hidden=true]')) return false;
        return true;
      });
      if (outside.length) {
        ctx.findings.push(mk('focusTrapLeak', 'Risk', 'visual-judgment', cssPath(modal),
          'Modal is open with ' + outside.length + ' focusable element(s) behind it; DOM structure alone cannot prove whether Tab escapes.',
          { outsideFocusableCount: outside.length, firstOutside: cssPath(outside[0]), keyboardProbeRequired: true }, {}, rectOf(modal),
          'Verify initial focus plus forward/reverse Tab boundaries with trusted browser input; add inert as defense in depth.'));
      }
    });
  }

  function ruleCLS(ctx) {
    var s = root.__uiAuditState;
    if (!s || typeof s.cls !== 'number' || !s.clsInstalled) {
      ctx.findings.push(mk('layoutShiftCLS', 'Risk', 'needs-visual', 'html',
        'CLS not measured — the layout-shift observer was not installed before navigation.',
        { installed: false }, {}, null,
        'Install __uiAuditInstallCLS() via add_init_script before navigating so CLS is captured from first paint.'));
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
    var sel = 'button,[role=button],.btn,input:not([type=hidden]),select,textarea';
    var candidates = qsa(sel).filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      if (el.closest('h1,h2,h3,h4,h5,h6,label,[data-ui-audit-layout-exempt=true]')) return false;
      var closestInteractive = el.closest('button,[role=button],a[href],input,select,textarea');
      if (closestInteractive && closestInteractive !== el) return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.width < threshold;
    });

    candidates.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var group = el.closest('[data-ui-audit-control-group],form,[role=group],.toolbar,.filters,.controls');
      if (!group || group === el) return;
      var controls = qsa(sel, group).filter(function (other) {
        if (other === el || !isVisible(other) || isExempt(other)) return false;
        return other.closest('[data-ui-audit-control-group],form,[role=group],.toolbar,.filters,.controls') === group;
      });
      if (controls.length < 2) return;
      var sameRow = controls.some(function (other) {
        var or = other.getBoundingClientRect();
        var overlap = Math.min(r.bottom, or.bottom) - Math.max(r.top, or.top);
        var minH = Math.min(r.height, or.height);
        return overlap > 0 && (overlap >= minH * 0.5 || overlap >= 10);
      });
      if (sameRow) return;
      var adjacentRows = {};
      controls.forEach(function (other) {
        var top = Math.round(other.getBoundingClientRect().top / 6) * 6;
        adjacentRows[top] = (adjacentRows[top] || 0) + 1;
      });
      var hasPeerRow = Object.keys(adjacentRows).some(function (top) {
        return adjacentRows[top] >= 2 && Math.abs(Number(top) - r.top) < Math.max(180, group.getBoundingClientRect().height);
      });
      if (hasPeerRow) {
        var text = (el.textContent || el.value || '').trim().slice(0, 20);
        ctx.findings.push(mk('loneNarrowElement', 'Polish', 'auto-measured', cssPath(el),
          'Narrow control "' + text + '" (' + Math.round(r.width) + 'px) is stranded beside an adjacent row of related controls.',
          { width: Math.round(r.width), text: text, groupSelector: cssPath(group) }, { threshold: threshold }, rectOf(el),
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

    var buttons = qsa('button,[role=button],input[type=button],input[type=submit],.btn,.button').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      return isButton(el);
    });
    var containers = [];
    buttons.forEach(function (button) {
      var container = button.closest('[data-ui-audit-action-group],[role=toolbar],.actions,.toolbar') || button.parentElement;
      if (container && containers.indexOf(container) < 0) containers.push(container);
    });
    containers.forEach(function (container) {
      if (container.closest('nav,[role=navigation],[role=tablist],[data-ui-audit-valid-control-group=true]')) return;
      var local = buttons.filter(function (button) {
        return (button.closest('[data-ui-audit-action-group],[role=toolbar],.actions,.toolbar') || button.parentElement) === container;
      });
      var rows = [];
      local.forEach(function (button) {
        var br = button.getBoundingClientRect();
        var row = rows.filter(function (candidate) { return Math.abs(candidate[0].rect.top - br.top) < 6; })[0];
        if (row) row.push({ el: button, rect: br });
        else rows.push([{ el: button, rect: br }]);
      });
      rows.forEach(function (row) {
      if (row.length > maxCount) {
        var selectors = row.map(function (item) {
          return (item.el.textContent || '').trim().slice(0, 15) || item.el.tagName.toLowerCase();
        }).join(', ');

        ctx.findings.push(mk('excessiveButtonsInRow', 'Polish', 'auto-measured', cssPath(container),
          'Too many buttons listed in a single row (' + row.length + ' buttons: ' + selectors + '). Consider grouping some under a menu/dropdown.',
          { count: row.length }, { max: maxCount }, rectOf(container),
          'Group some or all of these buttons into a dropdown menu (e.g., a "More" action menu) to clean up the row.'));
      }
      });
    });
  }

  function ruleDrift(ctx) {
    var cfg = ctx.cfg.polish;
    var radii = {}, shadows = {}, hues = {}, fontPairs = {};
    ctx.elements.forEach(function (el) {
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

  function controlGroupData(group) {
    var controlSelector = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=menuitem],[role=tab],summary';
    var controls = qsa(controlSelector, group).filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      var parentControl = el.parentElement && el.parentElement.closest(controlSelector);
      return !parentControl || !group.contains(parentControl);
    });
    var metadata = qsa('span,p,output,small,strong,div', group).filter(function (el) {
      if (!isVisible(el) || isExempt(el) || !hasOwnText(el)) return false;
      return !el.closest(controlSelector);
    });
    var items = controls.concat(metadata).filter(function (el, index, all) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && all.indexOf(el) === index;
    });
    items.sort(function (a, b) {
      var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return ar.top - br.top || ar.left - br.left;
    });
    var rows = [];
    items.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var row = rows.find(function (candidate) {
        var overlap = Math.min(candidate.bottom, r.bottom) - Math.max(candidate.top, r.top);
        return overlap >= Math.min(candidate.height, r.height) * 0.25 || Math.abs(candidate.top - r.top) < 8;
      });
      if (!row) {
        row = { top: r.top, bottom: r.bottom, height: r.height, items: [], controls: [] };
        rows.push(row);
      }
      row.items.push(el);
      if (controls.indexOf(el) >= 0) row.controls.push(el);
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.bottom);
      row.height = row.bottom - row.top;
    });
    rows.sort(function (a, b) { return a.top - b.top; });
    return { controls: controls, rows: rows };
  }

  function semanticControlGroups() {
    var selector = 'form,[role=search],[role=toolbar],nav,[aria-label*="pagination" i],[class*="pagination" i],[class*="toolbar" i],[class*="search" i]';
    var seen = {};
    return qsa(selector).filter(function (group) {
      if (!isVisible(group) || isExempt(group)) return false;
      if (group.matches('[role=tablist],[role=menu],[data-ui-audit-edge-to-edge=true],[data-ui-audit-layout-exempt=true]')) return false;
      var data = controlGroupData(group);
      if (data.controls.length < 2 || data.rows.length < 2) return false;
      var signature = data.controls.map(cssPath).sort().join('|');
      if (seen[signature]) return false;
      seen[signature] = true;
      group.__uiAuditControlGroupData = data;
      cachedElements.push(group);
      return true;
    });
  }

  function styledControlSurface(group) {
    var cs = getComputedStyle(group);
    var parent = group.parentElement && getComputedStyle(group.parentElement);
    var border = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']
      .some(function (property) { return parseFloat(cs[property]) > 0; });
    var rounded = parseFloat(cs.borderTopLeftRadius) > 0 || parseFloat(cs.borderTopRightRadius) > 0 ||
      parseFloat(cs.borderBottomLeftRadius) > 0 || parseFloat(cs.borderBottomRightRadius) > 0;
    var surfaced = parent && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== parent.backgroundColor;
    return border || rounded || surfaced;
  }

  function ruleControlGroupSpacing(ctx) {
    var minInset = Number(ctx.cfg.layout.controlGroupMinInset || 8);
    var maxDelta = Number(ctx.cfg.layout.controlGroupRowInsetDelta || 12);
    semanticControlGroups().forEach(function (group) {
      if (!styledControlSurface(group)) return;
      var data = group.__uiAuditControlGroupData || controlGroupData(group);
      var bounds = group.getBoundingClientRect();
      var insets = data.rows.map(function (row) {
        var rects = row.items.map(function (item) { return item.getBoundingClientRect(); });
        var left = Math.min.apply(null, rects.map(function (r) { return r.left; })) - bounds.left;
        var right = bounds.right - Math.max.apply(null, rects.map(function (r) { return r.right; }));
        return { left: round2(left), right: round2(right), items: row.items.length };
      });
      var lefts = insets.map(function (value) { return value.left; });
      var rights = insets.map(function (value) { return value.right; });
      var smallest = Math.min.apply(null, lefts.concat(rights));
      var leftDelta = Math.max.apply(null, lefts) - Math.min.apply(null, lefts);
      var rightDelta = Math.max.apply(null, rights) - Math.min.apply(null, rights);
      if (smallest >= minInset && leftDelta <= maxDelta && rightDelta <= maxDelta) return;
      ctx.findings.push(mk('controlGroupSpacing', 'Polish', 'auto-measured', cssPath(group),
        'Rows in this control group do not share a clear, consistent edge inset.',
        { rowInsets: insets, minInsetPx: round2(smallest), leftInsetDeltaPx: round2(leftDelta), rightInsetDeltaPx: round2(rightDelta) },
        { minInsetPx: minInset, maxRowInsetDeltaPx: maxDelta }, rectOf(group),
        'Give every control-group row a shared horizontal padding token and align its content edges.'));
    });
  }

  function ruleOrphanedControlRow(ctx) {
    var maxWidth = Number(ctx.cfg.layout.orphanControlMaxWidth || 180);
    var maxRatio = Number(ctx.cfg.layout.orphanControlMaxRatio || 0.25);
    semanticControlGroups().forEach(function (group) {
      if (group.matches('[data-ui-audit-stacked=true]')) return;
      var data = group.__uiAuditControlGroupData || controlGroupData(group);
      var bounds = group.getBoundingClientRect();
      data.rows.forEach(function (row, index) {
        if (row.controls.length !== 1) return;
        var neighbor = (index > 0 && data.rows[index - 1].controls.length >= 2) ||
          (index + 1 < data.rows.length && data.rows[index + 1].controls.length >= 2);
        if (!neighbor) return;
        var control = row.controls[0];
        var width = control.getBoundingClientRect().width;
        var ratio = bounds.width ? width / bounds.width : 1;
        if (width > maxWidth || ratio > maxRatio) return;
        ctx.findings.push(mk('orphanedControlRow', 'Polish', 'auto-measured', cssPath(control),
          'A narrow control is stranded on its own row next to a denser related control row.',
          { controlWidthPx: round2(width), groupWidthPx: round2(bounds.width), widthRatio: round2(ratio), rowIndex: index, rowCount: data.rows.length },
          { maxWidthPx: maxWidth, maxWidthRatio: maxRatio }, rectOf(control),
          'Place the related control with its peers, or create an explicit secondary toolbar with consistent padding and alignment.'));
      });
    });
  }

  function ruleInconsistentSpacing(ctx) {
    ctx.elements.forEach(function (parent) {
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

  function ruleBodyTextAlignment(ctx) {
    bodyTextCandidates(ctx).forEach(function (candidate) {
      var align = candidate.style.textAlign;
      if (align !== 'center' && align !== 'justify') return;
      ctx.findings.push(mk('bodyTextAlignment', 'Polish', 'auto-measured', cssPath(candidate.el),
        'Long-form text spans ' + candidate.lines + ' rendered lines with ' + align + ' alignment, which weakens a stable reading edge.',
        { textAlign: align, lines: candidate.lines, chars: candidate.chars }, {}, rectOf(candidate.el),
        'Use logical start alignment for long-form text; reserve centered alignment for short headings or compact copy.'));
    });
  }

  function ruleBodyTextLineHeight(ctx) {
    var min = Number((ctx.cfg.polish && ctx.cfg.polish.bodyLineHeight) || 1.5);
    bodyTextCandidates(ctx).forEach(function (candidate) {
      var lineHeight = candidate.style.lineHeight;
      if (lineHeight === 'normal') return;
      var lineHeightPx = parseFloat(lineHeight);
      var fontSize = parseFloat(candidate.style.fontSize);
      if (!Number.isFinite(lineHeightPx) || !Number.isFinite(fontSize) || fontSize <= 0) return;
      var ratio = lineHeightPx / fontSize;
      if (ratio < 0.95 || ratio >= min) return;
      ctx.findings.push(mk('bodyTextLineHeight', 'Polish', 'auto-measured', cssPath(candidate.el),
        'Long-form text uses a ' + round2(ratio) + ' line-height ratio, below the ' + min + ' readability guideline.',
        { lineHeightRatio: round2(ratio), lineHeightPx: round2(lineHeightPx), fontSizePx: round2(fontSize), lines: candidate.lines, chars: candidate.chars },
        { recommendedMin: min }, rectOf(candidate.el),
        'Increase long-form body line-height toward ' + min + '; treat this as readability guidance, not a WCAG AA conformance failure.'));
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
    ctx.elements.forEach(function (parent) {
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
    ctx.elements.forEach(function (el) {
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
    ctx.elements.forEach(function (el) {
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
    ctx.elements.forEach(function (parent) {
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
    ctx.elements.forEach(function (parent) {
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
    // Native buttons, links, and form controls do not require cursor:pointer.
    // Restrict this advisory to custom elements that borrow interactive semantics.
    qsa('[role=button]:not(button),[role=link]:not(a),[onclick]:not(button):not(a):not(input)').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var cs = getComputedStyle(el);
      if (!cs) return;
      if (cs.cursor !== 'pointer') {
        ctx.findings.push(mk('missingClickableCursor', 'Polish', 'auto-measured', cssPath(el),
          'Clickable element has no pointer cursor in its resting rendered state, reducing affordance.',
          { cursor: cs.cursor }, {}, rectOf(el),
          'Apply "cursor: pointer" to the clickable element; visible hover feedback is checked separately by the trusted pointer probe.'));
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
      ctx.elements.forEach(function (el) {
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

  // -------------------------- widget contract --------------------------
  // A standard widget promises a rule by its own shape: a square says "pick any", a
  // circle "pick exactly one", a toggle "this applies now", a tab strip "parallel
  // panels at one level". These rules check that promise. They are about semantics,
  // not pixels, so none of them re-measure what the rendering rules above already do.

  function ruleMultiRowTabs(ctx) {
    // Narrow layouts wrap legitimately; the spatial-memory argument is a desktop one.
    if (ctx.isMobile || ctx.cfg.adaptation === 'reflow-320') return;
    qsa('[role=tablist]').forEach(function (list) {
      if (!isVisible(list) || isExempt(list)) return;
      if (list.getAttribute('aria-orientation') === 'vertical') return;
      var tabs = qsa('[role=tab]', list).filter(function (t) { return isVisible(t) && !isExempt(t); });
      if (tabs.length < 3) return;
      var rows = [];
      tabs.forEach(function (tab) {
        var top = tab.getBoundingClientRect().top;
        var row = null;
        for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].top - top) <= 4) { row = rows[i]; break; }
        if (row) row.tabs.push(tab); else rows.push({ top: top, tabs: [tab] });
      });
      if (rows.length < 2) return;
      // One tab per row is a vertical rail, not a wrapped horizontal strip.
      if (rows.every(function (r) { return r.tabs.length === 1; })) return;
      ctx.findings.push(mk('multiRowTabs', 'Risk', 'auto-measured', cssPath(list),
        'Tab strip wraps onto more than one row. Selecting a back-row tab reshuffles the rows, so the position users memorized for every other tab moves.',
        { rows: rows.length, tabs: tabs.length, labels: tabs.slice(0, 8).map(labelText) }, { rows: 1 }, rectOf(list),
        'Keep tabs to one row: shorten labels to 1-2 words, reduce the tab count, or move the overflow behind a menu or a different navigation pattern.'));
    });
  }

  function rulePlaceholderAsOnlyLabel(ctx) {
    var PLACEHOLDER_TYPES = { text: 1, email: 1, url: 1, tel: 1, password: 1, number: 1, date: 1,
      'datetime-local': 1, month: 1, week: 1, time: 1 };
    qsa('input[placeholder],textarea[placeholder]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (!(el.getAttribute('placeholder') || '').trim()) return;
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      // The magnifying-glass search box is an accepted convention; everything else
      // owes the user a label that survives the first keystroke.
      if (type === 'search' || el.closest('[role=search],form[role=search]')) return;
      if (el.tagName === 'INPUT' && !PLACEHOLDER_TYPES[type]) return;
      if (visibleLabelText(el)) return;
      // No visible label at all. `unlabeledInput` already owns the case where nothing
      // names the control; this rule owns the one that is programmatically named but
      // visually labelled by placeholder text only.
      if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) return;
      ctx.findings.push(mk('placeholderAsOnlyLabel', 'Risk', 'auto-measured', cssPath(el),
        'Field has no persistent visible label. The placeholder is the only visible naming text and it disappears as soon as the user types, so the field is unlabeled exactly while it is being filled in and reviewed.',
        { placeholder: (el.getAttribute('placeholder') || '').trim().slice(0, 60),
          accessibleNameSource: el.getAttribute('aria-labelledby') ? 'aria-labelledby' : (el.getAttribute('aria-label') ? 'aria-label' : 'title') },
        {}, rectOf(el),
        'Add a persistent visible <label> outside the field. Keep the placeholder for format examples only.'));
    });
  }

  function ruleStackedDialogs(ctx) {
    var open = qsa('[aria-modal=true],dialog[open]').filter(function (d) {
      if (!isVisible(d) || isExempt(d)) return false;      // isExempt covers inert / aria-hidden handoff
      if (d.tagName === 'DIALOG') return d.hasAttribute('open');
      var role = d.getAttribute('role');
      return role === 'dialog' || role === 'alertdialog';
    });
    if (open.length < 2) return;
    var top = open[open.length - 1];
    ctx.findings.push(mk('stackedDialogs', 'Risk', 'auto-measured', cssPath(top),
      'More than one modal dialog is open at once. Each modal taxes working memory with the task it interrupted; stacking them means the user must hold two suspended tasks to answer one question.',
      { dialogs: open.length, selectors: open.map(cssPath).slice(0, 4) }, { dialogs: 1 }, rectOf(top),
      'Resolve or dismiss the first dialog before opening the second, or merge them into one decision. If the outer dialog is genuinely handed off, mark it inert/aria-hidden.'));
  }

  function ruleSingleRadioInGroup(ctx) {
    // Group by (form scope, name) over ALL radios, visible or not: a hidden sibling
    // still makes the group a real group, and reporting on a transient render is noise.
    var groups = {};
    qsa('input[type=radio]').forEach(function (radio) {
      var key = formKey(radio) + '::' + (radio.name || '');
      (groups[key] = groups[key] || []).push(radio);
    });
    qsa('input[type=radio]').forEach(function (radio) {
      if (!isVisible(radio) || isExempt(radio)) return;
      // An unnamed radio is its own group as far as the browser is concerned, but a
      // custom radiogroup widget may still be managing selection across siblings.
      var group = radio.closest('[role=radiogroup]');
      if (group && qsa('[role=radio],input[type=radio]', group).length > 1) return;
      if (!radio.name) {
        report(radio, 1, 'the radio has no name attribute, so it forms a group of one');
        return;
      }
      var siblings = groups[formKey(radio) + '::' + radio.name] || [];
      if (siblings.length === 1) report(radio, siblings.length, 'no other radio shares this name');
    });

    function report(radio, size, why) {
      ctx.findings.push(mk('singleRadioInGroup', 'Risk', 'auto-measured', cssPath(radio),
        'Radio button is the only member of its group (' + why + '). A radio cannot be deselected once touched, so this control can be switched on but never back off.',
        { groupName: radio.name || null, groupSize: size }, { groupSize: 2 }, rectOf(radio),
        'Use a checkbox for a standalone on/off choice, or give the group the sibling options it implies (adding an explicit "None" option when abstaining is legitimate).'));
    }
  }

  function ruleToggleInsideSubmitForm(ctx) {
    qsa('[role=switch]').forEach(function (toggle) {
      if (!isVisible(toggle) || isExempt(toggle)) return;
      if (toggle.hasAttribute('data-ui-audit-toggle-exempt')) return;
      var form = toggle.closest('form,[role=form]');
      if (!form || form.matches('[role=search]') || form.closest('[role=search]')) return;
      var submit = qsa('button,input[type=submit],input[type=image]', form).filter(function (b) {
        return b.type === 'submit' || b.type === 'image';
      }).filter(function (b) { return isVisible(b) && !isExempt(b); })[0];
      if (!submit) return;
      ctx.findings.push(mk('toggleInsideSubmitForm', 'Risk', 'auto-measured', cssPath(toggle),
        'Toggle switch sits inside a form that commits through a submit button. A switch promises a light-switch effect that applies the moment it is flipped, so the screen contradicts itself about when the setting takes effect.',
        { submitControl: cssPath(submit), submitLabel: labelText(submit) }, {}, rectOf(toggle),
        'Use a checkbox when a submit button commits the choice, or apply the toggle immediately and drop it from the submitted form.'));
    });
  }

  function ruleOrphanedFieldError(ctx) {
    qsa('[aria-invalid=true]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (!el.matches('input,select,textarea,[role=textbox],[role=combobox],[role=spinbutton],[contenteditable=true]')) return;
      if (referencedVisibleText(el, 'aria-errormessage') || referencedVisibleText(el, 'aria-describedby')) return;
      var wrapper = el.closest('.field,.form-field,.form-group,.form-row,.input-group,label') || el.parentElement;
      if (wrapper && qsa('[role=alert],.error,.error-message,.field-error,.invalid-feedback,[data-ui-audit-error]', wrapper)
        .some(function (n) { return isVisible(n) && (n.innerText || '').trim(); })) return;
      ctx.findings.push(mk('orphanedFieldError', 'Risk', 'auto-measured', cssPath(el),
        'Field is marked invalid but carries no error text of its own. The user is told something is wrong without being told what, where, or how to recover.',
        { ariaInvalid: 'true', ariaDescribedby: el.getAttribute('aria-describedby') || null,
          ariaErrormessage: el.getAttribute('aria-errormessage') || null }, {}, rectOf(el),
        'Put a specific message next to the offending field and connect it with aria-describedby or aria-errormessage. Say what went wrong and how to fix it, without blaming the user.'));
    });
  }

  function ruleDesktopHiddenNav(ctx) {
    // Small screens are exactly where a hamburger is the right answer.
    if (ctx.isMobile || ctx.cfg.adaptation === 'reflow-320') return;
    // Deliberately excludes [role=menu]: a closed dropdown popup is on almost every
    // page and is not the site's top-level navigation. Only containers that hold a
    // real link set count, in either direction.
    var navSelector = 'nav,[role=navigation],[role=menubar]';
    function navLinkCount(nav) {
      return qsa('a,[role=link],[role=menuitem]', nav).filter(function (link) {
        return !isExempt(link) && (link.textContent || '').trim();
      }).length;
    }
    var hasVisibleNav = qsa(navSelector).some(function (nav) {
      if (!isVisible(nav) || isExempt(nav)) return false;
      return qsa('a,[role=link],[role=menuitem]', nav).filter(function (link) {
        return isVisible(link) && !isExempt(link);
      }).length >= 3;
    });
    if (hasVisibleNav) return;
    var hiddenNavExists = qsa(navSelector).some(function (nav) {
      return !isVisible(nav) && navLinkCount(nav) >= 3;
    });
    var toggle = qsa('button,[role=button],a[aria-controls],[aria-expanded]').filter(function (el) {
      if (!isVisible(el) || isExempt(el) || el.hasAttribute('data-ui-audit-nav-exempt')) return false;
      var controlled = el.getAttribute('aria-controls')
        ? document.getElementById(el.getAttribute('aria-controls'))
        : null;
      if (controlled && controlled.matches(navSelector) && !isVisible(controlled) && navLinkCount(controlled) >= 3) return true;
      if (!hiddenNavExists) return false;
      if (el.getAttribute('aria-expanded') === 'true') return false;
      var hint = (labelText(el) + ' ' + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + ' ' +
        (el.getAttribute('aria-label') || '')).toLowerCase();
      return /hamburger|menu-?(toggle|button|btn)?|nav-?(toggle|button|btn)|navigation|메뉴|네비|내비/.test(hint);
    })[0];
    if (!toggle) return;
    ctx.findings.push(mk('desktopHiddenNav', 'Polish', 'auto-measured', cssPath(toggle),
      'Top-level navigation is hidden behind a disclosure control on a pointer-capable desktop layout. Navigation users cannot see is navigation they do not use, and the screen has the room to show it.',
      { toggleLabel: labelText(toggle) || (toggle.getAttribute('aria-label') || ''),
        controls: toggle.getAttribute('aria-controls') || null }, {}, rectOf(toggle),
      'Show top-level navigation inline on desktop and reserve the hamburger for small viewports. If this surface is deliberately chrome-free (an app rail, a canvas tool), mark it data-ui-audit-nav-exempt.'));
  }

  function ruleImageMissingAlt(ctx) {
    // A MISSING alt attribute is the defect. alt="" is an explicit declaration that the
    // image carries no information, which is the correct answer for decoration.
    qsa('img,input[type=image]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (el.hasAttribute('alt')) return;
      if (el.matches('[role=presentation],[role=none]')) return;
      if (accessibleNameAttr(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      ctx.findings.push(mk('imageMissingAlt', 'Fail', 'auto-measured', cssPath(el),
        'Image has no alt attribute, so assistive technology announces its file name or nothing at all. A missing attribute is not the same promise as alt="", which declares the image decorative.',
        { tag: el.tagName.toLowerCase(), src: (el.getAttribute('src') || '').slice(0, 120) }, {}, rectOf(el),
        'Add alt text describing what the image conveys in this context, or alt="" if it is purely decorative.'));
    });
    qsa('svg[role=img]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (accessibleNameAttr(el)) return;
      var title = el.querySelector('title');
      if (title && (title.textContent || '').trim()) return;
      ctx.findings.push(mk('imageMissingAlt', 'Fail', 'auto-measured', cssPath(el),
        'Inline SVG declares role="img" but exposes no accessible name, so it is announced as an unlabeled image.',
        { tag: 'svg', role: 'img' }, {}, rectOf(el),
        'Add a non-empty <title> as the first child (referenced with aria-labelledby) or an aria-label. Drop role="img" and add aria-hidden="true" if the graphic is decorative.'));
    });
  }

  function ruleSkipLinkMissing(ctx) {
    // A <main> landmark is itself a bypass mechanism, so the rule only fires when
    // neither route past the repeated navigation exists.
    if (qsa('main,[role=main]').some(function (el) { return isVisible(el); })) return;
    var nav = qsa('nav,[role=navigation]').filter(function (el) {
      if (!isVisible(el) || isExempt(el)) return false;
      return qsa('a[href],[role=link]', el).filter(function (link) {
        return isVisible(link) && (link.textContent || '').trim();
      }).length >= 3;
    })[0];
    if (!nav) return;
    // A skip link is deliberately hidden until focused, so visibility cannot be part of
    // the search: walk the first tab stops in DOM order regardless of how they render.
    var LEAD_STOPS = 3;
    var stops = qsa('a[href],button,input,select,textarea,[tabindex]').filter(function (el) {
      if (el.matches('input[type=hidden]')) return false;
      var index = el.getAttribute('tabindex');
      return !(index != null && parseInt(index, 10) < 0);
    }).slice(0, LEAD_STOPS);
    var skip = stops.filter(function (el) {
      return el.tagName === 'A' && /^#./.test(el.getAttribute('href') || '');
    })[0];
    if (!skip) {
      ctx.findings.push(mk('skipLinkMissing', 'Risk', 'auto-measured', cssPath(nav),
        'Repeated navigation sits ahead of the content with no bypass: no skip link among the first tab stops and no main landmark. Keyboard and screen-reader users tab through the same menu on every screen.',
        { navLinks: qsa('a[href]', nav).length, leadTabStops: stops.length }, { leadTabStops: LEAD_STOPS }, rectOf(nav),
        'Add a skip link as the first focusable element pointing at the content container, and mark that container with <main>.'));
      return;
    }
    var target = document.getElementById(decodeURIComponent((skip.getAttribute('href') || '').slice(1)));
    if (target && getComputedStyle(target).display !== 'none') return;
    ctx.findings.push(mk('skipLinkMissing', 'Risk', 'auto-measured', cssPath(skip),
      'Skip link points at a target that does not exist or is not rendered, so activating it moves focus nowhere and the bypass silently fails.',
      { href: skip.getAttribute('href'), targetFound: !!target }, {}, rectOf(skip),
      'Point the skip link at the id of the rendered content container and give that container a main landmark.'));
  }

  function ruleSelectAutoSubmit(ctx) {
    // Only the inline attribute is readable from the DOM; a listener attached with
    // addEventListener is invisible here and is covered by the checklist instead.
    qsa('select[onchange],input[type=radio][onchange],input[type=checkbox][onchange]').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      if (el.hasAttribute('data-ui-audit-autosubmit-exempt')) return;
      var handler = el.getAttribute('onchange') || '';
      if (!/(^|[^\w.])submit\s*\(|\.\s*(request)?[Ss]ubmit\s*\(/.test(handler)) return;
      ctx.findings.push(mk('selectAutoSubmit', 'Risk', 'auto-measured', cssPath(el),
        'Changing this control submits the form immediately. Users who arrow through the options to read them commit an option they never chose, and there is no way back for anyone whose selection was accidental.',
        { onchange: handler.slice(0, 120) }, {}, rectOf(el),
        'Commit through an explicit submit control. If the surface really must react to the choice, keep the change reversible and announce it; mark a deliberate case data-ui-audit-autosubmit-exempt.'));
    });
  }

  function ruleMissingIndeterminateState(ctx) {
    qsa('input[type=checkbox]').forEach(function (master) {
      if (!isVisible(master) || isExempt(master)) return;
      var children = selectAllScope(master);
      if (children.length < 2) return;
      var checked = children.filter(function (child) { return child.checked; }).length;
      if (checked === 0 || checked === children.length) return;
      if (master.indeterminate === true) return;
      if (master.getAttribute('aria-checked') === 'mixed') return;
      ctx.findings.push(mk('missingIndeterminateState', 'Risk', 'auto-measured', cssPath(master),
        'Select-all checkbox shows a plain on/off state while only some of its options are selected. The box reports a selection the list does not have, and clicking it silently discards or extends the real one.',
        { selected: checked, total: children.length, checked: master.checked, indeterminate: !!master.indeterminate },
        { indeterminate: true }, rectOf(master),
        'Set the master checkbox indeterminate (or aria-checked="mixed") whenever the selection is partial, and clear it when it is empty or complete.'));
    });

    function selectAllScope(master) {
      var referenced = (master.getAttribute('aria-controls') || '').trim().split(/\s+/).filter(Boolean)
        .map(function (id) { return document.getElementById(id); })
        .filter(function (el) { return el && el.matches('input[type=checkbox]'); });
      if (referenced.length >= 2) return referenced;
      var head = master.closest('thead');
      var table = head && head.closest('table');
      if (table) {
        return bodyRows(table).reduce(function (acc, row) {
          return acc.concat(qsa('input[type=checkbox]', row));
        }, []).filter(function (box) { return box !== master; });
      }
      var hint = (labelText(master.closest('label,th,td') || master) + ' ' +
        (master.getAttribute('aria-label') || '') + ' ' + (master.className || '') + ' ' + (master.id || '')).toLowerCase();
      if (!/select[-_ ]?all|check[-_ ]?all|toggle[-_ ]?all|전체\s*선택|모두\s*선택/.test(hint)) return [];
      var scope = master.closest('form,table,fieldset,ul,ol,[role=group],[data-ui-audit-control-group]');
      if (!scope) return [];
      return qsa('input[type=checkbox]', scope).filter(function (box) { return box !== master; });
    }
  }

  function ruleModalActionsOutOfView(ctx) {
    var dialog = topmostModal();
    if (!dialog) return;
    var hidden = qsa('button,input[type=submit],input[type=button],[role=button]', dialog).filter(function (action) {
      if (!isVisible(action) || isExempt(action)) return false;
      var scroller = scrollingAncestor(action, dialog);
      if (!scroller) return false;
      if (pinnedInside(action, scroller)) return false;
      var box = scroller.getBoundingClientRect();
      var rect = action.getBoundingClientRect();
      return rect.top >= box.bottom - 1 || rect.bottom <= box.top + 1;
    });
    if (!hidden.length) return;
    ctx.findings.push(mk('modalActionsOutOfView', 'Fail', 'auto-measured', cssPath(hidden[hidden.length - 1]),
      'Dialog action buttons sit inside the scrolling content and are not on screen when the dialog opens. A modal blocks the rest of the page, so an action the user cannot see is a decision they cannot make.',
      { hiddenActions: hidden.map(function (el) { return labelText(el) || cssPath(el); }).slice(0, 5), count: hidden.length },
      {}, rectOf(hidden[hidden.length - 1]),
      'Move the action row into a footer that stays pinned outside the scrolling area (or make it position:sticky at the bottom of the dialog), and let only the content scroll.'));

    function pinnedInside(action, scroller) {
      for (var n = action; n && n !== scroller; n = n.parentElement) {
        var position = getComputedStyle(n).position;
        if (position === 'sticky' || position === 'fixed') return true;
      }
      return false;
    }
  }

  function ruleEmptyDataCell(ctx) {
    dataTables().forEach(function (table) {
      var empties = bodyRows(table).reduce(function (acc, row) {
        return acc.concat(qsa('td', row).filter(function (cell) {
          if ((parseInt(cell.getAttribute('colspan'), 10) || 1) > 1) return false;
          if (cell.closest('[data-ui-audit-empty-ok]')) return false;
          if ((cell.innerText || cell.textContent || '').trim()) return false;
          return !cell.querySelector('img,svg,input,button,select,textarea,a,[role=button]');
        }));
      }, []);
      if (!empties.length) return;
      ctx.findings.push(mk('emptyDataCell', 'Polish', 'auto-measured', cssPath(table),
        'Data table leaves cells completely blank. A blank cell cannot say whether the value is missing, zero, not applicable, or still loading, and the reader has to guess which.',
        { emptyCells: empties.length, samples: empties.slice(0, 5).map(cssPath) }, {}, rectOf(table),
        'Render an explicit placeholder such as a dash for "no value", and keep zero and "not applicable" visually distinct from it.'));
    });
  }

  function ruleNumericColumnAlignment(ctx) {
    // Grouping and decimal marks are locale-specific: 1,240,000.50 (en/ko), 1.240.000,50
    // (de/es/it/pt), 1 240 000,50 (fr/ru/sv/pl). All three are quantitative and all three
    // belong on the end edge, so the parser recognizes each rather than only the en/ko one.
    var NUMBER_FORMS = [
      /^\d+$/,
      /^\d+[.,]\d+$/,
      /^\d{1,3}(,\d{3})+(\.\d+)?$/,
      /^\d{1,3}(\.\d{3})+(,\d+)?$/,
      /^\d{1,3}( \d{3})+([.,]\d+)?$/
    ];
    // \p{Sc} covers every single-character currency sign (won, dollar, euro, yen, pound,
    // rupee, ruble, lira, shekel, ...); CURRENCY_CODE covers the ones written as letters.
    // Units are listed symmetrically so an English column is recognized on the same terms
    // as a Korean one.
    var CURRENCY_CODE = '(?:USD|EUR|KRW|JPY|CNY|GBP|CHF|SEK|NOK|DKK|PLN|CZK|BRL|INR|RUB|TRY|AUD|CAD|NZD|HKD|SGD|TWD|THB|VND|IDR|MYR|PHP|MXN|ZAR|kr|z\u0142|K\u010d)';
    var UNIT = /\s?(?:%|\uFF05|\u00B0|\u2103|\u2109|\uAC1C|\uAC74|\uBA85|\uC6D0|\uC810|\uC704|\uD68C|\uBC30|\uB144|\uC6D4|\uC77C|\uC2DC\uAC04|\uBD84|\uCD08|kg|g|km|m|cm|mm|t|ha|L|ml|KB|MB|GB|TB|px|pt|pcs|ea|hrs?|min|sec|days?|items?)$/;

    dataTables().forEach(function (table) {
      var rows = bodyRows(table).filter(function (row) {
        return !qsa('td,th', row).some(function (cell) { return (parseInt(cell.getAttribute('colspan'), 10) || 1) > 1; });
      });
      if (rows.length < 3) return;
      var columns = rows[0].cells.length;
      for (var index = 0; index < columns; index++) {
        inspectColumn(table, rows, index);
      }
    });

    function inspectColumn(table, rows, index) {
      var cells = rows.map(function (row) { return row.cells[index]; })
        .filter(function (cell) { return cell && cell.tagName === 'TD' && isVisible(cell) && !isExempt(cell); });
      if (cells.length < 3) return;
      var values = cells.map(function (cell) { return (cell.innerText || cell.textContent || '').trim(); })
        .filter(Boolean);
      if (values.length < 3) return;
      if (values.some(isDateLike)) return;
      var numeric = values.filter(isNumericLike).length;
      if (numeric / values.length < 0.8) return;
      var cs = getComputedStyle(cells[0]);
      var align = cs.textAlign;
      var rtl = cs.direction === 'rtl';
      if (align === 'right' || align === 'end' || align === 'center') return;
      if (align === 'start' && rtl) return;
      if (rtl && align === 'left') return;
      var header = headerFor(table, index);
      // Anchor on the header cell so two offending columns in one table stay distinct
      // signals; dedupe keys on rule + selector + message.
      ctx.findings.push(mk('numericColumnAlignment', 'Polish', 'auto-measured', cssPath(header.el || cells[0]),
        'Numeric column is start-aligned, so the digit places do not line up and the reader cannot compare magnitudes by shape.',
        { column: index + 1, header: header.text, textAlign: align, numericCells: numeric, sampledCells: values.length },
        { textAlign: 'right' }, rectOf(cells[0]),
        'Align quantitative columns (and their headers) to the end edge — right in a left-to-right table — and keep nominal text columns start-aligned.'));
    }

    function headerFor(table, index) {
      var headerRow = qsa('thead tr', table)[0] || qsa('tr', table).filter(function (row) { return row.querySelector('th'); })[0];
      var cell = headerRow && headerRow.cells[index];
      return { el: cell || null, text: cell ? labelText(cell) : null };
    }

    function isNumericLike(value) {
      var cleaned = value
        .replace(/[\u00A0\u202F\u2009\u0027]/g, ' ')   // NBSP, narrow/thin space, Swiss apostrophe
        .trim()
        .replace(/^[(+\-\u2212]/, '')
        .replace(/\)$/, '')
        .replace(new RegExp('^' + CURRENCY_CODE + '\\s?'), '')
        .replace(new RegExp('\\s?' + CURRENCY_CODE + '$'), '')
        .replace(/^\p{Sc}\s?/u, '')
        .replace(/\s?\p{Sc}$/u, '')
        .replace(UNIT, '')
        .trim();
      if (!cleaned) return false;
      return NUMBER_FORMS.some(function (form) { return form.test(cleaned); });
    }

    function isDateLike(value) {
      return /\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(value) || /\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(value) ||
        /\d{1,2}:\d{2}/.test(value) || /\d{4}\s?[\u5E74\uB144]/.test(value);
    }
  }

  function ruleUnlinkedContactInfo(ctx) {
    // Unicode-aware so internationalized addresses (non-ASCII local parts and IDN domains)
    // are recognized, not only ASCII ones.
    var EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
    // Phone shapes differ by country, so the pattern is a union of the real ones rather than
    // the Korean form alone: +country (any grouping), the NANP 3-3-4, and a national trunk-0
    // number with either grouped or single-block subscriber digits (KR/JP/UK/DE/FR/CN).
    // Digit boundaries on both ends stop it starting inside a longer run — an account number
    // like 1002-123-456789 otherwise yields a phone-shaped substring — and the trailing colon
    // guard stops an opening-hours "09:00" being absorbed as another group.
    var PHONE = /(?<![\d-])(?:\+\d{1,3}(?:[-.\s]?\(?\d{1,4}\)?){1,5}|\(\d{2,4}\)[-.\s]?\d{3,4}[-.\s]?\d{3,4}|\d{3}[-.]\d{3}[-.]\d{4}|\(?0\d{1,3}\)?[-.\s]\d{2,4}(?:[-.\s]\d{2,4}){1,3}|\(?0\d{1,3}\)?[-.\s]\d{5,9})(?![\d\-:])/g;
    // E.164 allows at most 15 digits and no real number has fewer than 7. The length filter
    // is what keeps the looser shapes above from reporting version strings or short ranges.
    var PHONE_MIN_DIGITS = 7, PHONE_MAX_DIGITS = 15;
    var reported = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || !isVisible(parent) || isExempt(parent)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('a[href],pre,code,kbd,samp,script,style,textarea,option')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var text = node.textContent || '';
      var emails = text.match(EMAIL) || [];
      var phones = (text.match(PHONE) || []).filter(function (candidate) {
        var count = (candidate.match(/\d/g) || []).length;
        return count >= PHONE_MIN_DIGITS && count <= PHONE_MAX_DIGITS;
      }).map(function (candidate) { return candidate.trim(); });
      if (!emails.length && !phones.length) continue;
      var host = node.parentElement;
      if (reported.indexOf(host) >= 0) continue;
      reported.push(host);
      ctx.findings.push(mk('unlinkedContactInfo', 'Polish', 'auto-measured', cssPath(host),
        'Contact details are rendered as plain text. On a phone the number cannot be dialled and the address cannot be mailed without the user copying it out by hand.',
        { emails: emails.slice(0, 3), phones: phones.slice(0, 3) }, {}, rectOf(host),
        'Wrap email addresses in <a href="mailto:…"> and phone numbers in <a href="tel:…"> using the full international form in the href.'));
    }
  }

  function rulePopupExceedsViewport(ctx) {
    qsa('[role=menu],[role=listbox],[popover],.dropdown-menu,[data-ui-audit-popup]').forEach(function (panel) {
      if (!isVisible(panel) || isExempt(panel)) return;
      var rect = panel.getBoundingClientRect();
      if (rect.height < 40 || rect.width < 20) return;
      var overshoot = Math.round(Math.max(rect.bottom - root.innerHeight, -rect.top));
      if (overshoot <= 1) return;
      if (scrollingAncestor(panel, document.body) || scrollsItself(panel)) return;
      // An absolutely positioned panel that moves with the document is still reachable
      // as long as the page has room left to scroll; a pinned one never is.
      var pinned = isPinned(panel);
      var pageSlack = document.documentElement.scrollHeight - root.innerHeight - root.scrollY;
      if (!pinned && pageSlack >= overshoot) return;
      ctx.findings.push(mk('popupExceedsViewport', 'Risk', 'auto-measured', cssPath(panel),
        'Dropdown panel extends past the viewport with no scrolling of its own, so the options past the edge cannot be reached.',
        { panelHeight: Math.round(rect.height), viewportHeight: root.innerHeight, overshootPx: overshoot, pinned: pinned },
        { overshootPx: 0 }, rectOf(panel),
        'Cap the panel with a max-height tied to the viewport and give it overflow-y:auto so the remaining options stay reachable.'));
    });

    function scrollsItself(el) {
      var cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4;
    }
    function isPinned(el) {
      for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') return true;
      }
      return false;
    }
  }

  function ruleNavCurrentUnmarked(ctx) {
    qsa('nav,[role=navigation]').forEach(function (nav) {
      if (!isVisible(nav) || isExempt(nav)) return;
      if (nav.closest('footer,[role=contentinfo]')) return;
      var links = qsa('a[href]', nav).filter(function (link) {
        return isVisible(link) && !isExempt(link) && (link.textContent || '').trim();
      });
      if (links.length < 3) return;
      var marked = links.some(function (link) {
        return link.hasAttribute('aria-current') || link.getAttribute('aria-selected') === 'true' ||
          /(^|\s)(active|is-active|current|is-current|selected)(\s|$)/.test(link.className || '') ||
          /(^|\s)(active|is-active|current|is-current|selected)(\s|$)/.test((link.parentElement && link.parentElement.className) || '');
      });
      if (marked) return;
      var here = links.filter(function (link) { return link.pathname === location.pathname; });
      if (here.length !== 1) return;
      ctx.findings.push(mk('navCurrentUnmarked', 'Risk', 'auto-measured', cssPath(here[0]),
        'Navigation contains the screen the user is already on, but nothing marks it as current. The menu answers "where can I go" without answering "where am I".',
        { href: here[0].getAttribute('href'), label: labelText(here[0]), navLinks: links.length }, {}, rectOf(here[0]),
        'Set aria-current="page" on the link for the current screen and give it a visible state that does not rely on color alone.'));
    });
  }

  function ruleDisabledTab(ctx) {
    // isExempt() drops disabled controls by design, so the disabled state is read
    // directly here — it is the finding, not a reason to skip.
    qsa('[role=tab]').forEach(function (tab) {
      if (!isVisible(tab)) return;
      if (tab.closest('[aria-hidden=true],[inert],[hidden]')) return;
      if (!tab.matches('[disabled],[aria-disabled=true]')) return;
      ctx.findings.push(mk('disabledTab', 'Risk', 'auto-measured', cssPath(tab),
        'Tab is rendered in a disabled state. A tab that cannot be selected still costs a scan and teaches nothing about why it is unavailable or what would unlock it.',
        { label: labelText(tab), disabled: tab.hasAttribute('disabled') ? 'attribute' : 'aria-disabled' }, {}, rectOf(tab),
        'Remove the tab when it does not apply, or keep it selectable and explain the unavailable state inside its panel.'));
    });
  }

  function ruleNestedTabs(ctx) {
    qsa('[role=tabpanel] [role=tablist]').forEach(function (inner) {
      if (!isVisible(inner) || isExempt(inner)) return;
      var outer = inner.closest('[role=tabpanel]');
      ctx.findings.push(mk('nestedTabs', 'Polish', 'auto-measured', cssPath(inner),
        'Tab strip is nested inside another tab panel. Two levels of the same widget make it ambiguous which layer a click changes and where the user currently stands.',
        { outerPanel: cssPath(outer), innerTabs: qsa('[role=tab]', inner).length }, {}, rectOf(inner),
        'Flatten to one level: promote the inner sections to the outer strip, or use a different grouping (side navigation, accordion) for the second level.'));
    });
  }

  function ruleFlagAsLanguageIndicator(ctx) {
    // The defect is universal, so the vocabulary that finds the control must be too: a
    // switcher labelled "Sprache" or "语言" hides the same flag problem as one labelled
    // "언어", and an en+ko list would only ever report Korean and English products.
    var LANG = new RegExp([
      '(^|[^a-z])lang(uage)?([^a-z]|$)', 'locale', 'i18n',
      'langue', 'sprache', 'idioma', 'lingua', 'taal', 'spr[åa]k', 'kieli', 'nyelv',
      'j[eę]zyk', 'jazyk', 'bahasa', 'ngôn',
      'язык', 'мова',
      '言語', '语言', '語言',
      '언어', '다국어',
      'ภาษา', 'لغة'
    ].join('|'), 'i');
    var FLAG_EMOJI = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
    qsa('select,button,[role=button],[role=combobox],[role=menu],[role=listbox],a').forEach(function (el) {
      if (!isVisible(el) || isExempt(el)) return;
      var hint = [labelText(el), el.getAttribute('aria-label'), el.getAttribute('name'), el.id,
        (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className)]
        .filter(Boolean).join(' ');
      if (!LANG.test(hint)) return;
      var flagImage = qsa('img,svg,use', el).filter(function (node) {
        var mark = [node.getAttribute('src'), node.getAttribute('alt'), node.getAttribute('href'),
          (node.className && node.className.baseVal !== undefined ? node.className.baseVal : node.className)]
          .filter(Boolean).join(' ');
        return /flag|국기/i.test(mark);
      })[0];
      var emoji = FLAG_EMOJI.test(el.textContent || '');
      if (!flagImage && !emoji) return;
      ctx.findings.push(mk('flagAsLanguageIndicator', 'Polish', 'auto-measured', cssPath(el),
        'Language switcher identifies its options with flags. A flag names a country, not a language — one language spans many countries and one country speaks many languages, so some readers see no flag that belongs to them.',
        { cue: flagImage ? 'flag image' : 'flag emoji', control: el.tagName.toLowerCase() }, {}, rectOf(el),
        'Label each option with the language endonym (한국어, English, Español). Keep flags only for an explicit country or region choice.'));
    });
  }

  function ruleAccordionPanelScroll(ctx) {
    qsa('[aria-expanded=true][aria-controls]').forEach(function (header) {
      if (!isVisible(header) || isExempt(header)) return;
      var panel = document.getElementById((header.getAttribute('aria-controls') || '').trim());
      if (!panel || !isVisible(panel) || isExempt(panel)) return;
      if (panel.matches('[role=dialog],[role=menu],[role=listbox],[aria-modal=true]')) return;
      var cs = getComputedStyle(panel);
      if (!/(auto|scroll)/.test(cs.overflowY)) return;
      if (panel.scrollHeight <= panel.clientHeight + 4) return;
      ctx.findings.push(mk('accordionPanelScroll', 'Polish', 'auto-measured', cssPath(panel),
        'Expanded disclosure panel scrolls inside itself. The page now has two scrollbars competing for the same gesture, and content inside the panel never reaches the page scroll position it was expanded to show.',
        { panelHeight: Math.round(panel.clientHeight), contentHeight: Math.round(panel.scrollHeight) }, {}, rectOf(panel),
        'Let the panel grow to its content and leave scrolling to the page. Move genuinely unbounded content to its own screen instead of nesting a scroller.'));
    });
  }

  // ------------------------------ helpers ------------------------------
  function qsa(sel, root2) { return Array.prototype.slice.call((root2 || document).querySelectorAll(sel)); }
  function labelText(el) { return ((el && (el.innerText || el.textContent)) || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
  function formKey(el) {
    if (!el.form) return 'doc';
    var forms = Array.prototype.indexOf.call(document.forms, el.form);
    return 'form:' + forms;
  }
  function referencedVisibleText(el, attr) {
    var ids = (el.getAttribute(attr) || '').trim().split(/\s+/).filter(Boolean);
    return ids.some(function (id) {
      var target = document.getElementById(id);
      // A visually-hidden target is not a label the user can read while typing, and
      // not an error message they can see next to the field.
      return !!target && isVisible(target) && !isExempt(target) &&
        !!(target.innerText || target.textContent || '').trim();
    });
  }
  function visibleLabelText(el) {
    var wrapping = el.closest('label');
    if (wrapping && isVisible(wrapping) && !isExempt(wrapping) && (wrapping.innerText || '').trim()) return true;
    if (el.id) {
      var associated = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (associated && isVisible(associated) && !isExempt(associated) && (associated.innerText || '').trim()) return true;
    }
    return referencedVisibleText(el, 'aria-labelledby');
  }
  function accessibleNameAttr(el) {
    if ((el.getAttribute('aria-label') || '').trim()) return true;
    return referencedVisibleText(el, 'aria-labelledby');
  }
  function topmostModal() {
    var open = qsa('[aria-modal=true],dialog[open]').filter(function (d) {
      if (!isVisible(d) || isExempt(d)) return false;
      if (d.tagName === 'DIALOG') return d.hasAttribute('open');
      var role = d.getAttribute('role');
      return role === 'dialog' || role === 'alertdialog';
    });
    return open[open.length - 1] || null;
  }
  // Nearest ancestor of `el` (exclusive) up to and including `bound` that actually
  // scrolls vertically. Used to tell "below the fold of its own scroller" apart from
  // "just a tall element on a scrolling page".
  function scrollingAncestor(el, bound) {
    for (var n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      if (n === bound) break;
    }
    return null;
  }
  function dataTables() {
    return qsa('table').filter(function (table) {
      if (!isVisible(table) || isExempt(table)) return false;
      if (!table.querySelector('th')) return false;   // a layout table has no header cells
      return bodyRows(table).length >= 2;
    });
  }
  function bodyRows(table) {
    var body = qsa('tbody tr', table);
    if (body.length) return body.filter(function (row) { return !row.querySelector('th'); });
    return qsa('tr', table).filter(function (row) { return !row.querySelector('th'); });
  }
  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var c = el.childNodes[i];
      if (c.nodeType === 3 && c.textContent.trim()) return true;
    }
    return false;
  }
  function boundaryContrastCues(cs, adjacent) {
    var cues = [];
    var fill = colorAgainst(cs.backgroundColor, adjacent);
    if (fill) cues.push({ kind: 'background', ratio: contrast(fill, adjacent), color: rgbStr(fill) });
    ['Top', 'Right', 'Bottom', 'Left'].forEach(function (side) {
      var width = parseFloat(cs['border' + side + 'Width']) || 0;
      var style = cs['border' + side + 'Style'];
      if (width < 1 || style === 'none' || style === 'hidden') return;
      var paint = colorAgainst(cs['border' + side + 'Color'], adjacent);
      if (paint) cues.push({ kind: 'border' + side, ratio: contrast(paint, adjacent), color: rgbStr(paint), width: width });
    });
    var outlineWidth = parseFloat(cs.outlineWidth) || 0;
    if (outlineWidth >= 1 && cs.outlineStyle !== 'none' && cs.outlineStyle !== 'hidden' && cs.outlineStyle !== 'auto') {
      var outline = colorAgainst(cs.outlineColor, adjacent);
      if (outline) cues.push({ kind: 'outline', ratio: contrast(outline, adjacent), color: rgbStr(outline), width: outlineWidth });
    }
    return cues;
  }
  function iconContrastPaints(control, surface) {
    var paints = {};
    var symbol = (control.innerText || '').trim();
    if (symbol && !/[\p{L}\p{N}]/u.test(symbol)) add(getComputedStyle(control).color, 1, 'symbol');
    qsa('svg,svg *', control).forEach(function (node) {
      if (!isVisible(node)) return;
      var cs = getComputedStyle(node);
      add(cs.fill, parseFloat(cs.fillOpacity) || 1, 'fill');
      if ((parseFloat(cs.strokeWidth) || 0) > 0) add(cs.stroke, parseFloat(cs.strokeOpacity) || 1, 'stroke');
    });
    return Object.keys(paints).map(function (key) { return paints[key]; });

    function add(value, opacity, kind) {
      if (!value || value === 'none') return;
      var parsed = parseColor(value);
      if (!parsed) return;
      parsed[3] *= opacity;
      if (parsed[3] <= 0.05) return;
      var rgb = parsed[3] < 1 ? composite(parsed, surface) : parsed.slice(0, 3);
      var key = rgb.map(function (channel) { return Math.round(channel); }).join(',');
      if (!paints[key]) paints[key] = { kind: kind, color: rgbStr(rgb), ratio: contrast(rgb, surface) };
    }
  }
  function contrastEvidence(items, max) {
    return items.slice(0, max).map(function (item) {
      var evidence = {};
      Object.keys(item).forEach(function (key) { evidence[key] = key === 'ratio' ? round2(item[key]) : item[key]; });
      return evidence;
    });
  }
  function surroundingTextElement(container, excluded) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (excluded.contains(node)) return NodeFilter.FILTER_REJECT;
        if (!/[\p{L}\p{N}]/u.test(node.textContent || '')) return NodeFilter.FILTER_REJECT;
        var parent = node.parentElement;
        return parent && isVisible(parent) && !isExempt(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var node = walker.nextNode();
    return node ? node.parentElement : null;
  }
  function hasPersistentLinkCue(link, peer) {
    var cs = getComputedStyle(link);
    var peerStyle = getComputedStyle(peer);
    if (cs.textDecorationLine && cs.textDecorationLine !== 'none') return true;
    if (qsa('svg,img', link).some(isVisible)) return true;
    if (Math.abs((parseInt(cs.fontWeight, 10) || 400) - (parseInt(peerStyle.fontWeight, 10) || 400)) >= 100) return true;
    if (cs.fontStyle !== peerStyle.fontStyle) return true;
    var peerBg = effectiveBg(peer).rgb;
    var linkBg = colorAgainst(cs.backgroundColor, peerBg);
    if (linkBg && contrast(linkBg, peerBg) > 1.1) return true;
    return ['Top', 'Right', 'Bottom', 'Left'].some(function (side) {
      var width = parseFloat(cs['border' + side + 'Width']) || 0;
      return width >= 1 && cs['border' + side + 'Style'] !== 'none' && cs['border' + side + 'Style'] !== 'hidden';
    });
  }
  function renderedForeground(el) {
    var color = parseColor(getComputedStyle(el).color);
    if (!color) return null;
    var bg = effectiveBg(el).rgb;
    return color[3] < 1 ? composite(color, bg) : color.slice(0, 3);
  }
  function rgbDistance(a, b) {
    var dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }
  function colorAgainst(value, background) {
    var parsed = parseColor(value);
    if (!parsed || parsed[3] <= 0.05) return null;
    return parsed[3] < 1 ? composite(parsed, background) : parsed.slice(0, 3);
  }
  function bodyTextCandidates(ctx) {
    if (ctx.bodyTextCandidates) return ctx.bodyTextCandidates;
    var cfg = ctx.cfg.polish || {};
    var minChars = Number(cfg.bodyTextMinChars || 40);
    var minLines = Number(cfg.bodyTextMinLines || 3);
    ctx.bodyTextCandidates = qsa('p,li,dd,dt,blockquote').map(function (el) {
      if (!isVisible(el) || isExempt(el) || el.closest('nav,[role=navigation],[role=menu],[role=toolbar],form,table,pre,code')) return null;
      var text = (el.innerText || el.textContent || '').trim();
      var chars = Array.from(text).filter(function (char) { return /[\p{L}\p{N}]/u.test(char); }).length;
      if (chars < minChars) return null;
      var lines = renderedTextLines(el);
      if (lines < minLines) return null;
      return { el: el, style: getComputedStyle(el), chars: chars, lines: lines };
    }).filter(Boolean);
    return ctx.bodyTextCandidates;
  }
  function renderedTextLines(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var tops = [];
    Array.prototype.forEach.call(range.getClientRects(), function (rect) {
      if (rect.width < 1 || rect.height < 1) return;
      if (!tops.some(function (top) { return Math.abs(top - rect.top) < 2; })) tops.push(rect.top);
    });
    if (range.detach) range.detach();
    return tops.length;
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
  function contrastBg(el, pseudoStyle) {
    var bg = effectiveBg(el);
    var paintReason = complexPaintReason(el, pseudoStyle);
    if (!paintReason) return bg;
    return {
      rgb: bg.rgb,
      indeterminate: true,
      reason: [bg.reason, paintReason].filter(Boolean).join('; ')
    };
  }
  function complexPaintReason(el, pseudoStyle) {
    var pseudoReason = stylePaintReason(pseudoStyle, 'placeholder pseudo-element', false);
    if (pseudoReason) return pseudoReason;
    var n = el;
    while (n && n.nodeType === 1) {
      var reason = stylePaintReason(getComputedStyle(n), n.tagName.toLowerCase(), true);
      if (reason) return reason;
      n = n.parentElement;
    }
    return null;
  }
  function stylePaintReason(cs, label, includeOpacity) {
    if (!cs) return null;
    var opacity = parseFloat(cs.opacity);
    if (includeOpacity && Number.isFinite(opacity) && opacity >= 0.05 && opacity < 1) return 'opacity on ' + label;
    if (cs.filter && cs.filter !== 'none') return 'filter on ' + label;
    if ((cs.backdropFilter && cs.backdropFilter !== 'none') ||
        (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none')) return 'backdrop-filter on ' + label;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return 'mix-blend-mode on ' + label;
    if (cs.boxShadow && /\binset\b/.test(cs.boxShadow)) return 'inset box-shadow on ' + label;
    var maskImage = cs.maskImage || cs.webkitMaskImage;
    if (maskImage && maskImage !== 'none') return 'mask-image on ' + label;
    return null;
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
  function srgb(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
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
  function insideHorizontalScroller(el) {
    for (var parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      var style = getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return true;
    }
    return false;
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

  root.__uiAudit = audit;
  if (typeof module !== 'undefined' && module.exports) module.exports = { audit: audit, installCLS: installCLS };
})(typeof window !== 'undefined' ? window : this);
