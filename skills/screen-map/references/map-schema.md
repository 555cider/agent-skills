# `map.json` schema (version 2)

Two things write this file: `crawl`, which walks the app on its own, and `record`, which watches
somebody else walk it. Both go through the same registry, so identity is computed identically and a
recording adds to what a crawl already found instead of duplicating it.

Nothing else may write it. The file is not hand-edited and two maps are never concatenated — but
because entries can now arrive at different times, **every state and transition carries its own
provenance and its own commits**. That is what keeps a grown map honest: the file is no longer one
snapshot of one commit, so each record says when it was seen and when it was proved.

A version 1 map still loads. It is migrated in memory — every entry becomes `source: "crawl"` at the
commit the run recorded — and is written back as version 2 the next time anything saves it.

**Fields added since are optional, and absent means `false`.** `nondeterministic`, `inert` and
`toAlternatives` are written only once something has been observed that sets them, and `action.inNav`
is written on every new edge but is missing from every older map. So a file written before any of
them existed reads correctly without being migrated, which is why the version number has not moved:
nothing about an older file has to change for a newer reader to be right about it. Never treat a
missing one as unknown — it means no, and a reader that hedges there reports every old map as
suspect.

```jsonc
{
  "schema": 2,

  "app": {
    "baseUrl": "http://localhost:5101",
    "commit": "f4961ed",      // app repo HEAD at crawl time; null outside a git repo
    "dirty": false            // app had uncommitted changes; the map files themselves do not count
  },

  "run": {
    "id": "run-20260804T1435",
    "startedAt": "…", "finishedAt": "…",
    "replayVerify": true,     // false means routes were not walked end to end
    "allowMutating": false,
    "timing": {               // where the wall clock went; running out of it is the ordinary failure
      "totalMs": 214300,
      "phases":   [{ "label": "act.settle", "ms": 98000, "count": 118 }],   // by phase, descending
      "byScreen": [{ "route": "/orders", "title": "…", "ms": 61000, "actions": 34 }],
      "slowest":  [{ "from": "/orders", "action": "내보내기", "status": "verified", "ms": 4100 }]
    },
    "budgetHit": null,        // why the crawl stopped short; null means it finished
                              //   "maxStates" | "maxActions" | "maxMillis" — a ceiling the caller set
                              //   "incomplete" — a mid-crawl checkpoint; the run never reported finishing
                              //   "interrupted" — stopped by hand (Ctrl-C)
                              //   "crashed" — the crawl died with an error
    "dialogs": []             // javascript dialogs encountered and auto-cancelled
  },

  // Every state and transition carries these five. They answer three different questions,
  // and collapsing them loses the one that matters — see "Reading it correctly" below.
  //   "source": "crawl",                 // "crawl" | "record"
  //   "commit": "f4961ed",               // app commit when this was FIRST seen
  //   "recordedAt": "…",
  //   "lastObservedCommit": "a1b2c3d",   // app commit when it was LAST seen
  //   "lastObservedAt": "…"

  "states": [{
    "id": "s3",
    "route": "/announcements/:id",   // primary key: templated path
    "signature": "h:9f2a…",          // secondary key: structural DOM fingerprint
    "kind": "page",                  // "page" | "overlay" (modal, dropdown, popover)
    "title": "2026 하반기 MARU 배치",
    "titleIsSample": true,           // templated route: the title is one record's
    "reachable": "direct-url",       // present only when no safe click path existed
    "evidence": {
      "urlSample": "/announcements/123",
      "headings": [], "landmarks": [], "forms": [], "fields": [], "overlay": null
    }
  }],

  "transitions": [{
    "id": "t7",
    "from": "s2",
    "to": "s3",                      // null when the action was never performed
    "toAlternatives": [],            // absent unless this control has landed somewhere else too
    "nondeterministic": false,       // absent unless it has; `route` stops promising such an edge
    "inert": false,                  // absent unless the press changed screen, URL and network not at all
    "action": {
      "kind": "click",               // "click" | "link" | "submit" | "history"
      "role": "button", "name": "전체 9999",   // name as displayed
      "href": null, "hrefRaw": null, "external": false,
      "cssFallback": "aside > nav > section:nth-of-type(1) > button:nth-of-type(1)",
      "key": "click:button:전체",    // identity: numeric tokens dropped from the name
      "ambiguous": false,            // true when only position disambiguated it
      "fallbackUsed": false,         // true when the key missed and cssFallback matched
      "inNav": false                 // inside a nav landmark; half of what makes a control global
    },
    "class": "safe",                 // "safe" | "mutating" | "destructive"
    "classifiedBy": "same-origin-link",
    "status": "verified",            // "verified" | "observed" | "unexplored" | "sampled"
                                     //   | "blocked" | "failed"
    "blockedReason": null,
    "lastVerifiedAt": "…",
    "verifiedAtCommit": "f4961ed",   // app commit when the replay proved it; null if never
    "replayFailed": false,           // a replay tried this edge and could not reproduce it;
                                     //   such an edge is never handed back as a route again
    "invalidatedAt": "…",            // present only after `invalidate`
    "ms": 412                        // wall time this edge cost: reaching the screen, the
                                     // click, and settling. Absent on edges never attempted.
  }],

  "entrypoints": ["s0"],

  "coverage": {
    "states": 24, "actionsSeen": 118, "executed": 71,
    "notExecuted": 41,                                // every edge that is not `verified`
    "unexplored": 18, "sampled": 17, "blocked": 6, "failed": 0,   // and its parts; these sum to it
    "frontier": ["/orders :: click:button:내보내기"]   // queued but never reached
  }
}
```

