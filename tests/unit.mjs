/** Pure-model regression checks. No browser, no network. */

import {
  SCHEMA_VERSION, VERIFIED_OR_OBSERVED,
  authTarget, classifyAction, countsTowardSettle, createRegistry, fingerprintSignature, migrateMap,
  normalizePath, pathFromEntrypoints,
  playwrightExpr, renderMarkdown, renderMermaid, renderTiming, replayPathKey, routeTemplate,
  routeToMcpSteps, shortestSafePath, stateKind,
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
eq('a user-authored allow entry reclassifies a lexicon false positive',
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

// ---------- lexicon boundaries ----------
//
// Matching used to be a bare substring test, which is wrong in both directions and
// wrong in a different way per language. Every case below was produced by calling
// classifyAction on a name that a real app actually uses.
//
// A safe false positive is the worse half: `safe` runs during an ordinary crawl with
// no --allow-mutating, so "an action is executed only when it is positively
// recognized as safe" became false the moment a button was named `Install`.

const link = name => ({ kind: 'link', role: 'link', name, href: 'http://x/y', external: false });
const button = name => ({ kind: 'click', role: 'button', name });

// `all` inside a longer word must not promote an unknown button to safe.
eq('Install is not safe just because it contains "all"', classOf(button('Install')), 'mutating');
eq('Uninstall is not safe either', classOf(button('Uninstall')), 'mutating');
eq('Rollback is not safe just because it contains "back"', classOf(button('Rollback')), 'mutating');
eq('Research is not safe just because it contains "search"', classOf(button('Research')), 'mutating');
eq('Review is not safe just because it contains "view"', classOf(button('Review')), 'mutating');

// The same words still work when they really are the word.
eq('Show all is still safe', classOf(button('Show all')), 'safe');
eq('Go back is still safe', classOf(button('Go back')), 'safe');
eq('View details is still safe', classOf(button('View details')), 'safe');

// Destructive false positives cost coverage: a nav link that is never followed is a
// screen the map never learns about. Korean noun compounds are where this bites —
// 게시판 is a bulletin board, not the verb 게시.
eq('게시판 is a board, not the act of publishing', classOf(link('게시판')), 'safe');
eq('게시글 목록 is a listing', classOf(link('게시글 목록')), 'safe');
eq('승인 대기 목록 is a view of things awaiting approval', classOf(link('승인 대기 목록')), 'safe');
eq('전송 내역 is a log of sends, not a send', classOf(link('전송 내역')), 'safe');
eq('정지 이력 is a history view', classOf(link('정지 이력')), 'safe');
eq('배포 이력 is a history view', classOf(link('배포 이력')), 'safe');
eq('Open dropdown is not a "drop"', classOf(button('Open dropdown')), 'mutating');
eq('Payment methods is not a "pay"', classOf(link('Payment methods')), 'safe');
eq('Banner is not a "ban"', classOf(button('Banner')), 'mutating');

// …and the verbs they were shadowing are still caught.
eq('게시 is still destructive', classOf(button('게시')), 'destructive');
eq('게시하기 is still destructive', classOf(button('게시하기')), 'destructive');
eq('승인 is still destructive', classOf(button('승인')), 'destructive');
eq('전송 is still destructive', classOf(button('전송')), 'destructive');
eq('배포 is still destructive', classOf(button('배포')), 'destructive');
eq('Drop table is still destructive', classOf(button('Drop table')), 'destructive');
eq('Ban user is still destructive', classOf(button('Ban user')), 'destructive');
eq('Pay now is still destructive', classOf(button('Pay now')), 'destructive');
eq('an inflected destructive verb is still caught',
  classOf(button('Deletes everything')), 'destructive');
eq('a destructive link is still refused before the link rule',
  classOf(link('삭제')), 'destructive');
eq('취소하기 stays destructive while 취소 stays safe',
  [classOf(button('취소하기')), classOf(button('취소'))], ['destructive', 'safe']);

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

// ---------- provenance and the registry ----------
//
// The registry is the seam where a crawl and a recording have to agree. If it ever
// computes identity or numbers ids differently for the two, a recording files screens the
// crawl already knows as new nodes and the graph stops connecting.

const observationAt = (pathname, fingerprint = {}) => ({
  pathname, search: '', title: 'doc title',
  fingerprint: {
    headings: ['heading'], landmarks: ['main'], forms: [], fields: [], tabs: [], overlay: null,
    ...fingerprint,
  },
  actions: [],
});
const listLink = {
  kind: 'link', role: 'link', name: '목록', key: 'link:link:목록',
  href: 'http://localhost:1/items', hrefPath: '/items', external: false, cssFallback: 'a',
};
const stampedRegistry = (extra = {}) => createRegistry({
  config: {},
  stamp: { source: 'record', commit: 'cafe123', now: () => '2026-08-12T00:00:00.000Z' },
  ...extra,
});

const fresh = stampedRegistry();
const firstState = fresh.upsertState(observationAt('/')).state;
eq('a fresh registry numbers from zero', firstState.id, 's0');
eq('a new entry records who saw it', firstState.source, 'record');
eq('a new entry records the commit it was seen at', firstState.commit, 'cafe123');
eq('first sight and last sight start equal', firstState.lastObservedCommit, firstState.commit);

const again = fresh.upsertState(observationAt('/'));
check('the same screen twice is one node', again.isNew === false && again.state.id === 's0');

const laterRegistry = createRegistry({
  config: {},
  seed: fresh.live(),
  stamp: { source: 'record', commit: 'beef456', now: () => '2026-08-20T00:00:00.000Z' },
});
const restamped = laterRegistry.upsertState(observationAt('/')).state;
eq('re-observing moves the last-seen commit', restamped.lastObservedCommit, 'beef456');
eq('re-observing leaves the first-seen commit alone', restamped.commit, 'cafe123');
eq('re-observing does not invent a verification', restamped.verifiedAtCommit, undefined);

const seeded = createRegistry({
  config: {},
  seed: { states: [{ id: 's7', route: '/x', signature: 'h:1' }], transitions: [], entrypoints: [] },
  stamp: { source: 'record', commit: 'c', now: () => 'now' },
});
eq('a seeded registry continues the numbering instead of colliding',
  seeded.upsertState(observationAt('/new')).state.id, 's8');

const edge = fresh.upsertTransition(firstState, listLink);
eq('a recorded edge is classified by the same rules as a crawled one', edge.transition.class, 'safe');
eq('a new edge starts unproved', edge.transition.verifiedAtCommit, null);
check('a new edge has no failed replay behind it', edge.transition.replayFailed === false);
check('the same action twice is one edge', fresh.upsertTransition(firstState, listLink).isNew === false);

// ---------- migrating a version 1 map ----------

const legacy = migrateMap({
  schema: 1,
  app: { baseUrl: 'http://localhost:1', commit: 'old1234' },
  run: { startedAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:10:00.000Z' },
  states: [{ id: 's0', route: '/' }],
  transitions: [
    { id: 't0', from: 's0', to: 's0', status: 'verified' },
    { id: 't1', from: 's0', to: null, status: 'unexplored' },
  ],
  entrypoints: ['s0'],
});
eq('a version 1 map is brought forward rather than refused', legacy.schema, SCHEMA_VERSION);
eq('everything in it is attributed to the crawl that made it', legacy.states[0].source, 'crawl');
eq('and to the commit that crawl recorded', legacy.transitions[0].commit, 'old1234');
eq('an already-verified edge keeps that standing', legacy.transitions[0].verifiedAtCommit, 'old1234');
eq('an edge that was never walked gains no verification', legacy.transitions[1].verifiedAtCommit, undefined);
eq('a current map passes through untouched', migrateMap({ schema: 2, states: [] }).schema, 2);

// ---------- observed is not verified ----------

const recorded = {
  entrypoints: ['s0'],
  states: [
    { id: 's0', route: '/', title: '홈', kind: 'page', evidence: { urlSample: '/' } },
    { id: 's1', route: '/a', title: 'A', kind: 'page', evidence: { urlSample: '/a' } },
    { id: 's2', route: '/b', title: 'B', kind: 'page', evidence: { urlSample: '/b' } },
  ],
  transitions: [
    { id: 't0', from: 's0', to: 's1', class: 'safe', status: 'observed', action: { kind: 'link', role: 'link', name: 'A', key: 'a' } },
    { id: 't1', from: 's0', to: 's2', class: 'safe', status: 'observed', replayFailed: true, action: { kind: 'link', role: 'link', name: 'B', key: 'b' } },
  ],
  app: { baseUrl: 'http://localhost:1', commit: 'abc1234' },
  run: {},
};

check('a recorded edge is not a route by default', shortestSafePath(recorded, 's0', 's1') === null);
eq('asking for it explicitly finds it',
  shortestSafePath(recorded, 's0', 's1', { statuses: VERIFIED_OR_OBSERVED }).map(step => step.id), ['t0']);
check('an edge whose replay failed is never offered, even when asked for',
  shortestSafePath(recorded, 's0', 's2', { statuses: VERIFIED_OR_OBSERVED }) === null);
check('a proved edge still wins when both exist',
  shortestSafePath({ ...recorded, transitions: [
    { ...recorded.transitions[0], id: 't9', status: 'verified' },
  ] }, 's0', 's1').map(step => step.id).join() === 't9');

const recordedDiagram = renderMermaid(recorded).join('\n');
check('a recorded edge is drawn dashed, so a reviewer can see it was never proved',
  recordedDiagram.includes('s0 -.->') && !recordedDiagram.includes('s0 -->'));
check('the legend explains the difference instead of leaving it to be guessed',
  recordedDiagram.includes('dashed arrow was observed once'));

// ---------- the same route as MCP tool calls ----------

const mcpRoute = routeToMcpSteps(map, pathFromEntrypoints(map, 's2'), 'http://localhost:1');
eq('the route opens with a navigation', mcpRoute[0].tool, 'browser_navigate');
check('every click is preceded by its own snapshot',
  mcpRoute.every((step, index) =>
    step.tool !== 'browser_click' || (mcpRoute[index - 1] || {}).tool === 'browser_snapshot'));
check('no ref is invented, because a ref only exists inside one snapshot',
  mcpRoute.every(step => !('ref' in (step.args || {})) && JSON.stringify(step).indexOf('"ref"') === -1));
check('a click says where to get its ref from',
  mcpRoute.filter(step => step.tool === 'browser_click').every(step => step.refFrom === 'browser_snapshot'));
eq('a named control is matched by role and name',
  mcpRoute.find(step => step.tool === 'browser_click').match,
  { role: 'link', name: '상품 목록', href: undefined });

const ambiguousMap = {
  ...map,
  transitions: [{
    id: 'tA', from: 's0', to: 's1', class: 'safe', status: 'verified',
    action: {
      kind: 'click', role: 'button', name: '열기', key: 'k',
      ambiguous: true, cssFallback: 'div > button:nth-of-type(2)',
    },
  }],
};
const ambiguousRoute = routeToMcpSteps(
  ambiguousMap, pathFromEntrypoints(ambiguousMap, 's1'), 'http://localhost:1');
eq('a control only position could tell apart is matched by CSS, not by a name that matches several',
  ambiguousRoute.find(step => step.tool === 'browser_click').match,
  { css: 'div > button:nth-of-type(2)' });
check('and it says why', !!ambiguousRoute.find(step => step.tool === 'browser_click').note);

// ---------- executable locators ----------

const firstOpenLink = playwrightExpr({
  kind: 'link', role: 'link', name: 'Open', hrefRaw: '/items/1',
  cssFallback: 'main li:nth-of-type(1) > a',
});
const secondOpenLink = playwrightExpr({
  kind: 'link', role: 'link', name: 'Open', hrefRaw: '/items/2',
  cssFallback: 'main li:nth-of-type(2) > a',
});
check('same-name links with different hrefs get different executable locators',
  firstOpenLink !== secondOpenLink && firstOpenLink.includes('[href="/items/1"]')
    && secondOpenLink.includes('[href="/items/2"]'),
  JSON.stringify({ firstOpenLink, secondOpenLink }));
eq('a position-ambiguous action admits that it needs the CSS fallback',
  playwrightExpr({
    kind: 'click', role: 'button', name: 'Open', ambiguous: true,
    cssFallback: 'main > button:nth-of-type(2)',
  }),
  "page.locator('main > button:nth-of-type(2)')");

// ---------- rendering ----------

const markdown = renderMarkdown(map, { status: 'fresh', detail: 'app commit matches the crawl' });
check('report lists every screen', map.states.every(state => markdown.includes(state.route)));
check('report calls out actions that were never executed', markdown.includes('## Not executed'));
check('report records freshness', markdown.includes('Freshness'));

// `blocked` used to be the count of *everything* not executed, so a map that sampled
// 17 list links reported them once under `sampled` and again under `blocked`. The
// report now names the honest total and breaks it down by the status that produced it.
const counted = renderMarkdown({
  ...map,
  coverage: { states: 4, actionsSeen: 9, executed: 4, notExecuted: 5, unexplored: 1, sampled: 3, blocked: 1, failed: 0, frontier: [] },
}, { status: 'fresh' });
check('the report names the not-executed total, not the blocked count',
  counted.includes('5 not executed'), counted);
check('the report breaks that total down by status',
  counted.includes('1 unexplored, 3 sampled, 1 blocked'), counted);
check('a map written before the split still renders its old field',
  renderMarkdown({ ...map, coverage: { states: 1, actionsSeen: 2, executed: 1, blocked: 1 } }, {})
    .includes('1 not executed'));

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
