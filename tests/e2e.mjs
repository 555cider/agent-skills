import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../scripts/dom-picker.mjs", import.meta.url));
const LOCATOR = fileURLToPath(new URL("../scripts/locate-source.mjs", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function findChrome() {
  const names = [
    process.env.CHROME,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);
  for (const name of names) {
    if (name.includes("/") && existsSync(name)) return name;
    const found = spawnSync("which", [name], { encoding: "utf8" });
    if (found.status === 0) return found.stdout.trim();
  }
  return null;
}

function runProcess(command, args, timeout = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, timeout);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
  });
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.history = [];
    this.waiters = [];
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error(`WebSocket failed: ${url}`)), { once: true });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    const entry = { method: message.method, params: message.params || {} };
    this.history.push(entry);
    for (const handler of this.listeners.get(message.method) || []) handler(entry.params);
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method && waiter.predicate(entry.params)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(entry.params);
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, predicate = () => true, timeout = 12_000, fromHistory = false) {
    if (fromHistory) {
      const found = this.history.find((entry) => entry.method === method && predicate(entry.params));
      if (found) return Promise.resolve(found.params);
    }
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

class JsonLineStream {
  constructor(processHandle) {
    this.process = processHandle;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.stderr = "";
    processHandle.stdout.setEncoding("utf8");
    processHandle.stderr.setEncoding("utf8");
    processHandle.stdout.on("data", (chunk) => this.consume(chunk));
    processHandle.stderr.on("data", (chunk) => { this.stderr += chunk; });
  }

  consume(chunk) {
    this.buffer += chunk;
    const pieces = this.buffer.split(/\r?\n/);
    this.buffer = pieces.pop();
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      let value;
      try { value = JSON.parse(piece); }
      catch { continue; }
      this.lines.push(value);
      for (const waiter of [...this.waiters]) {
        if (waiter.event === value.event && waiter.predicate(value)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    }
  }

  waitFor(event, predicate = () => true, timeout = 15_000, includeHistory = true) {
    if (includeHistory) {
      const found = this.lines.find((line) => line.event === event && predicate(line));
      if (found) return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = { event, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for driver event ${event}\n${this.stderr}`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function fixtureHtml() {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>DOM Picker fixture</title>
      <style>
        * { box-sizing: content-box; }
        body { margin: 32px; font: 16px system-ui; }
        .settings-toolbar { display: flex; gap: 0; align-items: center; }
        .toolbar-action { min-height: 1px !important; padding: 10px 14px; background: hotpink !important; }
        dom-picker-v2-host { all: unset !important; display: none !important; width: 1px !important; height: 1px !important; }
        button, textarea { border-radius: 0 !important; font-size: 7px !important; }
      </style>
    </head>
    <body>
      <main>
        <h1>Settings</h1>
        <div class="settings-toolbar" data-testid="settings-toolbar">
          <button id="save" class="toolbar-action primary" data-testid="save-action"><span>Save</span></button>
          <button id="cancel" class="toolbar-action secondary" data-testid="cancel-action">Cancel</button>
        </div>
      </main>
      <script>
        window.appClicks = 0;
        document.querySelector('#save').addEventListener('click', () => { window.appClicks += 1; });
      </script>
    </body>
  </html>`;
}

const chrome = findChrome();
if (!chrome) process.exit(77);

const temporaryRoot = mkdtempSync(join(tmpdir(), "dom-picker-v2-e2e-"));
chmodSync(temporaryRoot, 0o700);
const profile = join(temporaryRoot, "chrome-profile");
const artifacts = join(temporaryRoot, "artifacts");
mkdirSync(profile, { recursive: true, mode: 0o700 });
mkdirSync(artifacts, { recursive: true, mode: 0o700 });

const server = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(fixtureHtml());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const appPort = server.address().port;
const appUrl = `http://127.0.0.1:${appPort}/settings`;

const chromeProcess = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-sandbox",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  appUrl,
], { stdio: ["ignore", "ignore", "ignore"] });

let browserConnection = null;
let pageConnection = null;
let driverProcess = null;

try {
  const debugPort = await waitUntil(() => {
    const path = join(profile, "DevToolsActivePort");
    if (!existsSync(path)) return null;
    const value = Number(readFileSync(path, "utf8").split(/\r?\n/)[0]);
    return Number.isInteger(value) && value > 0 ? value : null;
  }, "Chrome did not publish DevToolsActivePort", 20_000);
  const debugBase = `http://127.0.0.1:${debugPort}`;
  const version = await waitUntil(() => json(`${debugBase}/json/version`).catch(() => null), "Chrome debug endpoint was unavailable");
  browserConnection = new CdpConnection(version.webSocketDebuggerUrl);
  await browserConnection.ready;

  const target = await waitUntil(async () => {
    const pages = (await json(`${debugBase}/json`)).filter((item) => item.type === "page");
    return pages.find((item) => item.url.startsWith(appUrl)) || null;
  }, "fixture page target was unavailable");

  const extra = await browserConnection.send("Target.createTarget", { url: "about:blank" });
  const ambiguous = spawnSync(process.execPath, [DRIVER, "attach", `--port=${debugPort}`], { encoding: "utf8", timeout: 8_000 });
  expect(ambiguous.status === 2, "attach without a selector did not fail with multiple targets");
  expect(`${ambiguous.stdout}\n${ambiguous.stderr}`.includes("targets matched"), "ambiguous-target error was not actionable");
  await browserConnection.send("Target.closeTarget", { targetId: extra.targetId });

  driverProcess = spawn(process.execPath, [
    DRIVER,
    "attach",
    `--port=${debugPort}`,
    `--target=${target.id}`,
    "--arm",
    `--artifacts=${artifacts}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const driverEvents = new JsonLineStream(driverProcess);
  const sessionReady = await driverEvents.waitFor("ready");
  await driverEvents.waitFor("runtime_ready", (line) => line.payload?.isTop && line.payload?.url?.startsWith(appUrl));

  pageConnection = new CdpConnection(target.webSocketDebuggerUrl);
  const contexts = new Map();
  pageConnection.on("Runtime.executionContextCreated", ({ context }) => contexts.set(context.id, context));
  pageConnection.on("Runtime.executionContextDestroyed", ({ executionContextId }) => contexts.delete(executionContextId));
  pageConnection.on("Runtime.executionContextsCleared", () => contexts.clear());
  await pageConnection.ready;
  await pageConnection.send("Runtime.enable");
  await pageConnection.send("Page.enable");
  const frameTree = await pageConnection.send("Page.getFrameTree");
  const topFrameId = frameTree.frameTree.frame.id;

  const worldContext = () => Array.from(contexts.values()).find((context) => context.name === "dom-picker-v2" && context.auxData?.frameId === topFrameId);
  const mainContext = () => Array.from(contexts.values()).find((context) => context.auxData?.frameId === topFrameId && context.auxData?.isDefault);
  await waitUntil(worldContext, "isolated world was not visible to the verification connection");
  await waitUntil(mainContext, "main execution context was not visible");

  const evaluate = async (expression, contextId) => {
    const result = await pageConnection.send("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  };
  const isolatedEval = (expression) => evaluate(expression, worldContext().id);
  const mainEval = (expression) => evaluate(expression, mainContext().id);
  const clickAt = async (x, y, modifiers = 0) => {
    await pageConnection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    await pageConnection.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, modifiers, button: "left", clickCount: 1 });
    await pageConnection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, modifiers, button: "left", clickCount: 1 });
  };

  expect(await mainEval("typeof globalThis.__domPicker") === "undefined", "isolated API leaked into the page main world");
  const hostIsolation = await mainEval(`(function(){
    var host=document.querySelector('dom-picker-v2-host');
    var style=getComputedStyle(host);
    return {exists:!!host,closed:!!host&&!host.shadowRoot,display:style.display,width:parseFloat(style.width)};
  })()`);
  expect(hostIsolation.exists && hostIsolation.closed, "picker host did not use a closed Shadow DOM");
  expect(hostIsolation.display === "block" && hostIsolation.width > 300, "hostile page CSS hid or collapsed the picker host");

  const syntheticState = await isolatedEval(`(function(){
    globalThis.__domPicker.clear();
    globalThis.__domPicker.arm();
    var el=document.querySelector('#save span');
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,clientX:4,clientY:4}));
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,clientX:4,clientY:4}));
    return globalThis.__domPicker.getState();
  })()`);
  expect(syntheticState.picks.length === 0, "synthetic page events were accepted as a user pick");
  await mainEval("window.appClicks = 0; true");

  const saveRect = await mainEval(`(function(){var r=document.querySelector('#save span').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const pickPromise = driverEvents.waitFor("pick", () => true, 12_000, false);
  await clickAt(saveRect.x, saveRect.y);
  await pickPromise;
  const selectedState = await waitUntil(async () => {
    const current = await isolatedEval("globalThis.__domPicker.getState()");
    return current.picks.length === 1 ? current : null;
  }, "trusted pointer input did not select an element");
  const selected = selectedState.picks[0];
  expect(selected.tagName === "button" && selected.resolvedFromLeaf === "span", "semantic leaf promotion failed");
  expect(selected.accessibleName === "Save" && selected.selector === "#save", "pick identity evidence was incomplete");
  expect(selected.locators.some((item) => item.strategy === "testid" && item.unique), "stable locator ladder omitted data-testid");
  expect(selected.pseudoStyles?.before && selected.layoutContext && selected.metrics, "rich style/layout evidence was missing");
  expect(await mainEval("window.appClicks") === 0, "selecting the element activated the application click handler");

  let audit = await isolatedEval("globalThis.__domPicker._host.audit()");
  expect(audit.shadowMode === "closed" && audit.textareaLabelled, "panel isolation or textarea labelling failed");
  expect(audit.panelRect.width >= 300 && audit.panelRect.width <= 440, "panel geometry was outside the desktop contract");
  expect(audit.controls.length >= 7, "panel controls were not rendered");
  expect(audit.controls.every((control) => control.height >= 43.5), "one or more panel controls missed the 44px target size");
  expect(audit.controls.every((control) => !control.backgroundColor.includes("255, 105, 180")), "hostile page button CSS crossed the shadow boundary");

  await mainEval("document.querySelector('dom-picker-v2-host').remove(); true");
  await waitUntil(async () => (await isolatedEval("globalThis.__domPicker._host.audit()")).hostConnected, "picker host did not self-heal after page removal", 5_000);

  audit = await isolatedEval("globalThis.__domPicker._host.audit()");
  const textarea = audit.controls.find((control) => control.tagName === "textarea");
  expect(textarea, "request textarea was not available");
  await clickAt(textarea.x + textarea.width / 2, textarea.y + textarea.height / 2);
  await pageConnection.send("Input.insertText", { text: "Add eight pixels between these controls" });
  await waitUntil(async () => (await isolatedEval("globalThis.__domPicker.getState().draft")) === "Add eight pixels between these controls", "trusted text input did not update the draft");

  audit = await isolatedEval("globalThis.__domPicker._host.audit()");
  const send = audit.controls.find((control) => control.tagName === "button" && /Send fix request|수정 요청 보내기/.test(control.label));
  expect(send, "send button was not available");
  const requestPromise = driverEvents.waitFor("request", () => true, 15_000, false);
  await clickAt(send.x + send.width / 2, send.y + send.height / 2);
  const requestEvent = await requestPromise;
  const requestPath = requestEvent.payload.requestPath;
  expect(requestPath.startsWith(artifacts) && existsSync(requestPath), "request artifact was not persisted under the private root");
  expect((statSync(requestPath).mode & 0o777) === 0o600, "request artifact permissions were not private");
  const requestRecord = JSON.parse(readFileSync(requestPath, "utf8"));
  expect(requestRecord.protocolVersion === 2 && requestRecord.event === "request", "request artifact used the wrong protocol");
  expect(requestRecord.payload.instruction === "Add eight pixels between these controls", "request instruction was not preserved");
  expect(requestRecord.payload.provenance.channel === "isolated-picker", "request provenance channel was wrong");
  expect(requestRecord.payload.provenance.trustedUserEvent === true && requestRecord.payload.provenance.trusted === true, "trusted-event provenance gates were missing");
  expect(requestRecord.payload.picks[0].sourceHints && Array.isArray(requestRecord.payload.picks[0].sourceHints.react), "source hints were not attached");
  expect(existsSync(requestRecord.payload.artifacts.beforeScreenshot) && statSync(requestRecord.payload.artifacts.beforeScreenshot).size > 0, "before screenshot was not captured");
  await waitUntil(async () => (await isolatedEval("globalThis.__domPicker.getState().picks.length")) === 0, "panel did not clear after durable acknowledgement");

  const sourceRepo = join(temporaryRoot, "source-repo");
  mkdirSync(join(sourceRepo, "src", "settings"), { recursive: true });
  mkdirSync(join(sourceRepo, "src", "admin"), { recursive: true });
  writeFileSync(join(sourceRepo, "src", "settings", "SettingsToolbar.tsx"), `export function SettingsToolbar(){return <div className="settings-toolbar" data-testid="settings-toolbar"><button id="save" className="toolbar-action primary" data-testid="save-action"><span>Save</span></button><button id="cancel" data-testid="cancel-action">Cancel</button></div>}\n`);
  writeFileSync(join(sourceRepo, "src", "Generic.tsx"), `export const Generic=()=> <button>Save</button>;\n`);
  writeFileSync(join(sourceRepo, ".gitignore"), `.next/\ndist/\n`);
  mkdirSync(join(sourceRepo, ".next"), { recursive: true });
  writeFileSync(join(sourceRepo, ".next", "bundle.js"), `save-action Save Cancel\n`);
  const gitInit = spawnSync("git", ["init", "-q"], { cwd: sourceRepo, encoding: "utf8" });
  expect(gitInit.status === 0, `git init failed: ${gitInit.stderr}`);
  const located = spawnSync(process.execPath, [LOCATOR, `--repo=${sourceRepo}`, `--input=${requestPath}`], { encoding: "utf8" });
  expect(located.status === 0, `source locator failed: ${located.stderr}`);
  const locationResult = JSON.parse(located.stdout);
  expect(locationResult.confidence === "high", `source locator did not reach high confidence: ${located.stdout}`);
  expect(locationResult.candidates[0].path === "src/settings/SettingsToolbar.tsx", "source locator ranked the wrong owner first");
  expect(!locationResult.candidates.some((candidate) => candidate.path.startsWith(".next/")), "source locator admitted generated output");

  writeFileSync(join(sourceRepo, "src", "StatusBadge.tsx"), `export const StatusBadge=()=> <span className="status-badge neutral">Active</span>;\n`);
  writeFileSync(join(sourceRepo, "src", "admin", "StatusBadge.tsx"), `export const StatusBadge=()=> <span className="status-badge neutral">Active</span>;\n`);
  const ambiguousInput = join(temporaryRoot, "ambiguous.json");
  writeFileSync(ambiguousInput, JSON.stringify({ picks: [{ attributes: { class: "status-badge neutral" }, text: "Active", accessibleName: "Active", frame: { url: `${appUrl}/status` } }] }));
  const ambiguousLocation = spawnSync(process.execPath, [LOCATOR, `--repo=${sourceRepo}`, `--input=${ambiguousInput}`], { encoding: "utf8" });
  expect(ambiguousLocation.status === 0, `ambiguous locator run failed: ${ambiguousLocation.stderr}`);
  const ambiguousResult = JSON.parse(ambiguousLocation.stdout);
  expect(ambiguousResult.confidence !== "high" && ambiguousResult.warnings.some((warning) => warning.includes("separated")), "locator did not fail closed on tied candidates");

  const passAssertions = join(temporaryRoot, "assertions-pass.json");
  writeFileSync(passAssertions, JSON.stringify([{ pickIndex: 0, metric: "accessibleName", operator: "==", expected: "Save" }]));
  const verified = spawnSync(process.execPath, [DRIVER, "verify", `--request=${requestPath}`, `--assertions=${passAssertions}`], { encoding: "utf8", timeout: 15_000 });
  expect(verified.status === 0, `verification should have passed: ${verified.stdout}\n${verified.stderr}`);
  const verification = JSON.parse(verified.stdout.trim());
  expect(verification.payload.targetReacquired && verification.payload.passed, "verification did not reacquire and pass");
  expect(existsSync(verification.payload.afterScreenshot), "after screenshot was not recorded");

  const failAssertions = join(temporaryRoot, "assertions-fail.json");
  writeFileSync(failAssertions, JSON.stringify([{ pickIndex: 0, metric: "rect.height", operator: ">=", expected: 999 }]));
  const failedVerification = spawnSync(process.execPath, [DRIVER, "verify", `--request=${requestPath}`, `--assertions=${failAssertions}`], { encoding: "utf8", timeout: 15_000 });
  expect(failedVerification.status === 1, "failed rendered assertion did not produce a failing exit code");
  expect(JSON.parse(failedVerification.stdout.trim()).payload.passed === false, "failed verifier reported success");

  await isolatedEval("globalThis.__domPicker.snapshot('#cancel',{exact:false,multi:false});globalThis.__domPicker.arm();true");
  await delay(200);
  audit = await isolatedEval("globalThis.__domPicker._host.audit()");
  const reloadTextarea = audit.controls.find((control) => control.tagName === "textarea");
  await clickAt(reloadTextarea.x + reloadTextarea.width / 2, reloadTextarea.y + reloadTextarea.height / 2);
  await pageConnection.send("Input.insertText", { text: "draft survives reload" });
  await waitUntil(async () => (await isolatedEval("globalThis.__domPicker.getState().draft")) === "draft survives reload", "reload draft was not entered");
  await delay(350);
  const oldWorldId = worldContext().id;
  const loaded = pageConnection.waitFor("Page.loadEventFired", () => true, 12_000, false);
  const reloadRun = runProcess(process.execPath, [DRIVER, "reload", "--ignore-cache", `--port=${debugPort}`, `--target=${target.id}`]);
  await loaded;
  const reloadResult = await reloadRun;
  expect(reloadResult.status === 0 && JSON.parse(reloadResult.stdout).event === "reloaded", `reload command failed: ${reloadResult.stdout}\n${reloadResult.stderr}`);
  await waitUntil(() => worldContext() && worldContext().id !== oldWorldId ? worldContext() : null, "isolated world was not recreated after reload");
  const restored = await waitUntil(async () => {
    const value = await isolatedEval("globalThis.__domPicker.getState()");
    return value.draft === "draft survives reload" && value.picks.length === 1 && value.armed ? value : null;
  }, "picker state was not restored across reload");
  expect(restored.picks[0].accessibleName === "Cancel", "restored pick resolved to the wrong target");

  const crossOldWorld = worldContext();
  const crossLoaded = pageConnection.waitFor("Page.loadEventFired", () => true, 12_000, false);
  const crossNavigation = driverEvents.waitFor("navigation", (line) => line.payload?.allowed === false, 12_000, false);
  await pageConnection.send("Page.navigate", { url: "data:text/html,<title>cross-origin</title><p>cross</p>" });
  await crossLoaded;
  await waitUntil(() => worldContext() && worldContext() !== crossOldWorld ? worldContext() : null, "isolated world was not recreated on cross-origin navigation");
  await crossNavigation;
  const paused = await waitUntil(async () => {
    const value = await isolatedEval("globalThis.__domPicker.getState()");
    return value.pausedReason === "origin" ? value : null;
  }, "cross-origin navigation did not pause picker authority");
  expect(paused.armed === false, "picker remained armed on a disallowed origin");

  const returnOldWorld = worldContext();
  const returnLoaded = pageConnection.waitFor("Page.loadEventFired", () => true, 12_000, false);
  await pageConnection.send("Page.navigate", { url: appUrl });
  await returnLoaded;
  await waitUntil(() => worldContext() && worldContext() !== returnOldWorld ? worldContext() : null, "isolated world did not return to the allowed origin");
  await waitUntil(async () => await mainEval("document.querySelectorAll('dom-picker-v2-host').length") === 1, "picker host did not return on the allowed origin");

  const snapshotInstruction = join(temporaryRoot, "trusted-chat.txt");
  writeFileSync(snapshotInstruction, "Make the Cancel button easier to distinguish\n");
  const snapshotArtifacts = join(temporaryRoot, "snapshot-artifacts");
  const bundledSnapshot = spawnSync(process.execPath, [
    DRIVER,
    "snapshot",
    "#cancel",
    `--instruction-file=${snapshotInstruction}`,
    `--artifacts=${snapshotArtifacts}`,
    `--port=${debugPort}`,
    `--target=${target.id}`,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(bundledSnapshot.status === 0, `trusted-chat snapshot bundle failed: ${bundledSnapshot.stdout}\n${bundledSnapshot.stderr}`);
  const bundledEvent = JSON.parse(bundledSnapshot.stdout.trim());
  expect(bundledEvent.event === "request" && bundledEvent.payload.provenance.channel === "trusted-chat", "snapshot bundle used the wrong event or channel");
  expect(bundledEvent.payload.provenance.trustedUserEvent === false && bundledEvent.payload.provenance.trusted === false, "snapshot bundle fabricated browser trust");
  const bundledRecord = JSON.parse(readFileSync(bundledEvent.payload.requestPath, "utf8"));
  expect(bundledRecord.sessionId === sessionReady.sessionId, "snapshot bundle did not preserve the continuous driver session id");
  expect(bundledRecord.payload.instruction === "Make the Cancel button easier to distinguish", "snapshot bundle lost the chat instruction");
  expect(existsSync(bundledRecord.payload.artifacts.beforeScreenshot), "snapshot bundle omitted its before screenshot");
  expect(Array.isArray(bundledRecord.payload.picks[0].sourceHints.matchedStyles), "snapshot bundle omitted matched-style evidence");
  const bundledAssertions = join(temporaryRoot, "snapshot-assertions.json");
  writeFileSync(bundledAssertions, JSON.stringify([{ pickIndex: 0, metric: "accessibleName", operator: "==", expected: "Cancel" }]));
  const bundledVerification = spawnSync(process.execPath, [DRIVER, "verify", `--request=${bundledEvent.payload.requestPath}`, `--assertions=${bundledAssertions}`], { encoding: "utf8", timeout: 15_000 });
  expect(bundledVerification.status === 0 && JSON.parse(bundledVerification.stdout).payload.passed, "snapshot bundle could not use the standard verifier");
  const ambiguousSnapshot = spawnSync(process.execPath, [DRIVER, "snapshot", ".toolbar-action", `--port=${debugPort}`, `--target=${target.id}`], { encoding: "utf8", timeout: 12_000 });
  expect(ambiguousSnapshot.status === 2 && `${ambiguousSnapshot.stdout}\n${ambiguousSnapshot.stderr}`.includes("must match exactly one"), "snapshot did not fail closed on an ambiguous selector");

  const stopped = driverEvents.waitFor("stopped", () => true, 8_000, false);
  driverProcess.kill("SIGINT");
  await stopped;
  await waitUntil(async () => await mainEval("document.querySelectorAll('dom-picker-v2-host').length") === 0, "driver shutdown left the picker host behind");
  expect(await isolatedEval("typeof globalThis.__domPicker") === "undefined", "driver shutdown left the isolated API behind");

  const fallbackSnapshot = spawnSync(process.execPath, [DRIVER, "snapshot", "#save", `--port=${debugPort}`, `--target=${target.id}`], { encoding: "utf8", timeout: 12_000 });
  expect(fallbackSnapshot.status === 0, `fallback snapshot failed: ${fallbackSnapshot.stdout}\n${fallbackSnapshot.stderr}`);
  const fallbackEvent = JSON.parse(fallbackSnapshot.stdout.trim());
  expect(fallbackEvent.event === "snapshot" && fallbackEvent.payload.pick?.accessibleName === "Save", "fallback snapshot returned incomplete evidence");
  const fallbackAudit = await mainEval("globalThis.__domPicker._host.audit()");
  expect(fallbackAudit.secure === false, "fallback runtime incorrectly claimed isolated security");
  expect(fallbackAudit.controls.find((control) => control.tagName === "textarea")?.disabled === true, "fallback panel accepted browser instructions");
  const fallbackDestroy = spawnSync(process.execPath, [DRIVER, "destroy", `--port=${debugPort}`, `--target=${target.id}`], { encoding: "utf8", timeout: 12_000 });
  expect(fallbackDestroy.status === 0, `fallback destroy failed: ${fallbackDestroy.stdout}\n${fallbackDestroy.stderr}`);
  await waitUntil(async () => await mainEval("typeof globalThis.__domPicker === 'undefined' && document.querySelectorAll('dom-picker-v2-host').length === 0"), "fallback teardown left page state behind");

  const ownedArtifacts = join(temporaryRoot, "owned-artifacts");
  const ownedDriver = spawn(process.execPath, [DRIVER, "start", appUrl, "--headless", "--no-sandbox", "--arm", `--artifacts=${ownedArtifacts}`], { stdio: ["ignore", "pipe", "pipe"] });
  const ownedEvents = new JsonLineStream(ownedDriver);
  await ownedEvents.waitFor("ready", (line) => line.target?.url?.startsWith(appUrl), 20_000);
  await ownedEvents.waitFor("runtime_ready", (line) => line.payload?.isTop && line.payload?.url?.startsWith(appUrl), 12_000);
  const ownedProfile = await waitUntil(() => {
    const match = ownedEvents.stderr.match(/temporary Chrome profile at (.+); it will close/);
    return match?.[1] || null;
  }, "owned start session did not report its temporary profile");
  const ownedStopped = ownedEvents.waitFor("stopped", () => true, 10_000, false);
  ownedDriver.kill("SIGINT");
  await ownedStopped;
  expect(!existsSync(ownedProfile), "owned start session did not remove its temporary Chrome profile");

  console.log("dom-picker v2 real-browser e2e passed");
} finally {
  try { driverProcess?.kill("SIGKILL"); } catch { /* already stopped */ }
  pageConnection?.close();
  browserConnection?.close();
  try { chromeProcess.kill("SIGKILL"); } catch { /* already stopped */ }
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryRoot, { recursive: true, force: true });
}
