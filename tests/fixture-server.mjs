/**
 * Fixture app for the screen-map regression suite.
 *
 * It counts every state-changing hit it receives, which is how the tests prove a
 * negative: the crawler must leave `delete` at zero because it never pressed the
 * destructive button.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixture');

// Every one of these must stay at zero for the crawl to have behaved: each counts a
// side effect the skill promises never to cause on its own.
const COUNTERS = ['delete', 'submit', 'confirmed', 'download', 'login', 'external'];
const counters = {};

/** The only credentials that open `/dashboard`. The tests pass them in through `${VAR}`. */
const LOGIN = { email: 'crawler@example.invalid', password: 'hunter2' };
// Badge counts drift between visits in every real app. The home page renders one so
// the suite proves an action key survives its own label changing.
let visits = 0;
// The other half of that story: a label that drifts in *words*, which no amount of
// numeric-token dropping can normalize. The crawler harvests a screen only the first
// time it sees it, so the first render carries one wording and every later render the
// other — by the time the crawl comes back to click, the stored key cannot match.
let itemsVisits = 0;
let wizardVisits = 0;
// A second listener on another port, so "off-origin" is a real origin rather than an
// unreachable hostname the crawl would fail to load for the wrong reason.
let externalPort = null;

/** Per-run fixture state. The suite crawls this one server several times over. */
function reset() {
  for (const name of Object.keys(counters)) delete counters[name];
  for (const name of COUNTERS) counters[name] = 0;
  visits = 0;
  itemsVisits = 0;
  wizardVisits = 0;
}
reset();

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function page(name) {
  return readFileSync(join(FIXTURE, name), 'utf8');
}

function readBody(req, done) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => done(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'POST' && path === '/__click') {
    const name = url.searchParams.get('name') || 'unknown';
    counters[name] = (counters[name] || 0) + 1;
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }
  if (req.method === 'POST' && path === '/__reset') {
    reset();
    return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
  }
  if (path === '/__clicks') {
    return send(res, 200, JSON.stringify(counters), 'application/json');
  }
  if (req.method === 'POST' && path === '/items') {
    counters.submit += 1;
    res.writeHead(303, { location: '/items' });
    return res.end();
  }
  // A session behind a real credential check, so `auth.steps` is exercised end to end
  // rather than mocked: wrong credentials come back to the form, right ones set the
  // cookie that `storage-state.json` has to carry.
  if (req.method === 'POST' && path === '/login') {
    return readBody(req, body => {
      const form = new URLSearchParams(body);
      if (form.get('email') !== LOGIN.email || form.get('password') !== LOGIN.password) {
        res.writeHead(303, { location: '/login?bad=1' });
        return res.end();
      }
      counters.login += 1;
      res.writeHead(303, { location: '/dashboard', 'set-cookie': 'sid=ok; Path=/' });
      return res.end();
    });
  }
  if (req.method === 'GET' && path === '/external-redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${externalPort}/landed` });
    return res.end();
  }

  if (req.method !== 'GET') return send(res, 405, 'method not allowed');

  if (path === '/login') return send(res, 200, page('login.html'));
  if (path === '/dashboard') {
    if (!/(^|;\s*)sid=ok(;|$)/.test(req.headers.cookie || '')) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    return send(res, 200, page('dashboard.html'));
  }

  if (path === '/') {
    visits += 1;
    return send(res, 200, page('index.html').replace('{{VISITS}}', String(visits)));
  }
  // A request that reaches the server and changes nothing on screen. It exists so the
  // crawl can be shown to tell that apart from a control wired to nothing at all; it
  // counts nothing, so no other test's arithmetic moves when it is hit.
  if (path === '/api/ping') return send(res, 200, '{"ok":true}', 'application/json');
  if (path === '/gated') return send(res, 200, page('gated.html'));
  if (path === '/items') {
    itemsVisits += 1;
    return send(res, 200, page('items.html').replace('{{STASH}}', itemsVisits === 1 ? '비어 있음' : '항목 있음'));
  }
  if (/^\/items\/\d+$/.test(path)) return send(res, 200, page('item.html'));
  if (path === '/cart') return send(res, 200, page('cart.html'));
  if (path === '/hazards') return send(res, 200, page('hazards.html'));
  if (path === '/leaf') return send(res, 200, page('leaf.html'));
  // Visited once and it is never that screen again. The crawl therefore cannot replay
  // its way back, which is the case `replayFailures` exists to stop paying for.
  if (path === '/wizard') {
    wizardVisits += 1;
    return send(res, 200, page(wizardVisits === 1 ? 'wizard.html' : 'wizard-done.html'));
  }
  if (path === '/report.csv') {
    counters.download += 1;
    return send(res, 200, 'id,name\n1,상품 A\n', 'text/csv; charset=utf-8');
  }
  if (path === '/new') return send(res, 200, page('new.html'));
  return send(res, 404, '<h1>없는 화면</h1>');
});

const externalServer = createServer((_req, res) => {
  counters.external += 1;
  return send(res, 200, '<main><h1>허용되지 않은 출처</h1></main>');
});

const portFileIndex = process.argv.indexOf('--port-file');
externalServer.listen(0, '127.0.0.1', () => {
  externalPort = externalServer.address().port;
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    if (portFileIndex >= 0) writeFileSync(process.argv[portFileIndex + 1], String(port));
    process.stdout.write(`PORT=${port}\n`);
  });
});
