---
name: screen-map
description: Use when an agent needs to operate a local web app — reach a screen, run a flow, or write a browser test — and does not already know the click path; when asked to map, re-map, or check the freshness of an app's screens and transitions; or when a browser session driven by Playwright, CDP, dom-picker, or a person should be recorded into a reusable map so the next run does not rediscover it. Answers "how do I get to X" with an executable action sequence that was actually walked or actually watched. Does not cover fixing one pointed-at element, visual QA of a rendered screen, scraping third-party sites, non-browser work, or producing a sitemap.xml or information-architecture sitemap — this records executable actions between screens, not a URL hierarchy.
license: MIT
compatibility: Requires Node.js 22 or newer and an installed Chrome/Chromium. Crawling requires a disposable local environment; querying an existing map requires neither.
---

# Screen Map

A map of a web app that an agent reads: which screens exist, and the concrete action
that moves between any two. Built by one crawl, queried thereafter.

This is not a sitemap. A sitemap lists URLs; this records what you click to get from
one screen to the next, including screens that have no URL of their own.

Use the user's language in reports.

## Non-negotiable rules

- **Read before crawling.** If `.screen-map/map.json` exists, answer from `route`, `state`, and
  `actions`. Crawling is expensive and changes data; do not re-crawl to answer a question the map
  already answers.
- **Never crawl a host outside `allowHosts`.** The default is `localhost` and `127.0.0.1`. Widening
  it is the user's decision for a disposable environment, never yours. Staging and production are
  not disposable.
- **Action classification fails closed.** Anything unrecognized needs `--allow-mutating`, and an
  action that remains classified `destructive` never runs under any flag. A pre-existing exact
  `actionPolicy.allow` entry is the user's explicit escape hatch for a false positive; never add one
  on the user's behalf. See `references/action-policy.md`.
- **Never present a stale route as fact.** When `status` says stale, say so, and tell the user the
  route is discarded the moment a step fails.
- **Only `crawl` and `record` add to a map.** Never hand-edit one and never concatenate two.
  Every state and transition carries the commit it was seen at, which is what lets one map hold
  both a crawl and later recordings honestly. During use, `invalidate` may downgrade a broken
  transition and nothing more.
- **Observation is not verification.** A `record` run watched something happen once; it did not
  prove it repeats. Never report an `observed` edge as `verified`, and when you hand back a route
  built from one, say that it was watched and never replayed.
- **Report what was not covered.** A budget hit, a blocked edge, a sampled list, or a leftover
  frontier is part of the answer, not a footnote to omit.

## Answering "how do I get to X"

**Run from the app repository, calling the script by absolute path.** The script lives in this
skill directory but resolves `.screen-map/` against the working directory, and freshness is judged
by the git commit of the directory holding the map — so a command run from the skill directory
looks for a map that is not there and exits `1 no map at …`.

```bash
cd /path/to/the/app                       # the repo the map describes
node /path/to/skills/screen-map/scripts/screen-map.mjs status
node /path/to/skills/screen-map/scripts/screen-map.mjs route --to '/announcements/:id'
```

If changing directory is not an option, point every command at the map instead: `--dir <path>`
names the `.screen-map` directory, `--map <path>` names `map.json` outright. Both accept relative
paths, resolved against the working directory. `crawl` takes neither — it writes beside its
`--config` file.

`route` returns the ordered steps, a pasteable Playwright snippet, `confidence`, and `evidence`.
Execute those steps with whatever browser tooling is at hand. If a step fails, stop trusting the
map: run `invalidate --transition <id> --reason '…'` and continue by exploring directly.

Read `notes` before handing a route on. Two of them are about the route itself rather than the map:
a step marked **unstable** is a control that has been seen to land on more than one screen, so check
where you actually are after it instead of assuming the rest of the path still applies; and a target
marked **one-way** is a screen the map holds no safe click path back from, which is worth knowing
before you walk in rather than after. `status` counts both (`oneWay`, `isolated`).

The two fields answer different questions and neither substitutes for the other. `confidence` is
freshness — has the app moved since the map was made. `evidence` is `verified` when every step was
walked and proved, and `observed` when no proved route existed and the answer came from a recorded
session instead. An `observed` route is a report of what happened once, not a promise; say so when
you pass it on.

