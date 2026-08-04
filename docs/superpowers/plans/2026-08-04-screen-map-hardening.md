# Screen Map Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `screen-map` preserve its documented snapshot, origin-safety, redirect-settling, and executable-route contracts for the five reproduced defects.

**Architecture:** Keep the zero-dependency Node/CDP design. Freshness compares the recorded commit's app-visible diff while excluding only generated map artifacts; the browser driver owns request identity and top-level navigation blocking; the model owns stable Playwright locator rendering; skill prose owns the explicit `actionPolicy.allow` escape-hatch contract.

**Tech Stack:** Node.js 22+ ESM, Chrome DevTools Protocol, Bash fixture runner, JSON/Markdown skill contracts.

## Global Constraints

- Preserve the `screen-map` name, schema version 1, zero-dependency runtime, and JSON CLI exit-code contract.
- Do not widen cross-origin navigation: `allowHosts` gates the configured crawl host; top-level navigation remains pinned to `baseUrl.origin`.
- Treat `actionPolicy.allow` as a pre-existing, user-authored reclassification escape hatch; the agent must never add an entry on the user's behalf.
- Exclude generated `map.json`, `map.md`, and `storage-state.json` from freshness, but keep `config.json` and application files freshness-sensitive.
- Work in the current clean checkout as authorized by the user; do not commit or push unless the user asks.

---

### Task 1: Snapshot freshness survives committing the map

**Files:**
- Modify: `skills/screen-map/tests/assert-queries.mjs`
- Modify: `skills/screen-map/scripts/screen-map.mjs`
- Modify: `skills/screen-map/references/map-schema.md`
- Modify: `docs/superpowers/specs/2026-08-04-screen-map-design.md`

**Interfaces:**
- Consumes: `map.app.commit`, the absolute map path, and the current Git repository state.
- Produces: `freshnessOf(map, mapPath) -> { status, detail, appCommit, mapCommit }` where generated-only commits are `fresh`, app/config changes are `stale`, and an unavailable recorded commit is `unknown`.

- [x] **Step 1: Write failing CLI assertions**

  Extend `assert-queries.mjs` so it commits `map.json` and `map.md`, expects `status=fresh`, commits a README change and expects `status=stale`, then substitutes an unavailable map commit and expects `status=unknown`.

- [x] **Step 2: Run the focused query test and confirm RED**

  Run the fixture setup plus `node skills/screen-map/tests/assert-queries.mjs --app <fixture-app>` through `bash skills/screen-map/tests/run.sh`; expected failure is “map artifact commit remains fresh”.

- [x] **Step 3: Implement generated-artifact-aware Git comparison**

  Replace commit equality with repository-root path comparison: resolve current commit and working changes, verify `map.app.commit` with `git cat-file -e`, and use `git diff --name-only <mapCommit> HEAD`. Filter only exact generated artifact paths; do not filter `config.json` or the entire `.screen-map` directory.

- [x] **Step 4: Run the focused assertions and confirm GREEN**

  Run the query assertion path again; all fresh/stale/unknown cases must pass.

### Task 2: Redirect request identity and fallback provenance

**Files:**
- Create: `skills/screen-map/tests/assert-browser.mjs`
- Modify: `skills/screen-map/tests/run.sh`
- Modify: `skills/screen-map/scripts/browser.mjs`
- Modify: `skills/screen-map/scripts/screen-map.mjs`

**Interfaces:**
- Produces: `Page.inflight` derived from a `Set<requestId>` and `Page.click(...) -> { ok, via }` on success.
- Consumes: the existing `Network.requestWillBeSent`, `Network.loadingFinished`, and `Network.loadingFailed` event payloads.

- [x] **Step 1: Write failing browser assertions**

  Start a disposable same-origin redirect server, assert `settle({timeout:1200})` completes before the timeout with `inflight===0`, then mutate a button label and assert `Page.click(oldKey, cssFallback).via === 'css'`.

- [x] **Step 2: Run `assert-browser.mjs` and confirm both failures**

  The redirect case must fail because a counter leaks; the fallback case must fail because `Page.click` currently drops `target.via`.

- [x] **Step 3: Implement request-ID tracking and propagate `via`**

  Store active request IDs in a Set, delete them on finish/failure, derive quietness from its size, and return `{ ok: true, via: target.via }` after the mouse click. Initialize every transition's `action.fallbackUsed` to `false` and set it to `true` only from that returned provenance.

- [x] **Step 4: Re-run `assert-browser.mjs` and confirm GREEN**

  Both assertions must pass without relying on the 1.2-second fallback timeout.

### Task 3: Block external top-level documents before loading

