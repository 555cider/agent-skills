import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPORT = fileURLToPath(new URL("../scripts/locator-report.mjs", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "dom-picker-report-test-"));

function result(session, request, status, candidates, changed) {
  const directory = join(root, session, `request-${request}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "fix-result.json"), JSON.stringify({
    status,
    confidence: status === "applied_verified" ? "high" : "medium",
    candidates: candidates.map(([path, score]) => ({ path, score, signalFamilies: ["text", "class"] })),
    changes: changed.map((file) => ({ file, reason: "fix" })),
  }));
}

function run(...args) {
  const out = spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8" });
  return { status: out.status, json: out.status === 0 ? JSON.parse(out.stdout) : null, stderr: out.stderr };
}

try {
  result("session-a", "000001", "applied_verified", [["src/Card.tsx", 0.93], ["src/List.tsx", 0.4]], ["src/Card.tsx"]);
  result("session-a", "000002", "applied_verified", [["src/Nav.tsx", 0.86]], [`${root}/repo/src/Header.tsx`]);
  result("session-b", "000001", "applied_verified", [["src/Button.tsx", 0.84]], ["/work/repo/src/Button.tsx"]);
  result("session-b", "000002", "review_required", [["src/Modal.tsx", 0.61]], []);
  mkdirSync(join(root, "session-b", "request-000003"), { recursive: true });
  writeFileSync(join(root, "session-b", "request-000003", "fix-result.json"), "{not json");

  const { status, json } = run(root);
  assert.equal(status, 0);
  assert.equal(json.results, 4, "unreadable results are skipped, not counted");
  assert.deepEqual(json.byStatus, { applied_verified: 3, review_required: 1 });
  assert.equal(json.labeled, 3, "only applied edits carry an outcome");
  assert.deepEqual(json.unreadable.length, 1);

  const bins = Object.fromEntries(json.bins.map((bin) => [bin.range, bin]));
  assert.deepEqual(Object.keys(bins), ["0.80-0.90", "0.90-1.00"]);
  assert.equal(bins["0.80-0.90"].n, 2);
  assert.equal(bins["0.80-0.90"].hits, 1, "an absolute changed path matches its relative candidate");
  assert.equal(bins["0.90-1.00"].hits, 1);
  assert.equal(bins["0.90-1.00"].sufficient, false);
  const [lo, hi] = bins["0.80-0.90"].ci95;
  assert.ok(lo > 0 && lo < 0.5 && hi > 0.5 && hi < 1, "Wilson interval brackets the observed rate");

  assert.equal(json.misses.length, 1);
  assert.equal(json.misses[0].top, "src/Nav.tsx");
  assert.match(json.note, /not calibration/);

  const empty = mkdtempSync(join(tmpdir(), "dom-picker-report-empty-"));
  const none = run(empty);
  rmSync(empty, { recursive: true, force: true });
  assert.equal(none.status, 0);
  assert.equal(none.json.results, 0);
  assert.deepEqual(none.json.bins, []);

  assert.equal(run().status, 2, "an artifact directory is required");
  process.stdout.write("locator report: ok\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
