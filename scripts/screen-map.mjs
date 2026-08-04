#!/usr/bin/env node
/**
 * screen-map — build and query an agent-readable map of a web app.
 *
 *   crawl      explore the app and write a snapshot map
 *   route      shortest executable path to a screen        (the agent's payload)
 *   state      screens matching a route
 *   actions    actions available on a screen, with class and status
 *   status     is the map still fresh for this commit?
 *   verify     replay a stored route in a browser and report what was reached
 *   report     regenerate the human-readable map.md
 *   invalidate downgrade a transition that no longer works
 *
 * Exit codes: 0 success · 1 no answer · 2 error · 3 refused by a safety gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { launchBrowser, Page, sleep } from './browser.mjs';
import {
  SCHEMA_VERSION, authTarget, classifyAction, fingerprintSignature, normalizePath,
  pathFromEntrypoints, playwrightExpr, renderMarkdown, replayPathKey, routeTemplate, routeToSteps,
  shortestSafePath, stateById, stateKey, stateKind, stateTitle, statesByRoute,
  transitionsFrom,
} from './model.mjs';

const EXIT_OK = 0, EXIT_NO_ANSWER = 1, EXIT_ERROR = 2, EXIT_REFUSED = 3;

// ---------- argv ----------

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const [flag, inline] = token.slice(2).split(/=(.*)/s);
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) { options[key] = inline; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { options[key] = true; continue; }
    options[key] = next;
    index += 1;
  }
  return options;
}

function out(payload) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); }

/**
 * Git Bash rewrites a lone `/settings` argument into `C:/Program Files/Git/settings`
 * before Node ever sees it. Nothing here can undo that, but silently reporting
 * "unknown route" sends the reader hunting in the wrong place.
 */
function pathConversionHint(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || ''))
    ? 'This value arrived as a Windows path, which means the shell rewrote it. Pass the route without a leading slash (--to announcements) or set MSYS_NO_PATHCONV=1.'
    : null;
}
function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: message, ...extra }, null, 2) + '\n');
  process.exit(code);
}

// ---------- config ----------

const DEFAULT_BUDGET = { maxStates: 60, maxActions: 300, maxMillis: 600000, listSamples: 3 };

function interpolate(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
    const found = process.env[name];
    if (found === undefined) throw new Error(`config references ${match} but that environment variable is not set`);
    return found;
  });
}

function interpolateDeep(value) {
  if (Array.isArray(value)) return value.map(interpolateDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateDeep(item)]));
  }
  return interpolate(value);
}

function loadConfig(configPath) {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  if (!existsSync(absolute)) throw new Error(`config not found: ${absolute}`);
  const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  const config = interpolateDeep(parsed);
  if (!config.baseUrl) throw new Error('config.baseUrl is required');
  config.allowHosts = config.allowHosts || ['localhost', '127.0.0.1'];
  config.entrypoints = (config.entrypoints || ['/']).map(normalizePath);
  config.budget = { ...DEFAULT_BUDGET, ...(config.budget || {}) };
  config.actionPolicy = config.actionPolicy || {};
  config.viewport = config.viewport || { width: 1280, height: 900 };
  config.storageSeed = config.storageSeed || null;
  config.__dir = dirname(absolute);
  config.__path = absolute;
  return config;
}

/**
 * The gate runs before a browser exists. Crawling writes to whatever it points at,
 * so an unlisted host is refused rather than confirmed.
 */
function assertHostAllowed(baseUrl, allowHosts) {
  let url;
  try { url = new URL(baseUrl); }
  catch { fail(EXIT_REFUSED, `baseUrl is not a valid URL: ${baseUrl}`); }
  if (!allowHosts.includes(url.hostname)) {
    fail(EXIT_REFUSED,
      `refusing to crawl ${url.hostname}: not in allowHosts (${allowHosts.join(', ')})`,
      { hint: 'screen-map crawls with a real browser and can change data. Add the host to config.allowHosts only for a disposable environment.' });
  }
  return url;
}

const gitLines = output => String(output || '').split('\n').map(line => line.trim()).filter(Boolean);
const gitPath = (root, path) => relative(root, path).split('\\').join('/');

function runGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * `dirty` means *the app* changed, not that generated map artifacts changed.
 * Config remains part of the app snapshot; only files written by this tool are
 * excluded from freshness.
 */
