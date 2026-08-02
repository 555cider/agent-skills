(function installDomPickerV2() {
  "use strict";

  var VERSION = 2;
  var REVISION = 1;
  var existing = globalThis.__domPicker;
  if (existing && existing.protocolVersion === VERSION && existing.__installed) return existing;
  if (existing && typeof existing.destroy === "function") {
    try { existing.destroy(); } catch (_) { /* replace stale runtime */ }
  }

  var config = globalThis.__DOM_PICKER_CONFIG__ || {};
  var SECURE = config.mode === "isolated";
  var IS_TOP = window.top === window;
  var SESSION_ID = String(config.sessionId || (crypto.randomUUID ? crypto.randomUUID() : Date.now()));
  var ALLOWED_ORIGIN = String(config.allowedOrigin || location.origin);
  var BINDING = config.bindingName && typeof globalThis[config.bindingName] === "function"
    ? globalThis[config.bindingName]
    : null;
  var Z = 2147483647;
  var MAX_TEXT = 300;
  var MAX_HTML = 2400;
  var MAX_INSTRUCTION = 2000;
  var STYLE_KEYS = [
    "display", "position", "boxSizing", "width", "height", "minWidth", "minHeight",
    "maxWidth", "maxHeight", "margin", "marginTop", "marginRight", "marginBottom",
    "marginLeft", "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "flexDirection", "flexWrap", "justifyContent", "alignItems", "alignContent", "gap",
    "rowGap", "columnGap", "gridTemplateColumns", "gridTemplateRows", "color",
    "backgroundColor", "opacity", "fontFamily", "fontSize", "fontWeight", "lineHeight",
    "letterSpacing", "textAlign", "whiteSpace", "border", "borderRadius", "boxShadow",
    "overflow", "overflowX", "overflowY", "zIndex", "visibility", "pointerEvents"
  ];
  var LEAF_TAGS = new Set(["SVG", "PATH", "USE", "IMG", "I", "SPAN", "EM", "B", "STRONG", "SMALL"]);
  var state = {
    armed: false,
    multi: false,
    panelOpen: false,
    draft: "",
    picks: [],
    pending: new Map(),
    jobs: [],
    cancelPending: new Set(),
    captureMode: false,
    captureTransitions: 0,
    bridgeSeenAt: SECURE ? 0 : Date.now(),
    bridgeMessage: "",
    pausedReason: "",
    seq: 0
  };
  var selected = [];
  var hoverTarget = null;
  var destroyed = false;
  var raf = 0;
  var suppressClickUntil = 0;
  var stateTimer = 0;
  var healthTimer = 0;
  var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(schedulePosition) : null;
  var shadowMode = config.shadowMode === "open" || config.shadowMode === "light" ? config.shadowMode : "closed";

  var I18N = {
    ko: {
      launcher: "요소 선택",
      armed: "선택 중 · Esc로 취소",
      selected: function (n) { return n + "개 선택됨"; },
      title: "선택한 요소",
      instruction: "수정 요청",
      placeholder: "이 요소를 어떻게 고칠까요?",
      send: "수정 요청 보내기",
      disconnected: "에이전트 연결을 기다리는 중",
      originBlocked: "다른 출처로 이동해 선택기가 일시 정지됨",
      delivered: "에이전트에 전달됨",
      sending: "요청을 안전하게 기록하는 중",
      choose: "먼저 요소를 선택하세요",
      enter: "수정 내용을 입력하세요",
      parent: "선택 범위 넓히기",
      child: "선택 범위 되돌리기",
      add: "요소 더 선택",
      remove: "선택 해제",
      clear: "모두 해제",
      collapse: "패널 접기",
      hint: "클릭해 선택 · Shift+클릭으로 여러 개 · Esc로 취소",
      fallback: "요소 선택 후 수정 내용은 채팅에 입력하세요",
      requests: "요청 상태",
      requestCount: function (n) { return "요청 " + n; },
      cancelRequest: "요청 취소",
      cancelSending: "취소 요청 중",
      stages: {
        queued: "대기 중", claimed: "작업 접수", locating: "위치 찾는 중", editing: "수정 중",
        verifying: "검증 중", cancel_requested: "취소 요청됨", applied_verified: "적용 및 검증 완료",
        no_change: "변경 없음", cancelled: "취소됨", review_required: "검토 필요", blocked: "중단됨"
      }
    },
    en: {
      launcher: "Select element",
      armed: "Selecting · Esc to cancel",
      selected: function (n) { return n + " selected"; },
      title: "Selected elements",
      instruction: "Fix request",
      placeholder: "How should this element be fixed?",
      send: "Send fix request",
      disconnected: "Waiting for the agent connection",
      originBlocked: "Picker paused after navigating to another origin",
      delivered: "Delivered to the agent",
      sending: "Recording the request safely",
      choose: "Select an element first",
      enter: "Enter what should change",
      parent: "Widen selection",
      child: "Narrow selection",
      add: "Add element",
      remove: "Remove selection",
      clear: "Clear all",
      collapse: "Collapse panel",
      hint: "Click to select · Shift+click for multiple · Esc to cancel",
      fallback: "Select the element, then describe the fix in chat",
      requests: "Request status",
      requestCount: function (n) { return n + " request" + (n === 1 ? "" : "s"); },
      cancelRequest: "Cancel request",
      cancelSending: "Requesting cancellation",
      stages: {
        queued: "Queued", claimed: "Claimed", locating: "Locating source", editing: "Editing",
        verifying: "Verifying", cancel_requested: "Cancellation requested", applied_verified: "Applied and verified",
        no_change: "No change", cancelled: "Cancelled", review_required: "Needs review", blocked: "Blocked"
      }
    }
  };
  var T = ((navigator.language || "en").toLowerCase().startsWith("ko")) ? I18N.ko : I18N.en;

  function truncate(value, size) {
    if (value == null) return null;
    var text = String(value);
    return text.length > size ? text.slice(0, size) + "…" : text;
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof CSS.escape === "function") return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (char) { return "\\" + char; })
      .replace(/^(-?)([0-9])/, function (_, dash, digit) { return dash + "\\3" + digit + " "; });
  }

  function attrEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function uniqueSelector(selector, element) {
    try {
      var matches = document.querySelectorAll(selector);
      return matches.length === 1 && (!element || matches[0] === element);
    } catch (_) {
      return false;
    }
  }

  function buildLocators(element) {
    var locators = [];
    function add(strategy, value, selector, strength) {
      if (!value) return;
      locators.push({ strategy: strategy, value: String(value), selector: selector || null, unique: !!(selector && uniqueSelector(selector, element)), strength: strength });
    }
    if (element.id) add("id", element.id, "#" + cssEscape(element.id), "high");
    var testId = element.getAttribute("data-testid");
    if (testId) add("testid", testId, "[data-testid=\"" + attrEscape(testId) + "\"]", "high");
    var aria = element.getAttribute("aria-label");
    if (aria) add("aria-label", aria, "[aria-label=\"" + attrEscape(aria) + "\"]", "high");
    var name = element.getAttribute("name");
    if (name) add("name", name, "[name=\"" + attrEscape(name) + "\"]", "medium");
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 7) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        part += "#" + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function (child) { return child.tagName === node.tagName; });
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    var cssPath = parts.join(" > ");
    add("css", cssPath, cssPath, "low");
    return locators.sort(function (a, b) {
      return Number(b.unique) - Number(a.unique) || ({ high: 3, medium: 2, low: 1 }[b.strength] - { high: 3, medium: 2, low: 1 }[a.strength]);
    });
  }

  function accessibleName(element) {
    var aria = element.getAttribute("aria-label");
    if (aria) return truncate(aria.trim(), 160);
    var labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      var labels = labelledBy.split(/\s+/).map(function (id) { return document.getElementById(id); }).filter(Boolean);
      var joined = labels.map(function (node) { return (node.textContent || "").trim(); }).filter(Boolean).join(" ");
      if (joined) return truncate(joined, 160);
    }
    if (element.id) {
      try {
        var label = document.querySelector("label[for=\"" + attrEscape(element.id) + "\"]");
        if (label && label.textContent.trim()) return truncate(label.textContent.trim(), 160);
      } catch (_) { /* invalid id selector */ }
    }
    var alt = element.getAttribute("alt") || element.getAttribute("title");
    if (alt) return truncate(alt.trim(), 160);
    return truncate((element.textContent || "").trim().replace(/\s+/g, " "), 160) || "";
  }

  function inferredRole(element) {
    var explicit = element.getAttribute("role");
    if (explicit) return explicit;
    var tag = element.tagName;
    if (tag === "BUTTON") return "button";
    if (tag === "A" && element.hasAttribute("href")) return "link";
    if (tag === "INPUT") return element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return "img";
    return null;
  }

  function styleSnapshot(element, pseudo) {
    var computed = getComputedStyle(element, pseudo || null);
    var result = {};
    STYLE_KEYS.forEach(function (key) {
      var cssName = key.replace(/[A-Z]/g, function (char) { return "-" + char.toLowerCase(); });
      var value = computed.getPropertyValue(cssName);
      if (value) result[key] = value;
    });
    if (pseudo) result.content = computed.content;
    return result;
  }

  function ancestorSnapshot(element) {
    var items = [];
    var node = element;
    while (node && node.nodeType === 1 && items.length < 6) {
      items.push({
        tagName: node.tagName.toLowerCase(),
        id: node.id || null,
        className: truncate(node.getAttribute("class"), 240),
        role: inferredRole(node),
        text: truncate((node.textContent || "").trim().replace(/\s+/g, " "), 100)
      });
      node = node.parentElement;
    }
    return items;
  }

  function nearbyText(element) {
    var result = [];
    var seen = new Set();
    function add(node) {
      if (!node) return;
      var text = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (text && text.length <= 160 && !seen.has(text)) {
        seen.add(text);
        result.push(text);
      }
    }
    add(element.previousElementSibling);
    add(element.nextElementSibling);
    var parent = element.parentElement;
    if (parent) add(parent.querySelector("h1,h2,h3,h4,label,legend,[role=heading]"));
    return result.slice(0, 8);
  }

  function resolveSemanticTarget(element, exact) {
    if (!element || element.nodeType !== 1 || exact) return element;
    var node = element;
    for (var hop = 0; node && hop < 6; hop += 1, node = node.parentElement) {
      if (node.hasAttribute("data-testid") || node.id || node.hasAttribute("aria-label") || node.hasAttribute("role")) return node;
      if (["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)) return node;
      if (!LEAF_TAGS.has(node.tagName) && (node.textContent || "").trim()) return node;
    }
    return element;
  }

  function makeEvidence(rawElement, options) {
    var element = resolveSemanticTarget(rawElement, options && options.exact);
    if (!element) return null;
    var rect = element.getBoundingClientRect();
    var locators = buildLocators(element);
    var parent = element.parentElement;
    var attributes = {
      id: element.id || null,
      class: truncate(element.getAttribute("class"), 800),
      dataTestId: truncate(element.getAttribute("data-testid"), 240),
      ariaLabel: truncate(element.getAttribute("aria-label"), 240),
      name: truncate(element.getAttribute("name"), 240),
      type: truncate(element.getAttribute("type"), 80),
      href: truncate(element.getAttribute("href"), 400)
    };
    return {
      pickId: crypto.randomUUID ? crypto.randomUUID() : SESSION_ID + "-pick-" + (++state.seq),
      selector: (locators.find(function (item) { return item.unique; }) || locators[0] || {}).selector || null,
      locators: locators,
      tagName: element.tagName.toLowerCase(),
      role: inferredRole(element),
      accessibleName: accessibleName(element),
      attributes: attributes,
      text: truncate((element.textContent || "").trim().replace(/\s+/g, " "), MAX_TEXT) || "",
      outerHTML: truncate(element.outerHTML, MAX_HTML),
      nearbyText: nearbyText(element),
      ancestry: ancestorSnapshot(element),
      rect: { x: rect.x, y: rect.y, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
      computedStyle: styleSnapshot(element),
      pseudoStyles: { before: styleSnapshot(element, "::before"), after: styleSnapshot(element, "::after") },
      layoutContext: parent ? {
        parentTagName: parent.tagName.toLowerCase(),
        parentDisplay: getComputedStyle(parent).display,
        parentFlexDirection: getComputedStyle(parent).flexDirection,
        parentGap: getComputedStyle(parent).gap,
        siblingCount: parent.children.length
      } : null,
      metrics: {
        horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        verticalOverflow: element.scrollHeight > element.clientHeight + 1,
        clipped: ["hidden", "clip"].includes(getComputedStyle(element).overflow) && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      },
      resolvedFromLeaf: element !== rawElement ? rawElement.tagName.toLowerCase() : null,
      frame: { url: location.href, origin: location.origin, isTop: IS_TOP },
      capturedAt: new Date().toISOString()
    };
  }

  function findCandidates(query, requestedLimit) {
    var normalizedQuery = String(query || "").trim().replace(/\s+/g, " ").toLowerCase();
    var limit = Math.max(1, Math.min(50, Number(requestedLimit) || 20));
    if (!normalizedQuery) return [];
    var terms = normalizedQuery.split(" ").filter(Boolean);
    var matches = [];
    var elements = Array.from(document.querySelectorAll("body *")).slice(0, 5000);
    elements.forEach(function (element, documentIndex) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"].includes(element.tagName)) return;
      if (element.closest("dom-picker-v2-host")) return;
      var rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      var computed = getComputedStyle(element);
      if (computed.display === "none" || computed.visibility === "hidden" || Number(computed.opacity) === 0) return;
      var name = accessibleName(element) || "";
      var text = truncate((element.textContent || "").trim().replace(/\s+/g, " "), MAX_TEXT) || "";
      var stableText = [element.id, element.getAttribute("data-testid"), element.getAttribute("aria-label"), element.getAttribute("name")]
        .filter(Boolean).join(" ");
      var haystack = (name + " " + text + " " + stableText).toLowerCase();
      if (!terms.every(function (term) { return haystack.includes(term); })) return;
      var locators = buildLocators(element);
      var best = locators.find(function (locator) { return locator.unique; }) || locators[0] || null;
      if (!best || !best.selector) return;
      var normalizedName = name.toLowerCase().replace(/\s+/g, " ");
      var normalizedText = text.toLowerCase().replace(/\s+/g, " ");
      var stableUnique = locators.some(function (locator) { return locator.unique && locator.strength === "high"; });
      var exact = normalizedName === normalizedQuery || normalizedText === normalizedQuery;
      var semantic = !!inferredRole(element) || ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"].includes(element.tagName);
      var depth = 0;
      for (var node = element; node && node !== document.body; node = node.parentElement) depth += 1;
      var score = (exact ? 1000 : 0) + (stableUnique ? 200 : 0) + (semantic ? 40 : 0)
        - Math.min(200, Math.max(0, text.length - normalizedQuery.length)) - depth;
      matches.push({
        score: score,
        documentIndex: documentIndex,
        candidate: {
          tagName: element.tagName.toLowerCase(),
          role: inferredRole(element),
          accessibleName: name,
          text: text,
          selector: best.selector,
          locators: locators.slice(0, 6),
          attributes: {
            id: element.id || null,
            dataTestId: truncate(element.getAttribute("data-testid"), 240),
            ariaLabel: truncate(element.getAttribute("aria-label"), 240),
            name: truncate(element.getAttribute("name"), 240)
          },
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          frame: { url: location.href, origin: location.origin, isTop: IS_TOP }
        }
      });
    });
    return matches.sort(function (a, b) { return b.score - a.score || a.documentIndex - b.documentIndex; })
      .slice(0, limit).map(function (entry) { return entry.candidate; });
  }

  function labelFor(evidence) {
    var detail = evidence.accessibleName || evidence.attributes.dataTestId || evidence.attributes.id || evidence.text;
    return evidence.tagName + (detail ? " · " + truncate(detail, 42) : "");
  }

  function serializeState() {
    return {
      armed: state.armed,
      multi: state.multi,
      panelOpen: state.panelOpen,
      draft: state.draft,
      picks: state.picks.map(function (pick) { return JSON.parse(JSON.stringify(pick)); }),
      pausedReason: state.pausedReason
    };
  }

  function emit(event, payload, trustedEvent) {
    var envelope = {
      protocolVersion: VERSION,
      protocolRevision: REVISION,
      event: event,
      sessionId: SESSION_ID,
      frame: { url: location.href, origin: location.origin, isTop: IS_TOP },
      trustedUserEvent: !!(trustedEvent && trustedEvent.isTrusted),
      payload: payload || {}
    };
    if (BINDING) {
      try {
        BINDING(JSON.stringify(envelope));
        return true;
      } catch (error) {
        state.bridgeMessage = String(error && error.message || error);
      }
    }
    return false;
  }

  function scheduleStateEmit() {
    if (!SECURE || !BINDING) return;
    clearTimeout(stateTimer);
    stateTimer = setTimeout(function () { emit("state", serializeState()); }, 120);
  }

  var host = document.createElement("dom-picker-v2-host");
  host.setAttribute("data-dom-picker-version", String(VERSION));
  [
    ["all", "initial"], ["display", "block"], ["position", "fixed"], ["inset", "0"],
    ["width", "100vw"], ["height", "100vh"], ["z-index", String(Z)], ["pointer-events", "none"],
    ["contain", "layout style"], ["isolation", "isolate"], ["color-scheme", "dark"]
  ].forEach(function (entry) { host.style.setProperty(entry[0], entry[1], "important"); });
  var root = shadowMode === "light" ? host : host.attachShadow({ mode: shadowMode });

  var style = document.createElement("style");
  style.textContent = "\n" +
    ":host,.dp-root{--dp-ink:#081120;--dp-surface:#101b31;--dp-line:#33415d;--dp-text:#f3f7ff;--dp-dim:#b4bfd3;--dp-accent:#7c83ff;--dp-accent2:#13c795;--dp-danger:#ff5576;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--dp-text);color-scheme:dark}\n" +
    ".dp-root,.dp-root *{box-sizing:border-box}\n" +
    ".dp-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-size:14px;line-height:1.4}\n" +
    ".dp-overlay{position:fixed;pointer-events:none;border:2px solid var(--dp-accent2);background:rgba(19,199,149,.13);border-radius:4px}\n" +
    ".dp-overlay>span{position:absolute;left:-2px;top:-24px;max-width:min(360px,90vw);height:24px;padding:3px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:5px 5px 0 0;background:var(--dp-accent2);color:#03251b;font:700 11px/18px ui-monospace,SFMono-Regular,Menlo,monospace}\n" +
    ".dp-hover{border-color:var(--dp-accent);background:rgba(124,131,255,.14)}\n" +
    ".dp-hover>span{background:#111a2e;color:var(--dp-text);border:1px solid var(--dp-accent)}\n" +
    ".dp-launcher,.dp-panel{pointer-events:auto}\n" +
    ".dp-launcher{position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));min-width:132px;min-height:46px;padding:10px 14px;border:1px solid var(--dp-line);border-radius:12px;background:var(--dp-ink);color:var(--dp-text);box-shadow:0 10px 32px rgba(0,0,0,.38);font:700 13px/1.2 inherit;cursor:pointer}\n" +
    ".dp-launcher:hover,.dp-launcher:focus-visible{border-color:var(--dp-accent);background:#14213b;outline:3px solid rgba(124,131,255,.3);outline-offset:2px}\n" +
    ".dp-launcher[data-armed=true]{border-color:var(--dp-accent);box-shadow:0 0 0 3px rgba(124,131,255,.25),0 10px 32px rgba(0,0,0,.38)}\n" +
    ".dp-launcher-badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;margin-left:8px;padding:0 6px;border-radius:999px;background:var(--dp-accent2);color:#03251b;font-size:11px;font-weight:850}\n" +
    ".dp-panel{position:fixed;width:min(420px,calc(100vw - 24px));max-height:min(640px,calc(100vh - 84px));overflow:auto;border:1px solid var(--dp-line);border-radius:16px;background:var(--dp-surface);box-shadow:0 20px 60px rgba(0,0,0,.48);overscroll-behavior:contain}\n" +
    ".dp-panel[data-side=right]{right:12px;bottom:72px}.dp-panel[data-side=left]{left:12px;bottom:12px}.dp-hidden{display:none!important}\n" +
    ".dp-head{display:flex;align-items:center;gap:10px;min-height:52px;padding:10px 14px;border-bottom:1px solid var(--dp-line)}\n" +
    ".dp-title{min-width:0;flex:1;font-weight:750}.dp-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:999px;background:var(--dp-accent2);color:#03251b;font-size:11px;font-weight:800}\n" +
    ".dp-icon-button{width:44px;height:44px;border:0;border-radius:9px;background:transparent;color:var(--dp-dim);cursor:pointer;font:700 16px/1 inherit}.dp-icon-button:hover,.dp-icon-button:focus-visible{background:rgba(255,255,255,.08);color:var(--dp-text);outline:2px solid var(--dp-accent);outline-offset:-2px}\n" +
    ".dp-picks{max-height:220px;overflow:auto}.dp-pick{display:grid;grid-template-columns:28px minmax(0,1fr) 44px;gap:9px;align-items:start;padding:10px 14px;border-bottom:1px solid rgba(148,163,184,.16)}\n" +
    ".dp-number{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dp-accent2);color:#03251b;font-size:11px;font-weight:850}.dp-pick-label{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dp-selector{margin-top:2px;color:var(--dp-dim);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dp-refine{grid-column:2/4;display:flex;gap:6px;flex-wrap:wrap}.dp-scope-button{min-height:44px;border:1px solid var(--dp-line);border-radius:9px;padding:7px 9px;background:transparent;color:var(--dp-text);font:700 11px/1.2 inherit;cursor:pointer}.dp-scope-button:hover,.dp-scope-button:focus-visible{border-color:var(--dp-accent);outline:2px solid var(--dp-accent);outline-offset:1px}.dp-scope-button:disabled{cursor:not-allowed;opacity:.5}\n" +
    ".dp-form{padding:12px 14px}.dp-label{display:block;margin-bottom:6px;color:var(--dp-text);font-size:12px;font-weight:700}.dp-textarea{display:block;width:100%;min-height:84px;resize:vertical;border:1px solid var(--dp-line);border-radius:10px;padding:10px 11px;background:var(--dp-ink);color:var(--dp-text);font:14px/1.45 inherit}.dp-textarea::placeholder{color:#b8c3d7;opacity:1}.dp-textarea:focus{border-color:var(--dp-accent);outline:3px solid rgba(124,131,255,.25)}\n" +
    ".dp-jobs{border-bottom:1px solid rgba(148,163,184,.16)}.dp-job{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid rgba(148,163,184,.12)}.dp-job:first-child{border-top:0}.dp-job-stage{font-size:12px;font-weight:800}.dp-job-message{margin-top:2px;color:var(--dp-dim);font-size:11px;overflow-wrap:anywhere}.dp-job-final{opacity:.78}.dp-job .dp-button{min-width:88px}\n" +
    ".dp-actions{display:flex;gap:8px;margin-top:10px}.dp-button{min-height:44px;border:1px solid var(--dp-line);border-radius:10px;padding:9px 12px;background:transparent;color:var(--dp-text);font:700 13px/1.2 inherit;cursor:pointer}.dp-button:hover,.dp-button:focus-visible{background:rgba(255,255,255,.08);border-color:var(--dp-accent);outline:2px solid var(--dp-accent);outline-offset:1px}.dp-primary{flex:1;border-color:transparent;background:var(--dp-accent);color:white}.dp-primary:hover,.dp-primary:focus-visible{background:#9297ff}.dp-primary:disabled{cursor:not-allowed;background:#3e4862;color:#c4cada}\n" +
    ".dp-panel[data-compact=true] .dp-actions{flex-wrap:wrap}.dp-panel[data-compact=true] .dp-button{flex:1}.dp-panel[data-compact=true] .dp-primary{flex:1 0 100%;order:-1}\n" +
    ".dp-status{min-height:34px;padding:7px 14px;border-top:1px solid var(--dp-line);color:var(--dp-dim);font-size:12px}.dp-status[data-kind=ok]{color:#72e9c4}.dp-status[data-kind=error]{color:#ff9caf}\n" +
    ".dp-hint{position:fixed;left:50%;top:max(12px,env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100vw - 24px);padding:9px 14px;border:1px solid var(--dp-accent);border-radius:999px;background:var(--dp-ink);color:var(--dp-text);box-shadow:0 8px 28px rgba(0,0,0,.4);font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n" +
    "@media(max-width:600px){.dp-launcher{right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom))}.dp-actions{flex-wrap:wrap}.dp-button{flex:1}.dp-primary{flex:1 0 100%;order:-1}.dp-hint{top:max(8px,env(safe-area-inset-top));font-size:11px}}\n" +
    "@media(prefers-reduced-motion:reduce){.dp-root *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}";
  root.appendChild(style);
  var shell = document.createElement("div");
  shell.className = "dp-root";
  root.appendChild(shell);

  var overlays = document.createElement("div");
  shell.appendChild(overlays);
  var hint = document.createElement("div");
  hint.className = "dp-hint dp-hidden";
  hint.textContent = T.hint;
  shell.appendChild(hint);
  var launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "dp-launcher";
  launcher.setAttribute("aria-keyshortcuts", "Alt+Shift+S");
  shell.appendChild(launcher);
  var panel = document.createElement("section");
  panel.className = "dp-panel dp-hidden";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", T.title);
  shell.appendChild(panel);
  var textarea = null;
  var statusNode = null;

  function mount() {
    if (destroyed || host.isConnected || !document.documentElement) return;
    document.documentElement.appendChild(host);
  }

  function setVisualHeight() {
    var height = globalThis.visualViewport ? visualViewport.height : innerHeight;
    shell.style.setProperty("--dp-visual-height", Math.max(240, height - 84) + "px");
  }

  function createOverlay(className) {
    var box = document.createElement("div");
    box.className = "dp-overlay " + (className || "");
    var chip = document.createElement("span");
    box.appendChild(chip);
    overlays.appendChild(box);
    return { box: box, chip: chip };
  }

  var hoverOverlay = createOverlay("dp-hover");
  hoverOverlay.box.classList.add("dp-hidden");

  function viewportBounds() {
    var viewport = globalThis.visualViewport;
    var left = viewport ? viewport.offsetLeft : 0;
    var top = viewport ? viewport.offsetTop : 0;
    var width = viewport ? viewport.width : innerWidth;
    var height = viewport ? viewport.height : innerHeight;
    var scale = viewport ? viewport.scale : 1;
    return { left: left, top: top, width: width, height: height, scale: scale, right: left + width, bottom: top + height };
  }

  function placeOverlay(overlay, element, label) {
    if (!element || !element.isConnected) {
      overlay.box.classList.add("dp-hidden");
      return;
    }
    var rect = element.getBoundingClientRect();
    overlay.box.classList.remove("dp-hidden");
    overlay.box.style.left = rect.left + "px";
    overlay.box.style.top = rect.top + "px";
    overlay.box.style.width = rect.width + "px";
    overlay.box.style.height = rect.height + "px";
    overlay.chip.textContent = label || element.tagName.toLowerCase();
    overlay.chip.style.left = "-2px";
    overlay.chip.style.top = "-24px";
    var viewport = viewportBounds();
    var chipRect = overlay.chip.getBoundingClientRect();
    var chipWidth = Math.min(chipRect.width, viewport.width);
    var minimumLeft = viewport.left - rect.left;
    var maximumLeft = viewport.right - rect.left - chipWidth;
    var chipLeft = Math.max(minimumLeft, Math.min(-2, maximumLeft));
    var below = rect.top - 24 < viewport.top;
    overlay.chip.style.left = chipLeft + "px";
    overlay.chip.style.top = (below ? rect.height + 2 : -24) + "px";
    overlay.chip.dataset.placement = below ? "below" : "above";
  }

  function schedulePosition() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      selected.forEach(function (entry, index) {
        placeOverlay(entry.overlay, entry.element, (index + 1) + " · " + labelFor(entry.evidence));
      });
      if (hoverTarget && state.armed) {
        var hoverEvidence = makeEvidence(hoverTarget, { exact: true });
        placeOverlay(hoverOverlay, hoverTarget, labelFor(hoverEvidence) + " · " + Math.round(hoverEvidence.rect.width) + "×" + Math.round(hoverEvidence.rect.height));
      }
      positionPanel();
    });
  }

  function positionPanel() {
    var viewport = viewportBounds();
    var compact = viewport.width <= 600 || viewport.width * viewport.scale <= 600;
    panel.dataset.compact = String(compact);
    if (compact) {
      var averageY = state.picks.length
        ? state.picks.reduce(function (sum, pick) { return sum + pick.rect.top + pick.rect.height / 2; }, 0) / state.picks.length
        : viewport.top;
      var placement = averageY > viewport.top + viewport.height / 2 ? "top" : "bottom";
      panel.dataset.placement = placement;
      panel.style.setProperty("left", viewport.left + 8 + "px", "important");
      panel.style.setProperty("right", "auto", "important");
      panel.style.setProperty("bottom", "auto", "important");
      panel.style.setProperty("width", Math.max(0, viewport.width - 16) + "px", "important");
      panel.style.setProperty("max-height", Math.max(180, Math.min(640, viewport.height * 0.64)) + "px", "important");
      var panelHeight = panel.getBoundingClientRect().height;
      var top = placement === "top"
        ? viewport.top + 8
        : Math.max(viewport.top + 8, viewport.bottom - 66 - panelHeight);
      panel.style.setProperty("top", top + "px", "important");
      return;
    }
    ["left", "right", "top", "bottom", "width", "max-height"].forEach(function (name) { panel.style.removeProperty(name); });
    panel.dataset.placement = "side";
    var side = "right";
    if (state.picks.length) {
      var average = state.picks.reduce(function (sum, pick) { return sum + pick.rect.left + pick.rect.width / 2; }, 0) / state.picks.length;
      side = average > innerWidth / 2 ? "left" : "right";
    }
    panel.dataset.side = side;
  }

  function clearSelection() {
    selected.forEach(function (entry) {
      if (resizeObserver && entry.element) resizeObserver.unobserve(entry.element);
      entry.overlay.box.remove();
    });
    selected = [];
    state.picks = [];
    render();
    scheduleStateEmit();
  }

  function trailEvidence(evidence) {
    return {
      selector: evidence.selector || null,
      locators: (evidence.locators || []).map(function (locator) { return { ...locator }; }),
      tagName: evidence.tagName || "",
      accessibleName: evidence.accessibleName || "",
      attributes: { ...(evidence.attributes || {}) }
    };
  }

  function updateRefinementEvidence(entry) {
    entry.evidence.canWiden = !!(entry.element && entry.element.parentElement && entry.element.parentElement !== host && !host.contains(entry.element.parentElement));
    entry.evidence.canNarrow = !!entry.trail.length;
    entry.evidence.scopeTrail = entry.trail.map(function (item) { return trailEvidence(item.evidence); });
  }

  function selectElement(rawElement, options) {
    if (!rawElement || rawElement.nodeType !== 1 || rawElement === host || host.contains(rawElement)) return null;
    var element = resolveSemanticTarget(rawElement, options && options.exact);
    var existingIndex = selected.findIndex(function (entry) { return entry.element === element; });
    if (existingIndex >= 0) return selected[existingIndex].evidence;
    if (!(options && options.multi)) clearSelection();
    var evidence = makeEvidence(rawElement, options);
    var overlay = createOverlay("");
    var selectionEntry = { element: element, rawElement: rawElement, evidence: evidence, overlay: overlay, trail: [] };
    updateRefinementEvidence(selectionEntry);
    selected.push(selectionEntry);
    state.picks.push(evidence);
    state.panelOpen = IS_TOP;
    if (resizeObserver) resizeObserver.observe(element);
    placeOverlay(overlay, element, selected.length + " · " + labelFor(evidence));
    if (!(options && options.silent)) emit("pick", { pick: evidence }, options && options.trustedEvent);
    render();
    scheduleStateEmit();
    if (IS_TOP && !(options && options.keepFocus)) requestAnimationFrame(function () { if (textarea) textarea.focus(); });
    return evidence;
  }

  function emitSelectionCommand(pick, command, event) {
    if (!IS_TOP || !SECURE || !pick || !pick.frameId || !event || !event.isTrusted) return false;
    return emit("selection_command", {
      command: command,
      pickId: pick.pickId,
      frameId: pick.frameId,
      provenance: { channel: "isolated-picker", trustedUserEvent: true, allowedOrigin: ALLOWED_ORIGIN }
    }, event);
  }

  function refineSelection(index, direction, event) {
    var pick = state.picks[index];
    var selectedIndex = selected.findIndex(function (candidate) { return candidate.evidence.pickId === pick?.pickId; });
    var entry = selected[selectedIndex];
    if (!entry) return emitSelectionCommand(state.picks[index], direction, event);
    var next;
    var previous = null;
    if (direction === "widen") {
      next = entry.element.parentElement;
    } else {
      previous = entry.trail.pop();
      next = previous && previous.element;
    }
    if (!next || next === host || host.contains(next)) return;
    if (direction === "widen") entry.trail.push({ element: entry.element, rawElement: entry.rawElement, evidence: entry.evidence });
    if (resizeObserver) resizeObserver.unobserve(entry.element);
    var pickId = entry.evidence.pickId;
    entry.element = next;
    entry.rawElement = previous ? previous.rawElement : next;
    entry.evidence = makeEvidence(next, { exact: true });
    entry.evidence.pickId = pickId;
    updateRefinementEvidence(entry);
    state.picks[index] = entry.evidence;
    if (resizeObserver) resizeObserver.observe(next);
    render();
    schedulePosition();
    scheduleStateEmit();
  }

  function removeSelection(index, event) {
    var pick = state.picks[index];
    var selectedIndex = selected.findIndex(function (candidate) { return candidate.evidence.pickId === pick?.pickId; });
    var entry = selected[selectedIndex];
    if (!entry) return emitSelectionCommand(state.picks[index], "remove", event);
    if (entry) {
      if (resizeObserver) resizeObserver.unobserve(entry.element);
      entry.overlay.box.remove();
      selected.splice(selectedIndex, 1);
    }
    state.picks.splice(index, 1);
    if (!state.picks.length && !visibleJobs().length) state.panelOpen = false;
    render();
    scheduleStateEmit();
  }

  function bridgeConnected() {
    return !SECURE || (Date.now() - state.bridgeSeenAt < 4500 && !!BINDING);
  }

  function statusText() {
    if (state.pausedReason) return { text: T.originBlocked, kind: "error" };
    if (!SECURE) return { text: T.fallback, kind: "" };
    if (!bridgeConnected()) return { text: T.disconnected, kind: "error" };
    var pending = Array.from(state.pending.values()).pop();
    if (pending === "sending") return { text: T.sending, kind: "" };
    if (pending === "delivered") return { text: T.delivered, kind: "ok" };
    if (!state.picks.length) return { text: T.choose, kind: "" };
    return { text: "Alt+Shift+S · Esc · Ctrl/⌘+Enter", kind: "" };
  }

  function visibleJobs() {
    var active = state.jobs.filter(function (job) { return !job.final; });
    var completed = state.jobs.filter(function (job) { return job.final; }).slice(-3).reverse();
    return active.concat(completed);
  }

  function requestCancellation(job, event) {
    if (!SECURE || !event || !event.isTrusted || !job || !job.cancellable || state.cancelPending.has(job.requestId)) return false;
    state.cancelPending.add(job.requestId);
    var sent = emit("cancel_request", {
      requestId: job.requestId,
      provenance: { channel: "isolated-picker", trustedUserEvent: true, allowedOrigin: ALLOWED_ORIGIN }
    }, event);
    if (!sent) state.cancelPending.delete(job.requestId);
    render();
    setTimeout(function () {
      if (state.cancelPending.delete(job.requestId)) render();
    }, 5000);
    return sent;
  }

  function renderLauncher() {
    var latestPending = Array.from(state.pending.values()).pop();
    var activeCount = state.jobs.filter(function (job) { return !job.final; }).length;
    launcher.dataset.armed = String(state.armed);
    var text = latestPending === "delivered"
      ? T.delivered
      : state.armed ? T.armed : state.picks.length ? T.selected(state.picks.length) : T.launcher;
    launcher.replaceChildren(document.createTextNode(text));
    if (activeCount) {
      var badge = document.createElement("span");
      badge.className = "dp-launcher-badge";
      badge.textContent = String(activeCount);
      badge.setAttribute("aria-hidden", "true");
      launcher.appendChild(badge);
    }
    launcher.setAttribute("aria-label", activeCount ? text + " · " + T.requestCount(activeCount) : text);
  }

  function iconButton(text, label, handler) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dp-icon-button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", function (event) { event.stopPropagation(); handler(event); });
    return button;
  }

  function scopeButton(label, disabled, handler) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "dp-scope-button";
    button.textContent = label;
    button.setAttribute("aria-label", label);
    button.disabled = !!disabled;
    button.addEventListener("click", function (event) { event.stopPropagation(); handler(event); });
    return button;
  }

  function renderPanel() {
    panel.replaceChildren();
    var jobs = visibleJobs();
    var hasContent = state.picks.length || jobs.length;
    panel.classList.toggle("dp-hidden", !IS_TOP || !state.panelOpen || !hasContent);
    if (!IS_TOP || !hasContent) return;
    var head = document.createElement("div");
    head.className = "dp-head";
    var title = document.createElement("div");
    title.className = "dp-title";
    title.textContent = state.picks.length ? T.title : T.requests;
    var count = document.createElement("span");
    count.className = "dp-count";
    count.textContent = String(state.picks.length || state.jobs.filter(function (job) { return !job.final; }).length || jobs.length);
    head.append(title, count, iconButton("—", T.collapse, function () { state.panelOpen = false; render(); }));
    panel.appendChild(head);
    if (state.picks.length) {
      var list = document.createElement("div");
      list.className = "dp-picks";
      state.picks.forEach(function (pick, index) {
      var row = document.createElement("div");
      row.className = "dp-pick";
      var number = document.createElement("div");
      number.className = "dp-number";
      number.textContent = String(index + 1);
      var body = document.createElement("div");
      var label = document.createElement("div");
      label.className = "dp-pick-label";
      label.textContent = labelFor(pick);
      var selector = document.createElement("div");
      selector.className = "dp-selector";
      selector.textContent = pick.selector || "(no stable selector)";
      selector.title = selector.textContent;
      body.append(label, selector);
      var controls = document.createElement("div");
      controls.className = "dp-refine";
      var selectionEntry = selected.find(function (entry) { return entry.evidence.pickId === pick.pickId; });
      controls.append(
        scopeButton(T.parent, selectionEntry ? !selectionEntry.evidence.canWiden : pick.canWiden === false, function (event) { refineSelection(index, "widen", event); }),
        scopeButton(T.child, selectionEntry ? !selectionEntry.evidence.canNarrow : !pick.canNarrow, function (event) { refineSelection(index, "narrow", event); })
      );
      var remove = iconButton("×", T.remove, function (event) { removeSelection(index, event); });
      row.append(number, body, remove, controls);
        list.appendChild(row);
      });
      panel.appendChild(list);
    }
    if (jobs.length) {
      var jobList = document.createElement("div");
      jobList.className = "dp-jobs";
      jobs.forEach(function (job) {
        var row = document.createElement("div");
        row.className = "dp-job" + (job.final ? " dp-job-final" : "");
        var body = document.createElement("div");
        var stage = document.createElement("div");
        stage.className = "dp-job-stage";
        stage.textContent = T.stages[job.state] || job.state;
        body.appendChild(stage);
        if (job.message) {
          var message = document.createElement("div");
          message.className = "dp-job-message";
          message.textContent = job.message;
          body.appendChild(message);
        }
        row.appendChild(body);
        if (!job.final) {
          var cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "dp-button";
          cancel.textContent = state.cancelPending.has(job.requestId) ? T.cancelSending : T.cancelRequest;
          cancel.setAttribute("aria-label", T.cancelRequest);
          cancel.disabled = !job.cancellable || state.cancelPending.has(job.requestId);
          cancel.addEventListener("click", function (event) { event.stopPropagation(); requestCancellation(job, event); });
          row.appendChild(cancel);
        }
        jobList.appendChild(row);
      });
      panel.appendChild(jobList);
    }
    if (state.picks.length) {
      var form = document.createElement("div");
      form.className = "dp-form";
    var label = document.createElement("label");
    label.className = "dp-label";
    label.textContent = T.instruction;
    var textareaId = "dp-instruction-" + SESSION_ID.replace(/[^a-zA-Z0-9_-]/g, "");
    label.htmlFor = textareaId;
    textarea = document.createElement("textarea");
    textarea.id = textareaId;
    textarea.className = "dp-textarea";
    textarea.placeholder = T.placeholder;
    textarea.maxLength = MAX_INSTRUCTION;
    textarea.value = state.draft;
    textarea.disabled = !SECURE;
    textarea.addEventListener("input", function () { state.draft = textarea.value; scheduleStateEmit(); });
    textarea.addEventListener("keydown", function (event) {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submitRequest(event);
    });
    var actions = document.createElement("div");
    actions.className = "dp-actions";
    var send = document.createElement("button");
    send.type = "button";
    send.className = "dp-button dp-primary";
    send.textContent = T.send;
    send.disabled = !SECURE || !bridgeConnected() || !!state.pausedReason;
    send.addEventListener("click", function (event) { event.stopPropagation(); submitRequest(event); });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "dp-button";
    add.textContent = T.add;
    add.addEventListener("click", function (event) {
      event.stopPropagation();
      state.panelOpen = false;
      arm({ multi: true });
    });
    var clear = document.createElement("button");
    clear.type = "button";
    clear.className = "dp-button";
    clear.textContent = T.clear;
    clear.addEventListener("click", function (event) { event.stopPropagation(); clearSelection(); });
    actions.append(send, add, clear);
      form.append(label, textarea, actions);
      panel.appendChild(form);
    } else {
      textarea = null;
    }
    statusNode = document.createElement("div");
    statusNode.className = "dp-status";
    statusNode.setAttribute("role", "status");
    statusNode.setAttribute("aria-live", "polite");
    var currentStatus = statusText();
    statusNode.textContent = currentStatus.text;
    statusNode.dataset.kind = currentStatus.kind;
    panel.appendChild(statusNode);
  }

  function render() {
    if (destroyed) return;
    setVisualHeight();
    renderLauncher();
    renderPanel();
    hint.classList.toggle("dp-hidden", !state.armed);
    positionPanel();
    schedulePosition();
  }

  function arm(options) {
    if (location.origin !== ALLOWED_ORIGIN) {
      state.pausedReason = "origin";
      state.armed = false;
      render();
      return false;
    }
    state.pausedReason = "";
    state.armed = true;
    state.multi = !!(options && options.multi);
    render();
    scheduleStateEmit();
    return true;
  }

  function disarm() {
    state.armed = false;
    hoverTarget = null;
    hoverOverlay.box.classList.add("dp-hidden");
    render();
    scheduleStateEmit();
  }

  function submitRequest(event) {
    if (!SECURE || !event || !event.isTrusted) return false;
    if (location.origin !== ALLOWED_ORIGIN) {
      state.pausedReason = "origin";
      render();
      return false;
    }
    if (!bridgeConnected() || !state.picks.length || !state.draft.trim()) {
      if (statusNode) {
        statusNode.textContent = !bridgeConnected() ? T.disconnected : !state.picks.length ? T.choose : T.enter;
        statusNode.dataset.kind = "error";
      }
      return false;
    }
    var requestId = crypto.randomUUID ? crypto.randomUUID() : SESSION_ID + "-request-" + (++state.seq);
    state.pending.set(requestId, "sending");
    var payload = {
      requestId: requestId,
      instruction: state.draft.trim().slice(0, MAX_INSTRUCTION),
      picks: state.picks.map(function (pick) { return JSON.parse(JSON.stringify(pick)); }),
      provenance: { channel: "isolated-picker", trustedUserEvent: true, allowedOrigin: ALLOWED_ORIGIN }
    };
    var sent = emit("request", payload, event);
    if (!sent) state.pending.delete(requestId);
    render();
    return sent;
  }

  function onPointerMove(event) {
    if (!state.armed || !event.isTrusted) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host)) return;
    var candidate = path.find(function (node) { return node && node.nodeType === 1 && node !== host && !host.contains(node); });
    if (!candidate) candidate = document.elementFromPoint(event.clientX, event.clientY);
    if (!candidate || candidate === host || host.contains(candidate)) return;
    hoverTarget = resolveSemanticTarget(candidate, event.altKey);
    schedulePosition();
  }

  function onPointerDown(event) {
    if (!state.armed || !event.isTrusted) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host)) return;
    var candidate = path.find(function (node) { return node && node.nodeType === 1 && node !== host && !host.contains(node); });
    if (!candidate) candidate = document.elementFromPoint(event.clientX, event.clientY);
    if (!candidate || candidate === host || host.contains(candidate)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClickUntil = performance.now() + 800;
    selectElement(candidate, { exact: event.altKey, multi: event.shiftKey || state.multi, trustedEvent: event });
    if (!event.shiftKey && !state.multi) disarm();
  }

  function onClickCapture(event) {
    if (!event.isTrusted) return;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host)) return;
    if (!state.armed && performance.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onKeydown(event) {
    if (!event.isTrusted) return;
    if (event.altKey && event.shiftKey && (event.code === "KeyS" || event.key.toLowerCase() === "s")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.armed ? disarm() : arm({ multi: false });
      return;
    }
    if (state.armed && event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      var path = typeof event.composedPath === "function" ? event.composedPath() : [];
      var focused = document.activeElement;
      if (!path.includes(host) && focused && focused.nodeType === 1 && focused !== document.body && focused !== document.documentElement && !host.contains(focused)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        selectElement(focused, { exact: event.altKey, multi: event.shiftKey || state.multi, keepFocus: event.shiftKey, trustedEvent: event });
        if (!event.shiftKey && !state.multi) disarm();
        return;
      }
    }
    if (event.key === "Escape" && state.armed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      disarm();
    }
  }

  launcher.addEventListener("click", function (event) {
    event.stopPropagation();
    if ((state.picks.length || visibleJobs().length) && !state.armed) {
      state.panelOpen = !state.panelOpen;
      render();
      return;
    }
    state.armed ? disarm() : arm({ multi: false });
  });
  document.addEventListener("pointermove", onPointerMove, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition, true);
  if (globalThis.visualViewport) visualViewport.addEventListener("resize", render);

  var api = {
    protocolVersion: VERSION,
    protocolRevision: REVISION,
    sessionId: SESSION_ID,
    __installed: true,
    arm: arm,
    disarm: disarm,
    snapshot: function (target, options) {
      var element = typeof target === "string" ? document.querySelector(target) : target;
      return selectElement(element, options || { exact: false, multi: false });
    },
    getState: function () { return serializeState(); },
    clear: clearSelection,
    destroy: function () {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(stateTimer);
      clearInterval(healthTimer);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("DOMContentLoaded", mount);
      window.removeEventListener("scroll", schedulePosition, true);
      window.removeEventListener("resize", schedulePosition, true);
      if (globalThis.visualViewport) visualViewport.removeEventListener("resize", render);
      if (resizeObserver) resizeObserver.disconnect();
      host.remove();
      try { delete globalThis.__domPicker; } catch (_) { globalThis.__domPicker = undefined; }
    },
    _host: {
      heartbeat: function () {
        var wasConnected = bridgeConnected();
        var wasPaused = state.pausedReason === "bridge";
        state.bridgeSeenAt = Date.now();
        if (wasPaused) state.pausedReason = "";
        if (!wasConnected || wasPaused) render();
        return true;
      },
      setCaptureMode: function (hidden) {
        var next = !!hidden;
        if (state.captureMode === next) return true;
        state.captureMode = next;
        state.captureTransitions += 1;
        if (next) host.style.setProperty("visibility", "hidden", "important");
        else host.style.removeProperty("visibility");
        return true;
      },
      findCandidates: findCandidates,
      ack: function (requestId) {
        if (!state.pending.has(requestId)) return false;
        state.pending.set(requestId, "delivered");
        state.draft = "";
        clearSelection();
        state.panelOpen = false;
        render();
        setTimeout(function () { state.pending.delete(requestId); render(); }, 2500);
        return true;
      },
      syncJobs: function (jobs) {
        if (!IS_TOP || !Array.isArray(jobs)) return false;
        var allowedStates = new Set([
          "queued", "claimed", "locating", "editing", "verifying", "cancel_requested",
          "applied_verified", "no_change", "cancelled", "review_required", "blocked"
        ]);
        var nextJobs = jobs.slice(0, 100).map(function (job) {
          var stateName = allowedStates.has(job && job.state) ? job.state : "blocked";
          return {
            requestId: truncate(job && job.requestId || "", 160),
            sequence: Number(job && job.sequence || 0),
            state: stateName,
            message: truncate(job && job.message || "", 240),
            cancellable: !!(job && job.cancellable),
            final: !!(job && job.final),
            updatedAt: job && job.updatedAt || null
          };
        }).filter(function (job) { return !!job.requestId; });
        var changed = JSON.stringify(nextJobs) !== JSON.stringify(state.jobs);
        state.jobs = nextJobs;
        state.jobs.forEach(function (job) {
          if ((!job.cancellable || job.state === "cancel_requested" || job.final) && state.cancelPending.delete(job.requestId)) changed = true;
        });
        if (state.jobs.some(function (job) { return !job.final; }) && !state.panelOpen) {
          state.panelOpen = true;
          changed = true;
        }
        if (changed) render();
        return true;
      },
      restore: function (saved) {
        if (!saved || typeof saved !== "object") return false;
        state.draft = typeof saved.draft === "string" ? saved.draft.slice(0, MAX_INSTRUCTION) : state.draft;
        state.panelOpen = !!saved.panelOpen;
        state.multi = !!saved.multi;
        clearSelection();
        (saved.picks || []).forEach(function (pick) {
          if (IS_TOP && pick.frameId) return;
          var locator = (pick.locators || []).find(function (item) { return item.unique && item.selector; });
          var element = null;
          try { element = locator && document.querySelector(locator.selector); } catch (_) { /* stale */ }
          if (!element) return;
          selectElement(element, { exact: true, multi: true, silent: true });
          var entry = selected[selected.length - 1];
          entry.evidence.pickId = pick.pickId || entry.evidence.pickId;
          entry.trail = (pick.scopeTrail || []).map(function (trailPick) {
            var trailLocator = (trailPick.locators || []).find(function (item) { return item.unique && item.selector; });
            var trailElement = null;
            try { trailElement = trailLocator && document.querySelector(trailLocator.selector); } catch (_) { /* stale */ }
            return trailElement ? { element: trailElement, rawElement: trailElement, evidence: makeEvidence(trailElement, { exact: true }) } : null;
          }).filter(Boolean);
          updateRefinementEvidence(entry);
          state.picks[state.picks.length - 1] = entry.evidence;
          if (!IS_TOP) emit("pick", { pick: entry.evidence });
        });
        if (saved.armed) arm({ multi: saved.multi });
        render();
        return true;
      },
      ingestPick: function (pick) {
        if (!IS_TOP || !pick || !pick.pickId) return false;
        var index = state.picks.findIndex(function (item) { return item.pickId === pick.pickId; });
        if (index >= 0) state.picks[index] = pick;
        else state.picks.push(pick);
        state.panelOpen = true;
        render();
        scheduleStateEmit();
        return true;
      },
      updateIngestedPick: function (pickId, pick) {
        if (!IS_TOP || !pickId || !pick) return false;
        var index = state.picks.findIndex(function (item) { return item.pickId === pickId; });
        if (index < 0) return false;
        state.picks[index] = pick;
        render();
        scheduleStateEmit();
        return true;
      },
      removeIngestedPick: function (pickId) {
        if (!IS_TOP || !pickId) return false;
        var index = state.picks.findIndex(function (item) { return item.pickId === pickId; });
        if (index < 0) return false;
        state.picks.splice(index, 1);
        if (!state.picks.length && !visibleJobs().length) state.panelOpen = false;
        render();
        scheduleStateEmit();
        return true;
      },
      applySelectionCommand: function (pickId, command) {
        var stateIndex = state.picks.findIndex(function (pick) { return pick.pickId === pickId; });
        if (stateIndex < 0 || !new Set(["widen", "narrow", "remove"]).has(command)) return { ok: false };
        if (command === "remove") {
          removeSelection(stateIndex);
          return { ok: true, command: command, pickId: pickId, removed: true };
        }
        refineSelection(stateIndex, command);
        var entry = selected.find(function (candidate) { return candidate.evidence.pickId === pickId; });
        return entry ? {
          ok: true,
          command: command,
          pickId: pickId,
          pick: entry.evidence,
          canWiden: entry.evidence.canWiden,
          canNarrow: entry.evidence.canNarrow
        } : { ok: false };
      },
      reacquire: function (pick) {
        if (!pick || typeof pick !== "object") return {
          currentPick: null,
          matchedLocator: null,
          identityEvidence: { accepted: false, tagMatches: false, corroborators: [], strongUniqueLocator: false },
          reacquisitionConfidence: "none"
        };
        var candidates = (pick.locators || []).filter(function (locator) { return locator && locator.selector; });
        var strongestRejection = null;
        for (var index = 0; index < candidates.length; index += 1) {
          var locator = candidates[index];
          var matches = [];
          try {
            matches = document.querySelectorAll(locator.selector);
          } catch (_) { /* try the next locator */ }
          if (matches.length !== 1) continue;
          var element = matches[0];
          var currentName = accessibleName(element);
          var currentRole = inferredRole(element);
          var currentText = truncate((element.textContent || "").trim().replace(/\s+/g, " "), MAX_TEXT) || "";
          var corroborators = [];
          var stableAttributes = [
            ["id", element.id || null, pick.attributes?.id],
            ["data-testid", element.getAttribute("data-testid"), pick.attributes?.dataTestId],
            ["aria-label", element.getAttribute("aria-label"), pick.attributes?.ariaLabel],
            ["name", element.getAttribute("name"), pick.attributes?.name]
          ];
          if (stableAttributes.some(function (entry) { return entry[1] && entry[2] && entry[1] === entry[2]; })) corroborators.push("stable-attribute");
          if ((pick.accessibleName && currentName === pick.accessibleName) || (pick.text && currentText === pick.text)) corroborators.push("name-or-text");
          if (pick.role && currentRole === pick.role) corroborators.push("role");
          var expectedParent = pick.ancestry && pick.ancestry[1];
          var parent = element.parentElement;
          if (expectedParent && parent && expectedParent.tagName === parent.tagName.toLowerCase()
            && ((expectedParent.id && expectedParent.id === parent.id) || (expectedParent.className && expectedParent.className === parent.getAttribute("class")))) {
            corroborators.push("parent-context");
          }
          var tagMatches = !!pick.tagName && element.tagName.toLowerCase() === String(pick.tagName).toLowerCase();
          var strongUniqueLocator = locator.strength === "high" || ["id", "testid", "aria-label"].includes(locator.strategy);
          var positionalLocator = /:nth-(?:child|of-type)\(/.test(locator.selector);
          var hasDistinctiveCorroborator = corroborators.includes("stable-attribute") || corroborators.includes("name-or-text");
          var accepted = tagMatches && (strongUniqueLocator || (corroborators.length >= 2 && hasDistinctiveCorroborator));
          var identityEvidence = {
            accepted: accepted,
            tagMatches: tagMatches,
            strongUniqueLocator: strongUniqueLocator,
            positionalLocator: positionalLocator,
            corroborators: corroborators,
            hasDistinctiveCorroborator: hasDistinctiveCorroborator,
            requiredCorroborators: strongUniqueLocator ? 0 : 2
          };
          if (accepted) {
            return {
              currentPick: makeEvidence(element, { exact: true }),
              matchedLocator: { ...locator, unique: true },
              identityEvidence: identityEvidence,
              reacquisitionConfidence: strongUniqueLocator ? "high" : "medium"
            };
          }
          if (!strongestRejection || corroborators.length > strongestRejection.identityEvidence.corroborators.length) {
            strongestRejection = { matchedLocator: { ...locator, unique: true }, identityEvidence: identityEvidence };
          }
        }
        return {
          currentPick: null,
          matchedLocator: strongestRejection?.matchedLocator || null,
          identityEvidence: strongestRejection?.identityEvidence || {
            accepted: false,
            tagMatches: false,
            strongUniqueLocator: false,
            positionalLocator: false,
            corroborators: [],
            requiredCorroborators: 2
          },
          reacquisitionConfidence: "none"
        };
      },
      pause: function (reason) { state.pausedReason = reason || "host"; disarm(); render(); },
      audit: function () {
        var controls = Array.from(root.querySelectorAll ? root.querySelectorAll("button,textarea") : []);
        var overlayLabels = Array.from(overlays.querySelectorAll(".dp-overlay:not(.dp-hidden)>span")).map(function (label) {
          var rect = label.getBoundingClientRect();
          return { text: label.textContent || "", placement: label.dataset.placement || "above", x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
        });
        return {
          secure: SECURE,
          shadowMode: shadowMode,
          jobs: state.jobs.map(function (job) { return { ...job }; }),
          viewport: viewportBounds(),
          overlayLabels: overlayLabels,
          panelCompact: panel.dataset.compact === "true",
          panelPlacement: panel.dataset.placement || "side",
          captureMode: state.captureMode,
          captureTransitions: state.captureTransitions,
          controls: controls.map(function (control) {
            var rect = control.getBoundingClientRect();
            var cs = getComputedStyle(control);
            return { tagName: control.tagName.toLowerCase(), label: control.getAttribute("aria-label") || control.textContent || control.placeholder || "", disabled: !!control.disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: cs.color, backgroundColor: cs.backgroundColor, cursor: cs.cursor };
          }),
          textareaLabelled: !!(textarea && (textarea.getAttribute("aria-label") || (textarea.id && root.querySelector("label[for=\"" + textarea.id + "\"]")))),
          hostConnected: host.isConnected,
          panelRect: panel.getBoundingClientRect().toJSON ? panel.getBoundingClientRect().toJSON() : { width: panel.getBoundingClientRect().width, height: panel.getBoundingClientRect().height }
        };
      }
    }
  };

  globalThis.__domPicker = api;
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  healthTimer = setInterval(function () {
    if (!host.isConnected) mount();
    if (SECURE && state.bridgeSeenAt && !bridgeConnected() && state.pausedReason !== "bridge") {
      state.pausedReason = "bridge";
      disarm();
    }
  }, 1000);
  if (config.armOnStart && location.origin === ALLOWED_ORIGIN) arm({ multi: false });
  render();
  emit("ready", { version: VERSION, revision: REVISION, mode: SECURE ? "isolated" : "fallback", isTop: IS_TOP, allowedOrigin: ALLOWED_ORIGIN });
  return api;
})();
