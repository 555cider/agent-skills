#!/usr/bin/env bash
# Self-contained regression checks for the zero-dependency ui-audit runner.
#
# Run: bash skills/ui-audit/tests/run.sh
set -u
export UI_SPLINT_SETTLE_MS=350

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../scripts/audit-chrome.mjs"
PY_RUNNER="$HERE/../scripts/run-ui-audit.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ui-audit-tests.XXXXXX")"
PROFILES_BEFORE="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'uisplint-*' | wc -l)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_exit() {
  if [ "$EC" = "$2" ]; then
    pass "$1 [exit $2]"
  else
    fail "$1" "expected exit $2, got $EC (output: $(cat "$WORK/out" 2>/dev/null | tr '\n' '|' | head -c 300))"
  fi
}

PORT="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/fixtures" >"$WORK/http.log" 2>&1 &
SERVER_PID=$!
# Poll the port instead of a fixed sleep (flaky on slow/loaded CI).
if python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.time() + 10
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit(1)
PY
then :; else
  echo "FAIL  http server did not come up on port $PORT" >&2
  exit 1
fi

cat >"$WORK/missing-route.json" <<'EOF'
{
  "routes": ["/missing.html"],
  "viewports": [{ "name": "mobile", "width": 390, "height": 844, "isMobile": true, "dpr": 3 }],
  "themes": ["dark"],
  "states": ["default"],
  "scrollPositions": ["top"]
}
EOF

set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/missing-route.json" --out-dir "$WORK/audit" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e

assert_exit "missing route blocks audit" 1
if python3 - "$WORK/audit/coverage.json" <<'PY'
import json
import sys
data = json.load(open(sys.argv[1]))
cell = data["matrix"][0]
assert cell["status"] == "error", cell
assert "HTTP 404" in cell["error"], cell
PY
then
  pass "coverage records HTTP 404 as unverified"
else
  fail "coverage records HTTP 404 as unverified" "$(cat "$WORK/audit/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 300)"
fi

if grep -q "args = \[.*--no-sandbox" "$RUNNER"; then
  fail "Chrome sandbox is enabled by default" "runner hard-codes --no-sandbox"
else
  pass "Chrome sandbox is enabled by default"
fi
grep -qF -- "--allow-no-sandbox" "$RUNNER" && pass "unsafe sandbox override is explicit" || fail "unsafe sandbox override is explicit" "missing flag"
grep -qF "CDP command timeout" "$RUNNER" && pass "CDP requests have a deadline" || fail "CDP requests have a deadline" "missing timeout"

set +e
python3 "$PY_RUNNER" http://example.invalid --probes >"$WORK/probes.out" 2>"$WORK/probes.err"
EC=$?
set -e
assert_exit "removed mutating --probes flag is rejected" 2