function gitInfo(mapPath) {
  try {
    const start = dirname(mapPath);
    const root = runGit(start, ['rev-parse', '--show-toplevel']);
    const commit = runGit(root, ['rev-parse', '--short', 'HEAD']);
    const generated = new Set([
      mapPath,
      join(dirname(mapPath), 'map.md'),
      join(dirname(mapPath), 'storage-state.json'),
    ].map(path => gitPath(root, path)));
    const changed = [
      ...gitLines(runGit(root, ['diff', '--name-only'])),
      ...gitLines(runGit(root, ['diff', '--cached', '--name-only'])),
      ...gitLines(runGit(root, ['ls-files', '--others', '--exclude-standard'])),
    ].filter(path => !generated.has(path));
    return { root, commit, dirty: changed.length > 0, changed, generated };
  } catch {
    return { root: null, commit: null, dirty: false, changed: [], generated: new Set() };
  }
}

function gitCommitExists(root, commit) {
  try { runGit(root, ['cat-file', '-e', `${commit}^{commit}`]); return true; }
  catch { return false; }
}

function committedAppChanges(info, fromCommit, toCommit) {
  return gitLines(runGit(info.root, ['diff', '--name-only', fromCommit, toCommit]))
    .filter(path => !info.generated.has(path));
}

// ---------- map file ----------

function mapPathFrom(options) {
  if (options.map) return isAbsolute(options.map) ? options.map : resolve(process.cwd(), options.map);
  const dir = options.dir ? resolve(process.cwd(), options.dir) : resolve(process.cwd(), '.screen-map');
  return join(dir, 'map.json');
}

function loadMap(options) {
  const path = mapPathFrom(options);
  if (!existsSync(path)) {
    fail(EXIT_NO_ANSWER, `no map at ${path}`, { hint: 'run: screen-map crawl --config .screen-map/config.json' });
  }
  const map = JSON.parse(readFileSync(path, 'utf8'));
  if (map.schema !== SCHEMA_VERSION) {
    fail(EXIT_ERROR, `map schema ${map.schema} is not supported by this build (expected ${SCHEMA_VERSION})`);
  }
  return { map, path };
}

function freshnessOf(map, mapPath) {
  const info = gitInfo(mapPath);
  if (!info.commit || !map.app?.commit) {
    return { status: 'unknown', detail: 'no git commit recorded for the app', appCommit: info.commit, mapCommit: map.app?.commit || null };
  }
  if (!gitCommitExists(info.root, map.app.commit)) {
    return {
      status: 'unknown', detail: `recorded app commit ${map.app.commit} is not available locally`,
      appCommit: info.commit, mapCommit: map.app.commit,
    };
  }
  const committed = info.commit === map.app.commit
    ? []
    : committedAppChanges(info, map.app.commit, info.commit);
  if (!info.dirty && !committed.length) {
    return {
      status: 'fresh',
      detail: info.commit === map.app.commit
        ? 'app commit matches the crawl'
        : 'only generated map artifacts changed since the crawl',
      appCommit: info.commit, mapCommit: map.app.commit,
    };
  }
  return {
    status: 'stale',
    detail: info.dirty
      ? 'working tree has app or config changes since the crawl'
      : `app moved from ${map.app.commit} to ${info.commit}`,
    appCommit: info.commit, mapCommit: map.app.commit,
  };
}

// ---------- crawl ----------