Driving through MCP browser tools instead? The same route comes back as `mcp`, or on its own with
`route --to '/cart' --format mcp`:

```jsonc
[ { "tool": "browser_navigate", "args": { "url": "http://localhost:5101/" } },
  { "tool": "browser_snapshot", "args": {} },
  { "tool": "browser_click", "args": { "element": "link \"장바구니\"" },
    "match": { "role": "link", "name": "장바구니", "href": "/cart" }, "refFrom": "browser_snapshot" } ]
```

**A `ref` is never precomputed and must never be invented.** Those tools mint one per snapshot, so
any ref written into a map would be a plausible value matching nothing. Each click therefore carries
its own `browser_snapshot`: take the snapshot, find the element that satisfies `match`, pass that
ref. Where `match` is a `css` rather than a role and name, several controls share the name and only
position separates them — that step is the brittle one.

`match.name` is the name as displayed when the map was made, badge counts and all — `상품 목록 1`
was `상품 목록 0` yesterday. Match on `href` when it is there, and treat the name as a prefix rather
than an equality test. The map's own `key` drops purely numeric tokens for this reason; a snapshot
does not carry keys, so the trimming cannot be done for you.

Other queries:

```bash
screen-map state   --route '/announcements'          # screens at a route, dialogs included
screen-map actions --route '/announcements'          # every edge with class, status, reason
screen-map route   --to '/cart' --from '/checkout'   # a path from somewhere other than an entrypoint
screen-map verify  --to '/cart'                      # replay the stored route in a browser
screen-map report                                    # regenerate map.md for a human
screen-map invalidate --transition t7 --reason '…'   # downgrade an edge that stopped working
```

When `route` answers `no safe path`, read the rest of the payload before concluding the screen is
unreachable: a `mutatingPath` means the crawl did get there, through a step that cannot be replayed.
Walk it by hand, or add that one action to `actionPolicy.allow` and re-crawl.

Exit codes: `0` success · `1` no answer (unknown route, no safe path) · `2` error · `3` refused by a
safety gate.

On Git Bash, a lone `--to '/settings'` is rewritten to a Windows path before Node sees it. Pass the
route without the leading slash (`--to settings`) or set `MSYS_NO_PATHCONV=1`.

As root — inside most containers and many CI images — Chrome cannot sandbox itself, and anything
that opens a browser (`crawl`, `verify`) refuses rather than silently dropping the sandbox. Re-run
as an unprivileged user, or accept the trade explicitly: `--no-sandbox` on one command, or
`SCREEN_MAP_NO_SANDBOX=1` for a session that shells out repeatedly. Either way the pages being
crawled run unsandboxed on an account that can do anything, so only point it at a local app.

## Building a map

