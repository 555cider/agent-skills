/**
 * Assertions over a crawl of `/shell` — an app whose URL never moves and whose every
 * screen change is a plain button. Before these fixes the crawl merged the folder screen
 * into home (same landmarks, same fields), failed every action queued after an in-place
 * state change as `not-found`, dropped the `?mode=empty` entrypoint's query, built names
 * the page's own accessible names did not match, and could not route to any screen at all
 * because every route was `/shell`.
 *
 * Run: node assert-shell.mjs --map <map.json> --cli <screen-map.mjs> --dir <.screen-map dir>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const map = JSON.parse(readFileSync(args.get('map'), 'utf8'));
const cli = args.get('cli');
const dir = args.get('dir');

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
function query(...argv) {
  try {
    return { code: 0, json: JSON.parse(execFileSync(process.execPath, [cli, ...argv, '--dir', dir], { encoding: 'utf8' })) };
  } catch (error) {
    let json = null;
    try { json = JSON.parse(error.stdout); } catch { /* not JSON */ }
    return { code: error.status, json };
  }
}

const titled = title => map.states.filter(state => state.title === title);
const home = titled('셸 홈').find(state => state.route === '/shell');
const folder = map.states.find(state => (state.evidence.chrome || []).includes('폴더 메뉴'));
const leaf = map.states.find(state => (state.evidence.chrome || []).includes('항목 메뉴'));
const settings = titled('셸 설정')[0];

check('the crawl finished', !map.run.budgetHit && map.coverage.frontier.length === 0,
  JSON.stringify({ budgetHit: map.run.budgetHit, frontier: map.coverage.frontier }));
check('the run records that it replayed mutating steps', map.run.replayMutating === true);

// ---------- identity ----------

check('home and a folder are two screens although their landmarks and fields match',
  !!home && !!folder && home.id !== folder.id && home.signature !== folder.signature,
  JSON.stringify(map.states.map(state => [state.id, state.title, state.evidence.chrome])));
check('the header verbs that told them apart are in the evidence',
  JSON.stringify(home?.evidence.chrome) === JSON.stringify(['새 폴더', '설정']),
  JSON.stringify(home?.evidence.chrome));
check('the folder, its leaf and settings are all mapped', !!folder && !!leaf && !!settings,
  JSON.stringify(map.states.map(state => state.title)));

// ---------- reaching past a mutating step ----------

const leafEdge = map.transitions.find(transition => transition.action.name === '첫 항목 열기');
check('a screen two button presses deep had its own actions executed',
  leafEdge?.status === 'verified' && leafEdge.to === leaf?.id,
  JSON.stringify({ status: leafEdge?.status, reason: leafEdge?.blockedReason }));

// ---------- in-place state change ----------

check('no action failed as not-found after "모두 잠금" renamed the rows in place',
  !map.transitions.some(transition => /not-found/.test(transition.blockedReason || '')),
  JSON.stringify(map.transitions.filter(transition => /not-found/.test(transition.blockedReason || ''))
    .map(transition => transition.action.name)));
check('the fresh re-entry that recovered them is visible in the timing',
  map.run.timing.phases.some(phase => phase.label === 'reach.fresh-retry'),
  JSON.stringify(map.run.timing.phases.map(phase => phase.label)));

// ---------- names ----------

const row = map.transitions.find(transition => /^서류/.test(transition.action.name || ''));
check('a row name carries its icon label the way the accessible name does',
  row?.action.name === '서류 항목 2', JSON.stringify(row?.action.name));

// ---------- fixture query ----------

const emptyHome = map.states.find(state => state.route === '/shell?mode=empty');
check('an identityQuery parameter keeps the fixture entrypoint a screen of its own',
  !!emptyHome && emptyHome.id !== home?.id && emptyHome.evidence.urlSample === '/shell?mode=empty',
  JSON.stringify(map.states.map(state => state.route)));

// ---------- queries ----------

const all = query('route', '--all');
check('route --all answers', all.code === 0 && Array.isArray(all.json?.screens), JSON.stringify(all.json)?.slice(0, 300));
check('route --all lists every screen, each reachable',
  all.json?.screens.length === map.states.length && all.json.screens.every(screen => screen.reachable),
  JSON.stringify(all.json?.screens.filter(screen => !screen.reachable)));
check('route --all says which paths press mutating controls, and warns once',
  all.json?.screens.some(screen => screen.mutatingSteps > 0)
    && all.json.notes.some(note => /replayMutating/.test(note)),
  JSON.stringify(all.json?.notes));

const byId = query('route', '--to', leaf?.id || 's0');
check('route --to takes a state id when every screen shares one route',
  byId.code === 0 && byId.json?.steps.length === 3 && byId.json.title === '항목',
  JSON.stringify({ code: byId.code, steps: byId.json?.steps?.length, title: byId.json?.title }));
const shared = query('route', '--to', '/shell');
check('a bare shared route still answers with the entrypoint, as before', shared.code === 0 && shared.json?.steps.length === 1,
  JSON.stringify({ code: shared.code, steps: shared.json?.steps?.length }));

const sheet = map.states.find(state => state.route === '/shell' && state.kind === 'overlay');
const fromSheet = query('route', '--to', folder?.id || 's0', '--from', sheet?.id || 's0');
const fromSteps = fromSheet.json?.steps || [];
const sheetRow = fromSteps.find(step => /서류|사진/.test(step.name || ''));
check('a step taken inside the open sheet is scoped to the dialog, not to two same-named rows',
  /^await page\.getByRole\('dialog'\)\.getByRole\('button'/.test(sheetRow?.playwright || ''),
  JSON.stringify({ code: fromSheet.code, steps: fromSteps.map(step => step.playwright) }));
check('a path from a screen the URL cannot open first walks there from an entrypoint',
  fromSteps[0]?.kind === 'goto' && fromSteps[1]?.name === '전체 보기' && fromSteps[2] === sheetRow,
  JSON.stringify(fromSteps.map(step => step.name || step.kind)));
const counted = all.json?.screens.flatMap(screen => screen.steps || []).find(step => /서류/.test(step.name || ''));
// Run the generated pattern against the names the row can have, rather than pin its spelling.
const countedSource = (counted?.playwright || '').match(/name: \/(.*)\/ \}/)?.[1];
const countedRe = countedSource ? new RegExp(countedSource) : null;
check('a name holding a count is matched with the count free',
  !!countedRe && countedRe.test('서류 항목 2') && countedRe.test('서류 항목 17') && !countedRe.test('서류 항목 열기'),
  counted?.playwright);

const refused = query('verify', '--to', leaf?.id || 's0');
check('verify will not press mutating steps it was not given --allow-mutating for',
  refused.code === 3 && /--allow-mutating/.test(refused.json?.error || refused.json?.reason || JSON.stringify(refused.json)),
  JSON.stringify(refused.json)?.slice(0, 300));
const verify = query('verify', '--to', leaf?.id || 's0', '--allow-mutating');
check('verify replays a state id route in a browser and lands on that screen',
  verify.code === 0 && verify.json?.reached === true, JSON.stringify(verify.json)?.slice(0, 300));
const lookup = query('state', '--route', '/shell?mode=empty&utm=x');
check('a lookup keeps the identity parameter and drops the rest',
  lookup.code === 0 && lookup.json?.states?.every(state => state.route === '/shell?mode=empty'),
  JSON.stringify(lookup.json)?.slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