async function commandCrawl(options) {
  if (!options.config) fail(EXIT_ERROR, 'crawl requires --config <path>');
  let config;
  try { config = loadConfig(options.config); }
  catch (error) { fail(EXIT_ERROR, error.message); }

  const baseUrl = assertHostAllowed(config.baseUrl, config.allowHosts);
  const baseOrigin = baseUrl.origin;
  const allowMutating = options.allowMutating === true || options.allowMutating === 'true';
  const replayVerify = !(options.replayVerify === false || options.noReplayVerify === true || options.noReplayVerify === 'true');
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + config.budget.maxMillis;

  const states = [];
  const byKey = new Map();
  const transitions = [];
  const transitionByKey = new Map();
  const entrypoints = [];
  const queue = [];
  let executed = 0;
  let budgetHit = null;

  const live = () => ({ states, transitions, entrypoints });
  const byId = id => states.find(state => state.id === id) || null;

  function registerState(observation) {
    const route = routeTemplate(observation.pathname, config);
    const signature = fingerprintSignature(observation.fingerprint);
    const key = stateKey(route, signature);
    const existing = byKey.get(key);
    if (existing) return { state: existing, isNew: false };
    const state = {
      id: 's' + states.length,
      route, signature,
      kind: stateKind(observation.fingerprint),
      title: stateTitle({ ...observation, route }),
      // On a templated route the heading belongs to one record, not to the screen.
      titleIsSample: route.includes(':'),
      evidence: {
        urlSample: observation.pathname + (observation.search || ''),
        headings: observation.fingerprint.headings || [],
        landmarks: observation.fingerprint.landmarks || [],
        forms: observation.fingerprint.forms || [],
        fields: observation.fingerprint.fields || [],
        overlay: observation.fingerprint.overlay || null,
      },
    };
    states.push(state);
    byKey.set(key, state);
    return { state, isNew: true };
  }

  /** Same-destination links on one screen: `/announcements` has one per record. */
  const destinationBucket = action =>
    action.kind === 'link' && action.hrefPath && !action.external
      ? routeTemplate(action.hrefPath, config)
      : null;

  function registerActions(state, observation) {
    const actions = observation.actions || [];

    // Twenty links to the same templated screen teach the map nothing the first
    // three did not, and on a real list they exhaust the clock instead. Sample
    // them — and record the cap on every skipped edge, so it is never silent.
    const perDestination = new Map();
    for (const action of actions) {
      const bucket = destinationBucket(action);
      if (bucket) perDestination.set(bucket, (perDestination.get(bucket) || 0) + 1);
    }
    const takenPerDestination = new Map();
    const cap = Math.max(1, Number(config.budget.listSamples) || 1);

    for (const action of actions) {
      const identity = JSON.stringify([state.id, action.key]);
      if (transitionByKey.has(identity)) continue;

      const verdict = classifyAction(action, config.actionPolicy);
      const transition = {
        id: 't' + transitions.length,
        from: state.id,
        to: null,
        action: {
          kind: action.kind, role: action.role, name: action.name,
          href: action.href || null, hrefRaw: action.hrefRaw || null, external: !!action.external,
          cssFallback: action.cssFallback, key: action.key,
          ambiguous: !!action.ambiguous,
          fallbackUsed: false,
        },
        class: verdict.class,
        classifiedBy: verdict.classifiedBy,
        status: 'unexplored',
        blockedReason: null,
        lastVerifiedAt: null,
      };
      transitions.push(transition);
      transitionByKey.set(identity, transition);

      if (action.external) {
        transition.status = 'blocked';
        transition.blockedReason = 'external-origin';
        continue;
      }
      if (verdict.class === 'destructive') {
        transition.blockedReason = 'destructive: ' + verdict.reason;
        continue;
      }
      if (verdict.class === 'mutating' && !allowMutating) {
        transition.blockedReason = 'mutating: needs --allow-mutating';
        continue;
      }

      const bucket = destinationBucket(action);
      if (bucket) {
        const total = perDestination.get(bucket) || 1;
        const taken = takenPerDestination.get(bucket) || 0;
        if (total > cap && taken >= cap) {
          transition.status = 'sampled';
          transition.blockedReason = `list sample: ${cap} of ${total} links to ${bucket} on this screen are walked`;
          continue;
        }
        takenPerDestination.set(bucket, taken + 1);
      }

      queue.push({ stateId: state.id, actionKey: action.key, transitionId: transition.id });
    }
  }

  const keyOf = observation =>
    stateKey(routeTemplate(observation.pathname, config), fingerprintSignature(observation.fingerprint));

  /**
   * Where the clock went. Running out of `maxMillis` is the ordinary way this skill
   * fails, and without a record the only available answer to "why" is a guess — which is
   * how the wrong thing gets optimised while the real cost sits untouched. Every number
   * below is wall time actually spent, attributed to the phase that spent it.
   */
  const clock = { ms: new Map(), n: new Map(), byState: new Map() };
  function spend(label, ms) {
    clock.ms.set(label, (clock.ms.get(label) || 0) + ms);
    clock.n.set(label, (clock.n.get(label) || 0) + 1);
  }
  async function timed(label, fn) {
    const started = Date.now();
    try { return await fn(); } finally { spend(label, Date.now() - started); }
  }
  function chargeState(stateId, ms) {
    const row = clock.byState.get(stateId) || { ms: 0, actions: 0 };
    row.ms += ms;
    row.actions += 1;
    clock.byState.set(stateId, row);
  }

  async function walk(page, path) {
    let observation = null;
    for (const transition of path) {
      const blockedBefore = page.blockedNavigations.length;
      const clicked = await page.click(transition.action.key, transition.action.cssFallback);
      if (!clicked.ok) {
        // Where the walk actually stood matters more than which step failed: the
        // usual cause is landing somewhere other than the step's `from` screen.
        const at = await page.observe().catch(() => null);
        const expected = byId(transition.from);
        const actual = at ? keyOf(at) : null;
        const drifted = at && expected && actual !== stateKey(expected.route, expected.signature);
        return {
          ok: false,
          reason: `replay failed at ${transition.id} (${transition.action.name || transition.action.kind}): ${clicked.reason}`
            + (at ? `; stood on ${at.pathname}${at.scope === 'overlay' ? ' with an overlay open' : ''}` : '')
            + (drifted ? `, expected ${expected.route}` : ''),
        };
      }
      if (clicked.via === 'css') transition.action.fallbackUsed = true;
      observation = await page.settle();
      const blocked = page.blockedNavigations[blockedBefore];
      if (blocked) {
        return { ok: false, reason: `replay blocked navigation to ${blocked.url}: ${blocked.reason}` };
      }
    }
    return { ok: true, observation };
  }

  /** state id -> the replay path that failed, and why. See `reachState`. */
  const replayFailures = new Map();

  /** Walk to `state` the way the map claims it can be walked, then prove we arrived. */
  async function reachState(page, state) {
    const wanted = stateKey(state.route, state.signature);
    const current = await timed('reach.observe', () => page.observe().catch(() => null));
    if (current && keyOf(current) === wanted) {
      spend('reach.already-here', 0);
      return { ok: true, observation: current };
    }

    if (replayVerify) {
      // Walking from wherever we are is still a verified click path, and it avoids
      // re-walking the whole prefix for every action of every screen — the
      // difference between a crawl that finishes and one that runs out of clock.
      if (current) {
        const here = states.find(entry => stateKey(entry.route, entry.signature) === keyOf(current));
        const local = here && shortestSafePath(live(), here.id, state.id);
        if (local && local.length) {
          const walked = await timed('reach.local-walk', () => walk(page, local));
          if (walked.ok && keyOf(walked.observation) === wanted) {
            return { ok: true, observation: walked.observation };
          }
          spend('reach.local-walk-wasted', 0);
        }
      }

      const resolved = pathFromEntrypoints(live(), state.id);
      if (resolved) {
        // A screen the crawl cannot re-enter fails the same way for every action it
        // owns, and each attempt costs a full navigate + settle. On a stateful app —
        // an editor whose own saves change what the entrypoint renders — that is where
        // the entire clock goes: one dead screen with two hundred buttons spends the
        // budget proving the same verdict two hundred times. Remember the verdict per
        // resolved path, so a path the map has since grown a better route to is still
        // retried, and an unchanged one is answered without touching the browser.
        const pathKey = replayPathKey(resolved);
        const remembered = replayFailures.get(state.id);
        if (remembered && remembered.pathKey === pathKey) {
          spend('reach.replay-skipped', 0);
          return { ok: false, reason: remembered.reason, viaCache: true };
        }

        const origin = byId(resolved.origin);
        const landed = await timed('reach.replay-load', async () => {
          await page.navigate(baseOrigin + (origin?.evidence.urlSample || '/'));
          // `navigate` returns at load; a client-rendered app has not drawn its
          // navigation yet. Clicking here finds nothing and reads as a broken map.
          return page.settle();
        });
        const rememberFailure = reason => {
          replayFailures.set(state.id, { pathKey, reason });
          return { ok: false, reason };
        };
        if (!resolved.path.length) {
          return keyOf(landed) === wanted
            ? { ok: true, observation: landed }
            : rememberFailure('entrypoint did not reproduce the mapped screen');
        }
        const walked = await timed('reach.replay-walk', () => walk(page, resolved.path));
        // A click that would not resolve can be a control that simply had not drawn
        // yet; that is not a structural verdict, so it is not remembered.
        if (!walked.ok) return walked;
        if (keyOf(walked.observation) === wanted) return { ok: true, observation: walked.observation };
        return rememberFailure('replay landed on a different screen');
      }
    }

    // No safe click path (only possible with --allow-mutating). A page-kind state may
    // still be URL-addressable; anything else is honestly unreachable.
    if (state.kind === 'page') {
      const observation = await timed('reach.direct-url', async () => {
        await page.navigate(baseOrigin + state.evidence.urlSample);
        return page.settle();
      });
      const arrived = stateKey(routeTemplate(observation.pathname, config), fingerprintSignature(observation.fingerprint));
      if (arrived === stateKey(state.route, state.signature)) {
        state.reachable = 'direct-url';
        return { ok: true, observation };
      }
    }
    return { ok: false, reason: 'no safe path and not URL-addressable' };
  }

  const browser = await launchBrowser({ headless: options.headed !== true, noSandbox: options.noSandbox === true });
  let page;
  /** The action in hand when a fatal error lands — an error nobody can locate costs more than the bug. */
  let lastAttempt = null;
  try {
    page = await Page.open(browser.cdp, {
      viewport: config.viewport, storageSeed: config.storageSeed, allowedOrigin: baseOrigin,
    });

    if (config.auth) {
      await timed('setup.auth', () => runAuth(page, config, baseOrigin));
      const state = await page.storageState();
      writeFileSync(join(config.__dir, 'storage-state.json'), JSON.stringify(state, null, 2));
    }

    for (const entry of config.entrypoints) {
      const observation = await timed('setup.entrypoint', async () => {
        await page.navigate(baseOrigin + entry);
        return page.settle();
      });
      const { state, isNew } = registerState(observation);
      if (!entrypoints.includes(state.id)) entrypoints.push(state.id);
      if (isNew) registerActions(state, observation);
    }

    while (queue.length) {
      if (Date.now() > deadline) { budgetHit = 'maxMillis'; break; }
      if (executed >= config.budget.maxActions) { budgetHit = 'maxActions'; break; }
      if (states.length >= config.budget.maxStates) { budgetHit = 'maxStates'; break; }

      const item = queue.shift();
      const state = byId(item.stateId);
      const transition = transitions.find(entry => entry.id === item.transitionId);
      if (!state || !transition) continue;

      lastAttempt = { screen: state.route, title: state.title, action: item.actionKey, transition: transition.id };
      const actionStartedAt = Date.now();
      const reached = await reachState(page, state);
      if (!reached.ok) {
        transition.status = 'blocked';
        transition.blockedReason = reached.reason;
        transition.ms = Date.now() - actionStartedAt;
        chargeState(state.id, transition.ms);
        continue;
      }

      const blockedBefore = page.blockedNavigations.length;
      const clicked = await timed('act.click', () => page.click(item.actionKey, transition.action.cssFallback));
      if (clicked.via === 'css') transition.action.fallbackUsed = true;
      if (!clicked.ok) {
        transition.status = 'failed';
        transition.blockedReason = 'could not resolve the element: ' + clicked.reason;
        chargeState(state.id, Date.now() - actionStartedAt);
        continue;
      }
      executed += 1;

      const after = await timed('act.settle', () => page.settle());
      transition.ms = Date.now() - actionStartedAt;
      chargeState(state.id, transition.ms);
      const blockedNavigation = page.blockedNavigations[blockedBefore];
      if (blockedNavigation) {
        transition.status = 'blocked';
        transition.blockedReason = blockedNavigation.reason;
        await page.navigate(baseOrigin + (state.evidence.urlSample || '/'));
        await page.settle();
        continue;
      }
      let afterOrigin = null;
      try { afterOrigin = new URL(after.url).origin; } catch { afterOrigin = null; }
      if (afterOrigin && afterOrigin !== baseOrigin) {
        transition.status = 'blocked';
        transition.blockedReason = 'left-origin';
        await page.navigate(baseOrigin + (byId(entrypoints[0])?.evidence.urlSample || '/'));
        continue;
      }

      const { state: target, isNew } = registerState(after);
      transition.to = target.id;
      transition.status = 'verified';
      transition.lastVerifiedAt = new Date().toISOString();
      if (isNew) registerActions(target, after);
    }
  } catch (error) {
    // Where it died is most of the diagnosis. `harvest script never became ready` is
    // true of a crashed tab, a download, a PDF and a page that simply loaded slowly,
    // and the message alone cannot tell them apart.
    let at = null;
    try { at = page ? await page.evaluateJson('({url:location.href,title:document.title,ready:!!(window.__screenMap&&window.__screenMap.ready)})') : null; }
    catch (probeFailure) { at = { unreachable: probeFailure.message }; }
    try { if (page) await page.close(); } catch { /* closing anyway */ }
    await browser.close();
    fail(EXIT_ERROR, error.message, {
      lastAttempt,
      at,
      progress: { states: states.length, executed, queued: queue.length },
    });
  }

  const frontier = queue.map(item => {
    const state = byId(item.stateId);
    return `${state ? state.route : item.stateId} :: ${item.actionKey}`;
  });

  const finishedAt = new Date().toISOString();
  const timing = {
    totalMs: Date.parse(finishedAt) - Date.parse(startedAt),
    phases: [...clock.ms.entries()]
      .map(([label, ms]) => ({ label, ms, count: clock.n.get(label) || 0 }))
      .sort((a, b) => b.ms - a.ms || b.count - a.count),
    // Which screen the clock was spent on, not which screen it produced: a screen whose
    // every action costs a walk from an entrypoint is the thing to narrow or drop.
    byScreen: [...clock.byState.entries()]
      .map(([id, row]) => {
        const state = byId(id);
        return { route: state?.route || id, title: state?.title || '', ...row };
      })
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8),
    // An average hides a bimodal cost. Two actions that each open a 3D editor and
    // thirty that toggle a panel average out to a number describing neither, and the
    // fix for one is not the fix for the other.
    slowest: transitions
      .filter(transition => transition.ms > 0)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map(transition => ({
        from: byId(transition.from)?.route || transition.from,
        action: transition.action?.name || transition.action?.kind || '?',
        status: transition.status,
        ms: transition.ms,
      })),
  };

  const mapFile = join(config.__dir, 'map.json');
  const info = gitInfo(mapFile);
  const map = {
    schema: SCHEMA_VERSION,
    app: { baseUrl: config.baseUrl, commit: info.commit, dirty: info.dirty },
    run: {
      id: 'run-' + startedAt.replace(/[-:.]/g, '').slice(0, 15),
      startedAt, finishedAt,
      replayVerify, allowMutating, budgetHit, timing,
      dialogs: page ? page.dialogs : [],
    },
    states, transitions, entrypoints,
    coverage: {
      states: states.length,
      actionsSeen: transitions.length,
      executed,
      blocked: transitions.filter(transition => transition.status !== 'verified').length,
      sampled: transitions.filter(transition => transition.status === 'sampled').length,
      frontier,
    },
  };

  try { if (page) await page.close(); } catch { /* closing anyway */ }
  await browser.close();

  mkdirSync(config.__dir, { recursive: true });
  writeFileSync(mapFile, JSON.stringify(map, null, 2));
  writeFileSync(join(config.__dir, 'map.md'), renderMarkdown(map, freshnessOf(map, mapFile)));

  out({
    ok: true, map: mapFile, report: join(config.__dir, 'map.md'),
    coverage: map.coverage, budgetHit, timing,
    notExecuted: transitions.filter(transition => transition.status !== 'verified')
      .map(transition => ({ from: byId(transition.from)?.route, action: transition.action.name, class: transition.class, reason: transition.blockedReason })),
  });
}

