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

/**
 * The navigation target for an auth step. `normalizePath` answers "are these the same
 * screen", so it drops the query; an auth recipe asks the opposite question and needs
 * the query it was given — `?openLogin=true`, `?next=/somewhere`, an SSO `?code=`.
 * Normalizing a navigation target sends the browser somewhere else and reports nothing;
 * the run then dies several steps later at a selector that was never going to be on the
 * page it actually landed on.
 */
export function authTarget(path) {
  const raw = String(path ?? '/');
  const cut = raw.search(/[?#]/);
  return cut < 0 ? normalizePath(raw) : normalizePath(raw.slice(0, cut)) + raw.slice(cut);
}

/**
 * Identity of a replay attempt: which entrypoint, walked through which transitions. Two
 * attempts sharing a key are the same walk and reach the same verdict, so a failure can
 * be remembered against it. A map that has since grown a different route to the screen
 * produces a different key, and is therefore tried again.
 */
export function replayPathKey(resolved) {
  return String(resolved.origin) + '>' + (resolved.path || []).map(transition => transition.id).join('>');
}

/**
 * Whether a request is evidence that a render is still pending.
 *
 * Playwright's `networkidle` counts every resource type except favicons and EventSource,
 * and its own documentation calls the option DISCOURAGED — "rely on web assertions to
 * assess readiness instead". Both halves of that are worth taking seriously. Against a
 * dev server the strict rule never fires at all: Vite ships the app as hundreds of
 * unbundled modules, and a page long since drawn keeps streaming them, so every wait runs
 * to its timeout and returns the same screen it had a moment after loading.
 *
 * So this counts only what can carry new content into the page, and leans on the
 * fingerprint-stability half of `settle` — the assertion Playwright points to, which
 * plain networkidle does not have — to catch a screen that has not finished drawing.
 * EventSource is excluded for Playwright's reason and not a different one: an open stream
 * never ends, so counting it means never settling.
 */
const SETTLE_RELEVANT = new Set(['XHR', 'Fetch', 'Document']);

export function countsTowardSettle(resourceType) {
  // An absent type is counted: waiting too long is recoverable, while settling early
  // writes a half-drawn screen into the map as though it were a screen.
  if (!resourceType) return true;
  return SETTLE_RELEVANT.has(resourceType);
}

/**
 * The storage-seed script for a page, or null when there is nothing to seed. Values go
 * in with `setItem`, so the app sees exactly what a previous session would have left.
 * Never put a credential here — a seed suppresses first-run UI, and `auth.steps` is the
 * only thing that should be handling secrets.
 */
export function storageSeedSource(seed) {
  if (!seed) return null;
  const local = Object.entries(seed.localStorage || {}).map(([key, value]) => [key, String(value)]);
  const session = Object.entries(seed.sessionStorage || {}).map(([key, value]) => [key, String(value)]);
  if (!local.length && !session.length) return null;
  return '(()=>{try{'
    + `for(const [k,v] of ${JSON.stringify(local)}) localStorage.setItem(k,v);`
    + `for(const [k,v] of ${JSON.stringify(session)}) sessionStorage.setItem(k,v);`
    + '}catch(e){/* opaque origin — nothing to seed */}})()';
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

/**
 * A name whose head noun is a viewing word names a *screen*, not the verb inside it.
 * Korean puts that head last, so `승인 대기 목록` is a list of things awaiting
 * approval and `전송 내역` is a log of sends — both were classified `destructive` by
 * the verbs they contain, which meant a crawl never followed them and the map never
 * learned the screens behind them.
 *
 * This only ever *suppresses* a destructive match; it never promotes anything. The
 * action is then judged by the remaining rules, so a bare button still lands on
 * `mutating` rather than `safe`.
 */
export const DEFAULT_VIEW_NOUNS = [
  '목록', '리스트', '이력', '내역', '현황', '조회', '통계', '요약', '상세', '정보', '보기', '화면', '페이지',
  'list', 'history', 'log', 'report', 'summary', 'details', 'detail', 'info', 'status', 'page', 'view',
];

/**
 * Hangul has no word boundary, so `\b` does nothing to it: `/\b게시\b/` still matches
 * `게시판`. What bounds a Korean verb stem is the set of endings that may legally
 * follow it — `게시하기` is the verb, `게시판` is a different noun that happens to
 * start with the same two syllables. Anything else in Hangul directly after the stem
 * means this is not that verb.
 */
const KO_VERB_TAIL = '(?:하기|하다|하는|하며|하고|하여|해서|해요|합니다|됩니다|했[가-힣]*|하겠[가-힣]*'
  + '|하시[가-힣]*|되었[가-힣]*|한|할|함|해|됨|된|되기)?';

/**
 * English destructive verbs match their inflections too: failing closed on `Deletes`
 * costs one unexplored edge, missing it costs data. The safe lexicon deliberately
 * does *not* inflect — every extra thing it matches is an extra thing that gets
 * clicked without --allow-mutating.
 */
const EN_INFLECTION = '(?:s|es|d|ed|ing)?';

const HANGUL = /[가-힣]/;
const patternCache = new Map();

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function boundedPattern(pattern, inflect) {
  const cacheKey = (inflect ? 'i:' : 'x:') + pattern;
  const cached = patternCache.get(cacheKey);
  if (cached) return cached;
  const source = escapeRegExp(String(pattern));
  const built = HANGUL.test(pattern)
    ? new RegExp(source + KO_VERB_TAIL + '(?![가-힣])')
    : new RegExp('\\b' + source + (inflect ? EN_INFLECTION : '') + '\\b', 'i');
  patternCache.set(cacheKey, built);
  return built;
}

/**
 * Substring matching was the original implementation, and it was wrong in both
 * directions at once. `Install` contained `all` and came back **safe** — executed
 * during an ordinary crawl, which is precisely what the policy promises never
 * happens. `게시판` contained `게시` and came back **destructive**, so a bulletin
 * board was never opened.
 */
function matchesAny(name, patterns, inflect = false) {
  const haystack = String(name || '');
  if (!haystack) return false;
  return patterns.some(pattern => boundedPattern(pattern, inflect).test(haystack));
}

function looksLikeAView(name, nouns) {
  const trimmed = String(name || '').trim().toLowerCase();
  if (!trimmed) return false;
  return nouns.some(noun => {
    const lower = String(noun).toLowerCase();
    return HANGUL.test(noun)
      ? trimmed.endsWith(lower)
      : new RegExp('\\b' + escapeRegExp(lower) + 's?$').test(trimmed);
  });
}

/**
 * The guarantee is one-directional: an action runs by default only when it is
 * *positively recognized* as safe. Everything unrecognized falls to
 * `unknownActionClass` (default `mutating`), which needs --allow-mutating. An
 * exact user-authored allow entry reclassifies a heuristic false positive;
 * anything that remains destructive is never executed.
 */
export function classifyAction(action = {}, policy = {}) {
  const destructive = policy.destructivePatterns || DEFAULT_DESTRUCTIVE_PATTERNS;
  const safe = policy.safePatterns || DEFAULT_SAFE_PATTERNS;
  const viewNouns = policy.viewNouns || DEFAULT_VIEW_NOUNS;
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
  // A same-origin link whose name reads destructive stays refused: `GET /delete?id=1`
  // exists, and the markup cannot tell it apart from a navigation. The reason says it
  // was a link so a human reviewing map.md can see the one case worth an
  // `actionPolicy.allow` entry.
  if (matchesAny(action.name, destructive, true) && !looksLikeAView(action.name, viewNouns)) {
    return {
      class: 'destructive',
      classifiedBy: 'lexicon',
      reason: action.kind === 'link' && action.href && !action.external
        ? 'name matches destructive lexicon (same-origin link: a GET that deletes cannot be told apart from a navigation)'
        : 'name matches destructive lexicon',
    };
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
export function shortestSafePath(map, fromStateId, toStateId, { safeOnly = true } = {}) {
  if (fromStateId === toStateId) return [];
  const outgoing = new Map();
  for (const transition of map.transitions || []) {
    if (transition.status !== 'verified' || !transition.to) continue;
    if (safeOnly && transition.class !== 'safe') continue;
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
export function pathFromEntrypoints(map, toStateId, fromStateId = null, options = {}) {
  const origins = fromStateId ? [fromStateId] : (map.entrypoints || []);
  let best = null;
  let bestOrigin = null;
  for (const origin of origins) {
    const path = shortestSafePath(map, origin, toStateId, options);
    if (path && (best === null || path.length < best.length)) { best = path; bestOrigin = origin; }
  }
  return best === null ? null : { origin: bestOrigin, path: best };
}

/**
 * Why there was no route. "No safe path" is true of a screen nobody ever reached and of
 * one reached through a wizard's Save button, and the reader's next move is different:
 * the first needs a wider crawl, the second needs to accept a one-shot path. Refusing to
 * hand back a non-reproducible route is right; refusing to say it exists is not.
 */
export function mutatingDetour(map, toStateId, fromStateId = null) {
  const resolved = pathFromEntrypoints(map, toStateId, fromStateId, { safeOnly: false });
  if (!resolved) return null;
  const steps = resolved.path.filter(transition => transition.class !== 'safe');
  if (!steps.length) return null;
  return {
    length: resolved.path.length,
    via: steps.map(transition => ({
      from: stateById(map, transition.from)?.route || transition.from,
      action: transition.action?.name || transition.action?.key || '?',
      class: transition.class,
    })),
  };
}

// ---------- rendering ----------

export function playwrightExpr(action = {}) {
  const name = action.name ? String(action.name) : '';
  const quoted = text => "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (action.ambiguous && action.cssFallback) {
    return `page.locator(${quoted(action.cssFallback)})`;
  }
  if (name && action.role) {
    const semantic = `page.getByRole(${quoted(action.role)}, { name: ${quoted(name)} })`;
    if (action.kind === 'link' && action.hrefRaw) {
      const hrefSelector = `a[href=${JSON.stringify(String(action.hrefRaw))}]`;
      return `${semantic}.and(page.locator(${quoted(hrefSelector)}))`;
    }
    return semantic;
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

function truncate(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

/** Mermaid reads `"`, `<`, `>` and `|` as syntax wherever they appear in a label. */
function mermaidText(text, limit = 28) {
  return truncate(String(text ?? '').replace(/["<>|{}[\]]/g, ' '), limit);
}

/**
 * The map as a picture. The tables below it are the record; this is the part a human
 * can actually check, which is the step the whole workflow rests on — a reviewer who
 * cannot see the shape of the app cannot tell a good crawl from a broken one.
 *
 * Only verified transitions are drawn, because only those are claims the map makes
 * about walking. What was *not* walked is not hidden: it rides on the node it belongs
 * to as a count, so a screen the crawl barely opened looks different from one it
 * exhausted.
 */
export function renderMermaid(map) {
  const states = map.states || [];
  if (!states.length) return [];
  const entrypoints = new Set(map.entrypoints || []);
  const known = new Set(states.map(state => state.id));

  // An action that lands back on the screen it was pressed from says nothing about
  // navigation, and there are dozens of them on a real toolbar. Drawn, they bury the
  // graph in self-loops; counted on the node, they still show the screen was worked.
  const loops = new Map();
  const edges = new Map();
  const unexplored = new Map();
  for (const transition of map.transitions || []) {
    if (transition.status !== 'verified' || !transition.to) {
      unexplored.set(transition.from, (unexplored.get(transition.from) || 0) + 1);
      continue;
    }
    if (!known.has(transition.from) || !known.has(transition.to)) continue;
    if (transition.from === transition.to) {
      loops.set(transition.from, (loops.get(transition.from) || 0) + 1);
      continue;
    }
    const key = transition.from + '>' + transition.to;
    if (!edges.has(key)) edges.set(key, { from: transition.from, to: transition.to, names: [] });
    edges.get(key).names.push(transition.action?.name || transition.action?.kind || '?');
  }

  const lines = ['```mermaid', 'flowchart LR'];
  for (const state of states) {
    const badges = [];
    if (loops.get(state.id)) badges.push(`↻${loops.get(state.id)}`);
    if (unexplored.get(state.id)) badges.push(`⊘${unexplored.get(state.id)}`);
    const label = [
      mermaidText(state.route, 34),
      mermaidText(state.title),
      badges.join(' '),
    ].filter(Boolean).join('<br/>');
    // Stadium marks a screen reachable by URL alone; a hexagon marks an overlay,
    // which exists only on top of whatever raised it.
    const shape = entrypoints.has(state.id) ? `(["${label}"])`
      : state.kind === 'overlay' ? `{{"${label}"}}`
      : `["${label}"]`;
    lines.push(`  ${state.id}${shape}`);
  }
  for (const edge of edges.values()) {
    const [first, ...rest] = edge.names;
    const label = mermaidText(first, 24) + (rest.length ? ` +${rest.length}` : '');
    lines.push(`  ${edge.from} -->|"${label}"| ${edge.to}`);
  }
  if (entrypoints.size) {
    lines.push(`  classDef entry stroke-width:3px`);
    lines.push(`  class ${[...entrypoints].filter(id => known.has(id)).join(',')} entry`);
  }
  lines.push('```');
  lines.push('');
  lines.push('Stadium = entrypoint · hexagon = overlay · ↻ actions that stay on the screen ·'
    + ' ⊘ actions recorded but never executed. Only verified transitions are drawn.');
  return lines;
}

/**
 * Where the clock went, as a table. Budget exhaustion is this skill's ordinary failure,
 * and the fix depends entirely on which phase ate the time — narrowing entrypoints,
 * dropping a screen, or turning replay verification off are different answers to
 * different numbers. Reporting the total alone invites optimising by guess.
 */
export function renderTiming(timing) {
  if (!timing || !(timing.phases || []).length) return [];
  const seconds = ms => (ms / 1000).toFixed(1) + 's';
  const share = ms => timing.totalMs ? Math.round((ms / timing.totalMs) * 100) + '%' : '—';
  const lines = ['## Where the clock went', ''];
  lines.push(`Total ${seconds(timing.totalMs)}.`);
  lines.push('');
  lines.push('| Phase | Time | Share | Count |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const phase of timing.phases) {
    lines.push(`| \`${escapeCell(phase.label)}\` | ${seconds(phase.ms)} | ${share(phase.ms)} | ${phase.count} |`);
  }
  lines.push('');
  if ((timing.byScreen || []).length) {
    lines.push('| Screen | Time | Actions | Per action |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const row of timing.byScreen) {
      const each = row.actions ? seconds(row.ms / row.actions) : '—';
      lines.push(`| \`${escapeCell(row.route)}\` ${escapeCell(row.title)} | ${seconds(row.ms)} | ${row.actions} | ${each} |`);
    }
    lines.push('');
  }
  if ((timing.slowest || []).length) {
    lines.push('Slowest single actions — an average over a bimodal cost describes neither half:');
    lines.push('');
    lines.push('| Action | On | Outcome | Time |');
    lines.push('| --- | --- | --- | ---: |');
    for (const row of timing.slowest) {
      lines.push(`| ${escapeCell(row.action)} | \`${escapeCell(row.from)}\` | ${escapeCell(row.status)} | ${seconds(row.ms)} |`);
    }
    lines.push('');
  }
  return lines;
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
  // Maps crawled before `blocked` was split into its parts still carry the old field.
  const notExecutedCount = coverage.notExecuted ?? coverage.blocked ?? 0;
  const breakdown = ['unexplored', 'sampled', 'blocked', 'failed']
    .filter(key => coverage[key]).map(key => `${coverage[key]} ${key}`).join(', ');
  lines.push(`- Coverage: ${coverage.states ?? 0} states, ${coverage.actionsSeen ?? 0} actions seen, `
    + `${coverage.executed ?? 0} executed, ${notExecutedCount} not executed${breakdown ? ` (${breakdown})` : ''}`);
  // A crawl stops for two different kinds of reason, and conflating them misleads: a
  // budget is a ceiling the caller set and can raise, while the rest mean the run never
  // came back — the map on disk is whatever had been walked at that moment.
  const STOPPED_EARLY = {
    incomplete: 'this crawl was still running when the file was written; it never reported finishing',
    interrupted: 'the crawl was stopped by hand (Ctrl-C)',
    crashed: 'the crawl died with an error',
  };
  if (map.run?.budgetHit) {
    const early = STOPPED_EARLY[map.run.budgetHit];
    lines.push(early
      ? `- **Stopped early: ${map.run.budgetHit}** — ${early}. The map is partial.`
      : `- **Budget hit: ${map.run.budgetHit}** — the map is incomplete.`);
  }
  lines.push('');

  const diagram = renderMermaid(map);
  if (diagram.length) {
    lines.push('## Shape');
    lines.push('');
    lines.push(...diagram);
    lines.push('');
  }

  lines.push(...renderTiming(map.run?.timing));

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
