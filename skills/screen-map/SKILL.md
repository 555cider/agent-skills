---
name: screen-map
description: Use to operate a local web app without a known click path (reach a screen, run a flow, write a browser test), to map it or check a map's freshness, or to record a driven browser session into a reusable map. Not for fixing one element, visual QA, scraping third-party sites, or sitemap.xml.
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
screen-map report [--out <file>]                     # regenerate map.md for a human
screen-map invalidate --transition t7 --reason '…'   # downgrade an edge that stopped working
```

`verify` replays exactly the path `route` would hand out, `--from` included, and `--headed` shows
the window while it does. `invalidate` rewrites `map.md` along with `map.json`.

When `route` answers `no safe path`, read the rest of the payload before concluding the screen is
unreachable: a `mutatingPath` means the crawl did get there, through a step that cannot be replayed.
Explore only within the user's existing action authorization, or record a session the user drives. A missing safe route does not authorize changing `actionPolicy.allow`. A pre-existing, explicitly authorized allow entry may be used; do not create one just to improve coverage.

Exit codes: `0` success · `1` no answer (unknown route, no safe path) · `2` error · `3` refused by a
safety gate.

On Git Bash a leading-slash `--to`, `--from`, or `--route` is rewritten to a Windows path before
Node sees it; the CLI turns it back. If a route still comes back as `C:/…` in an error, pass it
without the leading slash (`--to settings`).

As root — inside most containers and many CI images — Chrome cannot sandbox itself, and anything
that opens a browser (`crawl`, `verify`) refuses rather than silently dropping the sandbox. Re-run
as an unprivileged user, or accept the trade explicitly: `--no-sandbox` on one command, or
`SCREEN_MAP_NO_SANDBOX=1` for a session that shells out repeatedly. Either way the pages being
crawled run unsandboxed on an account that can do anything, so only point it at a local app.

## Building a map

Only on a disposable local environment the user is willing to lose data in. Before the first
crawl, or when a crawl stops short (budget, login, overlay, an editor that will not re-open),
read [references/building.md](references/building.md): config, auth steps, budget, and how to
read a partial map.

## Recording a session instead of crawling one

When the screens that matter sit behind a login, a form submit, or any step the crawl refuses to
press, record a session somebody else drives instead: `record --launch` or `record --port`.
Read [references/recording.md](references/recording.md) before starting one; it covers what a
recording will not do and what to report afterwards (`droppedActions`, `skippedHosts`).

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
