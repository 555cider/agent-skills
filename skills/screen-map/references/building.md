# Building a map

How to write `.screen-map/config.json` and run `crawl`. Read it before the first crawl of an
app, or when a crawl runs out of budget, cannot get past a login or overlay, or maps an editor
as one screen.

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

3. Commit `config.json` and the app state that will be crawled, and start the crawl from that
   clean commit: config is part of the snapshot. With `auth` steps the crawl writes the live session
   to `storage-state.json` and, when the directory has none, a `.gitignore` naming it; commit that
   `.gitignore`, never `storage-state.json`.

4. Crawl:

   ```bash
   node /path/to/skills/screen-map/scripts/screen-map.mjs crawl --config .screen-map/config.json
   node /path/to/skills/screen-map/scripts/screen-map.mjs crawl --config .screen-map/config.json --allow-mutating
   ```

   `crawl` writes `map.json` and `map.md` next to the `--config` file, not into the working
   directory. `--headed` shows the browser window, which is how to watch a crawl that keeps
   failing on one screen. It prints one line per action to **stderr** — `[7] /items :: click:button:필터 →
   verified 809ms (queue 8)` — while stdout stays the JSON result; `--quiet` silences it. A crawl
   that goes minutes without a line is stuck, not slow. Do not start a second crawl to find out.

   The map is written to disk every `budget.checkpointEvery` actions (default 10), so a crash or a
   Ctrl-C keeps the walking already done. Any such file says why it stopped in `run.budgetHit`:
   `incomplete` (a checkpoint whose crawl never reported finishing), `interrupted` (Ctrl-C), or
   `crashed`. Treat all three as partial and re-crawl; only `null` means the map is whole.

5. Read `map.md`, confirm the screen names make sense, and commit `map.json` and `map.md`. A commit
   containing only those generated artifacts remains fresh; later app or config changes make it stale.

Re-crawling replaces what the crawl itself found and keeps what recordings contributed: every
`observed` edge, the screens only a recording reached, and the `recordings` history are carried
into the new map, matched to the new crawl's screens by route and signature. Where the crawl has
its own edge for the same control, its proof stands and the recording only adds what it saw. The
crawl's JSON reports `carriedFromRecordings`.

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
