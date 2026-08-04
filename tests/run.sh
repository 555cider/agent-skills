#!/usr/bin/env bash
# Self-contained regression checks for the zero-dependency ui-audit runner.
#
# Run: bash skills/ui-audit/tests/run.sh
set -u
export UI_SPLINT_SETTLE_MS=0

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../scripts/audit-chrome.mjs"
RULE_COVERAGE="$HERE/../scripts/rule-coverage.mjs"
PY_RUNNER="$HERE/../scripts/run-ui-audit.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ui-audit-tests.XXXXXX")"
PROFILES_BEFORE="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'uisplint-*' | wc -l)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

# Write a config literal to a real file and echo its path. Process substitution
# (`--config <(printf ...)`) yields /proc/<pid>/fd/N, which Node on Windows
# resolves to C:\proc\... and cannot open, so every such run died with exit 2.
CONFIG_SEQ=0
config_file() {
  CONFIG_SEQ=$((CONFIG_SEQ + 1))
  printf '%s' "$1" >"$WORK/config-$CONFIG_SEQ.json"
  printf '%s' "$WORK/config-$CONFIG_SEQ.json"
}

assert_exit() {
  if [ "$EC" = "$2" ]; then
    pass "$1 [exit $2]"
  else
    fail "$1" "expected exit $2, got $EC (output: $(cat "$WORK/out" 2>/dev/null | tr '\n' '|' | head -c 300))"
  fi
}

set +e
node --input-type=module - "$RULE_COVERAGE" >"$WORK/out" 2>"$WORK/err" <<'JS'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { assessRuleCoverage } = await import(pathToFileURL(process.argv[2]).href);
const top = assessRuleCoverage({
  rulesExpected: ['documentRule', 'viewportRule'],
  rulesRun: ['documentRule', 'viewportRule'],
  rulesSkipped: [],
}, { scroll: 'top', phase: 'all' });
assert.equal(top.status, 'checked');

// A top-page union contains viewportRule, but that must not mask its omission
// from the independent bottom/viewport report.
const bottom = assessRuleCoverage({
  rulesExpected: ['viewportRule'],
  rulesRun: [],
  rulesSkipped: [],
}, { scroll: 'bottom', phase: 'viewport' });
assert.equal(bottom.status, 'error');
assert.deepEqual(bottom.rulesMissing, ['viewportRule']);
assert.match(bottom.error, /did not run/);

const missingManifest = assessRuleCoverage({ rulesRun: ['viewportRule'] }, { scroll: 'bottom', phase: 'viewport' });
assert.equal(missingManifest.status, 'error');
assert.match(missingManifest.error, /rulesExpected/);

const missingRun = assessRuleCoverage({ rulesExpected: ['viewportRule'] }, { scroll: 'bottom', phase: 'viewport' });
assert.equal(missingRun.status, 'error');
assert.match(missingRun.error, /rulesRun/);

const missingSkipped = assessRuleCoverage({
  rulesExpected: ['viewportRule'],
  rulesRun: ['viewportRule'],
}, { scroll: 'bottom', phase: 'viewport' });
assert.equal(missingSkipped.status, 'error');
assert.match(missingSkipped.error, /rulesSkipped/);

const skipped = assessRuleCoverage({
  rulesExpected: ['viewportRule'],
  rulesRun: [],
  rulesSkipped: ['viewportRule: boom'],
}, { scroll: 'bottom', phase: 'viewport' });
assert.equal(skipped.status, 'error');
assert.deepEqual(skipped.rulesSkipped, ['viewportRule: boom']);
JS
EC=$?
set -e
assert_exit "each scroll report proves its own audit rule coverage" 0

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

