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
# session id slugging: save/resume/close by an id that needs slugging.
# ---------------------------------------------------------------------------
run_mem session save --cwd "$PROJ" --id "Handoff Cleanup" --summary "spaced id" --body "resume me"
assert_exit "session save with spaced id" 0
run_mem session resume --cwd "$PROJ" --id "Handoff Cleanup" --format json
assert_exit "session resume finds slugged id by raw id" 0
assert_json_expr "resume matches slugged session" "$WORK/out" \
  '"resume me" in data["body"]'
run_mem session close --cwd "$PROJ" --id "Handoff Cleanup"
assert_exit "session close finds slugged id by raw id" 0

# ---------------------------------------------------------------------------
# forget confinement + canonical gating + scoping.
# ---------------------------------------------------------------------------
MEMHOME="$WORK/memory-forget-scope"
FA="$WORK/forget-proj-a"; FB="$WORK/forget-proj-b"
mkdir -p "$FA" "$FB"
git -C "$FA" init -q; git -C "$FB" init -q

# forget --note must reject a path outside the store, even a sibling prefix dir.
mkdir -p "$MEMHOME" "${MEMHOME}-backup"
echo "keep" > "${MEMHOME}-backup/x.md"
run_mem forget --cwd "$FA" --note "${MEMHOME}-backup/x.md"
assert_exit "forget --note rejects out-of-store sibling path" 1
assert_file_exists "sibling file survives rejected forget" "${MEMHOME}-backup/x.md"

# forget --note --summary must NOT touch canonical without --canonical.
run_mem note --cwd "$FA" --scope project --priority explicit --type caveat \
  --source user --confidence high --summary "gate-canary fact" --body "b"
GATE_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$FA" --note "$GATE_NOTE"
CANON_A="$MEMHOME/projects/$(AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" repo-key --cwd "$FA")/MEMORY.md"
assert_contains "canary promoted to canonical" "$CANON_A" "gate-canary fact"
run_mem note --cwd "$FA" --scope project --priority explicit --type caveat \
  --source user --confidence high --summary "gate-canary fact" --body "b2"
GATE_NOTE2="$(note_path_from_stdout)"
run_mem forget --cwd "$FA" --note "$GATE_NOTE2" --summary "gate-canary fact"
assert_exit "forget --note --summary without --canonical succeeds" 0
assert_contains "canonical untouched without --canonical" "$CANON_A" "gate-canary fact"
run_mem forget --cwd "$FA" --summary "gate-canary fact" --canonical
assert_not_contains "canonical removed with --canonical" "$CANON_A" "gate-canary fact"

# Return to the primary project memory store for the remaining $PROJ/$PROJECT_MEMORY checks.
MEMHOME="$WORK/memory-notes"

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
pos = sum(1 for item in trigger if item["should_trigger"])
neg = sum(1 for item in trigger if not item["should_trigger"])
assert len(trigger) >= 8, f"need >=8 trigger cases, have {len(trigger)}"
assert pos >= 4 and neg >= 4, f"need a balanced positive/negative split, have {pos}/{neg}"
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

for secret_case in \
  'github_pat_1234567890abcdefghijklmnopqrstuvwxyz' \
  'ghp_1234567890abcdefghijklmnopqrstuv' \
  'glpat-1234567890abcdefghijklmnopqrstuv' \
  'xox''b-1234567890-abcdefghijklmnopqrst' \
  'AIza1234567890abcdefghijklmnopqrstuvwxyz' \
  'eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop'; do
  run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
    --source command --confidence high --summary "Token fixture $secret_case" \
    --evidence command:"print env" --body "Should be rejected"
  assert_exit "note rejects token family ${secret_case%%_*}" 1
done

run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Discuss token rotation without including a credential" \
  --evidence command:"docs check" --body "Ordinary prose about GitHub and JWT tokens is safe."
assert_exit "ordinary security prose is not a secret false positive" 0

# ---------------------------------------------------------------------------
# forget: --note + --summary respects the --canonical gate (regression).
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Canonical gate fixture fact" \
  --evidence command:"run gate" --body "Promote then forget."
