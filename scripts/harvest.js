/**
 * Injected into every document of the crawl target. Describes the current screen
 * and resolves an action key back to a click point.
 *
 * This file is page-side evidence gathering only: it never decides whether an
 * action may run. Classification happens in Node (scripts/model.mjs) so it can be
 * tested without a browser and cannot be influenced by page script.
 */
(() => {
  if (window.__screenMap) return;

  const MAX_TEXT = 80;
  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

  /**
   * Recording watches a session somebody else is driving; crawling drives one itself.
   * The difference decides what this script is allowed to change about the page — a
   * recorder that alters behavior is recording its own behavior, not the app's.
   */
  const RECORDING = !!window.__screenMapRecord;

  // A crawler must not spawn windows it cannot see or drive. A recorder has no such
  // right: the popup belongs to the run being watched.
  if (!RECORDING) {
    try { window.open = () => null; } catch { /* frozen window.open — links are neutralized on resolve */ }
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest && (el.closest('[inert]') || el.closest('[aria-hidden="true"]'))) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return clean(label);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => { const node = document.getElementById(id); return node ? node.textContent : ''; })
        .join(' ');
      if (text.trim()) return clean(text);
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && el.value && ['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (tag === 'img' && el.alt) return clean(el.alt);

    const text = el.innerText || el.textContent || '';
    if (text.trim()) return clean(text);

    const title = el.getAttribute('title');
    if (title && title.trim()) return clean(title);

    const inner = el.querySelector('img[alt], svg title, [aria-label]');
    if (inner) {
      const innerText = inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.textContent || '';
      if (innerText.trim()) return clean(innerText);
    }
    return '';
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (['submit', 'button', 'reset', 'image'].includes(el.type)) return 'button';
      if (el.type === 'checkbox') return 'checkbox';
      if (el.type === 'radio') return 'radio';
      return 'textbox';
    }
    return 'generic';
  }

  /**
   * Identity for an action, as opposed to its display name. Badge counts live
   * inside accessible names ("전체 9999", "휴지통 1"); keep them and the key stops
   * matching the moment the count moves, which breaks replay for the most-used
   * navigation on the screen. Purely numeric tokens are dropped; "상품 A" is
   * untouched. If nothing survives, the original name is the identity.
   */
  function identityName(name) {
    const tokens = String(name || '').split(/\s+/)
      .filter(token => token && !/^[\d.,()[\]{}+\-–—/·:]*\d[\d.,()[\]{}+\-–—/·:]*$/.test(token));
    return tokens.join(' ').trim() || String(name || '');
  }

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(child => child.tagName === node.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const ROLED_POPUP_SELECTOR = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[role="menubar"]';
  // Popper libraries wrap the roled element in a bare positioning div. Match the
  // wrapper only as a last resort, or the overlay is identified as "generic".
  const POPUP_WRAPPER_SELECTOR = '[data-radix-popper-content-wrapper],[data-floating-ui-portal]';

  /**
   * An open overlay traps interaction, so the reachable action set is its subtree
   * alone; harvesting the inert background would invent transitions that cannot
   * happen.
   *
   * Two shapes count. A modal dialog announces itself. A dropdown or popover does
   * not — component libraries instead mark the rest of the document `aria-hidden`,
   * which makes the page read as completely empty unless the popup is found. That
   * empty reading is what produced a phantom blank node per route.
   */
  function overlayRoot() {
    const candidates = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]');
    for (const candidate of candidates) {
      if (!visible(candidate)) continue;
      let isModal = candidate.getAttribute('aria-modal') === 'true';
      if (!isModal) { try { isModal = candidate.matches(':modal'); } catch { isModal = false; } }
      if (isModal) return candidate;
    }

    // Everything below depends on the page having a `<main>` or `role="main"`: a
    // non-modal popup is recognized by the *page* having gone aria-hidden behind it,
    // and that is the only element checked. A legacy layout without one therefore
    // never reports an overlay — the dropdown's items and the background are harvested
    // together, and the map grows transitions that only exist with the menu open.
    // Documented in references/map-schema.md; adding a landmark to the app fixes it.
    const main = document.querySelector('main,[role="main"]');
    if (!main || visible(main)) return null;

    for (const popup of document.querySelectorAll(ROLED_POPUP_SELECTOR)) {
      if (visible(popup)) return popup;
    }
    for (const wrapper of document.querySelectorAll(POPUP_WRAPPER_SELECTOR)) {
      if (!visible(wrapper)) continue;
      const roled = wrapper.querySelector(ROLED_POPUP_SELECTOR);
      return roled && visible(roled) ? roled : wrapper;
    }
    return null;
  }

  const LANDMARK_SELECTOR = 'header,nav,main,aside,footer,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="search"]';
  const ACTION_SELECTOR = [
    'a[href]', 'button', 'summary',
    'input[type="submit"]', 'input[type="button"]', 'input[type="image"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  ].join(',');

  /**
   * A container's name is its label, never its contents. Falling back to text like
   * `accessibleName` does would fold the whole menu — user name, email, profile
   * status — into the screen's identity, so the screen would change whenever any of
   * that changed.
   */
  function containerName(el) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return clean(label);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map(id => { const node = document.getElementById(id); return node ? node.textContent : ''; })
        .join(' ');
      if (text.trim()) return clean(text);
    }

    const heading = el.querySelector('h1,h2,h3,[role="heading"]');
    if (heading && (heading.textContent || '').trim()) return clean(heading.textContent);
    return '';
  }

  function landmarkName(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    return { header: 'banner', nav: 'navigation', main: 'main', aside: 'complementary', footer: 'contentinfo' }[tag] || tag;
  }

  function fingerprint(overlay) {
    const landmarks = [];
    for (const el of document.querySelectorAll(LANDMARK_SELECTOR)) {
      if (!visible(el)) continue;
      const name = landmarkName(el);
      if (!landmarks.includes(name)) landmarks.push(name);
    }

    const headings = [];
    for (const el of document.querySelectorAll('h1,h2')) {
      if (!visible(el)) continue;
      const text = clean(el.textContent);
      if (text && !headings.includes(text)) headings.push(text);
      if (headings.length >= 8) break;
    }

    const forms = [];
    for (const el of document.querySelectorAll('form')) {
      if (!visible(el)) continue;
      let id = el.getAttribute('name') || el.id || '';
      if (!id) {
        const action = el.getAttribute('action') || '';
        try { id = action ? new URL(action, location.href).pathname : 'form'; } catch { id = 'form'; }
      }
      const descriptor = clean(id) + ':' + (el.getAttribute('method') || 'get').toLowerCase();
      if (!forms.includes(descriptor)) forms.push(descriptor);
      if (forms.length >= 8) break;
    }

    // Field *names* are schema, not data: they tell a wizard step apart from its
    // sibling without splitting one screen per record the way headings would.
    const fields = [];
    for (const el of document.querySelectorAll('input,select,textarea')) {
      if (!visible(el)) continue;
      const descriptor = clean(el.getAttribute('name') || el.id || el.getAttribute('type') || el.tagName.toLowerCase());
      if (descriptor && !fields.includes(descriptor)) fields.push(descriptor);
      if (fields.length >= 12) break;
    }

    const tabs = [];
    for (const el of document.querySelectorAll('[role="tab"][aria-selected="true"]')) {
      if (!visible(el)) continue;
      const name = accessibleName(el);
      if (name && !tabs.includes(name)) tabs.push(name);
    }

    return {
      landmarks, headings, forms, fields, tabs,
      overlay: overlay ? { role: roleOf(overlay), name: containerName(overlay) } : null,
    };
  }

  function describe(el) {
    const role = roleOf(el);
    const name = accessibleName(el);
    const form = el.closest ? el.closest('form') : null;
    const formMethod = form ? (el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase() : null;
    const isSubmit = !!form && (
      (el.tagName.toLowerCase() === 'button' && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') ||
      (el.tagName.toLowerCase() === 'input' && ['submit', 'image'].includes(el.type))
    );

    let href = null;
    let hrefRaw = null;
    let external = false;
    if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) {
      const raw = el.getAttribute('href');
      if (!/^(javascript|mailto|tel|sms):/i.test(raw)) {
        try {
          const url = new URL(raw, location.href);
          href = url.href;
          hrefRaw = raw;
          external = url.origin !== location.origin;
        } catch { href = null; }
      }
    }

    return {
      kind: isSubmit ? 'submit' : (href ? 'link' : 'click'),
      role, name, identity: identityName(name), href, hrefRaw, external,
      hrefPath: href ? (() => { try { return new URL(href).pathname; } catch { return null; } })() : null,
      download: el.hasAttribute('download'),
      inNav: !!(el.closest && el.closest('nav,[role="navigation"]')),
      formMutating: !!form && !!formMethod && formMethod !== 'get',
      cssFallback: cssPath(el),
      nameless: !name,
    };
  }

  function collect() {
    const overlay = overlayRoot();
    const root = overlay || document;
    const found = [];
    for (const el of root.querySelectorAll(ACTION_SELECTOR)) {
      if (!visible(el)) continue;
      if (overlay && !overlay.contains(el)) continue;
      found.push({ el, info: describe(el) });
    }

    // Keys must survive a revisit, so disambiguate by href before falling back to
    // position — list order is far less stable than a link target.
    const byBase = new Map();
    for (const entry of found) {
      const base = `${entry.info.kind}:${entry.info.role}:${entry.info.identity}`;
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(entry);
    }
    for (const [base, entries] of byBase) {
      if (entries.length === 1) { entries[0].info.key = base; continue; }
      const paths = entries.map(entry => entry.info.hrefPath);
      const uniquePaths = new Set(paths.filter(Boolean));
      if (uniquePaths.size === entries.length) {
        entries.forEach(entry => { entry.info.key = `${base}:${entry.info.hrefPath}`; });
        continue;
      }
      entries.forEach((entry, index) => {
        entry.info.key = `${base}#${index + 1}`;
        entry.info.ambiguous = true;
      });
    }

    return { overlay, entries: found };
  }

  window.__screenMap = {
    ready: true,

    observe() {
      const { overlay, entries } = collect();
      return {
        url: location.href,
        pathname: location.pathname,
        search: location.search,
        title: clean(document.title),
        scope: overlay ? 'overlay' : 'document',
        fingerprint: fingerprint(overlay),
        actions: entries.map(entry => entry.info),
      };
    },

    /** Returns a viewport click point, or a reason the key is no longer usable. */
    resolve(key, cssFallback) {
      const { entries } = collect();
      let via = 'key';
      let matches = entries.filter(entry => entry.info.key === key);

      // The accessible name can drift for reasons that do not change the control.
      // A structural selector is a worse identity but a better last resort than
      // reporting the screen unreachable.
      if (matches.length !== 1 && cssFallback) {
        const byCss = entries.filter(entry => entry.info.cssFallback === cssFallback);
        if (byCss.length === 1) { matches = byCss; via = 'css'; }
      }

      if (matches.length === 0) return { ok: false, reason: 'not-found', count: 0 };
      if (matches.length > 1) return { ok: false, reason: 'ambiguous', count: matches.length };

      const el = matches[0].el;
      // A new tab is invisible to the driver; keep every navigation in this one.
      if (el.hasAttribute && el.hasAttribute('target')) el.removeAttribute('target');
      el.scrollIntoView({ block: 'center', inline: 'center' });

      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1);
      if (!(rect.width > 0 && rect.height > 0)) return { ok: false, reason: 'not-visible', count: 1 };
      return { ok: true, x, y, count: 1, via, action: matches[0].info };
    },
  };

  if (!RECORDING || typeof window.__screenMapEmit !== 'function') return;

  /**
   * Recording, page side: report what was activated, the instant it is activated.
   *
   * The report goes out through a CDP binding rather than into a variable the driver
   * later reads, because the common case is a click that navigates: the document — and
   * any buffer living in it — is gone before anyone could come back for it. Calling the
   * binding raises the event while the document is still standing.
   *
   * Listeners are capture-phase and passive-by-construction: they read, they never call
   * preventDefault, and they never stop propagation. A click the app would have handled
   * is handled exactly as it would have been.
   */
  let seq = 0;

  const controlFor = target => {
    if (!target || !target.closest) return null;
    return target.closest(ACTION_SELECTOR);
  };

  /** The key `collect()` would give this control, so recorded edges match crawled ones. */
  const describeControl = control => {
    const { entries } = collect();
    const known = entries.find(entry => entry.el === control);
    if (known) return known.info;
    // Outside the harvested set — hidden, or behind an overlay whose subtree we scope to.
    // The base key is what `collect` would have produced without disambiguation, which is
    // right in every case where the name is unique on the screen.
    const info = describe(control);
    info.key = `${info.kind}:${info.role}:${info.identity}`;
    return info;
  };

  const emit = (control, cause) => {
    try {
      const info = describeControl(control);
      seq += 1;
      window.__screenMapEmit(JSON.stringify({
        seq, cause, action: info,
        url: location.href, pathname: location.pathname, search: location.search,
        at: Date.now(),
      }));
    } catch { /* never let bookkeeping break the page */ }
  };

  let lastClick = { el: null, at: 0 };

  document.addEventListener('click', event => {
    const control = controlFor(event.target);
    if (!control) return;
    lastClick = { el: control, at: Date.now() };
    emit(control, 'click');
  }, true);

  // A form submitted with Enter never produces a click, so the submit event is the only
  // evidence it happened. When a submit button *was* clicked, `describe` already called
  // that click a submit — reporting it again here would file one press as two edges.
  document.addEventListener('submit', event => {
    const control = event.submitter
      || (event.target && event.target.querySelector('[type="submit"],button:not([type="button"])'));
    if (!control) return;
    if (lastClick.el === control && Date.now() - lastClick.at < 1000) return;
    emit(control, 'submit');
  }, true);
})();