# ---- empty matrix axes are invalid configuration, not a zero-cell green audit ----
for AXIS in routes viewports themes states scrollPositions; do
  ROUTES='["/clean.html"]'
  VIEWPORTS='[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}]'
  THEMES='["light"]'
  STATES='["default"]'
  SCROLL_POSITIONS='["top"]'
  case "$AXIS" in
    routes) ROUTES='[]' ;;
    viewports) VIEWPORTS='[]' ;;
    themes) THEMES='[]' ;;
    states) STATES='[]' ;;
    scrollPositions) SCROLL_POSITIONS='[]' ;;
  esac
  printf '{"routes":%s,"viewports":%s,"themes":%s,"states":%s,"scrollPositions":%s}\n' \
    "$ROUTES" "$VIEWPORTS" "$THEMES" "$STATES" "$SCROLL_POSITIONS" >"$WORK/empty-$AXIS.json"
  set +e
  node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/empty-$AXIS.json" \
    --out-dir "$WORK/empty-$AXIS" --no-screenshots >"$WORK/out" 2>"$WORK/err"
  EC=$?
  set -e
  assert_exit "empty $AXIS configuration is rejected" 2
  if grep -qF "$AXIS must be a non-empty array" "$WORK/err"; then
    pass "empty $AXIS reports an actionable configuration error"
  else
    fail "empty $AXIS reports an actionable configuration error" "$(cat "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300)"
  fi
done

printf '%s\n' '{"routes":[""],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"themes":["light"],"states":["default"],"scrollPositions":["top"]}' >"$WORK/invalid-route.json"
set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/invalid-route.json" --out-dir "$WORK/invalid-route" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "invalid route entry is rejected" 2
if grep -qF "routes[0] must be a non-empty string" "$WORK/err"; then pass "invalid route entry identifies its index"; else fail "invalid route entry identifies its index" "$(cat "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300)"; fi

for INVALID_MOCK in minMatches method; do
  if [ "$INVALID_MOCK" = "minMatches" ]; then
    RULE='{"pattern":"**/api/items","minMatches":0,"body":[]}'
    EXPECTED='stateMocks.default[0].minMatches must be an integer of at least 1'
  else
    RULE='{"pattern":"**/api/items","method":"GET POST","body":[]}'
    EXPECTED='stateMocks.default[0].method is invalid'
  fi
  printf '{"routes":["/clean.html"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"themes":["light"],"states":["default"],"scrollPositions":["top"],"stateMocks":{"default":[%s]}}\n' "$RULE" >"$WORK/invalid-mock-$INVALID_MOCK.json"
  set +e
  node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/invalid-mock-$INVALID_MOCK.json" --out-dir "$WORK/invalid-mock-$INVALID_MOCK" --no-screenshots >"$WORK/out" 2>"$WORK/err"
  EC=$?
  set -e
  assert_exit "invalid state mock $INVALID_MOCK is rejected before Chrome" 2
  if grep -qF "$EXPECTED" "$WORK/err"; then pass "invalid state mock $INVALID_MOCK reports its rule"; else fail "invalid state mock $INVALID_MOCK reports its rule" "$(cat "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300)"; fi
done

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
assert cell["hoverProbe"]["status"] == "not-applicable", cell
PY
then pass "theme init script records verified driver and mobile hover is not applicable"; else fail "theme init script records verified driver and mobile hover is not applicable" "invalid coverage"; fi

