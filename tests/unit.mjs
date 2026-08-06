/** Pure-model regression checks. No browser, no network. */

import {
  authTarget, classifyAction, countsTowardSettle, fingerprintSignature, normalizePath, pathFromEntrypoints,
  renderMarkdown, renderMermaid, renderTiming, replayPathKey, routeTemplate, shortestSafePath, stateKind,
  storageSeedSource,
} from '../scripts/model.mjs';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------- route templating ----------

eq('numeric id collapses', routeTemplate('/items/1'), '/items/:id');
eq('a second numeric id collapses to the same route', routeTemplate('/items/456'), '/items/:id');
eq('uuid collapses', routeTemplate('/orders/550e8400-e29b-41d4-a716-446655440000'), '/orders/:id');
eq('static segments survive', routeTemplate('/items'), '/items');
eq('nested ids collapse independently', routeTemplate('/orders/12/lines/34'), '/orders/:id/lines/:id');
eq('trailing slash is normalized', normalizePath('/items/'), '/items');
eq('query and hash are dropped', normalizePath('/items?tab=a#x'), '/items');
eq('root stays root', normalizePath(''), '/');
eq('override wins over segment patterns', routeTemplate('/p/abc', {
  routeTemplates: { overrides: [{ match: '/p/*', template: '/p/:slug' }] },
}), '/p/:slug');

// ---------- auth navigation targets ----------
//
// The opposite of route templating: an auth step navigates, so its query is the
// instruction, not noise. Dropping it lands the browser on another screen and the
// recipe then fails at some later step that was never the cause.

eq('a query survives into the auth target', authTarget('/login?next=/dashboard'), '/login?next=/dashboard');
eq('a hash survives', authTarget('/settings#billing'), '/settings#billing');
eq('the path part is still normalized', authTarget('/login//?a=1'), '/login?a=1');

// ---------- replay identity ----------

eq('a replay is identified by its origin and transitions',
  replayPathKey({ origin: 's0', path: [{ id: 't0' }, { id: 't1' }] }), 's0>t0>t1');
// Why remembering a failure stays honest: a map that has since grown a different route
// produces a different key, so the walk is tried again rather than written off.
check('a route the map has since grown is a different walk',
  replayPathKey({ origin: 's0', path: [{ id: 't0' }, { id: 't1' }] })
    !== replayPathKey({ origin: 's0', path: [{ id: 't9' }] }));

// ---------- storage seed ----------

check('no seed produces no script', storageSeedSource(null) === null);
check('seeded keys reach the script',
  storageSeedSource({ localStorage: { 'tour-done': 'true' } }).includes('tour-done'));
check('a quote in a value cannot break out of the script',
  storageSeedSource({ localStorage: { note: '");alert(1);//' } }).includes('\\");alert(1);//'));

// ---------- what counts as "still loading" ----------
//
// A dev server streams the app as hundreds of modules and never stops, so counting
// those means never settling — every wait burns its full timeout. The rule has to admit
// what carries content and refuse what merely keeps a socket warm.

check('a data fetch means a render may still be coming', countsTowardSettle('XHR'));
check('an unknown type counts, because waiting is the recoverable mistake', countsTowardSettle(undefined));
check('the module stream does not count', !countsTowardSettle('Script'));
// Playwright excludes this one for the same reason: the stream never ends, so counting
// it means the page is never idle. Getting this backwards reintroduces the timeout bug.
check('an EventSource stream never ends, so it cannot gate settling', !countsTowardSettle('EventSource'));

// ---------- signatures ----------

const listing = { landmarks: ['banner', 'main'], headings: ['상품 목록'], forms: [], fields: [], tabs: [], overlay: null };
const listingReordered = { landmarks: ['main', 'banner'], headings: ['상품 목록'], forms: [], fields: [], tabs: [], overlay: null };
const listingWithDialog = { ...listing, overlay: { role: 'dialog', name: '필터' } };
const listingWithMenu = { ...listing, overlay: { role: 'menu', name: '사용자 메뉴' } };

eq('signature ignores ordering', fingerprintSignature(listing), fingerprintSignature(listingReordered));
check('an open dialog changes the signature', fingerprintSignature(listing) !== fingerprintSignature(listingWithDialog));
check('a dropdown menu is a different screen from a dialog',
  fingerprintSignature(listingWithMenu) !== fingerprintSignature(listingWithDialog));
eq('an open overlay makes the state an overlay', stateKind(listingWithMenu), 'overlay');
eq('no overlay means a plain page', stateKind(listing), 'page');
check('signature is a short stable hash', /^h:[0-9a-f]{12}$/.test(fingerprintSignature(listing)));

