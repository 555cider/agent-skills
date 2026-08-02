import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { commitQueuedRequest, createSessionManifest } from "../scripts/session-ledger.mjs";

const DRIVER = fileURLToPath(new URL("../scripts/dom-picker.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "dom-picker-cli-test-"));

function run(args, input = undefined) {
  return spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf8", input });
}

try {
  const session = createSessionManifest({
    artifactRoot: root,
    sessionId: "cli-session",
    bindingName: "cli-binding",
    target: {
      targetId: "target-cli",
      title: "CLI fixture",
      url: "http://127.0.0.1:3000/",
      allowedOrigin: "http://127.0.0.1:3000",
      debugPort: 9222,
    },
  });
  const committed = commitQueuedRequest(session.sessionPath, {
    protocolVersion: 2,
    protocolRevision: 1,
    event: "request",
    sessionId: session.sessionId,
    target: session.target,
    connection: { port: 9222, targetId: "target-cli", worldName: "dom-picker-v2" },
    payload: {
      requestId: "cli-request",
      instruction: "fix it",
      picks: [{ pickId: "pick-cli" }],
      provenance: { channel: "isolated-picker", trustedUserEvent: true, trusted: true },
      artifacts: {},
      receivedAt: "2026-08-02T00:00:00.000Z",
    },
  });

  const queue = run(["queue", `--session=${session.sessionPath}`]);
  assert.equal(queue.status, 0, queue.stderr);
  const queueEvent = JSON.parse(queue.stdout.trim());
  assert.equal(queueEvent.event, "queue");
  assert.equal(queueEvent.payload.entries[0].requestId, "cli-request");

  const claim = run(["claim", `--session=${session.sessionPath}`, "--consumer=codex-cli"]);
  assert.equal(claim.status, 0, claim.stderr);
  const claimEvent = JSON.parse(claim.stdout.trim());
  assert.equal(claimEvent.event, "claim");
  assert.equal(claimEvent.payload.claimed, true);
  assert.equal(claimEvent.payload.entry.requestPath, committed.requestPath);

  const locating = run(
    ["status", `--request=${committed.requestPath}`, "--input=-"],
    JSON.stringify({ state: "locating", message: "Finding source" }),
  );
  assert.equal(locating.status, 0, locating.stderr);
  const statusEvent = JSON.parse(locating.stdout.trim());
  assert.equal(statusEvent.event, "request_status");
  assert.equal(statusEvent.payload.state, "locating");
  assert.equal(statusEvent.payload.browserSynced, false);

  const invalidInput = join(root, "invalid-status.json");
  writeFileSync(invalidInput, JSON.stringify({ state: "teleporting" }));
  const invalid = run(["status", `--request=${committed.requestPath}`, `--input=${invalidInput}`]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unsupported request state/);

  const cancel = run(["cancel", `--request=${committed.requestPath}`, "--channel=trusted-chat"]);
  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelEvent = JSON.parse(cancel.stdout.trim());
  assert.equal(cancelEvent.event, "cancel_request");
  assert.equal(cancelEvent.payload.state, "cancel_requested");
  assert.equal(cancelEvent.payload.immediate, false);

  const cancelled = run(
    ["status", `--request=${committed.requestPath}`, "--input=-"],
    JSON.stringify({ state: "cancelled", message: "Stopped before editing" }),
  );
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const help = run(["help"]);
  assert.match(help.stdout, /queue --session/);
  assert.match(help.stdout, /resume --session/);
  assert.match(help.stdout, /cancel --request/);
  assert.match(help.stdout, /find --text=TEXT/);
  assert.match(help.stdout, /snapshot <selector>.*--session=PATH/);
  process.stdout.write("PASS lifecycle CLI JSON contracts\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
