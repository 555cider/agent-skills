import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PROTOCOL_VERSION = 2;
export const PROTOCOL_REVISION = 1;
export const CAPABILITIES = Object.freeze([
  "durable-fifo",
  "status-sync",
  "cancel-request",
  "frame-selection-v2",
]);

export const ACTIVE_STATES = new Set(["claimed", "locating", "editing", "verifying", "cancel_requested"]);
export const FINAL_STATES = new Set(["applied_verified", "no_change", "cancelled", "review_required", "blocked"]);
const STATUS_STATES = new Set([...ACTIVE_STATES, ...FINAL_STATES]);
const TRANSITIONS = {
  claimed: new Set(["locating", "cancel_requested", "cancelled", "review_required", "blocked"]),
  locating: new Set(["editing", "cancel_requested", "cancelled", "no_change", "review_required", "blocked"]),
  editing: new Set(["verifying", "cancel_requested", "cancelled", "review_required", "blocked"]),
  verifying: new Set(["cancel_requested", "applied_verified", "no_change", "cancelled", "review_required", "blocked"]),
  cancel_requested: new Set(["cancelled", "review_required", "blocked"]),
};

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function inside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sessionRoot(sessionPath) {
  const absolute = realpathSync(resolve(sessionPath));
  if (basename(absolute) !== "session.json") throw new Error("session path must name session.json");
  return { sessionPath: absolute, root: dirname(absolute) };
}

function requestContext(requestPath) {
  const absolute = realpathSync(resolve(requestPath));
  if (basename(absolute) !== "request.json") throw new Error("request path must name request.json");
  const directory = dirname(absolute);
  const root = dirname(directory);
  const sessionPath = join(root, "session.json");
  if (!existsSync(sessionPath)) throw new Error("request is not inside a DOM Picker session");
  const session = loadSessionManifest(sessionPath);
  if (!inside(realpathSync(session.artifactRoot), absolute)) throw new Error("request escaped the session artifact root");
  return { requestPath: absolute, directory, sessionPath, session };
}

function requestDirectories(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^request-\d{6}-/.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
}

function optionalJson(path) {
  if (!existsSync(path)) return null;
  try { return readJson(path); }
  catch { return null; }
}

function entryFor(directory) {
  const requestPath = join(directory, "request.json");
  if (!existsSync(requestPath)) return null;
  const request = readJson(requestPath);
  const claim = optionalJson(join(directory, "claim.json"));
  const status = optionalJson(join(directory, "status.json"));
  const cancellation = optionalJson(join(directory, "cancel.json"));
  const state = status?.state || (cancellation ? (claim ? "cancel_requested" : "cancelled") : claim ? "claimed" : "queued");
  return {
    sequence: Number(request.payload?.queueSequence || 0),
    requestId: request.payload?.requestId || "",
    requestPath,
    directory,
    state,
    cancelRequested: !!cancellation,
    ...(claim ? { claim } : {}),
    ...(status ? { status } : {}),
    ...(cancellation ? { cancellation } : {}),
  };
}

