#!/usr/bin/env bash
# Self-contained regression checks for the zero-dependency ui-audit runner.
#
# Run: bash skills/ui-audit/tests/run.sh
set -u
export UI_AUDIT_SETTLE_MS=0

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/../scripts/audit-chrome.mjs"
RULE_COVERAGE="$HERE/../scripts/rule-coverage.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ui-audit-tests.XXXXXX")"
PROFILES_BEFORE="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'ui-audit-profile-*' | wc -l)"
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
    fail "$1" "expected exit $2, got $EC (output: $(cat "$WORK/out" "$WORK/err" 2>/dev/null | tr '\n' '|' | head -c 300))"
  fi
}

# Run the audit against the fixture server; the exit code lands in EC.
audit() { # out-dir-name, config-path, extra args...
  local name="$1" cfg="$2"
  shift 2
  node "$RUNNER" "http://127.0.0.1:$PORT" --config "$cfg" --out-dir "$WORK/$name" --no-screenshots "$@" >"$WORK/out" 2>"$WORK/err"
  EC=$?
}

# Assert a Python expression block over coverage/findings/advisories of one run.
check_py() { # label, out-dir-name, python body (cov, findings, advisories in scope)
  if python3 - "$WORK/$2" "$3" >"$WORK/py.out" 2>&1 <<'PY'
import json, pathlib, sys
d = pathlib.Path(sys.argv[1])
def load(name, key=None):
    p = d / name
    if not p.exists():
        return None
    data = json.loads(p.read_text(encoding="utf-8"))
    return data[key] if key else data
cov = load("coverage.json")
findings = load("findings.json", "findings") or []
advisories = load("advisories.json", "advisories") or []
cells = cov["matrix"] if cov else []
exec(sys.argv[2])
PY
  then pass "$1"; else fail "$1" "$(tr '\n' '|' <"$WORK/py.out" | head -c 500)"; fi
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

const missingManifest = assessRuleCoverage({ rulesRun: ['viewportRule'] }, { scroll: 'bottom', phase: 'viewport' });
assert.equal(missingManifest.status, 'error');
JS
EC=$?
assert_exit "each scroll report proves its own audit rule coverage" 0

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HERE/fixtures" >"$WORK/http.log" 2>&1 &
SERVER_PID=$!
# Poll the port instead of a fixed sleep (flaky on slow/loaded CI).
if python3 -c '
import socket, sys, time
deadline = time.time() + 10
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=0.5):
            sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit(1)' "$PORT"
then :; else
  echo "FAIL  http server did not come up on port $PORT" >&2
  exit 1
fi

M_VP='{"name":"m","width":390,"height":844,"isMobile":true,"dpr":1}'
D_VP='{"name":"desktop","width":1280,"height":800,"isMobile":false,"dpr":1}'
BASE_CFG="\"themes\":[\"light\"],\"states\":[\"default\"],\"adaptations\":[],\"scrollPositions\":[\"top\"]"

# ---- fixture contract: fixtures that share a matrix run in one browser ----
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

def matrix_of(fixture):
    viewport = fixture["viewport"]
    return {
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
        **({"stateSetups": fixture["stateSetups"]} if fixture.get("stateSetups") else {}),
        **({"auditConfig": fixture["auditConfig"]} if fixture.get("auditConfig") else {}),
    }

groups = {}
for fixture in expected:
    key = json.dumps(matrix_of(fixture), sort_keys=True)
    groups.setdefault(key, []).append(fixture)

def assert_present(file_name, contract, signals, channel):
    for must in contract:
        rule = must["rule"]
        needle = must.get("matches")
        matched = False
        mismatch = None
        for signal in signals:
            if signal.get("rule") != rule:
                continue
            if needle and needle not in json.dumps(signal, ensure_ascii=False):
                continue
            for field in ("severity", "confidence", "review"):
                if must.get(field) and signal.get(field) != must[field]:
                    mismatch = f"{field} {signal.get(field)!r} != {must[field]!r}"
                    break
            else:
                matched = True
                break
        if not matched:
            detail = f" matching {needle!r}" if needle else ""
            if mismatch:
                detail += f" [{mismatch}]"
            rules = ", ".join(sorted({f.get("rule", "?") for f in signals}))
            errors.append(f"{file_name}: missing {channel} {rule}{detail}; saw [{rules}]")