async function runAuth(page, config, baseOrigin) {
  for (const step of config.auth.steps || []) {
    switch (step.kind) {
      case 'goto':
        await page.navigate(baseOrigin + authTarget(step.path || '/'));
        await page.settle();
        break;
      case 'fill':
        await page.fill(step.selector, String(step.value ?? ''));
        break;
      case 'click': {
        if (step.selector) {
          const clicked = await page.evaluateJson(
            `(()=>{const el=document.querySelector(${JSON.stringify(step.selector)});if(!el)return{ok:false};el.click();return{ok:true};})()`);
          if (!clicked?.ok) throw new Error(`auth step: no element matched ${step.selector}`);
        } else {
          const key = `${step.actionKind || 'click'}:${step.role || 'button'}:${step.name || ''}`;
          const clicked = await page.click(key);
          if (!clicked.ok) throw new Error(`auth step: could not click ${key} (${clicked.reason})`);
        }
        await page.settle();
        break;
      }
      case 'wait':
        await sleep(Number(step.ms) || 500);
        break;
      case 'waitForPath': {
        const wanted = normalizePath(step.path);
        const deadline = Date.now() + (Number(step.timeoutMs) || 10000);
        let ok = false;
        while (Date.now() < deadline) {
          const observation = await page.observe().catch(() => null);
          if (observation && normalizePath(observation.pathname) === wanted) { ok = true; break; }
          await sleep(150);
        }
        if (!ok) throw new Error(`auth step: never reached ${wanted}`);
        break;
      }
      default:
        throw new Error(`unsupported auth step: ${JSON.stringify(step.kind)}`);
    }
  }
}

