#!/usr/bin/env bash
# Self-contained regression suite for scripts/plan-graph.py.
#
# Why a single shell runner (no pytest): the script's only contract is its CLI
# (exit codes + stdout/stderr lines), so we assert exactly that. Fixtures are
# generated into a throwaway temp dir rather than committed, because several
# need bytes/permissions git can't store portably (a UTF-8 BOM, a 0444 file,
# a stale-mtime lockfile). See README.md for the fixture catalogue.
#
# Run:  bash skills/plan-graph/tests/run.sh   (exit 0 = all pass)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PG="$HERE/../scripts/plan-graph.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pg-tests.XXXXXX")"
# Make everything writable again before deleting (readonly/lock cases chmod down).
trap 'chmod -R u+rwX "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ROOT_USER=0
[ "$(id -u 2>/dev/null)" = "0" ] && ROOT_USER=1

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n        %s\n' "$1" "$2"; }
skip() { printf 'SKIP  %s  (%s)\n' "$1" "$2"; }

# pg <root> [args...] -> runs the script against <root>/.agents/plan/graph.yaml
# with an EXPLICIT --root (default_root() shells out to `git rev-parse`, which
# inside this repo resolves to the repo root and breaks every file check).
# Captures stdout->$WORK/out, stderr->$WORK/err, exit code -> $EC.
pg() {
  local root="$1"; shift
  python3 "$PG" "$root/.agents/plan/graph.yaml" --root "$root" "$@" >"$WORK/out" 2>"$WORK/err"
  EC=$?
}

assert_exit()    { if [ "$EC" = "$2" ]; then pass "$1 [exit $2]"; else fail "$1" "expected exit $2, got $EC (err: $(head -c 200 "$WORK/err" | tr '\n' '|'))"; fi; }
assert_grep()    { if grep -qE -- "$3" "$2"; then pass "$1"; else fail "$1" "missing /$3/ in $(basename "$2"): $(head -c 200 "$2" | tr '\n' '|')"; fi; }
assert_grepF()   { if grep -qF -- "$3" "$2"; then pass "$1"; else fail "$1" "missing literal [$3] in $(basename "$2"): $(head -c 200 "$2" | tr '\n' '|')"; fi; }
assert_nogrep()  { if grep -qE -- "$3" "$2"; then fail "$1" "unexpected /$3/ -> $(grep -nE -- "$3" "$2" | head -1)"; else pass "$1"; fi; }
assert_fgrep()   { if grep -qE -- "$3" "$2"; then pass "$1"; else fail "$1" "file $2 missing /$3/"; fi; }
assert_fnogrep() { if grep -qE -- "$3" "$2"; then fail "$1" "file $2 unexpectedly has /$3/"; else pass "$1"; fi; }
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

# newcase <name> -> creates $WORK/<name>/.agents/plan and echoes the case root.
newcase() { local d="$WORK/$1"; mkdir -p "$d/.agents/plan"; printf '%s' "$d"; }
add_bom() { python3 -c "import sys;p=sys.argv[1];d=open(p,'rb').read();open(p,'wb').write(b'\xef\xbb\xbf'+d)" "$1"; }

# ---------------------------------------------------------------------------
# normal — SKILL.md golden example: tree shape, roadmap order, critical path.
# Guards #6 (excluded wording only on real exclusions) and #8 (depth>1 gate),
# and proves the documented --show output still reproduces byte-for-byte.
# ---------------------------------------------------------------------------
D=$(newcase normal)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 8

nodes:
  1: {p: ".agents/plan/auth.md", s: "Auth/session"}
  2: {p: ".agents/plan/errors.md", s: "Error strategy"}
  3: {p: ".agents/plan/checkout.md", s: "Checkout recovery"}
  4: {p: ".agents/plan/db.md", s: "DB schema"}
  5: {p: ".agents/plan/migration.md", s: "Migration plan"}
  6: {p: ".agents/plan/logging.md", s: "Logging plan"}
  7: {p: ".agents/plan/legacy.md", s: "Legacy approach", x: "dropped"}

deps:
  3: [1]
  4: [1, 2]
  5: [3, 4]
