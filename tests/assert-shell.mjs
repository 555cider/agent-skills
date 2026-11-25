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

check('the crawl finished, replaying mutating steps as configured',
  !map.run.budgetHit && map.coverage.frontier.length === 0 && map.run.replayMutating === true,
  JSON.stringify({ budgetHit: map.run.budgetHit, frontier: map.coverage.frontier }));

// ---------- identity ----------

check('home and a folder are two screens although their landmarks and fields match, told apart by header verbs',
  !!home && !!folder && home.signature !== folder.signature
    && JSON.stringify(home.evidence.chrome) === JSON.stringify(['새 폴더', '설정']) && !!leaf && !!settings,
  JSON.stringify(map.states.map(state => [state.id, state.title, state.evidence.chrome])));
const emptyHome = map.states.find(state => state.route === '/shell?mode=empty');
check('an identityQuery parameter keeps the fixture entrypoint a screen of its own',
  !!emptyHome && emptyHome.id !== home?.id && emptyHome.evidence.urlSample === '/shell?mode=empty',
  JSON.stringify(map.states.map(state => state.route)));

// ---------- reaching past a mutating step, and an in-place state change ----------

const leafEdge = map.transitions.find(transition => transition.action.name === '첫 항목 열기');
check('a screen two button presses deep had its own actions executed',
  leafEdge?.status === 'verified' && leafEdge.to === leaf?.id,
  JSON.stringify({ status: leafEdge?.status, reason: leafEdge?.blockedReason }));
check('no action failed as not-found after "모두 잠금" renamed the rows in place, thanks to a fresh re-entry',
  !map.transitions.some(transition => /not-found/.test(transition.blockedReason || ''))
    && map.run.timing.phases.some(phase => phase.label === 'reach.fresh-retry'),
  JSON.stringify(map.transitions.filter(transition => /not-found/.test(transition.blockedReason || ''))
    .map(transition => transition.action.name)));
const row = map.transitions.find(transition => /^서류/.test(transition.action.name || ''));
check('a row name carries its icon label the way the accessible name does',
  row?.action.name === '서류 항목 2', JSON.stringify(row?.action.name));

// ---------- queries ----------

const all = query('route', '--all');
check('route --all lists every screen, each reachable, and warns about mutating steps',
  all.code === 0 && all.json?.screens.length === map.states.length && all.json.screens.every(screen => screen.reachable)
    && all.json.screens.some(screen => screen.mutatingSteps > 0) && all.json.notes.some(note => /replayMutating/.test(note)),
  JSON.stringify(all.json)?.slice(0, 300));
const counted = all.json?.screens.flatMap(screen => screen.steps || []).find(step => /서류/.test(step.name || ''));
// Run the generated pattern against the names the row can have, rather than pin its spelling.
const countedSource = (counted?.playwright || '').match(/name: \/(.*)\/ \}/)?.[1];
const countedRe = countedSource ? new RegExp(countedSource) : null;
check('a name holding a count is matched with the count free',
  !!countedRe && countedRe.test('서류 항목 2') && countedRe.test('서류 항목 17') && !countedRe.test('서류 항목 열기'),
  counted?.playwright);

const byId = query('route', '--to', leaf?.id || 's0');
check('route --to takes a state id when every screen shares one route',
  byId.code === 0 && byId.json?.steps.length === 3 && byId.json.title === '항목',
  JSON.stringify({ code: byId.code, steps: byId.json?.steps?.length, title: byId.json?.title }));

const sheet = map.states.find(state => state.route === '/shell' && state.kind === 'overlay');
const fromSheet = query('route', '--to', folder?.id || 's0', '--from', sheet?.id || 's0');
const fromSteps = fromSheet.json?.steps || [];
const sheetRow = fromSteps.find(step => /서류|사진/.test(step.name || ''));
check('a path from a sheet the URL cannot open walks there first, then scopes its step to the dialog',
  /^await page\.getByRole\('dialog'\)\.getByRole\('button'/.test(sheetRow?.playwright || '')
    && fromSteps[0]?.kind === 'goto' && fromSteps[1]?.name === '전체 보기' && fromSteps[2] === sheetRow,
  JSON.stringify({ code: fromSheet.code, steps: fromSteps.map(step => step.playwright || step.kind) }));

const refused = query('verify', '--to', leaf?.id || 's0');
check('verify will not press mutating steps it was not given --allow-mutating for',
  refused.code === 3, JSON.stringify(refused.json)?.slice(0, 300));
const verify = query('verify', '--to', leaf?.id || 's0', '--allow-mutating');
check('verify replays a state id route in a browser and lands on that screen',
  verify.code === 0 && verify.json?.reached === true, JSON.stringify(verify.json)?.slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
