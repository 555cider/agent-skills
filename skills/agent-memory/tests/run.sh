#!/usr/bin/env bash
# Self-contained regression checks for scripts/memory.py.
#
# Run: bash skills/agent-memory/tests/run.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
MEM="$HERE/../scripts/memory.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-memory-tests.XXXXXX")"
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }

run_mem() {
  AGENT_MEMORY_HOME="$MEMHOME" AGENT_MEMORY_AGENT_ID="test-agent" \
    python3 "$MEM" "$@" >"$WORK/out" 2>"$WORK/err"
  EC=$?
}

assert_exit() {
  if [ "$EC" = "$2" ]; then
    pass "$1 [exit $2]"
  else
    fail "$1" "expected exit $2, got $EC (stderr: $(head -c 300 "$WORK/err" | tr '\n' '|'))"
  fi
}

assert_contains() {
  if grep -qF -- "$3" "$2"; then
    pass "$1"
  else
    fail "$1" "missing [$3] in $(basename "$2"): $(head -c 300 "$2" 2>/dev/null | tr '\n' '|')"
  fi
}

assert_not_contains() {
  if grep -qF -- "$3" "$2"; then
    fail "$1" "unexpected [$3] in $(basename "$2"): $(grep -nF -- "$3" "$2" | head -1)"
  else
    pass "$1"
  fi
}

assert_file_exists() {
  if [ -f "$2" ]; then
    pass "$1"
  else
    fail "$1" "missing file $2"
  fi
}

assert_json_expr() {
  python3 - "$2" "$3" <<'PY'
import json
import sys

path, expr = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
if not eval(expr, {"__builtins__": {}}, {"data": data, "any": any, "len": len, "all": all}):
    raise SystemExit(f"expression failed: {expr}")
PY
  if [ "$?" -eq 0 ]; then
    pass "$1"
  else
    fail "$1" "JSON expression failed: $3"
  fi
}

note_path_from_stdout() {
  sed -n 's/^NOTE=//p' "$WORK/out" | head -1
}

# ---------------------------------------------------------------------------
# repo-key: stable, sanitized, and insensitive to credential/scheme spelling.
# ---------------------------------------------------------------------------
MEMHOME="$WORK/memory-repokey"
R1="$WORK/repo-key-1"
R2="$WORK/repo-key-2"
mkdir -p "$R1" "$R2"
git -C "$R1" init -q
git -C "$R2" init -q
git -C "$R1" remote add origin 'https://token:secret@GitHub.com/Example/Agent-Memory.git/'
git -C "$R2" remote add origin 'git@github.com:Example/Agent-Memory.git'

run_mem repo-key --cwd "$R1"
assert_exit "repo-key https credential form" 0
KEY1="$(cat "$WORK/out")"
run_mem repo-key --cwd "$R2"
assert_exit "repo-key ssh form" 0
KEY2="$(cat "$WORK/out")"
if [ "$KEY1" = "$KEY2" ] && printf '%s' "$KEY1" | grep -Eq '^agent-memory-[0-9a-f]{12}$'; then
  pass "repo-key normalizes equivalent remotes"
else
  fail "repo-key normalizes equivalent remotes" "KEY1=$KEY1 KEY2=$KEY2"
fi

# ---------------------------------------------------------------------------
# note: creates unique Markdown notes with required metadata and rejects secrets.
# ---------------------------------------------------------------------------
MEMHOME="$WORK/memory-notes"
PROJ="$WORK/project-notes"
mkdir -p "$PROJ"
git -C "$PROJ" init -q
git -C "$PROJ" remote add origin 'https://github.com/example/project-notes.git'

run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Use pnpm run test:quality for doc path checks" \
  --evidence command:"pnpm run test:quality" --tag docs --tag verification \
  --body "Verified after docs path edits."
