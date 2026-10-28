/**
 * chrome-cdp.mjs — zero-dependency Chrome launcher, process-tree cleanup, and a minimal
 * DevTools Protocol client over Node's built-in WebSocket (Node >= 22).
 *
 * Shared by the dom-picker, screen-map, and ui-audit skills. Each skill is published on
 * its own, so each carries an IDENTICAL copy of this file in its scripts/ directory, and
 * tests/check-shared-copies.sh at the repository root fails when the copies drift. Change
 * one copy, then copy it over the other two.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function sleep(ms) { return new Promise(done => setTimeout(done, ms)); }

/** Fail early and clearly on a Node without the global WebSocket this file is built on. */
export function requireWebSocket(tool, hint = '') {
  if (typeof WebSocket !== 'undefined') return;
  process.stderr.write(`${tool} requires Node >= 22 (built-in WebSocket). Detected ${process.version}. `
    + (hint || 'Upgrade Node.') + '\n');
  process.exit(2);
}

// ---------- locate chrome ----------

/** $CHROME, then Chrome/Chromium/Edge on PATH, then the usual install locations; null if none. */
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
  return null;
}

// ---------- process tree ----------

// Chrome is a process tree, not a process: killing the launcher leaves the zygote and
// renderers running, reparented and still writing the profile we are about to delete.
// Windows gets the tree treatment via taskkill /T; POSIX gets it by launching Chrome as
// its own process-group leader (detached) so the whole group can be signalled with a
// negative pid. Detaching also means a terminal Ctrl-C no longer reaches Chrome, which is
// why every launch below is covered by the exit and signal hooks.
export const CHROME_DETACHED = process.platform !== 'win32';

function running(proc) { return Boolean(proc && proc.exitCode === null && proc.signalCode === null); }

export function killChromeTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    // Once the launcher is gone taskkill cannot find its tree, and the pid may be reused.
    if (running(proc)) spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-proc.pid, 'SIGKILL'); return; }
  catch { /* group already gone — fall through to the single-process kill */ }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

export function waitForExit(proc, timeoutMs) {
  if (!running(proc)) return Promise.resolve(true);
  return new Promise(done => {
    const onExit = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { proc.removeListener('exit', onExit); done(false); }, timeoutMs);
    proc.once('exit', onExit);
  });
}

// ---------- profile ----------

/**
 * Removal has to be confirmed, not merely attempted: rmSync unlinks files a still-shutting-
 * down renderer holds open and reports success, and that renderer then writes the profile
 * back. Loop until the directory is gone AND stays gone. Never throws.
 */
export async function removeProfile(profile) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* retried */ }
    if (!existsSync(profile)) {
      await sleep(50);
      if (!existsSync(profile)) return true;
    }
    await sleep(100 * (attempt + 1));
  }
  return !existsSync(profile);
}

function warnProfileLeft(profile) {
  process.stderr.write(`WARNING: Chrome temporary profile could not be removed: ${profile}\n`);
}

// ---------- launch and close ----------

const live = new Set();
let hooksInstalled = false;