cat >"$WORK/theme-valid.json" <<'EOF'
{"routes":["/clean.html"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"themes":["app-dark"],"states":["default"],"scrollPositions":["top"],"themeInitScripts":{"app-dark":"document.documentElement.dataset.theme='dark'"}}
EOF
set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/theme-valid.json" --out-dir "$WORK/theme-valid" --no-screenshots >"$WORK/out" 2>"$WORK/err"
set -e
if python3 - "$WORK/theme-valid/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["themeDriver"] == "init-script" and cell["status"] == "checked", cell
PY
then pass "theme init script records verified driver"; else fail "theme init script records verified driver" "invalid coverage"; fi

cat >"$WORK/theme-error.json" <<'EOF'
{"routes":["/clean.html"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"themes":["broken"],"states":["default"],"scrollPositions":["top"],"themeInitScripts":{"broken":"throw new Error('theme boom')"}}
EOF
set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/theme-error.json" --out-dir "$WORK/theme-error" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "theme init failure blocks coverage" 1
if grep -qF "theme init failed: theme boom" "$WORK/theme-error/coverage.json"; then pass "theme init error is preserved"; else fail "theme init error is preserved" "missing error"; fi

set +e
python3 - "$HERE" "$RUNNER" "$PORT" "$WORK" >"$WORK/contract.out" 2>"$WORK/contract.err" <<'PY'
import json
import pathlib
import subprocess
import sys

here = pathlib.Path(sys.argv[1])
runner = pathlib.Path(sys.argv[2])
port = sys.argv[3]
work = pathlib.Path(sys.argv[4])
expected = json.loads((here / "expected.json").read_text(encoding="utf-8"))["fixtures"]
base = f"http://127.0.0.1:{port}"
errors = []

for fixture in expected:
    file_name = fixture["file"]
    viewport = fixture["viewport"]
    out_dir = work / ("contract-" + file_name.replace(".", "-"))
    config = {
        "routes": ["/" + file_name],
        "viewports": [{
            "name": "fixture",
            "width": viewport["width"],
            "height": viewport["height"],
            "isMobile": viewport.get("isMobile", True),
            "dpr": viewport.get("dpr", 3),
        }],
        "themes": [fixture.get("theme", "light")],
        "states": fixture.get("states", ["default"]),
        "scrollPositions": ["top", "bottom"],
    }
    if fixture.get("stateSetups"):
        config["stateSetups"] = fixture["stateSetups"]
    cfg_path = work / (file_name + ".json")
    cfg_path.write_text(json.dumps(config), encoding="utf-8")
    result = subprocess.run(
        ["node", str(runner), base, "--config", str(cfg_path), "--out-dir", str(out_dir), "--no-screenshots"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode not in (0, 1):
        errors.append(f"{file_name}: runner exited {result.returncode}\n{result.stderr or result.stdout}")
        continue

    findings_path = out_dir / "findings.json"
    coverage_path = out_dir / "coverage.json"
    if not findings_path.exists() or not coverage_path.exists():
        errors.append(f"{file_name}: missing findings/coverage output")
        continue

    findings = json.loads(findings_path.read_text(encoding="utf-8"))
    coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
    bad_cells = [c for c in coverage.get("matrix", []) if c.get("status") != "checked"]
    if bad_cells:
        errors.append(f"{file_name}: unverified coverage cells {bad_cells!r}")

    # The exit code is a contract, not a free choice: an un-baselined Fail (or any unverified cell)
    # must gate with exit 1; a page whose worst finding is Risk/Polish must exit 0.
    has_fail = any(f.get("severity") == "Fail" for f in findings)
    expected_exit = 1 if (has_fail or bad_cells) else 0
    if result.returncode != expected_exit:
        worst = "Fail" if has_fail else ("unverified" if bad_cells else "Risk/Polish/none")
        errors.append(f"{file_name}: exit {result.returncode} but expected {expected_exit} (worst signal: {worst})")

    if fixture.get("expectZeroFindings") and findings:
        rules = ", ".join(sorted({f.get("rule", "?") for f in findings}))
        errors.append(f"{file_name}: expected zero findings, got {len(findings)} ({rules})")

    for must in fixture.get("mustHit", []):
        rule = must["rule"]
        needle = must.get("matches")
        want_sev = must.get("severity")
        want_conf = must.get("confidence")
        matched = False
        sev_mismatch = None
        for finding in findings:
            if finding.get("rule") != rule:
                continue
            blob = json.dumps(finding, ensure_ascii=False)
            if needle and needle not in blob:
                continue
            # Rule + text match; now pin severity/confidence when the contract asks.
            if want_sev and finding.get("severity") != want_sev:
                sev_mismatch = f"severity {finding.get('severity')!r} != {want_sev!r}"
                continue
            if want_conf and finding.get("confidence") != want_conf:
                sev_mismatch = f"confidence {finding.get('confidence')!r} != {want_conf!r}"
                continue
            matched = True
            break
        if not matched:
            detail = f" matching {needle!r}" if needle else ""
            if sev_mismatch:
                detail += f" [{sev_mismatch}]"
            rules = ", ".join(sorted({f.get("rule", "?") for f in findings}))
            errors.append(f"{file_name}: missing {rule}{detail}; saw [{rules}]")

    for forbidden in fixture.get("mustNotHit", []):
        if any(f.get("rule") == forbidden for f in findings):
            errors.append(f"{file_name}: forbidden rule {forbidden} fired")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
PY
EC=$?
set -e

assert_exit "fixture contract matches expected.json" 0
if [ "$EC" -ne 0 ]; then
  fail "fixture contract details" "$(cat "$WORK/contract.err" 2>/dev/null | tr '\n' '|' | head -c 800)"
fi

set +e

# ---------------------------------------------------------------------------
# whitelist: a selector matching several elements suppresses ALL of them (and
# their subtree), not just the first — the fixed semantics.
# ---------------------------------------------------------------------------
cat >"$WORK/wl.json" <<'EOF'
{
  "routes": ["/whitelist.html"],
  "viewports": [{ "name": "desktop", "width": 1280, "height": 900, "isMobile": false, "dpr": 1 }],
  "themes": ["light"],
  "states": ["default"],
  "scrollPositions": ["top"],
  "auditConfig": { "whitelist": [".wl"] }
}
EOF
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/wl.json" --out-dir "$WORK/wl" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/wl/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1], encoding="utf-8"))
contrast = [f for f in findings if f["rule"] == "effectiveContrast"]
# every remaining contrast finding must be on the un-whitelisted .other control
assert contrast, "expected the un-whitelisted control to still be flagged"
assert all(".wl" not in f["selector"] for f in contrast), \
    f"whitelist leaked: {[f['selector'] for f in contrast]}"
assert any("other" in f["selector"] for f in contrast), \
    f"expected .other to survive, got {[f['selector'] for f in contrast]}"
PY
then
  pass "whitelist suppresses all matching elements + subtree"
else
  fail "whitelist suppresses all matching elements + subtree" \
    "$(cat "$WORK/wl/findings.json" 2>/dev/null | tr '\n' '|' | head -c 400)"
fi

# ---- whitelist suppresses ALL matching instances (safeMatch regression) ----
# adbanners.html has two low-contrast `.ad-banner` slots. The buggy safeMatch only compared the
# first match of each selector, so it leaked every finding past the first whitelisted instance.
node "$RUNNER" "http://127.0.0.1:$PORT" --routes "/adbanners.html" --out-dir "$WORK/wl-off" --no-screenshots >/dev/null 2>&1
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"auditConfig":{"whitelist":[".ad-banner"]}}') \
  --routes "/adbanners.html" --out-dir "$WORK/wl-on" --no-screenshots >/dev/null 2>&1
if python3 - "$WORK/wl-off/findings.json" "$WORK/wl-on/findings.json" <<'PY'
import json, sys
off = json.load(open(sys.argv[1]))
on = json.load(open(sys.argv[2]))
# Baseline must actually surface both banners, or the test proves nothing.
banners_off = [f for f in off if f.get("rule") == "effectiveContrast"]
assert len(banners_off) >= 2, f"expected >=2 findings without whitelist, got {len(banners_off)}"
# With `.ad-banner` whitelisted, EVERY instance must be gone — not just the first.
leaked = [f for f in on if ".ad-banner" in f.get("selector", "")]
assert not leaked, f"whitelist leaked {len(leaked)} finding(s): {[f['selector'] for f in leaked]}"
PY
then
  pass "whitelist suppresses all matching instances"
else
  fail "whitelist suppresses all matching instances" "off=$(cat "$WORK/wl-off/findings.json" 2>/dev/null | head -c 200) on=$(cat "$WORK/wl-on/findings.json" 2>/dev/null | head -c 200)"
fi

# ---- runner-generated keyboard findings honor whitelist and baseline ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"auditConfig":{"whitelist":["#covered-action"]}}') \
  --out-dir "$WORK/keyboard-wl" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/keyboard-wl/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1]))