assert_exit "note writes eligible auto command" 0
NOTE1="$(note_path_from_stdout)"
assert_file_exists "note output path exists" "$NOTE1"
assert_contains "note has frontmatter type" "$NOTE1" "type: command"
assert_contains "note has required summary" "$NOTE1" "summary: Use pnpm run test:quality for doc path checks"
assert_contains "note records tags" "$NOTE1" "tags: docs,verification"
assert_contains "note records evidence kind" "$NOTE1" "kind: command"
assert_contains "note records agent id" "$NOTE1" "agent_id: test-agent"

run_mem note --cwd "$PROJ" --scope project --priority auto --type caveat \
  --source command --confidence high --summary "Restart dev server after production check" \
  --evidence command:"pnpm run check" --body "Chunk cache can be invalidated."
assert_exit "note writes second unique auto note" 0
NOTE2="$(note_path_from_stdout)"
if [ "$NOTE1" != "$NOTE2" ] && [ -f "$NOTE2" ]; then
  pass "note filenames are unique"
else
  fail "note filenames are unique" "NOTE1=$NOTE1 NOTE2=$NOTE2"
fi

run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "API key sk-abcdefghijklmnopqrstuvwxyz123456" \
  --evidence command:"print env" --body "Do not store this"
assert_exit "note rejects secret-looking content" 1
assert_contains "secret rejection reports error" "$WORK/err" "ERROR=sensitive content detected"

# ---------------------------------------------------------------------------
# promote: accepts only eligible automatic project operational facts.
# ---------------------------------------------------------------------------
run_mem promote --cwd "$PROJ" --note "$NOTE1"
assert_exit "promote eligible auto command" 0
PROJECT_KEY="$(AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" repo-key --cwd "$PROJ")"
PROJECT_MEMORY="$MEMHOME/projects/$PROJECT_KEY/MEMORY.md"
assert_file_exists "project MEMORY.md created" "$PROJECT_MEMORY"
assert_contains "promoted summary present" "$PROJECT_MEMORY" "Use pnpm run test:quality for doc path checks"
assert_contains "promoted canonical id present" "$PROJECT_MEMORY" "id: mem_"
assert_contains "promoted source note present" "$PROJECT_MEMORY" "source_note:"
assert_contains "promoted tags present" "$PROJECT_MEMORY" "tags: docs,verification"

run_mem note --cwd "$PROJ" --scope global --priority auto --type preference \
  --source session --confidence high --summary "Prefer terse Korean summaries" \
  --evidence command:"conversation" --body "This should not auto-promote."
assert_exit "note writes auto global preference candidate" 0
PREF_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$PREF_NOTE"
assert_exit "promote rejects auto global preference" 1
assert_contains "auto preference rejection explains policy" "$WORK/err" "ERROR=note is not eligible for promotion"

run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source session --confidence high --summary "Run local quality gate" \
  --body "Missing evidence must block promotion."
assert_exit "note writes missing evidence candidate" 0
NO_EVIDENCE_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$NO_EVIDENCE_NOTE"
assert_exit "promote rejects missing evidence" 1

# ---------------------------------------------------------------------------
# find: summary-first, explicit always included, auto only by keyword/include.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority explicit --type preference \
  --source user --confidence high --summary "Always keep verification proportional" \
  --body "User prefers narrow verification for small edits."
assert_exit "note writes explicit project memory" 0

run_mem find --cwd "$PROJ" --query verification --budget-lines 20
assert_exit "find verification query" 0
assert_contains "find includes canonical summary" "$WORK/out" "Use pnpm run test:quality for doc path checks"
assert_contains "find includes explicit inbox" "$WORK/out" "Always keep verification proportional"
assert_not_contains "find excludes unrelated auto by default" "$WORK/out" "Restart dev server after production check"

run_mem find --cwd "$PROJ" --query Restart --budget-lines 20
assert_exit "find includes matching auto keyword" 0
assert_contains "find includes matching auto" "$WORK/out" "Restart dev server after production check"

