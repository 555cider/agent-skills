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

const counters = { delete: 0, submit: 0, external: 0 };
// Badge counts drift between visits in every real app. The home page renders one so
// the suite proves an action key survives its own label changing.
let visits = 0;
let externalPort = null;

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function page(name) {
  return readFileSync(join(FIXTURE, name), 'utf8');
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'POST' && path === '/__click') {
    const name = url.searchParams.get('name') || 'unknown';
    counters[name] = (counters[name] || 0) + 1;
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
  if (req.method === 'GET' && path === '/external-redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${externalPort}/landed` });
    return res.end();
  }

  if (req.method !== 'GET') return send(res, 405, 'method not allowed');

  if (path === '/') {
    visits += 1;
    return send(res, 200, page('index.html').replace('{{VISITS}}', String(visits)));
  }
  if (path === '/gated') return send(res, 200, page('gated.html'));
  if (path === '/items') return send(res, 200, page('items.html'));
  if (/^\/items\/\d+$/.test(path)) return send(res, 200, page('item.html'));
  if (path === '/cart') return send(res, 200, page('cart.html'));
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
