/**
 * Zero-dependency Chrome driver for screen-map: launches Chrome, speaks CDP over
 * Node's built-in WebSocket (Node >= 22), and exposes the few page operations the
 * crawler needs. Mirrors the driver shape used by the ui-audit skill.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsTowardSettle, storageSeedSource } from './model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARVEST_SOURCE = readFileSync(join(HERE, 'harvest.js'), 'utf8');

export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'];
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    const result = spawnSync(which, [name], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim().split(/\r?\n/)[0];
  }
  const absolute = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  ];
  for (const candidate of absolute) if (candidate && existsSync(candidate)) return candidate;
  return 'google-chrome';
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = []; }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP websocket connect failed'));
    });
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
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && cdp.pending.has(message.id)) {
        const { resolve, reject, timer } = cdp.pending.get(message.id);
        cdp.pending.delete(message.id);
        clearTimeout(timer);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      } else if (message.method) {
        cdp.waiters = cdp.waiters.filter(waiter => !waiter(message));
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

  listen(method, sessionId, handler) {
    const waiter = message => {
      if (message.method === method && (!sessionId || message.sessionId === sessionId)) handler(message.params);
      return false;
    };
    this.waiters.push(waiter);
    return () => { this.waiters = this.waiters.filter(entry => entry !== waiter); };
  }
}

export async function launchBrowser({ headless = true, noSandbox = false } = {}) {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'screen-map-'));
  const args = [
    headless ? '--headless=new' : '--new-window',
    '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ];
  if (noSandbox) args.splice(1, 0, '--no-sandbox');

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let wsUrl;
  try {
    wsUrl = await new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the DevTools endpoint; is Chrome installed? set $CHROME')), 15000);
      proc.on('error', error => { clearTimeout(timer); reject(new Error('failed to start Chrome: ' + error.message)); });
      proc.on('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited (' + code + ') before listening')); });
      proc.stderr.on('data', chunk => {
        buffer += chunk.toString();
        const match = buffer.match(/ws:\/\/[^\s]+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
  } catch (error) {
    try { proc.kill(); } catch { /* already gone */ }
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }

  const cdp = await CDP.connect(wsUrl);
  return {
    cdp,
    async close() {
      try { await cdp.send('Browser.close'); } catch { /* fall through to kill */ }
      try { proc.kill(); } catch { /* already gone */ }
      // Windows keeps handles on the profile briefly after exit; a leftover temp
      // directory must never be reported as a crawl failure.
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(100);
        try { rmSync(profile, { recursive: true, force: true }); return; }
        catch { /* retry */ }
      }
    },
  };
}

export class Page {
  constructor(cdp, sessionId, targetId, browserContextId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.browserContextId = browserContextId;
    this.dialogs = [];
    this.blockedNavigations = [];
    this.cleanups = [];
    this.inflightRequests = new Set();
    this.completions = 0;
    this.idleSince = Date.now();
  }

  get inflight() { return this.inflightRequests.size; }