run_mem find --cwd "$PROJ" --include-auto --budget-lines 20
assert_exit "find include-auto without query" 0
assert_contains "find include-auto includes auto" "$WORK/out" "Restart dev server after production check"

# ---------------------------------------------------------------------------
# check: validates missing evidence, oversized summaries, and stale locks.
# ---------------------------------------------------------------------------
run_mem check --cwd "$PROJ"
assert_exit "check reports invalid candidate notes" 1
assert_contains "check catches missing evidence" "$WORK/err" "ERROR=auto promotion candidate missing evidence"

LONG_SUMMARY="$(printf 'x%.0s' $(seq 1 260))"
run_mem note --cwd "$PROJ" --scope project --priority explicit --type decision \
  --source user --confidence high --summary "$LONG_SUMMARY" --body "Too long."
assert_exit "note allows long summary for check coverage" 0

LOCK="$MEMHOME/.lock"
mkdir -p "$LOCK"
python3 - "$LOCK" <<'PY'
import os, sys, time
old = time.time() - 1000
os.utime(sys.argv[1], (old, old))
PY
run_mem check --cwd "$PROJ" --stale-lock-seconds 1
assert_exit "check fails stale lock" 1
assert_contains "check reports stale lock" "$WORK/err" "ERROR=stale lock"
rm -rf "$LOCK"

run_mem check --cwd "$PROJ"
assert_exit "check catches oversized summary" 1
assert_contains "check reports oversized summary" "$WORK/err" "ERROR=summary too long"

# ---------------------------------------------------------------------------
# forget: removes inbox notes and optionally canonical entries from MEMORY.md.
# ---------------------------------------------------------------------------
run_mem forget --cwd "$PROJ" --note "$NOTE2"
assert_exit "forget removes inbox note by path" 0
assert_contains "forget reports removed note" "$WORK/out" "FORGET="

run_mem forget --cwd "$PROJ" --summary "Always keep verification proportional"
assert_exit "forget removes matching notes by summary" 0

run_mem forget --cwd "$PROJ" --summary "nonexistent summary text"
assert_exit "forget fails on nonexistent summary" 1

# ---------------------------------------------------------------------------
# list: enumerate inbox notes with optional filters.
# ---------------------------------------------------------------------------
run_mem list --cwd "$PROJ"
assert_exit "list shows inbox notes" 0

run_mem list --cwd "$PROJ" --scope project --type command
assert_exit "list filters by scope and type" 0

run_mem list --cwd "$PROJ" --priority auto
assert_exit "list filters by priority" 0

run_mem list --cwd "$PROJ" --format json
assert_exit "list outputs valid JSON" 0
python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$WORK/out" 2>/dev/null && \
  pass "list JSON output is valid" || fail "list JSON output is valid" "invalid JSON"

# ---------------------------------------------------------------------------
# stats: show memory store statistics.
# ---------------------------------------------------------------------------
run_mem stats --cwd "$PROJ"
assert_exit "stats shows statistics" 0
assert_contains "stats shows total_memory_bytes" "$WORK/out" "total_memory_bytes"

run_mem stats --cwd "$PROJ" --format json
assert_exit "stats outputs valid JSON" 0
python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$WORK/out" 2>/dev/null && \
  pass "stats JSON output is valid" || fail "stats JSON output is valid" "invalid JSON"

# ---------------------------------------------------------------------------
# OKF-compatible topics: expose frontmatter metadata in JSON find results.
# ---------------------------------------------------------------------------
TOPIC_DIR="$MEMHOME/projects/$PROJECT_KEY/topics"
mkdir -p "$TOPIC_DIR"
cat >"$TOPIC_DIR/verification-policy.md" <<'EOF'
---
type: AgentMemoryTopic
title: Verification Policy
description: How to scope checks for documentation and small edits.
resource: repo://agent-skills/verification-policy
tags: [verification, docs]
timestamp: 2026-07-01T00:00:00Z
owner: agents
---

# Verification Policy

Use targeted checks before broad suites for doc-only edits.
EOF

