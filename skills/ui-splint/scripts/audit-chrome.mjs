#!/usr/bin/env node
/*
 * ui-splint runner — ZERO-DEPENDENCY path. Drives an already-installed Chrome/Chromium
 * directly over the DevTools Protocol (CDP) using Node's built-in WebSocket (Node >= 22).
 * No pip, no npm install. Use this when Playwright isn't set up (the common case).
 *
 * It injects scripts/audit.js (the deterministic detector) into every render state across a
 * route x viewport x theme x state matrix, measures defects, and writes findings.json +
 * coverage.json. Screenshots are viewport-clipped evidence, never the source of truth.
 *
 *   node audit-chrome.mjs http://localhost:3000 \
 *       [--config audit-config.json] [--out-dir .ui-splint] [--routes /,/login] [--no-screenshots]
 *
 * Chrome binary: $CHROME, else google-chrome / chromium / chrome / Edge are auto-detected.
 * Exit code: non-zero if any un-baselined Fail is found (so it can gate completion).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

if (typeof WebSocket === 'undefined') {
  console.error('ui-splint audit-chrome.mjs requires Node >= 22 (built-in WebSocket). Detected ' + process.version +
    '. Upgrade Node, or use the Playwright runner: python3 run-ui-splint.py');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_JS = readFileSync(join(HERE, 'audit.js'), 'utf8');
const KEYBOARD_PROBE_JS = readFileSync(join(HERE, 'keyboard-probe.js'), 'utf8');
const INIT = AUDIT_JS + '\n' + KEYBOARD_PROBE_JS + '\n;try{window.__uiSplintInstallCLS&&window.__uiSplintInstallCLS();}catch(e){}\n';

// ---------- args ----------
const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('-')) {
  console.error('usage: node audit-chrome.mjs <base_url> [--config f] [--out-dir d] [--routes /,/a] [--no-screenshots] [--allow-no-sandbox]');
  process.exit(2);
}
const baseUrl = argv[0].replace(/\/$/, '');
const opt = (name, def) => { const i = argv.indexOf(name); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def; };
const DEFAULT_CONFIG = join(HERE, 'audit-config.default.json');
const configPath = opt('--config', DEFAULT_CONFIG);
const outDir = opt('--out-dir', '.ui-splint');
const noShots = argv.includes('--no-screenshots');
const routesOverride = opt('--routes', null);
const allowNoSandbox = argv.includes('--allow-no-sandbox');
if (typeof process.getuid === 'function' && process.getuid() === 0 && !allowNoSandbox) {
  console.error('Chrome sandbox cannot run as root. Re-run as an unprivileged user, or explicitly pass --allow-no-sandbox after reviewing the risk.');
  process.exit(2);
}
if (allowNoSandbox) console.error('WARNING: Chrome sandbox disabled by explicit --allow-no-sandbox. Audit only trusted local pages.');

// A user who explicitly passes --config must not silently fall back to defaults on a typo'd path.
if (argv.includes('--config') && !existsSync(configPath)) {
  console.error(`--config file not found: ${configPath}`);
  process.exit(2);
}

const defCfg = JSON.parse(readFileSync(DEFAULT_CONFIG, 'utf8'));
const userCfg = existsSync(configPath) && configPath !== DEFAULT_CONFIG
  ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const cfg = { ...defCfg, ...userCfg };
const routes = routesOverride ? routesOverride.split(',') : cfg.routes || ['/'];
const viewports = cfg.viewports || [{ name: 'mobile', width: 390, height: 844, isMobile: true, dpr: 3 },
                                    { name: 'desktop', width: 1280, height: 900, isMobile: false, dpr: 1 }];
const themes = cfg.themes || ['light', 'dark'];
const states = cfg.states || ['default'];
const scrollPositions = cfg.scrollPositions || ['top', 'bottom'];
const auditCfg = cfg.auditConfig || {};
const baseline = cfg.baseline || [];
const themeInitScripts = cfg.themeInitScripts || {};
const stateSetups = cfg.stateSetups || {};
const keyboardCfg = cfg.keyboardProbe || {};
const settleMs = Number(process.env.UI_SPLINT_SETTLE_MS || cfg.settleMs || 1200);

mkdirSync(join(outDir, 'screens'), { recursive: true });

// ---------- locate chrome ----------
function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const n of names) {
    const r = spawnSync(which, [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  const abs = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe'];
  for (const a of abs) if (a && existsSync(a)) return a;
  return 'google-chrome';
}

// ---------- minimal CDP client over built-in WebSocket ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launchChrome() {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'uisplint-'));
  const args = ['--headless=new', '--disable-gpu', '--no-first-run',
    '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  if (allowNoSandbox) args.splice(2, 0, '--no-sandbox');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl;
  try { wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('timed out waiting for DevTools endpoint; is Chrome installed? set $CHROME')), 15000);
    proc.on('error', error => { clearTimeout(to); reject(new Error('failed to start Chrome: ' + error.message)); });
    proc.stderr.on('data', d => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(to); resolve(m[0]); }
    });
    proc.on('exit', c => { clearTimeout(to); reject(new Error('Chrome exited (' + c + ') before listening')); });
  }); } catch (error) {
    try { proc.kill(); } catch {}
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
  return { proc, wsUrl, profile };
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const cdp = new CDP(ws);
    const disconnect = reason => {
      const error = new Error('CDP WebSocket ' + reason);
      for (const pending of cdp.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      cdp.pending.clear();
      for (const waiter of cdp.waiters) waiter({ method: '__disconnect__' });
      cdp.waiters = [];
    };
    ws.onerror = () => disconnect('error');
    ws.onclose = () => disconnect('closed');
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject, timer } = cdp.pending.get(msg.id); cdp.pending.delete(msg.id); clearTimeout(timer);
        msg.error ? reject(new Error(msg.method + ': ' + msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        cdp.waiters = cdp.waiters.filter(w => !w(msg));
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP command timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  once(method, sessionId, timeout = 20000) { return this.onceFiltered(method, sessionId, null, timeout); }
  onceFiltered(method, sessionId, filter, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { reject(new Error('event timeout: ' + method)); cleanup(); }, timeout);
      const w = msg => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId) && (!filter || filter(msg.params))) {
          clearTimeout(to); resolve(msg.params); return true;
        }
        return false;
      };
      const cleanup = () => { this.waiters = this.waiters.filter(x => x !== w); };
      this.waiters.push(w);
    });
  }
  listen(method, sessionId, handler) {
    const w = msg => {
      if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) handler(msg.params);
      return false;
    };
    this.waiters.push(w);
    return () => { this.waiters = this.waiters.filter(x => x !== w); };
  }
}

// ---------- aggregation ----------
function countSev(fs) { const c = { Fail: 0, Risk: 0, Polish: 0 }; for (const f of fs) if (c[f.severity] != null) c[f.severity]++; return c; }
function slug(r) { return r.replace(/^\//, '').replace(/\//g, '_') || 'root'; }
const severityRank = { Polish: 1, Risk: 2, Fail: 3 };
function sameCell(a, b) {
  return ['route', 'viewport', 'theme', 'state'].every(field => a && b && a[field] === b[field]);
}
function aggregateFindings(source) {
  const by = new Map();
  for (const finding of source) {
    const cell = finding.cell ? structuredClone(finding.cell) : null;
    // Route is part of the aggregate identity: an identical component selector
    // on two screens is not necessarily the same root cause.
    const key = JSON.stringify([cell && cell.route, finding.rule, finding.selector]);
    if (!by.has(key)) {
      by.set(key, { ...structuredClone(finding), instances: 1, cells: cell ? [cell] : [] });
      continue;
    }
    const current = by.get(key);
    current.instances++;
    if (cell && !current.cells.some(seen => sameCell(cell, seen))) current.cells.push(cell);
    if ((severityRank[finding.severity] || 0) > (severityRank[current.severity] || 0)) {
      by.set(key, { ...structuredClone(finding), instances: current.instances, cells: current.cells });
    }
  }
  return [...by.values()];
}
async function waitFor(fn, timeout = 20000, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('timed out waiting for condition');
}

async function runtimeJson(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`, returnByValue: true, awaitPromise: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page evaluation failed');
  }
  return JSON.parse(response.result.value);
}

const KEY_CODES = {
  Tab: 9, Enter: 13, Escape: 27, Space: 32, ArrowLeft: 37, ArrowUp: 38,
  ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35
};

async function dispatchKey(cdp, sessionId, chord) {
  if (typeof chord !== 'string' || !chord) throw new Error('key must be a non-empty string');
  const parts = chord.split('+');
  const key = parts.pop();
  let modifiers = 0;
  for (const modifier of parts) {
    if (modifier === 'Alt') modifiers |= 1;
    else if (modifier === 'Control' || modifier === 'Ctrl') modifiers |= 2;
    else if (modifier === 'Meta') modifiers |= 4;
    else if (modifier === 'Shift') modifiers |= 8;
    else throw new Error(`unsupported key modifier: ${modifier}`);
  }
  const windowsVirtualKeyCode = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const code = key === ' ' ? 'Space' : key;
  const params = { key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  if (key.length === 1 && (modifiers & 7) === 0) {
    params.text = (modifiers & 8) ? key.toUpperCase() : key;
    params.unmodifiedText = key;
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, sessionId);
}

async function actionTarget(cdp, sessionId, selector, timeoutMs = 5000) {
  const encoded = JSON.stringify(selector);
  return waitFor(() => runtimeJson(cdp, sessionId, `(()=>{const matches=document.querySelectorAll(${encoded});if(matches.length!==1)return matches.length?{error:'matched '+matches.length+' elements'}:null;const el=matches[0];el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();const s=getComputedStyle(el);if(s.display==='none'||s.visibility==='hidden'||r.width<=0||r.height<=0||el.disabled)return null;return{x:r.left+r.width/2,y:r.top+r.height/2,checked:!!el.checked};})()`), timeoutMs).then(result => {
    if (result.error) throw new Error(`selector ${JSON.stringify(selector)} ${result.error}; actions require exactly one element`);
    return result;
  });
}

async function applyStateSetup(cdp, sessionId, state, setups, timeoutMs = 5000) {
  if (!setups || typeof setups !== 'object' || Array.isArray(setups)) throw new Error('stateSetups must be an object');
  const spec = setups[state];
  if (spec == null) return { configured: false, driver: 'none', status: 'not-configured', actions: 0, assertions: 0 };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`stateSetups.${state} must be an object`);
  const actions = spec.actions || [];
  const expects = spec.expect;
  if (!Array.isArray(actions)) throw new Error(`stateSetups.${state}.actions must be an array`);
  if (!Array.isArray(expects) || !expects.length) throw new Error(`stateSetups.${state}.expect must be a non-empty array`);

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    const allowed = new Set(['click', 'fill', 'press', 'hover', 'check', 'selectOption']);
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error(`stateSetups.${state}.actions[${index}] must be an object`);
    if (!allowed.has(action.type)) throw new Error(`stateSetups.${state}.actions[${index}].type is unsupported: ${JSON.stringify(action.type)}`);
    if (typeof action.selector !== 'string' || !action.selector) throw new Error(`stateSetups.${state}.actions[${index}].selector must be non-empty`);
    const point = await actionTarget(cdp, sessionId, action.selector, timeoutMs);
    const encoded = JSON.stringify(action.selector);
    if (action.type === 'click' || (action.type === 'check' && !point.checked)) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
    } else if (action.type === 'hover') {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
    } else if (action.type === 'fill') {
      if (typeof action.value !== 'string') throw new Error(`stateSetups.${state}.actions[${index}].value must be a string`);
      await runtimeJson(cdp, sessionId, `(()=>{const el=document.querySelector(${encoded});el.focus();if(typeof el.select==='function')el.select();return{ok:true};})()`);
      await cdp.send('Input.insertText', { text: action.value }, sessionId);
    } else if (action.type === 'press') {
      if (typeof action.key !== 'string' || !action.key) throw new Error(`stateSetups.${state}.actions[${index}].key must be non-empty`);
      await runtimeJson(cdp, sessionId, `(()=>{document.querySelector(${encoded}).focus();return{ok:true};})()`);
      await dispatchKey(cdp, sessionId, action.key);
    } else if (action.type === 'selectOption') {
      if (typeof action.value !== 'string') throw new Error(`stateSetups.${state}.actions[${index}].value must be a string`);
      const value = JSON.stringify(action.value);
      await runtimeJson(cdp, sessionId, `(()=>{const el=document.querySelector(${encoded});for(const option of el.options)option.selected=option.value===${value};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return{ok:true};})()`);
      const selected = await runtimeJson(cdp, sessionId, `({value:document.querySelector(${encoded}).value})`);
      if (selected.value !== action.value) throw new Error(`stateSetups.${state}.actions[${index}] could not select ${JSON.stringify(action.value)}`);
    }
    if (action.type === 'check') {
      const checked = await runtimeJson(cdp, sessionId, `({checked:!!document.querySelector(${encoded}).checked})`);
      if (!checked.checked) throw new Error(`stateSetups.${state}.actions[${index}] did not check the target`);
    }
    await sleep(50);
  }

  for (let index = 0; index < expects.length; index++) {
    const expectation = expects[index];
    if (!expectation || typeof expectation !== 'object' || Array.isArray(expectation)) throw new Error(`stateSetups.${state}.expect[${index}] must be an object`);
    const selector = expectation.selector;
    const expectedState = expectation.state || 'visible';
    if (typeof selector !== 'string' || !selector) throw new Error(`stateSetups.${state}.expect[${index}].selector must be non-empty`);
    if (!['visible', 'hidden', 'attached', 'detached'].includes(expectedState)) throw new Error(`stateSetups.${state}.expect[${index}].state is unsupported: ${JSON.stringify(expectedState)}`);
    const encoded = JSON.stringify(selector);
    await waitFor(async () => {
      const actual = await runtimeJson(cdp, sessionId, `(()=>{const matches=[...document.querySelectorAll(${encoded})];return{count:matches.length,visible:matches.filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}).length};})()`);
      if (expectedState === 'attached') return actual.count > 0;
      if (expectedState === 'detached') return actual.count === 0;
      if (expectedState === 'visible') return actual.visible > 0;
      return actual.visible === 0;
    }, timeoutMs);
  }
  return { configured: true, driver: 'structured-actions', status: 'checked', actions: actions.length, assertions: expects.length };
}

function keyboardFinding(rule, selector, message, measured, rect, suggestedFix) {
  return { rule, severity: 'Fail', confidence: 'auto-measured', selector, message,
    measured, threshold: {}, rect: rect || null, suggestedFix };
}

async function runKeyboardProbe(cdp, sessionId, config = {}, whitelist = [], baselineEntries = []) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('keyboardProbe must be an object');
  const maxSteps = Number(config.maxSteps ?? 120);
  const settle = Number(config.settleMs ?? 50);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error('keyboardProbe.maxSteps must be an integer between 1 and 1000');
  if (!Number.isInteger(settle) || settle < 0 || settle > 5000) throw new Error('keyboardProbe.settleMs must be an integer between 0 and 5000');
  const findings = [];
  const whitelistJson = JSON.stringify(whitelist || []);
  const modal = await runtimeJson(cdp, sessionId, `window.__uiSplintKeyboardProbe.modalPlan(${whitelistJson})`);
  const violations = [];
  if (modal.present) {
    if (!modal.activeInside) violations.push({ type: 'initial-focus-outside', focused: modal.activeSelector });
    for (const [boundary, chord, direction] of [['last', 'Tab', 'forward'], ['first', 'Shift+Tab', 'reverse']]) {
      const focused = await runtimeJson(cdp, sessionId, `window.__uiSplintKeyboardProbe.focusModalBoundary(${JSON.stringify(boundary)})`);
      if (!focused.ok) { violations.push({ type: 'boundary-focus-failed', direction, focused: focused.active }); continue; }
      await dispatchKey(cdp, sessionId, chord);
      if (settle) await sleep(settle);
      const active = await runtimeJson(cdp, sessionId, `window.__uiSplintKeyboardProbe.inspectActive(${whitelistJson})`);
      const expectedSelector = direction === 'forward' ? modal.firstSelector : modal.lastSelector;
      if (!active.inModal) violations.push({ type: 'focus-escaped', direction, focused: active.selector });
      else if (active.selector !== expectedSelector) violations.push({ type: 'wrong-boundary-wrap', direction, focused: active.selector, expected: expectedSelector });
    }
    if (violations.length && !modal.whitelisted) findings.push(keyboardFinding('focusTrapLeak', modal.selector,
      'Modal keyboard focus is not contained: ' + violations.map(v => v.type + (v.direction ? ` (${v.direction})` : '')).join('; ') + '.',
      { violations, tabbableCount: modal.tabbableCount || 0 }, null,
      'Move initial focus into the dialog and wrap forward/reverse Tab at its boundaries.'));
  }

  const traversal = await runtimeJson(cdp, sessionId, 'window.__uiSplintKeyboardProbe.traversalPlan()');
  const expected = Number(traversal.expected || 0);
  const visited = [];
  const obscured = new Set();
  if (expected) {
    const started = await runtimeJson(cdp, sessionId, 'window.__uiSplintKeyboardProbe.focusTraversalStart()');
    if (!started.ok) return { findings, proof: { status: 'error', reason: 'could not focus first tab stop', expected, visited: 0, dialogs: modal.visibleModalCount || 0, modalSelector: modal.selector || null, maxSteps } };
    for (let step = 0; step < maxSteps; step++) {
      const active = await runtimeJson(cdp, sessionId, `window.__uiSplintKeyboardProbe.inspectActive(${whitelistJson})`);
      if (!active.documentFocus || visited.includes(active.selector)) break;
      visited.push(active.selector);
      if (active.fullyObscured && !active.whitelisted && !obscured.has(active.selector)) {
        obscured.add(active.selector);
        findings.push(keyboardFinding('focusObscured', active.selector,
          'Keyboard focus is completely hidden by author-created layout or overlay.',
          { reason: active.reason, coveringSelector: active.coveringSelector }, active.rect,
          'Reflow the surface or add scroll padding so every focused control remains at least partially visible.'));
      }
      if (visited.length >= expected) break;
      await dispatchKey(cdp, sessionId, 'Tab');
      if (settle) await sleep(settle);
    }
  }
  let status = modal.present || expected ? 'checked' : 'not-applicable';
  let reason;
  if (expected && visited.length < expected) {
    status = 'incomplete';
    reason = `visited ${visited.length} of ${expected} tab stops before focus repeated or left the document`;
  }
  const proof = { status, expected, visited: visited.length, dialogs: modal.visibleModalCount || 0, modalSelector: modal.selector || null, maxSteps };
  if (reason) proof.reason = reason;
  const baselineKeys = new Set((baselineEntries || []).filter(item => item && typeof item === 'object')
    .map(item => `${item.rule}|${item.selector}`));
  return { findings: findings.filter(finding => !baselineKeys.has(`${finding.rule}|${finding.selector}`)), proof };
}

const allFindings = [];
const matrix = [];

const { proc, wsUrl, profile } = await launchChrome();
const cdp = await CDP.connect(wsUrl);
try {
  for (const route of routes) {
    const url = baseUrl + route;
    for (const vp of viewports) {
      const isMobile = !!vp.isMobile;
      for (const theme of themes) {
        for (const state of states) {
          const cell = { route, viewport: vp.name, theme, state };
          cell.themeDriver = themeInitScripts[theme] ? 'init-script' : 'media';
          cell.stateDriver = state === 'default' ? 'page-default' : 'none';
          cell.interceptions = 0;
          let targetId = null;
          let browserContextId = null;
          let stopDocumentResponses = null;
          try {
            const isolated = await cdp.send('Target.createBrowserContext');
            browserContextId = isolated.browserContextId;
            const created = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
            targetId = created.targetId;
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
            await cdp.send('Page.enable', {}, sessionId);
            await cdp.send('Network.enable', {}, sessionId);
            await cdp.send('Runtime.enable', {}, sessionId);
            // NB: mobile:false on purpose — CDP mobile + dpr can distort innerHeight; pass isMobile to the audit instead.
            await cdp.send('Emulation.setDeviceMetricsOverride',
              { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr || 1, mobile: false }, sessionId);
            await cdp.send('Emulation.setEmulatedMedia',
              { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
            if (themeInitScripts[theme]) {
              const themeSource = `(()=>{const run=()=>{try{${String(themeInitScripts[theme])}\n;window.__uiSplintThemeInit={ok:true};}catch(e){window.__uiSplintThemeInit={ok:false,error:String(e&&e.message||e)};}};if(document.documentElement)run();else{const o=new MutationObserver(()=>{if(document.documentElement){o.disconnect();run();}});o.observe(document,{childList:true});}})();`;
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: themeSource }, sessionId);
            }
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT }, sessionId);
            const loaded = cdp.once('Page.loadEventFired', sessionId, 20000).catch(() => null);
            // Match the navigated main document response, not a redirect, prefetch,
            // or fast subresource from another frame.
            const documentResponses = [];
            stopDocumentResponses = cdp.listen('Network.responseReceived', sessionId, p => {
              if (p.type === 'Document') documentResponses.push(p);
            });
            const nav = await cdp.send('Page.navigate', { url }, sessionId);
            if (nav.errorText) throw new Error(`navigation failed for ${url}: ${nav.errorText}`);
            await loaded;
            if (themeInitScripts[theme]) {
              const themeResult = await cdp.send('Runtime.evaluate',
                { expression: 'JSON.stringify(window.__uiSplintThemeInit||{ok:false,error:"theme init did not run"})', returnByValue: true }, sessionId);
              const themeProof = JSON.parse(themeResult.result.value);
              if (!themeProof.ok) throw new Error('theme init failed: ' + themeProof.error);
            }
            const response = await waitFor(
              () => documentResponses.find(p => p.frameId === nav.frameId),
              20000
            ).catch(() => null);
            const status = response && response.response && response.response.status;
            if (status >= 400) throw new Error(`HTTP ${status} loading ${url}`);
            await sleep(settleMs); // settle fonts + load-triggered late content (CLS)
            const setupProof = await applyStateSetup(cdp, sessionId, state, stateSetups);
            cell.setupDriver = setupProof.driver;
            cell.stateSetup = { status: setupProof.status, actions: setupProof.actions, assertions: setupProof.assertions };
            if (setupProof.configured) await sleep(100);

            const cellFindings = [];
            const cellRulesSkipped = [];
            for (const sp of scrollPositions) {
              const expr = sp === 'bottom' ? 'window.scrollTo(0, document.body.scrollHeight)'
                : sp === 'mid' ? 'window.scrollTo(0, document.body.scrollHeight/2)' : 'window.scrollTo(0,0)';
              await cdp.send('Runtime.evaluate', { expression: expr }, sessionId);
              await sleep(150);
              const acfg = JSON.stringify({ ...auditCfg, route, theme, state, isMobile, baseline });
              const r = await cdp.send('Runtime.evaluate',
                { expression: `JSON.stringify(window.__uiSplintAudit(${acfg}))`, returnByValue: true }, sessionId);
              const report = JSON.parse(r.result.value);
              for (const skipped of (report.coverage && report.coverage.rulesSkipped) || []) {
                if (!cellRulesSkipped.includes(skipped)) cellRulesSkipped.push(skipped);
              }
              for (const f of report.findings) { f.scroll = sp; f.cell = cell; }
              cellFindings.push(...report.findings);
              if (!noShots && (sp === 'top' || sp === 'bottom')) {
                const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
                writeFileSync(join(outDir, 'screens', `${slug(route)}_${vp.name}_${theme}_${state}_${sp}.png`),
                  Buffer.from(shot.data, 'base64'));
              }
            }
            const keyboard = await runKeyboardProbe(cdp, sessionId, keyboardCfg, auditCfg.whitelist || [], baseline);
            cell.keyboardProbe = keyboard.proof;
            if (['checked', 'not-applicable'].includes(keyboard.proof.status)) {
              for (let index = cellFindings.length - 1; index >= 0; index--) {
                const finding = cellFindings[index];
                if (finding.rule === 'focusTrapLeak' && finding.selector === keyboard.proof.modalSelector &&
                    finding.measured && finding.measured.keyboardProbeRequired) {
                  cellFindings.splice(index, 1);
                }
              }
            }
            for (const finding of keyboard.findings) {
              finding.scroll = 'keyboard';
              finding.cell = cell;
              cellFindings.push(finding);
            }
            // dedupe within cell
            const seen = new Set(), deduped = [];
            for (const f of cellFindings) { const k = f.rule + '|' + f.selector + '|' + f.message; if (!seen.has(k)) { seen.add(k); deduped.push(f); } }
            allFindings.push(...deduped);
            cell.counts = countSev(deduped);
            if (cellRulesSkipped.length) {
              cell.rulesSkipped = cellRulesSkipped;
              cell.status = 'error';
              cell.error = 'audit rule(s) skipped: ' + cellRulesSkipped.join('; ');
            } else if (!['checked', 'not-applicable'].includes(keyboard.proof.status)) {
              cell.status = 'error';
              cell.error = 'keyboard probe incomplete: ' + (keyboard.proof.reason || keyboard.proof.status);
            // This runner cannot mock network data, but a structured state setup with
            // explicit expectations can independently prove an interaction state.
            } else if (state === 'default' || setupProof.configured) {
              cell.status = 'checked';
            } else {
              cell.status = 'not-forced';
              cell.reason = 'data state not forced (audit-chrome.mjs has no network mocking); use run-ui-splint.py (Playwright) to mock empty/error/loading';
            }
          } catch (e) {
            cell.status = 'error'; cell.error = String(e && e.message || e);
            console.error(`  ! ${JSON.stringify(cell)}: ${cell.error}`);
          } finally {
            if (stopDocumentResponses) stopDocumentResponses();
            if (targetId) {
              try { await cdp.send('Target.closeTarget', { targetId }); } catch {}
            }
            if (browserContextId) {
              try { await cdp.send('Target.disposeBrowserContext', { browserContextId }); } catch {}
            }
          }
          matrix.push(cell);
          console.log(`  audited ${cell.status}: ${route} ${vp.name} ${theme} ${state} -> ${JSON.stringify(cell.counts || {})}`);
        }
      }
    }
  }
} finally {
  try { cdp.ws.close(); } catch {}
  // On Windows a bare kill can orphan the --headless child processes; kill the
  // whole tree by PID.
  try {
    if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    else proc.kill('SIGKILL');
  } catch {}
  await new Promise(resolve => {
    if (proc.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 1000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(profile, { recursive: true, force: true }); break; }
    catch { await sleep(100 * (attempt + 1)); }
  }
}

// Aggregate across cells while preserving routes and the worst severity evidence.
const findings = aggregateFindings(allFindings);
writeFileSync(join(outDir, 'findings.json'), JSON.stringify(findings, null, 2));
writeFileSync(join(outDir, 'coverage.json'), JSON.stringify({ base_url: baseUrl, generated_at: new Date().toISOString(), matrix, totals: countSev(findings) }, null, 2));

const totals = countSev(findings);
console.log(`\nUI Splint: ${JSON.stringify(totals)} across ${matrix.length} cells -> ${outDir}/findings.json`);
const notForced = matrix.filter(c => c.status === 'not-forced');
if (notForced.length) {
  console.log(`NOTE: ${notForced.length} non-default data-state cell(s) were NOT forced by this runner (no network mocking). ` +
    `They are recorded as "not-forced" in coverage.json — use run-ui-splint.py to actually exercise empty/error/loading.`);
}
const errors = matrix.filter(c => c.status !== 'checked');
if (errors.length) { console.log(`BLOCKED: ${errors.length} matrix cell(s) were not verified. Review coverage.json before claiming the work complete.`); process.exit(1); }
const fails = findings.filter(f => f.severity === 'Fail');
if (fails.length) { console.log(`BLOCKED: ${fails.length} un-baselined Fail finding(s). Review before claiming the work complete.`); process.exit(1); }
process.exit(0);
