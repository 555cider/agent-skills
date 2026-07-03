import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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
const BASE = "http://localhost:" + PORT;
const MATCH = opt("match", "");
const src = () => readFileSync(ASSET, "utf8");

async function pageTarget() {
  const list = await (await fetch(BASE + "/json")).json();
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return (MATCH ? pages.find((p) => (p.url || "").includes(MATCH)) : null) || pages[0];
}
function connect(ws) {
  const sock = new WebSocket(ws);
  let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { sock.addEventListener("open", () => res()); sock.addEventListener("error", rej); });
  sock.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); sock.send(JSON.stringify({ id: mid, method, params })); });
  return { ready, send };
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
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"]
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
    const dir = opt("user-data-dir", (process.env.TEMP || "/tmp") + "/dom-picker-cdp");
    const child = spawn(bin, ["--remote-debugging-port=" + PORT, "--user-data-dir=" + dir, "--new-window", url], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("launched chrome (pid " + child.pid + ") on :" + PORT + " -> " + url);
    process.exit(0);
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
    setInterval(async () => {
      try {
        const r = await evalJs(c, "!!(window.__s2p&&window.__s2p.__installed)");
        if (r.result.value === false) {
          await evalJs(c, src(), false);
          if (flag("arm")) await evalJs(c, "window.__s2p&&window.__s2p.enable&&window.__s2p.enable()");
          console.log("[keep] re-injected after reload");
        }
      } catch { try { c = await attach(); await c.send("Page.addScriptToEvaluateOnNewDocument", { source: src() }); } catch { } }
    }, 1000);
    break;
  }
  case "wait": {
    // Block until the user submits a fix request in the picker; print it and exit
    // (exiting is what re-invokes a host that launched this as a background task).
    const c = await attach();
    const read = async () => {
      const r = await evalJs(c, "JSON.stringify((window.__s2p&&window.__s2p.request)||null)");
      return r.result.value ? JSON.parse(r.result.value) : null;
    };
    let baseline = null;
    try { const cur = await read(); baseline = cur ? cur.seq : null; } catch { }
    console.log("[wait] waiting for a submitted fix request…");
    const iv = setInterval(async () => {
      try {
        const req = await read();
        if (req && req.seq !== baseline) {
          clearInterval(iv);
          const full = await evalJs(c, "JSON.stringify(window.__s2p.picks||[])");
          console.log("REQUEST " + JSON.stringify({ request: req, picks: JSON.parse(full.result.value || "[]") }));
          process.exit(0);
        }
      } catch { }
    }, 800);
    break;
  }
  case "read": {
    const c = await attach();
    const r = await evalJs(c, "JSON.stringify({lastPick:(window.__s2p&&window.__s2p.lastPick)||null,picks:(window.__s2p&&window.__s2p.picks)||[],request:(window.__s2p&&window.__s2p.request)||null})");
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
    console.log("usage: node cdp.mjs <launch [url] | keep [--arm] | wait | read | pick <sel> | inject [--arm] | clear> [--port=9222] [--match=<url-substr>]");
    process.exit(cmd ? 2 : 0);
}