EOF
for f in auth errors checkout db migration logging legacy; do printf '# %s\n\nbody\n' "$f" >"$D/.agents/plan/$f.md"; done
pg "$D" --fix >/dev/null 2>&1   # setup: populate frontmatter so check is clean

pg "$D" --show
assert_exit  "normal-show" 0
assert_grepF "normal-show tree root [5]"        "$WORK/out" "[5] Migration plan"
assert_grepF "normal-show shared-base repeat ↑" "$WORK/out" "[1] Auth/session ↑"
assert_grepF "normal-show dropped inline"       "$WORK/out" "[7] Legacy approach (dropped)"
assert_grepF "normal-show critical path"        "$WORK/out" "[1] ➔ [3] ➔ [5]"
assert_grep  "normal-show roadmap order [5]@5"  "$WORK/out" "5\. \[5\] Migration plan"

pg "$D"
assert_exit  "normal-check" 0
assert_grep  "normal-check OK sentinel" "$WORK/out" "OK plan graph"
assert_nogrep "normal-check no error"   "$WORK/err" "ERROR="
assert_nogrep "normal-check no warn"    "$WORK/err" "WARN="

pg "$D" --json
assert_exit "normal-json" 0
assert_grep "normal-json status OK"   "$WORK/out" '"status": "OK"'
assert_grep "normal-json empty errors" "$WORK/out" '"errors": \[\]'

pg "$D" --show --json
assert_exit "normal-show-json" 0
assert_grep "normal-show-json critical_path" "$WORK/out" '"critical_path"'
assert_grep "normal-show-json roadmap"       "$WORK/out" '"roadmap"'

# ---------------------------------------------------------------------------
# suggest-deps — read-only dependency candidates with confidence provenance.
# ---------------------------------------------------------------------------
D=$(newcase suggest)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: ".agents/plan/auth.md", s: "Auth/session"}
  2: {p: ".agents/plan/checkout.md", s: "Checkout recovery"}

deps:
EOF
printf '# Auth/session\n\nBase authentication constraints.\n' >"$D/.agents/plan/auth.md"
cat >"$D/.agents/plan/checkout.md" <<'EOF'
# Checkout recovery

This plan depends on .agents/plan/auth.md before implementing checkout retry behavior.
EOF
cp "$D/.agents/plan/graph.yaml" "$WORK/suggest-before.yaml"

pg "$D" --suggest-deps --json
assert_exit "suggest-deps-json" 0
assert_json_expr "suggest-deps reports extracted edge" "$WORK/out" \
  'data["status"] == "OK" and any(item["dependent"] == 2 and item["base"] == 1 and item["confidence"] == "EXTRACTED" for item in data["suggestions"])'
cmp "$D/.agents/plan/graph.yaml" "$WORK/suggest-before.yaml" >/dev/null && \
  pass "suggest-deps leaves graph untouched" || fail "suggest-deps leaves graph untouched" "graph mutated"

pg "$D" --suggest-deps
assert_exit "suggest-deps-text" 0
assert_grepF "suggest-deps text provenance" "$WORK/out" "SUGGEST=2->1 EXTRACTED"

pg "$D" --suggest-deps --fix
assert_exit "suggest-deps-fix-readonly" 0
[ ! -e "$D/.agents/plan/graph.yaml.lock" ] && \
  pass "suggest-deps fix mode does not leave lock" || fail "suggest-deps fix mode does not leave lock" "lock left behind"

# ---------------------------------------------------------------------------
# single — a lone node must NOT print a Critical Path section (#8 depth>1 gate).
# ---------------------------------------------------------------------------
D=$(newcase single)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "a.md", s: "alpha"}

deps:
EOF
pg "$D" --show
assert_exit   "single-show" 0
assert_grepF  "single-show node"        "$WORK/out" "[1] alpha"
assert_nogrep "single-show no critical" "$WORK/out" "Critical Path"

# ---------------------------------------------------------------------------
# cycle — --show must not crash and must list all nodes (#1); plain check errors.
# ---------------------------------------------------------------------------
D=$(newcase cycle)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "a.md", s: "alpha"}
  2: {p: "b.md", s: "beta"}

deps:
  1: [2]
  2: [1]
