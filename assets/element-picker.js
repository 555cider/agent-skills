(function () {
  if (window.__s2p && window.__s2p.__installed) return window.__s2p;

  var STYLE_KEYS = [
    "display", "position", "boxSizing",
    "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
    "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
    "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "flexDirection", "flexWrap", "justifyContent", "alignItems", "gap",
    "gridTemplateColumns", "gridTemplateRows",
    "color", "backgroundColor", "opacity",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign",
    "border", "borderRadius", "boxShadow", "overflow", "zIndex"
  ];
  var MAX_HTML = 4000;
  var LEAF = { SVG: 1, PATH: 1, USE: 1, IMG: 1, I: 1, SPAN: 1, EM: 1, B: 1, STRONG: 1, SMALL: 1, LABEL: 1 };
  var Z = 2147483646;
  var C = {
    ink: "#0b1220", surface: "#111a2e", line: "rgba(148,163,184,.28)",
    text: "#e5edff", dim: "#94a3b8",
    pick: "#6366f1", pickSoft: "rgba(99,102,241,.14)",
    sel: "#10b981", selSoft: "rgba(16,185,129,.14)",
    danger: "#f43f5e"
  };
  var MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  var SANS = "system-ui,-apple-system,Segoe UI,Roboto,sans-serif";

  // UI text follows the browser language: Korean for `ko*`, English otherwise.
  var I18N = {
    ko: {
      armAria: "요소 선택 중", armLabel: "선택 중… Esc로 취소",
      pickedAria: function (n) { return n + "개 선택됨, 더 선택"; },
      pickedLabel: function (n) { return n + "개 선택됨"; },
      startAria: "요소 선택 시작 (Alt+Shift+S)", startLabel: "요소 선택 · Alt+Shift+S",
      panelTitle: function (n) { return "선택한 요소 " + n + "개"; },
      resolvedNote: function (leaf, kind) { return leaf + " 아이콘을 감싼 " + kind + "으로 인식"; },
      removeAria: function (i) { return i + "번 선택 해제"; },
      placeholder: "이 요소를 어떻게 고칠까요?  (예: 색을 초록으로)",
      send: "보내기  (⌘/Ctrl+Enter)", addMore: "＋ 더 선택", clearAll: "모두 해제",
      needPick: "⚠ 먼저 요소를 선택하세요", needText: "⚠ 수정 내용을 입력하세요",
      sent: function (n) { return "✓ 대기열에 추가됨 (" + n + ") — 에이전트가 곧 가져갑니다"; },
      hintMulti: "요소를 클릭해 계속 담기 · Esc로 끝내기",
      hintSingle: "요소 위에 올려 클릭 · Esc로 취소",
      shortcuts: "⌨ 단축키: Alt+Shift+S(선택) · Esc(취소) · Ctrl+Enter(전송)",
      queueTitle: function (n) { return "대기열 " + n + "개"; },
      removeQueueAria: function (i) { return i + "번 대기열 삭제"; }
    },
    en: {
      armAria: "Selecting element", armLabel: "Selecting… Esc to cancel",
      pickedAria: function (n) { return n + " selected, pick more"; },
      pickedLabel: function (n) { return n + " selected"; },
      startAria: "Start selecting element (Alt+Shift+S)", startLabel: "Select element · Alt+Shift+S",
      panelTitle: function (n) { return n + " selected element" + (n === 1 ? "" : "s"); },
      resolvedNote: function (leaf, kind) { return "resolved to the " + kind + " wrapping the " + leaf + " icon"; },
      removeAria: function (i) { return "Deselect " + i; },
      placeholder: "How should this element be fixed?  (e.g. make it green)",
      send: "Send  (⌘/Ctrl+Enter)", addMore: "＋ Pick more", clearAll: "Clear all",
      needPick: "⚠ Select an element first", needText: "⚠ Enter what to fix",
      sent: function (n) { return "✓ Queued (" + n + ") — the agent will pick it up"; },
      hintMulti: "Click elements to keep adding · Esc to finish",
      hintSingle: "Hover and click an element · Esc to cancel",
      shortcuts: "⌨ Shortcuts: Alt+Shift+S(Pick) · Esc(Cancel) · Ctrl+Enter(Send)",
      queueTitle: function (n) { return "Queue (" + n + ")"; },
      removeQueueAria: function (i) { return "Remove queue item " + i; }
    }
  };
  var T = ((navigator.language || "en").toLowerCase().indexOf("ko") === 0) ? I18N.ko : I18N.en;

  function trunc(s, n) { if (s == null) return null; s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    s = String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
    // A leading digit (optionally after a hyphen) is invalid in a CSS identifier;
    // escape it as \3N , mirroring CSS.escape for the no-native fallback path.
    return s.replace(/^(-?)([0-9])/, function (_, dash, d) { return dash + "\\3" + d + " "; });
  }
  // Escape a value for use inside a double-quoted attribute selector.
  function attrEscape(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  // ---------- reload-survival state (per-origin sessionStorage) ------------
  // The picker is re-injected fresh on every reload, resetting _seq (which the
  // CDP `wait` bridge treats as monotonic) and discarding the user's draft and
  // selections. Persist just enough to restore continuity across a HARD reload
  // of the same origin. All access is guarded: sessionStorage throws in
  // sandboxed iframes / storage-disabled contexts. Not persisted: the transient
  // `request`/`_sentMsg`. Cross-origin navigation still loses this (per-origin).
  var STATE_KEY = "__s2p_state_v1";
  function saveState() {
    try {
      window.sessionStorage.setItem(STATE_KEY, JSON.stringify({
        seq: api._seq,
        draft: api._draft,
        picks: api.picks.map(function (p) { return p.selector; }).filter(Boolean)
      }));
    } catch (e) { /* storage unavailable — continuity is best-effort */ }
  }
  function loadState() {
    try {
      var raw = window.sessionStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function resolveTarget(el) {
    if (!el || el.nodeType !== 1) return el;
    var node = el, hops = 0;
    while (node && node.nodeType === 1 && hops < 5) {
      var tag = node.tagName;
      if (node.getAttribute && (node.getAttribute("data-testid") || node.getAttribute("id"))) return node;
      if (tag === "BUTTON" || tag === "A") return node;
      if (node.getAttribute && (node.getAttribute("role") || node.getAttribute("aria-label"))) return node;
      var own = (node.textContent || "").trim();
      if (!LEAF[tag] && own) return node;
      node = node.parentElement; hops++;
    }
    return el;
  }

  // True when `sel` resolves to exactly `el` and nothing else — a selector we
  // can safely hand downstream as a unique locator.
  function isUnique(sel, el) {
    try {
      var hits = document.querySelectorAll(sel);
      return hits.length === 1 && hits[0] === el;
    } catch (e) { return false; }
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      var idSel = "#" + cssEscape(el.id);
      if (isUnique(idSel, el)) return idSel;
    }
    var testid = el.getAttribute && el.getAttribute("data-testid");
    if (testid) {
      var tidSel = "[data-testid=\"" + attrEscape(testid) + "\"]";
      // Only trust the testid selector when it uniquely locates this element;
      // otherwise fall through to a structural path (several nodes can share a
      // testid, and the value may need escaping).
      if (isUnique(tidSel, el)) return tidSel;
    }
    var parts = [], node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + "#" + cssEscape(node.id)); break; }
      var parent = node.parentElement;
      if (parent) {
        var same = [], kids = parent.children;
        for (var i = 0; i < kids.length; i++) if (kids[i].tagName === node.tagName) same.push(kids[i]);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part); node = parent;
      if (parts.length > 6) break;
    }
    return parts.join(" > ");
  }

  function collectStyle(el) {
    var cs = window.getComputedStyle(el), out = {};
    for (var i = 0; i < STYLE_KEYS.length; i++) {
      var k = STYLE_KEYS[i];
      var v = cs.getPropertyValue(k.replace(/[A-Z]/g, function (m) { return "-" + m.toLowerCase(); }));
      if (v) out[k] = v;
    }
    return out;
  }

  function nearbyText(el) {
    var out = [], seen = {};
    function push(node) {
      if (!node) return;
      var t = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (t && t.length <= 120 && !seen[t]) { seen[t] = 1; out.push(t); }
    }
    if (el.previousElementSibling) push(el.previousElementSibling);
    if (el.nextElementSibling) push(el.nextElementSibling);
    var p = el.parentElement;
    if (p) { var h = p.querySelector && p.querySelector("h1,h2,h3,h4,label,legend,[role=heading]"); if (h) push(h); }
    return out.slice(0, 8);
  }

  // Human-readable descriptor: what the element *is*.
  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var al = el.getAttribute && el.getAttribute("aria-label");
    var testid = el.getAttribute && el.getAttribute("data-testid");
    var txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    var detail = al || testid || (el.id ? "#" + el.id : "") || txt;
    return { tag: tag, detail: detail ? trunc(detail, 36) : "" };
  }

  function makePayload(rawEl) {
    var el = resolveTarget(rawEl);
    var r = el.getBoundingClientRect();
    var d = describe(el);
    return {
      selector: buildSelector(el), tagName: el.tagName.toLowerCase(),
      id: el.id || null, className: (el.getAttribute && el.getAttribute("class")) || null,
      ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || null,
      name: (el.getAttribute && el.getAttribute("name")) || null,
      text: trunc((el.textContent || "").trim().replace(/\s+/g, " "), 300),
      outerHTML: trunc(el.outerHTML, MAX_HTML),
      parentHTML: el.parentElement ? trunc(el.parentElement.outerHTML, MAX_HTML) : null,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      computedStyle: collectStyle(el), nearbyText: nearbyText(el),
      resolvedFromLeaf: el !== rawEl ? rawEl.tagName.toLowerCase() : null,
      kind: d.tag, detail: d.detail, label: d.tag + (d.detail ? " · " + d.detail : ""),
      _el: el
    };
  }

  function snapshot(target) {
    var el = target;
    if (typeof target === "string") el = document.querySelector(target);
    if (!el || el.nodeType !== 1) return null;
    var p = makePayload(el), marked = p._el; delete p._el;
    // Ignore a repeat pick of an element already selected.
    for (var i = 0; i < selBoxes.length; i++) {
      if (selBoxes[i].__el === marked) { api.lastPick = api.picks[i] || p; return api.picks[i] || null; }
    }
    api.picks.push(p); api.lastPick = p; api._sentMsg = "";
    addBox(marked); renderAll();
    saveState();
    return p;
  }

  // ---------- element factory (every picker node is tagged data-s2p) ----------
  function mk(tag, css, parent) {
    var d = document.createElement(tag || "div");
    d.setAttribute("data-s2p", "1");
    if (css) d.style.cssText = css;
    (parent || document.documentElement).appendChild(d);
    return d;
  }
  function isOwn(el) { return !!(el && el.closest && el.closest("[data-s2p]")); }
  function place(box, el) {
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
  }

  var hoverBox = null, hoverChip = null, selBoxes = [], panel = null, hint = null;

  // Signature: a devtools-style inspector chip trailing the hovered element.
  function hover(el) {
    if (!hoverBox) {
      hoverBox = mk("div", "position:fixed;z-index:" + Z + ";pointer-events:none;border:1.5px solid " + C.pick + ";background:" + C.pickSoft + ";border-radius:3px;transition:all .05s ease-out;");
      hoverChip = mk("div", "position:fixed;z-index:" + (Z + 1) + ";pointer-events:none;font:600 11px/1.5 " + MONO + ";color:" + C.text + ";background:" + C.ink + ";border:1px solid " + C.line + ";border-left:2px solid " + C.pick + ";padding:2px 7px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.35);");
    }
    if (!el) { hoverBox.style.display = "none"; hoverChip.style.display = "none"; return; }
    hoverBox.style.display = "block"; place(hoverBox, el);
    var r = el.getBoundingClientRect(), d = describe(el);
    hoverChip.style.display = "block";
    hoverChip.textContent = d.tag + (d.detail ? " · " + d.detail : "") + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    var top = r.top - 24; if (top < 4) top = r.top + 4;
    hoverChip.style.left = Math.max(4, r.left) + "px";
    hoverChip.style.top = top + "px";
  }

  function addBox(el) {
    var box = mk("div", "position:fixed;z-index:" + Z + ";pointer-events:none;border:1.5px solid " + C.sel + ";background:" + C.selSoft + ";border-radius:3px;");
    place(box, el);
    var badge = mk("div", "position:absolute;left:-1px;top:-19px;font:700 10px/16px " + SANS + ";color:#04231a;background:" + C.sel + ";padding:1px 6px;border-radius:4px 4px 0 0;white-space:nowrap;", box);
    box.__el = el; box.__badge = badge; selBoxes.push(box);
    renumber();
  }
  function renumber() {
    for (var i = 0; i < selBoxes.length; i++) {
      var p = api.picks[i]; if (!p) continue;
      selBoxes[i].__badge.textContent = (selBoxes.length > 1 ? (i + 1) + " · " : "") + p.label;
    }
  }
  function reposition() {
    for (var i = 0; i < selBoxes.length; i++) if (selBoxes[i].__el) place(selBoxes[i], selBoxes[i].__el);
  }
  function removeAt(i) {
    if (!selBoxes[i]) return;
    selBoxes[i].remove(); selBoxes.splice(i, 1); api.picks.splice(i, 1);
    api.lastPick = api.picks[api.picks.length - 1] || null;
    renumber(); renderAll(); saveState();
  }

  // ---------- launcher ----------
  var btn = mk("button", "");
  btn.type = "button";
  function renderLauncher() {
    var n = api.picks.length, base = "position:fixed;right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom));z-index:" + (Z + 2) + ";display:inline-flex;align-items:center;gap:7px;box-sizing:border-box;min-height:44px;max-width:calc(100vw - 16px);font:600 12px/1 " + SANS + ";color:" + C.text + ";background:" + C.ink + ";border:1px solid " + C.line + ";padding:9px 13px;border-radius:9px;box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer;";
    btn.replaceChildren();
    if (api.active) { btn.setAttribute("aria-label", T.armAria); btn.append(dot(C.pick, true), txt(T.armLabel)); btn.style.cssText = base + "border-color:" + C.pick + ";box-shadow:0 0 0 3px " + C.pickSoft + ",0 6px 20px rgba(0,0,0,.35);"; }
    else if (n) { btn.setAttribute("aria-label", T.pickedAria(n)); btn.append(dot(C.sel), txt(T.pickedLabel(n)), countChip(String(n))); btn.style.cssText = base; }
    else { btn.setAttribute("aria-label", T.startAria); btn.append(dot(C.pick), txt(T.startLabel)); btn.style.cssText = base; }
  }
  function dot(color, pulse) {
    var d = document.createElement("span");
    d.style.cssText = "width:8px;height:8px;border-radius:50%;background:" + color + ";flex:none;" + (pulse ? "animation:s2pPulse 1.4s infinite;" : "");
    return d;
  }
  function txt(s) { var e = document.createElement("span"); e.textContent = s; return e; }
  function countChip(s) {
    var e = document.createElement("span");
    e.textContent = s;
    e.style.cssText = "min-width:16px;text-align:center;font:700 10px/16px " + SANS + ";color:#04231a;background:" + C.sel + ";border-radius:8px;padding:0 5px;";
    return e;
  }

  // ---------- selection panel (list of picks) ----------
  function renderPanel() {
    if (!panel) panel = mk("div", "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:" + (Z + 2) + ";box-sizing:border-box;width:min(400px,calc(100vw - 16px));max-height:calc(100vh - 80px);font:" + SANS + ";color:" + C.text + ";background:" + C.surface + ";border:1px solid " + C.line + ";border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:auto;overscroll-behavior:contain;");
    if (!api.picks.length && !api.queue.length) {
      panel.innerHTML = ""; panel.style.display = "none"; hideTip(); return;
    }
    panel.style.display = "block"; panel.innerHTML = ""; hideTip();

    if (api.picks.length > 0) {
      var head = mk("div", "display:flex;align-items:center;gap:8px;min-height:46px;padding:0 13px;border-bottom:1px solid " + C.line + ";", panel);
      head.appendChild(dot(C.sel));
      var htitle = mk("div", "font:600 12px/1.3 " + SANS + ";color:" + C.text + ";", head);
      htitle.textContent = T.panelTitle(api.picks.length);

      var list = mk("div", "max-height:150px;overflow:auto;", panel);
      api.picks.forEach(function (p, i) {
        var row = mk("div", "display:flex;align-items:flex-start;gap:9px;padding:8px 13px;" + (i ? "border-top:1px solid rgba(148,163,184,.14);" : ""), list);
        var num = mk("div", "flex:none;width:18px;height:18px;margin-top:1px;text-align:center;font:700 10px/18px " + SANS + ";color:#04231a;background:" + C.sel + ";border-radius:6px;", row);
        num.textContent = String(i + 1);
        var body = mk("div", "min-width:0;flex:1;", row);
        var kind = mk("div", "font:600 12.5px/1.35 " + SANS + ";color:" + C.text + ";", body);
        kind.textContent = p.label;
        var sel = mk("div", "margin-top:1px;font:11px/1.4 " + MONO + ";color:" + C.dim + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:help;", body);
        sel.textContent = p.selector || "";
        bindTip(sel, p.selector || "");
        if (p.resolvedFromLeaf) {
          var note = mk("div", "margin-top:1px;font:10.5px/1.3 " + SANS + ";color:" + C.dim + ";", body);
          note.textContent = T.resolvedNote(p.resolvedFromLeaf, p.kind);
        }
        var x = mk("button", "flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;font:600 11px/1 " + SANS + ";color:" + C.dim + ";background:transparent;border:0;padding:0;border-radius:6px;cursor:pointer;", row);
        x.type = "button"; x.textContent = "✕"; x.setAttribute("aria-label", T.removeAria(i + 1));
        x.addEventListener("mouseenter", function () { x.style.color = C.danger; });
        x.addEventListener("mouseleave", function () { x.style.color = C.dim; });
        x.addEventListener("click", function (e) { e.stopPropagation(); removeAt(i); });
      });

      var form = mk("div", "padding:9px 13px;border-top:1px solid " + C.line + ";", panel);
      if (api._sentMsg) {
        var msg = mk("div", "margin-bottom:6px;font:600 11px/1.4 " + SANS + ";color:" + (api._sentMsg.charAt(0) === "✓" ? C.sel : C.danger) + ";", form);
        msg.textContent = api._sentMsg;
      }
      var ta = mk("textarea", "width:100%;box-sizing:border-box;resize:none;height:46px;font:12px/1.4 " + SANS + ";color:" + C.text + ";background:" + C.ink + ";border:1px solid " + C.line + ";border-radius:8px;padding:7px 9px;outline:none;", form);
      ta.placeholder = T.placeholder;
      ta.value = api._draft || "";
      ta.addEventListener("input", function () { api._draft = ta.value; api._sentMsg = ""; saveState(); });
      ta.addEventListener("keydown", function (e) { e.stopPropagation(); if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitRequest(); });
      var sendWrap = mk("div", "margin-top:7px;", form);
      sendWrap.appendChild(primaryBtn(T.send, submitRequest));

      var foot = mk("div", "display:flex;gap:8px;padding:9px 13px 12px;border-bottom:1px solid " + C.line + ";", panel);
      foot.appendChild(action(T.addMore, C.pick, function () { api.enable(); }));
      foot.appendChild(action(T.clearAll, C.danger, function () { api.clear(); }));
    } else {
      var noPick = mk("div", "padding:16px 13px;text-align:center;font:600 11.5px/1.4 " + SANS + ";color:" + (api._sentMsg ? C.sel : C.dim) + ";border-bottom:1px solid " + C.line + ";", panel);
      noPick.textContent = api._sentMsg || T.needPick;
      var pickBtn = mk("div", "padding:9px 13px;border-bottom:1px solid " + C.line + ";", panel);
      pickBtn.appendChild(primaryBtn(T.addMore, function () { api.enable(); }));
    }
    if (api.queue.length > 0) {
      var qhead = mk("div", "display:flex;align-items:center;justify-content:space-between;min-height:36px;padding:0 13px;background:rgba(255,255,255,.02);border-bottom:1px solid " + C.line + ";", panel);
      var qtitle = mk("div", "font:600 11.5px/1.3 " + SANS + ";color:" + C.text + ";", qhead);
      qtitle.textContent = T.queueTitle(api.queue.length);

      var qlist = mk("div", "max-height:120px;overflow:auto;", panel);
      api.queue.forEach(function (q, idx) {
        var qrow = mk("div", "display:flex;align-items:flex-start;gap:9px;padding:7px 13px;" + (idx ? "border-top:1px solid rgba(148,163,184,.1);" : ""), qlist);

        var qnum = mk("div", "flex:none;width:16px;height:16px;margin-top:1.5px;text-align:center;font:700 9px/16px " + SANS + ";color:" + C.dim + ";background:rgba(148,163,184,.14);border-radius:4px;", qrow);
        qnum.textContent = String(idx + 1);

        var qbody = mk("div", "min-width:0;flex:1;", qrow);
        var qtext = mk("div", "font:600 12px/1.35 " + SANS + ";color:" + C.text + ";word-break:break-all;", qbody);
        qtext.textContent = q.text;

        var qinfo = mk("div", "margin-top:1px;font:10px/1.3 " + SANS + ";color:" + C.dim + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", qbody);
        var labels = q.picks.map(function (p) { return p.label; }).join(", ");
        qinfo.textContent = labels;
        bindTip(qinfo, labels);

        var qx = mk("button", "flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;font:600 11px/1 " + SANS + ";color:" + C.dim + ";background:transparent;border:0;padding:0;border-radius:4px;cursor:pointer;", qrow);
        qx.type = "button"; qx.textContent = "✕"; qx.setAttribute("aria-label", T.removeQueueAria(idx + 1));
        qx.addEventListener("mouseenter", function () { qx.style.color = C.danger; });
        qx.addEventListener("mouseleave", function () { qx.style.color = C.dim; });
        qx.addEventListener("click", function (e) { e.stopPropagation(); removeQueueAt(idx); });
      });
    }

    var kbInfo = mk("div", "padding:6px 13px 8px;text-align:center;font:10px/1.3 " + SANS + ";color:" + C.dim + ";background:rgba(0,0,0,.15);border-top:1px solid " + C.line + ";", panel);
    kbInfo.textContent = T.shortcuts;
  }
  function action(labelText, color, fn) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = labelText;
    b.style.cssText = "flex:1;min-width:0;min-height:44px;font:600 12px/1 " + SANS + ";color:" + C.text + ";background:transparent;border:1px solid " + color + ";border-radius:8px;padding:8px;cursor:pointer;transition:background .1s;";
    b.addEventListener("mouseenter", function () { b.style.background = "rgba(255,255,255,.06)"; });
    b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
    return b;
  }
  function primaryBtn(labelText, fn) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = labelText;
    b.style.cssText = "width:100%;min-height:44px;box-sizing:border-box;font:700 12px/1 " + SANS + ";color:#fff;background:" + C.pick + ";border:0;border-radius:8px;padding:9px;cursor:pointer;";
    b.addEventListener("click", function (e) { e.stopPropagation(); fn(); });
    return b;
  }
  function removeQueueAt(i) {
    if (!api.queue[i]) return;
    api.queue.splice(i, 1);
    api.request = api.queue[api.queue.length - 1] || null;
    renderAll();
  }
  // Atomically return a FIFO snapshot and reset every queue-facing UI alias.
  // Hosts should prefer this over mutating `queue` directly so stale queue rows
  // and success messages cannot survive a drain.
  function drainQueue() {
    var drained = api.queue.slice();
    api.queue = [];
    api.request = null;
    api._sentMsg = "";
    renderAll();
    return drained;
  }
  // The one bridge browser → agent: enqueue the fix request; a CDP watcher drains it.
  // A durable queue (not a single slot) so rapid submissions and ones sent while the
  // agent is busy are never overwritten — each Send snapshots its own picks.
  function submitRequest() {
    var text = (api._draft || "").trim();
    if (!api.picks.length) { api._sentMsg = T.needPick; renderPanel(); return; }
    if (!text) { api._sentMsg = T.needText; renderPanel(); return; }
    var req = {
      text: text, seq: ++api._seq,
      picks: api.picks.map(function (p) { return { selector: p.selector, label: p.label, tagName: p.tagName }; })
    };
    api.queue.push(req);
    api.request = req; // back-compat: latest enqueued request

    // Clear selection after successfully queueing
    api.lastPick = null;
    api.picks = [];
    for (var i = 0; i < selBoxes.length; i++) selBoxes[i].remove();
    selBoxes = [];

    api._draft = "";
    api._sentMsg = T.sent(api.queue.length);
    renderAll();
    saveState(); // persist the bumped _seq so a reload cannot rewind the bridge counter
  }

  function showHint(on) {
    if (!hint) hint = mk("div", "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:" + (Z + 2) + ";font:600 12px/1 " + SANS + ";color:" + C.text + ";background:" + C.ink + ";border:1px solid " + C.pick + ";padding:8px 13px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.35);");
    hint.textContent = api.multi ? T.hintMulti : T.hintSingle;
    hint.style.display = on ? "block" : "none";
  }

  // Full-selector tooltip: hover a truncated selector to read all of it.
  var tip = null;
  function showTip(text, anchor) {
    if (!text) return;
    if (!tip) tip = mk("div", "position:fixed;z-index:" + (Z + 3) + ";pointer-events:none;max-width:360px;font:11px/1.5 " + MONO + ";color:" + C.text + ";background:" + C.ink + ";border:1px solid " + C.line + ";padding:6px 9px;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.45);word-break:break-all;white-space:normal;");
    tip.textContent = text; tip.style.display = "block";
    var r = anchor.getBoundingClientRect();
    tip.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 372)) + "px";
    var top = r.top - tip.offsetHeight - 6;
    tip.style.top = (top < 6 ? r.bottom + 6 : top) + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; }
  function bindTip(node, text) {
    node.addEventListener("mouseenter", function () { showTip(text, node); });
    node.addEventListener("mouseleave", hideTip);
  }

  function renderAll() { renumber(); renderPanel(); renderLauncher(); }

  // ---------- events / api ----------
  function onMove(e) {
    if (!api.active) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !isOwn(el)) hover(resolveTarget(el)); else hover(null);
  }
  function onClick(e) {
    if (!api.active) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (isOwn(el)) return;
    e.preventDefault(); e.stopPropagation();
    snapshot(el);
    if (!api.multi) api.disable();
  }

  var api = {
    __installed: true, active: false, multi: false, lastPick: null, picks: [],
    _seq: 0, _draft: "", _sentMsg: "", request: null, queue: [],
    snapshot: snapshot,
    drainQueue: drainQueue,
    enable: function (opts) {
      api.multi = !!(opts && opts.multi); api.active = true; api._sentMsg = "";
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      window.addEventListener("scroll", reposition, true);
      window.addEventListener("resize", reposition, true);
      showHint(true); renderPanel(); renderLauncher();
    },
    disable: function () {
      api.active = false; hover(null); showHint(false);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition, true);
      renderLauncher();
    },
    clear: function () {
      api.lastPick = null; api.picks = [];
      api._draft = ""; api._sentMsg = "";
      for (var i = 0; i < selBoxes.length; i++) selBoxes[i].remove();
      selBoxes = [];
      renderPanel(); renderLauncher(); saveState();
    },
    toggle: function () { api.active ? api.disable() : api.enable(); },
    // Full teardown: leave the page exactly as it was before injection.
    destroy: function () {
      api.disable();
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("DOMContentLoaded", mount);
      document.removeEventListener("DOMContentLoaded", restoreState);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition, true);
      var nodes = document.querySelectorAll("[data-s2p]");
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      selBoxes = []; hoverBox = hoverChip = panel = hint = tip = null;
      api.active = false; api.picks = []; api.lastPick = null; api.request = null; api.queue = [];
      try { window.sessionStorage.removeItem(STATE_KEY); } catch (e) { /* storage unavailable */ }
      try { delete window.__s2p; } catch (e) { window.__s2p = undefined; }
    }
  };

  var st = mk("style", "");
  st.textContent = "@keyframes s2pPulse{0%{box-shadow:0 0 0 0 " + C.pick + "80}70%{box-shadow:0 0 0 6px " + C.pick + "00}100%{box-shadow:0 0 0 0 " + C.pick + "00}}@media (prefers-reduced-motion:reduce){[data-s2p]{animation:none!important}}";
  btn.addEventListener("click", function (e) { e.stopPropagation(); api.toggle(); });
  // Alt+Shift+S toggles picking so the user never has to mouse over to the launcher;
  // Esc leaves picking. `code === "KeyS"` is layout-independent (works on non-QWERTY).
  function onKeydown(e) {
    if (e.altKey && e.shiftKey && (e.code === "KeyS" || e.key === "S" || e.key === "s")) {
      e.preventDefault(); e.stopPropagation(); api.toggle(); return;
    }
    // Only intercept Escape while actively picking, so we don't swallow the host
    // page's own Escape handling (closing its modals/menus) the rest of the time.
    if (e.key === "Escape" && api.active) { e.preventDefault(); e.stopPropagation(); api.disable(); }
  }
  document.addEventListener("keydown", onKeydown);

  function mount() { if (document.body && !document.body.contains(btn)) { document.body.appendChild(btn); renderLauncher(); } }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);

  // Restore continuity after a hard reload of the same origin (best-effort).
  function restoreState() {
    var saved = loadState();
    if (!saved) return;
    if (typeof saved.seq === "number") api._seq = saved.seq;
    if (typeof saved.draft === "string") api._draft = saved.draft;
    if (saved.picks && saved.picks.length) {
      saved.picks.forEach(function (selstr) {
        // Re-resolve each stored selector; silently drop any that no longer
        // uniquely resolve (the page may have changed).
        try { if (selstr && document.querySelector(selstr)) snapshot(selstr); } catch (e) { /* drop */ }
      });
    }
    renderAll();
  }
  if (document.body) restoreState(); else document.addEventListener("DOMContentLoaded", restoreState);

  window.__s2p = api;
  return api;
})();