/** Last resort for an exit nobody planned: kill every Chrome still running, synchronously. */
function cleanupSync() {
  for (const handle of live) {
    live.delete(handle);
    killChromeTree(handle.proc);
    if (!handle.ownsProfile) continue;
    try { rmSync(handle.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* reported below */ }
    if (existsSync(handle.profile)) warnProfileLeft(handle.profile);
  }
}

function onSignal(signal) {
  // A caller with its own handler closes Chrome on its own schedule (and exits through
  // the 'exit' hook if it gives up); only an unhandled signal is ours to act on.
  if (process.listenerCount(signal) > 1) return;
  if (live.size) process.stderr.write(`\ninterrupted (${signal}): closing Chrome\n`);
  cleanupSync();
  process.exit(signal === 'SIGTERM' ? 143 : 130);
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', cleanupSync);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

async function devtoolsVersion(port, timeoutMs = 1000) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function waitForEndpoint(proc, activePortFile, timeoutMs) {
  return new Promise((resolveEndpoint, rejectEndpoint) => {
    let buffer = '';
    let settled = false;
    const finish = (error, wsUrl) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (error) rejectEndpoint(error); else resolveEndpoint(wsUrl);
    };
    const timer = setTimeout(
      () => finish(new Error('timed out waiting for the DevTools endpoint; is Chrome installed? set $CHROME')), timeoutMs);
    // Two sources, whichever answers first: the stderr banner, and the DevToolsActivePort
    // file, which was deleted before launch so whatever appears there is this Chrome's.
    const poll = setInterval(() => {
      try {
        const [port, path] = readFileSync(activePortFile, 'utf8').split(/\r?\n/);
        if (Number(port) > 0 && path) finish(null, `ws://127.0.0.1:${Number(port)}${path.trim()}`);
      } catch { /* not written yet */ }
    }, 100);
    proc.on('error', error => finish(new Error('failed to start Chrome: ' + error.message)));
    proc.on('exit', code => finish(new Error('Chrome exited (' + code + ') before listening')));
    // Keep draining after the banner: a full pipe would stall Chrome.
    proc.stderr.on('data', chunk => {
      if (settled) return;
      buffer += chunk.toString();
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) finish(null, match[0]);
    });
  });
}

/**
 * Start Chrome with a DevTools endpoint and return its handle:
 * { proc, wsUrl, port, profile, ownsProfile }. Pass the handle to closeChrome().
 *
 * `port` 0 lets the OS pick. A named port that already answers is refused instead of
 * attached to, and the endpoint finally used is checked to be the launched browser's own —
 * never a different browser that happens to hold the port or a stale DevToolsActivePort.
 * `userDataDir` is the caller's profile and is never deleted; without it a temporary
 * profile named `${profilePrefix}XXXXXX` is created and removed on close.
 */
export async function launchChrome({
  args = [], url = 'about:blank', port = 0, userDataDir = null, profilePrefix = 'chrome-cdp-', timeoutMs = 15000,
} = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome/Chromium not found; set CHROME=/path/to/chrome');
  if (port) {
    let info = null;
    try { info = await devtoolsVersion(port); } catch { /* nothing answering: free */ }
    if (info) {
      throw new Error(`port ${port} is already serving another browser (${info.Browser || 'unknown'}); `
        + 'choose a different port, or attach to that browser instead of launching one');
    }
  }
  const ownsProfile = !userDataDir;
  const profile = userDataDir ? resolve(userDataDir) : mkdtempSync(join(tmpdir(), profilePrefix));
  const activePortFile = join(profile, 'DevToolsActivePort');
  try { rmSync(activePortFile, { force: true }); } catch { /* Chrome rewrites it; the check below catches a stale one */ }

  installHooks();
  const proc = spawn(bin, [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: CHROME_DETACHED });
  const handle = { proc, wsUrl: null, port: null, profile, ownsProfile };
  live.add(handle);
  try {
    const deadline = Date.now() + timeoutMs;
    handle.wsUrl = await waitForEndpoint(proc, activePortFile, timeoutMs);
    handle.port = Number(new URL(handle.wsUrl).port);
    let info = null;
    let lastError = null;
    while (!info && Date.now() < deadline) {
      try { info = await devtoolsVersion(handle.port); }
      catch (error) { lastError = error; await sleep(100); }
    }
    if (!info) throw new Error(`DevTools endpoint on port ${handle.port} did not answer: ${lastError && lastError.message}`);
    const announced = new URL(handle.wsUrl).pathname;
    const answering = info.webSocketDebuggerUrl ? new URL(info.webSocketDebuggerUrl).pathname : '';
    if (announced !== answering) {
      throw new Error(`port ${handle.port} is answering as a different browser than the one launched; refusing to drive it`);
    }
    handle.wsUrl = info.webSocketDebuggerUrl;
  } catch (error) {
    await closeChrome(handle);
    throw error;
  }
  return handle;
}

