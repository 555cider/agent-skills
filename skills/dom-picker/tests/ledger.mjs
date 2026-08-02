import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITIES,
  claimNextRequest,
  commitQueuedRequest,
  createSessionManifest,
  listQueue,
  loadSessionManifest,
  readUiState,
  recordRequestStatus,
  requestCancellation,
  writeUiState,
} from "../scripts/session-ledger.mjs";

const root = mkdtempSync(join(tmpdir(), "dom-picker-ledger-test-"));

function requestRecord(id, receivedAt) {
  return {
    protocolVersion: 2,
    protocolRevision: 1,
    event: "request",
    sessionId: "session-a",
    target: { targetId: "target-a", allowedOrigin: "http://127.0.0.1:3000", debugPort: 9222 },
    connection: { port: 9222, targetId: "target-a", worldName: "dom-picker-v2" },
    payload: {
      requestId: id,
      instruction: `fix ${id}`,
      picks: [{ pickId: `pick-${id}` }],
      provenance: { channel: "isolated-picker", trustedUserEvent: true, trusted: true },
      artifacts: {},
      receivedAt,
    },
  };
}

try {
  const session = createSessionManifest({
    artifactRoot: root,
    sessionId: "session-a",
    bindingName: "binding-a",
    armOnStart: true,
    target: {
      targetId: "target-a",
      title: "Fixture",
      url: "http://127.0.0.1:3000/settings",
      allowedOrigin: "http://127.0.0.1:3000",
      debugPort: 9222,
    },
  });

  assert.equal(session.protocolVersion, 2);
  assert.equal(session.protocolRevision, 1);
  assert.deepEqual(session.capabilities, CAPABILITIES);
  assert.equal(loadSessionManifest(session.sessionPath).sessionId, "session-a");

  writeUiState(session.sessionPath, { draft: "keep this", armed: true, picks: [] });
  assert.deepEqual(readUiState(session.sessionPath), { draft: "keep this", armed: true, picks: [] });

  const wrongTargetRequest = requestRecord("wrong-target", "2026-08-01T23:59:59.000Z");
  wrongTargetRequest.target.targetId = "target-other";
  assert.throws(
    () => commitQueuedRequest(session.sessionPath, wrongTargetRequest),
    /target does not match the session/,
  );

  const committed = [
    commitQueuedRequest(session.sessionPath, requestRecord("request-a", "2026-08-02T00:00:00.000Z")),
    commitQueuedRequest(session.sessionPath, requestRecord("request-b", "2026-08-02T00:00:01.000Z")),
    commitQueuedRequest(session.sessionPath, requestRecord("request-c", "2026-08-02T00:00:02.000Z")),
    commitQueuedRequest(session.sessionPath, requestRecord("request-d", "2026-08-02T00:00:03.000Z")),
    commitQueuedRequest(session.sessionPath, requestRecord("request-e", "2026-08-02T00:00:04.000Z")),
  ];
  assert.deepEqual(committed.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(listQueue(session.sessionPath).entries.map((entry) => entry.requestId), ["request-a", "request-b", "request-c", "request-d", "request-e"]);

  const firstClaim = claimNextRequest(session.sessionPath, "codex-a");
  assert.equal(firstClaim.claimed, true);
  assert.equal(firstClaim.busy, false);
  assert.equal(firstClaim.entry.requestId, "request-a");
  assert.equal(firstClaim.resumed, false);

  const idempotentClaim = claimNextRequest(session.sessionPath, "codex-a");
  assert.equal(idempotentClaim.claimed, true);
  assert.equal(idempotentClaim.entry.requestId, "request-a");
  assert.equal(idempotentClaim.resumed, true);

  const blockedClaim = claimNextRequest(session.sessionPath, "codex-b");
  assert.deepEqual({ claimed: blockedClaim.claimed, busy: blockedClaim.busy }, { claimed: false, busy: true });

  const resultPath = join(committed[0].directory, "fix-result.json");
  writeFileSync(resultPath, "{}\n", { mode: 0o600 });
  recordRequestStatus(committed[0].requestPath, { state: "locating", message: "Locating source" });
  recordRequestStatus(committed[0].requestPath, { state: "editing", message: "Applying the minimal patch" });
  recordRequestStatus(committed[0].requestPath, { state: "verifying", message: "Checking the rendered target" });
  const completed = recordRequestStatus(committed[0].requestPath, {
    state: "applied_verified",
    message: "Verified in Chromium",
    resultPath,
  });
  assert.equal(completed.state, "applied_verified");
  assert.equal(completed.history.length, 4);
  const completedCancellation = requestCancellation(committed[0].requestPath, { channel: "isolated-picker" });
  assert.equal(completedCancellation.accepted, false);
  assert.equal(existsSync(join(committed[0].directory, "cancel.json")), false, "final requests must not gain cancellation markers");

  const secondClaim = claimNextRequest(session.sessionPath, "codex-b");
  assert.equal(secondClaim.claimed, true);
  assert.equal(secondClaim.entry.requestId, "request-b");

  const cancellationRequested = requestCancellation(committed[1].requestPath, { channel: "isolated-picker" });
  assert.equal(cancellationRequested.state, "cancel_requested");
  assert.equal(cancellationRequested.immediate, false);
  const cancellationRepeated = requestCancellation(committed[1].requestPath, { channel: "isolated-picker" });
  assert.equal(cancellationRepeated.requestedAt, cancellationRequested.requestedAt, "cancel must be idempotent");
  const cancelledActive = recordRequestStatus(committed[1].requestPath, {
    state: "cancelled",
    message: "Stopped before editing",
  });
  assert.equal(cancelledActive.state, "cancelled");

  const thirdClaim = claimNextRequest(session.sessionPath, "codex-c");
  assert.equal(thirdClaim.entry.requestId, "request-c");

  assert.throws(
    () => recordRequestStatus(committed[2].requestPath, { state: "locating", message: "first line\nsecond line" }),
    /single line/,
  );
  assert.throws(
    () => recordRequestStatus(committed[2].requestPath, { state: "locating", message: "x".repeat(241) }),
    /240 characters/,
  );
  const outsideResult = join(root, "outside-result.json");
  writeFileSync(outsideResult, "{}\n", { mode: 0o600 });
  assert.throws(
    () => recordRequestStatus(committed[2].requestPath, { state: "blocked", resultPath: outsideResult }),
    /inside the request directory/,
  );
  recordRequestStatus(committed[2].requestPath, { state: "locating", message: "Locating source" });
  recordRequestStatus(committed[2].requestPath, { state: "editing", message: "Applying a scoped patch" });
  requestCancellation(committed[2].requestPath, { channel: "isolated-picker" });
  assert.throws(
    () => recordRequestStatus(committed[2].requestPath, { state: "cancelled", message: "Rolled back" }),
    /complete safe rollback/,
  );
  const rolledBack = recordRequestStatus(committed[2].requestPath, {
    state: "cancelled",
    message: "Rolled back the session change",
    cancellation: { changesRemain: false, rollbackCompleted: true },
  });
  assert.deepEqual(rolledBack.cancellation, { requested: true, changesRemain: false, rollbackCompleted: true });

  const cancelledQueued = requestCancellation(committed[3].requestPath, { channel: "isolated-picker" });
  assert.equal(cancelledQueued.state, "cancelled");
  assert.equal(cancelledQueued.immediate, true);
  writeFileSync(join(committed[4].directory, "cancel.json"), JSON.stringify({ channel: "isolated-picker", requestedAt: "2026-08-02T00:00:05.000Z" }));
  assert.equal(listQueue(session.sessionPath).entries[4].state, "cancelled", "an unclaimed durable cancel marker must be crash-safe final state");
  const emptyClaim = claimNextRequest(session.sessionPath, "codex-c");
  assert.deepEqual({ claimed: emptyClaim.claimed, busy: emptyClaim.busy }, { claimed: false, busy: false });

  mkdirSync(join(root, "request-incomplete"));
  assert.equal(listQueue(session.sessionPath).entries.length, 5, "incomplete request directories must not enter the queue");

  const stored = JSON.parse(readFileSync(committed[0].requestPath, "utf8"));
  assert.equal(stored.payload.queueSequence, 1);
  process.stdout.write("PASS durable FIFO session ledger\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