assert_exit "gate fixture note created" 0
GATE_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$GATE_NOTE"
assert_exit "gate fixture promoted" 0
assert_contains "gate fixture in canonical" "$PROJECT_MEMORY" "Canonical gate fixture fact"

# A second inbox note to delete by path alongside a --summary, WITHOUT --canonical.
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Transient inbox fact" \
  --evidence command:"run x" --body "Delete me."
assert_exit "transient inbox note created" 0
TRANSIENT_NOTE="$(note_path_from_stdout)"
run_mem forget --cwd "$PROJ" --note "$TRANSIENT_NOTE" --summary "Canonical gate fixture fact"
assert_exit "forget --note --summary without --canonical succeeds" 0
assert_contains "canonical untouched without --canonical" "$PROJECT_MEMORY" "Canonical gate fixture fact"
if [ -f "$TRANSIENT_NOTE" ]; then
  fail "forget --note removed the named inbox note" "still present: $TRANSIENT_NOTE"
else
  pass "forget --note removed the named inbox note"
fi

# Now scrub the canonical entry explicitly.
run_mem forget --cwd "$PROJ" --summary "Canonical gate fixture fact" --canonical
assert_exit "forget --summary --canonical succeeds" 0
assert_not_contains "canonical removed with --canonical" "$PROJECT_MEMORY" "Canonical gate fixture fact"

# ---------------------------------------------------------------------------
# forget --id boundary matching: a truncated id must not match a full id.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Boundary id fixture" \
  --evidence command:"run y" --body "Has a stable id after promotion."
BOUNDARY_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$BOUNDARY_NOTE"
assert_exit "boundary fixture promoted" 0
run_mem forget --cwd "$PROJ" --id "mem_1970"
assert_exit "forget with a non-matching truncated id fails cleanly" 1
assert_contains "boundary fixture survives truncated id" "$PROJECT_MEMORY" "Boundary id fixture"

# ---------------------------------------------------------------------------
# error surface: a missing input file yields one ERROR= line, not a traceback.
# ---------------------------------------------------------------------------
run_mem promote --cwd "$PROJ" --note "$WORK/does-not-exist.md"
assert_exit "promote on missing note exits 1" 1
assert_contains "promote missing note prints ERROR=" "$WORK/err" "ERROR="
assert_not_contains "promote missing note has no traceback" "$WORK/err" "Traceback"

run_mem propose --cwd "$PROJ" --scope project --source session --input "$WORK/nope.txt"
assert_exit "propose on missing input exits 1" 1
assert_not_contains "propose missing input has no traceback" "$WORK/err" "Traceback"

# ---------------------------------------------------------------------------
# explicit-note promotion: a user explicit note is promotion-eligible.
# ---------------------------------------------------------------------------
run_mem note --cwd "$PROJ" --scope project --priority explicit --type preference \
  --source user --confidence high --summary "Explicit promotable preference" \
  --body "User asked to remember this."
EXPLICIT_NOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$PROJ" --note "$EXPLICIT_NOTE"
assert_exit "explicit user note is promotable" 0
assert_contains "explicit note reached canonical" "$PROJECT_MEMORY" "Explicit promotable preference"

# Promotion accepts only notes created in the current scoped inbox. A valid
# frontmatter file copied elsewhere must not become a write primitive.
EXTERNAL_NOTE="$WORK/external-valid-note.md"
cp "$EXPLICIT_NOTE" "$EXTERNAL_NOTE"
run_mem promote --cwd "$PROJ" --note "$EXTERNAL_NOTE"
assert_exit "promote rejects a valid note outside the memory store" 1
assert_contains "outside promote explains confinement" "$WORK/err" "inside the memory store"

SYMLINK_NOTE="$MEMHOME/projects/$(AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" repo-key --cwd "$PROJ")/inbox/explicit/symlink.md"
ln -s "$EXPLICIT_NOTE" "$SYMLINK_NOTE"
run_mem promote --cwd "$PROJ" --note "$SYMLINK_NOTE"
assert_exit "promote rejects a symlinked inbox note" 1
assert_contains "symlink promote explains rejection" "$WORK/err" "must not contain symlinks"
rm "$SYMLINK_NOTE"

