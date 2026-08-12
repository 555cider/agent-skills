#!/usr/bin/env bash
# Self-contained regression checks for the screen-map skill.
#
# Run: bash skills/screen-map/tests/run.sh
#
# Windows note: never use process substitution (`--config <(printf ...)`). Node on
# Windows resolves /proc/<pid>/fd/N to C:\proc\... and cannot open it, which is how
# the ui-audit suite once lost 24 cases. Write real files instead.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="$HERE/../scripts/screen-map.mjs"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/screen-map-tests.XXXXXX")"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

# A sub-suite reports its own `N passed, M failed`; folding that into one PASS hid the
# real size of this suite — 11 lines standing in for well over a hundred assertions, so
# a regression that killed thirty of them still read as one failure.
run_suite() { # name, command...
  local name="$1"; shift
  local status tally
  "$@" > "$WORK/$name.log" 2>&1
  status=$?
  sed 's/^/    /' "$WORK/$name.log"
  tally="$(grep -oE '^[0-9]+ passed, [0-9]+ failed$' "$WORK/$name.log" | tail -1)"
  if [ -n "$tally" ]; then
    PASS=$((PASS + ${tally%% *}))
    FAIL=$((FAIL + $(printf '%s' "$tally" | sed 's/.*, \([0-9]*\) failed/\1/')))
    printf '%s  %s (%s)\n' "$([ "$status" -eq 0 ] && echo PASS || echo FAIL)" "$name" "$tally"
  elif [ "$status" -eq 0 ]; then
    pass "$name"
  else
    fail "$name" "see output above"
  fi
}

# Containers run as root as a matter of course, and Chrome cannot sandbox itself there.
# Say so once and run unsandboxed, rather than letting every browser check below fail —
# or, worse, be skipped as though this machine had no Chrome at all.
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  export SCREEN_MAP_NO_SANDBOX=1
  printf 'note: running as root — Chrome cannot sandbox itself, so the suite runs it unsandboxed.\n\n'
fi

echo "── pure model ───────────────────────────────────────────"
run_suite unit node "$HERE/unit.mjs"

echo
echo "── browser driver ───────────────────────────────────────"
run_suite assert-browser node "$HERE/assert-browser.mjs"

echo
echo "── safety gate ──────────────────────────────────────────"
printf '%s' '{"baseUrl":"https://example.com"}' > "$WORK/off-limits.json"
node "$CLI" crawl --config "$WORK/off-limits.json" > "$WORK/gate.json" 2> "$WORK/gate.err"
GATE_CODE=$?
if [ "$GATE_CODE" -eq 3 ]; then pass "a host outside allowHosts is refused (exit 3)"
else fail "a host outside allowHosts is refused (exit 3)" "exit $GATE_CODE: $(cat "$WORK/gate.json" "$WORK/gate.err" 2>/dev/null | tr '\n' ' ')"; fi
if grep -q "refusing to crawl" "$WORK/gate.json" 2>/dev/null; then pass "the refusal names the host"
else fail "the refusal names the host" "$(cat "$WORK/gate.json" 2>/dev/null)"; fi

echo
echo "── fixture app ──────────────────────────────────────────"
# Everything past this point drives a real browser. Chrome missing is an environment
# fact, not a regression — say so and stop, rather than failing twenty checks that were
# never given a chance to run.
#
# Running as root is a *different* fact, and folding the two together is how a suite
# reports "skipped: Chrome unavailable" on a machine that has Chrome. Containers run as
# root as a matter of course, so the answer there is to accept the unsandboxed browser
# and run, not to quietly skip twenty checks. Say which one happened, either way.
# `pathToFileURL`, not the bare path: on Windows a drive-letter path is not a module
# specifier, and importing one fails the same way a missing Chrome does. That mistake
# skipped the entire browser suite and still printed a green line.
node -e '
  const { pathToFileURL } = require("node:url");
  import(pathToFileURL(process.argv[1]).href)
    .then(m => m.launchBrowser({ headless: true }))
    .then(b => b.close())
    .then(() => process.exit(0), error => {
      console.error(error.message);
      // 78: the browser is here and refused to run this way. That is a real failure of
      // this environment, not an absence, and skipping it would hide twenty checks.
      process.exit(error?.constructor?.name === "SandboxRefused" ? 78 : 77);
    });
