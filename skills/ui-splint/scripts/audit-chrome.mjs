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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
const INIT = AUDIT_JS + '\n;try{window.__uiSplintInstallCLS&&window.__uiSplintInstallCLS();}catch(e){}\n';

// ---------- args ----------
const argv = process.argv.slice(2);
if (!argv[0] || argv[0].startsWith('-')) {
  console.error('usage: node audit-chrome.mjs <base_url> [--config f] [--out-dir d] [--routes /,/a] [--no-screenshots]');
  process.exit(2);
}
const baseUrl = argv[0].replace(/\/$/, '');
const opt = (name, def) => { const i = argv.indexOf(name); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def; };
const DEFAULT_CONFIG = join(HERE, 'audit-config.default.json');
const configPath = opt('--config', DEFAULT_CONFIG);
const outDir = opt('--out-dir', '.ui-splint');
const noShots = argv.includes('--no-screenshots');
const routesOverride = opt('--routes', null);

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
  const profile = join(tmpdir(), 'uisplint-' + process.pid);
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => reject(new Error('timed out waiting for DevTools endpoint; is Chrome installed? set $CHROME')), 15000);
    proc.stderr.on('data', d => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(to); resolve(m[0]); }
    });
    proc.on('exit', c => { clearTimeout(to); reject(new Error('Chrome exited (' + c + ') before listening')); });
  });
  return { proc, wsUrl };
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
    const cdp = new CDP(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id); cdp.pending.delete(msg.id);
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
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
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
    const value = fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error('timed out waiting for condition');
}

const allFindings = [];
const matrix = [];

const { proc, wsUrl } = await launchChrome();
const cdp = await CDP.connect(wsUrl);
try {
  for (const route of routes) {
    const url = baseUrl + route;
    for (const vp of viewports) {
      const isMobile = !!vp.isMobile;
      for (const theme of themes) {
        for (const state of states) {
          const cell = { route, viewport: vp.name, theme, state };
          let targetId = null;
          let stopDocumentResponses = null;
          try {
            const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
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
            const response = await waitFor(
              () => documentResponses.find(p => p.frameId === nav.frameId),
              20000
            ).catch(() => null);
            const status = response && response.response && response.response.status;
            if (status >= 400) throw new Error(`HTTP ${status} loading ${url}`);
            await sleep(1200); // settle fonts + load-triggered late content (CLS)

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
            // dedupe within cell
            const seen = new Set(), deduped = [];
            for (const f of cellFindings) { const k = f.rule + '|' + f.selector + '|' + f.message; if (!seen.has(k)) { seen.add(k); deduped.push(f); } }
            allFindings.push(...deduped);
            cell.counts = countSev(deduped);
            if (cellRulesSkipped.length) {
              cell.rulesSkipped = cellRulesSkipped;
              cell.status = 'error';
              cell.error = 'audit rule(s) skipped: ' + cellRulesSkipped.join('; ');
            // This runner has no network mocking, so it cannot force empty/error/loading data
            // states — a non-default cell just re-renders the default page. Report it honestly as
            // not-forced rather than pretending the state was verified (silence is not coverage).
            } else if (state === 'default') {
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
    else proc.kill();
  } catch {}
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