run_mem find --cwd "$PROJ" --query "Verification Policy" --format json --budget-lines 5
assert_exit "find returns OKF topic" 0
assert_json_expr "OKF topic metadata is exposed" "$WORK/out" \
  'any(result["kind"] == "topic" and result["summary"] == "Verification Policy" and result["type"] == "AgentMemoryTopic" and result["description"].startswith("How to scope") and result["resource"] == "repo://agent-skills/verification-policy" and result["tags"] == ["verification", "docs"] and result["timestamp"] == "2026-07-01T00:00:00Z" and result["metadata"].get("owner") == "agents" for result in data["results"])'

cat >"$TOPIC_DIR/quoted-verification-policy.md" <<'EOF'
---
type: AgentMemoryTopic
title: "Quoted: Verification Policy"
description: "Handles: quoted scalars"
resource: repo://agent-skills/quoted-verification-policy
tags:
  - verification
  - docs
timestamp: "2026-07-01T01:00:00Z"
owner: "agent:memory"
---

# Quoted Policy

Use simple YAML block lists for readable tag metadata.
EOF

run_mem find --cwd "$PROJ" --query "Quoted: Verification" --format json --budget-lines 5
assert_exit "find returns OKF topic with YAML block tags" 0
assert_json_expr "OKF topic parser accepts block lists and quoted scalars" "$WORK/out" \
  'any(result["kind"] == "topic" and result["summary"] == "Quoted: Verification Policy" and result["description"] == "Handles: quoted scalars" and result["tags"] == ["verification", "docs"] and result["timestamp"] == "2026-07-01T01:00:00Z" and result["metadata"].get("owner") == "agent:memory" for result in data["results"])'

run_mem find --cwd "$PROJ" --query "Verification Policy" --type AgentMemoryTopic --format json --budget-lines 10
assert_exit "find filters OKF topics by topic type" 0
assert_json_expr "OKF topic type filter returns topic results" "$WORK/out" \
  'data["total"] >= 2 and all(result["kind"] == "topic" and result["type"] == "AgentMemoryTopic" for result in data["results"])'

cat >"$TOPIC_DIR/malformed-topic.md" <<'EOF'
---
type AgentMemoryTopic
title: Broken Topic
---

# Broken Topic

Malformed topic frontmatter should not break memory search.
EOF

run_mem find --cwd "$PROJ" --query "Broken Topic" --format json --budget-lines 5
assert_exit "find tolerates malformed topic frontmatter" 0
assert_json_expr "malformed topic remains searchable as plain text" "$WORK/out" \
  'any(result["kind"] == "topic" and "Broken Topic" in result["text"] for result in data["results"])'

# Test CRLF line endings in topic frontmatter
CRLF_TOPIC="$TOPIC_DIR/crlf-topic.md"
printf -- "---\r\ntype: AgentMemoryTopic\r\ntitle: CRLF Topic\r\ndescription: Testing CRLF endings\r\ntags: [crlf, test]\r\ntimestamp: 2026-07-01T02:00:00Z\r\n---\r\n\r\n# CRLF Topic\r\nBody here\r\n" > "$CRLF_TOPIC"

run_mem find --cwd "$PROJ" --query "CRLF Topic" --format json
assert_exit "find parses CRLF topic" 0
assert_json_expr "CRLF topic metadata is successfully parsed" "$WORK/out" \
  'any(result["kind"] == "topic" and result["title"] == "CRLF Topic" and result["tags"] == ["crlf", "test"] for result in data["results"])'

# Test YAML comment lines in topic frontmatter
COMMENT_TOPIC="$TOPIC_DIR/comment-topic.md"
cat >"$COMMENT_TOPIC" <<'EOF'
---
type: AgentMemoryTopic
# This is a YAML comment line
title: Commented Topic
# Another comment
tags:
  - comment
  # comment inside list
  - yaml
timestamp: 2026-07-01T03:00:00Z
---

# Commented Topic
Body here
EOF

