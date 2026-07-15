---
name: agent-memory
description: Use when a task may depend on prior user preferences, repo-specific conventions, earlier decisions, recurring command pitfalls, long-running handoff context, or when the user says to remember, forget, update memory (or 기억해줘 / 잊어버려 / 메모리 업데이트), or use memory across Codex, Claude, opencode, or other coding agents. Not for one-off facts derivable from the code or git history, or ephemeral state that will not matter next session — record those nowhere.
license: MIT
compatibility: Requires Python 3.10 or newer and local filesystem access.
---

# Agent Memory

Maintain a shared local memory protocol for multiple coding agents without an
external service. Memory data lives under `~/.agents/memory` by default, while
this skill and its helper live under the installed skill directory.

Use the helper script for writes:

```bash
python3 <skill-dir>/scripts/memory.py --help
```

Set `AGENT_MEMORY_HOME` to override the data store root. The helper lazily
creates the store and never overwrites unrelated user data. Set
`AGENT_MEMORY_AGENT_ID` to pin the agent identity stamped on captured notes
(otherwise it is derived from the harness — Claude Code, Codex, opencode — or
falls back to a generic id). The store itself is agent-agnostic: any harness
that can run `python3` can share it.

## When NOT to use

- Storing secrets, tokens, or personal data — the helper rejects these; never
  route them here or into `inbox/auto`.
- Ordinary progress logs or one-off paths that will not matter next session.
- Facts already recorded in the repo (code, `CLAUDE.md`, git history) — memory is
  for context that is *not* derivable from the checkout.

## Storage Model

```text
~/.agents/memory/
  .index/
    memory.sqlite3
  config/
    trust.json
  global/
    MEMORY.md
    topics/
      memory/
    inbox/
      explicit/
      auto/
  projects/
    <repo-key>/
      MEMORY.md
      topics/
        memory/
      sessions/
      inbox/
        explicit/
        auto/
```

- `global`: durable user preferences and cross-agent operating conventions.
- `projects/<repo-key>`: repo-specific facts, commands, caveats, and decisions.
- `MEMORY.md`: bounded summary view only; it is not the source of truth.
- `topics/memory/<id>.md`: authoritative promoted records with full body,
  evidence, aliases, verification dates, and supersession history.
- `.index/memory.sqlite3`: disposable SQLite FTS5 index rebuilt from Markdown.
  The Markdown store remains usable through filesystem search when FTS5 is
  unavailable.
- `config/trust.json`: repo keys explicitly allowed to receive global-memory
  recall. Project memory is isolated by repo key by default.
- Other `topics/`: longer OKF-compatible reference material loaded when relevant.
- `sessions/`: handoff/resume context for long work; do not read by default.
- `inbox/explicit`: user-directed memories; always check when reading memory.
- `inbox/auto`: agent-captured candidates; search only when relevant.

### OKF-Compatible Topics

`topics/` concept files may carry OKF-style Markdown frontmatter (`type:
AgentMemoryTopic`, plus optional `title`/`description`/`resource`/`tags`/
`timestamp`) so agents can search, exchange, or cite them. Only `type` is
required. See [references/okf-topics.md](references/okf-topics.md) for the full
shape and rules.

The helper computes `<repo-key>` from normalized git `origin`, then git
toplevel path, then cwd path:

```bash
python3 <skill-dir>/scripts/memory.py repo-key --cwd "$PWD"
```

## Read Mode

Use memory only when it can affect the task. Skip it for self-contained asks
such as simple translations, one-line shell commands, or isolated formatting.

When memory is relevant:

1. Use prompt-aware recall first. It searches summaries, aliases, tags, full
   bodies, and evidence through the rebuildable FTS index:

   ```bash
   python3 <skill-dir>/scripts/memory.py recall --cwd "$PWD" --prompt "<current user request>"
   ```

   Global memory is included only for repos added with `trust add`, or when an
   interactive caller explicitly passes `--include-global`:

   ```bash
   python3 <skill-dir>/scripts/memory.py trust add --cwd "$PWD"
   python3 <skill-dir>/scripts/memory.py trust list
   ```

