#!/usr/bin/env bash
# Prompt-contract checks for shrink-test-input. Frontmatter is validated by `agentskills
# validate` and eval JSON by tests/validate-skill-evals.py; behavior is evaluated with those evals.
# Pure shell + awk so it runs on macOS /bin/bash 3.2 and Git Bash without Python.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
SKILL="$ROOT/SKILL.md"
YAML="$ROOT/agents/openai.yaml"

PASS=0
FAIL=0
check() {
  if [ "$2" = 0 ]; then PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$3"; fi
}

b="$(awk 'f { print } NR > 1 && $0 == "---" && !f { f = 1 }' "$SKILL")"

# Body budget: the skill is loaded whole whenever it fires, so it must stay short.
body_lines="$(printf '%s\n' "$b" | wc -l | tr -d ' ')"
[ "$body_lines" -le 130 ]; check "body is at most 130 lines" $? "got $body_lines"

# The repo ships no skill outside skills/; a namespaced reference must resolve to one here.
missing=""
for ref in $(printf '%s\n' "$b" | grep -oE '`[a-z0-9-]+:[a-z0-9-]+`' | tr -d '`' | sort -u); do
  [ -d "$ROOT/../${ref#*:}" ] || missing="$missing $ref"
done
[ -z "$missing" ]; check "no references to skills this repo does not ship" $? "unresolved:$missing"

# Codex invokes the skill through agents/openai.yaml's default_prompt.
grep 'default_prompt:' "$YAML" 2>/dev/null | grep -qF '$shrink-test-input'
check "openai.yaml default_prompt invokes \$shrink-test-input" $? "missing in $YAML"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