// The defect real-app validation caught: hashing the h1 split one detail screen
// into one node per record.
const detailA = { landmarks: ['banner', 'main'], headings: ['2026 하반기 모집'], forms: [], fields: [], tabs: [], overlay: null };
const detailB = { landmarks: ['banner', 'main'], headings: ['3D프린터 장비교육'], forms: [], fields: [], tabs: [], overlay: null };
eq('two records of the same detail screen are one node',
  fingerprintSignature(detailA), fingerprintSignature(detailB));

const stepOne = { landmarks: ['main'], headings: ['가입'], forms: ['signup:post'], fields: ['email'], tabs: [], overlay: null };
const stepTwo = { landmarks: ['main'], headings: ['가입'], forms: ['signup:post'], fields: ['address', 'zip'], tabs: [], overlay: null };
check('different form fields still split a wizard at one url',
  fingerprintSignature(stepOne) !== fingerprintSignature(stepTwo));

const tabA = { landmarks: ['main'], headings: [], forms: [], fields: [], tabs: ['개요'], dialog: null };
const tabB = { landmarks: ['main'], headings: [], forms: [], fields: [], tabs: ['이력'], dialog: null };
check('the selected tab still splits a screen', fingerprintSignature(tabA) !== fingerprintSignature(tabB));

// ---------- classification ----------

const classOf = (action, policy) => classifyAction(action, policy).class;

eq('destructive lexicon blocks 삭제',
  classOf({ kind: 'click', role: 'button', name: '삭제' }), 'destructive');
eq('destructive lexicon blocks delete',
  classOf({ kind: 'click', role: 'button', name: 'Delete forever' }), 'destructive');
eq('destructive lexicon blocks 발송',
  classOf({ kind: 'click', role: 'button', name: '메일 발송' }), 'destructive');
eq('same-origin link is safe',
  classOf({ kind: 'link', role: 'link', name: '상품 목록', href: 'http://x/items', external: false }), 'safe');
eq('external link is safe to record but flagged',
  classifyAction({ kind: 'link', role: 'link', name: '외부 문서', href: 'https://other/', external: true }).classifiedBy,
  'external-link');
eq('form submit is mutating',
  classOf({ kind: 'submit', role: 'button', name: '저장' }), 'mutating');
eq('unrecognized button defaults to mutating, not safe',
  classOf({ kind: 'click', role: 'button', name: '무언가 하기' }), 'mutating');
eq('unknownActionClass can be tightened to destructive',
  classOf({ kind: 'click', role: 'button', name: '무언가 하기' }, { unknownActionClass: 'destructive' }), 'destructive');
eq('safe lexicon recognizes 닫기',
  classOf({ kind: 'click', role: 'button', name: '닫기' }), 'safe');
eq('deny list overrides everything',
  classOf({ kind: 'link', role: 'link', name: '홈', href: 'http://x/', external: false, key: 'link:link:홈' },
    { deny: ['link:link:홈'] }), 'destructive');
eq('allow list overrides the destructive lexicon',
  classOf({ kind: 'click', role: 'button', name: '삭제', key: 'click:button:삭제' },
    { allow: ['click:button:삭제'] }), 'safe');
eq('download links are never followed',
  classOf({ kind: 'link', role: 'link', name: '내보내기', href: 'http://x/f.csv', external: false, download: true }), 'destructive');
check('destructive check runs before the safe lexicon',
  classOf({ kind: 'click', role: 'button', name: '전체 삭제' }) === 'destructive');
eq('logging out would destroy the crawl session, so it is destructive',
  classOf({ kind: 'click', role: 'button', name: '로그아웃' }), 'destructive');
eq('sign out is caught in English too',
  classOf({ kind: 'click', role: 'button', name: 'Sign out' }), 'destructive');
eq('a button inside a navigation landmark is treated as navigation',
  classOf({ kind: 'click', role: 'button', name: '휴지통 1', inNav: true }), 'safe');
eq('a destructive name in a nav is still refused',
  classOf({ kind: 'click', role: 'button', name: '로그아웃', inNav: true }), 'destructive');
eq('a form submit inside a nav is still mutating',
  classOf({ kind: 'submit', role: 'button', name: '적용', inNav: true }), 'mutating');

// ---------- graph ----------