// ---------- queries ----------

function commandRoute(options) {
  if (!options.to) fail(EXIT_ERROR, 'route requires --to <route>');
  const { map, path } = loadMap(options);
  const targets = statesByRoute(map, options.to);
  if (!targets.length) {
    fail(EXIT_NO_ANSWER, `no screen with route ${normalizePath(options.to)}`, {
      known: [...new Set(map.states.map(state => state.route))].sort(),
      hint: pathConversionHint(options.to) || undefined,
    });
  }

  let origins = map.entrypoints;
  if (options.from) {
    const fromStates = statesByRoute(map, options.from);
    if (!fromStates.length) fail(EXIT_NO_ANSWER, `no screen with route ${normalizePath(options.from)}`);
    origins = fromStates.map(state => state.id);
  }

  let best = null;
  for (const target of targets) {
    for (const origin of origins) {
      const resolved = pathFromEntrypoints(map, target.id, origin);
      if (resolved && (!best || resolved.path.length < best.resolved.path.length)) best = { target, resolved };
    }
  }
  if (!best) {
    fail(EXIT_NO_ANSWER, `no safe path to ${normalizePath(options.to)}`,
      { hint: 'the screen exists in the map but no verified safe transition chain reaches it' });
  }

  const freshness = freshnessOf(map, path);
  const steps = routeToSteps(map, best.resolved, map.app.baseUrl);
  out({
    ok: true,
    to: best.target.route, title: best.target.title, kind: best.target.kind,
    confidence: freshness.status, freshness,
    steps,
    playwright: steps.map(step => step.playwright).join('\n'),
    notes: freshness.status === 'stale'
      ? ['The app has changed since this map was crawled. If any step fails, discard this route and re-crawl or explore directly.']
      : [],
  });
}

