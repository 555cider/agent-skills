#!/usr/bin/env node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVE_STATES,
  CAPABILITIES,
  FINAL_STATES,
  PROTOCOL_REVISION,
  claimNextRequest,
  commitQueuedRequest,
  createSessionManifest,
  listQueue,
  loadSessionManifest,
  readUiState,
  recordRequestStatus,
  requestCancellation,
  writeUiState,
} from "./session-ledger.mjs";

const PROTOCOL_VERSION = 2;
const WORLD_NAME = "dom-picker-v2";
const COMMAND_TIMEOUT_MS = 12_000;
const MAX_INSTRUCTION_LENGTH = 2_000;
const RUNTIME_PATH = fileURLToPath(new URL("../assets/picker-runtime.js", import.meta.url));
const RUNTIME_SOURCE = readFileSync(RUNTIME_PATH, "utf8");
const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);
const positionals = rest.filter((item) => !item.startsWith("--"));
const hasFlag = (name) => rest.includes(`--${name}`);
const option = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const match = rest.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
};
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function emit(event, payload = {}, extra = {}) {
  process.stdout.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, protocolRevision: PROTOCOL_REVISION, event, ...extra, payload })}\n`);
}

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code = 2) {
  diagnostic(`dom-picker: ${message}`);
  emit("error", { message });
  process.exit(code);
}

function parsePort(raw, { allowZero = false } = {}) {
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65535) {
    fail(`invalid port ${JSON.stringify(raw)}; expected ${minimum}..65535`);
  }
  return value;
}

function chromeBinary() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates = process.platform === "win32"
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        `${process.env.LOCALAPPDATA || ""}/Google/Chrome/Application/chrome.exe`,
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function listTargets(port) {
  const targets = await fetchJson(`${baseUrl(port)}/json`);
  if (!Array.isArray(targets)) throw new Error("debug endpoint returned a non-array target list");
  return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

function targetSummary(target) {
  return { targetId: target.id, title: target.title || "", url: target.url || "", type: target.type };
}

function browserSafeStatusMessage(value) {
  const firstLine = String(value || "").split(/\r?\n/, 1)[0].trim().slice(0, 240);
  if (!firstLine) return "";
  if (/^(?:diff --git|@@|---\s|\+\+\+\s|[+-]\s)/.test(firstLine)) return "Progress details hidden";
  return firstLine.replace(/\S*[\\/]\S*/g, "[details hidden]");
}

function browserJob(entry) {
  const state = entry.state;
  return {
    requestId: entry.requestId,
    sequence: entry.sequence,
    state,
    message: browserSafeStatusMessage(entry.status?.message),
    cancellable: state === "queued" || (ACTIVE_STATES.has(state) && state !== "cancel_requested"),
    final: FINAL_STATES.has(state),
    updatedAt: entry.status?.updatedAt || entry.claim?.claimedAt || null,
  };
}

async function syncBrowserJobsForRequest(requestPath) {
  let connection = null;
  try {
    const absoluteRequestPath = resolve(requestPath);
    const sessionPath = join(dirname(dirname(absoluteRequestPath)), "session.json");
    const queue = listQueue(sessionPath);
    const request = readJsonInput(absoluteRequestPath);
    const port = Number(request.connection?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const target = await chooseTarget(port, { targetId: request.connection?.targetId });
    if (urlOrigin(target.url) !== queue.session.target.allowedOrigin) return false;
    connection = new CdpConnection(target.webSocketDebuggerUrl);
    const contexts = new Map();
    connection.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
    await connection.ready;
    await connection.send("Runtime.enable");
    await connection.send("Page.enable");
    const frameTree = await connection.send("Page.getFrameTree");
    await delay(100);
    const world = await installedWorld(connection, contexts, frameTree.frameTree.frame.id);
    if (!world) return false;
    const sessionCheck = await evaluate(connection, "globalThis.__domPicker&&globalThis.__domPicker.sessionId||null", world.id);
    if (sessionCheck.result?.value !== queue.session.sessionId) return false;
    const jobs = queue.entries.map(browserJob);
    const synced = await evaluate(
      connection,
      `globalThis.__domPicker&&globalThis.__domPicker._host.syncJobs(${JSON.stringify(jobs)})`,
      world.id,
    );
    return synced.result?.value === true;
  } catch {
    return false;
  } finally {
    connection?.close();
  }
}

async function chooseTarget(port, { targetId, match, preferredUrl } = {}) {
  const pages = await listTargets(port);
  let matches = pages;
  if (targetId) matches = pages.filter((page) => page.id === targetId);
  else if (match) matches = pages.filter((page) => `${page.url || ""}\n${page.title || ""}`.includes(match));
  else if (preferredUrl) {
    matches = pages.filter((page) => page.url === preferredUrl || page.url.startsWith(preferredUrl));
  }
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? "no targets matched" : `${matches.length} targets matched`;
    const available = pages.map(targetSummary);
    throw new Error(`${reason}; select exactly one with --target=<id> or --match=<text>. Available: ${JSON.stringify(available)}`);
  }
  return matches[0];
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.opened = false;
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.closed = new Promise((resolveClosed) => { this.resolveClosed = resolveClosed; });
    this.socket.addEventListener("open", () => {
      this.opened = true;
      this.resolveReady();
    }, { once: true });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("error", () => this.disconnect("error"));
    this.socket.addEventListener("close", () => this.disconnect("closed"));
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); }
    catch { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && this.listeners.has(message.method)) {
      for (const handler of this.listeners.get(message.method)) {
        try { handler(message.params || {}); }
        catch (error) { diagnostic(`event handler failed for ${message.method}: ${error.message}`); }
      }
    }
  }

  disconnect(kind) {
    const error = new Error(`CDP WebSocket ${kind}`);
    if (!this.opened) this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.resolveClosed) {
      this.resolveClosed(error);
      this.resolveClosed = null;
    }
  }

  send(method, params = {}) {
    return new Promise((resolveSend, rejectSend) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        rejectSend(new Error("CDP WebSocket is not open"));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectSend(error);
      }
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

function evaluate(connection, expression, contextId, returnByValue = true) {
  return connection.send("Runtime.evaluate", {
    expression,
    ...(contextId ? { contextId } : {}),
    returnByValue,
    awaitPromise: true,
    userGesture: false,
  });
}

async function installedWorld(connection, contexts, frameId = null) {
  const candidates = Array.from(contexts.values())
    .filter((context) => context.name === WORLD_NAME && (!frameId || context.auxData?.frameId === frameId))
    .sort((a, b) => b.id - a.id);
  for (const context of candidates) {
    try {
      const installed = await evaluate(connection, "!!(globalThis.__domPicker&&globalThis.__domPicker.__installed)", context.id);
      if (installed.result?.value) return context;
    } catch { /* stale or blank named world */ }
  }
  return null;
}

async function setPickerCaptureMode(connection, contextIds, hidden) {
  const ids = [...new Set(contextIds.filter(Boolean))];
  const results = await Promise.all(ids.map(async (contextId) => {
    try {
      const result = await evaluate(connection, `globalThis.__domPicker&&globalThis.__domPicker._host.setCaptureMode(${hidden ? "true" : "false"})`, contextId);
      return result.result?.value === true;
    } catch {
      return false;
    }
  }));
  return { requested: ids.length, updated: results.filter(Boolean).length };
}

async function frameOwnerOffset(connection, frameId, topFrameId) {
  if (!frameId || frameId === topFrameId) return { x: 0, y: 0 };
  try {
    const owner = await connection.send("DOM.getFrameOwner", { frameId });
    const model = await connection.send("DOM.getBoxModel", {
      ...(owner.backendNodeId ? { backendNodeId: owner.backendNodeId } : { nodeId: owner.nodeId }),
    });
    const content = model.model?.content || [];
    return content.length >= 2 ? { x: content[0], y: content[1] } : { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

async function captureCleanEvidence(connection, picks, topFrameId, contextIds, padding = 24) {
  const evidence = { fullData: null, crops: [], pickerHidden: false, padding };
  const hidden = await setPickerCaptureMode(connection, contextIds, true);
  evidence.pickerHidden = hidden.requested > 0 && hidden.updated === hidden.requested;
  try {
    await delay(32);
    try {
      const screenshot = await connection.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      evidence.fullData = screenshot.data || null;
    } catch { /* full screenshot remains optional evidence */ }
    let viewport = null;
    try {
      const metrics = await connection.send("Page.getLayoutMetrics");
      viewport = metrics.cssVisualViewport || metrics.visualViewport || null;
    } catch { /* crops remain optional */ }
    for (const pick of picks || []) {
      const rect = pick?.rect;
      if (!viewport || !rect || rect.width <= 0 || rect.height <= 0) {
        evidence.crops.push(null);
        continue;
      }
      const offset = await frameOwnerOffset(connection, pick.frameId, topFrameId);
      const pageX = Number(viewport.pageX || 0);
      const pageY = Number(viewport.pageY || 0);
      const viewportRight = pageX + Number(viewport.clientWidth || 0);
      const viewportBottom = pageY + Number(viewport.clientHeight || 0);
      const targetX = pageX + offset.x + Number(rect.left ?? rect.x ?? 0);
      const targetY = pageY + offset.y + Number(rect.top ?? rect.y ?? 0);
      const x = Math.max(pageX, targetX - padding);
      const y = Math.max(pageY, targetY - padding);
      const right = Math.min(viewportRight, targetX + Number(rect.width) + padding);
      const bottom = Math.min(viewportBottom, targetY + Number(rect.height) + padding);
      if (right - x < 1 || bottom - y < 1) {
        evidence.crops.push(null);
        continue;
      }
      try {
        const crop = await connection.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x, y, width: right - x, height: bottom - y, scale: 1 },
        });
        evidence.crops.push({ data: crop.data || null, clip: { x, y, width: right - x, height: bottom - y, padding } });
      } catch {
        evidence.crops.push(null);
      }
    }
  } finally {
    await setPickerCaptureMode(connection, contextIds, false);
  }
  return evidence;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function privateArtifactRoot(requestedRoot, sessionId) {
  if (!requestedRoot) return mkdtempSync(join(tmpdir(), "dom-picker-session-"));
  const artifactBase = resolve(requestedRoot);
  mkdirSync(artifactBase, { recursive: true });
  const root = join(artifactBase, `session-${safeFilePart(sessionId)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
}

