/** Browser-driver regressions that need real CDP events but not a full crawl. */

import { createServer } from 'node:http';

import { launchBrowser, Page } from '../scripts/browser.mjs';

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
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
