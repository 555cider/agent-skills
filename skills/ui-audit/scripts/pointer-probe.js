/*
 * Shared pointer-hover inspection helpers for ui-audit.
 *
 * This file only plans targets and compares rendered styles. The runners must
 * supply trusted pointer movement through Playwright or CDP; dispatching a
 * synthetic mouseover event is not evidence that CSS :hover actually rendered.
 */
(function (root) {
  'use strict';

  var TARGETS = 'button,a[href],[role=button],[role=link],[role=menuitem],[role=tab],input,[onclick],summary';
  var GROUPS = 'form,[role=search],[role=toolbar],nav,[role=tablist],[role=menu]';
  var VISUAL_PROPS = [
    'color', 'backgroundColor', 'backgroundImage',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxShadow', 'outlineColor', 'outlineStyle', 'outlineWidth',
    'textDecorationColor', 'textDecorationLine', 'textDecorationStyle',
    'opacity', 'filter', 'transform', 'fontWeight'
  ];

  function qsa(selector, rootNode) {
    try { return Array.prototype.slice.call((rootNode || document).querySelectorAll(selector)); }
    catch (error) { return []; }
  }

  function visible(el) {
    if (!el || el.nodeType !== 1) return false;
    var style = getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' && parseFloat(style.opacity) >= 0.05 &&
      rect.width > 0 && rect.height > 0;
  }

  function candidate(el) {
    if (!visible(el) || el.closest('[hidden],[inert],[aria-hidden=true]')) return false;
    if (el.matches('[disabled],[aria-disabled=true]')) return false;
    if (getComputedStyle(el).pointerEvents === 'none') return false;
    if (el.tagName === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].indexOf(type) < 0) return false;
    }
    var ancestor = el.parentElement && el.parentElement.closest(TARGETS);
    return !ancestor;
  }

  function whitelisted(el, selectors) {
    return (selectors || []).some(function (selector) {
      try { return !!el.closest(selector); } catch (error) { return false; }
    });
  }

  function cssEscape(value) {
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return String(el);
    if (el.id) return '#' + cssEscape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      var classes = typeof node.className === 'string'
        ? node.className.trim().split(/\s+/).slice(0, 2).filter(Boolean) : [];
      if (classes.length) part += '.' + classes.map(cssEscape).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName;
        });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function rect(el) {
    var value = el.getBoundingClientRect();
    return { x: Math.round(value.left), y: Math.round(value.top),
      w: Math.round(value.width), h: Math.round(value.height) };
  }

  function edgeGap(a, b) {
    var dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    var dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    if (dx && dy) return Math.sqrt(dx * dx + dy * dy);
    return dx + dy;
  }

  function denseInfo(el, all, denseGapPx) {
    var group = el.closest(GROUPS);
    var sameGroup = group && all.some(function (other) {
      return other !== el && other.closest(GROUPS) === group;
    });
    var ownRect = el.getBoundingClientRect();
    var nearest = Infinity;
    all.forEach(function (other) {
      if (other === el) return;
      nearest = Math.min(nearest, edgeGap(ownRect, other.getBoundingClientRect()));
    });
    return {
      dense: !!sameGroup || nearest <= denseGapPx,
      sameSemanticGroup: !!sameGroup,
      nearestInteractiveGapPx: isFinite(nearest) ? Math.round(nearest * 100) / 100 : null,
      groupSelector: sameGroup ? cssPath(group) : null
    };
  }

  function styleValue(style) {
    var out = {};
    VISUAL_PROPS.forEach(function (property) { out[property] = style[property]; });
    out.content = style.content;
    return out;
  }

  function fingerprint(el) {
    var nodes = [{ key: 'self', node: el }];
    qsa('*', el).filter(visible).slice(0, 20).forEach(function (node, index) {
      nodes.push({ key: 'descendant:' + index + ':' + cssPath(node), node: node });
    });
    var parent = el.parentElement;
    for (var depth = 1; parent && depth <= 2; depth++, parent = parent.parentElement) {
      nodes.push({ key: 'ancestor:' + depth + ':' + cssPath(parent), node: parent });
    }
    var values = {};
    nodes.forEach(function (entry) {
      values[entry.key] = {
        normal: styleValue(getComputedStyle(entry.node)),
        before: styleValue(getComputedStyle(entry.node, '::before')),
        after: styleValue(getComputedStyle(entry.node, '::after'))
      };
    });
    return values;
  }

  function visibleTooltipSelectors(el) {
    var described = (el.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
    var tooltips = qsa('[role=tooltip]').concat(described.map(function (id) {
      return document.getElementById(id);
    }).filter(Boolean));
    var seen = {};
    return tooltips.filter(visible).map(cssPath).filter(function (selector) {
      if (seen[selector]) return false;
      seen[selector] = true;
      return true;
    }).sort();
  }

  function plan(whitelist, maxTargets, denseGapPx) {
    // Headless Chrome exposes `(hover: none)` even when the runner is driving a
    // desktop mouse. A zero-touch document is still a fine-pointer audit cell;
    // runners separately mark configured mobile/touch viewports not-applicable.
    var hoverCapable = !!((root.matchMedia && root.matchMedia('(hover: hover) and (pointer: fine)').matches) ||
      !(root.navigator && root.navigator.maxTouchPoints > 0));
    var all = qsa(TARGETS).filter(candidate).filter(function (el) {
      return !whitelisted(el, whitelist);
    });
    var selected = all.slice(0, maxTargets);
    return {
      hoverCapable: hoverCapable,
      expected: all.length,
      truncated: all.length > maxTargets,
      targets: selected.map(function (el) {
        var info = denseInfo(el, all, denseGapPx);
        return {
          selector: cssPath(el), rect: rect(el), dense: info.dense,
          sameSemanticGroup: info.sameSemanticGroup,
          nearestInteractiveGapPx: info.nearestInteractiveGapPx,
          groupSelector: info.groupSelector
        };
      })
    };
  }

  function neutralPoint() {
    var points = [
      { x: 1, y: 1 }, { x: Math.max(1, root.innerWidth - 2), y: 1 },
      { x: 1, y: Math.max(1, root.innerHeight - 2) },
      { x: Math.max(1, root.innerWidth - 2), y: Math.max(1, root.innerHeight - 2) }
    ];
    for (var i = 0; i < points.length; i++) {
      var hit = document.elementFromPoint(points[i].x, points[i].y);
      if (!hit || !hit.closest(TARGETS)) return points[i];
    }
    return { x: 0, y: 0 };
  }

  function prepare(selector) {
    var el = document.querySelector(selector);
    if (!el || !candidate(el)) return { ok: false, reason: 'target is no longer actionable' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var bounds = el.getBoundingClientRect();
    return {
      ok: true,
      point: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 },
      before: fingerprint(el),
      tooltipsBefore: visibleTooltipSelectors(el),
      rect: rect(el)
    };
  }

  function inspect(selector, before, tooltipsBefore) {
    var el = document.querySelector(selector);
    if (!el) return { ok: false, reason: 'target disappeared while hovered' };
    var after = fingerprint(el);
    var changed = [];
    var keys = {};
    Object.keys(before || {}).concat(Object.keys(after)).forEach(function (key) { keys[key] = true; });
    Object.keys(keys).forEach(function (key) {
      if (JSON.stringify((before || {})[key]) !== JSON.stringify(after[key])) changed.push(key);
    });
    var previous = {};
    (tooltipsBefore || []).forEach(function (selectorValue) { previous[selectorValue] = true; });
    var tooltipAfter = visibleTooltipSelectors(el);
    var newTooltips = tooltipAfter.filter(function (selectorValue) { return !previous[selectorValue]; });
    return {
      ok: true,
      hovered: el.matches(':hover'),
      changed: changed.length > 0 || newTooltips.length > 0,
      changedNodes: changed.slice(0, 12),
      newTooltips: newTooltips,
      rect: rect(el)
    };
  }

  root.__uiAuditPointerProbe = {
    plan: plan,
    neutralPoint: neutralPoint,
    prepare: prepare,
    inspect: inspect
  };
})(typeof window !== 'undefined' ? window : this);