## Reading it correctly

**Freshness follows the app tree, not the repository's commit counter.** Committing generated
`map.json` or `map.md` after a crawl keeps the snapshot fresh because those files do not change the
app that was observed. Changes to application files or `config.json` make it stale. If the recorded
commit is no longer available locally after a rebase, force-push, or shallow clone, freshness is
`unknown` rather than guessed.

**`source` is who *found* it, not who last learned something about it.** The crawl lists every
control it can see, including the ones its policy refuses to press. When a recording later walks one
of those, the edge keeps `source: "crawl"` — the crawl is where the control came from — and gains
`status: "observed"`. Reading `source` as "who produced the current status" inverts that and loses
the finder. The status is the field that says how the edge is known; only a recording produces
`observed`, so nothing is ambiguous.

**Three timestamps, three questions.** `commit`/`recordedAt` say when an entry was first seen.
`lastObservedCommit`/`lastObservedAt` say when it was last seen — a recording that revisits a screen
updates these and nothing else, so an edge found by a crawl weeks ago and confirmed to still exist
today does not keep answering with the old commit. `verifiedAtCommit`/`lastVerifiedAt` say when a
replay last proved it. An entry can be observed long after it was last verified; that gap is
information, which is why the fields are not merged.

**`status` is the honesty field.** `verified` means the transition was performed by this tool and
its target observed. `observed` means it happened once in front of `record` — real evidence about
the app, and no evidence at all that it repeats: nothing walked it a second time to find out.
`unexplored` means the edge exists in the UI and policy forbade pressing it. `sampled`
means it is one of many links on the screen pointing at the same templated route, and the crawl
walked `budget.listSamples` of them — the `blockedReason` names the cap and the total. `blocked`
means the crawler could not or would not go there. `failed` means it was tried and did not work, or
`invalidate` downgraded it during use.

Sampling is why a twenty-row list does not cost twenty replays. It is a deliberate cap, recorded on
every skipped edge; raise `budget.listSamples` when the rows genuinely lead somewhere different.

**`coverage.notExecuted` is the total; `blocked` is one status inside it.** They used to be the same
number under the second name, so `sampled` was counted twice — beside `blocked` and again inside it.
Read `notExecuted` for "how much of the app was never pressed" and the four status counts for why.

**Routing prefers `verified` + `safe`, and says when it could not get one.** A path containing a
mutating step is not reproducible, so `route` reports no path rather than hand back something that
works once. When no proved path exists but a recorded one does, `route` answers with it and sets
`evidence: "observed"` plus a note — a report of what happened, not a guarantee that it repeats.
`confidence` is a separate axis and stays freshness: a fresh map can still hand back a route nobody
ever replayed.