1. Confirm the target is a disposable local environment with data the user is willing to lose.
2. Write `.screen-map/config.json` in the app repository:

   ```jsonc
   {
     "baseUrl": "http://localhost:5101",
     "allowHosts": ["localhost", "127.0.0.1"],
     "entrypoints": ["/"],
     "storageSeed": { "localStorage": { "onboarding-dismissed": "true" } },
     "auth": { "steps": [
       { "kind": "goto", "path": "/login?next=/dashboard" },
       { "kind": "fill", "selector": "#email", "value": "${SITE_MAP_EMAIL}" },
       { "kind": "click", "role": "button", "name": "로그인" },
       { "kind": "waitForPath", "path": "/dashboard" }
     ] },
     "routeTemplates": { "overrides": [{ "match": "/p/*", "template": "/p/:slug" }] },
     "actionPolicy": { "deny": [], "allow": [], "unknownActionClass": "mutating" },
     "budget": { "maxStates": 60, "maxActions": 300, "maxMillis": 600000, "listSamples": 3, "checkpointEvery": 10 }
   }
   ```

   `listSamples` caps how many links on one screen pointing at the same templated route are
   actually walked; a twenty-row list otherwise costs twenty replays and teaches nothing after the
   third. Every skipped edge records the cap and the total, so the map never hides it.

   Budget by controls, not by screens. A crawl pays per candidate action — walking back to the
   screen that owns it, pressing it, waiting for the app to settle — so one editor whose toolbar
   holds two hundred buttons costs more than twenty ordinary pages. When `maxMillis` keeps running
   out, read `coverage.actionsSeen` before raising it: a small app with a big control surface is
   the normal reason, and narrowing `entrypoints` buys more than a longer clock.

   If `run.timing` blames `act.settle` and the figure is close to the settle ceiling times the
   action count, the app is leaving requests open rather than being slow. A `fetch()` whose response
   body is never read is the usual culprit: the stream stays open, the request never finishes, and
   every action waits out the whole timeout on a screen that was ready in milliseconds.

   Credentials come from the environment through `${VAR}`. Never write one into the file.

   `storageSeed` is written before every document renders, so a welcome card or product tour that
   decides during mount never appears. Seeding is the only thing that works: an overlay's backdrop
   swallows the clicks meant for the screen behind it, so an unseeded crawl maps the modal and stops
   there. Put first-run flags here and nothing else — secrets belong in `auth.steps`.

   Auth steps run once, before the first entrypoint. `goto` (`path`, query and hash preserved) ·
   `fill` (`selector`, `value`) · `click` · `wait` (`ms`) · `waitForPath` (`path`, `timeoutMs`).
   A `click` takes either `selector`, which dispatches a DOM click and therefore reaches a control
   underneath an overlay, or `role` + `name`, which clicks the accessible name at its coordinates
   and is blocked by anything covering it — and cannot see a control inside a modal's `aria-hidden`
   remainder at all. Reach for `selector` when a login lives behind a collapsed `<details>` or under
   a dim backdrop; prefer `role` + `name` otherwise, since it survives markup churn.

3. Add `.screen-map/storage-state.json` to `.gitignore`, then commit `config.json`, `.gitignore`,
   and the app state that will be crawled. Start the crawl from that clean commit: config is part of
   the snapshot, while `storage-state.json` holds a live session and must never be committed.

4. Crawl:

   ```bash
   node /path/to/skills/screen-map/scripts/screen-map.mjs crawl --config .screen-map/config.json
   node /path/to/skills/screen-map/scripts/screen-map.mjs crawl --config .screen-map/config.json --allow-mutating
   ```

   `crawl` writes `map.json` and `map.md` next to the `--config` file, not into the working
   directory. It prints one line per action to **stderr** — `[7] /items :: click:button:필터 →
   verified 809ms (queue 8)` — while stdout stays the JSON result; `--quiet` silences it. A crawl
   that goes minutes without a line is stuck, not slow. Do not start a second crawl to find out.

   The map is written to disk every `budget.checkpointEvery` actions (default 10), so a crash or a
   Ctrl-C keeps the walking already done. Any such file says why it stopped in `run.budgetHit`:
   `incomplete` (a checkpoint whose crawl never reported finishing), `interrupted` (Ctrl-C), or
   `crashed`. Treat all three as partial and re-crawl; only `null` means the map is whole.

5. Read `map.md`, confirm the screen names make sense, and commit `map.json` and `map.md`. A commit
   containing only those generated artifacts remains fresh; later app or config changes make it stale.

Crawling reaches every screen by replaying an already-verified safe click path from an entrypoint,
so every route the map hands out has been walked end to end. `--no-replay-verify` drops that
guarantee for speed; say so if you use it.

An app that stores what the crawl does to it — an editor that autosaves, a wizard that remembers its
step — can stop reproducing its own opening screen once `--allow-mutating` has pressed a few
buttons. Those actions come back `blocked` with `entrypoint did not reproduce the mapped screen`,
and the verdict is remembered per screen so the clock is not spent proving it once per button. Read
that reason as "this screen is not re-enterable", not "the map failed": route the crawl at the
navigational parts of the app and expect a canvas or editor surface to map as one screen with its
controls recorded but unopened.

## Recording a session instead of crawling one

A crawl is expensive and refuses on principle to press anything mutating, so the screens behind a
login, a form submit, or a wizard's Save are exactly the ones it never reaches. `record` gets them
for nothing: it attaches to a running browser, watches whoever is driving it, and files what they
reach into the same map.