' "$HERE/../scripts/browser.mjs" > "$WORK/chrome.err" 2>&1
CHROME_CODE=$?
if [ "$CHROME_CODE" -eq 77 ]; then
  # Print the reason. A bare "skipped" is indistinguishable from a broken probe, which
  # is exactly how a drive-letter import bug once skipped this whole suite in silence.
  pass "browser-driven checks (skipped: no usable Chrome — $(head -c 200 "$WORK/chrome.err" | tr '\n' ' '))"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 0
elif [ "$CHROME_CODE" -ne 0 ]; then
  fail "a browser can be launched" "$(head -c 400 "$WORK/chrome.err")"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
node "$HERE/fixture-server.mjs" --port-file "$WORK/port" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do [ -s "$WORK/port" ] && break; sleep 0.1; done
if [ ! -s "$WORK/port" ]; then
  fail "fixture server starts" "$(cat "$WORK/server.log" 2>/dev/null)"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
PORT="$(cat "$WORK/port")"
BASE="http://127.0.0.1:$PORT"
pass "fixture server listening on $PORT"

# One server serves every crawl below, so each has to start from the same fixture
# state. Without this the second crawl inherits the first one's visit counts and the
# drifting label never drifts for it.
reset_fixture() {
  node -e 'fetch(process.argv[1] + "/__reset", { method: "POST" }).catch(() => {})' "$BASE"
}

# An app repository holding one config. It has to be a real git repo: freshness is
# judged by the commit of the directory the map sits in, so a crawl outside one records
# no commit and `status` can never answer.
fixture_app() { # dir, config-json
  mkdir -p "$1/.screen-map"
  printf '%s\n' "$2" > "$1/.screen-map/config.json"
  printf 'fixture app\n' > "$1/README.md"
  git -C "$1" init -q
  git -C "$1" config user.email tests@example.invalid
  git -C "$1" config user.name "screen-map tests"
  git -C "$1" add -A
  git -C "$1" commit -q -m "fixture app"
}

APP="$WORK/app"
fixture_app "$APP" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/\"],
  \"budget\": { \"maxStates\": 30, \"maxActions\": 120, \"maxMillis\": 180000 }
}"

echo
echo "── crawl (default: nothing mutating runs) ────────────────"
reset_fixture
if node "$CLI" crawl --config "$APP/.screen-map/config.json" > "$WORK/crawl.json" 2> "$WORK/crawl.err"; then
  pass "crawl completes"
else
  fail "crawl completes" "$(cat "$WORK/crawl.json" "$WORK/crawl.err" 2>/dev/null | tr '\n' ' ')"
fi
run_suite assert-crawl node "$HERE/assert-crawl.mjs" --map "$APP/.screen-map/map.json" --base "$BASE" --mode default

echo
echo "── queries ──────────────────────────────────────────────"
run_suite assert-queries node "$HERE/assert-queries.mjs" --app "$APP"

echo
echo "── crawl (--allow-mutating) ─────────────────────────────"
APP2="$WORK/app2"
fixture_app "$APP2" "$(cat "$APP/.screen-map/config.json")"
reset_fixture
if node "$CLI" crawl --config "$APP2/.screen-map/config.json" --allow-mutating > "$WORK/crawl2.json" 2> "$WORK/crawl2.err"; then
  pass "crawl with --allow-mutating completes"
else
  fail "crawl with --allow-mutating completes" "$(cat "$WORK/crawl2.json" "$WORK/crawl2.err" 2>/dev/null | tr '\n' ' ')"
fi
run_suite assert-crawl-mutating node "$HERE/assert-crawl.mjs" --map "$APP2/.screen-map/map.json" --base "$BASE" --mode mutating

echo
echo "── auth steps ───────────────────────────────────────────"
# Credentials pass through here, and nothing had ever exercised it. `/dashboard` is
# behind a cookie the fixture only sets for one email/password pair, so a crawl that
# reaches it proves the steps ran — and one that does not is redirected to the form.
export SCREEN_MAP_EMAIL='crawler@example.invalid'
export SCREEN_MAP_PASSWORD='hunter2'