2. Use `find` for targeted maintenance and metadata filtering:

   ```bash
   python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --query "<keyword>" --budget-lines 40
   ```

3. Treat project durable records and `inbox/explicit` as the first read
   surface. Global durable records are available only under the trust rule.
4. Search other `topics/` and `inbox/auto` only when keywords match the current task,
   or pass `--include-auto` when explicitly reviewing pending candidates.
5. Verify drift-prone memory against repo/system truth when practical. If live
   verification is expensive, say the fact is memory-derived and may be stale.
6. Use filters when the target is known. The `find --type` filter accepts
   memory note types such as `command` and OKF topic types such as
   `AgentMemoryTopic`:

   ```bash
   python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --scope project --type command --query "docs"
   python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --type AgentMemoryTopic --query "verification"
   ```

7. Do not flood context. Recall context is capped at 6 KiB; increase
   `--budget-lines` only when the current task
   needs more detail.

## Capture Mode

Before the final response for meaningful work, run a short retention pass:

- Did the user explicitly ask to remember or change a preference?
- Did the session confirm a repo-specific command, caveat, or failure mode?
- Did a long-running task leave a state that a later agent must resume?
- Is the information durable, non-sensitive, and useful outside this session?

If yes, capture it. If no, do nothing.

### Explicit Memories

User wording such as "remember", "next time", "from now on", or "keep this in
memory" is explicit. Capture it even if you do not promote it immediately.

```bash
python3 <skill-dir>/scripts/memory.py note \
  --cwd "$PWD" \
  --scope global \
  --priority explicit \
  --type preference \
  --source user \
  --confidence high \
  --summary "Prefer narrow verification for small edits" \
  --alias "proportional verification" \
  --alias "비례 검증" \
  --tag verification \
  --body "User prefers proportional checks such as targeted tests and git diff --check for small scoped edits."
```

Promote explicit notes only when the instruction is unambiguous and does not
conflict with existing canonical memory:

```bash
python3 <skill-dir>/scripts/memory.py promote --cwd "$PWD" --note "<note-path>"
```

Promotion writes the complete authoritative record under `topics/memory/` and
adds only a concise pointer to `MEMORY.md`. Therefore the summary index can stay
small without losing the original body or evidence. `promote` accepts only a non-symlink note from the global inbox or the current
project's inbox. It rejects copied external files, path/frontmatter mismatches,
and notes belonging to another project.

If it conflicts or is ambiguous, leave it in `inbox/explicit` and surface the
conflict briefly.

### Automatic Memories

Automatic canonical promotion is deliberately narrow. Only auto-promote when
all are true:

- `scope=project`
- `confidence=high`
- `type` is `project-fact`, `command`, or `caveat`
- evidence kind is `command`, `repo-file`, or `test-result`
- the fact is concise, verified, non-sensitive, and likely reusable

Example:

```bash
NOTE="$(
  python3 <skill-dir>/scripts/memory.py note \
    --cwd "$PWD" \
    --scope project \
    --priority auto \
    --type command \
    --source command \
    --confidence high \
    --summary "Run pnpm run test:quality after docs path changes" \
    --evidence command:"pnpm run test:quality" \
    --tag docs \
    --tag verification \
    --body "This repo has static path/link checks that catch stale documentation references." |
  sed -n 's/^NOTE=//p'
)"
python3 <skill-dir>/scripts/memory.py promote --cwd "$PWD" --note "$NOTE"
```

Use `inbox/auto` without promotion for lower-confidence or narrower facts:

```bash
python3 <skill-dir>/scripts/memory.py note \
  --cwd "$PWD" \
  --scope project \
  --priority auto \
  --type caveat \
  --source session \
  --confidence medium \
  --summary "A transient test failure occurred on this branch" \
  --body "Keep as candidate only unless the same failure repeats with evidence."
```

Never auto-promote global preferences, global operating rules, decisions, or
anything inferred only from conversation.

To stage learning candidates from session notes, use `propose`. It scans text
for explicit corrections, repeated failures, and verified commands, then writes
only `inbox/auto` notes. It never edits canonical `MEMORY.md`; run `review` and
`promote` separately after checking the candidates and evidence.

