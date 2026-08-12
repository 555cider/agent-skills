/**
 * screen-map record: grow a map from a browser session somebody else is driving.
 *
 * The crawl learns the app by walking it. This learns it by watching — a Playwright
 * script connected over CDP, a dom-picker session, a person clicking. Everything those
 * sessions reach for free is exactly what a crawl cannot: screens behind a login, behind
 * a form submit, behind a step the action policy refuses to press.
 *
 * Two rules shape every decision in this file:
 *
 *   1. **Never touch the page.** No input is dispatched, no dialog answered, no popup
 *      closed, no viewport resized. A recorder that changes the run is recording itself.
 *   2. **Never invent causality.** An edge is written only when exactly one action is
 *      outstanding and one screen came back. Anything less certain is dropped and counted,
 *      because a transition that did not happen is worse than a transition not recorded.
 */

import { Page, sleep } from './browser.mjs';

const BINDING = '__screenMapEmit';

/** How long an unmatched click waits for a screen before it is given up on. */
const PENDING_TTL_MS = 12000;

/**
 * A recording has no natural end, so every checkpoint on disk has to be readable on its
 * own. `stoppedBy: "incomplete"` is what an unfinished one says about itself — the same
 * contract `crawl` uses for `budgetHit`, and for the same reason: a file that never got
 * to report how it ended must not look like one that ended cleanly.
 */
export function newRecordStats() {
  return {
    observations: 0,
    edges: 0,
    states: 0,
    droppedActions: 0,
    dropReasons: {},
    skippedHosts: {},
    sessions: 0,
    stoppedBy: 'incomplete',
  };
}