cat >"$WORK/theme-missing-init.json" <<'EOF'
{"routes":["/clean.html"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"themes":["app-dark"],"states":["default"],"scrollPositions":["top"]}
EOF
set +e
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/theme-missing-init.json" --out-dir "$WORK/theme-missing-init" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
set -e
assert_exit "custom theme without an init script is rejected" 2
if grep -qF "themeInitScripts.app-dark" "$WORK/err"; then pass "missing custom theme driver reports the theme name"; else fail "missing custom theme driver reports the theme name" "$(cat "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300)"; fi

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
import os
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
        "adaptations": fixture.get("adaptations", []),
        "workers": 2,
        "scrollPositions": ["top", "bottom"],
    }
    if fixture.get("stateSetups"):
        config["stateSetups"] = fixture["stateSetups"]
    if fixture.get("auditConfig"):
        config["auditConfig"] = fixture["auditConfig"]
    cfg_path = work / (file_name + ".json")
    cfg_path.write_text(json.dumps(config), encoding="utf-8")
    run_env = os.environ.copy()
    run_env["UI_SPLINT_SETTLE_MS"] = "350" if file_name == "kitchensink.html" else "0"
    result = subprocess.run(
        ["node", str(runner), base, "--config", str(cfg_path), "--out-dir", str(out_dir), "--no-screenshots"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=run_env,
    )
    if result.returncode not in (0, 1):
        errors.append(f"{file_name}: runner exited {result.returncode}\n{result.stderr or result.stdout}")
        continue

    findings_path = out_dir / "findings.json"
    advisories_path = out_dir / "advisories.json"
    coverage_path = out_dir / "coverage.json"
    if not findings_path.exists() or not advisories_path.exists() or not coverage_path.exists():
        errors.append(f"{file_name}: missing findings/advisories/coverage output")
        continue

    findings_doc = json.loads(findings_path.read_text(encoding="utf-8"))
    advisories_doc = json.loads(advisories_path.read_text(encoding="utf-8"))
    findings = findings_doc["findings"]
    advisories = advisories_doc["advisories"]
    coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
    if findings_doc.get("schemaVersion") != 2 or advisories_doc.get("schemaVersion") != 2 or coverage.get("schemaVersion") != 2:
        errors.append(f"{file_name}: outputs are not schema v2")
    bad_cells = [c for c in coverage.get("matrix", []) if c.get("status") != "checked"]
    if bad_cells:
        errors.append(f"{file_name}: unverified coverage cells {bad_cells!r}")
    expected_positions = config["scrollPositions"]
    expected_phases = ["all"] + ["viewport"] * (len(expected_positions) - 1)
    for cell in coverage.get("matrix", []):
        reports = cell.get("ruleCoverage")
        if not isinstance(reports, list):
            errors.append(f"{file_name}: cell omitted per-report ruleCoverage")
            continue
        if [report.get("scroll") for report in reports] != expected_positions:
            errors.append(f"{file_name}: ruleCoverage scroll sequence is incomplete: {reports!r}")
        if [report.get("phase") for report in reports] != expected_phases:
            errors.append(f"{file_name}: ruleCoverage phase sequence is incomplete: {reports!r}")
        incomplete_reports = [report for report in reports if report.get("status") != "checked"]
        if incomplete_reports:
            errors.append(f"{file_name}: incomplete audit reports {incomplete_reports!r}")

    # An un-baselined Fail, an unverified cell, or unresolved required review gates completion.
    has_fail = any(f.get("severity") == "Fail" for f in findings)
    has_required = any(a.get("review") == "required" for a in advisories)
    expected_exit = 1 if (has_fail or has_required or bad_cells) else 0
    if result.returncode != expected_exit:
        worst = "Fail" if has_fail else ("required-review" if has_required else ("unverified" if bad_cells else "optional/none"))
        errors.append(f"{file_name}: exit {result.returncode} but expected {expected_exit} (worst signal: {worst})")

    if fixture.get("expectZeroFindings") and findings:
        rules = ", ".join(sorted({f.get("rule", "?") for f in findings}))
        errors.append(f"{file_name}: expected zero findings, got {len(findings)} ({rules})")
    if fixture.get("expectZeroAdvisories") and advisories:
        rules = ", ".join(sorted({f.get("rule", "?") for f in advisories}))
        errors.append(f"{file_name}: expected zero advisories, got {len(advisories)} ({rules})")

    def assert_present(contract, signals, channel):
      for must in contract:
        rule = must["rule"]
        needle = must.get("matches")
        want_sev = must.get("severity")
        want_conf = must.get("confidence")
        want_review = must.get("review")
        matched = False
        sev_mismatch = None
        for signal in signals:
            if signal.get("rule") != rule:
                continue
            blob = json.dumps(signal, ensure_ascii=False)
            if needle and needle not in blob:
                continue
            if want_sev and signal.get("severity") != want_sev:
                sev_mismatch = f"severity {signal.get('severity')!r} != {want_sev!r}"
                continue
            if want_conf and signal.get("confidence") != want_conf:
                sev_mismatch = f"confidence {signal.get('confidence')!r} != {want_conf!r}"
                continue
            if want_review and signal.get("review") != want_review:
                sev_mismatch = f"review {signal.get('review')!r} != {want_review!r}"
                continue
            matched = True
            break
        if not matched:
            detail = f" matching {needle!r}" if needle else ""
            if sev_mismatch:
                detail += f" [{sev_mismatch}]"
            rules = ", ".join(sorted({f.get("rule", "?") for f in signals}))
            errors.append(f"{file_name}: missing {channel} {rule}{detail}; saw [{rules}]")

    def assert_absent(contract, signals, channel):
      for forbidden in contract:
        if isinstance(forbidden, str):
            forbidden = {"rule": forbidden}
        rule = forbidden["rule"]
        needle = forbidden.get("matches")
        for signal in signals:
            if signal.get("rule") != rule:
                continue
            if needle and needle not in json.dumps(signal, ensure_ascii=False):
                continue
            errors.append(f"{file_name}: forbidden {channel} {rule}{' matching ' + repr(needle) if needle else ''} fired")
            break

    assert_present(fixture.get("mustHit", []), findings, "finding")
    assert_present(fixture.get("mustAdvise", []), advisories, "advisory")
    assert_absent(fixture.get("mustNotHit", []), findings, "finding")
    assert_absent(fixture.get("mustNotAdvise", []), advisories, "advisory")

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
  "adaptations": [],
  "scrollPositions": ["top"],
  "auditConfig": { "whitelist": [".wl"] }
}
EOF
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/wl.json" --out-dir "$WORK/wl" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/wl/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1], encoding="utf-8"))["findings"]
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
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/adbanners.html"],"adaptations":[]}')" --out-dir "$WORK/wl-off" --no-screenshots >/dev/null 2>&1
# MSYS2_ARG_CONV_EXCL: Git Bash rewrites a bare "/route.html" argv into
# "C:/Program Files/Git/route.html" before the runner sees it, which silently
# audits nothing. Excluding the route prefix leaves $RUNNER conversion intact.
MSYS2_ARG_CONV_EXCL='/adbanners.html' \
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/adbanners.html"],"adaptations":[],"auditConfig":{"whitelist":[".ad-banner"]}}')" \
  --routes "/adbanners.html" --out-dir "$WORK/wl-on" --no-screenshots >/dev/null 2>&1