```bash
python3 <skill-dir>/scripts/memory.py propose \
  --cwd "$PWD" \
  --scope project \
  --source session \
  --tag verification \
  --input /tmp/session-notes.txt \
  --format json
```

## Do Not Record

Do not record:

- Secrets, tokens, passwords, private keys, or personal data.
- Guesses, speculation, or unverified external facts.
- Ordinary progress logs that will not matter next session.
- One-off file paths from a temporary branch.
- Large summaries that belong in `topics/` or a session handoff.

There is no `forget` note *type* — the note types are the six listed above. To
forget or remove memory, use the `forget` command (see **Forget Mode** below),
not a note. Leave a short explicit note only when a tombstone is necessary to
prevent reintroducing stale memory.

## Forget Mode

When the user asks to forget or remove a memory, use the `forget` command:

```bash
# Remove a specific inbox note by path
python3 <skill-dir>/scripts/memory.py forget --cwd "$PWD" --note "<note-path>"

# Remove all notes matching a summary text
python3 <skill-dir>/scripts/memory.py forget --cwd "$PWD" --summary "<summary text>"

# Remove one promoted canonical entry by stable id
python3 <skill-dir>/scripts/memory.py forget --cwd "$PWD" --id "mem_20260627_ab12cd34"

# Also remove matching entries from canonical MEMORY.md
python3 <skill-dir>/scripts/memory.py forget --cwd "$PWD" --summary "<summary text>" --canonical

# Delete a note AND its promoted canonical entry in one call
python3 <skill-dir>/scripts/memory.py forget --cwd "$PWD" --note "<note-path>" --summary "<summary text>" --canonical
```

Canonical `MEMORY.md` is touched **only** with `--canonical`; without it,
`forget` removes inbox notes (and the named `--note` file) but leaves promoted
entries intact. Use `--canonical` when a stale fact has already been promoted
and must be removed to prevent reintroduction. `forget` prints `FORGET=<path>`
per removed file and `REMOVED=<line>` per deleted canonical entry.

**Scope.** `--summary` matching (inbox and, with `--canonical`, MEMORY.md) is
confined to the **current repo (`--cwd`) plus global memory**. Pass
`--all-projects` to match across every project's store. `--note` and `--id`
target a single path/id and ignore this flag.

## Verify Mode

When a promoted canonical entry is re-checked against current repo/system truth,
refresh its verification date by stable id:

```bash
python3 <skill-dir>/scripts/memory.py verify --cwd "$PWD" --id "mem_20260627_ab12cd34"
python3 <skill-dir>/scripts/memory.py verify --cwd "$PWD" --id "mem_20260627_ab12cd34" --date 2026-06-27
```

Only verify after actually checking the fact. Do not use `verify` to make stale
memory look current.

## Update and Supersede

Do not rewrite history in place when a promoted fact changes. Create a new
version and mark the old durable record superseded:

```bash
python3 <skill-dir>/scripts/memory.py update \
  --id "mem_20260627_ab12cd34" \
  --summary "Use pnpm test:quality after documentation path changes" \
  --alias "docs verification" \
  --body "The replacement procedure and why it applies."
```

`supersede` is an alias of `update`. Recall excludes superseded records while
the Markdown history remains inspectable.

## Index, Migration, and Native Imports

The index is derived state. Inspect or rebuild it without changing memory:

```bash
python3 <skill-dir>/scripts/memory.py index status --format json
python3 <skill-dir>/scripts/memory.py index rebuild
```

Upgrade an older summary-only store with a preview, backup, and apply pass:

```bash
python3 <skill-dir>/scripts/memory.py migrate --cwd "$PWD" --format json
python3 <skill-dir>/scripts/memory.py migrate --cwd "$PWD" --apply
```

Claude, Codex, or `.remember` Markdown can be staged as reviewable
medium-confidence candidates. Import never promotes automatically, never edits
the source, and is idempotent by source path plus content. Codex defaults to
curated summary/ad-hoc notes; `.remember` defaults to active entry-sized
`now.md`/`today-*.md` content:

