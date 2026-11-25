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
//
// Cancelling is the whole point: an accepted confirm runs the very work the guard exists
// to withhold. The counter is the only witness that it was cancelled.
const ask = named('전체 보기');
check('the button behind a confirm() is pressed, the dialog recorded and cancelled',
  ask?.status === 'verified' && (map.run.dialogs || []).some(dialog => dialog.type === 'confirm')
    && clicks.confirmed === 0,
  JSON.stringify({ status: ask?.status, dialogs: map.run.dialogs, confirmed: clicks.confirmed }));

// ---------- popup ----------
//
// The popup is closed on sight, so the tab the crawl watches never moved. Inventing a
// `/cart` node out of a tab nobody observed would be a route the map could not replay.
const popup = named('장바구니 새 창 보기');
check('a control that opens a window is walked without the popup becoming a screen',
  popup?.status === 'verified' && stateOf(popup?.to)?.route === '/hazards'
    && !map.states.some(state => state.route === '/cart'),
  JSON.stringify({ status: popup?.status, to: stateOf(popup?.to)?.route, states: map.states.map(state => state.route) }));

// ---------- download ----------

const download = named('보고서');
check('a download link is refused by its attribute and the server never serves the file',
  download?.class === 'destructive' && download?.classifiedBy === 'download'
    && download?.status === 'unexplored' && clicks.download === 0,
  JSON.stringify({ class: download?.class, by: download?.classifiedBy, status: download?.status, downloads: clicks.download }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);