EOF
pg "$D" --show
assert_exit   "cycle-show" 0
assert_grepF  "cycle-show node 1"      "$WORK/out" "[1] alpha"
assert_grepF  "cycle-show node 2"      "$WORK/out" "[2] beta"
assert_grepF  "cycle-show excluded"    "$WORK/out" "(cycle, excluded from roadmap)"
assert_nogrep "cycle-show no traceback" "$WORK/out" "Traceback"
assert_nogrep "cycle-show no traceback (err)" "$WORK/err" "Traceback"

pg "$D"
assert_exit "cycle-check" 1
assert_grep "cycle-check error"  "$WORK/err" "ERROR=cycle detected: 1 -> 2 -> 1"
assert_grep "cycle-check FAIL"   "$WORK/err" "FAIL plan graph"

# ---------------------------------------------------------------------------
# legacy — missing frontmatter is a WARN (exit 0), --fix adds it, recheck clean.
# This is the backward-compat guard (#2): legacy repos must not insta-fail.
# ---------------------------------------------------------------------------
D=$(newcase legacy)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: ".agents/plan/auth.md", s: "Auth plan"}

deps:
EOF
printf '# Auth plan\n\nbody text\n' >"$D/.agents/plan/auth.md"

pg "$D"
assert_exit "legacy-check-pre" 0
assert_grep "legacy-check-pre WARN"   "$WORK/err" "WARN=missing frontmatter in .agents/plan/auth.md"
assert_grep "legacy-check-pre OK"     "$WORK/out" "OK plan graph"
assert_nogrep "legacy-check-pre no err" "$WORK/err" "ERROR="

pg "$D" --fix
assert_exit  "legacy-fix" 0
assert_grepF "legacy-fix CHANGE" "$WORK/out" "CHANGE=add-frontmatter 1 .agents/plan/auth.md"
assert_fgrep "legacy-fix wrote id"      "$D/.agents/plan/auth.md" "^id: 1"
assert_fgrep "legacy-fix wrote summary" "$D/.agents/plan/auth.md" 'summary: "Auth plan"'

pg "$D"
assert_exit   "legacy-check-post" 0
assert_nogrep "legacy-check-post no warn" "$WORK/err" "WARN=missing frontmatter"
assert_grep   "legacy-check-post OK"      "$WORK/out" "OK plan graph"

# ---------------------------------------------------------------------------
# comment — inline `# ...` comments in frontmatter must not break the parser
# (#4 strip), and a `#` INSIDE a quoted value must NOT be stripped.
# ---------------------------------------------------------------------------
D=$(newcase comment)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "auth.md", s: "Auth plan", x: "done"}

deps:
EOF
cat >"$D/auth.md" <<'EOF'
---
id: 1
summary: "Auth plan"  # human note
x: "done"  # optional state
---

body
EOF
pg "$D"
assert_exit   "comment-check" 0
assert_nogrep "comment-check no mismatch" "$WORK/err" "mismatch"
assert_nogrep "comment-check no error"    "$WORK/err" "ERROR="

D=$(newcase comment-hash)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "auth.md", s: "a # b", x: "done"}

deps:
EOF
cat >"$D/auth.md" <<'EOF'
---
id: 1
summary: "a # b"
x: "done"
---

body
EOF
pg "$D"
assert_exit   "comment-hash-check" 0
assert_nogrep "comment-hash no mismatch (quoted # preserved)" "$WORK/err" "mismatch"

# ---------------------------------------------------------------------------
# done / dropped — non-active states sync to file frontmatter (#5 scope widen).
# ---------------------------------------------------------------------------
D=$(newcase done)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "base.md", s: "Base"}
  2: {p: "dep.md", s: "Dep", x: "done"}

deps:
  1: [2]
EOF
printf '# base\n\nbody\n' >"$D/base.md"
printf '# dep\n\nbody\n'  >"$D/dep.md"
pg "$D" --fix
assert_exit  "done-fix" 0
assert_grepF "done-fix CHANGE"   "$WORK/out" "CHANGE=add-frontmatter 2 dep.md"
assert_fgrep "done-fix wrote x"  "$D/dep.md" 'x: "done"'