if python3 - "$WORK/wl-off/findings.json" "$WORK/wl-on/findings.json" <<'PY'
import json, sys
off = json.load(open(sys.argv[1]))["findings"]
on = json.load(open(sys.argv[2]))["findings"]
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

# ---- optional advisory cap is fair across rules and records suppression ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/newcases.html"],"themes":["light"],"adaptations":[],"viewports":[{"name":"desktop","width":800,"height":600,"isMobile":false,"dpr":1}],"auditConfig":{"maxPolish":2}}')" \
  --out-dir "$WORK/advisory-cap" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/advisory-cap/advisories.json" "$WORK/advisory-cap/coverage.json" <<'PY'
import json, sys
advisories = json.load(open(sys.argv[1]))["advisories"]
optional = [item for item in advisories if item.get("review") == "optional"]
cell = json.load(open(sys.argv[2]))["matrix"][0]
assert len(optional) == 2 and len({item["rule"] for item in optional}) == 2, optional
assert cell["suppressed"]["advisoryCap"] > 0 and cell["suppressed"]["byRule"], cell
PY
then pass "optional advisory cap is fair and observable"; else fail "optional advisory cap is fair and observable" "cap contract failed"; fi

# ---- runner-generated keyboard findings honor whitelist and baseline ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"auditConfig":{"whitelist":["#covered-action"]}}')" \
  --out-dir "$WORK/keyboard-wl" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/keyboard-wl/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1]))["findings"]
assert not any(f.get("rule") == "focusObscured" for f in findings), findings
PY
then pass "keyboard findings honor whitelist"; else fail "keyboard findings honor whitelist" "focusObscured leaked"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"baseline":[{"rule":"focusObscured","selector":"button#covered-action"}]}')" \
  --out-dir "$WORK/keyboard-base" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/keyboard-base/findings.json" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1]))["findings"]
