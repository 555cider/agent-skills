/**
 * screen-map pure model: route templating, state signatures, action classification,
 * graph queries, and rendering. No I/O, no browser — every function here is
 * exercised by tests/unit.mjs without launching Chrome.
 */

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

// ---------- route templating ----------

const DEFAULT_SEGMENT_PATTERNS = [
  '^\\d+$',                                                            // numeric id
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', // uuid
  '^[0-9a-fA-F]{24,}$',                                                // long hex id
];

/** Glob with `*` = one segment, `**` = the rest. Anchored. */
function globToRegExp(glob) {
  let out = '^';
  const parts = String(glob).split('/');
  parts.forEach((part, index) => {
    if (index > 0) out += '/';
    if (part === '**') { out += '.*'; return; }
    out += part.split('*').map(chunk => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  });
  return new RegExp(out + '$');
}

/**
 * Collapse volatile path segments so `/items/1` and `/items/2` become one node.
 * Overrides win over segment patterns so an app can pin its own shapes.
 */
export function routeTemplate(pathname, config = {}) {
  const raw = normalizePath(pathname);
  const rules = config.routeTemplates || {};
  for (const override of rules.overrides || []) {
    if (override && override.match && globToRegExp(override.match).test(raw)) {
      return normalizePath(override.template || raw);
    }
  }
  const patterns = (rules.segmentPatterns || DEFAULT_SEGMENT_PATTERNS).map(source => new RegExp(source));
  const templated = raw.split('/').map(segment => {
    if (!segment) return segment;
    return patterns.some(pattern => pattern.test(segment)) ? ':id' : segment;
  }).join('/');
  return normalizePath(templated);
}

export function normalizePath(pathname) {
  let value = String(pathname || '/');
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  try { value = decodeURI(value); } catch { /* keep raw when undecodable */ }
  if (!value.startsWith('/')) value = '/' + value;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  return value || '/';
}

// ---------- state signature ----------

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Structure only — landmarks, form identities, input field names, the open dialog,
 * and the active tab. Everything that varies with *data* is excluded, headings
 * above all: on a detail screen the h1 is the entity's title, so hashing it turns
 * one screen into one node per record. Headings are still carried in the
 * observation for the state's title and evidence; they just do not decide identity.
 */
export function fingerprintSignature(fingerprint = {}) {
  const canonical = {
    landmarks: [...(fingerprint.landmarks || [])].sort(),
    forms: [...(fingerprint.forms || [])].sort(),
    fields: [...(fingerprint.fields || [])].sort(),
    tabs: [...(fingerprint.tabs || [])].sort(),
    overlay: fingerprint.overlay ? { role: fingerprint.overlay.role, name: fingerprint.overlay.name } : null,
  };
  return 'h:' + createHash('sha1').update(stableStringify(canonical)).digest('hex').slice(0, 12);
}

export function stateKey(route, signature) { return route + '\u0000' + signature; }

export function stateKind(fingerprint = {}) { return fingerprint.overlay ? 'overlay' : 'page'; }

/** Prefer a real heading, fall back to the document title, then the route. */
export function stateTitle(observation = {}) {
  const overlay = observation.fingerprint && observation.fingerprint.overlay;
  // An unlabelled overlay is better described by what it is than by the page title
  // showing through behind it.
  if (overlay) return overlay.name || overlay.role;
  const headings = (observation.fingerprint && observation.fingerprint.headings) || [];
  if (headings.length) return headings[0];
  if (observation.title) return String(observation.title).trim();
  return observation.route || '/';
}

// ---------- action classification ----------

export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  '삭제', '제거', '지우기', '비우기', '폐기', '탈퇴', '초기화',
  '발송', '보내기', '전송', '제출하고 보내',
  '결제', '구매', '주문하기', '환불', '입금', '출금', '송금',
  '승인', '반려', '거절', '차단', '정지', '해지', '취소하기',
  '배포', '게시',
  // Logging out destroys the crawl's own session, which makes everything after it
  // a lie. Treat it as destructive even though it loses no user data.
  '로그아웃', '로그 아웃', '세션 종료',
  'logout', 'log out', 'sign out', 'signout',
  'delete', 'remove', 'destroy', 'purge', 'drop', 'erase', 'wipe',
  'send', 'dispatch', 'publish', 'deploy', 'release',
  'pay', 'purchase', 'checkout', 'refund', 'charge', 'withdraw', 'transfer',
  'approve', 'reject', 'ban', 'suspend', 'terminate', 'deactivate', 'unsubscribe',
];

export const DEFAULT_SAFE_PATTERNS = [
  '닫기', '취소', '뒤로', '이전', '다음', '더보기', '접기', '펼치기',
  '필터', '검색', '정렬', '보기', '상세', '목록', '홈', '새로고침', '전체',
  '메뉴', '탭', '선택',
  'close', 'cancel', 'back', 'previous', 'next', 'more', 'less',
  'expand', 'collapse', 'filter', 'search', 'sort', 'view', 'details', 'detail',
  'list', 'home', 'refresh', 'reload', 'all', 'open menu', 'menu', 'skip',
];

