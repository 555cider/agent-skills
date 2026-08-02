import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const runtimePath = fileURLToPath(new URL("../assets/picker-runtime.js", import.meta.url));
const runtime = readFileSync(runtimePath, "utf8");

function page() {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>DOM Picker UI audit fixture</title>
      <style>
        :root { color-scheme: light dark; font-family: Inter, system-ui, sans-serif; }
        body { min-height: 100vh; margin: 0; padding: 32px; background: #f5f7fb; color: #172033; }
        main { max-width: 720px; margin: 0 auto; }
        .toolbar { display: flex; gap: 4px; padding: 24px; border: 1px solid #ccd4e2; border-radius: 16px; background: white; }
        .toolbar button { min-height: 44px; padding: 10px 16px; border: 1px solid #8b97aa; border-radius: 9px; background: #eef2f8; color: #172033; font: 700 14px/1 system-ui; }
        @media (prefers-color-scheme: dark) {
          body { background: #070d18; color: #edf3ff; }
          .toolbar { border-color: #3a4760; background: #111a2b; }
          .toolbar button { border-color: #65728a; background: #1c2940; color: #edf3ff; }
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Settings</h1>
        <p>Rendered host content remains visible behind the transient picker.</p>
        <div class="toolbar" data-testid="settings-toolbar">
          <button id="audit-target" data-testid="save-action"><span>Save settings</span></button>
          <button type="button">Cancel</button>
        </div>
      </main>
      <script>
        globalThis.__auditBinding = function () {};
        globalThis.__DOM_PICKER_CONFIG__ = {
          mode: "isolated",
          sessionId: "ui-audit-session",
          bindingName: "__auditBinding",
          allowedOrigin: location.origin,
          armOnStart: false,
          shadowMode: "light"
        };
      </script>
      <script src="/picker-runtime.js"></script>
      <script>
        requestAnimationFrame(function () {
          globalThis.__domPicker._host.heartbeat();
          globalThis.__domPicker.snapshot("#audit-target", { exact: false, multi: false });
          globalThis.__domPicker._host.syncJobs([
            { requestId: "audit-active", sequence: 4, state: "locating", message: "Locating the owning component", cancellable: true, final: false, updatedAt: "2026-08-02T00:00:00.000Z" },
            { requestId: "audit-done", sequence: 3, state: "applied_verified", message: "Rendered checks passed", cancellable: false, final: true, updatedAt: "2026-08-02T00:00:00.000Z" }
          ]);
        });
      </script>
    </body>
  </html>`;
}

const server = createServer((request, response) => {
  response.setHeader("cache-control", "no-store");
  if (request.url === "/picker-runtime.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    response.end(runtime);
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(page());
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })}\n`);

const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise(() => {});
