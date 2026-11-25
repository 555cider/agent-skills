/** Pure-model regression checks. No browser, no network. */

import {
  SCHEMA_VERSION, VERIFIED_OR_OBSERVED,
  authTarget, canonicalRoute, carryRecorded, classifyAction, countsTowardSettle, createRegistry, fingerprintSignature,
  globalNavigationKeys, migrateMap,
  normalizePath, observeTarget, pathFromEntrypoints,
  playwrightExpr, reachability, renderMarkdown, renderMermaid, replaysMutating,
  routeTemplate, routeToMcpSteps, routeToSteps, shortestSafePath,
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

eq('ids collapse into templates', [
  routeTemplate('/items/456'),
  routeTemplate('/orders/550e8400-e29b-41d4-a716-446655440000'),
  routeTemplate('/orders/12/lines/34'),
  normalizePath('/items/?tab=a#x'),
], ['/items/:id', '/orders/:id', '/orders/:id/lines/:id', '/items']);
eq('unnamed query parameters are dropped and identityQuery ones sorted',
  routeTemplate('/items/7', { routeTemplates: { identityQuery: ['stt', 'empty'] } }, '?x=1&stt=none&empty=1'),
  '/items/:id?empty=1&stt=none');
eq('a lookup keeps the identity parameters the map names, sorted',
  canonicalRoute('/?stt=none&x=2&empty=1', ['stt', 'empty']), '/?empty=1&stt=none');

// The opposite of route templating: an auth step navigates, so its query is the
// instruction, not noise.
eq('a query survives into the auth target', authTarget('/login//?next=/dashboard'), '/login?next=/dashboard');

// ---------- storage seed ----------

check('a quote in a seeded value cannot break out of the script',
  storageSeedSource({ localStorage: { note: '");alert(1);//' } }).includes('\\");alert(1);//'));

// ---------- what counts as "still loading" ----------
//
// A dev server streams the app as hundreds of modules and never stops, so counting
// those means never settling. An EventSource never ends either.

check('a data fetch gates settling, module and EventSource streams do not',
  countsTowardSettle('XHR') && countsTowardSettle(undefined)
    && !countsTowardSettle('Script') && !countsTowardSettle('EventSource'));

// ---------- signatures ----------

const listing = { landmarks: ['banner', 'main'], headings: ['상품 목록'], forms: [], fields: [], tabs: [], overlay: null };
const listingWithDialog = { ...listing, overlay: { role: 'dialog', name: '필터' } };
const listingWithMenu = { ...listing, overlay: { role: 'menu', name: '사용자 메뉴' } };

eq('signature ignores ordering', fingerprintSignature(listing),
  fingerprintSignature({ ...listing, landmarks: ['main', 'banner'] }));
check('a dialog and a dropdown menu are each a screen of their own',
  new Set([listing, listingWithDialog, listingWithMenu].map(item => fingerprintSignature(item))).size === 3);
const chromeOn = { signature: { chrome: true } };
eq('header verbs do not change the signature unless the config asks',
  fingerprintSignature({ ...listing, chrome: ['뒤로', '그룹 메뉴'] }), fingerprintSignature(listing));
check('asked, header verbs split two screens whose structure is otherwise identical',
  fingerprintSignature({ ...listing, chrome: ['새 그룹', '설정'] }, chromeOn)
    !== fingerprintSignature({ ...listing, chrome: ['뒤로', '그룹 메뉴'] }, chromeOn));

// The defect real-app validation caught: hashing the h1 split one detail screen
// into one node per record.
eq('two records of the same detail screen are one node',
  fingerprintSignature({ ...listing, headings: ['2026 하반기 모집'] }),
  fingerprintSignature({ ...listing, headings: ['3D프린터 장비교육'] }));
check('different form fields still split a wizard at one url',
  fingerprintSignature({ ...listing, forms: ['signup:post'], fields: ['email'] })
    !== fingerprintSignature({ ...listing, forms: ['signup:post'], fields: ['address', 'zip'] }));

// ---------- classification ----------

const classOf = (action, policy) => classifyAction(action, policy).class;
const link = name => ({ kind: 'link', role: 'link', name, href: 'http://x/y', external: false });
const button = name => ({ kind: 'click', role: 'button', name });

eq('destructive lexicon blocks delete, send and logout in both languages',
  ['삭제', 'Delete forever', '메일 발송', '로그아웃', 'Sign out', '전체 삭제'].map(name => classOf(button(name))),
  Array(6).fill('destructive'));
eq('form submit and an unrecognized button are mutating, not safe',
  [classOf({ kind: 'submit', role: 'button', name: '저장' }), classOf(button('무언가 하기'))], ['mutating', 'mutating']);
eq('deny list overrides everything',
  classOf({ ...link('홈'), key: 'link:link:홈' }, { deny: ['link:link:홈'] }), 'destructive');
eq('a user-authored allow entry reclassifies a lexicon false positive',
  classOf({ ...button('삭제'), key: 'click:button:삭제' }, { allow: ['click:button:삭제'] }), 'safe');
eq('download links are never followed',
  classOf({ ...link('내보내기'), href: 'http://x/f.csv', download: true }), 'destructive');
eq('a button in a nav is navigation, but a destructive name or a submit there is not',
  [classOf({ ...button('휴지통 1'), inNav: true }), classOf({ ...button('로그아웃'), inNav: true }),
    classOf({ kind: 'submit', role: 'button', name: '적용', inNav: true })],
  ['safe', 'destructive', 'mutating']);

// Matching used to be a bare substring test, wrong in both directions. Every name below
// is one a real app actually uses.
eq('a word containing a safe word is not safe',
  ['Install', 'Rollback', 'Research', 'Review', 'Open dropdown', 'Banner'].map(name => classOf(button(name))),
  Array(6).fill('mutating'));
eq('the safe words still work as words', ['Show all', 'Go back', 'View details', '취소'].map(name => classOf(button(name))),
  Array(4).fill('safe'));
eq('Korean noun compounds are not the verb they contain',
  ['게시판', '게시글 목록', '승인 대기 목록', '전송 내역', '배포 이력', 'Payment methods'].map(name => classOf(link(name))),
  Array(6).fill('safe'));
eq('the verbs they were shadowing are still caught',
  ['게시하기', '승인', '전송', 'Drop table', 'Pay now', 'Deletes everything', '취소하기'].map(name => classOf(button(name))),
  Array(7).fill('destructive'));

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

eq('shortest safe path walks the graph from an entrypoint',
  pathFromEntrypoints(map, 's2').path.map(step => step.id), ['t0', 't1']);
check('mutating transitions are never used for replay', shortestSafePath(map, 's0', 's3') === null);

// ---------- provenance and the registry ----------
//
// The registry is the seam where a crawl and a recording have to agree. If it ever
// computes identity or numbers ids differently for the two, a recording files screens the
// crawl already knows as new nodes and the graph stops connecting.

const observationAt = (pathname) => ({
  pathname, search: '', title: 'doc title',
  fingerprint: { headings: ['heading'], landmarks: ['main'], forms: [], fields: [], tabs: [], overlay: null },
  actions: [],
});
const listLink = {
  kind: 'link', role: 'link', name: '목록', key: 'link:link:목록',
  href: 'http://localhost:1/items', hrefPath: '/items', external: false, cssFallback: 'a',
};
const fresh = createRegistry({ config: {}, stamp: { source: 'record', commit: 'cafe123', now: () => '2026-08-12T00:00:00.000Z' } });
const firstState = fresh.upsertState(observationAt('/')).state;
check('the same screen twice is one node', fresh.upsertState(observationAt('/')).isNew === false);
const restamped = createRegistry({
  config: {},
  seed: fresh.live(),
  stamp: { source: 'record', commit: 'beef456', now: () => '2026-08-20T00:00:00.000Z' },
}).upsertState(observationAt('/')).state;
eq('re-observing moves the last-seen commit only, and invents no verification',
  [restamped.commit, restamped.lastObservedCommit, restamped.verifiedAtCommit], ['cafe123', 'beef456', undefined]);
const seeded = createRegistry({
  config: {},
  seed: { states: [{ id: 's7', route: '/x', signature: 'h:1' }], transitions: [], entrypoints: [] },
  stamp: { source: 'record', commit: 'c', now: () => 'now' },
});
eq('a seeded registry continues the numbering instead of colliding',
  seeded.upsertState(observationAt('/new')).state.id, 's8');
const edge = fresh.upsertTransition(firstState, listLink);
eq('a recorded edge is classified like a crawled one and starts unproved',
  [edge.transition.class, edge.transition.verifiedAtCommit], ['safe', null]);

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
eq('a version 1 map is brought forward, keeping verified edges verified and nothing else',
  [legacy.schema, legacy.states[0].source, legacy.transitions[0].verifiedAtCommit, legacy.transitions[1].verifiedAtCommit],
  [SCHEMA_VERSION, 'crawl', 'old1234', undefined]);

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

check('a recorded edge is not a route by default, only when asked for',
  shortestSafePath(recorded, 's0', 's1') === null
    && shortestSafePath(recorded, 's0', 's1', { statuses: VERIFIED_OR_OBSERVED })?.length === 1);
check('an edge whose replay failed is never offered, even when asked for',
  shortestSafePath(recorded, 's0', 's2', { statuses: VERIFIED_OR_OBSERVED }) === null);
const recordedDiagram = renderMermaid(recorded).join('\n');
check('a recorded edge is drawn dashed, so a reviewer can see it was never proved',
  recordedDiagram.includes('s0 -.->') && !recordedDiagram.includes('s0 -->'));

// ---------- the same route as MCP tool calls ----------

const mcpRoute = routeToMcpSteps(map, pathFromEntrypoints(map, 's2'), 'http://localhost:1');
check('every click is preceded by its own snapshot and no ref is invented',
  mcpRoute[0].tool === 'browser_navigate'
    && mcpRoute.every((step, index) => step.tool !== 'browser_click' || (mcpRoute[index - 1] || {}).tool === 'browser_snapshot')
    && JSON.stringify(mcpRoute).indexOf('"ref"') === -1);
const ambiguousMap = {
  ...map,
  transitions: [{
    id: 'tA', from: 's0', to: 's1', class: 'safe', status: 'verified',
    action: { kind: 'click', role: 'button', name: '열기', key: 'k', ambiguous: true, cssFallback: 'div > button:nth-of-type(2)' },
  }],
};
eq('a control only position could tell apart is matched by CSS, not by a name that matches several',
  routeToMcpSteps(ambiguousMap, pathFromEntrypoints(ambiguousMap, 's1'), 'http://localhost:1')
    .find(step => step.tool === 'browser_click').match,
  { css: 'div > button:nth-of-type(2)' });

// ---------- executable locators ----------

const firstOpenLink = playwrightExpr({ kind: 'link', role: 'link', name: 'Open', hrefRaw: '/items/1', cssFallback: 'main li:nth-of-type(1) > a' });
const secondOpenLink = playwrightExpr({ kind: 'link', role: 'link', name: 'Open', hrefRaw: '/items/2', cssFallback: 'main li:nth-of-type(2) > a' });
check('same-name links with different hrefs get different executable locators',
  firstOpenLink !== secondOpenLink && firstOpenLink.includes('[href="/items/1"]'),
  JSON.stringify({ firstOpenLink, secondOpenLink }));
const mailbox = playwrightExpr({ kind: 'click', role: 'button', name: '메일함 12' });
const mailboxRe = new RegExp(mailbox.match(/name: \/(.*)\/ \}/)[1]);
check('a name holding a count matches the count moving, and stays anchored',
  mailboxRe.test('메일함 13') && mailboxRe.test('메일함') && !mailboxRe.test('메일함 전체') && !mailboxRe.test('받은 메일함 12'), mailbox);
