import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ASSET = fileURLToPath(new URL("../assets/element-picker.js", import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name) => argv.includes("--" + name);
const opt = (name, def) => {
  const a = argv.find((x) => x.startsWith("--" + name + "="));
  return a ? a.slice(name.length + 3) : def;
};
const PORT = process.env.CDP_PORT || opt("port", "9222");
const portNumber = Number(PORT);
if (cmd && (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)) {
  console.error("invalid --port: expected an integer from 1 to 65535");
  process.exit(2);
}
const BASE = "http://localhost:" + PORT;
const MATCH = opt("match", "");
const COMMAND_TIMEOUT_MS = 10000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const src = () => readFileSync(ASSET, "utf8");
// Prefer the picker's public atomic drain so its queue UI is rerendered too. Keep the
// direct queue reset as a compatibility fallback for already-injected older picker builds.
const DRAIN =
  "(function(){var s=window.__s2p;if(!s)return null;var o;" +
  "if(typeof s.drainQueue==='function'){o=s.drainQueue();}" +
  "else{if(!s.queue||!s.queue.length)return null;o=s.queue.slice();s.queue=[];s.request=null;}" +
  "return o&&o.length?JSON.stringify(o):null;})()";

async function pageTarget() {
  let list;
  try {
    list = await (await fetch(BASE + "/json")).json();
  } catch {
    // Chrome not listening on the debug port (not launched, wrong port, or a
    // non-debug Chrome). Caller turns null into the friendly NO_TARGET path.
    return null;
  }
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return (MATCH ? pages.find((p) => (p.url || "").includes(MATCH)) : null) || pages[0];
}
function connect(ws) {
  const sock = new WebSocket(ws);
  let id = 0; const pending = new Map();
  let opened = false;
  let settleReady;
  const ready = new Promise((res, rej) => {
    settleReady = { res, rej };
    sock.addEventListener("open", () => { opened = true; res(); }, { once: true });
  });
  const rejectPending = (error) => {
    for (const { rej, timer } of pending.values()) { clearTimeout(timer); rej(error); }
    pending.clear();
  };
  const disconnected = (kind) => {
    const error = new Error("CDP WebSocket " + kind);
    if (!opened) settleReady.rej(error);
    rejectPending(error);
  };
  sock.addEventListener("error", () => disconnected("error"));
  sock.addEventListener("close", () => disconnected("closed"));
  sock.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej, timer } = pending.get(m.id); pending.delete(m.id); clearTimeout(timer);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (sock.readyState !== WebSocket.OPEN) { rej(new Error("CDP WebSocket is not open")); return; }
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      rej(new Error("CDP command timed out: " + method));
    }, COMMAND_TIMEOUT_MS);
    pending.set(mid, { res, rej, timer });
    try { sock.send(JSON.stringify({ id: mid, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(mid); rej(error); }
  });
  const close = () => { rejectPending(new Error("CDP WebSocket closed by client")); try { sock.close(); } catch { } };
  return { ready, send, close };
}
const evalJs = (c, expression, rbv = true) => c.send("Runtime.evaluate", { expression, returnByValue: rbv, awaitPromise: true });
async function attach() {
  const t = await pageTarget();
  if (!t) { console.log("NO_TARGET (no page on " + BASE + "?)"); process.exit(2); }
  const c = connect(t.webSocketDebuggerUrl);
  await c.ready; await c.send("Runtime.enable"); await c.send("Page.enable");
  return c;
}
function chromeBin() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const cands = process.platform === "win32"
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        (process.env.LOCALAPPDATA || "") + "/Google/Chrome/Application/chrome.exe",
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return cands.find(existsSync);
}