assert not any(f.get("rule") == "focusObscured" for f in findings), findings
PY
then pass "keyboard findings honor baseline"; else fail "keyboard findings honor baseline" "focusObscured leaked"; fi

# ---- runner-generated pointer findings honor whitelist and baseline ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/interaction-layout.html"],"themes":["light"],"adaptations":[],"viewports":[{"name":"desktop","width":1280,"height":800,"isMobile":false,"dpr":1}],"auditConfig":{"whitelist":["#search-action","#sort-order"]}}')" \
  --out-dir "$WORK/pointer-wl" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/pointer-wl/advisories.json" <<'PY'
import json, sys
advisories = json.load(open(sys.argv[1]))["advisories"]
assert not any(f.get("rule") == "missingHoverFeedback" for f in advisories), advisories
PY
then pass "pointer findings honor whitelist"; else fail "pointer findings honor whitelist" "missingHoverFeedback leaked"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/interaction-layout.html"],"themes":["light"],"adaptations":[],"viewports":[{"name":"desktop","width":1280,"height":800,"isMobile":false,"dpr":1}],"baseline":[{"rule":"missingHoverFeedback","selector":"#search-action"},{"rule":"missingHoverFeedback","selector":"#sort-order"}]}')" \
  --out-dir "$WORK/pointer-base" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/pointer-base/advisories.json" <<'PY'
import json, sys
advisories = json.load(open(sys.argv[1]))["advisories"]
assert not any(f.get("rule") == "missingHoverFeedback" for f in advisories), advisories
PY
then pass "pointer findings honor baseline"; else fail "pointer findings honor baseline" "missingHoverFeedback leaked"; fi

# ---- bounded traversal and setup failures remain honest coverage errors ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/focus-obscured.html"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"keyboardProbe":{"maxSteps":1,"settleMs":0}}')" \
  --out-dir "$WORK/keyboard-cap" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "keyboard traversal cap blocks completion" 1
if python3 - "$WORK/keyboard-cap/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "error" and cell["keyboardProbe"]["status"] == "incomplete", cell
PY
then pass "keyboard cap is recorded in coverage"; else fail "keyboard cap is recorded in coverage" "missing incomplete proof"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/hover-valid.html"],"themes":["light"],"adaptations":[],"viewports":[{"name":"desktop","width":1280,"height":800,"isMobile":false,"dpr":1}],"hoverProbe":{"maxTargets":1,"settleMs":0,"maxWaitMs":0,"denseGapPx":12}}')" \
  --out-dir "$WORK/pointer-cap" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "pointer target cap blocks completion" 1
if python3 - "$WORK/pointer-cap/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "error" and cell["hoverProbe"]["status"] == "incomplete", cell
assert cell["hoverProbe"]["checked"] == 1 and cell["hoverProbe"]["expected"] == 4, cell
PY
then pass "pointer cap is recorded in coverage"; else fail "pointer cap is recorded in coverage" "missing incomplete proof"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/state-setup-modal.html"],"themes":["light"],"states":["dialog-open"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateSetups":{"dialog-open":{"actions":[{"type":"click","selector":"#missing"}],"expect":[{"selector":"[role=dialog]","state":"visible"}]}}}')" \
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
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/context-isolation.html"],"themes":["light"],"states":["one","two"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateSetups":{"one":{"expect":[{"selector":".fresh","state":"visible"}]},"two":{"expect":[{"selector":".fresh","state":"visible"}]}}}')" \
  --out-dir "$WORK/context-isolation" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/context-isolation/coverage.json" <<'PY'
import json, sys
cells = json.load(open(sys.argv[1]))["matrix"]
assert len(cells) == 2 and all(c["status"] == "checked" for c in cells), cells
PY
then pass "browser storage is isolated per matrix cell"; else fail "browser storage is isolated per matrix cell" "storage leaked"; fi

