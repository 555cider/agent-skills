/**
 * A stand-in for whatever drives the browser during a recording — a Playwright script,
 * dom-picker, a person. It connects over CDP to a browser that is already running and
 * clicks by accessible name, dispatching real mouse input the way a driver does.
 *
 * It deliberately shares no code with the skill it exercises. A recorder tested through
 * the skill's own driver would prove only that the two halves agree with each other.
 *
 *   node drive.mjs --port 9222 --goto http://host/ --click '상품 목록' --wait 400 --submit '저장'
 *
 * Steps run in the order given on the command line.
 */

const args = process.argv.slice(2);
const steps = [];
let port = 9222;
let host = '127.0.0.1';

for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--port') { port = Number(value); index++; continue; }
  if (flag === '--host') { host = value; index++; continue; }
  if (flag === '--close') { steps.push({ kind: 'close' }); continue; }
  if (['--goto', '--click', '--wait', '--type', '--enter', '--newtab'].includes(flag)) {
    steps.push({ kind: flag.slice(2), value });
    index++;
    continue;
  }
  throw new Error('unknown driver flag: ' + flag);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('driver: connect failed')); });
    const client = new Client(ws);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && client.pending.has(message.id)) {
        const { resolve, reject } = client.pending.get(message.id);
        client.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      } else if (message.method) {
        for (const handler of client.handlers) handler(message);
      }
    };
    return client;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('driver timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify(${expression})`, returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error('driver eval failed: ' + JSON.stringify(response.exceptionDetails.text));
  return response.result.value === undefined ? null : JSON.parse(response.result.value);
}

/** Find a control by its visible text and hand back a viewport point to press. */
const LOCATE = name => `(() => {
  const wanted = ${JSON.stringify(name)};
  const nodes = Array.from(document.querySelectorAll('a[href],button,summary,input[type="submit"],[role="button"],[role="link"],[role="tab"],[role="menuitem"]'));
  const match = nodes.find(el => {
    const text = (el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text === wanted || text.includes(wanted);
  });
  if (!match) return { ok: false };
  match.scrollIntoView({ block: 'center' });
  const rect = match.getBoundingClientRect();
  return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

const version = await (await fetch(`http://${host}:${port}/json/version`)).json();
const client = await Client.connect(version.webSocketDebuggerUrl);

const { targetInfos } = await client.send('Target.getTargets');
const pageTarget = targetInfos.find(info => info.type === 'page');
if (!pageTarget) throw new Error('driver: no page target to drive');
const { sessionId } = await client.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
await client.send('Page.enable', {}, sessionId);
await client.send('Runtime.enable', {}, sessionId);

for (const step of steps) {
  if (step.kind === 'goto') {
    await client.send('Page.navigate', { url: step.value }, sessionId);
    await sleep(900);
    continue;
  }
  if (step.kind === 'wait') { await sleep(Number(step.value)); continue; }
  if (step.kind === 'close') {
    // Give the recorder time to settle on the last screen before the tab it is watching
    // disappears; closing is how a driver tells it the session is over.
    await sleep(1500);
    await client.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => {});
    break;
  }
  if (step.kind === 'newtab') {
    await client.send('Target.createTarget', { url: step.value });
    await sleep(900);
    continue;
  }
  if (step.kind === 'type') {
    // Split on the first `=` only: a selector like `input[name="title"]` has its own.
    const cut = step.value.indexOf('=');
    const selector = step.value.slice(0, cut);
    const text = step.value.slice(cut + 1);
    await evaluate(client, sessionId,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    continue;
  }
  if (step.kind === 'enter') {
    // Submitting with the keyboard produces a `submit` event and no click at all — the
    // case the recorder's second listener exists for.
    for (const type of ['keyDown', 'char', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined,
      }, sessionId);
    }
    await sleep(900);
    continue;
  }

  const point = await evaluate(client, sessionId, LOCATE(step.value));
  if (!point || !point.ok) throw new Error(`driver: nothing named ${JSON.stringify(step.value)} on this screen`);
  const at = { x: Math.round(point.x), y: Math.round(point.y) };
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
  await sleep(900);
}

client.ws.close();
process.stdout.write('driver done\n');