**Files:**
- Modify: `skills/screen-map/tests/fixture-server.mjs`
- Modify: `skills/screen-map/tests/fixture/index.html`
- Modify: `skills/screen-map/tests/assert-crawl.mjs`
- Modify: `skills/screen-map/scripts/browser.mjs`
- Modify: `skills/screen-map/scripts/screen-map.mjs`

**Interfaces:**
- Produces: `Page.open(cdp, { viewport, allowedOrigin })` with a CDP Fetch guard for the main frame's `Document` requests and `page.blockedNavigations` evidence.
- Consumes: `baseUrl.origin` from crawl/verify configuration.

- [x] **Step 1: Add a failing redirect-to-external fixture**

  Add a same-origin `/external-redirect` link whose HTTP response points at a second local server. Count every request received by that second origin and assert the count stays zero while the transition is recorded as blocked.

- [x] **Step 2: Run the default crawl assertion and confirm RED**

  Expected failure: the second origin receives `/landed` before the crawler records `left-origin`.

- [x] **Step 3: Implement a main-frame Document guard**

  Enable CDP Fetch only for `Document` requests, identify the main frame with `Page.getFrameTree`, continue permitted requests, fail top-level requests whose origin differs from `allowedOrigin`, and retain blocked-navigation evidence so the crawl marks the transition `blocked: external-origin` without registering a self-loop.

- [x] **Step 4: Re-run default and mutating crawl assertions and confirm GREEN**

  Both modes must record the blocked edge and the external server counter must remain zero.

### Task 4: Generate unambiguous route locators

**Files:**
- Modify: `skills/screen-map/tests/unit.mjs`
- Modify: `skills/screen-map/scripts/harvest.js`
- Modify: `skills/screen-map/scripts/model.mjs`
- Modify: `skills/screen-map/scripts/screen-map.mjs`
- Modify: `skills/screen-map/references/map-schema.md`

**Interfaces:**
- Produces: persisted `action.hrefRaw` and `playwrightExpr(action)` that prefers role/name, intersects duplicate links with their raw href, and uses CSS only for position-ambiguous actions.

- [x] **Step 1: Write failing pure-model assertions**

  Assert that same-name links with different `hrefRaw` values render different Playwright expressions, and an `ambiguous:true` action renders its CSS fallback rather than a non-unique role locator.

- [x] **Step 2: Run `node skills/screen-map/tests/unit.mjs` and confirm RED**

  Expected failures: both same-name links currently emit the same locator and ambiguous actions still use role/name.

- [x] **Step 3: Persist href identity and centralize locator rendering**

  Harvest raw href attributes, persist them in transition actions, qualify semantic link locators by href, fall back to CSS only for ambiguous actions, and make the `actions` command call the same `playwrightExpr` helper as `route`.

- [x] **Step 4: Re-run unit and query assertions and confirm GREEN**

  Locator strings must be distinct and every query edge must retain a non-empty executable expression.

### Task 5: Align the explicit allow escape hatch contract

**Files:**
- Modify: `skills/screen-map/SKILL.md`
- Modify: `skills/screen-map/references/action-policy.md`
- Modify: `skills/screen-map/evals/behavior-evals.json`
- Modify: `skills/screen-map/tests/unit.mjs`

**Interfaces:**
- Preserves: `classifyAction` precedence where an exact, pre-existing `actionPolicy.allow` entry reclassifies a false positive as safe.
- Produces: an agent-facing rule that forbids adding allow entries without the user's explicit decision.

- [x] **Step 1: Rename the existing unit assertion to state the intentional contract**

  Keep the expected class `safe`, but name the test “a user-authored allow entry reclassifies a lexicon false positive”.

- [x] **Step 2: Update skill and policy prose**

  Replace the contradictory absolute wording with: destructive-class actions never run; exact user-authored allow entries are evaluated first; the agent never creates such an entry itself.

- [x] **Step 3: Strengthen the behavior eval**

  Require the agent not to add an allow entry on its own and clarify that `--allow-mutating` never overrides a destructive classification.

- [x] **Step 4: Parse both eval JSON files**

  Run `node -e` with `JSON.parse` over `behavior-evals.json` and `trigger-evals.json`; expected result is exit 0.

### Task 6: Integrated verification

**Files:**
- Verify all files listed above.

**Interfaces:**
- Produces: fresh evidence for the complete `screen-map` contract and a scoped diff for review.

- [x] **Step 1: Run focused checks**

  Run `node skills/screen-map/tests/unit.mjs` and `node skills/screen-map/tests/assert-browser.mjs`.

- [x] **Step 2: Run the full browser regression suite**

  Run `bash skills/screen-map/tests/run.sh`; require exit 0 and zero failed groups.

- [x] **Step 3: Inspect repository integrity**

  Run `git diff --check`, inspect `git diff --stat`, inspect the full scoped diff, and confirm `git status --short` contains only intended files.
