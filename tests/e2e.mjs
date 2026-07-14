import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const picker = readFileSync(fileURLToPath(new URL('../assets/element-picker.js', import.meta.url)), 'utf8');
const names = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
let chrome = null;
for (const name of names) {
  if (name.includes('/')) { chrome = name; break; }
  const found = spawnSync('which', [name], { encoding: 'utf8' });
  if (found.status === 0) { chrome = found.stdout.trim(); break; }
}
if (!chrome) process.exit(77);

const server = createServer((req, res) => {
  const ambiguous = req.url.includes('ambiguous=1');
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><button id="save"><span>Save</span></button>
    <button id="cancel">Cancel</button>
    <button data-testid="dup">one</button>${ambiguous ? '<button data-testid="dup">two</button>' : ''}`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const profile = mkdtempSync(join(tmpdir(), 'dom-picker-e2e-'));
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

let browserWs;
try {
  browserWs = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
    proc.stderr.on('data', chunk => {
      text += chunk;
      const match = text.match(/ws:\/\/[^\s]+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    proc.on('error', reject);
    proc.on('exit', code => reject(new Error(`Chrome exited ${code}`)));
  });

  const ws = new WebSocket(browserWs);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const callId = ++id; pending.set(callId, { resolve, reject });
    ws.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const session = attached.sessionId;
  await send('Page.enable', {}, session);
  await send('Runtime.enable', {}, session);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: picker }, session);
  const nav = async url => {
    await send('Page.navigate', { url }, session);
    await new Promise(r => setTimeout(r, 300));
    await send('Runtime.evaluate', { expression: picker }, session);
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await nav(`http://127.0.0.1:${port}/`);
  await evaluate(picker);
  const idempotent = await evaluate(`(function(){var before=window.__s2p;${picker};return before===window.__s2p;})()`);
  if (!idempotent) throw new Error('injection was not idempotent');
  const programmatic = JSON.parse(await evaluate(`JSON.stringify(window.__s2p.snapshot('#save span'))`));
  if (programmatic.selector !== '#save' || programmatic.resolvedFromLeaf !== 'span') throw new Error('leaf promotion failed');

  await evaluate(`window.__s2p.clear();window.__s2p.enable();var e=document.querySelector('#save span'),r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+1,clientY:r.top+1}));`);
  if (await evaluate(`window.__s2p.lastPick.selector`) !== '#save') throw new Error('human click selection failed');
  const submit = async (selector, text) => evaluate(`window.__s2p.snapshot(${JSON.stringify(selector)});var t=document.querySelector('textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,ctrlKey:true,key:'Enter'}))`);
  await submit('#save', 'first');
  await submit('#cancel', 'second');
  const drained = JSON.parse(await evaluate(`JSON.stringify(window.__s2p.drainQueue())`));
  if (drained.map(item => item.text).join(',') !== 'first,second') throw new Error('queue was not FIFO');

  await evaluate(`window.__s2p.snapshot('#cancel');var t=document.querySelector('textarea');t.value='draft';t.dispatchEvent(new Event('input',{bubbles:true}))`);
  await nav(`http://127.0.0.1:${port}/`);
  const continuity = JSON.parse(await evaluate(`JSON.stringify({draft:window.__s2p._draft,seq:window.__s2p._seq,picks:window.__s2p.picks.length})`));
  if (continuity.draft !== 'draft' || continuity.seq !== 2 || continuity.picks !== 1) throw new Error('reload continuity failed');

  await evaluate(`window.__s2p.clear();window.__s2p.snapshot('[data-testid="dup"]')`);
  await nav(`http://127.0.0.1:${port}/?ambiguous=1`);
  if (await evaluate(`window.__s2p.picks.length`) !== 0) throw new Error('ambiguous selector was restored');
  await evaluate(`window.__s2p.destroy()`);
  if (await evaluate(`typeof window.__s2p !== 'undefined' || document.querySelectorAll('[data-s2p]').length !== 0`)) throw new Error('destroy left picker state');
  ws.close();
  console.log('dom-picker browser e2e passed');
} finally {
  server.close();
  try { proc.kill('SIGKILL'); } catch {}
  rmSync(profile, { recursive: true, force: true });
}
