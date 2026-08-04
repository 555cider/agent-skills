/** End-to-end checks of the query surface against a crawled fixture map. */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'screen-map.mjs');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const appDir = args.get('app');
const mapPath = join(appDir, '.screen-map', 'map.json');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

function cli(...argv) {
  try {
    const stdout = execFileSync('node', [CLI, ...argv, '--map', mapPath], { encoding: 'utf8' });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (error) {
    let json = null;
    try { json = JSON.parse(error.stdout || 'null'); } catch { /* non-JSON failure */ }
    return { code: error.status ?? 2, json, stderr: error.stderr };
  }
}

function git(...argv) {
  return execFileSync('git', ['-C', appDir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// ---------- route ----------

const route = cli('route', '--to', '/cart');
check('route to a reachable screen succeeds', route.code === 0 && route.json?.ok === true, JSON.stringify(route.json));
check('route ends on the requested screen',
  route.json?.steps?.at(-1)?.to === '/cart', JSON.stringify(route.json?.steps?.at(-1)));
check('route starts with a goto', route.json?.steps?.[0]?.kind === 'goto');
check('every routed step is safe',
  (route.json?.steps || []).slice(1).every(step => step.class === 'safe'),
  JSON.stringify((route.json?.steps || []).map(step => step.class)));
check('route ships a pasteable Playwright snippet',
  typeof route.json?.playwright === 'string' && route.json.playwright.includes('page.goto('));
check('a fresh map reports fresh confidence', route.json?.confidence === 'fresh', JSON.stringify(route.json?.confidence));

const detailRoute = cli('route', '--to', '/items/:id');
const duplicateNameStep = (detailRoute.json?.steps || []).find(step => step.name === '상품 보기');
check('same-name links keep their href-qualified Playwright locator through crawl and query',
  duplicateNameStep?.playwright?.includes('.and(page.locator(')
    && duplicateNameStep.playwright.includes('[href="/items/'),
  JSON.stringify(duplicateNameStep));

const missing = cli('route', '--to', '/does-not-exist');
check('an unknown route answers "no" rather than erroring', missing.code === 1, 'exit ' + missing.code);
check('an unknown route lists what is known', Array.isArray(missing.json?.known) && missing.json.known.includes('/items'));

// ---------- state / actions ----------

const state = cli('state', '--route', '/items');
check('state returns both the page and its dialog', state.json?.states?.length === 2,
  JSON.stringify(state.json?.states?.map(entry => entry.kind)));

const actions = cli('actions', '--route', '/items/:id');
const detail = actions.json?.screens?.[0]?.actions || [];
const del = detail.find(action => action.name === '삭제');
check('actions reports the destructive edge with its reason',
  del?.class === 'destructive' && del?.status === 'unexplored' && !!del?.blockedReason,
  JSON.stringify(del));
check('actions ships a Playwright locator for each edge',
  detail.every(action => typeof action.playwright === 'string' && action.playwright.length > 0));

// ---------- verify (browser) ----------

const verify = cli('verify', '--to', '/cart');
check('the stored route still walks end to end in a real browser',
  verify.code === 0 && verify.json?.reached === true, JSON.stringify(verify.json));

// ---------- report ----------

const reportPath = join(appDir, '.screen-map', 'generated.md');
const report = cli('report', '--out', reportPath);
check('report writes a markdown summary', report.code === 0 && existsSync(reportPath));
const markdown = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
check('the summary names the screens', markdown.includes('/items/:id'));
check('the summary calls out what was not executed', markdown.includes('## Not executed') && markdown.includes('삭제'));
if (existsSync(reportPath)) unlinkSync(reportPath);

// ---------- invalidate downgrades and nothing else ----------

const before = JSON.parse(readFileSync(mapPath, 'utf8'));
const victim = before.transitions.find(transition => transition.status === 'verified');
const invalidate = cli('invalidate', '--transition', victim.id, '--reason', 'selector drifted');
const after = JSON.parse(readFileSync(mapPath, 'utf8'));
check('invalidate succeeds', invalidate.code === 0 && invalidate.json?.ok === true);
check('invalidate downgrades the transition',
  after.transitions.find(transition => transition.id === victim.id)?.status === 'failed');
check('invalidate never adds states or transitions',
  after.states.length === before.states.length && after.transitions.length === before.transitions.length,
  JSON.stringify({ states: after.states.length, transitions: after.transitions.length }));

// ---------- staleness ----------

const fresh = cli('status');
check('status is fresh right after a crawl', fresh.json?.status === 'fresh', JSON.stringify(fresh.json));

git('add', '.screen-map/map.json', '.screen-map/map.md');
git('commit', '-q', '-m', 'record screen map');
const committedMap = cli('status');
check('committing only generated map artifacts keeps the snapshot fresh',
  committedMap.json?.status === 'fresh', JSON.stringify(committedMap.json));

appendFileSync(join(appDir, 'README.md'), 'source changed\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'app moved on');
const stale = cli('status');
check('status turns stale when the app commit moves', stale.json?.status === 'stale', JSON.stringify(stale.json));
check('status explains why it is stale', typeof stale.json?.detail === 'string' && stale.json.detail.includes('moved'));

const staleRoute = cli('route', '--to', '/items');
check('a stale map still answers, but flags its confidence', staleRoute.json?.confidence === 'stale');
check('a stale route tells the agent what to do on failure',
  (staleRoute.json?.notes || []).some(note => note.includes('discard')));

const unavailable = JSON.parse(readFileSync(mapPath, 'utf8'));
unavailable.app.commit = '0000000000000000000000000000000000000000';
writeFileSync(mapPath, JSON.stringify(unavailable, null, 2));
const unknown = cli('status');
check('status is unknown when the recorded commit is unavailable',
  unknown.json?.status === 'unknown', JSON.stringify(unknown.json));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