export async function recordSession({
  cdp,
  config,
  registry,
  allowHosts,
  forMs = null,
  targetId = null,
  progress = () => {},
  checkpoint = () => {},
  shouldStop = () => false,
  // Filled in place rather than returned alone: the caller checkpoints to disk while this
  // is still running, and a checkpoint that reported zeros for a session already twenty
  // edges deep would be worse than no numbers at all.
  stats = newRecordStats(),
} = {}) {
  const drop = reason => {
    stats.droppedActions += 1;
    stats.dropReasons[reason] = (stats.dropReasons[reason] || 0) + 1;
  };

  const hostAllowed = url => {
    try { return allowHosts.includes(new URL(url).hostname); }
    catch { return false; }
  };
  const noteSkipped = url => {
    let host;
    try { host = new URL(url).hostname; } catch { host = String(url).slice(0, 40); }
    stats.skippedHosts[host] = (stats.skippedHosts[host] || 0) + 1;
  };

  const recorders = new Map();
  const cleanups = [];
  let stopped = false;
  const debug = process.env.SCREEN_MAP_DEBUG === '1'
    ? line => process.stderr.write('  debug: ' + line + '\n')
    : () => {};

  async function attachTo(id) {
    if (recorders.has(id) || stopped) return;
    let sessionId;
    try { ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: id, flatten: true })); }
    catch { return; }   // the tab closed between discovery and attach

    // Contexts have to be tracked from before `Runtime.enable`, because enabling is what
    // replays the ones that already exist. Without them a binding call cannot be told
    // apart from one raised inside an iframe.
    const contexts = new Map();
    cleanups.push(cdp.listen('Runtime.executionContextCreated', sessionId, params => {
      contexts.set(params.context.id, params.context.auxData || {});
    }));
    cleanups.push(cdp.listen('Runtime.executionContextDestroyed', sessionId, params => {
      contexts.delete(params.executionContextId);
    }));

    const recorder = { sessionId, targetId: id, contexts, pending: [], lastState: null, busy: false, dirty: true };
    recorders.set(id, recorder);
    stats.sessions += 1;

    cleanups.push(cdp.listen('Runtime.bindingCalled', sessionId, params => {
      if (params.name !== BINDING) return;
      const auxData = contexts.get(params.executionContextId);
      // An iframe's click cannot be attributed to the top-level screen we observe, and
      // guessing is exactly what this file refuses to do.
      if (auxData && auxData.isDefault === false) { drop('iframe'); return; }
      let payload;
      try { payload = JSON.parse(params.payload); } catch { drop('unparseable'); return; }
      debug(`binding ${payload.cause} ${payload.action.key} from=${recorder.lastState ? recorder.lastState.route : 'null'}`);
      recorder.pending.push({ ...payload, from: recorder.lastState, receivedAt: Date.now() });
      recorder.dirty = true;
    }));

    const wake = () => { recorder.dirty = true; };
    cleanups.push(cdp.listen('Page.frameNavigated', sessionId, wake));
    cleanups.push(cdp.listen('Page.loadEventFired', sessionId, wake));

    await cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    // The binding has to exist before the harvest script runs, or the page-side recorder
    // sees no way to report and quietly installs no listeners at all.
    await cdp.send('Runtime.addBinding', { name: BINDING }, sessionId).catch(() => {});

    try {
      recorder.page = await Page.attach(cdp, { targetId: id, sessionId }, { recording: true });
    } catch (error) {
      recorders.delete(id);
      progress(`could not instrument a tab: ${error.message}`);
      return;
    }
    progress(`recording tab ${id.slice(0, 8)}`);
  }

  /** One settle-and-file pass for one tab. Never runs twice at once for the same tab. */
  async function pump(recorder) {
    if (recorder.busy || !recorder.page) return;
    recorder.busy = true;
    try {
      let observation;
      try { observation = await recorder.page.settle(); }
      catch (error) { debug(`settle failed: ${error.message}`); return; }
      if (!observation || !observation.url) { debug('settle returned nothing'); return; }
      debug(`settled on ${observation.pathname} with ${recorder.pending.length} pending`);

      // Expire before matching: a click whose screen never arrived must not be attached
      // to whatever screen shows up minutes later.
      const now = Date.now();
      const fresh = recorder.pending.filter(item => now - item.receivedAt < PENDING_TTL_MS);
      for (let i = 0; i < recorder.pending.length - fresh.length; i++) drop('timed-out');
      recorder.pending = fresh;

      if (!hostAllowed(observation.url)) {
        noteSkipped(observation.url);
        // Whatever was pressed happened somewhere we are not recording.
        for (const _ of recorder.pending) drop('host-not-allowed');
        recorder.pending = [];
        recorder.lastState = null;
        return;
      }

      const { state, isNew } = registry.upsertState(observation);
      stats.observations += 1;
      if (isNew) stats.states += 1;

      // What else is on this screen is worth as much as what was pressed. The crawl files
      // every control it can see and marks the ones it did not press `unexplored`; a
      // recording that filed only the clicked control would hand back a map claiming the
      // screen has exactly one action on it. Re-registering is free — identity dedupes.
      for (const action of observation.actions || []) registry.upsertTransition(state, action);

      const outstanding = recorder.pending;
      recorder.pending = [];

      if (outstanding.length === 1 && !outstanding[0].from) {
        // Pressed before this tab had produced a screen at all — usually a click on the
        // very first document, before the first settle finished. There is no `from` to
        // hang an edge on. Count it: an uncounted drop is a click the user made that the
        // map does not contain and does not admit to missing.
        drop('no-screen-yet');
      } else if (outstanding.length === 1) {
        const cause = outstanding[0];
        const fromState = cause.from;
        const { transition } = registry.upsertTransition(fromState, cause.action);
        // A recording only ever raises an edge's standing to `observed`; an edge the crawl
        // already proved keeps its proof, and one it marked blocked has now been shown to
        // work, which is worth more than the refusal that produced the block.
        const before = transition.status;
        if (transition.status !== 'verified') {
          transition.status = 'observed';
          transition.blockedReason = null;
        }
        transition.to = state.id;
        stats.edges += 1;
        progress(`${fromState.route} :: ${cause.action.key} → ${state.route}`
          + ` [${before} → ${transition.status}] (${transition.class})`);
        checkpoint();
      } else if (outstanding.length > 1) {
        // Several presses, one screen: any one of them could be the cause and none of
        // them can be shown to be. The screen is still real, so it is kept.
        for (const _ of outstanding) drop('several-actions-one-screen');
        progress(`${outstanding.length} actions and a single screen — no edge recorded`);
      } else if (isNew) {
        // Arrived with no press behind it: typed, scripted `goto`, back button, or a
        // report that was lost when its document went away. It is URL-addressable, which
        // is a real and useful fact — but it is not a click, and no click is invented.
        if (state.kind === 'page') {
          state.reachable = 'direct-url';
          if (!registry.entrypoints.includes(state.id)) registry.entrypoints.push(state.id);
        }
        progress(`${state.route} [reached without a recorded action]`);
        checkpoint();
      }

      recorder.lastState = state;
    } finally {
      recorder.busy = false;
    }
  }

  // New tabs join the recording; a tab that goes away stops it for that tab only.
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  cleanups.push(cdp.listen('Target.targetCreated', null, params => {
    const info = params.targetInfo;
    if (!info || info.type !== 'page') return;
    if (targetId && info.targetId !== targetId) return;
    attachTo(info.targetId).catch(() => {});
  }));
  cleanups.push(cdp.listen('Target.targetDestroyed', null, params => {
    recorders.delete(params.targetId);
  }));

  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const info of targetInfos.filter(entry => entry.type === 'page')) {
    if (targetId && info.targetId !== targetId) continue;
    await attachTo(info.targetId);
  }
  if (!recorders.size) throw new Error('no page target to record; open a tab in that browser first');

  const deadline = forMs ? Date.now() + forMs : null;
  while (!stopped) {
    if (shouldStop()) { stats.stoppedBy = 'signal'; break; }
    if (deadline && Date.now() > deadline) { stats.stoppedBy = 'duration'; break; }
    if (!recorders.size) { stats.stoppedBy = 'no-tabs'; break; }

    const due = [...recorders.values()].filter(recorder => recorder.dirty && !recorder.busy);
    for (const recorder of due) { recorder.dirty = false; await pump(recorder); }
    await sleep(due.length ? 60 : 200);
  }
  stopped = true;

  for (const recorder of recorders.values()) {
    for (const _ of recorder.pending) drop('still-outstanding-at-exit');
    try { if (recorder.page) await recorder.page.close(); } catch { /* the tab may be gone */ }
  }
  for (const cleanup of cleanups) cleanup();
  return stats;
}
