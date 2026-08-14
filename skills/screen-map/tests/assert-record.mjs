/**
 * What a recording must and must not put in a map.
 *
 * The negatives carry most of the weight here. A recorder that clicks, that closes a
 * browser it was only watching, that promotes what it saw to `verified`, or that files a
 * destructive control as a route, fails quietly and looks like it worked.
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf('--' + name);
  return index >= 0 ? args[index + 1] : null;
};

const map = JSON.parse(readFileSync(flag('map'), 'utf8'));
const mode = flag('mode') || 'record';
const seeded = mode === 'seeded';
/** The same map as it stood before the recording, for the properties that are about change. */
const before = flag('before') ? JSON.parse(readFileSync(flag('before'), 'utf8')) : null;

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
};

const routes = map.states.map(state => state.route);
const observed = map.transitions.filter(transition => transition.status === 'observed');
const byId = new Map(map.states.map(state => [state.id, state]));
const routeOf = id => (byId.get(id) || {}).route || '?';
const edge = (from, to) => observed.find(t => routeOf(t.from) === from && routeOf(t.to) === to);

check('the map is written at the current schema', map.schema === 2, `schema ${map.schema}`);

// ---------- what was watched ----------

check('a session that was driven produces observed edges', observed.length > 0,
  `statuses: ${JSON.stringify(map.transitions.map(t => t.status))}`);

if (!seeded) {
  check('the clicked navigation is recorded as an edge', !!edge('/', '/items'),
    `routes seen: ${routes.join(', ')}`);
  check('a click that opens a dropdown is a screen of its own',
    map.states.some(state => state.kind === 'overlay'),
    `kinds: ${map.states.map(s => s.kind).join(', ')}`);
  check('an edge out of that overlay is recorded too',
    observed.some(t => (byId.get(t.from) || {}).kind === 'overlay'));

  // The back button is the one screen change with no control behind it. Filed as an
  // arrival from nowhere it would promote the screen to an entrypoint and lose the edge;
  // filed as a click it would name a control nobody pressed.
  const back = observed.find(t => t.action && t.action.kind === 'history');
  check('pressing the browser back button is recorded as a transition', !!back,
    `kinds seen: ${[...new Set(map.transitions.map(t => t.action && t.action.kind))].join(', ')}`);
  if (back) {
    check('it leads back to the screen the walk came from',
      routeOf(back.from) === '/items/:id' && routeOf(back.to) === '/items',
      `${routeOf(back.from)} → ${routeOf(back.to)}`);
    check('it is safe to replay: going back presses nothing', back.class === 'safe', back.class);
    check('and the screen it landed on is not promoted to an entrypoint by arriving there',
      !map.entrypoints.includes(back.to) || (byId.get(back.to) || {}).reachable !== 'direct-url');
  }
  check('the crawl-side back button does not exist: only a recording makes one',
    map.transitions.filter(t => t.action && t.action.kind === 'history')
      .every(t => t.status === 'observed'));
}

// `source` says who *found* the entry, not who last learned something about it. An edge
// the crawl listed but refused to press is discovered by the crawl and watched by a
// recording, so it keeps `source: "crawl"` and gains `status: "observed"` — conflating the
// two would erase the fact that the crawl is where the control came from.
const beforeIds = new Set(((before && before.transitions) || []).map(transition => transition.id));
check('an edge the recording discovered is attributed to the recording',
  observed.filter(transition => !beforeIds.has(transition.id))
    .every(transition => transition.source === 'record'),
  JSON.stringify(observed.map(t => [t.id, t.source])));
check('every observed edge says when it was watched',
  observed.every(transition => transition.lastObservedAt));
check('nothing a recording watched is presented as proved',
  observed.every(transition => transition.verifiedAtCommit === null && !transition.lastVerifiedAt));
check('every entry carries the commit it was seen at',
  map.states.every(state => state.commit !== undefined)
  && map.transitions.every(transition => transition.commit !== undefined));
check('first sight and last sight are both recorded',
  map.states.every(state => state.recordedAt && state.lastObservedAt));

// ---------- what was only seen, never pressed ----------

check('controls that were never pressed are still recorded',
  map.transitions.some(transition => transition.status === 'unexplored'),
  'a map naming only what was clicked would claim each screen has one action');
check('an unpressed control leads nowhere, rather than somewhere guessed',
  map.transitions.filter(t => t.status === 'unexplored').every(t => t.to === null));

// ---------- what must never happen ----------