eq('a step inside an open dialog is scoped to it',
  playwrightExpr({ kind: 'click', role: 'button', name: '닫기' }, { within: 'dialog' }),
  "page.getByRole('dialog').getByRole('button', { name: '닫기' })");

// ---------- replaying mutating edges ----------

const buttonApp = {
  run: {},
  entrypoints: ['s0'],
  states: [
    { id: 's0', route: '/', signature: 'h:a', kind: 'page' },
    { id: 's1', route: '/', signature: 'h:b', kind: 'page' },
  ],
  transitions: [
    { id: 't0', from: 's0', to: 's1', class: 'mutating', status: 'verified', action: { key: 'click:button:폴더' } },
  ],
};
const replaying = { ...buttonApp, run: { replayMutating: true } };
check('only a map crawled with replayMutating replays a proved mutating edge',
  pathFromEntrypoints(buttonApp, 's1') === null && !replaysMutating(buttonApp)
    && pathFromEntrypoints(replaying, 's1')?.path.length === 1);
// Status `observed` on purpose: an unexplored edge is dropped by the status filter before
// the class is ever looked at, which would make these pass for nothing.
const destructive = { ...replaying, transitions: [{ ...replaying.transitions[0], class: 'destructive', status: 'observed' }] };
check('a destructive edge a recording watched is never on a path, replayMutating or not',
  pathFromEntrypoints(destructive, 's1', null, { statuses: VERIFIED_OR_OBSERVED }) === null
    && !reachability(destructive).canReach.has('s1'));