auth_app() { # dir, entry-path, click-step, extra-step
  fixture_app "$1" "{
    \"baseUrl\": \"$BASE\",
    \"entrypoints\": [\"/dashboard\"],
    \"auth\": { \"steps\": [
      { \"kind\": \"goto\", \"path\": \"$2\" },
      $4
      { \"kind\": \"fill\", \"selector\": \"#email\", \"value\": \"\${SCREEN_MAP_EMAIL}\" },
      { \"kind\": \"fill\", \"selector\": \"#password\", \"value\": \"\${SCREEN_MAP_PASSWORD}\" },
      $3,
      { \"kind\": \"waitForPath\", \"path\": \"/dashboard\", \"timeoutMs\": 3000 }
    ] },
    \"budget\": { \"maxStates\": 10, \"maxActions\": 20, \"maxMillis\": 60000 }
  }"
}

routes_of() { # map file -> sorted routes, comma separated
  node -e '
    const map = require(process.argv[1]);
    process.stdout.write([...new Set(map.states.map(s => s.route))].sort().join(","));
  ' "$1"
}

# `role` + `name` clicks a coordinate, so it needs the consent strip to have cleared —
# which is what the `wait` step is for.
reset_fixture
auth_app "$WORK/auth1" "/login?next=/dashboard" \
  '{ "kind": "click", "role": "button", "name": "로그인" }' \
  '{ "kind": "wait", "ms": 900 },'
if node "$CLI" crawl --config "$WORK/auth1/.screen-map/config.json" > "$WORK/auth1.json" 2> "$WORK/auth1.err"; then
  if [ "$(routes_of "$WORK/auth1/.screen-map/map.json")" = "/dashboard,/leaf" ]; then
    pass "goto + wait + fill + click by role and name + waitForPath reaches the screen behind the login"
  else
    fail "goto + wait + fill + click by role and name + waitForPath reaches the screen behind the login" \
      "mapped $(routes_of "$WORK/auth1/.screen-map/map.json")"
  fi
else
  fail "an authenticated crawl completes" "$(cat "$WORK/auth1.json" "$WORK/auth1.err" 2>/dev/null | tr '\n' ' ')"
fi

if node -e '
  const state = require(process.argv[1]);
  const ok = (state.cookies || []).some(c => c.name === "sid" && c.value === "ok");
  process.exit(ok ? 0 : 1);
' "$WORK/auth1/.screen-map/storage-state.json" 2>/dev/null; then
  pass "the session the auth steps opened is written to storage-state.json"
else
  fail "the session the auth steps opened is written to storage-state.json" \
    "$(head -c 300 "$WORK/auth1/.screen-map/storage-state.json" 2>/dev/null)"
fi

if [ "$(node -e 'fetch(process.argv[1] + "/__clicks").then(r => r.json()).then(c => process.stdout.write(String(c.login)))' "$BASE")" = "1" ]; then
  pass "the credentials were actually posted, once"
else
  fail "the credentials were actually posted, once" "server counted a different number of logins"
fi

# The documented difference, as a pair. Same page, same steps, only the click kind
# changes: with the strip stuck up, the coordinate click lands on the backdrop and the
# DOM click still reaches the button underneath.
reset_fixture
auth_app "$WORK/auth2" "/login?stuck=1" '{ "kind": "click", "role": "button", "name": "로그인" }' ''
node "$CLI" crawl --config "$WORK/auth2/.screen-map/config.json" > "$WORK/auth2.json" 2> "$WORK/auth2.err"
AUTH2_CODE=$?
if [ "$AUTH2_CODE" -ne 0 ] && grep -q "never reached /dashboard" "$WORK/auth2.json"; then
  pass "a click by role and name cannot reach a control under an overlay, and says so"
else
  fail "a click by role and name cannot reach a control under an overlay, and says so" \
    "exit $AUTH2_CODE: $(head -c 300 "$WORK/auth2.json")"
fi

reset_fixture
auth_app "$WORK/auth3" "/login?stuck=1" '{ "kind": "click", "selector": "#submit" }' ''
if node "$CLI" crawl --config "$WORK/auth3/.screen-map/config.json" > "$WORK/auth3.json" 2> "$WORK/auth3.err" \
  && [ "$(routes_of "$WORK/auth3/.screen-map/map.json")" = "/dashboard,/leaf" ]; then
  pass "a click by selector reaches the same control under the same overlay"
else
  fail "a click by selector reaches the same control under the same overlay" \
    "$(cat "$WORK/auth3.json" "$WORK/auth3.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi

# The negative that gives the three above their meaning: without the steps, the crawl
# never sees the screen at all — it is handed the login form instead.
fixture_app "$WORK/auth4" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/dashboard\"],
  \"budget\": { \"maxStates\": 10, \"maxActions\": 20, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/auth4/.screen-map/config.json" > "$WORK/auth4.json" 2> "$WORK/auth4.err" \
  && [ "$(routes_of "$WORK/auth4/.screen-map/map.json")" = "/login" ]; then
  pass "without auth steps the crawl is redirected to the login form and maps that"
else
  fail "without auth steps the crawl is redirected to the login form and maps that" \
    "mapped $(routes_of "$WORK/auth4/.screen-map/map.json" 2>/dev/null)"
fi

echo
echo "── dialogs, popups and downloads ────────────────────────"
fixture_app "$WORK/hazards" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/hazards\"],
  \"budget\": { \"maxStates\": 10, \"maxActions\": 20, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/hazards/.screen-map/config.json" > "$WORK/hazards.json" 2> "$WORK/hazards.err"; then
  pass "a crawl of the hazard screen completes"
else
  fail "a crawl of the hazard screen completes" "$(cat "$WORK/hazards.json" "$WORK/hazards.err" 2>/dev/null | tr '\n' ' ')"
fi
run_suite assert-hazards node "$HERE/assert-hazards.mjs" --map "$WORK/hazards/.screen-map/map.json" --base "$BASE"

echo
echo "── crawl leaves a map behind while it is still running ──"
# Ten minutes of walking used to live only in memory: a crash at minute nine lost all
# of it. Checkpoints have to be readable *during* the crawl, and they have to say they
# are partial — a half-map that reads as finished is worse than no map.
APP5="$WORK/app5"
fixture_app "$APP5" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/\"],
  \"budget\": { \"maxStates\": 30, \"maxActions\": 120, \"maxMillis\": 180000, \"checkpointEvery\": 1 }
}"

