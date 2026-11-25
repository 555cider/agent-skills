/** End-to-end checks of the query surface against a crawled fixture map. */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function cli(...argv) { return cliWith({}, ...argv); }

/** `env` entries set to `undefined` are removed, so a test can run as if outside Git Bash. */
function cliWith(env, ...argv) {
  const merged = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key]; else merged[key] = value;
  }
  const target = argv.includes('--map') ? [] : ['--map', mapPath];
  try {
    const stdout = execFileSync('node', [CLI, ...argv, ...target], { encoding: 'utf8', env: merged });
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
check('route to a reachable screen starts with a goto, ends there, and runs only safe steps',
  route.code === 0 && route.json?.ok === true && route.json.steps[0]?.kind === 'goto'
    && route.json.steps.at(-1)?.to === '/cart'
    && route.json.steps.slice(1).every(step => step.class === 'safe')
    && route.json.playwright?.includes('page.goto(') && route.json.confidence === 'fresh',
  JSON.stringify(route.json));

const detailRoute = cli('route', '--to', '/items/:id');
const duplicateNameStep = (detailRoute.json?.steps || []).find(step => step.name === '상품 보기');
check('same-name links keep their href-qualified Playwright locator through crawl and query',
  duplicateNameStep?.playwright?.includes('.and(page.locator(')
    && duplicateNameStep.playwright.includes('[href="/items/'),
  JSON.stringify(duplicateNameStep));

const missing = cli('route', '--to', '/does-not-exist');
check('an unknown route answers "no" and lists what is known, with no shell hint',
  missing.code === 1 && missing.json?.known?.includes('/items') && missing.json?.hint === undefined,
  JSON.stringify(missing.json));

// ---------- actions ----------

const actions = cli('actions', '--route', '/items/:id');
const detail = actions.json?.screens?.[0]?.actions || [];
const del = detail.find(action => action.name === '삭제');
check('actions reports the destructive edge with its reason, and a locator for each edge',
  del?.class === 'destructive' && del?.status === 'unexplored' && !!del?.blockedReason
    && detail.every(action => typeof action.playwright === 'string' && action.playwright.length > 0),
  JSON.stringify(del));

// ---------- verify (browser) ----------
//
// verify used to run its own search: no `--from`, and edges seen to land in two places
// were allowed. It could then prove a path route never hands out.
const routedFrom = cli('route', '--to', '/cart', '--from', '/items');
const verifiedFrom = cli('verify', '--to', '/cart', '--from', '/items');
const routedIds = (routedFrom.json?.steps || []).slice(1).map(step => step.transition);
const walkedIds = (verifiedFrom.json?.walked || []).map(step => step.transition);
check('verify --from walks in a real browser exactly the path route --from hands out',
  routedFrom.code === 0 && verifiedFrom.json?.reached === true
    && routedIds.length > 0 && JSON.stringify(walkedIds) === JSON.stringify(routedIds),
  JSON.stringify({ routed: routedIds, walked: walkedIds, verify: verifiedFrom.json?.detail }));

// ---------- --from starts at the page, not at a menu left open ----------
//
// An overlay shares its page's route. Picking it as the origin hands back a first step that
// assumes a dropdown the caller does not have open.
{
  // Outside the app repository: an untracked file there would make the map below stale.
  const dir = mkdtempSync(join(tmpdir(), 'screen-map-synthetic-'));
  const stamp = { source: 'crawl', commit: null, recordedAt: null, lastObservedCommit: null, lastObservedAt: null };
  const screen = (id, route, kind) => ({ id, ...stamp, route, signature: 'h:' + id, kind, title: route, evidence: { urlSample: route } });
  const edge = (id, from, to, name) => ({
    id, ...stamp, from, to, class: 'safe', classifiedBy: 'test', status: 'verified',
    action: { kind: 'click', role: 'link', name, key: 'click:link:' + name, cssFallback: null },
  });
  const synthetic = {
    schema: 2, app: { baseUrl: 'http://127.0.0.1:1', commit: null },
    run: { finishedAt: null, budgetHit: null },
    states: [screen('s0', '/a', 'page'), screen('s1', '/a', 'overlay'), screen('s2', '/b', 'page')],
    transitions: [edge('t0', 's0', 's1', 'menu'), edge('t1', 's1', 's2', 'b')],
    entrypoints: ['s0'],
  };
  const syntheticMap = join(dir, 'map.json');
  writeFileSync(syntheticMap, JSON.stringify(synthetic));
  const fromPage = cli('route', '--to', '/b', '--from', '/a', '--map', syntheticMap);
  check('route --from starts at the page screen, not the overlay that shares its route',
    fromPage.code === 0 && JSON.stringify((fromPage.json?.steps || []).slice(1).map(step => step.transition)) === '["t0","t1"]',
    JSON.stringify(fromPage.json?.steps || fromPage.json));
  rmSync(dir, { recursive: true, force: true });
}

// ---------- invalidate downgrades and nothing else ----------

const before = JSON.parse(readFileSync(mapPath, 'utf8'));
const victim = before.transitions.find(transition => transition.status === 'verified');
const invalidate = cli('invalidate', '--transition', victim.id, '--reason', 'selector drifted');
const after = JSON.parse(readFileSync(mapPath, 'utf8'));
check('invalidate downgrades the transition and adds nothing',
  invalidate.code === 0 && after.transitions.find(transition => transition.id === victim.id)?.status === 'failed'
    && after.states.length === before.states.length && after.transitions.length === before.transitions.length,
  JSON.stringify({ states: after.states.length, transitions: after.transitions.length }));
check('invalidate rewrites map.md so the human copy stops offering the step',
  readFileSync(join(appDir, '.screen-map', 'map.md'), 'utf8').includes('selector drifted'),
  JSON.stringify(invalidate.json));

// ---------- the shell rewrote the argument ----------
//
// Git Bash turns a lone `/settings` into `C:/Program Files/Git/settings` before Node
// sees it. Under Git Bash (`MSYSTEM` set) the rewrite is undone; elsewhere the failure
// blames the shell rather than the map.

const rewritten = cliWith({ MSYSTEM: undefined, EXEPATH: undefined }, 'route', '--to', 'C:/Program Files/Git/settings');
check('outside Git Bash a rewritten route argument fails with a hint about the shell',
  rewritten.code === 1 && /MSYS_NO_PATHCONV|without a leading slash/.test(rewritten.json?.hint || ''),
  JSON.stringify(rewritten.json));
const undone = cliWith({ MSYSTEM: 'MINGW64', EXEPATH: String.raw`C:\Program Files\Git\bin` },
  'route', '--to', 'C:/Program Files/Git/cart', '--from', 'C:/Program Files/Git/items');
check('under Git Bash a rewritten --to and --from are turned back into routes',
  undone.code === 0 && undone.json?.to === '/cart' && undone.json?.steps?.[0]?.state === '/items',
  JSON.stringify(undone.json?.steps?.[0] || undone.json));

// ---------- staleness ----------

git('add', '.screen-map/map.json', '.screen-map/map.md');
git('commit', '-q', '-m', 'record screen map');
const committedMap = cli('status');
check('committing only generated map artifacts keeps the snapshot fresh',
  committedMap.json?.status === 'fresh', JSON.stringify(committedMap.json));

appendFileSync(join(appDir, 'README.md'), 'source changed\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'app moved on');
const staleRoute = cli('route', '--to', '/items');
check('a map whose app commit moved still answers, but flags its confidence as stale',
  staleRoute.code === 0 && staleRoute.json?.confidence === 'stale', JSON.stringify(staleRoute.json?.confidence));

const unavailable = JSON.parse(readFileSync(mapPath, 'utf8'));
unavailable.app.commit = '0000000000000000000000000000000000000000';
writeFileSync(mapPath, JSON.stringify(unavailable, null, 2));
const unknown = cli('status');
check('status is unknown when the recorded commit is unavailable',
  unknown.json?.status === 'unknown', JSON.stringify(unknown.json));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