MISMATCH_DEST="$(dirname "$EXPLICIT_NOTE")/mismatched-note.md"
run_mem note --cwd "$PROJ" --scope project --priority auto --type command \
  --source command --confidence high --summary "Path metadata mismatch fixture" \
  --evidence command:"run mismatch" --body "Eligible, but copied into the wrong priority inbox."
MISMATCH_SOURCE="$(note_path_from_stdout)"
cp "$MISMATCH_SOURCE" "$MISMATCH_DEST"
run_mem promote --cwd "$PROJ" --note "$MISMATCH_DEST"
assert_exit "promote rejects priority/path metadata mismatch" 1
assert_contains "metadata mismatch explains rejection" "$WORK/err" "scope and priority metadata"
rm "$MISMATCH_DEST"

# ---------------------------------------------------------------------------
# find --since and --include-topics gating (regression).
# ---------------------------------------------------------------------------
run_mem find --cwd "$PROJ" --since 1970-01-01 --budget-lines 50
assert_exit "find --since accepts a date filter" 0

run_mem find --cwd "$PROJ" --budget-lines 50
assert_exit "bare find succeeds" 0
assert_not_contains "bare find does not dump topics" "$WORK/out" "Verification Policy"

run_mem find --cwd "$PROJ" --include-topics --budget-lines 50
assert_exit "find --include-topics succeeds" 0
assert_contains "find --include-topics surfaces topics" "$WORK/out" "Verification Policy"

# ---------------------------------------------------------------------------
# durable records + FTS recall: full bodies survive promotion, aliases work,
# promoted inbox notes are deduplicated, and filesystem fallback stays useful.
# ---------------------------------------------------------------------------
MEMHOME="$WORK/memory-durable"
DPROJ="$WORK/project-durable"
mkdir -p "$DPROJ"
run_mem note --cwd "$DPROJ" --scope project --priority explicit --type preference \
  --source user --confidence high --summary "Prefer proportional verification" \
  --alias "비례 검증" --alias "narrow checks" --tag verification \
  --body "Run the narrowest useful checks for small scoped changes."
assert_exit "note accepts multilingual aliases" 0
DNOTE="$(note_path_from_stdout)"
assert_contains "note stores Korean alias" "$DNOTE" "비례 검증"
run_mem promote --cwd "$DPROJ" --note "$DNOTE"
assert_exit "promotion creates durable record" 0
DRECORD="$(sed -n 's/^RECORD=//p' "$WORK/out")"
assert_file_exists "durable record file exists" "$DRECORD"
assert_contains "durable record preserves full body" "$DRECORD" "Run the narrowest useful checks"
assert_contains "durable record keeps alias" "$DRECORD" "narrow checks"
run_mem check --cwd "$DPROJ"
assert_exit "check validates durable record frontmatter" 0

run_mem index rebuild --format json
assert_exit "FTS index rebuild succeeds" 0
assert_json_expr "FTS index contains one deduplicated promoted record" "$WORK/out" "data['backend'] in ('sqlite_fts5', 'filesystem') and data['records'] >= 1"
run_mem recall --cwd "$DPROJ" --prompt "비례 검증" --format json
assert_exit "recall finds Korean alias" 0
assert_json_expr "recall deduplicates promoted source note" "$WORK/out" "data['total'] == 1 and data['results'][0]['kind'] == 'record'"

AGENT_MEMORY_HOME="$MEMHOME" AGENT_MEMORY_DISABLE_FTS5=1 \
  python3 "$MEM" recall --cwd "$DPROJ" --prompt "narrow checks" --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "filesystem recall fallback succeeds" 0
assert_json_expr "filesystem fallback returns durable record" "$WORK/out" "data['index_status']['backend'] == 'filesystem' and data['total'] == 1"