/**
 * Stop a launched Chrome: give it `graceMs` to exit (SIGTERM on POSIX), then kill the
 * whole tree and remove a temporary profile, warning if it survives. Never throws;
 * resolves to whether the profile is gone. Safe to call more than once.
 */
export function closeChrome(handle, { graceMs = 0 } = {}) {
  if (!handle) return Promise.resolve(true);
  if (!handle.closing) {
    handle.closing = (async () => {
      const { proc } = handle;
      if (graceMs > 0 && running(proc)) {
        if (CHROME_DETACHED) { try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ } }
        await waitForExit(proc, graceMs);
      }
      killChromeTree(proc);
      await waitForExit(proc, 2000);
      live.delete(handle);
      if (!handle.ownsProfile) return true;
      const removed = await removeProfile(handle.profile);
      if (!removed) warnProfileLeft(handle.profile);
      return removed;
    })();
  }
  return handle.closing;
}

// ---------- minimal CDP client ----------

/**
 * One WebSocket to a browser or page endpoint. `await cdp.ready` (or use CDP.connect)
 * before sending. Commands carry an optional flat-mode sessionId; events are delivered to
 * listen()/on() handlers, and once()/onceFiltered() reject on timeout or disconnect.
 */
export class CDP {
  constructor(wsUrl, { timeoutMs = 20000 } = {}) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.handlers = new Set();
    this.disconnectHooks = new Set();
    this.opened = false;
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.ready.catch(() => { /* surfaced to whoever awaits it */ });
    this.closed = new Promise(resolveClosed => { this.resolveClosed = resolveClosed; });
    this.ws.addEventListener('open', () => { this.opened = true; this.resolveReady(); }, { once: true });
    this.ws.addEventListener('message', event => this.onMessage(event));
    this.ws.addEventListener('error', () => this.disconnect('error'));
    this.ws.addEventListener('close', () => this.disconnect('closed'));
  }

  static async connect(wsUrl, options) {
    const cdp = new CDP(wsUrl, options);
    try { await cdp.ready; }
    catch (error) { cdp.close(); throw error; }
    return cdp;
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const handler of [...this.handlers]) {
      if (handler.method !== message.method) continue;
      if (handler.sessionId && handler.sessionId !== message.sessionId) continue;
      try { handler.fn(message.params || {}); }
      catch (error) { process.stderr.write(`CDP event handler failed for ${message.method}: ${error && error.message}\n`); }
    }
  }

  disconnect(kind) {
    const error = new Error('CDP WebSocket ' + kind);
    if (!this.opened) this.rejectReady(error);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const hook of [...this.disconnectHooks]) hook(error);
    this.disconnectHooks.clear();
    if (this.resolveClosed) { this.resolveClosed(error); this.resolveClosed = null; }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolveSend, rejectSend) => {
      if (this.ws.readyState !== WebSocket.OPEN) { rejectSend(new Error('CDP WebSocket is not open')); return; }
      const id = ++this.id;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const timer = setTimeout(() => { this.pending.delete(id); rejectSend(new Error('CDP command timeout: ' + method)); }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolveSend, reject: rejectSend, timer });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); rejectSend(error); }
    });
  }

  /** Call `fn(params)` for every `method` event (from `sessionId` only, if given); returns an unsubscribe. */
  listen(method, sessionId, fn) {
    const handler = { method, sessionId, fn };
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  on(method, fn) { return this.listen(method, null, fn); }

  once(method, sessionId, timeout = 20000) { return this.onceFiltered(method, sessionId, null, timeout); }

  onceFiltered(method, sessionId, filter, timeout = 20000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const done = () => { clearTimeout(timer); stop(); this.disconnectHooks.delete(onDisconnect); };
      const timer = setTimeout(() => { done(); rejectEvent(new Error('event timeout: ' + method)); }, timeout);
      const onDisconnect = error => { done(); rejectEvent(error); };
      const stop = this.listen(method, sessionId, params => {
        if (filter && !filter(params)) return;
        done();
        resolveEvent(params);
      });
      this.disconnectHooks.add(onDisconnect);
    });
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