reset_fixture
node "$CLI" crawl --config "$APP5/.screen-map/config.json" > "$WORK/crawl5.json" 2> "$WORK/crawl5.err" &
CRAWL_PID=$!
MIDRUN=""
for _ in $(seq 1 300); do
  kill -0 "$CRAWL_PID" 2>/dev/null || break
  if [ -s "$APP5/.screen-map/map.json" ]; then
    MIDRUN="$(node -e '
      try {
        const map = require(process.argv[1]);
        process.stdout.write(String(map.run.budgetHit) + " " + map.states.length);
      } catch { /* caught mid-write: try again */ }
    ' "$APP5/.screen-map/map.json" 2>/dev/null)"
    [ -n "$MIDRUN" ] && break
  fi
  sleep 0.1
done
wait "$CRAWL_PID"
CRAWL5_CODE=$?

if [ -z "$MIDRUN" ]; then
  fail "the crawl writes a checkpoint before it finishes" "no readable map.json appeared while the crawl was running"
elif [ "${MIDRUN%% *}" = "incomplete" ]; then
  pass "a mid-crawl checkpoint is on disk and says it is not a finished map ($MIDRUN states)"
else
  fail "a mid-crawl checkpoint says it is not a finished map" "budgetHit was $MIDRUN, expected incomplete"
fi

if [ "$CRAWL5_CODE" -eq 0 ] && [ "$(node -e 'process.stdout.write(String(require(process.argv[1]).run.budgetHit))' "$APP5/.screen-map/map.json")" = "null" ]; then
  pass "the finished crawl overwrites the checkpoint with a complete map"
else
  fail "the finished crawl overwrites the checkpoint with a complete map" "exit $CRAWL5_CODE: $(cat "$WORK/crawl5.json" "$WORK/crawl5.err" 2>/dev/null | tr '\n' ' ')"
fi

if grep -qE '^\[[0-9]+\] .* → verified' "$WORK/crawl5.err"; then
  pass "progress goes to stderr, one line per action"
else
  fail "progress goes to stderr, one line per action" "$(head -c 400 "$WORK/crawl5.err")"
fi
if [ -s "$WORK/crawl5.json" ] && node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$WORK/crawl5.json"; then
  pass "stdout stays pure JSON while progress is being written"
else
  fail "stdout stays pure JSON while progress is being written" "$(head -c 400 "$WORK/crawl5.json")"
fi

echo
echo "── config reaches the crawl ─────────────────────────────"
# Everything below is written in config.json and read nowhere else in the suite. Each
# one is a knob the documentation promises works; none had ever been turned.

map_field() { # map file, expression over `map`
  node -e '
    const map = require(process.argv[1]);
    process.stdout.write(String(eval(process.argv[2])));
  ' "$1" "$2"
}