D=$(newcase dropped)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "legacy.md", s: "Legacy", x: "dropped"}

deps:
EOF
cat >"$D/legacy.md" <<'EOF'
---
id: 1
summary: "Legacy"
x: "done"
---

body
EOF
pg "$D" --fix
assert_exit  "dropped-fix" 0
assert_grep  "dropped-fix CHANGE x" "$WORK/out" "CHANGE=sync-frontmatter 1 legacy.md .*x"
assert_fgrep "dropped-fix wrote x"  "$D/legacy.md" 'x: "dropped"'
assert_fnogrep "dropped-fix cleared old x" "$D/legacy.md" 'x: "done"'

# missing node: file absent must NOT become a sync error.
D=$(newcase missingnode)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "gone.md", s: "Gone", x: "missing"}

deps:
EOF
pg "$D"
assert_exit   "missingnode-check" 0
assert_grep   "missingnode WARN"          "$WORK/err" "WARN=1 file is missing"
assert_nogrep "missingnode no sync error" "$WORK/err" "frontmatter mismatch"

# ---------------------------------------------------------------------------
# sync — CHANGE=sync-frontmatter token format (#10) + blank line preserved (#9).
# ---------------------------------------------------------------------------
D=$(newcase sync)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: ".agents/plan/auth.md", s: "New summary", x: "dropped"}

deps:
EOF
cat >"$D/.agents/plan/auth.md" <<'EOF'
---
id: 1
summary: "Old summary"
---

First body line after blank.
EOF
pg "$D" --fix
assert_exit   "sync-fix" 0
assert_grepF  "sync-fix token format"   "$WORK/out" "CHANGE=sync-frontmatter 1 .agents/plan/auth.md summary,x"
assert_nogrep "sync-fix no space token" "$WORK/out" "summary, x"
if python3 -c "import sys;c=open(sys.argv[1]).read();sys.exit(0 if '---\n\nFirst body line' in c else 1)" "$D/.agents/plan/auth.md"; then
  pass "sync-fix blank line preserved"
else
  fail "sync-fix blank line preserved" "blank line after frontmatter was swallowed"
fi

# ---------------------------------------------------------------------------
# readonly — a write failure during --fix surfaces as ERROR + exit 1 (#3).
# (chmod here, not in a committed fixture: git can't store 0444 portably.)
# ---------------------------------------------------------------------------
if [ "$ROOT_USER" = "1" ]; then
  skip "readonly-fix" "running as root: 0444 is still writable"
else
  D=$(newcase readonly)
  cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "auth.md", s: "New"}

deps:
EOF
  cat >"$D/auth.md" <<'EOF'
---
id: 1
summary: "Old"
---

body
EOF
  chmod 0444 "$D/auth.md"
  pg "$D" --fix
  chmod 0644 "$D/auth.md"
  assert_exit   "readonly-fix" 1
  assert_grep   "readonly-fix ERROR"      "$WORK/err" "ERROR=failed to update frontmatter in auth.md"
  assert_grep   "readonly-fix FAIL"       "$WORK/err" "FAIL plan graph"
  assert_nogrep "readonly-fix no traceback" "$WORK/err" "Traceback"
fi

# ---------------------------------------------------------------------------
# dedup — duplicate bases collapse on --fix and the rewritten graph re-parses
# (proxy for the atomic write producing valid content).
# ---------------------------------------------------------------------------
D=$(newcase dedup)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "a.md", s: "A", x: "done"}
  2: {p: "b.md", s: "B", x: "done"}

deps:
  1: [2, 2]
EOF
pg "$D" --fix
assert_exit  "dedup-fix" 0
assert_grepF "dedup-fix CHANGE" "$WORK/out" "CHANGE=dedup 1"
assert_fgrep   "dedup-fix collapsed" "$D/.agents/plan/graph.yaml" "1: \[2\]"
assert_fnogrep "dedup-fix no dup"    "$D/.agents/plan/graph.yaml" "1: \[2, 2\]"
pg "$D"   # re-parse mutated graph
assert_exit "dedup-recheck" 0

