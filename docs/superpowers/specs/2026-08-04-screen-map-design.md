# screen-map — an agent-readable map of a web app

Date: 2026-08-04
Status: accepted, with three points superseded by the implementation

The record below is the design as accepted. Three parts of it are no longer what
the skill does, and `skills/screen-map/references/` is the authority on those:

- **"Unclassifiable means destructive"** became `mutating`, gated behind
  `--allow-mutating` and configurable via `actionPolicy.unknownActionClass`.
  Refusing every unrecognized control outright left ordinary apps unmappable;
  the reasoning is in `references/action-policy.md`.
- **`kind: "page" | "dialog" | "panel"`** became `"page" | "overlay"`. A dropdown
  and a modal differ in markup, not in what a crawl must do about them.
- **"an existing map is reused as the crawl *plan*"** is **not implemented.**
  Every re-crawl is a fresh breadth-first walk, and there is no `--resume` that
  picks up the leftover `coverage.frontier`. The snapshot argument below still
  holds; only the cost claim attached to it is unearned.

## Problem

To do anything in a web app, an agent gropes its way forward: snapshot, guess,
click, snapshot again. That is expensive, it loses its place often, and every
route it works out evaporates when the session ends. The next session starts
from zero.

## Goal

Freeze one exploration into a **point-in-time snapshot map** so a later agent can
ask "how do I reach the announcement detail screen?" and get three executable
actions back. The consumer is an agent, not a person; humans only review.

## Decisions

| Fork | Decision |
| --- | --- |
| Primary consumer | The **next session's agent**. Humans review only. |
| Collection | **Whole-snapshot regeneration.** Runs are never merged — a new map replaces the old one. |
| Node identity | **Route template + coarse DOM signature** (`/a/123` and `/a/456` collapse; a modal is its own node). |
| State-changing actions | **Classify and fail closed** — safe runs, mutating is opt-in, destructive is never executed. |
| Viewer UI | **Out of scope for v1.** Humans review generated Markdown. |
| Query interface | **CLI queries** that return only the path fragment needed, never the whole map. |

### Why snapshots rather than accumulation

An incrementally grown map mixes transitions recorded at different app versions
and offers no way to tell which are still true. A snapshot carries one
`app.commit`, so staleness is derived from the application changes since that
commit while ignoring only generated map artifacts. Re-crawling stays cheap
because an existing map is reused as the crawl *plan*: stored actions replay, and
the agent only adjudicates where reality diverged. That is regeneration with a
hint, not accumulation.

Only `crawl` may add states and transitions. Live use may `invalidate` a broken
transition, which downgrades it and never adds anything. Old and new cannot
tangle.

## Artifact

Written into the target app's repository:

```
.screen-map/
  map.json             # the map (snapshot)
  map.md               # generated human review summary
  config.json          # crawl settings, hand-written, committed
  storage-state.json   # auth snapshot, gitignored
```

Committing `map.json` is recommended: the next session gets it without
re-crawling, and `app.commit` makes staleness detectable.

### `map.json`

```jsonc
{
  "schema": 1,
  "app": { "baseUrl": "http://localhost:5101", "commit": "f4961ed", "dirty": false },
  "run": { "id": "…", "startedAt": "…", "finishedAt": "…", "budgetHit": null },
  "states": [{
    "id": "s3",
    "route": "/announcements/:id",
    "signature": "h:9f2a…",
    "kind": "page" | "dialog" | "panel",
    "title": "공고 상세",
    "evidence": { "urlSample": "/announcements/123", "headings": [], "landmarks": [], "forms": [] }
  }],
  "transitions": [{
    "id": "t7", "from": "s2", "to": "s3",
    "action": { "kind": "click", "role": "row", "name": "공고 A",
                "playwright": "getByRole('row', { name: '공고 A' })", "cssFallback": "…" },
    "class":  "safe" | "mutating" | "destructive",
    "status": "verified" | "unexplored" | "blocked" | "failed",
    "lastVerifiedAt": "…"
  }],
  "entrypoints": ["s0"],
  "coverage": { "states": 24, "actionsSeen": 118, "executed": 71, "blocked": 12, "frontier": [] }
}
```

`status: "unexplored"` carries the weight of the fail-closed policy. A
destructive action is never clicked, but the *edge is still recorded* — "the
delete button is at the top right of the detail screen, and it was not pressed"
is itself worth knowing. Failing closed therefore does not punch holes in the
map.

### Node identity

- **Route template.** Numeric, UUID, and configured slug segments collapse to
  `:id`. Overridable per app in `config.json`.