# Running out of budget is this skill's ordinary ending, and `SKILL.md` calls the
# leftover frontier the core of its honesty. Three actions is not enough to walk the
# fixture, so the map must say both what stopped it and what is left.
fixture_app "$WORK/budget" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/\"],
  \"budget\": { \"maxStates\": 30, \"maxActions\": 3, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/budget/.screen-map/config.json" > "$WORK/budget.json" 2> "$WORK/budget.err" \
  && [ "$(map_field "$WORK/budget/.screen-map/map.json" 'map.run.budgetHit')" = "maxActions" ] \
  && [ "$(map_field "$WORK/budget/.screen-map/map.json" 'map.coverage.frontier.length > 0')" = "true" ]; then
  pass "a crawl that runs out of budget says which one, and leaves the frontier behind"
else
  fail "a crawl that runs out of budget says which one, and leaves the frontier behind" \
    "$(cat "$WORK/budget.json" "$WORK/budget.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi

# `--no-replay-verify` trades away the guarantee that every route was walked from an
# entrypoint. The map has to record that it was used, or a reader cannot tell which
# kind of map they are holding.
fixture_app "$WORK/noreplay" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/hazards\"],
  \"budget\": { \"maxStates\": 10, \"maxActions\": 20, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/noreplay/.screen-map/config.json" --no-replay-verify > "$WORK/noreplay.json" 2> "$WORK/noreplay.err" \
  && [ "$(map_field "$WORK/noreplay/.screen-map/map.json" 'map.run.replayVerify')" = "false" ]; then
  pass "--no-replay-verify is recorded in the map it produced"
else
  fail "--no-replay-verify is recorded in the map it produced" \
    "$(cat "$WORK/noreplay.json" "$WORK/noreplay.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi

# `deny` has to beat every other rule, and `allow` has to beat the classifier — with a
# side effect on the server, since a policy that only changes a label proves nothing.
fixture_app "$WORK/policy" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/new\"],
  \"actionPolicy\": {
    \"deny\": [\"link:link:홈\"],
    \"allow\": [\"submit:button:저장\"]
  },
  \"budget\": { \"maxStates\": 10, \"maxActions\": 4, \"maxMillis\": 60000 }
}"
reset_fixture
node "$CLI" crawl --config "$WORK/policy/.screen-map/config.json" > "$WORK/policy.json" 2> "$WORK/policy.err"
POLICY_CODE=$?
DENIED="$(map_field "$WORK/policy/.screen-map/map.json" \
  '(rows => rows.length > 0 && rows.every(t => t.class === "destructive" && t.classifiedBy === "config-deny"))(map.transitions.filter(t => t.action.key === "link:link:홈"))' 2>/dev/null)"
if [ "$POLICY_CODE" -eq 0 ] && [ "$DENIED" = "true" ]; then
  pass "actionPolicy.deny turns a safe navigation into one the crawl refuses"
else
  fail "actionPolicy.deny turns a safe navigation into one the crawl refuses" \
    "exit $POLICY_CODE, got $DENIED"
fi
# Not `= 1`: the submit is the only way onward from `/new`, so it sits on the replay
# path to everything past it and runs again every time the crawl walks back. That is
# what letting a mutating action through costs, and the count is the evidence.
SUBMITS="$(node -e 'fetch(process.argv[1] + "/__clicks").then(r => r.json()).then(c => process.stdout.write(String(c.submit)))' "$BASE")"
if [ "$SUBMITS" -ge 1 ] 2>/dev/null; then
  pass "actionPolicy.allow runs a form submit that --allow-mutating was not given for ($SUBMITS times, replays included)"
else
  fail "actionPolicy.allow runs a form submit that --allow-mutating was not given for" \
    "the server saw $SUBMITS submits"
fi

# Without an override `/items/1` templates to `/items/:id`. The override has to win, or
# an app whose paths the built-in heuristic reads wrong has no way to correct it.
fixture_app "$WORK/routes" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/items/1\"],
  \"routeTemplates\": { \"overrides\": [{ \"match\": \"/items/*\", \"template\": \"/items/:sku\" }] },
  \"budget\": { \"maxStates\": 10, \"maxActions\": 4, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/routes/.screen-map/config.json" > "$WORK/routes.json" 2> "$WORK/routes.err" \
  && [ "$(map_field "$WORK/routes/.screen-map/map.json" 'map.states.some(s => s.route === "/items/:sku")')" = "true" ]; then
  pass "routeTemplates.overrides names the screen instead of the built-in guess"
else
  fail "routeTemplates.overrides names the screen instead of the built-in guess" \
    "routes: $(map_field "$WORK/routes/.screen-map/map.json" 'map.states.map(s => s.route).join(",")' 2>/dev/null)"
fi