function commandState(options) {
  if (!options.route) fail(EXIT_ERROR, 'state requires --route <route>');
  const { map } = loadMap(options);
  const found = statesByRoute(map, options.route);
  if (!found.length) {
    fail(EXIT_NO_ANSWER, `no screen with route ${normalizePath(options.route)}`, {
      known: [...new Set(map.states.map(state => state.route))].sort(),
      hint: pathConversionHint(options.route) || undefined,
    });
  }
  out({
    ok: true,
    states: found.map(state => ({
      ...state,
      entrypoint: map.entrypoints.includes(state.id),
      outgoing: transitionsFrom(map, state.id).length,
    })),
  });
}

function commandActions(options) {
  if (!options.route) fail(EXIT_ERROR, 'actions requires --route <route>');
  const { map } = loadMap(options);
  const found = statesByRoute(map, options.route);
  if (!found.length) {
    fail(EXIT_NO_ANSWER, `no screen with route ${normalizePath(options.route)}`,
      { hint: pathConversionHint(options.route) || undefined });
  }
  out({
    ok: true,
    screens: found.map(state => ({
      id: state.id, route: state.route, title: state.title, kind: state.kind,
      actions: transitionsFrom(map, state.id).map(transition => ({
        transition: transition.id,
        kind: transition.action.kind,
        role: transition.action.role,
        name: transition.action.name,
        class: transition.class,
        classifiedBy: transition.classifiedBy,
        status: transition.status,
        blockedReason: transition.blockedReason,
        to: transition.to ? stateById(map, transition.to)?.route : null,
        playwright: playwrightExpr(transition.action),
      })),
    })),
  });
}