const destructive = map.transitions.filter(transition => transition.class === 'destructive');
check('a destructive control is recognized even though nobody classified it by hand',
  destructive.length > 0, 'the fixture has a 삭제 button');
check('recording never presses a destructive control',
  destructive.every(transition => transition.status === 'unexplored' && transition.to === null),
  JSON.stringify(destructive.map(t => [t.action.name, t.status])));
check('nothing recorded is marked as having failed a replay',
  map.transitions.every(transition => transition.replayFailed !== true));

// ---------- reaching a screen without pressing anything ----------

if (!seeded) {
  check('a screen arrived at by URL says so rather than inventing a click',
    map.states.some(state => state.reachable === 'direct-url'));
}
check('such a screen becomes somewhere a route can start from',
  map.entrypoints.length > 0);

// ---------- the run report ----------

const recording = (map.recordings || [])[map.recordings.length - 1];
check('the recording is recorded', !!recording);
check('a finished recording says how it ended',
  !!recording && recording.stoppedBy && recording.stoppedBy !== 'incomplete',
  JSON.stringify(recording && recording.stoppedBy));
check('its numbers are the run\'s, not an empty template',
  !!recording && recording.edges > 0 && recording.observations > 0,
  JSON.stringify(recording));
check('coverage counts observed edges apart from unpressed ones',
  map.coverage.observed === observed.length
  && map.coverage.notExecuted === map.transitions.filter(t =>
    ['unexplored', 'sampled', 'blocked', 'failed'].includes(t.status)).length,
  JSON.stringify(map.coverage));

// ---------- adding to what a crawl already found ----------

if (seeded) {
  const crawled = map.transitions.filter(transition => transition.source === 'crawl');
  check('the crawl\'s own findings survive the recording', crawled.length > 0);
  check('what the crawl proved keeps its proof',
    crawled.filter(t => t.status === 'verified').length > 0
    && crawled.filter(t => t.status === 'verified').every(t => t.verifiedAtCommit !== null));

  // The whole reason to record on top of a crawl. The crawl refused this form submit as
  // mutating and never learned what follows it; a person walking the same screen does,
  // and the map has to end up holding what the crawl could not reach.
  const submitted = observed.find(transition => transition.class === 'mutating');
  check('a step the crawl refused to press is learned by watching somebody press it',
    !!submitted,
    `observed: ${JSON.stringify(observed.map(t => [t.action.key, t.class]))}`);
  check('and it leads somewhere, which is the part the crawl could never fill in',
    !!submitted && !!submitted.to);
  check('watching it does not make it safe to replay',
    !submitted || submitted.class === 'mutating');
  // The property is about the proof, not about who found the edge: an edge that was
  // `verified` before the recording must still be `verified` after it, no matter how many
  // times the session walked over it.
  const wasVerified = ((before && before.transitions) || [])
    .filter(transition => transition.status === 'verified').map(transition => transition.id);
  const nowById = new Map(map.transitions.map(transition => [transition.id, transition]));
  check('re-walking a proved path leaves the proof alone rather than downgrading it',
    wasVerified.length > 0
    && wasVerified.every(id => (nowById.get(id) || {}).status === 'verified'),
    JSON.stringify(wasVerified.filter(id => (nowById.get(id) || {}).status !== 'verified')));
  check('a crawl-found edge the crawl never pressed can still be learned by watching',
    observed.some(transition => transition.source === 'crawl'),
    'the /new submit was listed by the crawl and refused, then walked by the recording');
  const ids = map.states.map(state => Number(state.id.slice(1)));
  check('ids continue instead of colliding', new Set(ids).size === ids.length,
    `duplicate state ids: ${JSON.stringify(map.states.map(s => s.id))}`);
  const edgeIds = map.transitions.map(transition => transition.id);
  check('edge ids continue too', new Set(edgeIds).size === edgeIds.length);

  // Compared against the map as it stood, not against git HEAD: the property is that a
  // recording leaves the basis alone, whatever it was. (It is not HEAD here — the query
  // suite deliberately parks an unreachable commit in this map to exercise `unknown`
  // freshness, and that is exactly the kind of value a recording must not quietly fix.)
  check('the freshness basis is not advanced by a recording',
    !!before && map.app.commit === before.app.commit,
    `map says ${map.app.commit}, before the recording it was ${before && before.app.commit}`);
  check('the recording is appended to the map\'s history rather than replacing it',
    (map.recordings || []).length === ((before && before.recordings) || []).length + 1);
  check('every screen the crawl had is still there',
    !!before && before.states.every(state => map.states.some(kept => kept.id === state.id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
