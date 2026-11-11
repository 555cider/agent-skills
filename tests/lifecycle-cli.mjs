import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

  // `stop` with no driver behind the session: a bad timeout is refused, and a real one
  // reports that nothing picked the request up instead of hanging or claiming a stop.
  const badTimeout = run(["stop", `--session=${session.sessionPath}`, "--timeout-ms=abc"]);
  assert.equal(badTimeout.status, 2);
  assert.match(badTimeout.stdout + badTimeout.stderr, /positive integer/);
  const unanswered = run(["stop", `--session=${session.sessionPath}`, "--timeout-ms=600"]);
  assert.equal(unanswered.status, 2);
  assert.match(unanswered.stdout + unanswered.stderr, /did not pick up the stop/);
  assert.equal(existsSync(join(dirname(session.sessionPath), "stop-request")), false, "an unanswered stop left its request behind");

  // Options: both --name=value and --name value parse; a typo is refused, not ignored.
  const spaced = run(["queue", "--session", session.sessionPath]);
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.equal(JSON.parse(spaced.stdout.trim()).event, "queue");
  const typo = run(["queue", `--sesion=${session.sessionPath}`]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown option --sesion/);
  const missingValue = run(["claim", "--session", "--consumer=a"]);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /--session requires a value/);
  const pinnedTwice = run(["reload", `--session=${session.sessionPath}`, "--target=x"]);
  assert.equal(pinnedTwice.status, 2);
  assert.match(pinnedTwice.stderr, /already names the target/);

  // claim --wait-ms waits in-process: an empty queue times out, a request that arrives is claimed.
  const waitRoot = mkdtempSync(join(tmpdir(), "dom-picker-cli-wait-"));
  try {
    const waitSession = createSessionManifest({
      artifactRoot: waitRoot,
      sessionId: "wait-session",
      bindingName: "wait-binding",
      target: { ...session.target, targetId: "target-wait" },
    });
    const emptyStarted = Date.now();
    const empty = run(["claim", `--session=${waitSession.sessionPath}`, "--consumer=codex-wait", "--wait-ms=400"]);
    assert.equal(empty.status, 0, empty.stderr);
    const emptyEvent = JSON.parse(empty.stdout.trim());
    assert.deepEqual([emptyEvent.payload.claimed, emptyEvent.payload.timedOut], [false, true]);
    assert.ok(Date.now() - emptyStarted >= 350, "claim --wait-ms returned before its wait");
    const badWait = run(["claim", `--session=${waitSession.sessionPath}`, "--consumer=codex-wait", "--wait-ms=soon"]);
    assert.equal(badWait.status, 2);

    const waitingStarted = Date.now();
    const waiting = new Promise((done) => {
      const child = spawn(process.execPath, [DRIVER, "claim", `--session=${waitSession.sessionPath}`, "--consumer=codex-wait", "--wait-ms=8000"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("close", (status) => done({ status, stdout }));
    });
    await new Promise((done) => setTimeout(done, 300));
    commitQueuedRequest(waitSession.sessionPath, {
      protocolVersion: 2,
      protocolRevision: 1,
      event: "request",
      sessionId: waitSession.sessionId,
      target: waitSession.target,
      connection: { port: 9222, targetId: "target-wait", worldName: "dom-picker-v2" },
      payload: {
        requestId: "late-request",
        instruction: "fix it",
        picks: [{ pickId: "pick-late" }],
        provenance: { channel: "isolated-picker", trustedUserEvent: true, trusted: true },
        artifacts: {},
        receivedAt: "2026-08-02T00:00:01.000Z",
      },
    });
    const waited = await waiting;
    assert.equal(waited.status, 0);
    const waitedEvent = JSON.parse(waited.stdout.trim());
    assert.deepEqual([waitedEvent.payload.claimed, waitedEvent.payload.timedOut, waitedEvent.payload.entry.requestId], [true, false, "late-request"]);
    assert.ok(Date.now() - waitingStarted < 6000, "claim --wait-ms did not return when work arrived");
  } finally {
    rmSync(waitRoot, { recursive: true, force: true });
  }

  const help = run(["help"]);
  assert.match(help.stdout, /stop --session/);
  assert.match(help.stdout, /queue --session/);
  assert.match(help.stdout, /resume --session/);
  assert.match(help.stdout, /cancel --request/);
  assert.match(help.stdout, /find --text=TEXT/);
  assert.match(help.stdout, /snapshot <selector>.*--session=PATH/);
  process.stdout.write("PASS lifecycle CLI JSON contracts\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