# ---- worker concurrency preserves deterministic ordering and results ----
printf '%s' '{"routes":["/clean.html"],"themes":["light","dark"],"states":["default"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"workers":1}' >"$WORK/workers-1.json"
printf '%s' '{"routes":["/clean.html"],"themes":["light","dark"],"states":["default"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"workers":2}' >"$WORK/workers-2.json"
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/workers-1.json" --out-dir "$WORK/workers-1" --no-screenshots >"$WORK/out" 2>"$WORK/err"
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$WORK/workers-2.json" --out-dir "$WORK/workers-2" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/workers-1" "$WORK/workers-2" <<'PY'
import json, pathlib, sys
left, right = map(pathlib.Path, sys.argv[1:])
for name in ("findings.json", "advisories.json"):
    assert json.loads((left / name).read_text()) == json.loads((right / name).read_text()), name
def cells(path):
    data = json.loads((path / "coverage.json").read_text())
    return [(c["index"], c["route"], c["viewport"], c["theme"], c["state"], c["adaptation"], c["status"]) for c in data["matrix"]]
assert cells(left) == cells(right), (cells(left), cells(right))
PY
then pass "workers=1 and workers=2 produce deterministic outputs"; else fail "workers=1 and workers=2 produce deterministic outputs" "output mismatch"; fi

# ---- non-default data states are recorded as not-forced, not silently 'checked' ----
MSYS2_ARG_CONV_EXCL='/clean.html' \
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"states":["default","empty"],"themes":["light"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":3}]}')" \
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

# ---- explicit CDP Fetch state mock records configured interception proof ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/state-mock.html"],"states":["stale"],"themes":["light"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateMocks":{"stale":[{"pattern":"**/api/items","status":200,"contentType":"application/json","body":[]}]}}')" \
  --out-dir "$WORK/configured-mock" --no-screenshots >"$WORK/out" 2>"$WORK/err"
if python3 - "$WORK/configured-mock/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "checked", cell
assert cell["stateDriver"] == "configured-mock" and cell["interceptions"] == 1, cell
assert cell["rulesExpected"] and set(cell["rulesExpected"]) == set(cell["rulesRun"]), cell
proof = cell["stateMock"]
assert proof["status"] == "checked", proof
assert proof["rules"] == [{
    "pattern": "**/api/items",
    "method": "any",
    "minMatches": 1,
    "matches": 1,
    "held": 0,
    "status": "checked",
}], proof
PY
then pass "configured CDP state mock is proven by interception"; else fail "configured CDP state mock is proven by interception" "missing configured proof"; fi

# ---- every explicit mock rule must independently prove its declared contract ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/state-mock.html"],"states":["partial"],"themes":["light"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateMocks":{"partial":[{"pattern":"**/api/items","body":[]},{"pattern":"**/api/summary","body":{}}]}}')" \
  --out-dir "$WORK/partial-mock" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "partially matched explicit state mock blocks completion" 1
if python3 - "$WORK/partial-mock/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["status"] == "not-forced", cell
assert cell["interceptions"] == 1, cell
rules = cell["stateMock"]["rules"]
assert [rule["matches"] for rule in rules] == [1, 0], rules
assert [rule["status"] for rule in rules] == ["checked", "not-forced"], rules
assert cell["stateMock"]["status"] == "not-forced", cell
PY
then pass "partial state mock coverage identifies the unmatched rule"; else fail "partial state mock coverage identifies the unmatched rule" "$(cat "$WORK/partial-mock/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 500)"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/state-mock.html"],"states":["method"],"themes":["light"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateMocks":{"method":[{"pattern":"**/api/items","method":"POST","body":[]}]}}')" \
  --out-dir "$WORK/method-mock" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "state mock method mismatch blocks completion" 1
if python3 - "$WORK/method-mock/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
rule = cell["stateMock"]["rules"][0]
assert cell["status"] == "not-forced" and cell["interceptions"] == 0, cell
assert rule["method"] == "POST" and rule["matches"] == 0 and rule["status"] == "not-forced", rule
PY
then pass "state mock proof preserves method-specific mismatch"; else fail "state mock proof preserves method-specific mismatch" "$(cat "$WORK/method-mock/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 500)"; fi

node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/state-mock.html"],"states":["density"],"themes":["light"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateMocks":{"density":[{"pattern":"**/api/items","minMatches":2,"body":[]}]}}')" \
  --out-dir "$WORK/min-matches-mock" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "state mock below minMatches blocks completion" 1