echo
echo "── a screen the crawl cannot re-enter ───────────────────"
# `/wizard` is itself only on its first visit. Every action it owns therefore fails the
# same way, and each attempt costs a navigate and a settle — on a real editor with two
# hundred buttons that is where the whole budget goes. The verdict is remembered per
# screen, so it is proven once and read from cache afterwards.
fixture_app "$WORK/wizard" "{
  \"baseUrl\": \"$BASE\",
  \"entrypoints\": [\"/wizard\"],
  \"budget\": { \"maxStates\": 10, \"maxActions\": 20, \"maxMillis\": 60000 }
}"
reset_fixture
if node "$CLI" crawl --config "$WORK/wizard/.screen-map/config.json" > "$WORK/wizard.json" 2> "$WORK/wizard.err"; then
  WIZ="$WORK/wizard/.screen-map/map.json"
  if [ "$(map_field "$WIZ" 'map.transitions.filter(t => t.status === "verified").length')" = "1" ] \
    && [ "$(map_field "$WIZ" 'map.transitions.filter(t => t.status === "blocked").length')" = "2" ]; then
    pass "a screen that stops reproducing itself blocks its remaining actions instead of failing them"
  else
    fail "a screen that stops reproducing itself blocks its remaining actions instead of failing them" \
      "$(map_field "$WIZ" 'JSON.stringify(map.transitions.map(t => [t.action.name, t.status]))')"
  fi
  if [ "$(map_field "$WIZ" 'map.transitions.some(t => /did not reproduce|different screen/.test(t.blockedReason || ""))')" = "true" ]; then
    pass "the block says the screen could not be re-entered, not that the map failed"
  else
    fail "the block says the screen could not be re-entered, not that the map failed" \
      "$(map_field "$WIZ" 'JSON.stringify(map.transitions.map(t => t.blockedReason))')"
  fi
  if [ "$(map_field "$WIZ" '(map.run.timing.phases.find(p => p.label === "reach.replay-skipped") || {count: 0}).count >= 1')" = "true" ]; then
    pass "the second action reads the remembered verdict instead of touching the browser again"
  else
    fail "the second action reads the remembered verdict instead of touching the browser again" \
      "$(map_field "$WIZ" 'map.run.timing.phases.map(p => p.label).join(",")')"
  fi
else
  fail "a crawl of the non-reproducible screen completes" \
    "$(cat "$WORK/wizard.json" "$WORK/wizard.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi

echo
echo "── storage seed (first-run overlay) ─────────────────────"
# `/gated` decides during mount whether to raise a tour overlay whose backdrop hides
# the screen behind it. Unseeded, that overlay is all the crawl can ever see; the
# seed has to land before the first paint for the real screen to be mapped at all.
seed_app() { # dir, seed-json
  fixture_app "$1" "{
    \"baseUrl\": \"$BASE\",
    \"entrypoints\": [\"/gated\"],
    \"storageSeed\": $2,
    \"budget\": { \"maxStates\": 30, \"maxActions\": 120, \"maxMillis\": 180000 }
  }"
}

reached_items() { # map file -> "yes" when the screen behind the overlay was mapped
  node -e '
    const map = require(process.argv[1]);
    process.stdout.write(map.states.some(state => state.route === "/items") ? "yes" : "no");
  ' "$1"
}

seed_app "$WORK/app3" 'null'
if node "$CLI" crawl --config "$WORK/app3/.screen-map/config.json" > "$WORK/crawl3.json" 2> "$WORK/crawl3.err"; then
  if [ "$(reached_items "$WORK/app3/.screen-map/map.json")" = "no" ]; then
    pass "without a seed the first-run overlay is all the crawl can reach"
  else
    fail "without a seed the first-run overlay is all the crawl can reach" "the crawl walked past an overlay that blocks clicks"
  fi
else
  fail "unseeded crawl completes" "$(cat "$WORK/crawl3.json" "$WORK/crawl3.err" 2>/dev/null | tr '\n' ' ')"
fi

seed_app "$WORK/app5b" '{ "sessionStorage": { "tour-done": "true" } }'
if node "$CLI" crawl --config "$WORK/app5b/.screen-map/config.json" > "$WORK/crawl5b.json" 2> "$WORK/crawl5b.err" \
  && [ "$(reached_items "$WORK/app5b/.screen-map/map.json")" = "yes" ]; then
  pass "a sessionStorage seed lands as early as a localStorage one"
else
  fail "a sessionStorage seed lands as early as a localStorage one" \
    "$(cat "$WORK/crawl5b.json" "$WORK/crawl5b.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
