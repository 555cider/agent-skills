---
name: screen-map
description: Use when an agent needs to operate a local web app — reach a screen, run a flow, or write a browser test — and does not already know the click path, or when asked to map, re-map, or check the freshness of an app's screens and transitions. Answers "how do I get to X" with an executable action sequence drawn from a crawl that was actually walked. Does not cover fixing one pointed-at element, visual QA of a rendered screen, scraping third-party sites, non-browser work, or producing a sitemap.xml or information-architecture sitemap — this records executable actions between screens, not a URL hierarchy.
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
- **An action runs only when it is positively recognized as safe.** Anything unrecognized needs
  `--allow-mutating`; anything matching the destructive lexicon is never executed at all, under any
  flag. See `references/action-policy.md`.
- **Never present a stale route as fact.** When `status` says stale, say so, and tell the user the
  route is discarded the moment a step fails.
- **Never merge maps.** Only `crawl` adds states and transitions. During use, `invalidate` may
  downgrade a broken transition and nothing more. A map is one snapshot of one commit.
- **Report what was not covered.** A budget hit, a blocked edge, a sampled list, or a leftover
  frontier is part of the answer, not a footnote to omit.

## Answering "how do I get to X"

Resolve paths relative to this skill directory. Every command prints JSON.

```bash
node scripts/screen-map.mjs status
node scripts/screen-map.mjs route --to '/announcements/:id'
```

`route` returns the ordered steps, a pasteable Playwright snippet, and `confidence`. Execute those
steps with whatever browser tooling is at hand. If a step fails, stop trusting the map: run
`invalidate --transition <id> --reason '…'` and continue by exploring directly.

Other queries:

```bash
node scripts/screen-map.mjs state   --route '/announcements'   # screens at a route, dialogs included
node scripts/screen-map.mjs actions --route '/announcements'   # every edge with class, status, reason
node scripts/screen-map.mjs verify  --to '/cart'               # replay the stored route in a browser
node scripts/screen-map.mjs report                             # regenerate map.md for a human
```

Exit codes: `0` success · `1` no answer (unknown route, no safe path) · `2` error · `3` refused by a
safety gate.

On Git Bash, a lone `--to '/settings'` is rewritten to a Windows path before Node sees it. Pass the
route without the leading slash (`--to settings`) or set `MSYS_NO_PATHCONV=1`.

## Building a map

1. Confirm the target is a disposable local environment with data the user is willing to lose.
2. Write `.screen-map/config.json` in the app repository:

   ```jsonc
   {
     "baseUrl": "http://localhost:5101",
     "allowHosts": ["localhost", "127.0.0.1"],
     "entrypoints": ["/"],
     "auth": { "steps": [
       { "kind": "goto", "path": "/login" },
       { "kind": "fill", "selector": "#email", "value": "${SITE_MAP_EMAIL}" },
       { "kind": "click", "role": "button", "name": "로그인" },
       { "kind": "waitForPath", "path": "/dashboard" }
     ] },
     "routeTemplates": { "overrides": [{ "match": "/p/*", "template": "/p/:slug" }] },
     "actionPolicy": { "deny": [], "allow": [], "unknownActionClass": "mutating" },
     "budget": { "maxStates": 60, "maxActions": 300, "maxMillis": 600000, "listSamples": 3 }
   }
   ```

   `listSamples` caps how many links on one screen pointing at the same templated route are
   actually walked; a twenty-row list otherwise costs twenty replays and teaches nothing after the
   third. Every skipped edge records the cap and the total, so the map never hides it.

   Credentials come from the environment through `${VAR}`. Never write one into the file.

3. Crawl:

   ```bash
   node scripts/screen-map.mjs crawl --config .screen-map/config.json
   node scripts/screen-map.mjs crawl --config .screen-map/config.json --allow-mutating   # opt-in
   ```

4. Read `map.md`, confirm the screen names make sense, and commit `map.json`, `map.md`, and
   `config.json`. Add `.screen-map/storage-state.json` to `.gitignore` — it holds a live session.

Crawling reaches every screen by replaying an already-verified safe click path from an entrypoint,
so every route the map hands out has been walked end to end. `--no-replay-verify` drops that
guarantee for speed; say so if you use it.

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