# Global recall is denied for a new repo, then enabled by explicit trust.
run_mem note --cwd "$DPROJ" --scope global --priority explicit --type preference \
  --source user --confidence high --summary "Use global review convention" \
  --alias "global-only-alias" --body "Cross-project convention."
GNOTE="$(note_path_from_stdout)"
run_mem promote --cwd "$DPROJ" --note "$GNOTE"
assert_exit "global explicit memory promotes" 0
run_mem recall --cwd "$DPROJ" --prompt "global-only-alias" --format json
assert_json_expr "untrusted repo excludes global recall" "$WORK/out" "data['trusted'] is False and data['total'] == 0"
run_mem trust add --cwd "$DPROJ"
assert_exit "trust add succeeds" 0
run_mem recall --cwd "$DPROJ" --prompt "global-only-alias" --format json
assert_json_expr "trusted repo includes global recall" "$WORK/out" "data['trusted'] is True and data['global_included'] is True and data['total'] == 1"

# Updating creates a new active id while preserving the superseded old record.
DID="$(basename "$DRECORD" .md)"
run_mem update --id "$DID" --summary "Prefer targeted verification" \
  --alias "targeted checks" --body "Use targeted checks, expanding only when risk requires it."
assert_exit "update creates versioned replacement" 0
NEW_RECORD="$(sed -n 's/^RECORD=//p' "$WORK/out")"
NEW_ID="$(basename "$NEW_RECORD" .md)"
assert_contains "old record is retained as superseded" "$DRECORD" "status: superseded"
assert_contains "new record points to predecessor" "$NEW_RECORD" "supersedes: $DID"
run_mem recall --cwd "$DPROJ" --prompt "targeted checks" --format json
assert_json_expr "normal recall returns only active replacement" "$WORK/out" "data['total'] == 1 and data['results'][0]['id'] == '$NEW_ID'"

# Cleanup may prune old candidates, but never the source note of a promoted record.
touch -d '2000-01-01 UTC' "$DNOTE"
run_mem cleanup --cwd "$DPROJ" --older-than-days 1
assert_exit "cleanup succeeds with promoted source note" 0
assert_file_exists "cleanup protects promoted source note" "$DNOTE"
run_mem forget --cwd "$DPROJ" --id "$NEW_ID"
assert_exit "forget by id removes active durable record" 0
if [ ! -e "$NEW_RECORD" ]; then
  pass "forget deletes durable record file"
else
  fail "forget deletes durable record file" "still present: $NEW_RECORD"
fi

# ---------------------------------------------------------------------------
# migration and native import are preview-first, backed up, and idempotent.
# ---------------------------------------------------------------------------
MEMHOME="$WORK/memory-migrate"
MPROJ="$WORK/project-migrate"
mkdir -p "$MPROJ"
MKEY="$(AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" repo-key --cwd "$MPROJ")"
mkdir -p "$MEMHOME/projects/$MKEY"
printf '%s\n' '# Project Memory' '' '- [command] Legacy verification command (id: mem_legacy_1234; confidence: high; source_note: old.md; last_verified: 2026-01-01; tags: docs)' >"$MEMHOME/projects/$MKEY/MEMORY.md"
run_mem migrate --cwd "$MPROJ" --format json
assert_exit "migration preview succeeds" 0
assert_json_expr "migration preview reports one action" "$WORK/out" "data['total'] == 1 and data['applied'] is False"
if [ ! -d "$MEMHOME/projects/$MKEY/topics/memory" ]; then
  pass "migration preview is non-mutating"
else
  fail "migration preview is non-mutating" "topics/memory was created"
fi
run_mem migrate --cwd "$MPROJ" --apply --format json
assert_exit "migration apply succeeds" 0
assert_file_exists "migration writes durable legacy record" "$MEMHOME/projects/$MKEY/topics/memory/mem_legacy_1234.md"
assert_contains "migration adds canonical resource pointer" "$MEMHOME/projects/$MKEY/MEMORY.md" "resource: topics/memory/mem_legacy_1234.md"
assert_json_expr "migration creates backup" "$WORK/out" "len(data['backup']) > 0"
run_mem migrate --cwd "$MPROJ" --apply --format json
assert_json_expr "migration rerun is idempotent" "$WORK/out" "data['total'] == 0"

