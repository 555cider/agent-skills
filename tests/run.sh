#!/usr/bin/env bash
# Prompt-contract checks for shrink-test-input. Eval JSON shape is validated repo-wide by
# tests/validate-skill-evals.py; behavior is evaluated with those evals, not here.
# Pure shell + awk so it runs on macOS /bin/bash 3.2 and Git Bash without Python.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
SKILL="$ROOT/SKILL.md"
YAML="$ROOT/agents/openai.yaml"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }
check() { if [ "$2" = 0 ]; then pass "$1"; else fail "$1" "$3"; fi; }

# frontmatter value of <key> (single line, surrounding quotes removed)
front() {
  awk -v k="$1" 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
    NR > 1 && index($0, k ": ") == 1 { v = substr($0, length(k) + 3); gsub(/^"|"$/, "", v); print v; exit }' "$SKILL"
}
# yaml value of <key> under interface: (single line, quotes removed)
yaml_value() {
  awk -v k="$1" '{ line = $0; sub(/^ +/, "", line) }
    index(line, k ": ") == 1 { v = substr(line, length(k) + 3); gsub(/^"|"$/, "", v); print v; exit }' "$YAML"
}
# text after the closing frontmatter line
body() { awk 'f { print } NR > 1 && $0 == "---" && !f { f = 1 }' "$SKILL"; }
# 0 when the body contains the literal string $1
in_body() { case "$b" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

[ "$(head -n 1 "$SKILL")" = "---" ]; check "SKILL.md opens with frontmatter" $? "first line is not ---"
[ "$(front name)" = "shrink-test-input" ]; check "frontmatter name is shrink-test-input" $? "got [$(front name)]"

desc="$(front description)"
[ -n "$desc" ]; check "description is present" $? "empty description"
# The Agent Skills spec caps description at 1024 characters.
desc_len="$(printf '%s' "$desc" | LC_ALL=C.UTF-8 wc -m 2>/dev/null | tr -d ' ')"
[ -n "$desc_len" ] && [ "$desc_len" -le 1024 ]; check "description is at most 1024 characters" $? "got $desc_len"

b="$(body)"

# The procedure is eight numbered steps, in order.
expected=1
for heading in "Find the repository's recipe first" "Write the feature list before touching the file" \
  "Pin the behaviour on the original" "Choose the lightest form that keeps the features" \
  "Reduce against a predicate, not by eye" "Make it safe to commit" \
  "Prove the shrunk input still carries each feature" "Leave provenance next to the shrunk input"; do
  in_body "## $expected. $heading"; check "step $expected is '$heading'" $? "missing heading"
  expected=$((expected + 1))
done
in_body "## Converting an existing test"; check "section 'Converting an existing test' is present" $? "missing"
in_body "## Boundaries"; check "section 'Boundaries' is present" $? "missing"

# The four forms, lightest first.
prev=0
for form in "1. **Built in test code**" "2. **Generator script committed beside its output**" \
  "3. **Reduced cut of the original**" "4. **Original stays outside the repo**"; do
  line="$(body | grep -nF -- "$form" | head -n 1 | cut -d: -f1)"
  [ -n "$line" ] && [ "$line" -gt "$prev" ]; check "form '$form' is listed in order" $? "line=[$line] previous=$prev"
  [ -n "$line" ] && prev="$line"
done
in_body "Take the highest one that keeps every listed feature"; check "the ladder says to take the lightest form" $? "missing"

# The behaviours that make a shrunk input trustworthy.
in_body "**multiplicity**"; check "feature list asks for multiplicity" $? "missing"
in_body "**for the same reason**"; check "verdict must hold for the same reason" $? "missing"
in_body "opens the candidate without new errors"; check "predicate includes the format's reader" $? "missing"
in_body "**Mutation check**"; check "mutation check is required" $? "missing"
in_body "ask the user once"; check "asks once about a derived customer cut without a repo policy" $? "missing"
in_body "never a machine path"; check "tests refer to test data by repo-relative path" $? "missing"
in_body "Keep regression corpora and performance inputs whole"; check "boundaries keep corpora and perf inputs whole" $? "missing"

# The description's scope guard must be restated in the body's boundaries.
for word in "regression corpora" "performance" "golden snapshots"; do
  case "$desc" in *"$word"*) d=0 ;; *) d=1 ;; esac
  check "description excludes '$word'" $d "missing from description"
done

# Body budget: the skill is loaded whole whenever it fires, so it must stay short.
body_lines="$(body | wc -l | tr -d ' ')"
[ "$body_lines" -le 130 ]; check "body is at most 130 lines" $? "got $body_lines"

# The repo ships no skill outside skills/; a namespaced reference must resolve to one here.
missing=""
for ref in $(body | grep -oE '`[a-z0-9-]+:[a-z0-9-]+`' | tr -d '`' | sort -u); do
  [ -d "$ROOT/../${ref#*:}" ] || missing="$missing $ref"
done
[ -z "$missing" ]; check "no references to skills this repo does not ship" $? "unresolved:$missing"

# agents/openai.yaml must describe the same skill with the same scope guard.
if [ -f "$YAML" ]; then
  short="$(yaml_value short_description)"
  prompt="$(yaml_value default_prompt)"
  [ -n "$short" ]; check "openai.yaml has a short_description" $? "missing"
  case "$prompt" in *'$shrink-test-input'*) r=0 ;; *) r=1 ;; esac
  check "openai.yaml default_prompt invokes \$shrink-test-input" $r "got [$prompt]"
  for word in "sample file" "gitignored" "regression corpora" "performance" "golden snapshots"; do
    case "$desc" in *"$word"*) d=0 ;; *) d=1 ;; esac
    case "$prompt" in *"$word"*) y=0 ;; *) y=1 ;; esac
    [ "$d" = "$y" ]; check "openai.yaml and SKILL.md agree on '$word'" $? "description=$d default_prompt=$y"
  done
else
  fail "agents/openai.yaml exists" "missing $YAML"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