function commandStatus(options) {
  const { map, path } = loadMap(options);
  const freshness = freshnessOf(map, path);
  const notVerified = map.transitions.filter(transition => transition.status !== 'verified');
  out({
    ok: true,
    status: freshness.status,
    detail: freshness.detail,
    mapCommit: freshness.mapCommit,
    appCommit: freshness.appCommit,
    crawledAt: map.run?.finishedAt || null,
    states: map.states.length,
    transitions: map.transitions.length,
    notExecuted: notVerified.length,
    budgetHit: map.run?.budgetHit || null,
    map: path,
  });
}

function commandReport(options) {
  const { map, path } = loadMap(options);
  const target = options.out ? resolve(process.cwd(), options.out) : join(dirname(path), 'map.md');
  writeFileSync(target, renderMarkdown(map, freshnessOf(map, path)));
  out({ ok: true, report: target });
}

function commandInvalidate(options) {
  if (!options.transition) fail(EXIT_ERROR, 'invalidate requires --transition <id>');
  const { map, path } = loadMap(options);
  const transition = map.transitions.find(entry => entry.id === options.transition);
  if (!transition) fail(EXIT_NO_ANSWER, `no transition ${options.transition}`);

  const before = { states: map.states.length, transitions: map.transitions.length };
  transition.status = 'failed';
  transition.blockedReason = options.reason ? String(options.reason) : 'invalidated during use';
  transition.invalidatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(map, null, 2));

  // Only `crawl` may add to the map; live use downgrades and nothing else.
  out({ ok: true, transition: transition.id, status: transition.status, unchanged: before });
}

