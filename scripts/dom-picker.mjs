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
  process.stdout.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, event, ...extra, payload })}\n`);
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
    let screenshotData = null;
    if (captureScreenshot) {
      try {
        const screenshot = await connection.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
        screenshotData = screenshot.data || null;
      } catch { /* screenshot remains optional evidence */ }
    }
    return { pick: enriched, screenshotData };
  } finally {
    connection.close();
  }
}

class PickerSession {
  constructor({ port, target, arm, artifactRoot, owned }) {
    this.port = port;
    this.target = target;
    this.armOnStart = arm;
    this.sessionId = randomUUID();
    this.artifactRoot = privateArtifactRoot(artifactRoot, this.sessionId);
    this.owned = owned || null;
    this.bindingName = `__domPickerEmit_${this.sessionId.replace(/-/g, "")}`;
    this.allowedOrigin = urlOrigin(target.url);
    this.connection = null;
    this.contexts = new Map();
    this.frames = new Map();
    this.styleSheets = new Map();
    this.topFrameId = null;
    this.topWorldContextId = null;
    this.savedState = { armed: arm, panelOpen: false, draft: "", picks: [] };
    this.requests = new Set();
    this.stopping = false;
    this.heartbeatTimer = null;
    this.heartbeatRunning = false;
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

  async start() {
    mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 });
    await this.attach();
    this.heartbeatTimer = setInterval(() => { void this.tickHeartbeat(); }, 1500);
    this.line("ready", { artifactRoot: this.artifactRoot, mode: "isolated", armed: this.armOnStart });
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
    this.styleSheets.clear();
    const connection = new CdpConnection(this.target.webSocketDebuggerUrl);
    this.connection = connection;
    connection.on("Runtime.executionContextCreated", ({ context }) => {
      this.contexts.set(context.id, context);
      if (context.name === WORLD_NAME && context.auxData?.frameId === this.topFrameId) this.topWorldContextId = context.id;
    });
    connection.on("Runtime.executionContextDestroyed", ({ executionContextId }) => this.contexts.delete(executionContextId));
    connection.on("Runtime.executionContextsCleared", () => {
      this.contexts.clear();
      this.topWorldContextId = null;
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
    this.topWorldContextId = Array.from(this.contexts.values())
      .find((context) => context.name === WORLD_NAME && context.auxData?.frameId === this.topFrameId)?.id || null;
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
    if (this.topWorldContextId) {
      await evaluate(connection, `globalThis.__domPicker&&globalThis.__domPicker._host.restore(${JSON.stringify(this.savedState)})`, this.topWorldContextId);
      await this.heartbeat();
    }
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

  async heartbeat() {
    const connection = this.connection;
    if (!connection) return;
    await Promise.all(this.isolatedContexts().map(async (context) => {
      try { await evaluate(connection, "globalThis.__domPicker&&globalThis.__domPicker._host.heartbeat()", context.id); }
      catch { /* context may be navigating */ }
    }));
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
    if (envelope.protocolVersion !== PROTOCOL_VERSION || envelope.sessionId !== this.sessionId) {
      this.line("rejected", { reason: "protocol or session mismatch" });
      return;
    }
    const context = this.contexts.get(params.executionContextId);
    const frameId = context?.auxData?.frameId || null;
    if (envelope.event === "ready") {
      if (envelope.frame?.isTop) {
        this.topWorldContextId = params.executionContextId;
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.restore(${JSON.stringify(this.savedState)})`, params.executionContextId);
      } else if (this.savedState.armed) {
        await evaluate(this.connection, "globalThis.__domPicker&&globalThis.__domPicker.arm({multi:false})", params.executionContextId);
      }
      await evaluate(this.connection, "globalThis.__domPicker&&globalThis.__domPicker._host.heartbeat()", params.executionContextId);
      this.line("runtime_ready", { frameId, url: envelope.frame?.url || "", isTop: !!envelope.frame?.isTop });
      return;
    }
    if (envelope.event === "state") {
      if (envelope.frame?.isTop) this.savedState = envelope.payload;
      return;
    }
    if (envelope.event === "pick") {
      const pick = { ...envelope.payload.pick, frameId };
      if (!envelope.frame?.isTop && this.topWorldContextId) {
        await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.ingestPick(${JSON.stringify(pick)})`, this.topWorldContextId);
      }
      this.line("pick", { pickId: pick.pickId, frameId, label: `${pick.tagName}${pick.accessibleName ? ` · ${pick.accessibleName}` : ""}` });
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
    const requestDirectory = join(this.artifactRoot, `request-${safeFilePart(requestId)}`);
    mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
    let screenshotPath = null;
    try {
      const screenshot = await this.connection.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
      screenshotPath = join(requestDirectory, "before.png");
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
    } catch (error) {
      diagnostic(`screenshot capture failed for ${requestId}: ${error.message}`);
    }
    const requestRecord = {
      protocolVersion: PROTOCOL_VERSION,
      event: "request",
      sessionId: this.sessionId,
      target: this.targetEnvelope(),
      connection: { port: this.port, targetId: this.target.id, worldName: WORLD_NAME },
      payload: {
        ...payload,
        picks: enrichedPicks,
        provenance: { ...payload.provenance, trusted: true, contextId, frameId },
        artifacts: { directory: requestDirectory, beforeScreenshot: screenshotPath },
        receivedAt: new Date().toISOString(),
      },
    };
    const requestPath = join(requestDirectory, "request.json");
    atomicJson(requestPath, requestRecord);
    const ackContext = this.topWorldContextId || contextId;
    await evaluate(this.connection, `globalThis.__domPicker&&globalThis.__domPicker._host.ack(${JSON.stringify(requestId)})`, ackContext);
    this.line("request", {
      requestId,
      requestPath,
      pickCount: enrichedPicks.length,
      artifacts: requestRecord.payload.artifacts,
      provenance: {
        channel: requestRecord.payload.provenance.channel,
        trustedUserEvent: requestRecord.payload.provenance.trustedUserEvent,
        trusted: requestRecord.payload.provenance.trusted,
      },
    });
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
  const frameTree = await connection.send("Page.getFrameTree");
  await delay(150);
  const frames = extractFrameTree(frameTree.frameTree);
  const worlds = Array.from(contexts.values()).filter((context) => context.name === WORLD_NAME);
  const topWorld = worlds.find((context) => context.auxData?.frameId === frameTree.frameTree.frame.id);
  if (!topWorld) fail("dom-picker isolated world is not available; keep start/attach running during verification");
  const currentPicks = [];
  for (const pick of requestRecord.payload?.picks || []) {
    let world = worlds.find((context) => context.auxData?.frameId === pick.frameId);
    if (!world && pick.frame?.url) {
      const matchingFrames = Array.from(frames.values()).filter((frame) => frame.url === pick.frame.url);
      if (matchingFrames.length === 1) world = worlds.find((context) => context.auxData?.frameId === matchingFrames[0].id);
    }
    if (!world && pick.frame?.isTop !== false) world = topWorld;
    if (!world) {
      currentPicks.push(null);
      continue;
    }
    const result = await evaluate(connection, `globalThis.__domPicker&&globalThis.__domPicker._host.reacquire(${JSON.stringify(pick)})`, world.id);
    currentPicks.push(result.result?.value || null);
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
  try {
    const screenshot = await connection.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    afterScreenshot = join(requestDirectory, "after.png");
    writeFileSync(afterScreenshot, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
  } catch { /* screenshot remains optional evidence */ }
  const result = {
    protocolVersion: PROTOCOL_VERSION,
    event: "verification",
    sessionId: requestRecord.sessionId,
    target: requestRecord.target,
    payload: {
      requestId: requestRecord.payload?.requestId,
      targetReacquired: currentPicks.every(Boolean),
      picks: currentPicks,
      assertions: evaluated,
      targetedAudit: currentPicks.map((pick) => pick ? pick.metrics : null),
      beforeScreenshot: requestRecord.payload?.artifacts?.beforeScreenshot || null,
      afterScreenshot,
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
  const existingWorld = Array.from(contexts.values()).find((context) => context.name === WORLD_NAME && context.auxData?.frameId === frameTree.frameTree.frame.id)
    || Array.from(contexts.values()).find((context) => context.name === WORLD_NAME);
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
      "usage: node dom-picker.mjs <start <url> | attach | targets | snapshot <selector> | reload | verify | destroy>\n" +
      "  start <url> [--arm] [--headless] [--no-sandbox] [--port=0] [--user-data-dir=PATH] [--artifacts=DIR]\n" +
      "  attach [--target=ID|--match=TEXT] [--port=9222] [--arm] [--artifacts=DIR]\n" +
      "  targets [--port=9222]\n" +
      "  snapshot <selector> [--instruction-file=PATH|-] [--artifacts=DIR] [--target=ID|--match=TEXT] [--port=9222]\n" +
      "  reload [--ignore-cache] [--target=ID|--match=TEXT] [--port=9222]\n" +
      "  verify --request=PATH --assertions=PATH|-\n" +
      "  destroy [--target=ID|--match=TEXT] [--port=9222]\n"
    );
    process.exit(0);
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
  if (command === "snapshot" || command === "destroy") {
    const port = parsePort(option("port", "9222"));
    const target = await chooseTarget(port, { targetId: option("target", null), match: option("match", null) });
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
      const sessionId = captured.runtimeSessionId || randomUUID();
      const requestId = randomUUID();
      const artifactRoot = privateArtifactRoot(option("artifacts", null), sessionId);
      const requestDirectory = join(artifactRoot, `request-${safeFilePart(requestId)}`);
      mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
      let beforeScreenshot = null;
      if (enriched.screenshotData) {
        beforeScreenshot = join(requestDirectory, "before.png");
        writeFileSync(beforeScreenshot, Buffer.from(enriched.screenshotData, "base64"), { mode: 0o600 });
      }
      const targetRecord = { ...targetSummary(target), allowedOrigin: urlOrigin(target.url), debugPort: port };
      const provenance = { channel: "trusted-chat", trustedUserEvent: false, trusted: false };
      const requestRecord = {
        protocolVersion: PROTOCOL_VERSION,
        event: "request",
        sessionId,
        target: targetRecord,
        connection: { port, targetId: target.id, worldName: WORLD_NAME },
        payload: {
          requestId,
          instruction,
          picks: [enriched.pick],
          provenance,
          artifacts: { directory: requestDirectory, beforeScreenshot },
          receivedAt: new Date().toISOString(),
        },
      };
      const requestPath = join(requestDirectory, "request.json");
      atomicJson(requestPath, requestRecord);
      emit("request", { requestId, requestPath, pickCount: 1, artifacts: requestRecord.payload.artifacts, provenance }, { sessionId, target: targetRecord });
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
