#!/usr/bin/env bash
# Structural regression checks for skills/step-back/SKILL.md and its evals.
#
# step-back ships no scripts — the document IS the deliverable, and its only firing
# mechanism is the frontmatter `description`. So the invariants worth guarding are
# structural: the trigger vocabulary must survive edits, the three tripwires and their
# thresholds must stay present and consistent between SKILL.md and the behavior evals,
# and the misuse guard must not be quietly dropped.
#
# Pure shell so it runs under Git Bash on Windows too — no process substitution, no
# GNU-only flags. Python is used only to check that the eval files parse.
#
# Run: bash skills/step-back/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$HERE/.." && pwd)"
SKILL_MD="$SKILL_DIR/SKILL.md"
TRIGGER_EVALS="$SKILL_DIR/evals/trigger-evals.json"
BEHAVIOR_EVALS="$SKILL_DIR/evals/behavior-evals.json"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

assert_file() {
  if [ -f "$2" ]; then pass "$1"; else fail "$1" "missing file: $2"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi
}
# assert_contains <label> <file> <fixed string>
assert_contains() {
  if grep -qF -- "$3" "$2"; then pass "$1"; else fail "$1" "missing [$3] in $(basename "$2")"; fi
}
# assert_matches <label> <file> <ERE>
assert_matches() {
  if grep -qE -- "$3" "$2"; then pass "$1"; else fail "$1" "no line matching /$3/ in $(basename "$2")"; fi
}

python_bin() {
  if command -v python3 >/dev/null 2>&1; then printf 'python3\n'
  elif command -v python >/dev/null 2>&1; then printf 'python\n'
  fi
}

# ---------------------------------------------------------------- files exist

assert_file "SKILL.md exists" "$SKILL_MD"
assert_file "trigger-evals.json exists" "$TRIGGER_EVALS"
assert_file "behavior-evals.json exists" "$BEHAVIOR_EVALS"

if [ ! -f "$SKILL_MD" ]; then
  printf '\npassed %d, failed %d\n' "$PASS" "$FAIL"
  exit 1
fi

# The frontmatter description is one physical line in every skill in this repo; the
# checks below read it as such.
DESCRIPTION="$(grep -m1 '^description: ' "$SKILL_MD")"

# ------------------------------------------------------------------ identity

assert_eq "frontmatter name matches the directory" \
  "name: step-back" "$(grep -m1 '^name: ' "$SKILL_MD")"
assert_eq "skill directory is named step-back" "step-back" "$(basename "$SKILL_DIR")"
assert_matches "frontmatter declares a license" "$SKILL_MD" '^license: '
assert_matches "frontmatter declares compatibility" "$SKILL_MD" '^compatibility: '

# --------------------------------------------------------- trigger vocabulary
#
# With no hook and no script, the description is the entire firing mechanism. Every
# term below corresponds to a tripwire the skill cannot fire without; losing one to a
# well-meaning copy edit silently kills that tripwire.

for term in complete "third time" "tool calls" proportional; do
  if printf '%s' "$DESCRIPTION" | grep -qF -- "$term"; then
    pass "description keeps the trigger term [$term]"
  else
    fail "description keeps the trigger term [$term]" "not found in the description line"
  fi
done

if printf '%s' "$DESCRIPTION" | grep -qF -- "Do not use"; then
  pass "description states its negative cases"
else
  fail "description states its negative cases" "no 'Do not use' clause in the description line"
fi

if [ "$(grep -c '^description: ' "$SKILL_MD")" = "1" ]; then
  pass "description is a single frontmatter line"
else
  fail "description is a single frontmatter line" "expected exactly one 'description: ' line"
fi

# ------------------------------------------------------------------ tripwires

assert_matches "T1 is defined" "$SKILL_MD" '\*\*T1\*\*'
assert_matches "T2 is defined" "$SKILL_MD" '\*\*T2\*\*'
assert_matches "T3 is defined" "$SKILL_MD" '\*\*T3\*\*'
assert_contains "T2 threshold is the third occurrence" "$SKILL_MD" '**third**'
assert_contains "T3 threshold is 15 tool calls" "$SKILL_MD" '**15** tool calls'
assert_contains "T3 counts per subgoal, not per session" "$SKILL_MD" 'per subgoal'

# The rewrite question and the one-sentence question are what the tripwires actually
# run. A tripwire without its question degrades into a log line.
assert_contains "T1 asks the rewrite question" "$SKILL_MD" 'what would I do differently'
assert_contains "T2/T3 ask what is being learned" "$SKILL_MD" 'What exactly am I trying to learn'

# ----------------------------------------------------------------- escalation

assert_contains "escalation is per tripwire" "$SKILL_MD" 'Count each tripwire separately'
assert_contains "first firing is decided alone" "$SKILL_MD" 'First firing'
assert_contains "second firing goes to the user" "$SKILL_MD" 'Second firing'

# ----------------------------------------------------------------- principles
#
# Ten principles, numbered without gaps. A renumbering accident breaks the
# tripwire-to-principle mapping the body relies on.

n=1
while [ "$n" -le 10 ]; do
  count="$(grep -cE "^$n\. " "$SKILL_MD")"
  if [ "$count" = "1" ]; then
    pass "principle $n appears exactly once"
  else
    fail "principle $n appears exactly once" "found $count lines starting with '$n. '"
  fi
  n=$((n + 1))
done

if [ "$(grep -cE '^11\. ' "$SKILL_MD")" = "0" ]; then
  pass "principle list stops at 10"
else
  fail "principle list stops at 10" "found an 11th principle; update this test and the tripwire table"
fi

# --------------------------------------------------------------- misuse guard
#
# The worst outcome for this skill is edge B eating edge A: shipping something thin and
# reporting that it "stepped back". These two lines are the guard against that and must
# not be edited away.

assert_contains "misuse guard section exists" "$SKILL_MD" 'This is not permission to do less'
assert_contains "scope narrowing stays the user's decision" "$SKILL_MD" \
  "Narrowing scope is the user's decision"
assert_contains "an explicit thoroughness request suspends the thresholds" "$SKILL_MD" \
  '**do not apply**'

# ----------------------------------------------------------------- boundaries

assert_contains "boundary with verification-before-completion" "$SKILL_MD" \
  'superpowers:verification-before-completion'
assert_contains "boundary with systematic-debugging" "$SKILL_MD" \
  'superpowers:systematic-debugging'

# ------------------------------------------------- thresholds match the evals
#
# Drift guard: a threshold changed in SKILL.md but not in the behavior evals leaves the
# evals asserting a rule the skill no longer states.

assert_contains "behavior evals quote the 15-tool-call threshold" "$BEHAVIOR_EVALS" '15 tool calls'
assert_contains "behavior evals quote the third-occurrence threshold" "$BEHAVIOR_EVALS" 'third'
assert_contains "behavior evals cover the scope-narrowing guard" "$BEHAVIOR_EVALS" \
  "user's requested scope"

# -------------------------------------------------------- eval files are JSON

PY="$(python_bin)"
if [ -z "$PY" ]; then
  fail "eval files parse as JSON" "no python3 or python on PATH"
else
  for f in "$TRIGGER_EVALS" "$BEHAVIOR_EVALS"; do
    if "$PY" -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$f" 2>/dev/null; then
      pass "$(basename "$f") parses as JSON"
    else
      fail "$(basename "$f") parses as JSON" "json.load failed"
    fi
  done
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