if python3 - "$WORK/min-matches-mock/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
rule = cell["stateMock"]["rules"][0]
assert cell["status"] == "not-forced", cell
assert rule["minMatches"] == 2 and rule["matches"] == 1 and rule["status"] == "not-forced", rule
PY
then pass "state mock proof enforces minMatches"; else fail "state mock proof enforces minMatches" "$(cat "$WORK/min-matches-mock/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 500)"; fi

# The default state is only implicit when no explicit mock contract was declared.
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/clean.html"],"states":["default"],"themes":["light"],"adaptations":[],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"stateMocks":{"default":[{"pattern":"**/api/missing","body":[]}]}}')" \
  --out-dir "$WORK/default-explicit-mock" --no-screenshots >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "unmatched explicit default-state mock blocks completion" 1
if python3 - "$WORK/default-explicit-mock/coverage.json" <<'PY'
import json, sys
cell = json.load(open(sys.argv[1]))["matrix"][0]
assert cell["state"] == "default" and cell["status"] == "not-forced", cell
assert cell["stateMock"]["status"] == "not-forced", cell
PY
then pass "explicit default-state mock requires proof"; else fail "explicit default-state mock requires proof" "$(cat "$WORK/default-explicit-mock/coverage.json" 2>/dev/null | tr '\n' '|' | head -c 500)"; fi

# ---- rulesSkipped is unverified coverage, not a green audit ----
MSYS2_ARG_CONV_EXCL='/clean.html' \
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"auditConfig":{"polish":null},"themes":["dark"],"viewports":[{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}],"states":["default"],"scrollPositions":["top"]}')" \
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
if grep -q "item.frameId === nav.frameId" "$RUNNER"; then
  pass "CDP response filter matches navigated main frame"
else
  fail "CDP response filter matches navigated main frame" "Network.responseReceived must be filtered by Page.navigate frameId"
fi

# ---- Python entrypoint is a thin compatibility shim to the Node implementation ----
if python3 - "$HERE/../scripts/run-ui-audit.py" <<'PY'
import importlib.util, pathlib, sys
path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ui_splint_runner", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.NODE_RUNNER.name == "audit-chrome.mjs"
assert "playwright" not in path.read_text(encoding="utf-8").lower()
assert callable(mod.main)
PY
then
  pass "Python compatibility shim delegates to Node"
else
  fail "Python compatibility shim delegates to Node" "shim contract failed"
fi

# ---- the usage contract requires both reachable and realistically dense states ----
SKILL_DOC="$HERE/../SKILL.md"
if grep -qF "Data presence also does not prove data density." "$SKILL_DOC"; then
  pass "skill distinguishes populated DOM from data density"
else
  fail "skill distinguishes populated DOM from data density" "missing density-proof contract"
fi
if grep -qF "Treat interaction reachability and content density as separate matrix requirements" "$SKILL_DOC"; then
  pass "skill requires independent reachability and density proof"
else
  fail "skill requires independent reachability and density proof" "missing orthogonal state requirements"
fi
if grep -qF "The final response also does not prove asynchronous mutation feedback." "$SKILL_DOC"; then
  pass "skill distinguishes final state from mutation pending feedback"
else
  fail "skill distinguishes final state from mutation pending feedback" "missing async mutation contract"
fi
if grep -qF "add a functional interaction test for request count" "$SKILL_DOC"; then
  pass "skill requires functional duplicate-submission proof"
else
  fail "skill requires functional duplicate-submission proof" "missing single-flight test contract"
fi

PROFILES_AFTER=""
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  PROFILES_AFTER="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'uisplint-*' | wc -l)"
  [ "$PROFILES_AFTER" = "$PROFILES_BEFORE" ] && break
  sleep 0.1
done
if [ "$PROFILES_AFTER" = "$PROFILES_BEFORE" ]; then
  pass "Chrome temporary profiles are removed"
else
  fail "Chrome temporary profiles are removed" "before=$PROFILES_BEFORE after=$PROFILES_AFTER"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
