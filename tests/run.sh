#!/usr/bin/env bash
# Prompt-contract checks for step-back. Eval JSON shape is validated repo-wide by
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

[ "$(head -n 1 "$SKILL")" = "---" ]; check "SKILL.md opens with frontmatter" $? "first line is not ---"
[ "$(front name)" = "step-back" ]; check "frontmatter name is step-back" $? "got [$(front name)]"

desc="$(front description)"
[ -n "$desc" ]; check "description is present" $? "empty description"
# The Agent Skills spec caps description at 1024 characters.
desc_len="$(printf '%s' "$desc" | LC_ALL=C.UTF-8 wc -m 2>/dev/null | tr -d ' ')"
[ -n "$desc_len" ] && [ "$desc_len" -le 1024 ]; check "description is at most 1024 characters" $? "got $desc_len"

# Every tripwire in the description must exist in the body with the same number.
b="$(body)"
for pair in "complete:**T1:**" "third:**third**" "15:**15**"; do
  word="${pair%%:*}"; marker="${pair#*:}"
  case "$desc" in *"$word"*) d=0 ;; *) d=1 ;; esac
  case "$b" in *"$marker"*) m=0 ;; *) m=1 ;; esac
  [ "$d" = 0 ] && [ "$m" = 0 ]; check "tripwire '$word' is in the description and the body" $? "description=$d body=$m"
done

# Body budget: the skill is loaded whole at every tripwire, so it must stay short.
body_lines="$(body | wc -l | tr -d ' ')"
[ "$body_lines" -le 90 ]; check "body is at most 90 lines" $? "got $body_lines"

# The repo ships no skill outside skills/; a namespaced reference must resolve to one here.
missing=""
for ref in $(body | grep -oE '`[a-z0-9-]+:[a-z0-9-]+`' | tr -d '`' | sort -u); do
  [ -d "$ROOT/../${ref#*:}" ] || missing="$missing $ref"
done
[ -z "$missing" ]; check "no references to skills this repo does not ship" $? "unresolved:$missing"

# agents/openai.yaml must describe the same skill: same tripwires, same scope guard.
if [ -f "$YAML" ]; then
  short="$(yaml_value short_description)"
  prompt="$(yaml_value default_prompt)"
  [ -n "$short" ]; check "openai.yaml has a short_description" $? "missing"
  case "$prompt" in *'$step-back'*) r=0 ;; *) r=1 ;; esac
  check "openai.yaml default_prompt invokes \$step-back" $r "got [$prompt]"
  for word in complete third 15 scope verification; do
    case "$desc" in *"$word"*) d=0 ;; *) d=1 ;; esac
    case "$prompt" in *"$word"*) y=0 ;; *) y=1 ;; esac
    [ "$d" = "$y" ]; check "openai.yaml and SKILL.md agree on '$word'" $? "description=$d default_prompt=$y"
  done
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
