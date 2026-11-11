# Recording a session instead of crawling one

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

With several tabs open, `--target <targetId>` (from `http://127.0.0.1:<port>/json`) records
only that one.

A single-page app's `pushState` and back button change the screen without a new document; the
recorder follows those too. A click whose page-side route differs from the screen the tab last
settled on is dropped as `from-mismatch` rather than filed from the wrong screen.

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
