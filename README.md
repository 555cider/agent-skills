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
scripts/screen-map.mjs   CLI: crawl, route, state, actions, status, verify, report, invalidate
scripts/model.mjs      pure logic — route templates, signatures, classification, graph, rendering
scripts/browser.mjs    Chrome launch + minimal CDP client + page operations
scripts/harvest.js     injected into the page: describes the screen, resolves an action to a point
references/            action policy and the map.json schema
tests/                 fixture app, pure-model tests, crawl assertions, query assertions
```

`model.mjs` holds everything that can be decided without a browser, which is what makes most of the
suite run in milliseconds. `harvest.js` gathers evidence only — it never decides whether an action
may run, so page script cannot influence the policy.

## Design properties worth preserving

**Snapshots, not accumulation.** Only `crawl` adds states and transitions. `invalidate` may downgrade
a transition during use; nothing else writes. An incrementally grown map mixes observations from
different app versions with no way to tell which are still true.

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
and `--allow-mutating`), and asserts the map.

The fixture counts every state-changing request it receives, which is how the suite proves a
negative: `clicks.delete` must stay at `0` because the crawler never pressed the destructive button.
If that assertion ever goes green for the wrong reason — for example because the button stopped being
found at all — the sibling assertion that the edge exists will fail.

Windows: never use process substitution in `run.sh`. Node on Windows resolves `/proc/<pid>/fd/N` to
`C:\proc\...` and cannot open it. Write real files.
