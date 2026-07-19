(function installDomPickerV2() {
  "use strict";

  var VERSION = 2;
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
      parent: "부모 요소 선택",
      child: "자식 요소 선택",
      add: "요소 더 선택",
      remove: "선택 해제",
      clear: "모두 해제",
      collapse: "패널 접기",
      hint: "클릭해 선택 · Shift+클릭으로 여러 개 · Esc로 취소",
      fallback: "요소 선택 후 수정 내용은 채팅에 입력하세요"
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
      parent: "Select parent element",
      child: "Select child element",
      add: "Add element",
      remove: "Remove selection",
      clear: "Clear all",
      collapse: "Collapse panel",
      hint: "Click to select · Shift+click for multiple · Esc to cancel",
      fallback: "Select the element, then describe the fix in chat"
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
    ".dp-panel{position:fixed;width:min(420px,calc(100vw - 24px));max-height:min(640px,calc(100vh - 84px));overflow:auto;border:1px solid var(--dp-line);border-radius:16px;background:var(--dp-surface);box-shadow:0 20px 60px rgba(0,0,0,.48);overscroll-behavior:contain}\n" +
    ".dp-panel[data-side=right]{right:12px;bottom:72px}.dp-panel[data-side=left]{left:12px;bottom:12px}.dp-hidden{display:none!important}\n" +
    ".dp-head{display:flex;align-items:center;gap:10px;min-height:52px;padding:10px 14px;border-bottom:1px solid var(--dp-line)}\n" +
    ".dp-title{min-width:0;flex:1;font-weight:750}.dp-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:999px;background:var(--dp-accent2);color:#03251b;font-size:11px;font-weight:800}\n" +
    ".dp-icon-button{width:44px;height:44px;border:0;border-radius:9px;background:transparent;color:var(--dp-dim);cursor:pointer;font:700 16px/1 inherit}.dp-icon-button:hover,.dp-icon-button:focus-visible{background:rgba(255,255,255,.08);color:var(--dp-text);outline:2px solid var(--dp-accent);outline-offset:-2px}\n" +
    ".dp-picks{max-height:220px;overflow:auto}.dp-pick{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:9px;align-items:start;padding:10px 14px;border-bottom:1px solid rgba(148,163,184,.16)}\n" +
    ".dp-number{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dp-accent2);color:#03251b;font-size:11px;font-weight:850}.dp-pick-label{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dp-selector{margin-top:2px;color:var(--dp-dim);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dp-refine{display:flex;gap:2px}\n" +
    ".dp-form{padding:12px 14px}.dp-label{display:block;margin-bottom:6px;color:var(--dp-text);font-size:12px;font-weight:700}.dp-textarea{display:block;width:100%;min-height:84px;resize:vertical;border:1px solid var(--dp-line);border-radius:10px;padding:10px 11px;background:var(--dp-ink);color:var(--dp-text);font:14px/1.45 inherit}.dp-textarea::placeholder{color:#b8c3d7;opacity:1}.dp-textarea:focus{border-color:var(--dp-accent);outline:3px solid rgba(124,131,255,.25)}\n" +
    ".dp-actions{display:flex;gap:8px;margin-top:10px}.dp-button{min-height:44px;border:1px solid var(--dp-line);border-radius:10px;padding:9px 12px;background:transparent;color:var(--dp-text);font:700 13px/1.2 inherit;cursor:pointer}.dp-button:hover,.dp-button:focus-visible{background:rgba(255,255,255,.08);border-color:var(--dp-accent);outline:2px solid var(--dp-accent);outline-offset:1px}.dp-primary{flex:1;border-color:transparent;background:var(--dp-accent);color:white}.dp-primary:hover,.dp-primary:focus-visible{background:#9297ff}.dp-primary:disabled{cursor:not-allowed;background:#3e4862;color:#c4cada}\n" +
    ".dp-status{min-height:34px;padding:7px 14px;border-top:1px solid var(--dp-line);color:var(--dp-dim);font-size:12px}.dp-status[data-kind=ok]{color:#72e9c4}.dp-status[data-kind=error]{color:#ff9caf}\n" +
    ".dp-hint{position:fixed;left:50%;top:max(12px,env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100vw - 24px);padding:9px 14px;border:1px solid var(--dp-accent);border-radius:999px;background:var(--dp-ink);color:var(--dp-text);box-shadow:0 8px 28px rgba(0,0,0,.4);font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n" +
    "@media(max-width:600px){.dp-panel{left:8px!important;right:8px!important;bottom:max(66px,env(safe-area-inset-bottom))!important;width:auto;max-height:min(64vh,var(--dp-visual-height,64vh));border-radius:16px}.dp-launcher{right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom))}.dp-actions{flex-wrap:wrap}.dp-primary{flex-basis:100%;order:-1}.dp-button{flex:1}.dp-hint{top:max(8px,env(safe-area-inset-top));font-size:11px}}\n" +
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

  function selectElement(rawElement, options) {
    if (!rawElement || rawElement.nodeType !== 1 || rawElement === host || host.contains(rawElement)) return null;
    var element = resolveSemanticTarget(rawElement, options && options.exact);
    var existingIndex = selected.findIndex(function (entry) { return entry.element === element; });
    if (existingIndex >= 0) return selected[existingIndex].evidence;
    if (!(options && options.multi)) clearSelection();
    var evidence = makeEvidence(rawElement, options);
    var overlay = createOverlay("");
    selected.push({ element: element, rawElement: rawElement, evidence: evidence, overlay: overlay });
    state.picks.push(evidence);
    state.panelOpen = IS_TOP;
    if (resizeObserver) resizeObserver.observe(element);
    placeOverlay(overlay, element, selected.length + " · " + labelFor(evidence));
    emit("pick", { pick: evidence }, options && options.trustedEvent);
    render();
    scheduleStateEmit();
    if (IS_TOP) requestAnimationFrame(function () { if (textarea) textarea.focus(); });
    return evidence;
  }

  function refineSelection(index, direction) {
    var entry = selected[index];
    if (!entry) return;
    var next = direction === "parent" ? entry.element.parentElement : entry.element.firstElementChild;
    if (!next || next === host || host.contains(next)) return;
    if (resizeObserver) resizeObserver.unobserve(entry.element);
    entry.element = next;
    entry.rawElement = next;
    entry.evidence = makeEvidence(next, { exact: true });
    state.picks[index] = entry.evidence;
    if (resizeObserver) resizeObserver.observe(next);
    render();
    schedulePosition();
    scheduleStateEmit();
  }

  function removeSelection(index) {
    var entry = selected[index];
    if (entry) {
      if (resizeObserver) resizeObserver.unobserve(entry.element);
      entry.overlay.box.remove();
      selected.splice(index, 1);
    }
    state.picks.splice(index, 1);
    if (!state.picks.length) state.panelOpen = false;
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

  function renderLauncher() {
    var latestPending = Array.from(state.pending.values()).pop();
    launcher.dataset.armed = String(state.armed);
    launcher.textContent = latestPending === "delivered"
      ? T.delivered
      : state.armed ? T.armed : state.picks.length ? T.selected(state.picks.length) : T.launcher;
    launcher.setAttribute("aria-label", launcher.textContent);
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

  function renderPanel() {
    panel.replaceChildren();
    panel.classList.toggle("dp-hidden", !IS_TOP || !state.panelOpen || !state.picks.length);
    if (!IS_TOP || !state.picks.length) return;
    var head = document.createElement("div");
    head.className = "dp-head";
    var title = document.createElement("div");
    title.className = "dp-title";
    title.textContent = T.title;
    var count = document.createElement("span");
    count.className = "dp-count";
    count.textContent = String(state.picks.length);
    head.append(title, count, iconButton("—", T.collapse, function () { state.panelOpen = false; render(); }));
    panel.appendChild(head);
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
      controls.append(
        iconButton("↑", T.parent, function () { refineSelection(index, "parent"); }),
        iconButton("↓", T.child, function () { refineSelection(index, "child"); }),
        iconButton("×", T.remove, function () { removeSelection(index); })
      );
      row.append(number, body, controls);
      list.appendChild(row);
    });
    panel.appendChild(list);
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
    if (event.key === "Escape" && state.armed) {
      event.preventDefault();
      event.stopImmediatePropagation();
      disarm();
    }
  }

  launcher.addEventListener("click", function (event) {
    event.stopPropagation();
    if (state.picks.length && !state.armed) {
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
        state.bridgeSeenAt = Date.now();
        if (state.pausedReason === "bridge") state.pausedReason = "";
        render();
        return true;
      },
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
      restore: function (saved) {
        if (!saved || typeof saved !== "object") return false;
        state.draft = typeof saved.draft === "string" ? saved.draft.slice(0, MAX_INSTRUCTION) : state.draft;
        state.panelOpen = !!saved.panelOpen;
        state.multi = !!saved.multi;
        clearSelection();
        (saved.picks || []).forEach(function (pick) {
          var locator = (pick.locators || []).find(function (item) { return item.unique && item.selector; });
          var element = null;
          try { element = locator && document.querySelector(locator.selector); } catch (_) { /* stale */ }
          if (element) selectElement(element, { exact: true, multi: true });
        });
        if (saved.armed) arm({ multi: saved.multi });
        render();
        return true;
      },
      ingestPick: function (pick) {
        if (!IS_TOP || !pick || !pick.pickId) return false;
        if (!state.picks.some(function (item) { return item.pickId === pick.pickId; })) state.picks.push(pick);
        state.panelOpen = true;
        render();
        return true;
      },
      reacquire: function (pick) {
        if (!pick || typeof pick !== "object") return null;
        var element = null;
        var candidates = (pick.locators || []).filter(function (locator) { return locator && locator.selector; });
        for (var index = 0; index < candidates.length && !element; index += 1) {
          try {
            var matches = document.querySelectorAll(candidates[index].selector);
            if (matches.length === 1) element = matches[0];
          } catch (_) { /* try the next locator */ }
        }
        return element ? makeEvidence(element, { exact: true }) : null;
      },
      pause: function (reason) { state.pausedReason = reason || "host"; disarm(); render(); },
      audit: function () {
        var controls = Array.from(root.querySelectorAll ? root.querySelectorAll("button,textarea") : []);
        return {
          secure: SECURE,
          shadowMode: shadowMode,
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
    if (SECURE && state.bridgeSeenAt && !bridgeConnected()) {
      state.pausedReason = "bridge";
      disarm();
    }
  }, 1000);
  if (config.armOnStart && location.origin === ALLOWED_ORIGIN) arm({ multi: false });
  render();
  emit("ready", { version: VERSION, mode: SECURE ? "isolated" : "fallback", isTop: IS_TOP, allowedOrigin: ALLOWED_ORIGIN });
  return api;
})();
