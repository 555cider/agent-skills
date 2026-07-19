# DOM Picker v2

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

The driver stays alive and emits JSON Lines. In the browser, press `Alt+Shift+S`, select the target,
describe the change, and send it. Each accepted request is saved atomically with a before screenshot.

For a selector already identified by the agent, create the same evidence bundle from the trusted
chat instruction:

```bash
node scripts/dom-picker.mjs snapshot '[data-testid="save-action"]' \
  --instruction-file=/tmp/trusted-chat.txt --port=9222 --target=<target-id>
```

Map the request to source and verify after the edit:

```bash
node scripts/locate-source.mjs --repo=/path/to/repo --input=/tmp/.../request.json
node scripts/dom-picker.mjs verify --request=/tmp/.../request.json --assertions=assertions.json
```

## What changed in v2

- A named CDP isolated world and random binding keep the trusted panel bridge out of page scripts.
- The picker UI lives in a closed Shadow DOM and survives hostile application CSS and DOM removal.
- One long-running session restores selection and draft state across reloads and reconnects.
- Picks include locator ladders, accessibility, layout, overflow, pseudo-style, matched CSS, and
  React hints.
- Source location is deterministic and confidence-gated.
- Completion requires target reacquisition, assertions, and before/after render evidence.
- Target selection fails closed; there is no implicit first-tab fallback.

The picker is always transient browser state. It is never imported into the target application.
See [SKILL.md](SKILL.md) for the full workflow and `references/` for protocol, safety, source-location,
and verification contracts.