export function createSessionManifest({ artifactRoot, sessionId, target, bindingName, armOnStart = false }) {
  if (!artifactRoot || !sessionId || !target?.targetId || !bindingName) throw new Error("session manifest fields are incomplete");
  const root = resolve(artifactRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const sessionPath = join(root, "session.json");
  const now = new Date().toISOString();
  const session = {
    protocolVersion: PROTOCOL_VERSION,
    protocolRevision: PROTOCOL_REVISION,
    capabilities: [...CAPABILITIES],
    sessionId: String(sessionId),
    bindingName: String(bindingName),
    armOnStart: !!armOnStart,
    target: { ...target },
    artifactRoot: root,
    sessionPath,
    createdAt: now,
    updatedAt: now,
  };
  atomicJson(sessionPath, session);
  return session;
}

export function loadSessionManifest(path) {
  const { sessionPath, root } = sessionRoot(path);
  const session = readJson(sessionPath);
  if (session.protocolVersion !== PROTOCOL_VERSION || session.protocolRevision !== PROTOCOL_REVISION) {
    throw new Error("unsupported DOM Picker session protocol");
  }
  if (realpathSync(resolve(session.artifactRoot)) !== root) throw new Error("session artifact root does not match its location");
  return session;
}

export function writeUiState(sessionPath, state) {
  const session = loadSessionManifest(sessionPath);
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("ui state must be an object");
  atomicJson(join(session.artifactRoot, "ui-state.json"), state);
  return state;
}

export function readUiState(sessionPath) {
  const session = loadSessionManifest(sessionPath);
  return optionalJson(join(session.artifactRoot, "ui-state.json"));
}

export function commitQueuedRequest(sessionPath, requestRecord) {
  const session = loadSessionManifest(sessionPath);
  const requestId = requestRecord?.payload?.requestId;
  if (!requestId || requestRecord.sessionId !== session.sessionId) throw new Error("request does not belong to the session");
  const targetMatches = requestRecord.protocolVersion === PROTOCOL_VERSION
    && Number(requestRecord.protocolRevision) === PROTOCOL_REVISION
    && requestRecord.target?.targetId === session.target.targetId
    && requestRecord.target?.allowedOrigin === session.target.allowedOrigin
    && Number(requestRecord.target?.debugPort) === Number(session.target.debugPort)
    && requestRecord.connection?.targetId === session.target.targetId
    && Number(requestRecord.connection?.port) === Number(session.target.debugPort)
    && requestRecord.connection?.worldName === "dom-picker-v2";
  if (!targetMatches) throw new Error("request target does not match the session");
  const existing = listQueue(sessionPath).entries.find((entry) => entry.requestId === requestId);
  if (existing) return existing;
  let sequence = listQueue(sessionPath).entries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 1;
  let directory;
  while (true) {
    directory = join(session.artifactRoot, `request-${String(sequence).padStart(6, "0")}-${safeFilePart(requestId)}`);
    try {
      mkdirSync(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      sequence += 1;
    }
  }
  const requestPath = join(directory, "request.json");
  const stored = {
    ...requestRecord,
    protocolRevision: PROTOCOL_REVISION,
    payload: {
      ...requestRecord.payload,
      queueSequence: sequence,
      artifacts: { ...(requestRecord.payload.artifacts || {}), directory },
    },
  };
  atomicJson(requestPath, stored);
  return entryFor(directory);
}

export function listQueue(sessionPath) {
  const session = loadSessionManifest(sessionPath);
  const entries = requestDirectories(session.artifactRoot).map(entryFor).filter(Boolean)
    .sort((a, b) => a.sequence - b.sequence || a.requestId.localeCompare(b.requestId));
  return { session, entries };
}

export function claimNextRequest(sessionPath, consumer) {
  const consumerId = String(consumer || "").trim();
  if (!consumerId || consumerId.length > 120) throw new Error("consumer must be between 1 and 120 characters");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const queue = listQueue(sessionPath);
    const active = queue.entries.find((entry) => ACTIVE_STATES.has(entry.state));
    if (active) {
      if (active.claim?.consumer === consumerId) return { claimed: true, busy: false, resumed: true, entry: active };
      return { claimed: false, busy: true, resumed: false, entry: active };
    }
    const next = queue.entries.find((entry) => entry.state === "queued");
    if (!next) return { claimed: false, busy: false, resumed: false, entry: null };
    if (existsSync(join(next.directory, "cancel.json")) || existsSync(join(next.directory, "status.json"))) continue;
    const claim = { consumer: consumerId, claimedAt: new Date().toISOString() };
    try {
      writeFileSync(join(next.directory, "claim.json"), `${JSON.stringify(claim, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const claimedEntry = entryFor(next.directory);
      if (claimedEntry.state !== "claimed") continue;
      return { claimed: true, busy: false, resumed: false, entry: claimedEntry };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("could not claim the next request after concurrent updates");
}

export function requestCancellation(requestPath, input) {
  const context = requestContext(requestPath);
  const channel = String(input?.channel || "");
  if (!new Set(["isolated-picker", "trusted-chat"]).has(channel)) {
    throw new Error("cancellation channel must be isolated-picker or trusted-chat");
  }

  const cancellationPath = join(context.directory, "cancel.json");
  const initialEntry = entryFor(context.directory);
  if (FINAL_STATES.has(initialEntry.state)) {
    const existing = optionalJson(cancellationPath);
    return {
      ...(existing || {}),
      accepted: !!existing,
      immediate: initialEntry.state === "cancelled",
      state: initialEntry.state,
    };
  }
  let cancellation = optionalJson(cancellationPath);
  if (!cancellation) {
    const requestedAt = new Date().toISOString();
    cancellation = { channel, requestedAt };
    try {
      writeFileSync(cancellationPath, `${JSON.stringify(cancellation, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(cancellationPath, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      cancellation = readJson(cancellationPath);
    }
  }

  const entry = entryFor(context.directory);
  if (entry.status && FINAL_STATES.has(entry.status.state)) {
    return { ...cancellation, accepted: false, immediate: entry.state === "cancelled", state: entry.state };
  }

  if (entry.claim) {
    if (entry.status?.state !== "cancel_requested") {
      recordRequestStatus(context.requestPath, {
        state: "cancel_requested",
        message: "Cancellation requested",
      });
    }
    return { ...cancellation, accepted: true, immediate: false, state: "cancel_requested" };
  }

  const status = {
    state: "cancelled",
    message: "Cancelled before the agent claimed it",
    resultPath: null,
    updatedAt: cancellation.requestedAt,
    history: [{
      state: "cancelled",
      at: cancellation.requestedAt,
      message: "Cancelled before the agent claimed it",
    }],
  };
  atomicJson(join(context.directory, "status.json"), status);
  return { ...cancellation, accepted: true, immediate: true, state: "cancelled" };
}

export function recordRequestStatus(requestPath, input) {
  const context = requestContext(requestPath);
  const state = String(input?.state || "");
  if (!STATUS_STATES.has(state) || state === "claimed") throw new Error(`unsupported request state: ${JSON.stringify(state)}`);
  const message = input?.message == null ? "" : String(input.message);
  if (message.length > 240) throw new Error("status message must be at most 240 characters");
  if (/\r|\n/.test(message)) throw new Error("status message must be a single line");
  const queueEntry = entryFor(context.directory);
  if (!queueEntry.claim) throw new Error("request must be claimed before recording status");
  if (state === "cancelled" && !queueEntry.cancellation) throw new Error("cancelled requires a durable cancellation request");
  const current = queueEntry.status?.state || "claimed";
  if (FINAL_STATES.has(current)) throw new Error(`request is already final: ${current}`);
  if (!TRANSITIONS[current]?.has(state)) throw new Error(`invalid request state transition: ${current} -> ${state}`);

  let cancellation = null;
  if (state === "cancelled") {
    const editStarted = (queueEntry.status?.history || []).some((entry) => entry.state === "editing" || entry.state === "verifying");
    const supplied = input?.cancellation;
    if (supplied != null && (typeof supplied !== "object" || Array.isArray(supplied))) {
      throw new Error("cancelled cancellation proof must be an object");
    }
    if (supplied?.changesRemain === true) throw new Error("cancelled requires no changes to remain");
    if (editStarted && (supplied?.changesRemain !== false || supplied?.rollbackCompleted !== true)) {
      throw new Error("cancelled after editing requires a complete safe rollback with no changes remaining");
    }
    cancellation = {
      requested: true,
      changesRemain: false,
      rollbackCompleted: editStarted ? true : supplied?.rollbackCompleted === true,
    };
  }

  let resultPath = null;
  if (input?.resultPath != null) {
    const absoluteResult = realpathSync(resolve(input.resultPath));
    if (!inside(realpathSync(context.directory), absoluteResult)) throw new Error("resultPath must stay inside the request directory");
    resultPath = absoluteResult;
  }
  if (state === "applied_verified" && !resultPath) throw new Error("applied_verified requires resultPath");

  const at = new Date().toISOString();
  const history = [...(queueEntry.status?.history || []), {
    state,
    at,
    ...(message ? { message } : {}),
    ...(resultPath ? { resultPath } : {}),
    ...(cancellation ? { cancellation } : {}),
  }];
  const status = {
    state,
    message,
    resultPath,
    updatedAt: at,
    history,
    ...(cancellation ? { cancellation } : {}),
  };
  atomicJson(join(context.directory, "status.json"), status);
  return status;
}