function matchesAny(name, patterns) {
  const haystack = String(name || '').toLowerCase();
  if (!haystack) return false;
  return patterns.some(pattern => haystack.includes(String(pattern).toLowerCase()));
}

/**
 * The guarantee is one-directional: an action runs by default only when it is
 * *positively recognized* as safe. Everything unrecognized falls to
 * `unknownActionClass` (default `mutating`), which needs --allow-mutating, and
 * anything matching the destructive lexicon is never executed at all.
 */
export function classifyAction(action = {}, policy = {}) {
  const destructive = policy.destructivePatterns || DEFAULT_DESTRUCTIVE_PATTERNS;
  const safe = policy.safePatterns || DEFAULT_SAFE_PATTERNS;
  const unknownClass = policy.unknownActionClass === 'destructive' ? 'destructive' : 'mutating';

  if ((policy.deny || []).includes(action.key)) {
    return { class: 'destructive', classifiedBy: 'config-deny', reason: 'listed in actionPolicy.deny' };
  }
  if ((policy.allow || []).includes(action.key)) {
    return { class: 'safe', classifiedBy: 'config-allow', reason: 'listed in actionPolicy.allow' };
  }
  if (action.download) {
    return { class: 'destructive', classifiedBy: 'download', reason: 'download link' };
  }
  if (matchesAny(action.name, destructive)) {
    return { class: 'destructive', classifiedBy: 'lexicon', reason: 'name matches destructive lexicon' };
  }
  // Off-origin links are harmless to *record* but are never followed, so classifying
  // them as safe keeps the map honest without widening the crawl.
  if (action.kind === 'link' && action.external) {
    return { class: 'safe', classifiedBy: 'external-link', reason: 'external origin, not followed' };
  }
  if (action.kind === 'link' && action.href && !action.external) {
    return { class: 'safe', classifiedBy: 'same-origin-link', reason: 'same-origin navigation' };
  }
  if (action.kind === 'submit' || action.formMutating) {
    return { class: 'mutating', classifiedBy: 'form-submit', reason: 'submits a non-GET form' };
  }
  // Single-page apps navigate with buttons as often as with links. A control inside
  // a navigation landmark is a structural signal, not a guess about its wording —
  // and it is checked after the destructive lexicon, so a logout button in a nav
  // is still refused.
  if (action.inNav) {
    return { class: 'safe', classifiedBy: 'navigation-landmark', reason: 'control inside a navigation landmark' };
  }
  if (matchesAny(action.name, safe)) {
    return { class: 'safe', classifiedBy: 'lexicon', reason: 'name matches safe lexicon' };
  }
  if (action.role === 'tab') {
    return { class: 'safe', classifiedBy: 'role', reason: 'tab switch' };
  }
  return { class: unknownClass, classifiedBy: 'default', reason: 'not positively recognized as safe' };
}

// ---------- graph queries ----------

export function statesByRoute(map, route) {
  const wanted = normalizePath(route);
  return (map.states || []).filter(state => state.route === wanted);
}

export function stateById(map, id) {
  return (map.states || []).find(state => state.id === id) || null;
}

export function transitionsFrom(map, stateId) {
  return (map.transitions || []).filter(transition => transition.from === stateId);
}

/**
 * Replay paths are safe-only by design: a path containing a mutating step is not
 * reproducible, and a route the map hands out must be walkable again.
 */
export function shortestSafePath(map, fromStateId, toStateId) {
  if (fromStateId === toStateId) return [];
  const outgoing = new Map();
  for (const transition of map.transitions || []) {
    if (transition.class !== 'safe' || transition.status !== 'verified' || !transition.to) continue;
    if (!outgoing.has(transition.from)) outgoing.set(transition.from, []);
    outgoing.get(transition.from).push(transition);
  }
  const previous = new Map([[fromStateId, null]]);
  const queue = [fromStateId];
  while (queue.length) {
    const current = queue.shift();
    for (const transition of outgoing.get(current) || []) {
      if (previous.has(transition.to)) continue;
      previous.set(transition.to, transition);
      if (transition.to === toStateId) {
        const path = [];
        let cursor = transition;
        while (cursor) { path.unshift(cursor); cursor = previous.get(cursor.from); }
        return path;
      }
      queue.push(transition.to);
    }
  }
  return null;
}

/** Shortest safe path from any entrypoint, preferring the shortest overall. */
export function pathFromEntrypoints(map, toStateId, fromStateId = null) {
  const origins = fromStateId ? [fromStateId] : (map.entrypoints || []);
  let best = null;
  let bestOrigin = null;
  for (const origin of origins) {
    const path = shortestSafePath(map, origin, toStateId);
    if (path && (best === null || path.length < best.length)) { best = path; bestOrigin = origin; }
  }
  return best === null ? null : { origin: bestOrigin, path: best };
}

// ---------- rendering ----------