**One control is not always one destination.** When a `(from, action.key)` edge is seen to land
somewhere other than its recorded `to`, the edge is not split — splitting it would file the same
button as two controls and hide the only fact worth keeping. Instead `nondeterministic` is set, the
displaced screen moves into `toAlternatives`, and `to` becomes the newer observation, which is what a
caller replaying now is most likely to meet — **except that a watched observation never displaces a
proved one.** A recording that sees the control land elsewhere is recorded as exactly that, but
letting it take `to` would delete the crawl's proved destination from the graph and a route to that
screen would stop existing on the strength of one thing somebody saw once. Recordings raise what is
known and never lower it, here as with `status`. `route` will not build a promised path through such an
edge: its first pass skips it, so an answer containing one comes back as `evidence: "observed"` with a
note naming the step. This is the same idea as `replayFailed` — evidence that a step is not
dependable is worth as much as evidence that it works.

**`inert` means the press did nothing at all**: same screen, same URL, and not one request left the
browser. It is recorded only by `crawl`, which is the only thing holding the network counter. A
refresh or a retry button is *not* inert — it lands back on its own screen but does reach the server,
and that difference is why the two are not one flag. Inert edges stay in `transitions`; `map.md`
counts them separately (`⊙`) so a dead control does not read as a screen full of activity.

**Browser history edges exist, and only recordings make them.** `action.kind: "history"` is a screen
change with no control behind it — somebody pressed the browser's own back button while `record` was
watching. The crawl never writes one: its `page.goBack()` is how the crawler returns to a screen, an
implementation detail of walking, not something the app does.

It is recognized by the tab's position in its own session history falling, asked of the browser
rather than of the page. A listener inside the document cannot do this job: a back navigation to a
different document builds a *new* document, and the `popstate` for the traversal never reaches a
script injected into the page it lands on. Reading the history index is not driving, so the recorder
stays as passive as it was. Like everything else a recording sees, the edge is `observed` — it
happened once, and nothing walked it again to find out whether it repeats. A replay walks it with
`goBack()`.

**One-way screens and global navigation are derived, not stored.** Whether a screen can be got back
from, and whether a control is site furniture rather than a step, are both computed from
`transitions` when `status`, `route` or `report` runs. Keeping them in the file would create a second
copy that can disagree with the graph it came from. `map.md` folds global navigation out of the
diagram and lists it once; **routing keeps every one of those edges**, because a header link is
usually the shortest and sturdiest way anywhere.

An edge with `replayFailed: true` is excluded from routing entirely, `observed` or not. It is the
one case where the map holds positive evidence that the step does not work, and offering it would be
worse than offering nothing.

**`route` is the intended read path.** Loading the whole file into context defeats the point; on a
real app it is large. Query it.

**A screen can appear more than once at the same route.** `/items` with a filter dialog open is a
different node from `/items`. Use `state --route` to see all of them and `kind` to tell them apart.
An app with one global user menu therefore grows one `overlay` node per route; that is accurate, not
duplication.

**Overlay detection needs a `<main>`.** A true modal is found by `aria-modal`, but a dropdown or
popover is recognized only by the page having gone `aria-hidden` behind it — and the element checked
for that is `main, [role="main"]`. An app without one never reports an `overlay` node: the menu's
items and the background behind it are harvested as one screen, so the map gains transitions that
only exist while the menu is open. Adding the landmark to the app is the fix.

**The signature is structure, not content.** It hashes landmarks, form identities, input field
names, the open overlay, and the selected tab. Headings are excluded: on a detail screen the `h1` is
the record's title, and hashing it produced one node per record on the first real app this was run
against. `title` is still taken from a heading, which is why `titleIsSample` exists.

**`key` is identity, `name` is display.** Purely numeric tokens are stripped from the key so a badge
count that moves does not orphan the control. When `fallbackUsed` is true the control was found by
CSS position rather than by name — that route is more brittle than the rest.

`href` is the resolved absolute destination used for origin checks. `hrefRaw` preserves the anchor's
literal attribute so same-name links can produce distinct Playwright locators without falling back
to list position.

**`frontier` is not decoration.** A non-empty frontier or a non-null `budgetHit` means the map is
incomplete, and any claim of coverage has to say so.

**A map on disk is not proof a crawl finished.** `crawl` checkpoints every
`budget.checkpointEvery` actions so a crash does not cost the whole walk, and it writes one last
file on Ctrl-C and on a fatal error. Those files are structurally identical to a finished map and
differ only in `run.budgetHit` — `incomplete`, `interrupted`, `crashed`. Read that field before
reading anything else.