NATIVE="$WORK/native-claude"
mkdir -p "$NATIVE"
printf '%s\n' '# Build convention' 'Use the repository wrapper.' >"$NATIVE/build.md"
run_mem import-native --harness claude --source-dir "$NATIVE" --cwd "$MPROJ" --format json
assert_json_expr "native import preview reports candidate only" "$WORK/out" "data['total'] == 1 and data['applied'] is False"
run_mem import-native --harness claude --source-dir "$NATIVE" --cwd "$MPROJ" --apply --format json
assert_json_expr "native import stages medium candidate" "$WORK/out" "data['total'] == 1 and data['applied'] is True"
IMPORTED="$(find "$MEMHOME/projects/$MKEY/inbox/auto" -name '*.md' | head -1)"
assert_contains "native import records source harness" "$IMPORTED" "source: claude"
assert_contains "native import stays medium confidence" "$IMPORTED" "confidence: medium"
run_mem import-native --harness claude --source-dir "$NATIVE" --cwd "$MPROJ" --apply --format json
assert_json_expr "native import rerun is idempotent" "$WORK/out" "data['total'] == 0"

REMEMBER_NATIVE="$WORK/native-remember"
mkdir -p "$REMEMBER_NATIVE/logs"
printf '%s\n' \
  '# Current work' \
  '## 10:00 | main' \
  'Keep the alpha handoff.' \
  '## 11:00 | main' \
  'Keep the beta handoff.' >"$REMEMBER_NATIVE/now.md"
printf '%s\n' \
  '# Today' \
  '## 11:00 | main' \
  'Keep the beta handoff.' >"$REMEMBER_NATIVE/today-2026-07-15.md"
printf '%s\n' '# Recent' 'Historical duplicate.' >"$REMEMBER_NATIVE/recent.md"
printf '%s\n' '# Log' 'Internal log noise.' >"$REMEMBER_NATIVE/logs/events.md"
run_mem import-native --harness remember --source-dir "$REMEMBER_NATIVE" --cwd "$MPROJ" --format json
assert_json_expr "remember import splits active entries and deduplicates content" "$WORK/out" "data['total'] == 2 and len(data['skipped']) == 1 and data['skipped'][0]['reason'] == 'duplicate-content' and all(a['type'] == 'handoff' for a in data['actions'])"
assert_json_expr "remember import excludes archives by default" "$WORK/out" "all('recent.md' not in a['source'] and '/logs/' not in a['source'] for a in data['actions'])"
run_mem import-native --harness remember --source-dir "$REMEMBER_NATIVE" --cwd "$MPROJ" --include-history --format json
assert_json_expr "remember history requires explicit opt-in" "$WORK/out" "data['include_history'] is True and any('recent.md' in a['source'] for a in data['actions'])"
run_mem import-native --harness remember --source-dir "$REMEMBER_NATIVE" --cwd "$MPROJ" --apply --format json
assert_json_expr "remember import stages entry-sized candidates" "$WORK/out" "data['total'] == 2 and data['applied'] is True"
run_mem import-native --harness remember --source-dir "$REMEMBER_NATIVE" --cwd "$MPROJ" --apply --format json
assert_json_expr "remember import rerun is idempotent" "$WORK/out" "data['total'] == 0 and any(s['reason'] == 'already-imported' for s in data['skipped'])"