assert not any(f.get("rule") == "focusObscured" for f in findings), findings
PY
then pass "keyboard findings honor whitelist"; else fail "keyboard findings honor whitelist" "focusObscured leaked"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"baseline":[{"rule":"focusObscured","selector":"button#covered-action"}]}') \
  --out-dir "$WORK/keyboard-base" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/keyboard-base/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1]))
assert not any(f.get("rule") == "focusObscured" for f in findings), findings
PY
then pass "keyboard findings honor baseline"; else fail "keyboard findings honor baseline" "focusObscured leaked"; fi

# ---- bounded traversal and setup failures remain honest coverage errors ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"keyboardProbe":{"maxSteps":1,"settleMs":0}}') \
  --out-dir "$WORK/keyboard-cap" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "keyboard traversal cap blocks completion" 1
if python3 - "$WORK/keyboard-cap/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "error" and cell["keyboardProbe"]["status"] == "incomplete", cell
PY
then pass "keyboard cap is recorded in coverage"; else fail "keyboard cap is recorded in coverage" "missing incomplete proof"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"routes":["/state-setup-modal.html"],"themes":["light"],"states":["dialog-open"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateSetups":{"dialog-open":{"actions":[{"type":"click","selector":"#missing"}],"expect":[{"selector":"[role=dialog]","state":"visible"}]}}}') \
  --out-dir "$WORK/setup-error" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "invalid state setup blocks completion" 1
if python3 - "$WORK/setup-error/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "error" and "timed out" in cell["error"], cell
PY
then pass "state setup failure is recorded"; else fail "state setup failure is recorded" "missing setup error"; fi

# ---- every cell gets an isolated browser context ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"routes":["/context-isolation.html"],"themes":["light"],"states":["one","two"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateSetups":{"one":{"expect":[{"selector":".fresh","state":"visible"}]},"two":{"expect":[{"selector":".fresh","state":"visible"}]}}}') \
  --out-dir "$WORK/context-isolation" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/context-isolation/coverage.json" <<'PY'
import json, sys
cells = json.load(open(sys.argv[1]))["matrix"]
assert len(cells) == 2 and all(c["status"] == "checked" for c in cells), cells
PY
then pass "browser storage is isolated per matrix cell"; else fail "browser storage is isolated per matrix cell" "storage leaked"; fi

# ---- non-default data states are recorded as not-forced, not silently 'checked' ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"states":["default","empty"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":3}]}') \
  --routes "/clean.html" --out-dir "$WORK/nf" --no-screenshots >"$WORK/nf.out" 2>&1
EC=$?
if python3 - "$WORK/nf/coverage.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))["matrix"]
by = {c["state"]: c["status"] for c in m}
assert by.get("default") == "checked", by
assert by.get("empty") == "not-forced", by
PY
then
  pass "unmockable data state recorded as not-forced"
else
  fail "unmockable data state recorded as not-forced" "$(cat "$WORK/nf/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 300)"