- **DOM signature.** Sorted hash over landmark roles, truncated `h1`/`h2` text,
  form names, open dialog role and name, and active tab name. Deliberately
  lossy: item counts, dates, and user data are excluded, or the node count
  explodes.
- Same route plus same signature means the same node.

## Crawl

1. **Environment gate.** Refuse any host outside `config.allowHosts` (default
   `localhost`, `127.0.0.1`) before opening a browser. This is the guard against
   accidentally crawling staging or production.
2. **Auth.** Run the configured auth recipe once, snapshot cookies and
   `localStorage` to `storage-state.json`, then inject that state on every later
   navigation instead of logging in again.
3. **Frontier BFS.** Per state: fingerprint and dedupe, harvest interactive
   elements into role-plus-accessible-name descriptors with a CSS fallback,
   classify each action, execute the permitted ones, and record the resulting
   transition.
4. **Replay verification.** To test action `a` in state `s`, replay the shortest
   already-verified path from an entrypoint to `s`, then perform `a`. This
   removes order dependence and — the real point — guarantees that **every path
   the map hands out has been walked end to end at least once**. On by default;
   `--no-replay-verify` trades that guarantee for speed.
5. **Budget.** `maxStates`, `maxActions`, wall clock. Whatever is left is
   recorded in `coverage.frontier` rather than silently dropped.
6. **Dialogs.** Subscribe to `Page.javascriptDialogOpening` and always dismiss.
   An unhandled dialog locks CDP and kills the session.

### Hard rules

- Refuse hosts outside the allowlist; never navigate outside the origin allowlist.
- Never execute a destructive action; record it as `unexplored`.
- Execute mutating actions only with `--allow-mutating` and a passing gate.
- Never fill credential or payment fields; never upload files.
- Unclassifiable means destructive.

## Query CLI

```bash
node scripts/screen-map.mjs crawl --config .screen-map/config.json [--allow-mutating]
node scripts/screen-map.mjs route --to '/announcements/:id' [--from '/']
node scripts/screen-map.mjs state --route '/announcements'
node scripts/screen-map.mjs actions --route '/announcements'
node scripts/screen-map.mjs status
node scripts/screen-map.mjs report
node scripts/screen-map.mjs invalidate --transition t7 --reason '…'
```

`route --to` is the agent's payload: an ordered action sequence, a pasteable
Playwright snippet, and `confidence: fresh | stale | unknown`. The whole map never
needs to enter context.

`status` compares application and config changes between `map.app.commit`, the
current `HEAD`, and the working tree. A later commit containing only generated
`map.json`, `map.md`, or `storage-state.json` does not stale the observed app;
application or config changes do. If the recorded commit is unavailable locally,
the verdict is `unknown` rather than guessed. A stale route is discarded the
moment any step fails.

## Out of scope for v1

The original proposal described a human-facing graph viewer. With an agent as the
consumer, its machinery goes away: SCC capsules and Tarjan, representative-cycle
computation, the four path modes, the run list and timeline, opacity layers, and
the transition detail panel. Collapsing cycles is a presentation device; shortest
path over the graph is all an agent needs. Snapshot diffing for regression
detection is deferred, but `app.commit` keeps the door open.

If a viewer is wanted later it should be a separate skill that consumes
`map.json`. Building a map and drawing a map are different problems.

## What the first real app changed

The fixture suite passed before any of these. Each was found by crawling a running
React app (solport) and reading the result.

- **Headings left the signature.** Hashing the `h1` split one detail screen into 21
  nodes, one per record. The signature is now structure only — landmarks, form
  identities, input field names, overlay, selected tab. Field *names* are schema,
  so a wizard at one URL still splits correctly.
- **Overlays are not just dialogs.** A dropdown marks the rest of the document
  `aria-hidden`, so the page read as completely empty and every route grew a phantom
  blank node. `kind` is now `page | overlay`, and an overlay's name comes from its
  label, never its text — folding a user menu's contents into the screen's identity
  would change the screen whenever the user's name did.
- **Numeric tokens left action identity.** A rail button labelled `전체 9999` could
  not be found again once the badge moved, which blocked 24 transitions.
- **`navigate` is not `settle`.** Replay clicked immediately after load, before the
  app had rendered its navigation, and reported a broken map. That single missing
  await accounted for every remaining replay failure.
- **Replay walks from where it stands.** Restarting from an entrypoint for every
  action ran the fixture out of clock. Walking the safe path from the current screen
  is still a verified click path and finishes.

After these, the same crawl produced 10 screens with zero replay failures; everything
not executed was a policy decision, which is the intended outcome.