  static async open(cdp, {
    viewport = { width: 1280, height: 900 }, storageSeed = null, allowedOrigin = null,
  } = {}) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const page = new Page(cdp, sessionId, targetId, browserContextId);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }, sessionId);

    // Welcome cards, product tours and cookie strips decide whether to appear while the
    // app mounts, from storage it reads on that first render. Seeding afterwards is too
    // late: the overlay is already up and its backdrop already swallowing the crawler's
    // clicks, so the crawl maps a modal instead of the screen behind it. Seeding on every
    // new document means no page is ever rendered unseeded — including replays.
    const seed = storageSeedSource(storageSeed);
    if (seed) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed }, sessionId);

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HARVEST_SOURCE }, sessionId);

    if (allowedOrigin) {
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId);
      const mainFrameId = frameTree.frame.id;
      await cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      }, sessionId);
      page.cleanups.push(cdp.listen('Fetch.requestPaused', sessionId, params => {
        let blocked = false;
        if (params.frameId === mainFrameId) {
          try { blocked = new URL(params.request.url).origin !== allowedOrigin; }
          catch { blocked = true; }
        }
        if (blocked) {
          page.blockedNavigations.push({ url: params.request.url, reason: 'external-origin' });
          cdp.send('Fetch.failRequest', {
            requestId: params.requestId, errorReason: 'BlockedByClient',
          }, sessionId).catch(() => {});
          return;
        }
        cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
      }));
    }

    // Fingerprint stability alone marks a skeleton screen as settled: the DOM holds
    // still for a few hundred ms while the data request is in flight, and the crawler
    // records the loading state as a screen of its own. Track in-flight requests so
    // "settled" also means the app stopped fetching.
    //
    // Only requests that can carry new content are counted — see `countsTowardSettle`
    // for why, and for what Playwright does differently. Measured against a Vite app,
    // counting everything meant `inflight` never returned to zero at all, so every
    // settle ran to its timeout and the crawl paid seconds per action to re-learn what
    // it already knew within one.
    const started = params => {
      // A redirect re-fires for the same id; counting it twice leaks the counter up.
      if (page.inflightRequests.has(params.requestId)) return;
      if (!countsTowardSettle(params.type)) return;
      page.inflightRequests.add(params.requestId);
    };
    const finished = params => {
      if (!page.inflightRequests.delete(params.requestId)) return;
      page.completions += 1;
      if (page.inflight === 0) page.idleSince = Date.now();
    };
    page.cleanups.push(cdp.listen('Network.requestWillBeSent', sessionId, started));
    page.cleanups.push(cdp.listen('Network.loadingFinished', sessionId, finished));
    page.cleanups.push(cdp.listen('Network.loadingFailed', sessionId, finished));

    // An unhandled dialog locks CDP and takes the whole crawl with it. Cancel every
    // confirm/alert/prompt; accept beforeunload so navigation is never wedged.
    page.cleanups.push(cdp.listen('Page.javascriptDialogOpening', sessionId, params => {
      page.dialogs.push({ type: params.type, message: params.message });
      const accept = params.type === 'beforeunload';
      cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {});
    }));

    // Stray popups are invisible to the driver; close them so they cannot swallow input.
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    page.cleanups.push(cdp.listen('Target.targetCreated', null, params => {
      const info = params.targetInfo;
      if (!info || info.type !== 'page' || info.targetId === targetId) return;
      if (info.browserContextId && info.browserContextId !== browserContextId) return;
      cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }));

    return page;
  }

  async evaluateJson(expression) {
    const response = await this.cdp.send('Runtime.evaluate', {
      expression: `(async()=>JSON.stringify(await (${expression})))()`,
      returnByValue: true, awaitPromise: true,
    }, this.sessionId);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description
        || response.exceptionDetails.text || 'page evaluation failed');
    }
    return response.result.value === undefined ? null : JSON.parse(response.result.value);
  }

  async navigate(url, { timeout = 20000 } = {}) {
    const loaded = new Promise(resolve => {
      const stop = this.cdp.listen('Page.loadEventFired', this.sessionId, () => { stop(); resolve(true); });
      setTimeout(() => { stop(); resolve(false); }, timeout);
    });
    const result = await this.cdp.send('Page.navigate', { url }, this.sessionId);
    if (result.errorText) throw new Error(`navigation failed for ${url}: ${result.errorText}`);
    await loaded;
    await this.waitForHarvest();
  }

  async waitForHarvest(timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const ready = await this.evaluateJson('!!(window.__screenMap && window.__screenMap.ready)');
        if (ready) return true;
      } catch { /* context still swapping */ }
      await sleep(80);
    }
    throw new Error('harvest script never became ready');
  }

  observe() { return this.evaluateJson('window.__screenMap.observe()'); }

  /**
   * Settled means two things at once: the app stopped fetching, and the screen
   * stopped changing. Either alone captures skeletons as if they were screens.
   */
  async settle({ timeout = 8000, interval = 150, stableRounds = 2, quietMs = 300 } = {}) {
    const deadline = Date.now() + timeout;
    let previous = null;
    let stable = 0;
    let latest = null;
    let seenCompletions = this.completions;
    while (Date.now() < deadline) {
      let observation = null;
      try { observation = await this.observe(); }
      catch { await sleep(interval); continue; }
      latest = observation;

      // A client router swaps the URL before the data lands, so the previous
      // screen can look perfectly stable at the new path. Any response that
      // arrives restarts the window: the render it feeds has not happened yet.
      if (this.completions !== seenCompletions) {
        seenCompletions = this.completions;
        stable = 0;
      }

      const quiet = this.inflight === 0 && Date.now() - this.idleSince >= quietMs;
      // A screen with no landmarks, no headings and no actions is not a screen —
      // it is a render the crawler caught mid-flight. Never settle on one.
      const empty = !(observation.fingerprint.landmarks || []).length
        && !(observation.fingerprint.headings || []).length
        && !(observation.actions || []).length;
      const key = observation.pathname + '|' + JSON.stringify(observation.fingerprint);
      if (key === previous && quiet && !empty) {
        stable += 1;
        if (stable >= stableRounds) return observation;
      } else {
        stable = 0;
        previous = key;
      }
      await sleep(interval);
    }
    // A polling app never goes quiet; the timeout is the answer, not a failure.
    if (latest) return latest;
    await this.waitForHarvest();
    return this.observe();
  }

  async click(key, cssFallback = null) {
    const target = await this.evaluateJson(
      `window.__screenMap.resolve(${JSON.stringify(key)}, ${JSON.stringify(cssFallback)})`);
    if (!target || !target.ok) return { ok: false, reason: (target && target.reason) || 'unresolvable' };
    const point = { x: Math.round(target.x), y: Math.round(target.y) };
    // Move first: hover-revealed controls are common and a bare press misses them.
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', buttons: 0 }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }, this.sessionId);
    await this.cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }, this.sessionId);
    return { ok: true, via: target.via };
  }

  async fill(selector, value) {
    const filled = await this.evaluateJson(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return {ok:false};` +
      `el.focus();el.value=${JSON.stringify(value)};` +
      `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));` +
      `return {ok:true};})()`);
    if (!filled || !filled.ok) throw new Error(`auth step: no element matched ${selector}`);
  }

  async storageState() {
    const { cookies } = await this.cdp.send('Storage.getCookies', { browserContextId: this.browserContextId });
    let origin = null;
    let local = [];
    try {
      const snapshot = await this.evaluateJson(
        '({origin:location.origin,items:Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])})');
      origin = snapshot.origin;
      local = snapshot.items;
    } catch { /* opaque origin — cookies alone */ }
    return { cookies, localStorage: origin ? [{ origin, items: local }] : [] };
  }

  async applyStorageState(state) {
    if (!state) return;
    if (state.cookies?.length) {
      await this.cdp.send('Storage.setCookies', { cookies: state.cookies, browserContextId: this.browserContextId });
    }
    for (const entry of state.localStorage || []) {
      await this.evaluateJson(
        `(()=>{if(location.origin!==${JSON.stringify(entry.origin)})return {skipped:true};` +
        `for(const [k,v] of ${JSON.stringify(entry.items)}) localStorage.setItem(k,v);return {ok:true};})()`);
    }
  }

  async close() {
    for (const cleanup of this.cleanups) cleanup();
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* already gone */ }
    try { await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }); }
    catch { /* already gone */ }
  }
}
