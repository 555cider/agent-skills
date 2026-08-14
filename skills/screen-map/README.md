# Screen Map — maintainer notes

An agent-readable map of a web app: the screens it has, and the concrete action that moves between
any two. One crawl produces one snapshot; every later question is a query against that file.

## Why it exists

Without a map, an agent operating a web app snapshots, guesses, clicks, and snapshots again. It is
expensive, it loses its place, and everything it worked out dies with the session. This skill freezes
one exploration so the next session starts with `route --to '/announcements/:id'` and three
executable steps.

The design record is `docs/superpowers/specs/2026-08-04-screen-map-design.md` in the monorepo. It is
not part of the published skill — installs clone the `split/screen-map` branch, which carries this
directory and nothing above it — so the path only resolves for maintainers working in the monorepo.

## Layout

```
scripts/screen-map.mjs   CLI: crawl, record, route, state, actions, status, verify, report, invalidate
scripts/model.mjs      pure logic — route templates, signatures, classification, registry, graph, rendering
scripts/browser.mjs    Chrome launch or attach + minimal CDP client + page operations
scripts/record.mjs     the recorder: watches a session it does not drive, and files what it sees
scripts/harvest.js     injected into the page: describes the screen, resolves an action, reports clicks
references/            action policy and the map.json schema
tests/                 fixture app, pure-model tests, crawl assertions, query assertions, an external driver
```

`model.mjs` holds everything that can be decided without a browser, which is what makes most of the
suite run in milliseconds. `harvest.js` gathers evidence only — it never decides whether an action
may run, so page script cannot influence the policy.

`createRegistry` in `model.mjs` is the seam the two builders meet at. It computes identity and
classification and nothing else; sampling, budgets, the frontier queue and the mutating gate are
crawl policy and stay in `commandCrawl`. Keep it that way — a recorder that inherited the crawl's
queue would walk edges nobody asked it to walk, which is the one thing a recorder must never do.

## Design properties worth preserving

**Two builders, one identity.** `crawl` and `record` both add states and transitions, through the
same registry. If either ever computes a route template, a signature or an action key differently,
a recording files screens the crawl already knows as new nodes and the graph silently stops
connecting. `invalidate` may downgrade a transition during use; nothing else writes.

**Provenance instead of snapshots.** The map used to be one crawl pinned to one commit, and merging
was banned outright because mixed-version observations could not be told apart. They can now: every
entry carries when it was first seen, last seen, and last proved. The ban that remains is on
hand-editing and on concatenating two maps.

**Recording never touches the page.** No input dispatched, no dialog answered, no popup closed, no
viewport set — `Page.attach` exists to make that structural rather than a matter of discipline. It
also closes only a browser it launched. Both are load-bearing: the point of a recording is that the
session it watched is the session that would have happened anyway.

**Never invent causality.** An edge is written only when exactly one action is outstanding and one
screen comes back. Several presses landing on one screen are dropped and counted in
`droppedActions`; an arrival with no press behind it is recorded as `direct-url` with no edge. The
weaker `observed` status exists for the same reason — watching something happen once is evidence
about the app and no evidence at all about whether it repeats.

The one arrival that is *not* causeless is the back button, and it is recognized from outside the
page: the tab's session-history index falling. A `popstate` listener injected into the document
cannot do it, because a back navigation to a different document builds a new document and the
traversal never reaches a script running in the page it lands on — measured, not assumed. Reading
the history index is not driving, so the recorder stays passive.

**One control, one edge — even when it wobbles.** A `(from, action.key)` edge that lands somewhere
other than its recorded target is not split into two edges. Splitting would file one button as two
controls and lose the only fact worth having: that it cannot be relied on. Instead the edge gains
`nondeterministic`, the displaced screen moves to `toAlternatives`, and `route` will not build a
promised path through it. Same principle as `replayFailed` — evidence that a step does *not* work is
worth keeping.

**Projections change the picture, never the graph.** `map.md` folds a site's global menu out of the
diagram (a control inside a nav landmark, on most screens — counted, never classified by a model) and
counts inert presses apart from real self-loops. Routing sees every edge regardless: a header link is
usually the shortest and sturdiest way anywhere. One-way and unreachable screens are computed the
same way, on read, and never stored — a derived field on disk is one more thing that can disagree
with the graph it came from.

**Positive recognition, not blocklisting.** An action runs by default only when a rule proves it
safe. See `references/action-policy.md` — particularly why unknown defaults to `mutating` rather than
`destructive`.

**Replay verification.** To test an action in state `s`, the crawler replays an already-verified safe
path from an entrypoint to `s` and confirms the signature before acting. That is what makes "every
route the map hands out has been walked end to end" true rather than aspirational. It is also the
main cost; `--no-replay-verify` trades it away.

**Deliberately lossy signatures.** The DOM fingerprint excludes item counts, dates, and user data. Add
any of them and one list screen becomes hundreds of nodes.

## Tests

```bash
bash skills/screen-map/tests/run.sh
```

Needs Node 22+ and Chrome. The suite starts a fixture app on a random port, crawls it twice (default
and `--allow-mutating`), records two sessions against it, and asserts the map.

The fixture counts every state-changing request it receives, which is how the suite proves a
negative: `clicks.delete` must stay at `0` because the crawler never pressed the destructive button.
If that assertion ever goes green for the wrong reason — for example because the button stopped being
found at all — the sibling assertion that the edge exists will fail. The recording section leans on
the same counters for a stronger claim: after a whole recorded session *every* counter must still be
zero, because a recorder that pressed anything is not one.

`tests/drive.mjs` stands in for Playwright — it attaches over CDP and dispatches real mouse input.
It deliberately shares no code with the skill. A recorder tested through the skill's own driver
would prove only that the two halves agree with each other.

Recording tests use `--launch --port 0` and read the real endpoint back from `--endpoint-file`, so
parallel worktrees cannot collide on a debug port. They end by having the driver close the tab, not
by signalling: MSYS `kill -INT` does not reach a Node process on Windows as SIGINT, and waiting out
the `--for` ceiling instead once added three minutes of dead time to the suite.

Windows: never use process substitution in `run.sh`. Node on Windows resolves `/proc/<pid>/fd/N` to
`C:\proc\...` and cannot open it. Write real files.
