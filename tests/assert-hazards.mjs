/**
 * Assertions over a crawl of `/hazards` — the three things `references/action-policy.md`
 * promises the driver survives: a modal javascript dialog, a popup the driver is not
 * attached to, and a download. All three used to be claims with nothing behind them.
 */

import { readFileSync } from 'node:fs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}

const map = JSON.parse(readFileSync(args.get('map'), 'utf8'));
const base = args.get('base');
const clicks = await (await fetch(base + '/__clicks')).json();

let pass = 0;
let fail = 0;
function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

const named = name => map.transitions.find(transition => transition.action.name === name);
const stateOf = id => map.states.find(state => state.id === id);

check('the crawl finished instead of wedging',
  !map.run.budgetHit && map.coverage.frontier.length === 0,
  JSON.stringify({ budgetHit: map.run.budgetHit, frontier: map.coverage.frontier }));

// ---------- javascript dialog ----------

const ask = named('전체 보기');
check('the button behind a confirm() is recorded and pressed',
  ask?.status === 'verified', JSON.stringify({ status: ask?.status, reason: ask?.blockedReason }));
check('the dialog is recorded rather than silently swallowed',
  (map.run.dialogs || []).some(dialog => dialog.type === 'confirm'),
  JSON.stringify(map.run.dialogs));
// Cancelling is the whole point: an accepted confirm runs the very work the guard
// exists to withhold. The counter is the only witness that it was cancelled and not
// merely dismissed after the fact.
check('the dialog was cancelled, so the work it guards never ran', clicks.confirmed === 0,
  'server counted ' + clicks.confirmed + ' guarded actions');

// ---------- popup ----------

const popup = named('장바구니 새 창 보기');
check('a control that opens a window with script is still walked',
  popup?.status === 'verified', JSON.stringify({ status: popup?.status, reason: popup?.blockedReason }));
// The popup is closed on sight, so the tab the crawl watches never moved. An edge back
// to the same screen is the honest record; inventing a `/cart` node out of a tab nobody
// observed would be a route the map could not replay.
check('the popup does not become a screen the crawl never watched',
  stateOf(popup?.to)?.route === '/hazards'
    && !map.states.some(state => state.route === '/cart'),
  JSON.stringify({ to: stateOf(popup?.to)?.route, states: map.states.map(state => state.route) }));

// A `target=_blank` *link* is a different animal: Chrome navigates the driven tab, so
// there is no stray window and the crawl should record a plain navigation. Asserted so
// that stays a fact about this driver rather than an assumption.
const blank = named('설명 문서');
check('a target=_blank link is walked as an ordinary navigation',
  blank?.status === 'verified' && stateOf(blank?.to)?.route === '/leaf',
  JSON.stringify({ status: blank?.status, to: stateOf(blank?.to)?.route }));

// ---------- download ----------

const download = named('보고서');
check('a download link is refused by its attribute, not by its wording',
  download?.class === 'destructive' && download?.classifiedBy === 'download',
  JSON.stringify({ class: download?.class, by: download?.classifiedBy }));
check('the download link is never followed', download?.status === 'unexplored',
  JSON.stringify({ status: download?.status, reason: download?.blockedReason }));
check('the server never served the file', clicks.download === 0,
  'server counted ' + clicks.download + ' downloads');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