function urlOrigin(url) {
  try { return new URL(url).origin; }
  catch { return "null"; }
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolveWait) => {
    const onExit = () => { clearTimeout(timer); resolveWait(true); };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveWait(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function cleanupOwnedChrome(owned) {
  if (!owned) return;
  if (owned.child && owned.child.exitCode == null && owned.child.signalCode == null) {
    try { owned.child.kill("SIGTERM"); } catch { /* already exited */ }
    if (!(await waitForChildExit(owned.child, 2500))) {
      try { owned.child.kill("SIGKILL"); } catch { /* already exited */ }
      await waitForChildExit(owned.child, 1000);
    }
  }
  if (owned.removeProfile) {
    for (let attempt = 0; attempt < 5 && existsSync(owned.profile); attempt += 1) {
      try { rmSync(owned.profile, { recursive: true, force: true }); } catch { /* retry after file handles close */ }
      if (existsSync(owned.profile)) await delay(100);
    }
  }
}

function bootstrapSource({ sessionId, bindingName, allowedOrigin, armOnStart, shadowMode = "closed" }) {
  const pickerConfig = { mode: "isolated", sessionId, bindingName, allowedOrigin, armOnStart, shadowMode };
  return `globalThis.__DOM_PICKER_CONFIG__=${JSON.stringify(pickerConfig)};\n${RUNTIME_SOURCE}`;
}

async function launchOwnedChrome(url) {
  const binary = chromeBinary();
  if (!binary) fail("Chrome/Chromium not found; set CHROME=/path/to/chrome");
  const requestedPort = parsePort(option("port", "0"), { allowZero: true });
  const providedProfile = option("user-data-dir", null);
  const profile = providedProfile ? resolve(providedProfile) : mkdtempSync(join(tmpdir(), "dom-picker-v2-"));
  const args = [
    `--remote-debugging-port=${requestedPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
  ];
  if (hasFlag("headless")) args.push("--headless=new", "--disable-gpu");
  if (hasFlag("no-sandbox")) args.push("--no-sandbox");
  args.push(url);
  const child = spawn(binary, args, { stdio: "ignore" });
  const deadline = Date.now() + 20_000;
  let port = requestedPort || null;
  while (Date.now() < deadline) {
    if (!port) {
      const activePortFile = join(profile, "DevToolsActivePort");
      if (existsSync(activePortFile)) {
        const firstLine = readFileSync(activePortFile, "utf8").split(/\r?\n/)[0];
        port = Number(firstLine);
      }
    }
    if (port) {
      try {
        await fetchJson(`${baseUrl(port)}/json/version`);
        return { child, port, profile, removeProfile: !providedProfile };
      } catch { /* keep waiting */ }
    }
    if (child.exitCode != null) {
      await cleanupOwnedChrome({ child, profile, removeProfile: !providedProfile });
      fail(`Chrome exited before the debug endpoint was ready (code ${child.exitCode})`);
    }
    await delay(100);
  }
  await cleanupOwnedChrome({ child, profile, removeProfile: !providedProfile });
  fail("Chrome debug endpoint did not become ready within 20 seconds");
}

function extractFrameTree(frameTree) {
  const frames = new Map();
  function visit(node, parentId = null) {
    if (!node || !node.frame) return;
    frames.set(node.frame.id, { ...node.frame, parentId });
    for (const child of node.childFrames || []) visit(child, node.frame.id);
  }
  visit(frameTree);
  return frames;
}

async function collectReactHints(connection, selector, contextId) {
  if (!selector || !contextId) return [];
  const expression = `(function(){
    var el;try{el=document.querySelector(${JSON.stringify(selector)});}catch(_){return []}
    if(!el)return [];
    var key=Object.keys(el).find(function(k){return k.indexOf('__reactFiber$')===0||k.indexOf('__reactInternalInstance$')===0});
    var fiber=key&&el[key],out=[],seen={};
    for(var i=0;fiber&&i<24;i++,fiber=fiber.return){
      var type=fiber.type,name=typeof type==='string'?type:(type&&(type.displayName||type.name))||null;
      var source=fiber._debugSource||null;
      var token=String(name||'')+'|'+String(source&&source.fileName||'')+'|'+String(source&&source.lineNumber||'');
      if((name||source)&&!seen[token]){seen[token]=1;out.push({component:name,fileName:source&&source.fileName||null,lineNumber:source&&source.lineNumber||null,columnNumber:source&&source.columnNumber||null});}
    }
    return out.slice(0,12);
  })()`;
  try {
    const result = await evaluate(connection, expression, contextId);
    return result.result?.value || [];
  } catch {
    return [];
  }
}

async function collectMatchedStyles(connection, selector, styleSheets) {
  if (!selector) return [];
  try {
    const documentNode = await connection.send("DOM.getDocument", { depth: -1, pierce: true });
    const query = await connection.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector });
    if (!query.nodeId) return [];
    const matched = await connection.send("CSS.getMatchedStylesForNode", { nodeId: query.nodeId });
    return (matched.matchedCSSRules || []).filter((entry) => entry.rule?.origin !== "user-agent").slice(-16).map((entry) => {
      const rule = entry.rule || {};
      const style = rule.style || {};
      const header = styleSheets.get(rule.styleSheetId) || {};
      return {
        selectorText: rule.selectorList?.text || "",
        sourceUrl: header.sourceURL || "",
        styleSheetId: rule.styleSheetId || null,
        range: style.range || null,
        properties: (style.cssProperties || []).filter((property) => property.name && property.value && !property.disabled)
          .slice(0, 40).map((property) => ({ name: property.name, value: property.value, important: !!property.important })),
      };
    });
  } catch {
    return [];
  }
}

async function enrichSnapshot(target, pick, captureScreenshot) {
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  const contexts = new Map();
  const styleSheets = new Map();
  connection.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  connection.on("CSS.styleSheetAdded", ({ header }) => styleSheets.set(header.styleSheetId, header));
  try {
    await connection.ready;
    await connection.send("Runtime.enable");
    await connection.send("Page.enable");
    await connection.send("DOM.enable");
    await connection.send("CSS.enable");
    const tree = await connection.send("Page.getFrameTree");
    await delay(100);
    const topFrameId = tree.frameTree.frame.id;
    const defaultContext = Array.from(contexts.values())
      .find((context) => context.auxData?.frameId === topFrameId && context.auxData?.isDefault);
    const locator = (pick.locators || []).find((item) => item.unique && item.selector) || (pick.locators || [])[0];
    const enriched = {
      ...pick,
      frameId: topFrameId,
      sourceHints: {
        react: await collectReactHints(connection, locator?.selector, defaultContext?.id),
        matchedStyles: await collectMatchedStyles(connection, locator?.selector, styleSheets),
      },
    };
    let capturedEvidence = { fullData: null, crops: [], pickerHidden: false, padding: 24 };
    if (captureScreenshot) {
      const captureContextIds = [];
      for (const frameId of extractFrameTree(tree.frameTree).keys()) {
        const world = await installedWorld(connection, contexts, frameId);
        if (world) captureContextIds.push(world.id);
      }
      capturedEvidence = await captureCleanEvidence(connection, [enriched], topFrameId, captureContextIds, 24);
    }
    return { pick: enriched, capturedEvidence };
  } finally {
    connection.close();
  }
}

function persistBeforeEvidence(requestPath, capturedEvidence) {
  const requestDirectory = dirname(resolve(requestPath));
  let beforeScreenshot = null;
  if (capturedEvidence.fullData) {
    beforeScreenshot = join(requestDirectory, "before.png");
    writeFileSync(beforeScreenshot, Buffer.from(capturedEvidence.fullData, "base64"), { mode: 0o600 });
  }
  const beforeTargetCrops = capturedEvidence.crops.map((crop, index) => {
    if (!crop?.data) return null;
    const cropPath = join(requestDirectory, `before-pick-${index + 1}.png`);
    writeFileSync(cropPath, Buffer.from(crop.data, "base64"), { mode: 0o600 });
    return cropPath;
  });
  const storedRecord = readJsonInput(requestPath);
  storedRecord.payload.artifacts = {
    ...(storedRecord.payload.artifacts || {}),
    directory: requestDirectory,
    beforeScreenshot,
    beforeTargetCrops,
    targetCropClips: capturedEvidence.crops.map((crop) => crop?.clip || null),
    pickerHidden: capturedEvidence.pickerHidden,
    cropPadding: capturedEvidence.padding,
  };
  atomicJson(requestPath, storedRecord);
  return storedRecord;
}

class PickerSession {
  constructor({ port, target, arm, artifactRoot, owned, resumeSession = null }) {
    this.port = port;
    this.target = target;
    this.resumed = !!resumeSession;
    this.armOnStart = this.resumed ? !!resumeSession.armOnStart : !!arm;
    this.sessionId = this.resumed ? resumeSession.sessionId : randomUUID();
    this.artifactRoot = this.resumed ? resumeSession.artifactRoot : privateArtifactRoot(artifactRoot, this.sessionId);
    this.owned = owned || null;
    this.bindingName = this.resumed ? resumeSession.bindingName : `__domPickerEmit_${this.sessionId.replace(/-/g, "")}`;
    this.allowedOrigin = this.resumed ? resumeSession.target.allowedOrigin : urlOrigin(target.url);
    this.connection = null;
    this.contexts = new Map();
    this.frames = new Map();
    this.styleSheets = new Map();
    this.topFrameId = null;
    this.topWorldContextId = null;
    const restoredUi = this.resumed ? readUiState(resumeSession.sessionPath) : null;
    this.savedState = restoredUi
      ? { ...restoredUi, frameStates: undefined }
      : { armed: !!arm, panelOpen: false, draft: "", picks: [] };
    delete this.savedState.frameStates;
    this.frameStates = new Map(Object.entries(restoredUi?.frameStates || {}));
    this.runtimeContextByFrame = new Map();
    this.requests = new Set();
    this.stopping = false;
    this.heartbeatTimer = null;
    this.heartbeatRunning = false;
    this.sessionPath = this.resumed ? resumeSession.sessionPath : null;
  }

  targetEnvelope() {
    return {
      targetId: this.target.id,
      title: this.target.title || "",
      url: this.target.url || "",
      allowedOrigin: this.allowedOrigin,
      debugPort: this.port,
    };
  }

  line(event, payload = {}) {
    emit(event, payload, { sessionId: this.sessionId, target: this.targetEnvelope() });
  }

  persistedUiState() {
    return { ...this.savedState, frameStates: Object.fromEntries(this.frameStates) };
  }

  persistUiState() {
    if (this.sessionPath) writeUiState(this.sessionPath, this.persistedUiState());
  }

  frameStateFor(frameId, url = "") {
    const exact = this.frameStates.get(frameId);
    if (exact) return exact;
    const byUrl = Array.from(this.frameStates.values()).filter((entry) => entry?.url === url);
    return byUrl.length === 1 ? byUrl[0] : null;
  }

  async start() {
    mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
    if (!this.resumed) {
      const session = createSessionManifest({
        artifactRoot: this.artifactRoot,
        sessionId: this.sessionId,
        target: this.targetEnvelope(),
        bindingName: this.bindingName,
        armOnStart: this.armOnStart,
      });
      this.sessionPath = session.sessionPath;
    }
    this.persistUiState();
    await this.attach();
    this.heartbeatTimer = setInterval(() => { void this.tickHeartbeat(); }, 1500);
    this.line("ready", {
      artifactRoot: this.artifactRoot,
      sessionPath: this.sessionPath,
      mode: "isolated",
      armed: this.armOnStart,
      resumed: this.resumed,
      capabilities: [...CAPABILITIES],
    });
    const stop = async (signal) => {
      if (this.stopping) return;
      this.stopping = true;
      clearInterval(this.heartbeatTimer);
      try { await this.destroyRuntime(); } catch { /* page may already be closed */ }
      this.connection?.close();
      await cleanupOwnedChrome(this.owned);
      this.line("stopped", { signal });
      process.exit(0);
    };
    process.once("SIGINT", () => { void stop("SIGINT"); });
    process.once("SIGTERM", () => { void stop("SIGTERM"); });
    await new Promise(() => {});
  }

  async attach() {
    this.contexts.clear();
    this.runtimeContextByFrame.clear();
    this.styleSheets.clear();
    const connection = new CdpConnection(this.target.webSocketDebuggerUrl);
    this.connection = connection;
    connection.on("Runtime.executionContextCreated", ({ context }) => {
      this.contexts.set(context.id, context);
    });
    connection.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
      this.contexts.delete(executionContextId);
      if (this.topWorldContextId === executionContextId) this.topWorldContextId = null;
      for (const [frameId, contextId] of this.runtimeContextByFrame) {
        if (contextId === executionContextId) this.runtimeContextByFrame.delete(frameId);
      }
    });
    connection.on("Runtime.executionContextsCleared", () => {
      this.contexts.clear();
      this.topWorldContextId = null;
      this.runtimeContextByFrame.clear();
    });
    connection.on("CSS.styleSheetAdded", ({ header }) => this.styleSheets.set(header.styleSheetId, header));
    connection.on("Page.frameNavigated", ({ frame }) => {
      this.frames.set(frame.id, frame);
      if (!frame.parentId) {
        this.target.url = frame.url;
        const origin = urlOrigin(frame.url);
        this.line("navigation", { url: frame.url, origin, allowed: origin === this.allowedOrigin });
      }
    });
    connection.on("Runtime.bindingCalled", (params) => {
      void this.onBinding(params).catch((error) => this.line("error", { message: error.message }));
    });
    await connection.ready;
    await connection.send("Runtime.enable");
    await connection.send("Page.enable");
    await connection.send("DOM.enable");
    await connection.send("CSS.enable");
    const tree = await connection.send("Page.getFrameTree");
    this.frames = extractFrameTree(tree.frameTree);
    this.topFrameId = tree.frameTree.frame.id;
    this.topWorldContextId = null;
    await connection.send("Runtime.addBinding", { name: this.bindingName, executionContextName: WORLD_NAME });
    await connection.send("Page.addScriptToEvaluateOnNewDocument", {
      source: bootstrapSource({
        sessionId: this.sessionId,
        bindingName: this.bindingName,
        allowedOrigin: this.allowedOrigin,
        armOnStart: this.armOnStart,
        shadowMode: "closed",
      }),
      worldName: WORLD_NAME,
      runImmediately: true,
    });
    await this.heartbeat();
    connection.closed.then(() => { if (!this.stopping) void this.reconnect(); });
  }

  async reconnect() {
    this.line("disconnected", { message: "CDP connection closed; retrying" });
    while (!this.stopping) {
      await delay(500);
      try {
        const pages = await listTargets(this.port);
        const target = pages.find((page) => page.id === this.target.id);
        if (!target) continue;
        this.target = target;
        await this.attach();
        this.line("reconnected", {});
        return;
      } catch { /* retry */ }
    }
  }

  isolatedContexts() {
    return Array.from(this.contexts.values()).filter((context) => context.name === WORLD_NAME);
  }

  defaultContextForFrame(frameId) {
    return Array.from(this.contexts.values()).find((context) => context.auxData?.frameId === frameId && context.auxData?.isDefault);
  }

  async restoreChildRuntimes() {
    if (!this.connection) return;
    await Promise.all(Array.from(this.runtimeContextByFrame.entries()).map(async ([frameId, contextId]) => {
      if (frameId === this.topFrameId) return;
      const frame = this.frames.get(frameId);
      const saved = this.frameStateFor(frameId, frame?.url || "");
      if (!saved?.state) return;
      try {
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.restore(${JSON.stringify(saved.state)})`, contextId);
      } catch { /* child context may be navigating */ }
    }));
  }

  async heartbeat() {
    const connection = this.connection;
    if (!connection) return;
    await Promise.all(this.isolatedContexts().map(async (context) => {
      try { await evaluate(connection, "globalThis.__domPicker&&globalThis.__domPicker._host.heartbeat()", context.id); }
      catch { /* context may be navigating */ }
    }));
    await this.syncJobs();
  }

  async syncJobs() {
    if (!this.connection || !this.topWorldContextId || !this.sessionPath) return;
    const jobs = listQueue(this.sessionPath).entries.map(browserJob);
    try {
      await evaluate(
        this.connection,
        `globalThis.__domPicker&&globalThis.__domPicker._host.syncJobs(${JSON.stringify(jobs)})`,
        this.topWorldContextId,
      );
    } catch { /* top context may be navigating */ }
  }

  async tickHeartbeat() {
    if (this.heartbeatRunning || this.stopping) return;
    this.heartbeatRunning = true;
    try { await this.heartbeat(); }
    finally { this.heartbeatRunning = false; }
  }

  async onBinding(params) {
    if (params.name !== this.bindingName || !this.connection) return;
    let envelope;
    try { envelope = JSON.parse(params.payload); }
    catch {
      this.line("rejected", { reason: "invalid binding payload" });
      return;
    }
    if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.protocolRevision !== PROTOCOL_REVISION || envelope.sessionId !== this.sessionId) {
      this.line("rejected", { reason: "protocol or session mismatch" });
      return;
    }
    const context = this.contexts.get(params.executionContextId);
    const frameId = context?.auxData?.frameId || null;
    if (envelope.event === "ready") {
      if (frameId) this.runtimeContextByFrame.set(frameId, params.executionContextId);
      if (envelope.frame?.isTop) {
        this.topWorldContextId = params.executionContextId;
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.restore(${JSON.stringify(this.savedState)})`, params.executionContextId);
        await this.restoreChildRuntimes();
      } else {
        const saved = this.frameStateFor(frameId, envelope.frame?.url || "");
        if (saved?.state) {
          await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.restore(${JSON.stringify(saved.state)})`, params.executionContextId);
        } else if (this.savedState.armed) {
          await evaluate(this.connection, "globalThis.__domPicker&&globalThis.__domPicker.arm({multi:false})", params.executionContextId);
        }
      }
      await evaluate(this.connection, "globalThis.__domPicker&&globalThis.__domPicker._host.heartbeat()", params.executionContextId);
      if (envelope.frame?.isTop) await this.syncJobs();
      this.line("runtime_ready", { frameId, url: envelope.frame?.url || "", isTop: !!envelope.frame?.isTop });
      return;
    }
    if (envelope.event === "state") {
      if (envelope.frame?.isTop) {
        this.savedState = envelope.payload;
      } else if (frameId) {
        this.frameStates.set(frameId, { url: envelope.frame?.url || this.frames.get(frameId)?.url || "", state: envelope.payload });
      }
      this.persistUiState();
      return;
    }
    if (envelope.event === "pick") {
      const pick = {
        ...envelope.payload.pick,
        frameId,
        canWiden: envelope.payload.pick?.canWiden !== false,
        canNarrow: !!envelope.payload.pick?.canNarrow,
      };
      if (!envelope.frame?.isTop && this.topWorldContextId) {
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.ingestPick(${JSON.stringify(pick)})`, this.topWorldContextId);
      }
      this.line("pick", { pickId: pick.pickId, frameId, label: `${pick.tagName}${pick.accessibleName ? ` · ${pick.accessibleName}` : ""}` });
      return;
    }
    if (envelope.event === "selection_command") {
      const payload = envelope.payload || {};
      const command = String(payload.command || "");
      const ownerFrameId = String(payload.frameId || "");
      const pickId = String(payload.pickId || "");
      const trusted = envelope.trustedUserEvent === true
        && envelope.frame?.isTop === true
        && frameId === this.topFrameId
        && envelope.frame?.origin === this.allowedOrigin
        && payload.provenance?.channel === "isolated-picker"
        && payload.provenance?.trustedUserEvent === true
        && payload.provenance?.allowedOrigin === this.allowedOrigin;
      const ownerContextId = this.runtimeContextByFrame.get(ownerFrameId);
      if (!trusted || !pickId || ownerFrameId === this.topFrameId || !ownerContextId || !new Set(["widen", "narrow", "remove"]).has(command)) {
        this.line("rejected", { pickId, reason: "selection command did not satisfy frame ownership gates" });
        return;
      }
      const evaluated = await evaluate(
        this.connection,
        `globalThis.__domPicker&&globalThis.__domPicker._host.applySelectionCommand(${JSON.stringify(pickId)},${JSON.stringify(command)})`,
        ownerContextId,
      );
      const result = evaluated.result?.value;
      if (!result?.ok || !this.topWorldContextId) {
        this.line("rejected", { pickId, reason: "selection command target was no longer available" });
        return;
      }
      if (result.removed) {
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.removeIngestedPick(${JSON.stringify(pickId)})`, this.topWorldContextId);
      } else {
        const updatedPick = {
          ...result.pick,
          frameId: ownerFrameId,
          canWiden: !!result.canWiden,
          canNarrow: !!result.canNarrow,
        };
        await evaluate(
          this.connection,
          `globalThis.__domPicker&&globalThis.__domPicker._host.updateIngestedPick(${JSON.stringify(pickId)},${JSON.stringify(updatedPick)})`,
          this.topWorldContextId,
        );
      }
      this.line("selection_command", { pickId, frameId: ownerFrameId, command });
      return;
    }
    if (envelope.event === "cancel_request") {
      const requestId = String(envelope.payload?.requestId || "");
      const trusted = envelope.trustedUserEvent === true
        && envelope.frame?.isTop === true
        && frameId === this.topFrameId
        && envelope.frame?.origin === this.allowedOrigin
        && envelope.payload?.provenance?.channel === "isolated-picker"
        && envelope.payload?.provenance?.trustedUserEvent === true;
      const entry = listQueue(this.sessionPath).entries.find((candidate) => candidate.requestId === requestId);
      if (!trusted || !entry) {
        this.line("rejected", { requestId, reason: "cancellation did not satisfy isolated-world provenance gates" });
        return;
      }
      const cancellation = requestCancellation(entry.requestPath, { channel: "isolated-picker" });
      await this.syncJobs();
      this.line("cancel_request", { requestId, ...cancellation });
      return;
    }
    if (envelope.event === "request") await this.persistRequest(envelope, frameId, params.executionContextId);
  }

  async persistRequest(envelope, frameId, contextId) {
    const payload = envelope.payload || {};
    const requestId = payload.requestId;
    if (!requestId || this.requests.has(requestId)) return;
    const trusted = envelope.trustedUserEvent === true
      && envelope.frame?.isTop === true
      && frameId === this.topFrameId
      && payload.provenance?.channel === "isolated-picker"
      && payload.provenance?.trustedUserEvent === true
      && payload.provenance?.allowedOrigin === this.allowedOrigin
      && envelope.frame?.origin === this.allowedOrigin;
    if (!trusted) {
      this.line("rejected", { requestId, reason: "request did not satisfy isolated-world provenance gates" });
      return;
    }
    if (typeof payload.instruction !== "string" || !payload.instruction.trim() || !Array.isArray(payload.picks) || !payload.picks.length) {
      this.line("rejected", { requestId, reason: "request instruction or picks were invalid" });
      return;
    }
    this.requests.add(requestId);
    const enrichedPicks = [];
    for (const original of payload.picks || []) {
      const pick = { ...original, frameId: original.frameId || frameId };
      const locator = (pick.locators || []).find((item) => item.unique && item.selector) || (pick.locators || [])[0];
      const defaultContext = this.defaultContextForFrame(pick.frameId || frameId);
      pick.sourceHints = {
        react: await collectReactHints(this.connection, locator?.selector, defaultContext?.id),
        matchedStyles: pick.frameId === this.topFrameId ? await collectMatchedStyles(this.connection, locator?.selector, this.styleSheets) : [],
      };
      enrichedPicks.push(pick);
    }
    let capturedEvidence = { fullData: null, crops: [], pickerHidden: false, padding: 24 };
    try {
      capturedEvidence = await captureCleanEvidence(
        this.connection,
        enrichedPicks,
        this.topFrameId,
        Array.from(this.runtimeContextByFrame.values()),
        24,
      );
    } catch (error) {
      diagnostic(`screenshot capture failed for ${requestId}: ${error.message}`);
    }
    const requestRecord = {
      protocolVersion: PROTOCOL_VERSION,
      protocolRevision: PROTOCOL_REVISION,
      event: "request",
      sessionId: this.sessionId,
      target: this.targetEnvelope(),
      connection: { port: this.port, targetId: this.target.id, worldName: WORLD_NAME },
      payload: {
        ...payload,
        picks: enrichedPicks,
        provenance: { ...payload.provenance, trusted: true, contextId, frameId },
        artifacts: {
          directory: null,
          beforeScreenshot: null,
          beforeTargetCrops: [],
          pickerHidden: capturedEvidence.pickerHidden,
          cropPadding: capturedEvidence.padding,
        },
        receivedAt: new Date().toISOString(),
      },
    };
    const committed = commitQueuedRequest(this.sessionPath, requestRecord);
    const requestDirectory = committed.directory;
    const requestPath = committed.requestPath;
    let screenshotPath = null;
    if (capturedEvidence.fullData) {
      screenshotPath = join(requestDirectory, "before.png");
      writeFileSync(screenshotPath, Buffer.from(capturedEvidence.fullData, "base64"), { mode: 0o600 });
    }
    const cropPaths = capturedEvidence.crops.map((crop, index) => {
      if (!crop?.data) return null;
      const cropPath = join(requestDirectory, `before-pick-${index + 1}.png`);
      writeFileSync(cropPath, Buffer.from(crop.data, "base64"), { mode: 0o600 });
      return cropPath;
    });
    const storedRecord = readJsonInput(requestPath);
    storedRecord.payload.artifacts = {
      directory: requestDirectory,
      beforeScreenshot: screenshotPath,
      beforeTargetCrops: cropPaths,
      targetCropClips: capturedEvidence.crops.map((crop) => crop?.clip || null),
      pickerHidden: capturedEvidence.pickerHidden,
      cropPadding: capturedEvidence.padding,
    };
    atomicJson(requestPath, storedRecord);
    const ackContext = this.topWorldContextId || contextId;
    await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.ack(${JSON.stringify(requestId)})`, ackContext);
    this.line("request", {
      requestId,
      requestPath,
      pickCount: enrichedPicks.length,
      artifacts: storedRecord.payload.artifacts,
      provenance: {
        channel: requestRecord.payload.provenance.channel,
        trustedUserEvent: requestRecord.payload.provenance.trustedUserEvent,
        trusted: requestRecord.payload.provenance.trusted,
      },
    });
    await this.syncJobs();
  }

  async destroyRuntime() {
    if (!this.connection) return;
    await Promise.all(this.isolatedContexts().map(async (context) => {
      try { await evaluate(this.connection, "globalThis.__domPicker&&globalThis.__domPicker.destroy()", context.id); }
      catch { /* context already gone */ }
    }));
  }
}

function readJsonInput(path) {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(path), "utf8");
  return JSON.parse(raw);
}

function valueAt(object, dottedPath) {
  return String(dottedPath || "").split(".").filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], object);
}

function compareAssertion(actual, assertion) {
  const operator = assertion.operator || "==";
  const expected = assertion.expected;
  const numericActual = typeof expected === "number" ? Number.parseFloat(actual) : actual;
  if (operator === "==") return String(actual) === String(expected);
  if (operator === "!=") return String(actual) !== String(expected);
  if (operator === ">") return numericActual > expected;
  if (operator === ">=") return numericActual >= expected;
  if (operator === "<") return numericActual < expected;
  if (operator === "<=") return numericActual <= expected;
  if (operator === "contains") return String(actual).includes(String(expected));
  if (operator === "matches") return new RegExp(String(expected)).test(String(actual));
  throw new Error(`unsupported assertion operator: ${operator}`);
}

async function verifyRequest() {
  const requestPath = option("request", null);
  const assertionPath = option("assertions", null);
  if (!requestPath) fail("verify requires --request=<request.json>");
  if (!assertionPath) fail("verify requires --assertions=<assertions.json|->");
  const requestRecord = readJsonInput(requestPath);
  const assertions = readJsonInput(assertionPath);
  if (!Array.isArray(assertions) || !assertions.length) fail("assertions must be a non-empty JSON array");
  const port = parsePort(requestRecord.connection?.port);
  const target = await chooseTarget(port, { targetId: requestRecord.connection?.targetId });
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  const contexts = new Map();
  connection.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  await connection.ready;
  await connection.send("Runtime.enable");
  await connection.send("Page.enable");
  await connection.send("DOM.enable");
  const frameTree = await connection.send("Page.getFrameTree");
  await delay(150);
  const frames = extractFrameTree(frameTree.frameTree);
  const topWorld = await installedWorld(connection, contexts, frameTree.frameTree.frame.id);
  if (!topWorld) fail("dom-picker isolated world is not available; keep start/attach running during verification");
  const currentPicks = [];
  const reacquisitions = [];
  const captureContextIds = new Set([topWorld.id]);
  for (const pick of requestRecord.payload?.picks || []) {
    let world = pick.frameId ? await installedWorld(connection, contexts, pick.frameId) : null;
    if (!world && pick.frame?.url) {
      const matchingFrames = Array.from(frames.values()).filter((frame) => frame.url === pick.frame.url);
      if (matchingFrames.length === 1) world = await installedWorld(connection, contexts, matchingFrames[0].id);
    }
    if (!world && pick.frame?.isTop !== false) world = topWorld;
    if (!world) {
      currentPicks.push(null);
      reacquisitions.push({
        currentPick: null,
        matchedLocator: null,
        identityEvidence: { accepted: false, tagMatches: false, corroborators: [], strongUniqueLocator: false },
        reacquisitionConfidence: "none",
      });
      continue;
    }
    captureContextIds.add(world.id);
    const result = await evaluate(connection, `globalThis.__domPicker&&globalThis.__domPicker._host.reacquire(${JSON.stringify(pick)})`, world.id);
    const value = result.result?.value || null;
    const reacquisition = value?.currentPick !== undefined
      ? value
      : {
          currentPick: value,
          matchedLocator: null,
          identityEvidence: { accepted: !!value, tagMatches: !!value, corroborators: [], strongUniqueLocator: false },
          reacquisitionConfidence: value ? "medium" : "none",
        };
    reacquisitions.push(reacquisition);
    currentPicks.push(reacquisition.currentPick ? { ...reacquisition.currentPick, frameId: pick.frameId || frameTree.frameTree.frame.id } : null);
  }
  const evaluated = assertions.map((assertion) => {
    const pickIndex = Number.isInteger(assertion.pickIndex) ? assertion.pickIndex : 0;
    const current = currentPicks[pickIndex];
    const actual = current ? valueAt(current, assertion.metric) : undefined;
    let passed = false;
    let error = null;
    try { passed = current != null && compareAssertion(actual, assertion); }
    catch (assertionError) { error = assertionError.message; }
    return { ...assertion, actual: actual ?? null, passed, ...(error ? { error } : {}) };
  });
  const requestDirectory = requestRecord.payload?.artifacts?.directory || dirname(resolve(requestPath));
  let afterScreenshot = null;
  let afterTargetCrops = [];
  let afterPickerHidden = false;
  try {
    for (const frameId of frames.keys()) {
      const world = await installedWorld(connection, contexts, frameId);
      if (world) captureContextIds.add(world.id);
    }
    const captured = await captureCleanEvidence(
      connection,
      currentPicks.map((pick, index) => pick || requestRecord.payload?.picks?.[index]),
      frameTree.frameTree.frame.id,
      Array.from(captureContextIds),
      24,
    );
    afterPickerHidden = captured.pickerHidden;
    if (captured.fullData) {
      afterScreenshot = join(requestDirectory, "after.png");
      writeFileSync(afterScreenshot, Buffer.from(captured.fullData, "base64"), { mode: 0o600 });
    }
    afterTargetCrops = captured.crops.map((crop, index) => {
      if (!crop?.data) return null;
      const path = join(requestDirectory, `after-pick-${index + 1}.png`);
      writeFileSync(path, Buffer.from(crop.data, "base64"), { mode: 0o600 });
      return path;
    });
  } catch { /* screenshot remains optional evidence */ }
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    protocolRevision: PROTOCOL_REVISION,
    event: "verification",
    sessionId: requestRecord.sessionId,
    target: requestRecord.target,
    payload: {
      requestId: requestRecord.payload?.requestId,
      targetReacquired: currentPicks.every(Boolean),
      picks: currentPicks,
      reacquisition: reacquisitions,
      assertions: evaluated,
      targetedAudit: currentPicks.map((pick) => pick ? pick.metrics : null),
      beforeScreenshot: requestRecord.payload?.artifacts?.beforeScreenshot || null,
      afterScreenshot,
      afterTargetCrops,
      pickerHidden: afterPickerHidden,
      cropPadding: 24,
      passed: currentPicks.every(Boolean) && evaluated.every((assertion) => assertion.passed),
      verifiedAt: new Date().toISOString(),
    },
  };
  atomicJson(join(requestDirectory, "verification.json"), result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  connection.close();
  process.exit(result.payload.passed ? 0 : 1);
}

async function oneShotRuntime(target, action) {
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  const contexts = new Map();
  connection.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  await connection.ready;
  await connection.send("Runtime.enable");
  await connection.send("Page.enable");
  const frameTree = await connection.send("Page.getFrameTree");
  await delay(100);
  const existingWorld = await installedWorld(connection, contexts, frameTree.frameTree.frame.id)
    || await installedWorld(connection, contexts);
  if (existingWorld) {
    try {
      const installed = await evaluate(connection, "!!(globalThis.__domPicker&&globalThis.__domPicker.__installed)", existingWorld.id);
      if (installed.result?.value) {
        const value = await action(connection, existingWorld.id);
        connection.close();
        return { mode: "isolated", value };
      }
    } catch { /* use the evidence-only main-world fallback */ }
  }
  const sessionId = randomUUID();
  const source = `globalThis.__DOM_PICKER_CONFIG__=${JSON.stringify({ mode: "fallback", sessionId, allowedOrigin: urlOrigin(target.url), shadowMode: "closed" })};\n${RUNTIME_SOURCE}`;
  await evaluate(connection, source, null, false);
  const value = await action(connection, null);
  connection.close();
  return { mode: "fallback", value };
}

async function reloadTarget(target) {
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.ready;
  await connection.send("Page.enable");
  let cancelLoad = () => {};
  const loaded = new Promise((resolveLoaded) => {
    let off = null;
    const timer = setTimeout(() => {
      if (off) off();
      resolveLoaded(false);
    }, COMMAND_TIMEOUT_MS);
    off = connection.on("Page.loadEventFired", () => {
      clearTimeout(timer);
      off();
      resolveLoaded(true);
    });
    cancelLoad = () => {
      clearTimeout(timer);
      if (off) off();
      resolveLoaded(false);
    };
  });
  try {
    await connection.send("Page.reload", { ignoreCache: hasFlag("ignore-cache") });
    if (!(await loaded)) throw new Error("page reload timed out");
  } finally {
    cancelLoad();
    connection.close();
  }
}

async function main() {
  if (!command || command === "help" || hasFlag("help")) {
    process.stdout.write(
      "usage: node dom-picker.mjs <start <url> | attach | resume | queue | claim | status | cancel | targets | find | snapshot <selector> | reload | verify | destroy>\n" +
      "  start <url> [--arm] [--headless] [--no-sandbox] [--port=0] [--user-data-dir=PATH] [--artifacts=DIR]\n" +
      "  attach [--target=ID|--match=TEXT] [--port=9222] [--arm] [--artifacts=DIR]\n" +
      "  resume --session=PATH\n" +
      "  queue --session=PATH\n" +
      "  claim --session=PATH --consumer=ID\n" +
      "  status --request=PATH --input=PATH|-\n" +
      "  cancel --request=PATH --channel=trusted-chat\n" +
      "  targets [--port=9222]\n" +
      "  find --text=TEXT [--limit=20] [--session=PATH] [--target=ID|--match=TEXT] [--port=9222]\n" +
      "  snapshot <selector> [--instruction-file=PATH|-] [--session=PATH|--artifacts=DIR] [--target=ID|--match=TEXT] [--port=9222]\n" +
      "  reload [--ignore-cache] [--target=ID|--match=TEXT] [--port=9222]\n" +
      "  verify --request=PATH --assertions=PATH|-\n" +
      "  destroy [--target=ID|--match=TEXT] [--port=9222]\n"
    );
    process.exit(0);
  }
  if (command === "queue") {
    const sessionPath = option("session", null);
    if (!sessionPath) fail("queue requires --session=<session.json>");
    const queue = listQueue(sessionPath);
    emit("queue", { session: queue.session, entries: queue.entries, capabilities: [...CAPABILITIES] }, { sessionId: queue.session.sessionId, target: queue.session.target });
    return;
  }
  if (command === "claim") {
    const sessionPath = option("session", null);
    const consumer = option("consumer", null);
    if (!sessionPath) fail("claim requires --session=<session.json>");
    if (!consumer) fail("claim requires --consumer=<id>");
    const session = listQueue(sessionPath).session;
    emit("claim", claimNextRequest(sessionPath, consumer), { sessionId: session.sessionId, target: session.target });
    return;
  }
  if (command === "status") {
    const requestPath = option("request", null);
    const inputPath = option("input", null);
    if (!requestPath) fail("status requires --request=<request.json>");
    if (!inputPath) fail("status requires --input=<status.json|->");
    const status = recordRequestStatus(requestPath, readJsonInput(inputPath));
    const browserSynced = await syncBrowserJobsForRequest(requestPath);
    emit("request_status", { ...status, browserSynced });
    return;
  }
  if (command === "cancel") {
    const requestPath = option("request", null);
    const channel = option("channel", null);
    if (!requestPath) fail("cancel requires --request=<request.json>");
    if (channel !== "trusted-chat") fail("cancel requires --channel=trusted-chat; browser cancellation is recorded by the live isolated session");
    const request = readJsonInput(requestPath);
    const cancellation = requestCancellation(requestPath, { channel });
    const browserSynced = await syncBrowserJobsForRequest(requestPath);
    emit("cancel_request", { requestId: request.payload?.requestId || "", ...cancellation, browserSynced }, {
      sessionId: request.sessionId,
      target: request.target,
    });
    return;
  }
  if (command === "targets") {
    const port = parsePort(option("port", "9222"));
    const targets = await listTargets(port);
    emit("targets", { targets: targets.map(targetSummary) });
    return;
  }
  if (command === "start") {
    const url = positionals[0];
    if (!url) fail("start requires a URL");
    const owned = await launchOwnedChrome(url);
    let target;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        target = await chooseTarget(owned.port, { preferredUrl: url });
        break;
      } catch { await delay(150); }
    }
    if (!target) {
      await cleanupOwnedChrome(owned);
      fail(`could not resolve the launched page for ${url}`);
    }
    diagnostic(`dom-picker owns a temporary Chrome profile at ${owned.profile}; it will close with this session`);
    try {
      await new PickerSession({ port: owned.port, target, arm: hasFlag("arm"), artifactRoot: option("artifacts", null), owned }).start();
    } catch (error) {
      await cleanupOwnedChrome(owned);
      throw error;
    }
    return;
  }
  if (command === "attach") {
    const port = parsePort(option("port", "9222"));
    const target = await chooseTarget(port, { targetId: option("target", null), match: option("match", null) });
    await new PickerSession({ port, target, arm: hasFlag("arm"), artifactRoot: option("artifacts", null), owned: null }).start();
    return;
  }
  if (command === "resume") {
    const sessionPath = option("session", null);
    if (!sessionPath) fail("resume requires --session=<session.json>");
    const session = loadSessionManifest(sessionPath);
    const port = parsePort(session.target?.debugPort);
    const target = await chooseTarget(port, { targetId: session.target?.targetId });
    if (urlOrigin(target.url) !== session.target.allowedOrigin) {
      fail(`resume target origin changed from ${JSON.stringify(session.target.allowedOrigin)} to ${JSON.stringify(urlOrigin(target.url))}`);
    }
    await new PickerSession({
      port,
      target,
      arm: false,
      artifactRoot: session.artifactRoot,
      owned: null,
      resumeSession: session,
    }).start();
    return;
  }
  if (command === "verify") {
    await verifyRequest();
    return;
  }
  if (command === "reload") {
    const port = parsePort(option("port", "9222"));
    const target = await chooseTarget(port, { targetId: option("target", null), match: option("match", null) });
    await reloadTarget(target);
    emit("reloaded", { url: target.url, ignoreCache: hasFlag("ignore-cache") }, { target: targetSummary(target) });
    return;
  }
  if (command === "find") {
    const query = option("text", null);
    if (!query?.trim()) fail("find requires --text=<visible text or accessible name>");
    const rawLimit = option("limit", "20");
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("find --limit must be between 1 and 50");
    const sessionPath = option("session", null);
    const session = sessionPath ? loadSessionManifest(sessionPath) : null;
    const port = session ? parsePort(session.target?.debugPort) : parsePort(option("port", "9222"));
    const target = await chooseTarget(port, session
      ? { targetId: session.target?.targetId }
      : { targetId: option("target", null), match: option("match", null) });
    if (session && urlOrigin(target.url) !== session.target.allowedOrigin) {
      fail(`find target origin changed from ${JSON.stringify(session.target.allowedOrigin)} to ${JSON.stringify(urlOrigin(target.url))}`);
    }
    const result = await oneShotRuntime(target, async (connection, contextId) => {
      const found = await evaluate(
        connection,
        `JSON.stringify({runtimeSessionId:globalThis.__domPicker&&globalThis.__domPicker.sessionId||null,candidates:globalThis.__domPicker&&globalThis.__domPicker._host.findCandidates(${JSON.stringify(query.trim())},${limit})||[]})`,
        contextId,
      );
      return found.result?.value ? JSON.parse(found.result.value) : { runtimeSessionId: null, candidates: [] };
    });
    if (session && (result.mode !== "isolated" || result.value.runtimeSessionId !== session.sessionId)) {
      fail("find --session does not match the isolated picker running in the selected target");
    }
    emit("candidates", { query: query.trim(), candidates: result.value.candidates, mode: result.mode }, { target: targetSummary(target) });
    return;
  }
  if (command === "snapshot" || command === "destroy") {
    const snapshotSessionPath = command === "snapshot" ? option("session", null) : null;
    const snapshotSession = snapshotSessionPath ? loadSessionManifest(snapshotSessionPath) : null;
    const port = snapshotSession
      ? parsePort(snapshotSession.target?.debugPort)
      : parsePort(option("port", "9222"));
    const target = await chooseTarget(port, snapshotSession
      ? { targetId: snapshotSession.target?.targetId }
      : { targetId: option("target", null), match: option("match", null) });
    if (snapshotSession && urlOrigin(target.url) !== snapshotSession.target.allowedOrigin) {
      fail(`snapshot target origin changed from ${JSON.stringify(snapshotSession.target.allowedOrigin)} to ${JSON.stringify(urlOrigin(target.url))}`);
    }
    if (command === "snapshot") {
      const selector = positionals[0];
      if (!selector) fail("snapshot requires a CSS selector");
      const runtimeResult = await oneShotRuntime(target, async (connection, contextId) => {
        const evaluated = await evaluate(connection, `JSON.stringify((function(){var matches;try{matches=document.querySelectorAll(${JSON.stringify(selector)})}catch(error){return {matchCount:-1,error:String(error&&error.message||error),pick:null}}return {matchCount:matches.length,runtimeSessionId:globalThis.__domPicker&&globalThis.__domPicker.sessionId||null,pick:matches.length===1&&globalThis.__domPicker?globalThis.__domPicker.snapshot(matches[0],{exact:false,multi:false}):null}})())`, contextId);
        return evaluated.result?.value ? JSON.parse(evaluated.result.value) : null;
      });
      const captured = runtimeResult.value;
      if (!captured || captured.matchCount !== 1 || !captured.pick) {
        const detail = captured?.error || `matched ${captured?.matchCount ?? 0} elements`;
        fail(`snapshot selector must match exactly one usable element (${detail}): ${JSON.stringify(selector)}`);
      }
      const instructionFile = option("instruction-file", null);
      if (instructionFile && runtimeResult.mode !== "isolated") {
        fail("snapshot --instruction-file requires a running start/attach session so the standard verifier remains available");
      }
      if (snapshotSession && captured.runtimeSessionId !== snapshotSession.sessionId) {
        fail("snapshot --session does not match the isolated picker running in the selected target");
      }
      const enriched = await enrichSnapshot(target, captured.pick, !!instructionFile);
      if (!instructionFile) {
        emit("snapshot", { pick: enriched.pick }, { target: targetSummary(target) });
        return;
      }
      let instruction;
      try {
        instruction = (instructionFile === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(instructionFile), "utf8")).trim();
      } catch (error) {
        fail(`could not read --instruction-file: ${error.message}`);
      }
      if (!instruction) fail("--instruction-file must contain a non-empty trusted-chat instruction");
      if (instruction.length > MAX_INSTRUCTION_LENGTH) fail(`instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters`);
      const sessionId = snapshotSession?.sessionId || captured.runtimeSessionId || randomUUID();
      const requestId = randomUUID();
      const targetRecord = {
        targetId: target.id,
        title: target.title || "",
        url: target.url || "",
        allowedOrigin: snapshotSession?.target.allowedOrigin || urlOrigin(target.url),
        debugPort: port,
      };
      const provenance = { channel: "trusted-chat", trustedUserEvent: false, trusted: false };
      const requestRecord = {
        protocolVersion: PROTOCOL_VERSION,
        protocolRevision: PROTOCOL_REVISION,
        event: "request",
        sessionId,
        target: targetRecord,
        connection: { port, targetId: target.id, worldName: WORLD_NAME },
        payload: {
          requestId,
          instruction,
          picks: [enriched.pick],
          provenance,
          artifacts: {
            directory: null,
            beforeScreenshot: null,
            beforeTargetCrops: [],
            pickerHidden: enriched.capturedEvidence.pickerHidden,
            cropPadding: enriched.capturedEvidence.padding,
          },
          receivedAt: new Date().toISOString(),
        },
      };
      let requestPath;
      if (snapshotSession) {
        requestPath = commitQueuedRequest(snapshotSession.sessionPath, requestRecord).requestPath;
      } else {
        const artifactRoot = privateArtifactRoot(option("artifacts", null), sessionId);
        const requestDirectory = join(artifactRoot, `request-${safeFilePart(requestId)}`);
        mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
        requestPath = join(requestDirectory, "request.json");
        requestRecord.payload.artifacts.directory = requestDirectory;
        atomicJson(requestPath, requestRecord);
      }
      const storedRecord = persistBeforeEvidence(requestPath, enriched.capturedEvidence);
      const browserSynced = snapshotSession ? await syncBrowserJobsForRequest(requestPath) : false;
      emit("request", {
        requestId,
        requestPath,
        pickCount: 1,
        artifacts: storedRecord.payload.artifacts,
        provenance,
        browserSynced,
      }, { sessionId, target: targetRecord });
    } else {
      await oneShotRuntime(target, async (connection, contextId) => {
        await evaluate(connection, "globalThis.__domPicker&&globalThis.__domPicker.destroy()", contextId, false);
        return true;
      });
      emit("destroyed", {}, { target: targetSummary(target) });
    }
    return;
  }
  fail(`unknown command ${JSON.stringify(command)}; run 'node dom-picker.mjs help'`);
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));