// ---------- verify ----------

async function commandVerify(options) {
  if (!options.to) fail(EXIT_ERROR, 'verify requires --to <route>');
  const { map, path } = loadMap(options);
  const targets = statesByRoute(map, options.to);
  if (!targets.length) {
    fail(EXIT_NO_ANSWER, `no screen with route ${normalizePath(options.to)}`,
      { hint: pathConversionHint(options.to) || undefined });
  }

  const configPath = options.config ? options.config : join(dirname(path), 'config.json');
  let config;
  try { config = loadConfig(configPath); }
  catch (error) { fail(EXIT_ERROR, error.message); }
  const baseUrl = assertHostAllowed(config.baseUrl, config.allowHosts);

  let best = null;
  for (const target of targets) {
    const resolved = pathFromEntrypoints(map, target.id);
    if (resolved && (!best || resolved.path.length < best.resolved.path.length)) best = { target, resolved };
  }
  if (!best) fail(EXIT_NO_ANSWER, `no safe path to ${normalizePath(options.to)}`);

  const browser = await launchBrowser({ headless: options.headed !== true, noSandbox: options.noSandbox === true });
  let page;
  try {
    page = await Page.open(browser.cdp, {
      viewport: config.viewport, storageSeed: config.storageSeed, allowedOrigin: baseUrl.origin,
    });
    const storagePath = join(dirname(path), 'storage-state.json');
    const origin = stateById(map, best.resolved.origin);
    await page.navigate(baseUrl.origin + (origin?.evidence.urlSample || '/'));
    if (existsSync(storagePath)) {
      await page.applyStorageState(JSON.parse(readFileSync(storagePath, 'utf8')));
      await page.navigate(baseUrl.origin + (origin?.evidence.urlSample || '/'));
    }

    let observation = await page.settle();
    const walked = [];
    for (const transition of best.resolved.path) {
      const blockedBefore = page.blockedNavigations.length;
      const clicked = await page.click(transition.action.key, transition.action.cssFallback);
      if (!clicked.ok) {
        out({ ok: false, reached: false, failedAt: transition.id, reason: clicked.reason, walked });
        await page.close(); await browser.close();
        process.exit(EXIT_NO_ANSWER);
      }
      observation = await page.settle();
      const blocked = page.blockedNavigations[blockedBefore];
      if (blocked) {
        out({ ok: false, reached: false, failedAt: transition.id, reason: blocked.reason, walked });
        await page.close(); await browser.close();
        process.exit(EXIT_NO_ANSWER);
      }
      walked.push({ transition: transition.id, action: transition.action.name, at: observation.pathname });
    }

    const arrived = stateKey(routeTemplate(observation.pathname, config), fingerprintSignature(observation.fingerprint));
    const expected = stateKey(best.target.route, best.target.signature);
    const reached = arrived === expected;
    out({
      ok: reached, reached, to: best.target.route,
      landedOn: observation.pathname, steps: walked.length, walked,
      detail: reached ? 'the stored route still works' : 'the route no longer lands on the mapped screen',
    });
    await page.close();
    await browser.close();
    process.exit(reached ? EXIT_OK : EXIT_NO_ANSWER);
  } catch (error) {
    try { if (page) await page.close(); } catch { /* closing anyway */ }
    await browser.close();
    fail(EXIT_ERROR, error.message);
  }
}

// ---------- entry ----------

const options = parseArgs(process.argv.slice(2));
const command = options._[0];

try {
  switch (command) {
    case 'crawl': await commandCrawl(options); break;
    case 'route': commandRoute(options); break;
    case 'state': commandState(options); break;
    case 'actions': commandActions(options); break;
    case 'status': commandStatus(options); break;
    case 'report': commandReport(options); break;
    case 'invalidate': commandInvalidate(options); break;
    case 'verify': await commandVerify(options); break;
    default:
      fail(EXIT_ERROR, `unknown command: ${command || '(none)'}`,
        { commands: ['crawl', 'route', 'state', 'actions', 'status', 'verify', 'report', 'invalidate'] });
  }
} catch (error) {
  fail(EXIT_ERROR, error && error.message ? error.message : String(error));
}