# ---------------------------------------------------------------------------
# badparse — a malformed graph is exit 2 and (with --fix) left byte-identical:
# the one no-mutation guarantee in the Output Contract.
# ---------------------------------------------------------------------------
D=$(newcase badparse)
printf 'next: 2\n\nnodes:\n  1: {p: oops\n' >"$D/.agents/plan/graph.yaml"
cp "$D/.agents/plan/graph.yaml" "$WORK/badparse.orig"
pg "$D"
assert_exit "badparse-check" 2
assert_grep "badparse-check error" "$WORK/err" "ERROR=parse:"
pg "$D" --fix
assert_exit "badparse-fix exit2" 2
if cmp -s "$D/.agents/plan/graph.yaml" "$WORK/badparse.orig"; then
  pass "badparse-fix did not touch graph"
else
  fail "badparse-fix did not touch graph" "graph was mutated despite parse failure"
fi

# ---------------------------------------------------------------------------
# missing-graph — check fails (exit 1), --fix initializes an empty next:1 graph.
# ---------------------------------------------------------------------------
D=$(newcase missinggraph); rm -rf "$D/.agents"   # no graph at all
python3 "$PG" "$D/.agents/plan/graph.yaml" --root "$D" >"$WORK/out" 2>"$WORK/err"; EC=$?
assert_exit "missinggraph-check" 1
assert_grep "missinggraph-check msg" "$WORK/err" "graph file does not exist"
python3 "$PG" "$D/.agents/plan/graph.yaml" --root "$D" --fix >"$WORK/out" 2>"$WORK/err"; EC=$?
assert_exit  "missinggraph-fix" 0
assert_fgrep "missinggraph-fix next:1" "$D/.agents/plan/graph.yaml" "next: 1"

# ===========================================================================
# NEW-BUG GUARDS — RED against the pre-fix script, GREEN after this PR's fixes.
# ===========================================================================

# BOM on a plan file: --fix must recognize existing frontmatter, NOT prepend a
# second block (silent corruption). [#1]
D=$(newcase bomplan)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: ".agents/plan/a.md", s: "Summary one"}

deps:
EOF
cat >"$D/.agents/plan/a.md" <<'EOF'
---
id: 1
summary: "Summary one"
---

body
EOF
add_bom "$D/.agents/plan/a.md"
pg "$D" --fix
assert_exit   "bomplan-fix" 0
assert_nogrep "bomplan-fix no dup frontmatter" "$WORK/out" "CHANGE=add-frontmatter 1"
# exactly one frontmatter block => exactly one 'id: 1' line
if [ "$(grep -c '^id: 1' "$D/.agents/plan/a.md")" = "1" ]; then
  pass "bomplan-fix single frontmatter block"
else
  fail "bomplan-fix single frontmatter block" "found $(grep -c '^id: 1' "$D/.agents/plan/a.md") id lines (duplicate frontmatter)"
fi

# BOM on graph.yaml: must parse, not report the whole file unparseable. [#1]
D=$(newcase bomgraph)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: ".agents/plan/a.md", s: "Alpha"}

deps:
EOF
cat >"$D/.agents/plan/a.md" <<'EOF'
---
id: 1
summary: "Alpha"
---

body
EOF
add_bom "$D/.agents/plan/graph.yaml"
pg "$D"
assert_exit   "bomgraph-check" 0
assert_grep   "bomgraph-check OK"       "$WORK/out" "OK plan graph"
assert_nogrep "bomgraph-check no parse err" "$WORK/err" "ERROR=parse"

# Duplicate base in deps must NOT exclude the dependent from the roadmap as a
# phantom cycle. [#4]
D=$(newcase dupbase)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "a.md", s: "alpha"}
  2: {p: "b.md", s: "beta"}

deps:
  2: [1, 1]
EOF
pg "$D" --show
assert_exit   "dupbase-show" 0
assert_grep   "dupbase-show dependent in roadmap" "$WORK/out" "2\. \[2\] beta"
assert_nogrep "dupbase-show no phantom cycle"     "$WORK/out" "excluded from roadmap"
# the repeated base must collapse in the tree too (render_tree child set() dedup).
assert_nogrep "dupbase-show no duplicate child"   "$WORK/out" "\[1\] alpha ↑"