run_mem find --cwd "$PROJ" --query "Commented Topic" --format json
assert_exit "find parses topic with frontmatter comments" 0
assert_json_expr "commented topic metadata is successfully parsed" "$WORK/out" \
  'any(result["kind"] == "topic" and result["title"] == "Commented Topic" and result["tags"] == ["comment", "yaml"] for result in data["results"])'

# Test index.md and log.md exclusion in find search
cat >"$TOPIC_DIR/index.md" <<'EOF'
---
type: AgentMemoryIndex
title: Topic Index
---
# Index
Table of contents
EOF

cat >"$TOPIC_DIR/log.md" <<'EOF'
---
type: AgentMemoryLog
title: Topic Log
---
# Log
Chronological history
EOF

run_mem find --cwd "$PROJ" --query "Topic Index" --format json
assert_exit "find query for index.md succeeds" 0
assert_json_expr "index.md is excluded from concept search" "$WORK/out" \
  'not any(result["kind"] == "topic" and result["title"] == "Topic Index" for result in data["results"])'

run_mem find --cwd "$PROJ" --query "Topic Log" --format json
assert_exit "find query for log.md succeeds" 0
assert_json_expr "log.md is excluded from concept search" "$WORK/out" \
  'not any(result["kind"] == "topic" and result["title"] == "Topic Log" for result in data["results"])'

# Test check command validation of topics (check reports malformed topic)
run_mem check --cwd "$PROJ"
assert_exit "check command fails on malformed topic" 1
assert_contains "check reports malformed topic" "$WORK/err" "ERROR=malformed frontmatter line"

# Remove malformed-topic.md to check if validation passes
rm "$TOPIC_DIR/malformed-topic.md"

# Test check command validation of topics (check reports missing type)
cat >"$TOPIC_DIR/missing-type.md" <<'EOF'
---
title: Missing Type
---
Body
EOF

run_mem check --cwd "$PROJ"
assert_exit "check command fails on topic missing type" 1
assert_contains "check reports missing type" "$WORK/err" "ERROR=missing type in topic"

rm "$TOPIC_DIR/missing-type.md"

# Test check command validation of sensitive topic frontmatter
cat >"$TOPIC_DIR/sensitive-frontmatter-topic.md" <<'EOF'
---
type: AgentMemoryTopic
title: Sensitive Frontmatter Topic
description: token: abcdefghijklmnop
---

Body is harmless.
EOF

run_mem check --cwd "$PROJ"
assert_exit "check command fails on sensitive topic frontmatter" 1
assert_contains "check reports sensitive topic frontmatter" "$WORK/err" "ERROR=sensitive content detected"

run_mem review --cwd "$PROJ" --stale-days 90 --format json
assert_exit "review command succeeds with sensitive topic issue" 0
assert_json_expr "review reports sensitive topic frontmatter" "$WORK/out" \
  'any(item["kind"] == "invalid_topic" and "sensitive content detected" in item["detail"] for item in data["findings"])'

rm "$TOPIC_DIR/sensitive-frontmatter-topic.md"

# Verify review command reports topic issues
cat >"$TOPIC_DIR/invalid-topic-for-review.md" <<'EOF'
---
title: Invalid Topic for Review
---
Body
EOF

run_mem review --cwd "$PROJ" --stale-days 90 --format json
assert_exit "review command succeeds with topic issues" 0
assert_json_expr "review reports missing type in topics" "$WORK/out" \
  'any(item["kind"] == "invalid_topic" and "missing type" in item["detail"] for item in data["findings"])'

rm "$TOPIC_DIR/invalid-topic-for-review.md"
rm "$CRLF_TOPIC"
rm "$COMMENT_TOPIC"
rm "$TOPIC_DIR/index.md"
rm "$TOPIC_DIR/log.md"

# ---------------------------------------------------------------------------
# cleanup: remove old inbox notes based on age.
# ---------------------------------------------------------------------------
run_mem cleanup --cwd "$PROJ" --older-than-days 9999 --dry-run
assert_exit "cleanup dry-run succeeds" 0