CODEX_NATIVE="$WORK/native-codex"
mkdir -p "$CODEX_NATIVE/extensions/ad_hoc/notes" "$CODEX_NATIVE/rollout_summaries"
printf '%s\n' '# Memory summary' 'Concise user profile.' >"$CODEX_NATIVE/memory_summary.md"
printf '%s\n' '# Raw memories' 'Noisy merged history.' >"$CODEX_NATIVE/raw_memories.md"
printf '%s\n' '# User Preference' 'Prefer proportional verification.' >"$CODEX_NATIVE/extensions/ad_hoc/notes/preference.md"
printf '%s\n' '# Rollout' 'Old task transcript.' >"$CODEX_NATIVE/rollout_summaries/old.md"
run_mem import-native --harness codex --source-dir "$CODEX_NATIVE" --cwd "$MPROJ" --scope global --format json
assert_json_expr "codex import selects curated memory and recognizes preferences" "$WORK/out" "data['total'] == 2 and data['scope'] == 'global' and any(a['type'] == 'preference' for a in data['actions']) and any(a['type'] == 'project-fact' for a in data['actions'])"
assert_json_expr "codex import excludes raw and rollout history by default" "$WORK/out" "all('raw_memories.md' not in a['source'] and 'rollout_summaries' not in a['source'] for a in data['actions'])"
run_mem import-native --harness codex --source-dir "$CODEX_NATIVE" --cwd "$MPROJ" --scope global --only-type preference --match proportional --format json
assert_json_expr "codex import supports safe type and text narrowing" "$WORK/out" "data['total'] == 1 and data['only_type'] == 'preference' and data['match'] == ['proportional'] and data['actions'][0]['type'] == 'preference'"
run_mem import-native --harness codex --source-dir "$CODEX_NATIVE" --cwd "$MPROJ" --scope global --include-history --format json
assert_json_expr "codex history requires explicit opt-in" "$WORK/out" "data['total'] == 4 and data['include_history'] is True"
run_mem import-native --harness codex --source-dir "$CODEX_NATIVE" --cwd "$MPROJ" --scope global --apply --format json
assert_json_expr "codex import can target global memory" "$WORK/out" "data['total'] == 2 and all('/global/inbox/auto/' in a['note'] for a in data['actions'])"

EXIST_HOME="$WORK/existing-home"
EXIST_CODEX="$EXIST_HOME/.codex"
EXIST_MEM="$WORK/memory-existing"
EXIST_PROJ="$WORK/project-existing"
EXIST_ENCODED="${EXIST_PROJ//\//-}"
mkdir -p \
  "$EXIST_HOME/.claude/projects/$EXIST_ENCODED/memory" \
  "$EXIST_CODEX/memories/extensions/ad_hoc/notes" \
  "$EXIST_PROJ/.remember"
printf '%s\n' '# Claude convention' 'Use the project wrapper.' >"$EXIST_HOME/.claude/projects/$EXIST_ENCODED/memory/convention.md"
printf '%s\n' '# Now' '## 12:00 | main' 'Resume the current migration.' >"$EXIST_PROJ/.remember/now.md"
printf '%s\n' 'User preference: keep checks proportional.' >"$EXIST_CODEX/memories/extensions/ad_hoc/notes/ask-before-related-followups.md"
HOME="$EXIST_HOME" CODEX_HOME="$EXIST_CODEX" AGENT_MEMORY_HOME="$EXIST_MEM" \
  python3 "$MEM" import-existing --cwd "$EXIST_PROJ" --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "one-command existing-memory preview succeeds" 0
assert_json_expr "one-command preview combines Claude, remember, and Codex" "$WORK/out" "data['total'] == 3 and data['applied'] is False and [i['harness'] for i in data['imports']] == ['claude', 'remember', 'codex']"
HOME="$EXIST_HOME" CODEX_HOME="$EXIST_CODEX" AGENT_MEMORY_HOME="$EXIST_MEM" \
  python3 "$MEM" import-existing --cwd "$EXIST_PROJ" --apply --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "one-command existing-memory apply succeeds" 0
assert_json_expr "one-command apply stages every selected candidate" "$WORK/out" "data['total'] == 3 and data['applied'] is True"
HOME="$EXIST_HOME" CODEX_HOME="$EXIST_CODEX" AGENT_MEMORY_HOME="$EXIST_MEM" \
  python3 "$MEM" import-existing --cwd "$EXIST_PROJ" --apply --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_json_expr "one-command existing-memory rerun is idempotent" "$WORK/out" "data['total'] == 0"