# --fix must NOT write frontmatter to a path that escapes the repo root. [#7]
D=$(newcase traversal)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "../escape-traversal.md", s: "Evil"}

deps:
EOF
printf '# outside, no frontmatter\n' >"$WORK/escape-traversal.md"   # lives OUTSIDE the case root
pg "$D" --fix
assert_exit    "traversal-fix exit1" 1
assert_fnogrep "traversal-fix left outside file untouched" "$WORK/escape-traversal.md" "^---"
rm -f "$WORK/escape-traversal.md"

# Cycle/forest must not print a node twice (spurious standalone ↑ line). [#5]
D=$(newcase forestrepeat)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 4

nodes:
  1: {p: "a.md", s: "alpha"}
  2: {p: "b.md", s: "beta"}
  3: {p: "c.md", s: "gamma"}

deps:
  1: [2]
  2: [1]
EOF
pg "$D" --show
assert_exit   "forestrepeat-show" 0
# node 2 must never appear as a top-level (no-prefix) line; only nested or as a child.
assert_nogrep "forestrepeat no duplicate top-level node" "$WORK/out" "^\[2\] beta"

# ---------------------------------------------------------------------------
# lock — a fresh foreign lock blocks --fix (exit 1) and survives; a stale lock
# (>10s) is overtaken and our lock is released afterward (ownership). [#9]
# ---------------------------------------------------------------------------
D=$(newcase lockfresh)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "a.md", s: "alpha", x: "done"}

deps:
EOF
LOCK="$D/.agents/plan/graph.yaml.lock"
printf '999999' >"$LOCK"   # foreign, fresh
pg "$D" --fix              # ~3s: the script retries 3x before giving up
assert_exit "lockfresh-fix blocked" 1
assert_grep "lockfresh-fix ERROR" "$WORK/err" "ERROR=graph locked by another process"
if [ -f "$LOCK" ]; then pass "lockfresh-fix did not delete foreign lock"; else fail "lockfresh-fix did not delete foreign lock" "foreign lock was removed"; fi

D=$(newcase lockstale)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "a.md", s: "alpha", x: "done"}

deps:
EOF
LOCK="$D/.agents/plan/graph.yaml.lock"
printf '999999' >"$LOCK"
touch -d '1 hour ago' "$LOCK" 2>/dev/null || touch -t 202001010000 "$LOCK"
pg "$D" --fix
assert_exit "lockstale-fix overtakes" 0
assert_grep "lockstale-fix OK" "$WORK/out" "OK plan graph"
if [ -f "$LOCK" ]; then fail "lockstale-fix released our lock" "lockfile remained after a run we owned"; else pass "lockstale-fix released our lock"; fi

# ---------------------------------------------------------------------------
# release_lock ownership — must NOT delete a lockfile owned by another pid. [#9]
# (Drives the function directly; the --fix contention path can't exercise the
# "our lock overtaken mid-run" branch.)
# ---------------------------------------------------------------------------
FLOCK="$WORK/relown.lock"
printf '999999' >"$FLOCK"   # a pid that is not ours
# Pass PG and FLOCK as argv (not embedded in the -c string) so MSYS/Git Bash
# path-converts them to native paths — an embedded '/tmp/...' literal is not
# converted and native Windows Python cannot resolve it.
if python3 -c "
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('pg', sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules['pg'] = m; spec.loader.exec_module(m)
m.release_lock(Path(sys.argv[2]))
sys.exit(0 if Path(sys.argv[2]).exists() else 1)
" "$PG" "$FLOCK"; then
  pass "release_lock keeps foreign lock"
else
  fail "release_lock keeps foreign lock" "release_lock deleted a lockfile owned by another pid"
fi
rm -f "$FLOCK"

# ---------------------------------------------------------------------------
# write-fail — a graph write failure surfaces ERROR + exit 1, not a traceback.
# Pre-create graph.yaml.tmp as a DIRECTORY so write_graph's tmp write fails. [#10]
# ---------------------------------------------------------------------------
D=$(newcase writefail)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "a.md", s: "A", x: "done"}
  2: {p: "b.md", s: "B", x: "done"}

deps:
  1: [2, 2]
