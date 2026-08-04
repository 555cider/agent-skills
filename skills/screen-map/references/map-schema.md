# `map.json` schema (version 1)

One crawl produces one file. Maps are never merged: a new crawl replaces the old snapshot, so every
record in the file belongs to the same app commit.

```jsonc
{
  "schema": 1,

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
    "budgetHit": null,        // "maxStates" | "maxActions" | "maxMillis" when the crawl was cut short
    "dialogs": []             // javascript dialogs encountered and auto-cancelled
  },

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
    "action": {
      "kind": "click",               // "click" | "link" | "submit"
      "role": "button", "name": "전체 9999",   // name as displayed
      "href": null, "hrefRaw": null, "external": false,
      "cssFallback": "aside > nav > section:nth-of-type(1) > button:nth-of-type(1)",
      "key": "click:button:전체",    // identity: numeric tokens dropped from the name
      "ambiguous": false,            // true when only position disambiguated it
      "fallbackUsed": false          // true when the key missed and cssFallback matched
    },
    "class": "safe",                 // "safe" | "mutating" | "destructive"
    "classifiedBy": "same-origin-link",
    "status": "verified",            // "verified" | "unexplored" | "sampled" | "blocked" | "failed"
    "blockedReason": null,
    "lastVerifiedAt": "…",
    "invalidatedAt": "…"             // present only after `invalidate`
  }],

  "entrypoints": ["s0"],

  "coverage": {
    "states": 24, "actionsSeen": 118, "executed": 71, "blocked": 12,
    "sampled": 17,                                    // list links capped, see below
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

**`status` is the honesty field.** Only `verified` means the transition was performed and its target
observed. `unexplored` means the edge exists in the UI and policy forbade pressing it. `sampled`
means it is one of many links on the screen pointing at the same templated route, and the crawl
walked `budget.listSamples` of them — the `blockedReason` names the cap and the total. `blocked`
means the crawler could not or would not go there. `failed` means it was tried and did not work, or
`invalidate` downgraded it during use.

Sampling is why a twenty-row list does not cost twenty replays. It is a deliberate cap, recorded on
every skipped edge; raise `budget.listSamples` when the rows genuinely lead somewhere different.

**Only `verified` + `safe` transitions are used for routing.** A path containing a mutating step is
not reproducible, so `route` will report no path rather than hand back something that works once.

**`route` is the intended read path.** Loading the whole file into context defeats the point; on a
real app it is large. Query it.

**A screen can appear more than once at the same route.** `/items` with a filter dialog open is a
different node from `/items`. Use `state --route` to see all of them and `kind` to tell them apart.
An app with one global user menu therefore grows one `overlay` node per route; that is accurate, not
duplication.

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