run_mem cleanup --cwd "$PROJ" --older-than-days 0
assert_exit "cleanup removes old notes" 0

# ---------------------------------------------------------------------------
# find --format json: returns structured JSON output.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority explicit --type preference \
  --source user --confidence high --summary "JSON test preference" \
  --body "Testing JSON output format."
assert_exit "note writes test preference for JSON find" 0

run_mem note --cwd "$PROJ" --scope project --priority auto --type caveat \
  --source session --confidence medium --summary "Background cache restart candidate" \
  --body "This unrelated auto note must not appear unless it matches the query or include-auto is set."
assert_exit "note writes unrelated auto note for JSON exclusion" 0

run_mem find --cwd "$PROJ" --query "JSON" --format json --budget-lines 10
assert_exit "find with JSON format" 0
python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$WORK/out" 2>/dev/null && \
  pass "find JSON output is valid" || fail "find JSON output is valid" "invalid JSON"
assert_contains "find JSON has results key" "$WORK/out" '"results"'
assert_contains "find JSON has total key" "$WORK/out" '"total"'
python3 - "$WORK/out" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
results = data["results"]

def require(condition, message):
    if not condition:
        raise SystemExit(message)

require(results, "expected at least one JSON result")
for result in results:
    for key in ("kind", "scope", "path"):
        require(key in result, f"missing {key} in {result}")

canonical = [
    result for result in results
    if result.get("kind") == "canonical"
    and result.get("summary") == "Use pnpm run test:quality for doc path checks"
]
require(canonical, "missing promoted canonical MEMORY.md result")
canon = canonical[0]
require(canon.get("scope") == "project", f"wrong canonical scope: {canon}")
require(canon.get("type") == "command", f"wrong canonical type: {canon}")
require(canon.get("confidence") == "high", f"wrong canonical confidence: {canon}")
require(canon.get("id", "").startswith("mem_"), f"missing canonical id: {canon}")
require(canon.get("source_note"), f"missing source_note: {canon}")
require(canon.get("last_verified"), f"missing last_verified: {canon}")
require(canon.get("tags") == ["docs", "verification"], f"wrong canonical tags: {canon}")
require(isinstance(canon.get("score"), int), f"missing score: {canon}")
require("matched_fields" in canon, f"missing matched_fields: {canon}")
require("snippet" in canon, f"missing snippet: {canon}")

explicit = [
    result for result in results
    if result.get("kind") == "explicit"
    and result.get("summary") == "JSON test preference"
]
require(explicit, "missing explicit JSON preference result")
require(explicit[0].get("priority") == "explicit", f"wrong explicit priority: {explicit[0]}")

auto = [result for result in results if result.get("summary") == "Background cache restart candidate"]
require(not auto, f"unrelated auto note leaked into JSON results: {auto}")
PY
if [ "$?" -eq 0 ]; then
  pass "find JSON returns normalized canonical and note records"
else
  fail "find JSON returns normalized canonical and note records" "$(head -c 300 "$WORK/out" | tr '\n' '|')"
fi

# ---------------------------------------------------------------------------
# find ranking and filters.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope global --priority explicit --type preference \
  --source user --confidence high --summary "Global JSON preference" \
  --body "Global preference that should rank below project canonical matches."
assert_exit "note writes global explicit preference for ranking" 0

run_mem find --cwd "$PROJ" --query "test:quality" --format json --budget-lines 3
assert_exit "ranked find query succeeds" 0
assert_json_expr "ranked find returns project canonical first" "$WORK/out" \
  'data["results"][0]["kind"] == "canonical" and data["results"][0]["scope"] == "project" and data["results"][0]["summary"] == "Use pnpm run test:quality for doc path checks"'