fi

seed_app "$WORK/app4" '{ "localStorage": { "tour-done": "true" } }'
if node "$CLI" crawl --config "$WORK/app4/.screen-map/config.json" > "$WORK/crawl4.json" 2> "$WORK/crawl4.err"; then
  if [ "$(reached_items "$WORK/app4/.screen-map/map.json")" = "yes" ]; then
    pass "a seeded crawl maps the screen behind the overlay"
  else
    fail "a seeded crawl maps the screen behind the overlay" "$(cat "$WORK/app4/.screen-map/map.json" 2>/dev/null | head -c 400)"
  fi
else
  fail "seeded crawl completes" "$(cat "$WORK/crawl4.json" "$WORK/crawl4.err" 2>/dev/null | tr '\n' ' ')"
fi

echo
echo "── recording a session somebody else drives ─────────────"
# `drive.mjs` stands in for Playwright: it attaches over CDP and dispatches real mouse
# input, sharing no code with the recorder. A recorder tested through the skill's own
# driver would prove only that the two halves agree with each other.
#
# `--port 0` so parallel worktrees cannot collide, and the endpoint comes back through a
# file the way the fixture server's port does. `--for` is a ceiling, not the plan: the
# driver closes the tab when it is done and the recording ends with it. Signals are not
# usable here — MSYS `kill -INT` does not reach a Node process on Windows as SIGINT.
record_session() { # app-dir, driver-args...
  local app="$1"; shift
  rm -f "$WORK/cdp"
  # `--headless`: a visible window paints on its own schedule, and a scripted click that
  # lands before layout settles silently does nothing at all — which reads here as a
  # recorder that missed the click rather than a driver that missed the button.
  node "$CLI" record --config "$app/.screen-map/config.json" --launch --headless --port 0 \
    --endpoint-file "$WORK/cdp" --for 90000 > "$WORK/record.json" 2> "$WORK/record.err" &
  local recorder=$!
  local endpoint=""
  for _ in $(seq 1 200); do [ -s "$WORK/cdp" ] && break; sleep 0.1; done
  endpoint="$(cat "$WORK/cdp" 2>/dev/null)"
  if [ -z "$endpoint" ]; then
    kill "$recorder" 2>/dev/null
    fail "record opens a browser to watch" "$(head -c 400 "$WORK/record.err" 2>/dev/null)"
    return 1
  fi
  node "$HERE/drive.mjs" --port "${endpoint##*:}" "$@" > "$WORK/drive.log" 2>&1
  local driven=$?
  # The recording ends when the driver closes the tab. A driver that died never got there,
  # so cut it loose rather than sitting out the whole `--for` ceiling twice over.
  [ "$driven" -eq 0 ] || kill "$recorder" 2>/dev/null
  wait "$recorder"
  local recorded=$?
  [ "$driven" -eq 0 ] || { fail "the driver walks the fixture" "$(tail -c 400 "$WORK/drive.log")"; return 1; }
  [ "$recorded" -eq 0 ] || { fail "record finishes cleanly" "$(tail -c 400 "$WORK/record.err")"; return 1; }
  return 0
}

# An array, not a string: every one of these labels has a space in it, and word-splitting
# an unquoted string hands `--click` the word `상품` and the driver the word `목록`.
WALK=(--goto "$BASE/" --click "상품 목록" --wait 400 --click "상품 보기" --wait 400
      --goto "$BASE/" --wait 400 --click "사용자 메뉴" --wait 400 --click "장바구니" --close)