switch (cmd) {
  case "launch": {
    const url = pos[0] || "about:blank";
    const bin = chromeBin();
    if (!bin) { console.error("chrome not found — set CHROME=/path/to/chrome"); process.exit(2); }
    // Fresh, unpredictable profile dir by default (avoids clobbering a running Chrome and the
    // multi-user /tmp symlink hazard of a fixed path). Reuse one only if the caller names it.
    const dir = opt("user-data-dir", mkdtempSync(join(tmpdir(), "dom-picker-")));
    const child = spawn(bin, ["--remote-debugging-port=" + PORT, "--user-data-dir=" + dir, "--new-window", url], { detached: true, stdio: "ignore" });
    child.unref();
    // Wait until the debug endpoint answers so a following keep/wait doesn't hit NO_TARGET.
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try { const r = await fetch(BASE + "/json/version"); if (r.ok) { ready = true; break; } } catch { }
      await new Promise((res) => setTimeout(res, 200));
    }
    console.log("launched chrome (pid " + child.pid + ") on :" + PORT + " -> " + url + (ready ? "" : " (debug port not confirmed within 15s)"));
    console.error("WARNING: --remote-debugging-port=" + PORT + " lets any local process fully control this browser. Use a throwaway profile and close it when done.");
    process.exit(ready ? 0 : 2);
  }
  case "inject": {
    const c = await attach();
    await evalJs(c, src(), false);
    if (flag("arm")) await evalJs(c, "window.__s2p&&window.__s2p.enable&&window.__s2p.enable()");
    console.log(JSON.stringify({ injected: true, armed: flag("arm") }));
    process.exit(0);
  }
  case "keep": {
    // Long-lived: re-inject whenever the picker is missing (survives reloads).
    // The on-new-document registration only holds while THIS connection stays open.
    let c = await attach();
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src() });
    console.log("[keep] watching :" + PORT + (flag("arm") ? " (auto-arm)" : ""));
    while (true) {
      await delay(1000);
      try {
        const r = await evalJs(c, "!!(window.__s2p&&window.__s2p.__installed)");
        if (r.result.value === false) {
          await evalJs(c, src(), false);
          if (flag("arm")) await evalJs(c, "window.__s2p&&window.__s2p.enable&&window.__s2p.enable()");
          console.log("[keep] re-injected after reload");
        }
      } catch {
        // Execution context / socket lost (typically a navigation). Close the
        // dead socket before re-attaching so reloads don't leak connections or
        // duplicate the on-new-document registration.
        c.close();
        try {
          c = await attach();
          await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src() });
          console.log("[keep] reconnected after navigation");
        } catch { /* target gone; next tick retries */ }
      }
    }
  }
  case "serve": {
    // Preferred interactive listener: keep the picker alive across reloads (like `keep`)
    // AND deliver queued fix requests. On the first non-empty queue, drain ALL of it in one
    // shot, print `REQUEST {requests:[...]}`, and exit — the exit re-invokes a host that
    // launched this as a background task. Requests the user submits while the host works
    // survive in the in-page queue and are returned immediately by the next `serve`, so the
    // host must re-launch `serve` right after receiving (before processing) to stay armed.
    let c = await attach();
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src() });
    console.log("[serve] watching :" + PORT + (flag("arm") ? " (auto-arm)" : ""));
    while (true) {
      await delay(800);
      try {
        const inst = await evalJs(c, "!!(window.__s2p&&window.__s2p.__installed)");
        if (inst.result.value === false) {
          await evalJs(c, src(), false);
          if (flag("arm")) await evalJs(c, "window.__s2p&&window.__s2p.enable&&window.__s2p.enable()");
          console.log("[serve] re-injected after reload");
          continue;
        }
        const drained = await evalJs(c, DRAIN);
        if (drained.result.value) {
          console.log("REQUEST " + JSON.stringify({ requests: JSON.parse(drained.result.value) }));
          process.exit(0);
        }
      } catch {
        c.close();
        try { c = await attach(); await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src() }); } catch { }
      }
    }
  }
  case "wait": {
    // One-shot drainer (no keep-alive). Blocks until the queue has >=1 request, drains the
    // WHOLE queue, prints `REQUEST {requests:[...]}`, and exits. Prefer `serve` interactively;
    // `wait` remains for hosts that keep the picker alive separately. --timeout=<sec> bounds
    // the wait (exit 3) so a host task can't hang forever if no request is submitted.
    const timeoutSec = Number(opt("timeout", "0"));
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
      console.error("invalid --timeout: expected a non-negative number of seconds");
      process.exit(2);
    }
    const c = await attach();
    const started = Date.now();
    console.log("[wait] waiting for a submitted fix request…" + (timeoutSec > 0 ? " (timeout " + timeoutSec + "s)" : ""));
    while (true) {
      await delay(800);
      if (timeoutSec > 0 && (Date.now() - started) > timeoutSec * 1000) {
        console.log("TIMEOUT (no fix submitted within " + timeoutSec + "s)");
        process.exit(3);
      }
      try {
        const drained = await evalJs(c, DRAIN);
        if (drained.result.value) {
          console.log("REQUEST " + JSON.stringify({ requests: JSON.parse(drained.result.value) }));
          process.exit(0);
        }
      } catch { }
    }
  }
  case "read": {
    const c = await attach();
    const r = await evalJs(c, "JSON.stringify({lastPick:(window.__s2p&&window.__s2p.lastPick)||null,picks:(window.__s2p&&window.__s2p.picks)||[],request:(window.__s2p&&window.__s2p.request)||null,queue:(window.__s2p&&window.__s2p.queue)||[]})");
    console.log(r.result.value);
    process.exit(0);
  }
  case "pick": {
    const sel = pos[0];
    if (!sel) { console.error("usage: cdp.mjs pick <css-selector>"); process.exit(2); }
    const c = await attach();
    const r = await evalJs(c, "JSON.stringify(window.__s2p?window.__s2p.snapshot(" + JSON.stringify(sel) + "):null)");
    console.log(r.result.value || "null");
    process.exit(0);
  }
  case "clear": {
    const c = await attach();
    await evalJs(c, "window.__s2p&&window.__s2p.clear&&window.__s2p.clear()");
    console.log("cleared");
    process.exit(0);
  }
  default:
    console.log("usage: node cdp.mjs <launch [url] | serve [--arm] | keep [--arm] | wait [--timeout=<sec>] | read | pick <sel> | inject [--arm] | clear> [--port=9222] [--match=<url-substr>]");
    process.exit(cmd ? 2 : 0);
}
