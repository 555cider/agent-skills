/** Browser-driver regressions that need real CDP events but not a full crawl. */

import { createServer } from 'node:http';

import { SandboxRefused, launchBrowser, Page } from '../scripts/browser.mjs';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

// ---------- running as root ----------
//
// No browser is launched here: the guard fires before Chrome is even located, which is
// what makes it testable anywhere. It has to stay a *distinguishable* refusal, because
// the suite's Chrome-absence skip reads the class name — collapse the two and a machine
// with a perfectly good Chrome reports twenty checks as "skipped" and exits green.
{
  const realGetuid = process.getuid;
  const realEnv = process.env.SCREEN_MAP_NO_SANDBOX;
  process.getuid = () => 0;
  delete process.env.SCREEN_MAP_NO_SANDBOX;
  let refusal = null;
  try { await launchBrowser({ headless: true }); }
  catch (error) { refusal = error; }
  check('as root, launching a browser is refused rather than silently unsandboxed',
    refusal instanceof SandboxRefused, refusal ? refusal.constructor.name : 'nothing was thrown');
  check('the refusal names both ways out, since a container cannot stop being root',
    /--no-sandbox/.test(refusal?.message || '') && /SCREEN_MAP_NO_SANDBOX/.test(refusal?.message || ''),
    JSON.stringify(refusal?.message));
  if (realEnv === undefined) delete process.env.SCREEN_MAP_NO_SANDBOX;
  else process.env.SCREEN_MAP_NO_SANDBOX = realEnv;
  if (realGetuid) process.getuid = realGetuid; else delete process.getuid;
}

const html = '<!doctype html><html><body><main><h1>Final</h1>'
  + '<button id="target" type="button">Old name</button></main></body></html>';
const server = createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/final' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

let browser;
let page;
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  page = await Page.open(browser.cdp);
  await page.navigate(base + '/redirect');

  const started = Date.now();
  const observation = await page.settle({ timeout: 1200, interval: 50, stableRounds: 1, quietMs: 100 });
  const elapsed = Date.now() - started;
  check('a redirected document releases every in-flight request id', page.inflight === 0,
    JSON.stringify({ inflight: page.inflight, completions: page.completions }));
  check('redirect settling completes before the timeout fallback', elapsed < 1000,
    `settle took ${elapsed}ms`);

  const action = observation.actions.find(entry => entry.name === 'Old name');
  await page.evaluateJson('(()=>{document.querySelector("#target").textContent="New name";return true})()');
  const clicked = await page.click(action.key, action.cssFallback);
  check('a CSS fallback reports its provenance to the crawler', clicked.ok && clicked.via === 'css',
    JSON.stringify(clicked));
} catch (error) {
  check('browser regression setup completes', false, error?.stack || String(error));
} finally {
  try { if (page) await page.close(); } catch { /* closing anyway */ }
  try { if (browser) await browser.close(); } catch { /* closing anyway */ }
  await new Promise(resolve => server.close(resolve));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