```bash
# open a browser and watch it — the endpoint is printed, and written to --endpoint-file if given
node /path/to/skills/screen-map/scripts/screen-map.mjs record \
  --config .screen-map/config.json --launch --port 9222

# or attach to one that is already running with --remote-debugging-port
node .../screen-map.mjs record --config .screen-map/config.json --port 9222
```

Then drive that browser with anything: `chromium.connectOverCDP('http://127.0.0.1:9222')`, a
Playwright MCP server pointed at the same endpoint, dom-picker's `--port`, or your own hands.
Everything walked lands in `.screen-map/map.json` as `observed` edges, beside whatever a crawl
already found. Controls that were on screen but never pressed are recorded `unexplored`, so the map
still says what else is there.

`record` never dispatches input, answers a dialog, closes a popup, or resizes anything: a recorder
that changes the session is recording itself. For the same reason **it closes only a browser it
opened** — attach with `--port` and your window survives the recording, socket dropped and nothing
else. On an abrupt kill a `--launch`ed browser can outlive it; it is a visible window, so close it.

Stop with Ctrl-C, or `--for <ms>` where signals are unreliable — MSYS `kill -INT` does not reach a
Node process on Windows as SIGINT, and Git Bash is the ordinary way to run this there. Either way
the map is written, and it is checkpointed as the session goes. A recording that never reported
finishing says `stoppedBy: "incomplete"` in `recordings`, exactly as a crashed crawl does.

`--launch` opens a visible window, since the point is that somebody drives it. Add `--headless` when
the driver needs no window — a Playwright run in CI, or any script that clicks by coordinate, where
a real window's paint timing lets a click land before layout and quietly do nothing. `--endpoint-file
<path>` writes the endpoint for a script to read, and with `--port 0` the browser takes any free port
so parallel sessions cannot collide.

Three things a recording will not do, each of which would be a lie:

- **It will not invent a click.** Arrive at a screen by typing a URL or a scripted `goto` and the
  screen is recorded with `reachable: "direct-url"` — no edge. Press several things before one screen
  comes back and none of them can be shown to be the cause, so all are dropped and counted in
  `droppedActions`. The one screen change with no control behind it that *is* filed as an edge is the
  browser's **back button**, recognized by the tab's position in its own session history falling:
  `kind: "history"`, replayed as `goBack()`. A crawl never produces one — its own `goBack` is how the
  crawler returns to a screen, not something the app does.
- **It will not record outside `allowHosts`.** Another tab on another site is watched and skipped,
  counted in `skippedHosts`. Recording a browser you also use means pointing it at a config whose
  allowlist you have read.
- **It will not make the map look newer than it is.** Freshness is still judged against the commit
  the map was based on, and a recording does not advance it. The per-entry commits hold the finer
  answer until freshness is computed from them.

Report `droppedActions` and `skippedHosts` when you report the run. They are clicks the user made
that the map does not contain.

Nothing promotes a recorded edge on its own. To find out whether one reproduces, replay it by hand:
`verify --to '/cart'` walks an `observed` path when no proved one exists and says which it used. It
reports and does not write, so a successful replay leaves the edge `observed`; a failed one is your
cue to `invalidate` the step that broke.

## How screens are identified

A node is a route template plus a coarse DOM signature, so `/items/1` and `/items/2` are one screen
while an open modal or dropdown is its own.

The signature is **structure only**: landmarks, form identities, input field names, the open overlay,
and the selected tab. Headings are excluded on purpose — on a detail screen the `h1` is the record's
title, so hashing it yields one node per record. Headings still supply the screen's title and
evidence; when the route is templated that title is one sample, flagged `titleIsSample`.

Action identity drops purely numeric tokens for the same reason: a rail button labelled `전체 9999`
must still be findable when the badge reads `전체 9998`.

`references/map-schema.md` documents the file.

## Staleness

`status` compares the app repository's `HEAD` against the commit recorded at crawl time. Uncommitted
changes to the app also count; regenerating the map files themselves does not.

A stale map is still useful — routes usually survive — but it is a hypothesis, not a record. Offer to
re-crawl when the user is about to depend on it.
