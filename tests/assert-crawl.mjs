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

check('every fixture screen is mapped, and /items/1..3 collapse into one node',
  ['/', '/items', '/items/:id', '/cart', '/new'].every(route => routes.includes(route))
    && byRoute('/items/:id').length === 1,
  'routes: ' + JSON.stringify(routes));

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

// ---------- fail-closed policy ----------

const del = transitionsNamed('삭제')[0];
check('the delete button is recorded destructive and never pressed',
  del?.class === 'destructive' && del?.status === 'unexplored' && clicks.delete === 0,
  JSON.stringify({ class: del?.class, status: del?.status, clicks: clicks.delete }));

const save = transitionsNamed('저장')[0];
if (mode === 'mutating') {
  check('with --allow-mutating the form submit runs and reaches the server',
    save?.class === 'mutating' && save?.status === 'verified' && clicks.submit >= 1,
    JSON.stringify({ class: save?.class, status: save?.status, submits: clicks.submit }));
} else {
  check('without --allow-mutating the form submit is classified mutating and left alone',
    save?.class === 'mutating' && save?.status === 'unexplored' && clicks.submit === 0,
    JSON.stringify({ class: save?.class, status: save?.status, submits: clicks.submit }));
}

// The --allow-mutating crawl is a short walk that only proves the policy above.
if (mode === 'mutating') {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const external = transitionsNamed('외부 문서')[0];
const redirectedExternal = transitionsNamed('외부 리다이렉트')[0];
check('an external link and a same-origin link that redirects away are blocked, and the outside never sees a request',
  [external, redirectedExternal].every(t => t?.status === 'blocked' && t?.blockedReason === 'external-origin')
    && clicks.external === 0,
  JSON.stringify({ external: external?.status, redirect: redirectedExternal?.status, requests: clicks.external }));

// A press that changes nothing is not the same fact as a press that stays put. One is a
// dead control; the other is a refresh.
const inert = map.transitions.filter(transition => transition.inert);
check('a control wired to nothing is marked inert, a refresh that reaches the server is not',
  inert.length === 1 && inert[0].action.name === '펼치기'
    && map.transitions.some(t => t.action.name === '새로고침' && t.from === t.to && !t.inert),
  'inert: ' + JSON.stringify(inert.map(t => t.action.name)));

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
check('all five list items are edges, three walked and two marked sampled with the cap',
  listLinks.length === 5 && walkedLinks.length === 3 && sampledLinks.length === 2
    && sampledLinks.every(transition => /list sample: 3 of 5/.test(transition.blockedReason || '')),
  JSON.stringify({ links: listLinks.length, walked: walkedLinks.length, sampled: sampledLinks.map(t => t.blockedReason) }));

// `blocked` once held every non-verified transition, so the sampled links above were
// counted twice. The parts must now add up to the total.
const cov = map.coverage;
check('coverage parts add up to the not-executed total, which matches the unverified edges',
  cov.sampled === 2 && cov.blocked + cov.unexplored + cov.sampled + cov.failed === cov.notExecuted
    && cov.notExecuted === map.transitions.filter(transition => transition.status !== 'verified').length,
  JSON.stringify(cov));

// ---------- identity survives a drifting label ----------

const toList = map.transitions.find(transition =>
  stateOf(transition.from)?.route === '/' && stateOf(transition.to)?.route === '/items');
check('the link whose badge count changes on every visit is still walked by name',
  toList?.status === 'verified' && !/\d/.test(toList.action.key) && toList.action.fallbackUsed === false,
  JSON.stringify(toList && { status: toList.status, key: toList.action.key, fallbackUsed: toList.action.fallbackUsed }));

// The other kind of drift: wording, which dropping numbers cannot normalize. The only way
// this edge gets walked is the recorded CSS position, and the map has to say so.
const stash = map.transitions.filter(transition => transition.action.cssFallback === '#stash');
check('a link whose wording changes is one edge, walked by CSS position and reported as such',
  stash.length === 1 && stash[0].action.fallbackUsed === true
    && stash[0].status === 'verified' && stateOf(stash[0].to)?.route === '/cart',
  JSON.stringify(stash.map(t => ({ name: t.action.name, fallbackUsed: t.action.fallbackUsed, status: t.status }))));

// ---------- graph integrity ----------

check('every verified transition names a target that exists',
  map.transitions.filter(transition => transition.status === 'verified').every(transition => !!stateOf(transition.to)));
check('the crawl terminated inside its budget and recorded the app commit',
  !map.run.budgetHit && map.coverage.frontier.length === 0 && /^[0-9a-f]{7,}$/.test(map.app.commit || ''),
  JSON.stringify({ budgetHit: map.run.budgetHit, frontier: map.coverage.frontier, commit: map.app.commit }));

// Budget exhaustion is this skill's ordinary failure, and the fix depends on which phase
// spent the time.
const timing = map.run.timing || {};
check('the run accounts for its own time, by phase and by screen',
  timing.totalMs > 0 && timing.phases?.length > 0 && timing.byScreen?.length > 0,
  JSON.stringify({ totalMs: timing.totalMs, phases: (timing.phases || []).length }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