run_mem find --cwd "$PROJ" --scope project --type command --format json --budget-lines 20
assert_exit "find filters by scope and type" 0
assert_json_expr "find scope/type filter excludes non-project commands" "$WORK/out" \
  'all(result["scope"] == "project" and result.get("type") == "command" for result in data["results"])'

run_mem find --cwd "$PROJ" --priority explicit --source user --format json --budget-lines 20
assert_exit "find filters by priority and source" 0
assert_json_expr "find priority/source filter returns explicit user notes only" "$WORK/out" \
  'all(result.get("priority") == "explicit" and result.get("source") == "user" for result in data["results"])'

CANON_ID="$(python3 - "$PROJECT_MEMORY" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"id: (mem_[^;)]+)", text)
print(match.group(1) if match else "")
PY
)"
if [ -n "$CANON_ID" ]; then
  pass "canonical id can be extracted"
else
  fail "canonical id can be extracted" "$(cat "$PROJECT_MEMORY")"
fi

run_mem verify --cwd "$PROJ" --id "$CANON_ID" --date 2026-06-27
assert_exit "verify updates canonical last_verified by id" 0
assert_contains "verify reports updated memory" "$WORK/out" "VERIFY="
assert_contains "verify updated last_verified" "$PROJECT_MEMORY" "last_verified: 2026-06-27"

run_mem forget --cwd "$PROJ" --id "$CANON_ID"
assert_exit "forget removes canonical by id" 0
assert_not_contains "canonical id removed by forget" "$PROJECT_MEMORY" "$CANON_ID"

# Re-promote for review coverage.
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Use pnpm run test:quality for doc path checks" \
  --evidence command:"pnpm run test:quality" --tag docs --tag verification \
  --body "Verified after docs path edits."
assert_exit "note writes fresh eligible auto command for review" 0
REVIEW_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$REVIEW_NOTE"
assert_exit "promote eligible auto command after id forget" 0
CANON_ID="$(python3 - "$PROJECT_MEMORY" <<'PY'
import re
import sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"id: (mem_[^;)]+)", text)
print(match.group(1) if match else "")
PY
)"

# Add old-format canonical entry and a stale entry for review coverage.
cat >>"$PROJECT_MEMORY" <<'EOF'
- [command] Legacy command without id (confidence: high; source_note: missing-note.md; last_verified: 2020-01-01)
- [command] Use pnpm run test:quality for doc path checks (confidence: high; source_note: duplicate-note.md; last_verified: 2020-01-01)
EOF

run_mem review --cwd "$PROJ" --stale-days 1 --format json
assert_exit "review reports findings without failing" 0
assert_contains "review JSON has findings" "$WORK/out" '"findings"'
assert_json_expr "review reports missing ids" "$WORK/out" \
  'any(item["kind"] == "missing_id" for item in data["findings"])'
assert_json_expr "review reports stale canonical entries" "$WORK/out" \
  'any(item["kind"] == "stale_canonical" for item in data["findings"])'
assert_json_expr "review reports duplicate summaries" "$WORK/out" \
  'any(item["kind"] == "duplicate_summary" for item in data["findings"])'
assert_json_expr "review reports missing source notes" "$WORK/out" \
  'any(item["kind"] == "missing_source_note" for item in data["findings"])'
assert_json_expr "review reports promotion candidates" "$WORK/out" \
  'any(item["kind"] == "promotion_candidate" for item in data["findings"])'

# ---------------------------------------------------------------------------
# propose: stage candidate learnings from session text without promoting them.
# ---------------------------------------------------------------------------
PROPOSE_TEXT="$WORK/propose-input.txt"
cat >"$PROPOSE_TEXT" <<'EOF'
Repeated failure: after pnpm run check, restart ./sp dev before browser verification.
Verified with command: ./sp dev
User correction: keep verification narrow for small doc-only edits.
EOF

run_mem propose --cwd "$PROJ" --scope project --source session \
  --tag verification --format json --input "$PROPOSE_TEXT"