export function playwrightExpr(action = {}) {
  const name = action.name ? String(action.name) : '';
  const quoted = text => "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (name && action.role) {
    return `page.getByRole(${quoted(action.role)}, { name: ${quoted(name)} })`;
  }
  if (action.cssFallback) return `page.locator(${quoted(action.cssFallback)})`;
  return `page.locator(${quoted(action.selector || 'body')})`;
}

export function routeToSteps(map, resolved, baseUrl) {
  const steps = [];
  const originState = stateById(map, resolved.origin);
  steps.push({
    n: 1,
    kind: 'goto',
    url: (baseUrl || map.app?.baseUrl || '') + (originState ? originState.evidence?.urlSample || originState.route : '/'),
    playwright: `await page.goto(${JSON.stringify((baseUrl || map.app?.baseUrl || '') + (originState ? originState.evidence?.urlSample || originState.route : '/'))})`,
    state: originState ? originState.route : '/',
  });
  for (const transition of resolved.path) {
    const target = stateById(map, transition.to);
    steps.push({
      n: steps.length + 1,
      kind: transition.action.kind,
      role: transition.action.role,
      name: transition.action.name,
      class: transition.class,
      playwright: `await ${playwrightExpr(transition.action)}.click()`,
      to: target ? target.route : null,
      toTitle: target ? target.title : null,
      transition: transition.id,
    });
  }
  return steps;
}

function escapeCell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderMarkdown(map, freshness = {}) {
  const lines = [];
  const byId = new Map((map.states || []).map(state => [state.id, state]));
  const short = text => {
    const value = String(text ?? '');
    return value.length > 40 ? value.slice(0, 39) + '…' : value;
  };
  const label = id => {
    const state = byId.get(id);
    if (!state) return `\`${id}\``;
    return `\`${state.route}\`${state.kind === 'overlay' ? ' ▸' : ''} ${short(state.title)}`;
  };

  lines.push('# Site map');
  lines.push('');
  lines.push('<!-- Generated by the screen-map skill. Do not edit by hand; run `screen-map report`. -->');
  lines.push('');
  lines.push(`- Base URL: \`${map.app?.baseUrl || ''}\``);
  lines.push(`- App commit: \`${map.app?.commit || 'unknown'}\`${map.app?.dirty ? ' (working tree dirty at crawl time)' : ''}`);
  lines.push(`- Crawled: ${map.run?.finishedAt || map.run?.startedAt || 'unknown'}`);
  if (freshness.status) lines.push(`- Freshness: **${freshness.status}**${freshness.detail ? ` — ${freshness.detail}` : ''}`);
  const coverage = map.coverage || {};
  lines.push(`- Coverage: ${coverage.states ?? 0} states, ${coverage.actionsSeen ?? 0} actions seen, ${coverage.executed ?? 0} executed, ${coverage.blocked ?? 0} not executed`);
  if (map.run?.budgetHit) lines.push(`- **Budget hit: ${map.run.budgetHit}** — the map is incomplete.`);
  lines.push('');

  lines.push('## Screens');
  lines.push('');
  lines.push('| Route | Title | Kind | Reachable |');
  lines.push('| --- | --- | --- | --- |');
  for (const state of map.states || []) {
    const entry = (map.entrypoints || []).includes(state.id);
    const reachable = entry ? 'entrypoint' : (state.reachable || 'safe path');
    lines.push(`| \`${escapeCell(state.route)}\` | ${escapeCell(state.title)} | ${state.kind} | ${reachable} |`);
  }
  lines.push('');

  lines.push('## Transitions');
  lines.push('');
  lines.push('| From | Action | To | Class | Status |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const transition of map.transitions || []) {
    const action = transition.action || {};
    const target = transition.to ? label(transition.to) : (transition.blockedReason ? `_${transition.blockedReason}_` : '_unknown_');
    lines.push(`| ${escapeCell(label(transition.from))} | ${action.kind} ${escapeCell(action.name || action.href || '')} | ${escapeCell(target)} | ${transition.class} | ${transition.status} |`);
  }
  lines.push('');

  const notExecuted = (map.transitions || []).filter(transition => transition.status !== 'verified');
  if (notExecuted.length) {
    lines.push('## Not executed');
    lines.push('');
    lines.push('These edges exist in the UI but were never performed. Their existence is still recorded.');
    lines.push('');
    for (const transition of notExecuted) {
      const action = transition.action || {};
      lines.push(`- ${label(transition.from)} → **${escapeCell(action.name || action.href || action.kind)}** (${transition.class}, ${transition.status}${transition.blockedReason ? `: ${transition.blockedReason}` : ''})`);
    }
    lines.push('');
  }

  if ((coverage.frontier || []).length) {
    lines.push('## Unexplored frontier');
    lines.push('');
    lines.push('The crawl budget ran out before these were reached.');
    lines.push('');
    for (const item of coverage.frontier) lines.push(`- \`${escapeCell(item)}\``);
    lines.push('');
  }

  return lines.join('\n');
}