EOF
mkdir "$D/.agents/plan/graph.yaml.tmp"   # occupies the temp path write_graph needs
pg "$D" --fix
assert_exit   "writefail-fix" 1
assert_grep   "writefail-fix ERROR"      "$WORK/err" "ERROR=failed to write graph"
assert_nogrep "writefail-fix no traceback" "$WORK/err" "Traceback"

# ---------------------------------------------------------------------------
# show-fix-lock — --show takes precedence and never locks, so --show --fix under
# a fresh foreign lock still prints the tree (exit 0), matching the docs.
# ---------------------------------------------------------------------------
D=$(newcase showfixlock)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "a.md", s: "alpha", x: "done"}

deps:
EOF
printf '999999' >"$D/.agents/plan/graph.yaml.lock"
pg "$D" --show --fix
assert_exit   "showfixlock-show" 0
assert_grepF  "showfixlock tree shown" "$WORK/out" "[1] alpha"
assert_nogrep "showfixlock not blocked" "$WORK/err" "graph locked"

# ---------------------------------------------------------------------------
# eval assets — trigger/behavior eval files are well-formed and consistent with
# the skill name (guards against silent drift; the repo validator checks shape
# but this keeps the skill self-testing in isolation).
# ---------------------------------------------------------------------------
if python3 - "$HERE/../evals/behavior-evals.json" "$HERE/../evals/trigger-evals.json" <<'PY'
import json, sys
behavior = json.load(open(sys.argv[1], encoding="utf-8"))
trigger = json.load(open(sys.argv[2], encoding="utf-8"))
assert behavior["skill_name"] == "plan-graph", behavior.get("skill_name")
assert len(behavior["evals"]) >= 4
assert all({"id", "prompt", "expected_output"} <= set(item) for item in behavior["evals"])
assert isinstance(trigger, list) and len(trigger) >= 8
assert sum(1 for x in trigger if x["should_trigger"]) >= 4
assert sum(1 for x in trigger if not x["should_trigger"]) >= 4
assert all({"query", "should_trigger"} <= set(x) for x in trigger)
PY
then
  pass "eval assets have expected schema"
else
  fail "eval assets have expected schema" "invalid eval JSON"
fi

# ---------------------------------------------------------------------------
# deepchain — a long linear dependency chain must not RecursionError: --show
# exercises get_longest_path + render_tree, plain check exercises has_cycle.
# (These were recursive; a ~1500-node chain overflowed the default limit.)
# ---------------------------------------------------------------------------
D=$(newcase deepchain)
python3 - "$D" <<'PY'
import sys
d = sys.argv[1]
n = 1500
g = [f"next: {n+1}", "", "nodes:"]
for i in range(1, n + 1):
    g.append(f'  {i}: {{p: "p{i}.md", s: "node {i}"}}')
g += ["", "deps:"]
for i in range(1, n):
    g.append(f"  {i}: [{i + 1}]")
open(f"{d}/.agents/plan/graph.yaml", "w").write("\n".join(g) + "\n")
# Active plan files with matching frontmatter so both --show and check stay clean.
for i in range(1, n + 1):
    deps = f"deps: [{i + 1}]\n" if i < n else ""
    open(f"{d}/p{i}.md", "w").write(f'---\nid: {i}\nsummary: "node {i}"\n{deps}---\n\nbody {i}\n')
PY
pg "$D" --show
assert_exit   "deepchain-show" 0
assert_nogrep "deepchain-show no traceback"  "$WORK/err" "Traceback"
assert_grepF  "deepchain-show critical path" "$WORK/out" "Critical Path"
pg "$D"
assert_exit   "deepchain-check" 0
assert_nogrep "deepchain-check no traceback" "$WORK/err" "Traceback"
assert_grep   "deepchain-check OK"           "$WORK/out" "OK plan graph"

# ---------------------------------------------------------------------------
# show-fix-missing — --show takes precedence over --fix, so --show --fix on a
# MISSING graph must error (exit 1) and must NOT initialize a graph file.
# ---------------------------------------------------------------------------
D=$(newcase showfixmissing); rm -rf "$D/.agents"
python3 "$PG" "$D/.agents/plan/graph.yaml" --root "$D" --show --fix >"$WORK/out" 2>"$WORK/err"; EC=$?
assert_exit "showfixmissing-noinit" 1
if [ ! -e "$D/.agents/plan/graph.yaml" ]; then
  pass "showfixmissing did not create graph"
