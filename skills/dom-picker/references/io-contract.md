# I/O Contract

The skill consumes an **input** object and returns an **output** object. The machine-readable
contracts are `input.schema.json` and `output.schema.json` in this directory; this doc is the prose
companion.

## Input (`input.schema.json`)

Assembled by the agent from the browser + repo tools before reasoning about a fix:

- `instruction` — what the user wants fixed about the selected element.
- `page` — `{ url, title, viewport{ width, height, devicePixelRatio } }`.
- `element` — the `PickedElement` payload from `assets/element-picker.js`: `selector`, `tagName`,
  `id`, `className`, `text`, `outerHTML`, `parentHTML`, `rect`, `computedStyle`, `nearbyText`.
- `screenshot` — base64 or data-URL screenshot of the element/page.
- `candidateFiles` — repo files already located, each `{ path, content, reason, score }`.

The agent is not handed this object literally — it *builds* it by driving the tools in the SKILL.md
workflow. The schema defines the shape that reasoning and output must be consistent with.

## Output (`output.schema.json`)

- `summary` — one line describing the fix.
- `confidence` — `low` | `medium` | `high`.
- `diagnosis` — why the element looks wrong and which source construct causes it.
- `candidateFiles` — `[{ path, reason, score }]`, ranked (see `candidate-ranking.md`).
- `changes` — `[{ file, reason, diff }]`, each `diff` a validated unified diff (see `patch-policy.md`).
- `warnings` — risks, ambiguities, unverified assumptions.
- `canAutoApply` — `true` only when confidence is `high`, the diff validated, and the user approved
  (see `safety-policy.md`).

Low confidence is a valid result: fill `diagnosis` + `candidateFiles`, leave `changes` empty or
tentative, and set `canAutoApply: false`.