APPREC="$WORK/app-record"
fixture_app "$APPREC" "{ \"baseUrl\": \"$BASE\", \"entrypoints\": [\"/\"] }"
reset_fixture
if record_session "$APPREC" "${WALK[@]}"; then
  pass "a recorded session completes and writes a map"
  run_suite assert-record node "$HERE/assert-record.mjs" --map "$APPREC/.screen-map/map.json" --mode record

  # Nothing promotes a recorded edge on its own, so replaying one by hand has to be
  # possible — otherwise `observed` is a status an edge can never leave. `--to items`
  # without the slash: Git Bash rewrites a lone `/items` into a Windows path.
  reset_fixture
  if node "$CLI" verify --to items --map "$APPREC/.screen-map/map.json" \
      > "$WORK/verify-observed.json" 2> "$WORK/verify-observed.err"; then
    if node -e '
      const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (!result.reached) throw new Error("the recorded route did not replay: " + JSON.stringify(result));
      if (result.evidence !== "observed") throw new Error("verify did not say which kind of path it walked: " + JSON.stringify(result.evidence));
      if (!result.note) throw new Error("a replayed recording must say the map still calls it observed");
    ' "$WORK/verify-observed.json" 2> "$WORK/verify-check.err"; then
      pass "a recorded route can be replayed by hand, and verify says it was only ever watched"
    else
      fail "a recorded route can be replayed by hand" "$(cat "$WORK/verify-check.err")"
    fi
  else
    fail "verify replays a recorded route" \
      "$(cat "$WORK/verify-observed.json" "$WORK/verify-observed.err" 2>/dev/null | tr '\n' ' ' | head -c 300)"
  fi

  if node -e '
    const map = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const observed = map.transitions.filter(t => t.status === "observed");
    if (!observed.length) throw new Error("no observed edges left to check");
    if (observed.some(t => t.status === "verified")) throw new Error("verify wrote to the map");
  ' "$APPREC/.screen-map/map.json" 2> "$WORK/verify-write.err"; then
    pass "replaying does not quietly promote the edge: verify reports, it does not write"
  else
    fail "replaying does not quietly promote the edge" "$(cat "$WORK/verify-write.err")"
  fi
fi

# The fixture counts every state-changing hit it receives. Recording must leave all of
# them at zero: it watches, and a watcher that presses anything is not one.
SIDE_EFFECTS="$(node -e '
  fetch(process.argv[1] + "/__clicks").then(r => r.json()).then(c => {
    const dirty = Object.entries(c).filter(([, count]) => count > 0);
    process.stdout.write(dirty.length ? JSON.stringify(dirty) : "clean");
  }).catch(e => process.stdout.write("probe failed: " + e.message));
' "$BASE")"
if [ "$SIDE_EFFECTS" = "clean" ]; then
  pass "recording changed nothing on the server: it never pressed anything itself"
else
  fail "recording changed nothing on the server" "$SIDE_EFFECTS"
fi

# Recording onto a map a crawl already produced. The point is not to re-walk what the
# crawl already proved — that changes nothing by design — but to reach what it refused:
# `/new` submits a POST form, which the default policy classifies mutating and never
# presses, so the screen behind it is a hole only a recording can fill.
#
# The before/after copy is how the "nothing was quietly rewritten" properties are checked.
# Reading a reference value out of git would be wrong as well as awkward: this map's commit
# is deliberately *not* HEAD — the query suite parks an unreachable commit in it to exercise
# `unknown` freshness — and a recording must leave even that alone.
APPSEED="$WORK/app-seeded"
cp -r "$APP" "$APPSEED"
cp "$APPSEED/.screen-map/map.json" "$WORK/seed-before.json"
SEEDED_WALK=(--goto "$BASE/" --wait 400 --click "상품 목록" --wait 400
             --goto "$BASE/new" --wait 400 --type 'input[name="title"]=녹화된 상품'
             --click "저장" --wait 700 --close)
reset_fixture
if record_session "$APPSEED" "${SEEDED_WALK[@]}"; then
  pass "a recording extends an existing crawl map"
  run_suite assert-record-seeded node "$HERE/assert-record.mjs" \
    --map "$APPSEED/.screen-map/map.json" --mode seeded --before "$WORK/seed-before.json"
fi

# A tab pointed somewhere outside allowHosts is not recorded, and the refusal is counted
# rather than silent.
APPHOST="$WORK/app-host"
fixture_app "$APPHOST" "{ \"baseUrl\": \"$BASE\", \"allowHosts\": [\"127.0.0.1\"], \"entrypoints\": [\"/\"] }"
reset_fixture
if record_session "$APPHOST" --goto "$BASE/" --wait 400 --goto "http://localhost:$PORT/items" --wait 700 --close; then
  if node -e '
    const map = require(process.argv[1]);
    const record = (map.recordings || []).slice(-1)[0] || {};
    const skipped = Object.keys(record.skippedHosts || {});
    const routes = map.states.map(state => state.route);
    if (!skipped.includes("localhost")) throw new Error("localhost was not reported as skipped: " + JSON.stringify(record.skippedHosts));
    if (routes.includes("/items")) throw new Error("a screen outside allowHosts was recorded anyway");
  ' "$APPHOST/.screen-map/map.json" 2> "$WORK/host.err"; then
    pass "a host outside allowHosts is watched but never recorded, and the skip is counted"
  else
    fail "a host outside allowHosts is watched but never recorded" "$(cat "$WORK/host.err")"
  fi
fi

echo
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
