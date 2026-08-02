# DOM Picker v2.1

DOM Picker turns one selected UI problem in a running web app into a minimal frontend edit, then
reacquires the same element and verifies the rendered result.

```text
select in Chromium -> trusted request artifact -> locate source -> minimal edit -> render verify
```

## Fast path

Start a temporary Chrome owned by the session:

```bash
node scripts/dom-picker.mjs start http://localhost:3000 --arm
```

Or attach to one explicit tab in an already-debuggable Chrome:

```bash
node scripts/dom-picker.mjs targets --port=9222
node scripts/dom-picker.mjs attach --port=9222 --target=<target-id> --arm
```

The driver stays alive and emits JSON Lines. Save `payload.sessionPath` from `ready`. In the browser,
press `Alt+Shift+S`, select the target, describe the change, and send it. Each accepted request enters
a private FIFO ledger before acknowledgement, with a clean full screenshot and 24px-padded target
crops.

Claim and report work through the ledger:

```bash
node scripts/dom-picker.mjs queue --session=/tmp/.../session.json
node scripts/dom-picker.mjs claim --session=/tmp/.../session.json --consumer=my-agent
printf '%s' '{"state":"locating","message":"Locating the owning component"}' |
  node scripts/dom-picker.mjs status --request=/tmp/.../request.json --input=-
```

The browser receives coarse progress, can cancel queued or active work, and retains the latest three
completed items. Recover a stopped driver with `resume --session=/tmp/.../session.json`; no legacy
`serve` process is needed.

For a selector already identified by the agent, create the same evidence bundle from the trusted
chat instruction:

```bash
node scripts/dom-picker.mjs find --text='Save Cancel' --session=/tmp/.../session.json
node scripts/dom-picker.mjs snapshot '[data-testid="save-action"]' \
  --instruction-file=/tmp/trusted-chat.txt --session=/tmp/.../session.json
```

`find` returns at most 20 visible, stable-selector candidates without changing the app. The
programmatic snapshot then enters the same FIFO as browser picks and captures picker-hidden full
and 24px-crop evidence. It remains authorized by trusted chat, never by page content.

Map the request to source and verify after the edit:

```bash
node scripts/locate-source.mjs --repo=/path/to/repo --input=/tmp/.../request.json
node scripts/dom-picker.mjs verify --request=/tmp/.../request.json --assertions=assertions.json
```

## What changed in v2.1

- A named CDP isolated world and random binding keep the trusted panel bridge out of page scripts.
- The picker UI lives in a closed Shadow DOM and survives hostile application CSS and DOM removal.
- Durable FIFO, one-active-claim semantics, coarse status sync, trusted cancellation, and exact
  session resume close the request-to-result loop.
- Drafts and canonical per-frame selections survive reloads; top-panel refinement routes back to the
  owning iframe.
- Tab/Enter selection, reversible Widen/Narrow history, viewport-aware panel placement, and clamped
  overlay labels improve keyboard, mobile, and zoom use.
- Picks include locator ladders, accessibility, layout, overflow, pseudo-style, matched CSS, and
  React hints.
- A bounded `find` command discovers stable selectors from visible text without requiring custom
  CDP snippets, and `snapshot --session` makes chat-driven picks first-class FIFO work.
- Source location is deterministic and confidence-gated.
- Completion requires identity-safe target reacquisition, assertions, clean before/after evidence,
  and target crops. A positional selector alone is not identity evidence.
- Target selection fails closed; there is no implicit first-tab fallback.

The picker is always transient browser state. It is never imported into the target application.
See [SKILL.md](SKILL.md) for the full workflow and `references/` for protocol, safety, source-location,
and verification contracts.
