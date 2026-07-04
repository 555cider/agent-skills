# I/O Contract

The skill consumes an **input** object and returns an **output** object. The machine-readable
contracts are `input.schema.json` and `output.schema.json` in this directory; this doc is the prose
companion.

## Input (`input.schema.json`)

Assembled by the agent from the browser + repo tools before reasoning about a fix:

- `instruction` — what the user wants fixed about the selected element.
- `page` — `{ url, title, viewport{ width, height, devicePixelRatio } }`.
- `element` — the `PickedElement` payload from `assets/element-picker.js`: `selector`, `tagName`,
  `id`, `className`, `ariaLabel`, `name`, `text` (truncated to 300 chars), `outerHTML` (truncated to
  4000), `parentHTML`, `rect`, `computedStyle`, `nearbyText`, plus the descriptor fields `kind`,
  `detail`, `label`, and `resolvedFromLeaf` (set when a wrapping element was picked instead of a
  clicked icon leaf).
- `screenshot` — base64 or data-URL screenshot of the element/page. Optional: a headless/programmatic
  agent pick (`cdp.mjs pick`) may omit it.
- `candidateFiles` — repo files already located, each `{ path, content, reason, score }`.
- `requests` — optional **batch**: when the picker's `window.__s2p.queue` is drained, each queued
  `{ text, seq, picks }` is normalized into one request entry. The single top-level
  `instruction`/`element` still describe one request on the non-batch path.

Because `text`/`outerHTML` are truncated, a candidate-ranking "exact text match" (see
`candidate-ranking.md`) can only match against the first 300 chars of visible text.

The agent is not handed this object literally — it *builds* it by driving the tools in the SKILL.md
workflow. The schema defines the shape that reasoning and output must be consistent with.

## Queue and batch flow

The browser→host bridge is a **durable queue**, not a single slot: every Send in the picker pushes a
`{ text, picks, seq }` onto `window.__s2p.queue` (`request` aliases the latest for back-compat). The
host **drains the whole queue atomically** — `cdp.mjs serve` for the user's own browser, or a
`browser_evaluate` drain on the Playwright path — so rapid submissions and ones sent while the agent
is busy are never lost. A drain returns `{ requests: [ … ] }`; the agent processes each request
through the normal find-source → diff pipeline, reusing page context and any selector→file mapping
resolved earlier in the session. The **output for a batch is a JSON array** — one object matching
`output.schema.json` per request (see its `definitions.batch`). A single request stays a single
object.

## Output (`output.schema.json`)

- `summary` — one line describing the fix.
- `confidence` — `low` | `medium` | `high`.
- `diagnosis` — why the element looks wrong and which source construct causes it.
- `candidateFiles` — `[{ path, reason, score }]`, ranked (see `candidate-ranking.md`).
- `changes` — `[{ file, reason, diff }]`, each `diff` a validated unified diff (see `patch-policy.md`).
- `warnings` — risks, ambiguities, unverified assumptions.
- `canAutoApply` — `true` only when the current request is authorized and the safe-apply gate holds
  without another prompt (see `safety-policy.md`).
- `applyDecision` — `{ authorizedBy, eligible, applied, reason }`, recording whether authorization
  came from `trusted-chat`, `confirmed-browser-request`, or `none`, and whether the patch was
  actually applied.

Low confidence is a valid result: fill `diagnosis` + `candidateFiles`, leave `changes` empty or
tentative, and set `canAutoApply: false`.
