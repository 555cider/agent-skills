import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

function request(session, requestId) {
  return {
    protocolVersion: 2,
    protocolRevision: 1,
    event: "request",
    sessionId: session.sessionId,
    target: session.target,
    connection: { port: 9222, targetId: session.target.targetId, worldName: "dom-picker-v2" },
    payload: {
      requestId,
      instruction: "fix it",
      picks: [{ pickId: `pick-${requestId}` }],
      provenance: { channel: "isolated-picker", trustedUserEvent: true, trusted: true },
      artifacts: {},
      receivedAt: "2026-08-02T00:00:00.000Z",
    },
  };
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

  // `stop` with no driver behind the session reports that nothing picked the request up
  // instead of hanging or claiming a stop, and leaves no request behind.
  const unanswered = run(["stop", `--session=${session.sessionPath}`, "--timeout-ms=300"]);
  assert.equal(unanswered.status, 2);
  assert.match(unanswered.stdout + unanswered.stderr, /did not pick up the stop/);
  assert.equal(existsSync(join(dirname(session.sessionPath), "stop-request")), false, "an unanswered stop left its request behind");

  // Options: --name value parses like --name=value; a typo is refused, not ignored.
  const spaced = run(["queue", "--session", session.sessionPath]);
  assert.equal(spaced.status, 0, spaced.stderr);
  assert.equal(JSON.parse(spaced.stdout.trim()).event, "queue");
  const typo = run(["queue", `--sesion=${session.sessionPath}`]);
  assert.equal(typo.status, 2);

  // claim --wait-ms waits in-process: a request that arrives during the wait is claimed.
  const waitingStarted = Date.now();
  const waiting = new Promise((done) => {
    const child = spawn(process.execPath, [DRIVER, "claim", `--session=${session.sessionPath}`, "--consumer=codex-wait", "--wait-ms=8000"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => done({ status, stdout }));
  });
  await new Promise((done) => setTimeout(done, 300));
  commitQueuedRequest(session.sessionPath, request(session, "late-request"));
  const waited = await waiting;
  assert.equal(waited.status, 0);
  const waitedEvent = JSON.parse(waited.stdout.trim());
  assert.deepEqual([waitedEvent.payload.claimed, waitedEvent.payload.timedOut, waitedEvent.payload.entry.requestId], [true, false, "late-request"]);
  assert.ok(Date.now() - waitingStarted < 6000, "claim --wait-ms did not return when work arrived");
  process.stdout.write("PASS lifecycle CLI JSON contracts\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