def assert_absent(file_name, contract, signals, channel):
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

for index, (key, fixtures) in enumerate(groups.items()):
    config = json.loads(key)
    config["routes"] = ["/" + fixture["file"] for fixture in fixtures]
    names = ",".join(fixture["file"] for fixture in fixtures)
    out_dir = work / f"contract-{index}"
    cfg_path = work / f"contract-{index}.json"
    cfg_path.write_text(json.dumps(config), encoding="utf-8")
    run_env = os.environ.copy()
    run_env["UI_AUDIT_SETTLE_MS"] = "350" if any(f["file"] == "kitchensink.html" for f in fixtures) else "0"
    result = subprocess.run(
        ["node", str(runner), base, "--config", str(cfg_path), "--out-dir", str(out_dir), "--no-screenshots"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=run_env,
    )
    if result.returncode not in (0, 1):
        errors.append(f"{names}: runner exited {result.returncode}\n{result.stderr or result.stdout}")
        continue
    try:
        findings_doc = json.loads((out_dir / "findings.json").read_text(encoding="utf-8"))
        advisories_doc = json.loads((out_dir / "advisories.json").read_text(encoding="utf-8"))
        coverage = json.loads((out_dir / "coverage.json").read_text(encoding="utf-8"))
    except OSError:
        errors.append(f"{names}: missing findings/advisories/coverage output")
        continue
    if {findings_doc.get("schemaVersion"), advisories_doc.get("schemaVersion"), coverage.get("schemaVersion")} != {2}:
        errors.append(f"{names}: outputs are not schema v2")
    findings = findings_doc["findings"]
    advisories = advisories_doc["advisories"]
    bad_cells = [c for c in coverage.get("matrix", []) if c.get("status") != "checked"]
    if bad_cells:
        errors.append(f"{names}: unverified coverage cells {bad_cells!r}")
    for cell in coverage.get("matrix", []):
        reports = cell.get("ruleCoverage") or []
        if [report.get("scroll") for report in reports] != config["scrollPositions"]:
            errors.append(f"{names}: ruleCoverage scroll sequence is incomplete: {reports!r}")
        if any(report.get("status") != "checked" for report in reports):
            errors.append(f"{names}: incomplete audit reports {reports!r}")

    # An un-baselined Fail, an unverified cell, or unresolved required review gates completion.
    has_fail = any(f.get("severity") == "Fail" for f in findings)
    has_required = any(a.get("review") == "required" for a in advisories)
    expected_exit = 1 if (has_fail or has_required or bad_cells) else 0
    if result.returncode != expected_exit:
        errors.append(f"{names}: exit {result.returncode} but expected {expected_exit}")

    for fixture in fixtures:
        file_name = fixture["file"]
        route = "/" + file_name
        mine = lambda signals: [s for s in signals if (s.get("cell") or {}).get("route") == route]
        f_mine, a_mine = mine(findings), mine(advisories)
        if fixture.get("expectZeroFindings") and f_mine:
            errors.append(f"{file_name}: expected zero findings, got {sorted({f.get('rule') for f in f_mine})}")
        if fixture.get("expectZeroAdvisories") and a_mine:
            errors.append(f"{file_name}: expected zero advisories, got {sorted({f.get('rule') for f in a_mine})}")
        assert_present(file_name, fixture.get("mustHit", []), f_mine, "finding")
        assert_present(file_name, fixture.get("mustAdvise", []), a_mine, "advisory")
        assert_absent(file_name, fixture.get("mustNotHit", []), f_mine, "finding")
        assert_absent(file_name, fixture.get("mustNotAdvise", []), a_mine, "advisory")

print(f"{len(expected)} fixtures in {len(groups)} browser runs")
if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
PY
EC=$?
assert_exit "fixture contract matches expected.json ($(cat "$WORK/contract.out" 2>/dev/null))" 0
if [ "$EC" -ne 0 ]; then
  fail "fixture contract details" "$(cat "$WORK/contract.err" 2>/dev/null | tr '\n' '|' | head -c 1200)"
fi

# ---- a missing route is unverified coverage, not an empty green audit ----
audit missing-route "$(config_file "{\"routes\":[\"/missing.html\"],\"viewports\":[$M_VP],$BASE_CFG}")"
assert_exit "missing route blocks audit" 1
check_py "coverage records HTTP 404 as unverified" missing-route \
  'assert cells[0]["status"] == "error" and "HTTP 404" in cells[0]["error"], cells'

# ---- every static configuration error exits 2 before Chrome starts ----
UPLOAD_MISSING="$WORK/no-such-upload.bin"
for CASE in \
  'empty-routes|{"routes":[]}' \
  'theme-init|{"themes":["app-dark"]}' \
  'state-mock|{"stateMocks":{"default":[{"pattern":"**/api/items","minMatches":0,"body":[]}]}}' \
  "setup-upload|{\"stateSetups\":{\"open\":{\"actions\":[{\"type\":\"upload\",\"selector\":\"#a\",\"files\":[\"$UPLOAD_MISSING\"]}],\"expect\":[{\"selector\":\"#a\"}]}}}"; do
  NAME="${CASE%%|*}"; EXTRA="${CASE#*|}"
  CFG="$(config_file "$(node -e 'const extra=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify({routes:["/clean.html"],viewports:[{name:"m",width:390,height:844,isMobile:true,dpr:1}],themes:["light"],states:["default"],scrollPositions:["top"],...extra}))' "$EXTRA")")"
  audit "precheck-$NAME" "$CFG"
  [ -e "$WORK/precheck-$NAME/coverage.json" ] && EC="coverage written"
  assert_exit "invalid $NAME is a configuration error reported before Chrome launches" 2
done

# ---- a theme init script runs, and its failure blocks coverage ----
audit theme-error "$(config_file "{\"routes\":[\"/clean.html\"],\"viewports\":[$M_VP],\"themes\":[\"broken\"],\"states\":[\"default\"],\"scrollPositions\":[\"top\"],\"themeInitScripts\":{\"broken\":\"throw new Error('theme boom')\"}}")"
assert_exit "theme init failure blocks coverage" 1
check_py "theme init error is preserved" theme-error 'assert "theme boom" in cells[0]["error"], cells'

# ---- whitelist suppresses ALL matching instances and their subtree ----
# adbanners.html has two low-contrast `.ad-banner` slots. The buggy safeMatch only compared the
# first match of each selector, so it leaked every finding past the first whitelisted instance.
audit whitelist "$(config_file "{\"routes\":[\"/whitelist.html\",\"/adbanners.html\"],\"viewports\":[{\"name\":\"desktop\",\"width\":1280,\"height\":900,\"isMobile\":false,\"dpr\":1}],$BASE_CFG,\"auditConfig\":{\"whitelist\":[\".wl\",\".ad-banner\"]}}")"
check_py "whitelist suppresses every matching element and its subtree" whitelist '
contrast = [f for f in findings if f["rule"] == "effectiveContrast"]
assert any("other" in f["selector"] for f in contrast), f"un-whitelisted .other was not flagged: {contrast}"
leaked = [f["selector"] for f in findings if ".wl" in f["selector"] or ".ad-banner" in f["selector"]]
assert not leaked, f"whitelist leaked: {leaked}"'

# ---- runner-generated keyboard and pointer findings honor whitelist and baseline ----
audit runner-signals "$(config_file "{\"routes\":[\"/focus-obscured.html\",\"/interaction-layout.html\"],\"viewports\":[$M_VP,$D_VP],$BASE_CFG,\"auditConfig\":{\"whitelist\":[\"#covered-action\"]},\"baseline\":[{\"rule\":\"missingHoverFeedback\",\"selector\":\"#search-action\"},{\"rule\":\"missingHoverFeedback\",\"selector\":\"#sort-order\"}]}")"
check_py "keyboard findings honor whitelist and pointer findings honor baseline" runner-signals '
assert not any(f.get("rule") == "focusObscured" for f in findings), findings
assert not any(f.get("rule") == "missingHoverFeedback" for f in advisories), advisories'

# ---- bounded traversal and setup failures remain honest coverage errors ----
audit pointer-cap "$(config_file "{\"routes\":[\"/hover-valid.html\"],\"viewports\":[$D_VP],$BASE_CFG,\"hoverProbe\":{\"maxTargets\":1,\"settleMs\":0,\"maxWaitMs\":0,\"denseGapPx\":12}}")"
assert_exit "pointer target cap blocks completion" 1
check_py "pointer cap is recorded in coverage, with the default rendering path" pointer-cap '
cell = cells[0]
assert cell["status"] == "error" and cell["hoverProbe"]["status"] == "incomplete", cell
assert cell["hoverProbe"]["checked"] == 1 and cell["hoverProbe"]["expected"] == 4, cell
assert cov["runner"]["chrome"] == {"headed": False, "disableGpu": True, "args": ["--headless=new", "--disable-gpu"]}, cov["runner"]'

audit setup-error "$(config_file "{\"routes\":[\"/state-setup-modal.html\"],\"themes\":[\"light\"],\"states\":[\"dialog-open\"],\"viewports\":[$M_VP],\"stateSetups\":{\"dialog-open\":{\"actions\":[{\"type\":\"click\",\"selector\":\"#missing\"}],\"expect\":[{\"selector\":\"[role=dialog]\",\"state\":\"visible\"}]}}}")"
assert_exit "invalid state setup blocks completion" 1
check_py "state setup failure is recorded" setup-error 'assert cells[0]["status"] == "error" and "timed out" in cells[0]["error"], cells'

# ---- every cell gets an isolated browser context ----
audit context-isolation "$(config_file "{\"routes\":[\"/context-isolation.html\"],\"themes\":[\"light\"],\"states\":[\"one\",\"two\"],\"viewports\":[$M_VP],\"stateSetups\":{\"one\":{\"expect\":[{\"selector\":\".fresh\",\"state\":\"visible\"}]},\"two\":{\"expect\":[{\"selector\":\".fresh\",\"state\":\"visible\"}]}}}")"
check_py "browser storage is isolated per matrix cell" context-isolation \
  'assert len(cells) == 2 and all(c["status"] == "checked" for c in cells), cells'

# ---- data states: a mock is proven by interception, every rule separately; no mock is not-forced ----
audit state-mocks "$(config_file "{\"routes\":[\"/state-mock.html\"],\"states\":[\"stale\",\"partial\",\"unmocked\"],\"themes\":[\"light\"],\"adaptations\":[],\"viewports\":[$M_VP],\"stateMocks\":{\"stale\":[{\"pattern\":\"**/api/items\",\"status\":200,\"contentType\":\"application/json\",\"body\":[]}],\"partial\":[{\"pattern\":\"**/api/items\",\"body\":[]},{\"pattern\":\"**/api/summary\",\"body\":{}}]}}")"
assert_exit "an unproven data state blocks completion" 1
check_py "configured mock is proven, a partial mock names its unmatched rule, an unmocked state is not-forced" state-mocks '
by = {c["state"]: c for c in cells}
stale = by["stale"]
assert stale["status"] == "checked" and stale["stateDriver"] == "configured-mock" and stale["interceptions"] == 1, stale
assert stale["stateMock"]["rules"] == [{"pattern": "**/api/items", "method": "any", "minMatches": 1, "matches": 1, "held": 0, "status": "checked"}], stale
partial = by["partial"]
assert partial["status"] == "not-forced", partial
assert [r["status"] for r in partial["stateMock"]["rules"]] == ["checked", "not-forced"], partial
assert by["unmocked"]["status"] == "not-forced", by["unmocked"]'

# ---- rulesSkipped is unverified coverage, not a green audit ----
audit skipped "$(config_file "{\"routes\":[\"/clean.html\"],\"auditConfig\":{\"polish\":null},\"themes\":[\"dark\"],\"viewports\":[$M_VP],\"states\":[\"default\"],\"scrollPositions\":[\"top\"]}")"
assert_exit "rulesSkipped blocks completion" 1
check_py "rule exceptions are recorded as unverified coverage" skipped '
cell = cells[0]
assert cell["status"] == "error" and any("designSystemDrift" in item for item in cell.get("rulesSkipped", [])), cell'

# ---- CLI routes: a Git Bash install-root rewrite is undone, other shapes are refused ----
ROUTE_CFG="$(config_file "{\"viewports\":[$M_VP],$BASE_CFG}")"
MSYSTEM=MINGW64 EXEPATH='C:\Program Files\Git\bin' \
  audit msys-routes "$ROUTE_CFG" --routes 'C:/Program Files/Git/clean.html,hover-valid.html'
check_py "Git Bash route rewrite is undone and a bare route joins under the base URL" msys-routes \
  'assert [(c["route"], c["status"]) for c in cells] == [("/clean.html", "checked"), ("hover-valid.html", "checked")], cells'
MSYSTEM=MINGW64 EXEPATH='C:\Program Files\Git\bin' \
  audit msys-bad "$ROUTE_CFG" --routes 'D:/elsewhere/settings'
assert_exit "an unrecoverable Git Bash route rewrite is refused" 2

# ---- phone cells are touch-emulated; typed keys run the browser default action ----
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file "{\"routes\":[\"/runner-input.html\"],\"themes\":[\"light\"],\"adaptations\":[],\"viewports\":[{\"name\":\"m\",\"width\":390,\"height\":844,\"isMobile\":true,\"dpr\":3}],\"states\":[\"touch\",\"press-enter\"],\"stateSetups\":{\"touch\":{\"expect\":[{\"selector\":\"html[data-pointer=coarse][data-hover=none][data-touch=yes][data-inner-height=\\\"844\\\"]\",\"state\":\"attached\"}]},\"press-enter\":{\"actions\":[{\"type\":\"press\",\"selector\":\"#enter-target\",\"key\":\"Enter\"}],\"expect\":[{\"selector\":\"#enter-panel\",\"state\":\"visible\"}]}}}")" \
  --out-dir "$WORK/runner-input-mobile" >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "touch emulation and an Enter press reach their states" 0