const watchedOnly = { ...replaying, transitions: [{ ...replaying.transitions[0], status: 'observed' }] };
check('a mutating edge only a recording watched is not replayed',
  pathFromEntrypoints(watchedOnly, 's1', null, { statuses: VERIFIED_OR_OBSERVED }) === null);

// ---------- rendering ----------

// `blocked` used to be the count of *everything* not executed, so sampled links were
// reported twice. The report names the honest total and breaks it down by status.
const counted = renderMarkdown({
  ...map,
  coverage: { states: 4, actionsSeen: 9, executed: 4, notExecuted: 5, unexplored: 1, sampled: 3, blocked: 1, failed: 0, frontier: [] },
}, { status: 'fresh' });
check('the report names the not-executed total and breaks it down by status',
  counted.includes('5 not executed') && counted.includes('1 unexplored, 3 sampled, 1 blocked'), counted);
const risky = renderMermaid({
  states: [{ id: 's0', route: '/x', title: 'a "quoted" <b>|title', kind: 'page' }],
  entrypoints: [], transitions: [],
}).join('\n');
check('label syntax cannot break the diagram', !risky.includes('"quoted"') && !risky.includes('<b>'));

// ---------- one control, two destinations ----------
//
// A recording raises what is known and never lowers it. Letting one watched observation
// take `to` would delete the crawl's proved destination.

