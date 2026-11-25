/**
 * What a recording must and must not put in a map.
 *
 * The negatives carry most of the weight here. A recorder that clicks, that promotes what
 * it saw to `verified`, or that files a destructive control as a route, fails quietly and
 * looks like it worked.
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

// ---------- what was watched ----------

if (!seeded) {
  check('the clicked navigation and an edge out of an opened dropdown are recorded',
    !!edge('/', '/items') && observed.some(t => (byId.get(t.from) || {}).kind === 'overlay'),
    `routes seen: ${routes.join(', ')}`);

  // The back button is the one screen change with no control behind it. Filed as an
  // arrival from nowhere it would promote the screen to an entrypoint and lose the edge;
  // filed as a click it would name a control nobody pressed.
  const back = observed.find(t => t.action && t.action.kind === 'history');
  check('pressing the browser back button is a safe transition back to the screen the walk came from',
    !!back && routeOf(back.from) === '/items/:id' && routeOf(back.to) === '/items' && back.class === 'safe',
    back ? `${routeOf(back.from)} → ${routeOf(back.to)} ${back.class}` : 'no history edge');
  check('a screen arrived at by URL says so rather than inventing a click',
    map.states.some(state => state.reachable === 'direct-url') && map.entrypoints.length > 0);
}

// `source` says who *found* the entry, not who last learned something about it.
const beforeIds = new Set(((before && before.transitions) || []).map(transition => transition.id));
check('an edge the recording discovered is attributed to the recording',
  observed.length > 0 && observed.filter(transition => !beforeIds.has(transition.id))
    .every(transition => transition.source === 'record'),
  JSON.stringify(observed.map(t => [t.id, t.source])));
check('nothing a recording watched is presented as proved',
  observed.every(transition => transition.lastObservedAt && transition.verifiedAtCommit === null && !transition.lastVerifiedAt));

// ---------- what must never happen ----------

check('controls that were never pressed are recorded, leading nowhere',
  map.transitions.some(t => t.status === 'unexplored')
    && map.transitions.filter(t => t.status === 'unexplored').every(t => t.to === null));
const destructive = map.transitions.filter(transition => transition.class === 'destructive');
check('a destructive control is recognized and never pressed',
  destructive.length > 0 && destructive.every(transition => transition.status === 'unexplored' && transition.to === null),
  JSON.stringify(destructive.map(t => [t.action.name, t.status])));

// ---------- the run report ----------

const recording = (map.recordings || [])[map.recordings.length - 1];
check('a finished recording says how it ended, with the run\'s numbers',
  !!recording && recording.stoppedBy && recording.stoppedBy !== 'incomplete'
    && recording.edges > 0 && recording.observations > 0,
  JSON.stringify(recording));

// ---------- adding to what a crawl already found ----------

if (seeded) {
  // The whole reason to record on top of a crawl. The crawl refused this form submit as
  // mutating and never learned what follows it; a person walking the same screen does.
  const submitted = observed.find(transition => transition.class === 'mutating');
  check('a step the crawl refused to press is learned by watching, and stays mutating',
    !!submitted && !!submitted.to && submitted.source === 'crawl',
    `observed: ${JSON.stringify(observed.map(t => [t.action.key, t.class, t.source]))}`);
  const wasVerified = ((before && before.transitions) || [])
    .filter(transition => transition.status === 'verified').map(transition => transition.id);
  const nowById = new Map(map.transitions.map(transition => [transition.id, transition]));
  check('re-walking a proved path leaves the proof alone rather than downgrading it',
    wasVerified.length > 0 && wasVerified.every(id => (nowById.get(id) || {}).status === 'verified'),
    JSON.stringify(wasVerified.filter(id => (nowById.get(id) || {}).status !== 'verified')));
  const ids = map.states.map(state => state.id);
  const edgeIds = map.transitions.map(transition => transition.id);
  check('state and edge ids continue instead of colliding, and every crawled screen is kept',
    new Set(ids).size === ids.length && new Set(edgeIds).size === edgeIds.length
      && !!before && before.states.every(state => ids.includes(state.id)),
    `state ids: ${JSON.stringify(ids)}`);
  // Compared against the map as it stood, not against git HEAD: the query suite parks an
  // unreachable commit in this map, and a recording must not quietly fix that.
  check('the freshness basis is untouched and the recording is appended to the history',
    !!before && map.app.commit === before.app.commit
      && (map.recordings || []).length === ((before && before.recordings) || []).length + 1,
    `map says ${map.app.commit}, before the recording it was ${before && before.app.commit}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