```bash
python3 <skill-dir>/scripts/memory.py import-existing --cwd "$PWD" --format json
python3 <skill-dir>/scripts/memory.py import-existing --cwd "$PWD" --apply
```

`import-existing` combines current-project Claude and `.remember` memory with
conservatively matched Codex global preferences. Use `import-native` for a
single source or custom filters:

```bash
python3 <skill-dir>/scripts/memory.py import-native --harness claude --cwd "$PWD" --format json
python3 <skill-dir>/scripts/memory.py import-native --harness claude --cwd "$PWD" --apply
python3 <skill-dir>/scripts/memory.py import-native --harness remember --cwd "$PWD" --format json
python3 <skill-dir>/scripts/memory.py import-native --harness codex --scope global --only-type preference --match "user preference" --cwd "$PWD" --format json
```

Review the preview before adding `--apply`. Use `--include-history` only for an
intentional raw/rollout/archive import. `--only-type` and repeatable `--match`
filters narrow mixed stores before apply. Codex preference cues are typed as
preferences; rolling `.remember` entries are typed as handoffs. Duplicate and
sensitive candidates appear in `skipped`.

## Claude, Codex, and OpenCode Integration

For human installation from this repository, prefer the single-command setup:

```bash
./install.sh --local agent-memory --shadow
./install.sh --local agent-memory --primary
```

The installer syncs the skill, configures all three harnesses, installs the
`agent-memory` launcher, creates backups, and prints the remaining manual
review/restart actions. Use the lower-level commands below for diagnostics,
custom harness selection, or uninstalling only adapters.

Use `shadow` first: agent-memory supplies prompt-time recall while native
memory remains enabled. Integration commands are dry-run unless `--apply` is
present, merge existing JSON settings, and back up changed configs:

```bash
python3 <skill-dir>/scripts/memory.py doctor --format json
python3 <skill-dir>/scripts/memory.py integrate --mode shadow --harness all --format json
python3 <skill-dir>/scripts/memory.py integrate --mode shadow --harness all --apply
```

Codex treats a new or changed user command hook as untrusted until reviewed;
open `/hooks` once after installation and trust the exact agent-memory hook.
Restart OpenCode after installing or changing its global plugin file.

After comparing recall quality, `primary` disables recognized native Codex and
Claude memory settings. It refuses enabled remember-plugin conflicts unless
they have been reviewed and `--disable-known-conflicts` is passed. Recognized
Codex plugin tables are disabled while unrelated plugin and hook state is
preserved:

```bash
python3 <skill-dir>/scripts/memory.py integrate --mode primary --harness all --apply --disable-known-conflicts
python3 <skill-dir>/scripts/memory.py integrate --mode off --harness all --apply
```

`off` removes only adapters carrying agent-memory's ownership marker. It does
not silently re-enable native memory settings disabled during primary mode.
Prompt hooks fail open: an unavailable store, malformed event, timeout, or
adapter error returns no context and never blocks the host agent.

## Review Mode

Review memory health without mutating anything. Read/search/list/stats/check,
session list/resume, and cleanup dry-run also leave an absent store absent:

```bash
python3 <skill-dir>/scripts/memory.py review --cwd "$PWD"
python3 <skill-dir>/scripts/memory.py review --cwd "$PWD" --stale-days 90 --format json
```

Use review before larger cleanup. It reports promotion candidates, invalid
candidates, duplicate summaries, stale canonical entries, missing canonical ids,
missing source notes, overgrown files, and inbox pressure.

## Session Handoffs

Use project sessions for short-lived handoff/resume state that should not become
durable canonical memory:

```bash
python3 <skill-dir>/scripts/memory.py session save \
  --cwd "$PWD" \
  --id "handoff-branch-cleanup" \
  --summary "Continue branch cleanup" \
  --body "Branch: feature/docs. Touched docs/reference. Next: run path checks."

python3 <skill-dir>/scripts/memory.py session list --cwd "$PWD"
python3 <skill-dir>/scripts/memory.py session resume --cwd "$PWD" --latest
python3 <skill-dir>/scripts/memory.py session close --cwd "$PWD" --id "handoff-branch-cleanup"
```

