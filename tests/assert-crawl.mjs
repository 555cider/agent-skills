/** Assertions over a map produced by crawling the fixture app. */

import { readFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}

const map = JSON.parse(readFileSync(args.get('map'), 'utf8'));
const base = args.get('base');
const mode = args.get('mode') || 'default';
const clicks = await (await fetch(base + '/__clicks')).json();

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

const routes = map.states.map(state => state.route).sort();
const byRoute = route => map.states.filter(state => state.route === route);
const transitionsNamed = name => map.transitions.filter(transition => transition.action.name === name);
const stateOf = id => map.states.find(state => state.id === id);

// ---------- node identity ----------

check('every fixture screen is mapped',
  ['/', '/items', '/items/:id', '/cart', '/new'].every(route => routes.includes(route)),
  'routes: ' + JSON.stringify(routes));

check('/items/1, /items/2 and /items/3 collapse into one node',
  byRoute('/items/:id').length === 1,
  'got ' + byRoute('/items/:id').length + ' nodes for /items/:id');

check('the open filter dialog is its own node',
  byRoute('/items').length === 2 && byRoute('/items').some(state => state.kind === 'overlay'),
  'states at /items: ' + JSON.stringify(byRoute('/items').map(state => state.kind)));

// The defect real-app validation caught: a dropdown marks the page aria-hidden, so
// without overlay detection every route grew a phantom "empty screen" node.
const menuState = map.states.find(state => state.kind === 'overlay' && state.evidence.overlay?.role === 'menu');
check('a dropdown that aria-hides the page is recognized as an overlay, not a blank screen',
  !!menuState && menuState.route === '/', JSON.stringify(menuState && { route: menuState.route, title: menuState.title }));
check('no screen was recorded mid-render',
  map.states.every(state => state.evidence.landmarks.length > 0 || state.evidence.headings.length > 0),
  JSON.stringify(map.states.filter(state => !state.evidence.landmarks.length && !state.evidence.headings.length)
    .map(state => state.route)));

check('the detail screen keeps a concrete url sample',
  /^\/items\/\d+$/.test(byRoute('/items/:id')[0]?.evidence.urlSample || ''),
  JSON.stringify(byRoute('/items/:id')[0]?.evidence.urlSample));

// ---------- fail-closed policy ----------

const del = transitionsNamed('삭제')[0];
check('the delete button is recorded as an edge', !!del);
check('the delete button is classified destructive', del?.class === 'destructive', JSON.stringify(del?.class));
check('the delete button was never executed', del?.status === 'unexplored', JSON.stringify(del?.status));
check('the delete button was never actually clicked in the browser', clicks.delete === 0,
  'server counted ' + clicks.delete + ' delete clicks');

const save = transitionsNamed('저장')[0];
check('the form submit is classified mutating', save?.class === 'mutating', JSON.stringify(save?.class));
if (mode === 'mutating') {
  check('with --allow-mutating the form submit runs', save?.status === 'verified', JSON.stringify(save?.status));
  check('the server saw the submit', clicks.submit >= 1, 'submit count ' + clicks.submit);
  check('the destructive button stays untouched even with --allow-mutating', clicks.delete === 0);
} else {
  check('without --allow-mutating the form submit is left alone', save?.status === 'unexplored', JSON.stringify(save?.status));
  check('the server never saw a submit', clicks.submit === 0, 'submit count ' + clicks.submit);
}

const external = transitionsNamed('외부 문서')[0];
check('the external link is recorded', !!external);
check('the external link is never followed',
  external?.status === 'blocked' && external?.blockedReason === 'external-origin',
  JSON.stringify({ status: external?.status, reason: external?.blockedReason }));

const redirectedExternal = transitionsNamed('외부 리다이렉트')[0];
check('a same-origin link that redirects away is recorded', !!redirectedExternal);
check('an external redirect is blocked before it becomes a transition target',
  redirectedExternal?.status === 'blocked' && redirectedExternal?.blockedReason === 'external-origin',
  JSON.stringify({ status: redirectedExternal?.status, reason: redirectedExternal?.blockedReason }));
check('the blocked external origin receives no document request', clicks.external === 0,
  'external server counted ' + clicks.external + ' requests');