# ---------------------------------------------------------------------------
# harness adapters: hooks fail open; config install is dry-run-first, merges
# unrelated settings, and removes only owned adapters.
# ---------------------------------------------------------------------------
printf '{not json' | AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" hook --harness codex >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "malformed hook input fails open" 0
assert_contains "malformed hook emits empty object" "$WORK/out" "{}"
printf '{"prompt":"Legacy verification command","cwd":"%s"}' "$MPROJ" | \
  AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" hook --harness codex >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "valid prompt hook recalls context" 0
assert_json_expr "prompt hook emits UserPromptSubmit additionalContext" "$WORK/out" "data['hookSpecificOutput']['hookEventName'] == 'UserPromptSubmit' and 'Legacy verification command' in data['hookSpecificOutput']['additionalContext']"

IHOME="$WORK/integration-home"
mkdir -p "$IHOME/.claude"
printf '%s\n' '{"permissions":{"allow":["Bash(git status)"]}}' >"$IHOME/.claude/settings.json"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode shadow --harness all --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "integration preview succeeds" 0
if [ ! -e "$IHOME/.codex/hooks.json" ]; then
  pass "integration preview does not create config"
else
  fail "integration preview does not create config" "unexpected hooks.json"
fi
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode shadow --harness all --apply --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "shadow integration apply succeeds" 0
assert_contains "Claude integration preserves unrelated settings" "$IHOME/.claude/settings.json" "Bash(git status)"
assert_contains "Claude prompt hook is marked as owned" "$IHOME/.claude/settings.json" "agent-memory-managed"
assert_file_exists "Codex prompt hook config installed" "$IHOME/.codex/hooks.json"
assert_file_exists "OpenCode adapter installed" "$IHOME/.config/opencode/plugins/agent-memory.js"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" doctor --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "doctor reports integration state" 0
assert_json_expr "doctor sees all managed adapters" "$WORK/out" "data['integrations']['claude']['managed'] and data['integrations']['codex_hooks']['managed'] and data['integrations']['opencode']['managed']"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode off --harness all --apply >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "integration off succeeds" 0
assert_contains "integration off preserves Claude settings" "$IHOME/.claude/settings.json" "Bash(git status)"
if [ ! -e "$IHOME/.config/opencode/plugins/agent-memory.js" ]; then
  pass "integration off removes owned OpenCode adapter"
else
  fail "integration off removes owned OpenCode adapter" "adapter remains"
fi

mkdir -p "$IHOME/.codex"
printf '%s\n' 'hooks = ["remember@0.1.0"]' >"$IHOME/.codex/config.toml"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode primary --harness codex --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "primary integration preview reports conflict" 0
assert_json_expr "primary preview is explicitly blocked" "$WORK/out" "data['blocked'] is True and len(data['conflicts']) == 1 and data['applied'] is False"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode primary --harness codex --apply >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "primary integration blocks known conflict" 1
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode primary --harness codex --disable-known-conflicts --apply >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "primary integration disables reviewed conflict" 0
assert_contains "primary integration disables Codex native memory" "$IHOME/.codex/config.toml" "memories = false"
assert_not_contains "primary integration removes known remember hook" "$IHOME/.codex/config.toml" "remember@"

printf '%s\n' \
  '[plugins."remember@claude-plugins-official"]' \
  'enabled = false' \
  '' \
  '[plugins."remember-codex-bridge@personal"]' \
  'enabled = true' >"$IHOME/.codex/config.toml"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode primary --harness codex --format json >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "primary preview understands Codex plugin tables" 0
assert_json_expr "primary ignores already disabled plugin" "$WORK/out" "len(data['conflicts']) == 1 and data['conflicts'][0]['token'] == 'remember-codex-bridge'"
HOME="$IHOME" AGENT_MEMORY_HOME="$MEMHOME" python3 "$MEM" integrate --mode primary --harness codex --disable-known-conflicts --apply >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "primary disables enabled Codex plugin table" 0
python3 - "$IHOME/.codex/config.toml" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)
assert config["plugins"]["remember@claude-plugins-official"]["enabled"] is False
assert config["plugins"]["remember-codex-bridge@personal"]["enabled"] is False
assert config["features"]["memories"] is False
PY
if [ "$?" -eq 0 ]; then
  pass "primary preserves disabled plugin and disables active bridge"