fi
# clean.html has no Fail, but the not-forced cell is still unverified and must block completion.
assert_exit "not-forced cell blocks completion" 1

# ---- rulesSkipped is unverified coverage, not a green audit ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config <(printf '{"auditConfig":{"polish":null},"themes":["dark"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"states":["default"],"scrollPositions":["top"]}') \
  --routes "/clean.html" --out-dir "$WORK/skipped" --no-screenshots >"$WORK/skipped.out" 2>&1
EC=$?
if python3 - "$WORK/skipped/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "error", cell
assert cell.get("rulesSkipped"), cell
assert any("designSystemDrift" in item for item in cell["rulesSkipped"]), cell
PY
then
  pass "rule exceptions are recorded as unverified coverage"
else
  fail "rule exceptions are recorded as unverified coverage" "$(cat "$WORK/skipped/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 500)"
fi
assert_exit "rulesSkipped blocks completion" 1

# ---- main-document response matching uses the navigated frame, not just any Document ----
if grep -q "p.frameId === nav.frameId" "$RUNNER"; then
  pass "CDP response filter matches navigated main frame"
else
  fail "CDP response filter matches navigated main frame" "Network.responseReceived must be filtered by Page.navigate frameId"
fi

# ---- Python helpers: aggregation parity + state interception proof ----
if python3 - "$HERE/../scripts/run-ui-audit.py" <<'PY'
import importlib.util, json, pathlib, sys
path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ui_splint_runner", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def finding(route, viewport, severity):
    return {
        "rule": "tapTarget", "selector": "button.target", "severity": severity,
        "message": severity, "cell": {"route": route, "viewport": viewport, "theme": "light", "state": "default"},
    }

aggregated = mod.dedupe_global([
    finding("/one", "risk", "Risk"),
    finding("/one", "fail", "Fail"),
    finding("/two", "risk", "Risk"),
])
assert len(aggregated) == 2, aggregated
one = next(f for f in aggregated if f["cell"]["route"] == "/one")
assert one["severity"] == "Fail" and one["cell"]["viewport"] == "fail", one
assert {c["viewport"] for c in one["cells"]} == {"risk", "fail"}, one

class FakePage:
    def __init__(self): self.handler = None
    def unroute(self, pattern): self.handler = None
    def route(self, pattern, handler): self.handler = handler

class FakeRoute:
    def fulfill(self, **kwargs): self.fulfilled = kwargs

page = FakePage()
tracker = mod.apply_state_route(page, "empty", "**/api/**")
assert mod.state_coverage("empty", tracker, "**/api/**")[0] == "not-forced"
route = FakeRoute()
page.handler(route)
assert tracker["interceptions"] == 1 and route.fulfilled["body"] == "[]"
assert mod.state_coverage("empty", tracker, "**/api/**") == ("checked", None)

page = FakePage()
tracker = mod.apply_state_route(page, "stale", "**/api/**", {
    "stale": [{"pattern": "**/items", "status": 200, "contentType": "application/json", "body": {"stale": True}}]
})
route = FakeRoute()
page.handler(route)
assert tracker["driver"] == "configured-mock" and tracker["interceptions"] == 1
assert json.loads(route.fulfilled["body"])["stale"] is True
PY
then
  pass "Python aggregation and state interception helpers"
else
  fail "Python aggregation and state interception helpers" "helper contract failed"
fi

PROFILES_AFTER="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'uisplint-*' | wc -l)"
if [ "$PROFILES_AFTER" = "$PROFILES_BEFORE" ]; then
  pass "Chrome temporary profiles are removed"
else
  fail "Chrome temporary profiles are removed" "before=$PROFILES_BEFORE after=$PROFILES_AFTER"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
