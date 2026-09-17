import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'ui-copy-policy-'));
const fixture = readFileSync(new URL('./fixtures/copy-conventions.html', import.meta.url));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const nounStyle of [false, true]) {
    const config = join(root, `${nounStyle}.json`);
    const output = join(root, `${nounStyle}`);
    writeFileSync(config, JSON.stringify({ routes: ['/'], viewports: [{ name: 'desktop', width: 1280, height: 900, isMobile: false, dpr: 1 }],
      themes: ['light'], states: ['default'], scrollPositions: ['top'], adaptations: [],
      auditConfig: { maxPolish: 100, copy: { koButtonNounStyle: nounStyle } } }));
    const run = spawn(process.execPath, [fileURLToPath(new URL('../scripts/audit-chrome.mjs', import.meta.url)),
      `http://127.0.0.1:${server.address().port}`, '--config', config, '--out-dir', output, '--no-screenshots'],
      { env: { ...process.env, UI_AUDIT_SETTLE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    run.stdout.on('data', chunk => { log += chunk; });
    run.stderr.on('data', chunk => { log += chunk; });
    const code = await new Promise((resolve, reject) => { run.on('error', reject); run.on('close', resolve); });
    assert.ok(code === 0 || code === 1, log);
    const report = JSON.parse(readFileSync(join(output, 'advisories.json'), 'utf8'));
    const entries = Array.isArray(report) ? report : report.advisories;
    assert.ok(Array.isArray(entries), JSON.stringify(report).slice(0, 200));
    const wording = entries.filter(item => item.rule === 'koreanButtonVerbForm');
    if (!nounStyle) assert.equal(wording.length, 0, 'default must respect Korean verb labels');
    else {
      assert.ok(wording.some(item => JSON.stringify(item).includes('bad-gi')), 'opt-in detects the configured noun convention');
      assert.ok(!wording.some(item => JSON.stringify(item).includes('bad-more')), 'natural 더보기 remains accepted');
      assert.ok(!wording.some(item => /short English|Use .More|Use .Close/.test(item.fix)), 'never replace product language');
    }
  }
  console.log('PASS Korean copy policy: default and explicit noun convention');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