else
  fail "primary preserves disabled plugin and disables active bridge" "unexpected plugin or feature state"
fi

# ---------------------------------------------------------------------------
# CLI validation: destructive commands reject invalid values before layout or
# lock creation, and read-only commands follow the same positive/date contract.
# ---------------------------------------------------------------------------
INVALID_HOME="$WORK/invalid-memory-home"

assert_invalid_without_mutation() {
  local label="$1"
  shift
  rm -rf "$INVALID_HOME"
  AGENT_MEMORY_HOME="$INVALID_HOME" AGENT_MEMORY_AGENT_ID="test-agent" \
    python3 "$MEM" "$@" >"$WORK/out" 2>"$WORK/err"
  EC=$?
  assert_exit "$label" 2
  if [ ! -e "$INVALID_HOME" ]; then
    pass "$label leaves the memory store untouched"
  else
    fail "$label leaves the memory store untouched" "unexpected path created: $INVALID_HOME"
  fi
}

assert_invalid_without_mutation "find rejects negative budget" \
  find --cwd "$PROJ" --budget-lines -1
assert_invalid_without_mutation "cleanup rejects negative age" \
  cleanup --cwd "$PROJ" --older-than-days -1
assert_invalid_without_mutation "verify rejects impossible calendar date" \
  verify --cwd "$PROJ" --id "$CANON_ID" --date 2026-02-30
assert_invalid_without_mutation "find rejects malformed since date" \
  find --cwd "$PROJ" --since yesterday

# Valid read-only and preview commands must also leave an absent store absent.
READONLY_HOME="$WORK/read-only-memory-home"
assert_readonly_without_mutation() {
  local label="$1" expected="$2"
  shift 2
  rm -rf "$READONLY_HOME"
  AGENT_MEMORY_HOME="$READONLY_HOME" AGENT_MEMORY_AGENT_ID="test-agent" \
    python3 "$MEM" "$@" >"$WORK/out" 2>"$WORK/err"
  EC=$?
  assert_exit "$label" "$expected"
  if [ ! -e "$READONLY_HOME" ]; then
    pass "$label leaves an absent store absent"
  else
    fail "$label leaves an absent store absent" "unexpected path created: $READONLY_HOME"
  fi
}

assert_readonly_without_mutation "find is filesystem-read-only" 0 find --cwd "$PROJ"
assert_readonly_without_mutation "check is filesystem-read-only" 0 check --cwd "$PROJ"
assert_readonly_without_mutation "list is filesystem-read-only" 0 list --cwd "$PROJ"
assert_readonly_without_mutation "stats is filesystem-read-only" 0 stats --cwd "$PROJ" --format json
assert_readonly_without_mutation "review is filesystem-read-only" 0 review --cwd "$PROJ" --format json
assert_readonly_without_mutation "session list is filesystem-read-only" 0 session list --cwd "$PROJ" --format json
assert_readonly_without_mutation "session resume failure is filesystem-read-only" 1 session resume --cwd "$PROJ" --latest
assert_readonly_without_mutation "cleanup dry-run is filesystem-read-only" 0 cleanup --cwd "$PROJ" --older-than-days 1 --dry-run

# ---------------------------------------------------------------------------
# --memory-home flag overrides the env var.
# ---------------------------------------------------------------------------
ALT_HOME="$WORK/alt-memory"
AGENT_MEMORY_HOME="$MEMHOME" AGENT_MEMORY_AGENT_ID="test-agent" \
  python3 "$MEM" --memory-home "$ALT_HOME" stats --cwd "$PROJ" --format json \
  >"$WORK/out" 2>"$WORK/err"
EC=$?
assert_exit "stats honors --memory-home override" 0
if [ ! -e "$ALT_HOME" ]; then
  pass "read-only --memory-home leaves the overridden store absent"
else
  fail "read-only --memory-home leaves the overridden store absent" "unexpected $ALT_HOME"
fi

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
