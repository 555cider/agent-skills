/*
 * UI Splint keyboard probe helpers.
 *
 * This file deliberately does not synthesize keyboard events. Calling
 * HTMLElement.focus() plus dispatchEvent(new KeyboardEvent(...)) cannot prove
 * real sequential focus behavior. Browser drivers use these helpers to choose
 * boundaries and inspect evidence, then send trusted Tab/Shift+Tab input via
 * Playwright or CDP Input.dispatchKeyEvent.
 */
(function installUiSplintKeyboardProbe(root) {
  'use strict';

  if (root.__uiSplintKeyboardProbe) return;

  var FOCUSABLE = [
    'a[href]', 'area[href]', 'button', 'input', 'select', 'textarea',
    'iframe', 'object', 'embed', 'summary', '[contenteditable]', '[tabindex]'
  ].join(',');

  function deepActive() {
    var active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function composedParent(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    var rootNode = el.getRootNode && el.getRootNode();
    return rootNode && rootNode.host ? rootNode.host : null;
  }

  function composedContains(container, el) {
    for (var cur = el; cur; cur = composedParent(cur)) {
      if (cur === container) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    for (var cur = el; cur; cur = composedParent(cur)) {
      if (cur.nodeType !== 1) continue;
      var style = getComputedStyle(cur);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
      if (cur.hidden || cur.getAttribute('aria-hidden') === 'true' || cur.hasAttribute('inert')) return false;
    }
    var rects = el.getClientRects();
    return !!rects.length && Array.prototype.some.call(rects, function (rect) {
      return rect.width > 0 && rect.height > 0;
    });
  }

  function isTabbable(el) {
    if (!isVisible(el) || el.matches(':disabled,[disabled]')) return false;
    if (el.matches('input[type="hidden"]')) return false;
    if (el.matches('[contenteditable="false"]')) return false;
    return el.tabIndex >= 0;
  }

  function walkRoots(rootNode, out) {
    var nodes = rootNode.querySelectorAll ? rootNode.querySelectorAll(FOCUSABLE) : [];
    Array.prototype.forEach.call(nodes, function (el) {
      out.push(el);
      if (el.shadowRoot) walkRoots(el.shadowRoot, out);
    });
  }

  function tabbables(scope) {
    var all = [];
    walkRoots(scope || document, all);
    all = all.filter(function (el) {
      return isTabbable(el) && (!scope || scope === document || composedContains(scope, el));
    });
    return all.map(function (el, order) {
      return { el: el, order: order, tabIndex: el.tabIndex };
    }).sort(function (a, b) {
      var ap = a.tabIndex > 0;
      var bp = b.tabIndex > 0;
      if (ap !== bp) return ap ? -1 : 1;
      if (ap && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
      return a.order - b.order;
    }).map(function (item) { return item.el; });
  }

  function cssPart(el) {
    var name = (el.localName || 'element').toLowerCase();
    if (el.id) return name + '#' + CSS.escape(el.id);
    var part = name;
    var cls = Array.prototype.slice.call(el.classList || []).filter(Boolean).slice(0, 2);
    if (cls.length) part += '.' + cls.map(CSS.escape).join('.');
    var parent = el.parentElement;
    if (parent) {
      var peers = Array.prototype.filter.call(parent.children, function (peer) {
        return peer.localName === el.localName;
      });
      if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(el) + 1) + ')';
    }
    return part;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '<none>';
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1) {
      parts.unshift(cssPart(cur));
      if (cur.id) break;
      var rootNode = cur.getRootNode && cur.getRootNode();
      if (!cur.parentElement && rootNode && rootNode.host) {
        parts.unshift('>>>');
        cur = rootNode.host;
      } else {
        cur = cur.parentElement;
      }
      if (parts.length > 16) break;
    }
    return parts.join(' > ').replace(/ > >>> > /g, ' >>> ');
  }

  function visibleModals() {
    return Array.prototype.filter.call(
      document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"]'),
      isVisible
    );
  }

  function topModal() {
    var modals = visibleModals();
    if (!modals.length) return null;
    return modals.map(function (modal, order) {
      var rect = modal.getBoundingClientRect();
      var x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
      var y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
      var stack = document.elementsFromPoint(x, y);
      var hit = stack.some(function (el) { return el === modal || modal.contains(el); });
      var z = Number.parseInt(getComputedStyle(modal).zIndex, 10);
      return { modal: modal, hit: hit, z: Number.isFinite(z) ? z : 0, order: order };
    }).sort(function (a, b) {
      if (a.hit !== b.hit) return a.hit ? 1 : -1;
      if (a.z !== b.z) return a.z - b.z;
      return a.order - b.order;
    }).pop().modal;
  }

  function sampleExposure(el) {
    var rect = el.getBoundingClientRect();
    var left = Math.max(0, rect.left);
    var top = Math.max(0, rect.top);
    var right = Math.min(innerWidth, rect.right);
    var bottom = Math.min(innerHeight, rect.bottom);
    var visibleWidth = Math.max(0, right - left);
    var visibleHeight = Math.max(0, bottom - top);
    var base = {
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      viewportIntersection: { x: left, y: top, w: visibleWidth, h: visibleHeight },
      fullyObscured: false,
      coveringSelector: null
    };
    if (!visibleWidth || !visibleHeight) {
      base.fullyObscured = true;
      base.reason = 'outside-viewport';
      return base;
    }
    var xs = [left + 1, left + visibleWidth / 2, right - 1];
    var ys = [top + 1, top + visibleHeight / 2, bottom - 1];
    var exposed = false;
    var covering = null;
    xs.forEach(function (x) {
      ys.forEach(function (y) {
        if (exposed || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
        var stack = document.elementsFromPoint(x, y);
        var painted = stack[0];
        if (painted && (painted === el || composedContains(el, painted))) {
          exposed = true;
        } else if (!covering && painted) {
          covering = painted;
        }
      });
    });
    if (!exposed) {
      base.fullyObscured = true;
      base.reason = 'author-overlay';
      base.coveringSelector = cssPath(covering);
    }
    return base;
  }

  function matchesWhitelist(el, whitelist) {
    if (!el || !Array.isArray(whitelist)) return false;
    return whitelist.some(function (selector) {
      if (typeof selector !== 'string' || !selector) return false;
      try {
        for (var cur = el; cur; cur = composedParent(cur)) {
          if (cur.matches && cur.matches(selector)) return true;
        }
      } catch (_) { return false; }
      return false;
    });
  }

  function inspectActive(whitelist) {
    var active = deepActive();
    var modal = topModal();
    if (!active || active === document.body || active === document.documentElement) {
      return {
        selector: active ? cssPath(active) : '<none>',
        tag: active && active.localName || null,
        inModal: false,
        fullyObscured: false,
        documentFocus: false
      };
    }
    var exposure = sampleExposure(active);
    return Object.assign({
      selector: cssPath(active),
      tag: active.localName || null,
      inModal: !!modal && composedContains(modal, active),
      modalSelector: modal ? cssPath(modal) : null,
      documentFocus: true,
      whitelisted: matchesWhitelist(active, whitelist)
    }, exposure);
  }

  function modalPlan(whitelist) {
    var modal = topModal();
    if (!modal) return { present: false };
    var stops = tabbables(modal);
    var active = deepActive();
    return {
      present: true,
      selector: cssPath(modal),
      activeInside: !!active && composedContains(modal, active),
      activeSelector: cssPath(active),
      whitelisted: matchesWhitelist(modal, whitelist),
      visibleModalCount: visibleModals().length,
      tabbableCount: stops.length,
      firstSelector: stops.length ? cssPath(stops[0]) : cssPath(modal),
      lastSelector: stops.length ? cssPath(stops[stops.length - 1]) : cssPath(modal)
    };
  }

  function focusModalBoundary(which) {
    var modal = topModal();
    if (!modal) return { ok: false, error: 'no visible aria-modal dialog' };
    var stops = tabbables(modal);
    var target = stops.length ? (which === 'last' ? stops[stops.length - 1] : stops[0]) : modal;
    if (!stops.length && !modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: false });
    var active = deepActive();
    return { ok: active === target, target: cssPath(target), active: cssPath(active) };
  }

  function traversalPlan() {
    var modal = topModal();
    var scope = modal || document;
    var stops = tabbables(scope);
    return {
      scope: modal ? 'modal' : 'document',
      modalSelector: modal ? cssPath(modal) : null,
      expected: stops.length,
      firstSelector: stops.length ? cssPath(stops[0]) : null
    };
  }

  function focusTraversalStart() {
    var modal = topModal();
    var stops = tabbables(modal || document);
    if (!stops.length) return { ok: true, empty: true, active: cssPath(deepActive()) };
    stops[0].focus({ preventScroll: false });
    return { ok: deepActive() === stops[0], empty: false, active: cssPath(deepActive()) };
  }

  root.__uiSplintKeyboardProbe = {
    version: 1,
    modalPlan: modalPlan,
    focusModalBoundary: focusModalBoundary,
    traversalPlan: traversalPlan,
    focusTraversalStart: focusTraversalStart,
    inspectActive: inspectActive
  };
})(window);