# Desktop: no touch points, and screenshots include a full-page capture taller than the viewport.
mkdir -p "$WORK/runner-input-desktop/screens"
: >"$WORK/runner-input-desktop/screens/stale_m_light_default_none_top.png"
: >"$WORK/runner-input-desktop/screens/notes.txt"
node "$RUNNER" "http://127.0.0.1:$PORT" --config "$(config_file '{"routes":["/runner-input.html"],"themes":["light"],"adaptations":[],"viewports":[{"name":"d","width":1280,"height":900,"isMobile":false,"dpr":1}],"states":["desk"],"stateSetups":{"desk":{"expect":[{"selector":"html[data-touch=no][data-inner-height=\"900\"]","state":"attached"}]}}}')" \
  --out-dir "$WORK/runner-input-desktop" >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "desktop cell keeps a mouse-only device" 0
SCREENS="$WORK/runner-input-desktop/screens"
if node -e 'const fs=require("fs"),p=require("path"),d=process.argv[1];const png=fs.readFileSync(p.join(d,"runner-input.html_d_light_desk_none_full.png"));if(png.readUInt32BE(20)<=900)throw new Error("full-page height "+png.readUInt32BE(20));for(const f of ["runner-input.html_d_light_desk_none_top.png","notes.txt"])if(!fs.existsSync(p.join(d,f)))throw new Error("missing "+f);if(fs.existsSync(p.join(d,"stale_m_light_default_none_top.png")))throw new Error("stale screenshot kept");for(const run of ["runner-input-desktop","runner-input-mobile"])for(const cell of require(p.join(d,"..","..",run,"coverage.json")).matrix)if(cell.fullPageScreenshot?.status!=="captured")throw new Error(run+" "+JSON.stringify(cell.fullPageScreenshot))' "$SCREENS" 2>"$WORK/err"; then
  pass "full-page screenshot is captured, stale runner screenshots are cleared, other files are kept"
else
  fail "full-page screenshot is captured, stale runner screenshots are cleared, other files are kept" "$(head -c 300 "$WORK/err")"
fi

PROFILES_AFTER=""
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  PROFILES_AFTER="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'ui-audit-profile-*' | wc -l)"
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