else
  fail "showfixmissing did not create graph" "graph.yaml was initialized despite --show"
fi

# ---------------------------------------------------------------------------
# mark/clear missing lifecycle — --fix marks a vanished active file x:missing
# and clears it when the file returns (headline --fix drift repair).
# ---------------------------------------------------------------------------
D=$(newcase marklifecycle)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "ghost.md", s: "Ghost"}

deps:
EOF
pg "$D" --fix
assert_exit  "marklifecycle-mark" 0
assert_grepF "marklifecycle mark CHANGE"     "$WORK/out" "CHANGE=mark 1 missing"
assert_fgrep "marklifecycle graph x:missing" "$D/.agents/plan/graph.yaml" 'x: "missing"'
printf '# ghost\n\nback\n' >"$D/ghost.md"
pg "$D" --fix
assert_exit    "marklifecycle-clear" 0
assert_grepF   "marklifecycle clear CHANGE" "$WORK/out" "CHANGE=clear 1 missing"
assert_fnogrep "marklifecycle x cleared"    "$D/.agents/plan/graph.yaml" 'x: "missing"'

# ---------------------------------------------------------------------------
# suggest-deps INFERRED — weaker keyword-overlap candidate (not a direct
# path/name/summary reference) with dependency language present.
# ---------------------------------------------------------------------------
D=$(newcase inferdep)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 3

nodes:
  1: {p: "auth.md", s: "session token rotation"}
  2: {p: "checkout.md", s: "checkout flow"}

deps:
EOF
printf '# session token rotation\n\nRotate session tokens on login.\n' >"$D/auth.md"
cat >"$D/checkout.md" <<'EOF'
# checkout flow

This work must land after the session rotation groundwork; it also refreshes the token.
EOF
pg "$D" --suggest-deps
assert_exit  "inferdep-show" 0
assert_grepF "inferdep INFERRED provenance" "$WORK/out" "SUGGEST=2->1 INFERRED"

# ---------------------------------------------------------------------------
# validate-errors — dangling dep, self dep, absolute path, and duplicate path
# each surface as ERROR (exit 1) with no traceback; duplicate cites the FIRST id.
# ---------------------------------------------------------------------------
D=$(newcase valerrors)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 5

nodes:
  1: {p: "a.md", s: "A", x: "done"}
  2: {p: "a.md", s: "dup path", x: "done"}
  3: {p: "/etc/passwd", s: "absolute", x: "done"}
  4: {p: "d.md", s: "D", x: "done"}

deps:
  4: [9]
EOF
pg "$D"
assert_exit   "valerrors-check" 1
assert_grep   "valerrors dangling"      "$WORK/err" "ERROR=dangling dep: 4->9"
assert_grep   "valerrors absolute"      "$WORK/err" "ERROR=3 has absolute path"
assert_grep   "valerrors duplicate 1st" "$WORK/err" "ERROR=duplicate node path: 1 and 2 use a.md"
assert_nogrep "valerrors no traceback"  "$WORK/err" "Traceback"

D=$(newcase selfdep)
cat >"$D/.agents/plan/graph.yaml" <<'EOF'
next: 2

nodes:
  1: {p: "a.md", s: "A", x: "done"}

deps:
  1: [1]
EOF
pg "$D"
assert_exit "selfdep-check" 1
assert_grep "selfdep error" "$WORK/err" "ERROR=self dependency: 1"

# ---------------------------------------------------------------------------
# empty-graph --show — a graph with no nodes prints the empty sentinel, exit 0.
# ---------------------------------------------------------------------------
D=$(newcase emptyshow)
printf 'next: 1\n\nnodes:\n\ndeps:\n' >"$D/.agents/plan/graph.yaml"
pg "$D" --show
assert_exit  "emptyshow-show" 0
assert_grepF "emptyshow sentinel" "$WORK/out" "(empty plan graph)"

# ---------------------------------------------------------------------------
printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