// ---------- modal scoping ----------

const dialogState = byRoute('/items').find(state => state.kind === 'overlay');
const fromDialog = map.transitions.filter(transition => transition.from === dialogState?.id);
check('a modal hides the inert background from the crawl',
  fromDialog.length > 0 && fromDialog.every(transition => transition.action.name === '닫기'),
  'dialog actions: ' + JSON.stringify(fromDialog.map(transition => transition.action.name)));

const fromMenu = map.transitions.filter(transition => transition.from === menuState?.id)
  .map(transition => transition.action.name).sort();
check('an open dropdown scopes the crawl to its own items',
  JSON.stringify(fromMenu) === JSON.stringify(['닫기', '장바구니']),
  'menu actions: ' + JSON.stringify(fromMenu));

// ---------- list sampling is capped, and says so ----------

const listLinks = map.transitions.filter(transition =>
  stateOf(transition.from)?.route === '/items' && transition.action.kind === 'link'
  && /^\/items\/\d+$/.test(new URL(transition.action.href || 'http://x/').pathname));
const walkedLinks = listLinks.filter(transition => transition.status === 'verified');
const sampledLinks = listLinks.filter(transition => transition.status === 'sampled');

check('all five list items are recorded as edges', listLinks.length === 5, 'got ' + listLinks.length);
check('only the sample size is actually walked', walkedLinks.length === 3, 'walked ' + walkedLinks.length);
check('the rest are marked sampled, not silently dropped', sampledLinks.length === 2, 'sampled ' + sampledLinks.length);
check('each skipped link states the cap and the total',
  sampledLinks.every(transition => /list sample: 3 of 5 links to \/items\/:id/.test(transition.blockedReason || '')),
  JSON.stringify(sampledLinks.map(transition => transition.blockedReason)));
check('coverage counts the sampled edges', map.coverage.sampled === 2, JSON.stringify(map.coverage.sampled));

// ---------- identity survives a drifting label ----------

const toList = map.transitions.find(transition =>
  stateOf(transition.from)?.route === '/' && stateOf(transition.to)?.route === '/items');
check('the link whose badge count changes on every visit is still walked',
  toList?.status === 'verified', JSON.stringify(toList && { status: toList.status, reason: toList.blockedReason }));
check('its action key drops the badge count',
  !!toList && !/\d/.test(toList.action.key), JSON.stringify(toList?.action.key));

// ---------- graph integrity ----------

check('every verified transition names its target',
  map.transitions.filter(transition => transition.status === 'verified').every(transition => !!transition.to));
check('every transition target exists',
  map.transitions.filter(transition => transition.to).every(transition => !!stateOf(transition.to)));
check('every transition records whether CSS fallback was used',
  map.transitions.every(transition => typeof transition.action.fallbackUsed === 'boolean'),
  JSON.stringify(map.transitions.filter(transition => typeof transition.action.fallbackUsed !== 'boolean')
    .map(transition => transition.id)));
check('the cycle between list and detail is captured',
  map.transitions.some(transition => stateOf(transition.from)?.route === '/items/:id' && stateOf(transition.to)?.route === '/items'));
check('the crawl terminated inside its budget',
  !map.run.budgetHit && map.coverage.frontier.length === 0,
  JSON.stringify({ budgetHit: map.run.budgetHit, frontier: map.coverage.frontier }));
check('the crawl recorded the app commit', /^[0-9a-f]{7,}$/.test(map.app.commit || ''), JSON.stringify(map.app.commit));

// ---------- accounting ----------
//
// Budget exhaustion is this skill's ordinary failure, and the fix depends on which phase
// spent the time. Without these numbers the only available diagnosis is a guess.

const timing = map.run.timing || {};
check('the run accounts for its own time',
  timing.totalMs > 0 && Array.isArray(timing.phases) && timing.phases.length > 0,
  JSON.stringify({ totalMs: timing.totalMs, phases: (timing.phases || []).length }));
check('the clock is attributed to the screens that spent it',
  Array.isArray(timing.byScreen) && timing.byScreen.length > 0
    && timing.byScreen.every(row => row.ms >= 0 && row.actions > 0),
  JSON.stringify(timing.byScreen));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