const wobbly = { id: 'tw', from: 's1', to: null, class: 'safe', status: 'verified', action: { key: 'kw' } };
observeTarget(wobbly, 's2', { proved: true });
observeTarget(wobbly, 's3', { proved: true });
eq('a second destination is kept beside the first, not instead of it',
  [wobbly.to, wobbly.nondeterministic, wobbly.toAlternatives], ['s3', true, ['s2', 's3']]);
const proved = { id: 'tp', from: 's1', to: 's2', class: 'safe', status: 'verified', action: { key: 'kp' } };
observeTarget(proved, 's9');
eq('a watched observation does not displace a proved destination', proved.to, 's2');
const wobblyMap = { ...map, transitions: map.transitions.map(entry => entry.id === 't1' ? { ...entry, nondeterministic: true } : entry) };
check('a path that can only run through an unreliable step is not promised',
  shortestSafePath(wobblyMap, 's0', 's2', { proofOnly: true }) === null);

// ---------- getting back out ----------

const hop = (from, to, extra = {}) => ({
  id: `${from}>${to}`, from, to, class: 'safe', status: 'verified',
  action: { kind: 'click', role: 'button', name: `${from}→${to}`, key: `k:${from}>${to}` },
  ...extra,
});
const returns = reachability({
  entrypoints: ['e'],
  states: [{ id: 'e' }, { id: 'a' }, { id: 'b' }, { id: 'dead' }, { id: 'orphan' }],
  transitions: [hop('e', 'a'), hop('a', 'e'), hop('a', 'b'), hop('b', 'a'), hop('e', 'dead')],
});
eq('a screen with no way back and a screen nothing reaches are named apart',
  [returns.oneWay, returns.isolated], [['dead'], ['orphan']]);

// ---------- site furniture ----------
//
// A global menu points at the same place from every screen. Only the picture folds it.

const navEdge = (from, to, key, name) => ({
  id: `${from}:${key}`, from, to, class: 'safe', status: 'verified',
  action: { kind: 'link', role: 'link', name, key, inNav: true },
});
const furnished = {
  entrypoints: ['n0'],
  states: ['n0', 'n1', 'n2', 'n3', 'n4'].map(id => ({ id, route: `/${id}`, title: id, kind: 'page' })),
  transitions: [
    ...['n0', 'n1', 'n2', 'n3', 'n4'].map(id => navEdge(id, 'n0', 'link:link:홈', '홈')),
    navEdge('n1', 'n2', 'link:link:희귀', '희귀'),
    navEdge('n2', 'n3', 'link:link:희귀', '희귀'),
    hop('n0', 'n1'),
  ],
};
const globalKeys = globalNavigationKeys(furnished);
check('a control on every screen is furniture, one on two screens out of five is not',
  globalKeys.has('link:link:홈') && !globalKeys.has('link:link:희귀'));
check('the diagram folds the global menu out, routing still uses it',
  !renderMermaid(furnished).join('\n').includes('홈')
    && shortestSafePath(furnished, 'n4', 'n0').map(step => step.action.key).join() === 'link:link:홈');