const map = {
  entrypoints: ['s0'],
  states: [
    { id: 's0', route: '/', title: '홈', kind: 'page', evidence: { urlSample: '/' } },
    { id: 's1', route: '/items', title: '상품 목록', kind: 'page', evidence: { urlSample: '/items' } },
    { id: 's2', route: '/items/:id', title: '상품 상세', kind: 'page', evidence: { urlSample: '/items/1' } },
    { id: 's3', route: '/secret', title: '비밀', kind: 'page', evidence: { urlSample: '/secret' } },
  ],
  transitions: [
    { id: 't0', from: 's0', to: 's1', class: 'safe', status: 'verified', action: { kind: 'link', role: 'link', name: '상품 목록', key: 'k0' } },
    { id: 't1', from: 's1', to: 's2', class: 'safe', status: 'verified', action: { kind: 'link', role: 'link', name: '상품 A', key: 'k1' } },
    { id: 't2', from: 's2', to: 's1', class: 'safe', status: 'verified', action: { kind: 'link', role: 'link', name: '상품 목록', key: 'k2' } },
    { id: 't3', from: 's0', to: 's3', class: 'mutating', status: 'verified', action: { kind: 'submit', role: 'button', name: '저장', key: 'k3' } },
    { id: 't4', from: 's1', to: 's3', class: 'safe', status: 'unexplored', action: { kind: 'click', role: 'button', name: '삭제', key: 'k4' } },
  ],
  coverage: { states: 4, actionsSeen: 5, executed: 4, blocked: 1, frontier: [] },
  app: { baseUrl: 'http://localhost:1', commit: 'abc1234' },
  run: { finishedAt: '2026-08-04T00:00:00.000Z' },
};

eq('shortest safe path walks the graph', shortestSafePath(map, 's0', 's2').map(step => step.id), ['t0', 't1']);
eq('a cycle does not stall the search', shortestSafePath(map, 's2', 's1').map(step => step.id), ['t2']);
check('mutating transitions are never used for replay', shortestSafePath(map, 's0', 's3') === null);
eq('path from entrypoints reports its origin', pathFromEntrypoints(map, 's2').origin, 's0');
check('unreachable target yields no path', pathFromEntrypoints(map, 's3') === null);
eq('a state is zero steps from itself', shortestSafePath(map, 's1', 's1'), []);

// ---------- rendering ----------

const markdown = renderMarkdown(map, { status: 'fresh', detail: 'app commit matches the crawl' });
check('report lists every screen', map.states.every(state => markdown.includes(state.route)));
check('report calls out actions that were never executed', markdown.includes('## Not executed'));
check('report records freshness', markdown.includes('Freshness'));

// ---------- diagram ----------
//
// The report's tables are the record; the diagram is the only part a reviewer can
// check at a glance, and step 4 of the workflow asks them to do exactly that.

check('the report carries a diagram', markdown.includes('```mermaid'));
const loopy = {
  states: [
    { id: 's0', route: '/editor', title: '에디터', kind: 'page' },
    { id: 's1', route: '/editor', title: '도움말', kind: 'overlay' },
  ],
  entrypoints: ['s0'],
  transitions: [
    { id: 't0', from: 's0', to: 's0', class: 'mutating', status: 'verified', action: { name: '저장' } },
    { id: 't1', from: 's0', to: 's0', class: 'safe', status: 'verified', action: { name: '실행취소' } },
    { id: 't2', from: 's0', to: 's1', class: 'safe', status: 'verified', action: { name: '도움말' } },
    { id: 't3', from: 's0', to: 's1', class: 'safe', status: 'verified', action: { name: '단축키' } },
    { id: 't4', from: 's0', to: null, class: 'mutating', status: 'blocked', action: { name: '벽' } },
  ],
};
const diagram = renderMermaid(loopy).join('\n');
check('an action that stays on its screen is counted, not drawn', diagram.includes('↻2') && !diagram.includes('s0 -->|"저장"| s0'));
check('parallel edges collapse into one edge that says how many it stands for',
  (diagram.match(/s0 -->/g) || []).length === 1 && diagram.includes('+1'));
check('what was never executed rides on the node', diagram.includes('⊘1'));
check('an entrypoint is drawn as a stadium', diagram.includes('s0(['));
check('an overlay is drawn as a hexagon', diagram.includes('s1{{'));

// ---------- clock accounting ----------

eq('nothing measured means nothing reported', renderTiming(undefined), []);
const timingReport = renderTiming({
  totalMs: 20000,
  phases: [{ label: 'reach.replay-load', ms: 15000, count: 50 }, { label: 'act.click', ms: 1000, count: 40 }],
  byScreen: [{ route: '/editor', title: '에디터', ms: 12000, actions: 40 }],
}).join('\n');
check('the dominant phase is reported with its share', timingReport.includes('15.0s') && timingReport.includes('75%'));
check('the screen that spent the clock is named', timingReport.includes('/editor'));
check('cost per action is derived, since that is the number to act on', timingReport.includes('0.3s'));

const risky = renderMermaid({
  states: [{ id: 's0', route: '/x', title: 'a "quoted" <b>|title', kind: 'page' }],
  entrypoints: [], transitions: [],
}).join('\n');
check('label syntax cannot break the diagram', !risky.includes('"quoted"') && !risky.includes('<b>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