Do not read sessions by default. Use them when the user asks to continue,
resume, inspect a handoff, or when a long-running task must be picked up by a
later agent.

## List and Stats

List inbox notes with optional filters:

```bash
python3 <skill-dir>/scripts/memory.py list --cwd "$PWD" --scope project --type command
python3 <skill-dir>/scripts/memory.py list --cwd "$PWD" --format json
```

Show memory store statistics:

```bash
python3 <skill-dir>/scripts/memory.py stats --cwd "$PWD"
python3 <skill-dir>/scripts/memory.py stats --cwd "$PWD" --format json
```

## Cleanup

Remove old inbox notes that are no longer relevant:

```bash
# Preview what would be removed (dry-run)
python3 <skill-dir>/scripts/memory.py cleanup --cwd "$PWD" --older-than-days 90 --dry-run

# Actually remove old notes
python3 <skill-dir>/scripts/memory.py cleanup --cwd "$PWD" --older-than-days 90
```

Cleanup is confined to the **current repo (`--cwd`) plus global memory**; other
projects' inboxes are untouched. Pass `--all-projects` to prune every project's
inbox store-wide.

## JSON Output

`recall`, `index`, `migrate`, `import-existing`, `import-native`, `integrate`,
`doctor`, `find`, `list`, `stats`, `propose`, `review`, `session list`, and
`session resume` accept `--format json`. Full field-by-field schemas are in
[references/json-output.md](references/json-output.md).

## Helper Contract

The helper enforces the mechanical parts that agents are bad at doing manually:

- Stable `repo-key` generation with credential stripping and URL normalization.
- Unique inbox filenames using UTC timestamp, agent id, and random suffix.
- A memory-store lock around writes.
- Canonical updates by read/merge/dedupe under lock, temp write, and atomic rename.
- Sensitive-pattern rejection for note and canonical content.
- Promotion eligibility checks and stable canonical ids.
- Full durable promoted records and bounded summary pointers.
- Alias-aware prompt recall with SQLite FTS5 and filesystem fallback.
- Versioned update/supersede history and trust-gated global recall.
- Dry-run migrations, native imports, and harness integration with backups.
- Propose: conservative session-text candidate extraction into `inbox/auto` only.
- Budgeted ranked lookup with filters.
- Forget: inbox note deletion and optional canonical entry removal by summary or id.
- Verify: canonical `last_verified` updates by id.
- Review: non-mutating health findings for stale, duplicate, invalid, and promotable memory.
- Session handoffs: save, list, resume, and close project handoff notes.
- List: filtered enumeration of inbox notes.
- Stats: store-wide statistics aggregation.
- Cleanup: age-based inbox pruning with dry-run support.

## Validation

```bash
python3 <skill-dir>/scripts/memory.py check --cwd "$PWD"
bash <skill-dir>/tests/run.sh
python3 <skill-dir>/tests/benchmark.py
```

Run `check` after manual memory maintenance or when memory behavior looks wrong.
It reports malformed frontmatter, stale locks, missing evidence, oversized
summaries, sensitive-pattern hits, and a `MEMORY.md` that has grown past its line
budget. The benchmark builds the production FTS schema with 50,000 synthetic
records and gates 200 selective queries at a 25 ms p95 default.

If the helper is unavailable, read memory files directly but do not edit
canonical `MEMORY.md`. At most, create a uniquely named inbox note manually and
report that helper validation could not run. Run any subcommand with `--help`
for its full flag list.

## Common Mistakes

- Editing canonical `MEMORY.md` by hand instead of using `promote`/`forget` —
  bypasses locking, dedupe, and validation.
- Expecting `forget --summary` to scrub `MEMORY.md` — it removes inbox notes
  only; add `--canonical` to touch promoted entries.
- Running `find` with no query and expecting topics — topics load only with a
  query or `--include-topics`.
- Promoting an explicit/user preference as an automatic project fact — only
  verified automatic project operational facts are promotion-eligible.

## Report Discipline

When memory materially influenced the answer, say so briefly. If the memory was
not verified in the current turn and may drift, state that it is memory-derived
and may be stale. Do not present unverified memory as current repo truth.