// ---------- the back button ----------

const historyResolved = {
  origin: 's1',
  path: [{
    id: 'th', from: 's2', to: 's1', class: 'safe', status: 'observed',
    action: { kind: 'history', role: 'browser', name: 'back', key: 'history:back' },
  }],
};
const historyMap = { ...map, app: { baseUrl: 'http://localhost:1' } };
eq('a history step is safe and walked, not clicked',
  [classifyAction({ kind: 'history', name: 'back', key: 'history:back' }).class,
    routeToSteps(historyMap, historyResolved, 'http://localhost:1')[1].playwright],
  ['safe', 'await page.goBack()']);

// ---------- a re-crawl keeps what was recorded ----------
{
  const st = (id, route, extra = {}) => ({ id, source: 'crawl', route, signature: 'h:' + route, kind: 'page', title: route, evidence: { urlSample: route }, ...extra });
  const tr = (id, from, to, key, extra = {}) => ({
    id, source: 'crawl', from, to, class: 'safe', status: 'verified',
    action: { kind: 'click', key, name: key }, blockedReason: null, ...extra,
  });
  const previous = {
    states: [st('s0', '/'), st('s1', '/new'), st('s2', '/done', { source: 'record' }), st('s3', '/typed', { source: 'record', reachable: 'direct-url' })],
    transitions: [
      tr('t0', 's0', 's1', 'click:link:new'),
      tr('t1', 's1', 's2', 'submit:button:save', { class: 'mutating', status: 'observed' }),
      tr('t2', 's2', null, 'click:link:again', { source: 'record', status: 'unexplored' }),
      tr('t3', 's0', null, 'click:button:gone', { source: 'record', status: 'unexplored' }),
      tr('t4', 's0', 's1', 'click:link:wobble', { status: 'observed' }),
      tr('t5', 's0', 's2', 'click:link:old', { source: 'record', status: 'observed' }),
      { ...tr('t6', 's1', 's0', 'history:back', { source: 'record', status: 'observed' }), action: { kind: 'history', key: 'history:back', name: 'back' } },
    ],
    entrypoints: ['s0', 's3'],
    recordings: [{ startedAt: 'x', edges: 1 }],
  };
  // The new crawl numbers its screens differently and refused the mutating submit again.
  const crawl = {
    schema: 2,
    states: [st('s0', '/new'), st('s1', '/')],
    transitions: [
      tr('t0', 's1', 's0', 'click:link:new'),
      tr('t1', 's0', null, 'submit:button:save', { class: 'mutating', status: 'unexplored', blockedReason: 'mutating: needs --allow-mutating' }),
      tr('t2', 's1', 's0', 'click:link:wobble'),
    ],
    entrypoints: ['s1'],
  };
  const frozen = JSON.stringify(crawl);
  const { map: merged, carried } = carryRecorded(crawl, previous);
  const route = id => merged.states.find(state => state.id === id)?.route;
  const submit = merged.transitions.find(t => t.action.key === 'submit:button:save');
  check('a re-crawl keeps the recorded edge past a step it refused',
    submit?.status === 'observed' && route(submit.to) === '/done' && submit.blockedReason === null,
    JSON.stringify(submit));
  check('a recording-only screen is carried with a fresh id, matched by route',
    merged.states.filter(state => state.route === '/done').length === 1
      && new Set(merged.states.map(state => state.id)).size === merged.states.length,
    JSON.stringify(merged.states.map(state => [state.id, state.route])));
  check('recorded controls the new crawl no longer lists on a crawled screen are dropped',
    !merged.transitions.some(t => t.action.key === 'click:button:gone' || t.action.key === 'click:link:old'));
  check('a recorded back navigation survives, since a crawl never lists it',
    merged.transitions.some(t => t.action.key === 'history:back' && route(t.from) === '/new' && route(t.to) === '/'));
  const wobble = merged.transitions.find(t => t.action.key === 'click:link:wobble');
  check('a crawl-proved edge keeps its proof when a carried observation agrees',
    wobble?.status === 'verified' && !wobble.nondeterministic, JSON.stringify(wobble));
  check('entrypoints, recordings history and the crawl snapshot survive the merge',
    merged.entrypoints.some(id => route(id) === '/typed') && merged.recordings?.length === 1
      && JSON.stringify(crawl) === frozen && carried === 4,
    JSON.stringify({ entrypoints: merged.entrypoints, carried }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