assert_exit "propose stages candidates" 0
assert_contains "propose JSON has candidates" "$WORK/out" '"candidates"'
assert_json_expr "propose writes auto inbox notes" "$WORK/out" \
  'data["total"] == 2 and all(item["priority"] == "auto" for item in data["candidates"])'
assert_json_expr "propose command candidate has evidence" "$WORK/out" \
  'any(item["type"] == "command" and item["confidence"] == "high" and item["evidence"] for item in data["candidates"])'
assert_json_expr "propose preference candidate stays medium" "$WORK/out" \
  'any(item["type"] == "preference" and item["confidence"] == "medium" for item in data["candidates"])'
assert_json_expr "propose notes are staged in inbox" "$WORK/out" \
  'all(item["path"] for item in data["candidates"])'
assert_not_contains "propose does not promote to MEMORY.md" "$PROJECT_MEMORY" "restart ./sp dev"

# ---------------------------------------------------------------------------
# session handoff: save, list, resume, close.
# ---------------------------------------------------------------------------
run_mem session save --cwd "$PROJ" --id handoff-1 --summary "Continue docs cleanup" \
  --body "Branch main. Touched docs. Next run quality checks."
assert_exit "session save creates handoff" 0
assert_contains "session save reports path" "$WORK/out" "SESSION="

run_mem session list --cwd "$PROJ" --format json
assert_exit "session list JSON succeeds" 0
assert_json_expr "session list includes active handoff" "$WORK/out" \
  'any(item["session_id"] == "handoff-1" and item["status"] == "active" for item in data["results"])'

run_mem session resume --cwd "$PROJ" --id handoff-1 --format json
assert_exit "session resume by id succeeds" 0
assert_json_expr "session resume returns body" "$WORK/out" \
  'data["session_id"] == "handoff-1" and "Next run quality checks" in data["body"]'

run_mem session close --cwd "$PROJ" --id handoff-1
assert_exit "session close succeeds" 0
run_mem session list --cwd "$PROJ" --status closed --format json
assert_exit "session list filters closed handoffs" 0
assert_json_expr "session list includes closed handoff" "$WORK/out" \
  'any(item["session_id"] == "handoff-1" and item["status"] == "closed" for item in data["results"])'

# ---------------------------------------------------------------------------
# eval assets: behavior and trigger eval files are valid.
# ---------------------------------------------------------------------------
BEHAVIOR_EVALS="$HERE/../evals/behavior-evals.json"
TRIGGER_EVALS="$HERE/../evals/trigger-evals.json"
assert_file_exists "behavior eval asset exists" "$BEHAVIOR_EVALS"
assert_file_exists "trigger eval asset exists" "$TRIGGER_EVALS"
python3 - "$BEHAVIOR_EVALS" "$TRIGGER_EVALS" <<'PY'
import json
import sys

behavior = json.load(open(sys.argv[1], encoding="utf-8"))
trigger = json.load(open(sys.argv[2], encoding="utf-8"))
assert behavior["skill_name"] == "agent-memory"
assert len(behavior["evals"]) >= 6
assert all({"id", "prompt", "expected_output"} <= set(item) for item in behavior["evals"])
assert len(trigger) == 20
assert sum(1 for item in trigger if item["should_trigger"]) == 10
assert sum(1 for item in trigger if not item["should_trigger"]) == 10
assert all({"query", "should_trigger"} <= set(item) for item in trigger)
PY
if [ "$?" -eq 0 ]; then
  pass "eval assets have expected schema"
else
  fail "eval assets have expected schema" "invalid eval JSON"
fi

# ---------------------------------------------------------------------------
# sensitive patterns: additional edge cases.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "AWS key AKIAIOSFODNN7EXAMPLE" \
  --evidence command:"print env" --body "Should be rejected"
assert_exit "note rejects AWS AKIA key pattern" 1

run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Private key header test" \
  --evidence command:"cat key.pem" --body "-----BEGIN RSA PRIVATE KEY-----"
assert_exit "note rejects private key pattern" 1

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
