/** Pure-model regression checks. No browser, no network. */

import {
  classifyAction, fingerprintSignature, normalizePath, pathFromEntrypoints,
  renderMarkdown, routeTemplate, shortestSafePath, stateKind,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
