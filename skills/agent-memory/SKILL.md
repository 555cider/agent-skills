---
name: agent-memory
description: Use when a task may depend on prior user preferences, repo-specific conventions, earlier decisions, recurring command pitfalls, long-running handoff context, or when the user says to remember, forget, update memory, or use memory across Codex, Claude, opencode, or other coding agents.
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
creates the store and never overwrites unrelated user data.

## Storage Model

```text
~/.agents/memory/
  global/
    MEMORY.md
    topics/
    inbox/
      explicit/
      auto/
  projects/
    <repo-key>/
      MEMORY.md
      topics/
      sessions/
      inbox/
        explicit/
        auto/
```

- `global`: durable user preferences and cross-agent operating conventions.
- `projects/<repo-key>`: repo-specific facts, commands, caveats, and decisions.
- `MEMORY.md`: short curated summary only.
- `topics/`: longer reference material loaded only when relevant.
- `sessions/`: handoff/resume context for long work; do not read by default.
- `inbox/explicit`: user-directed memories; always check when reading memory.
- `inbox/auto`: agent-captured candidates; search only when relevant.

The helper computes `<repo-key>` from normalized git `origin`, then git
toplevel path, then cwd path:

```bash
python3 <skill-dir>/scripts/memory.py repo-key --cwd "$PWD"
```

## Read Mode

Use memory only when it can affect the task. Skip it for self-contained asks
such as simple translations, one-line shell commands, or isolated formatting.

When memory is relevant:

1. Search concise summaries first. Results are ranked by relevance, with
   project-scope and matching canonical/explicit memories preferred:

   ```bash
   python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --query "<keyword>" --budget-lines 40
   ```

2. Treat `global/MEMORY.md`, project `MEMORY.md`, and `inbox/explicit` as the
   first read surface.
3. Search `topics/` and `inbox/auto` only when keywords match the current task,
   or pass `--include-auto` when explicitly reviewing pending candidates.
4. Verify drift-prone memory against repo/system truth when practical. If live
   verification is expensive, say the fact is memory-derived and may be stale.
5. Use filters when the target is known:

   ```bash
   python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --scope project --type command --query "docs"
   ```

6. Do not flood context. Increase `--budget-lines` only when the current task
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
  --tag verification \
  --body "User prefers proportional checks such as targeted tests and git diff --check for small scoped edits."
```

Promote explicit notes only when the instruction is unambiguous and does not
conflict with existing canonical memory:

```bash
python3 <skill-dir>/scripts/memory.py promote --cwd "$PWD" --note "<note-path>"
```

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

There is no `forget` note type. If the user asks to forget or remove memory,
inspect the relevant canonical memory and inbox notes, then delete or amend the
specific entries intentionally. Leave a short explicit note only when a
tombstone is necessary to prevent reintroducing stale memory.

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
```

Use `--canonical` only when the stale fact has already been promoted to
`MEMORY.md` and must be removed to prevent reintroduction.

## Verify Mode

When a promoted canonical entry is re-checked against current repo/system truth,
refresh its verification date by stable id:

```bash
python3 <skill-dir>/scripts/memory.py verify --cwd "$PWD" --id "mem_20260627_ab12cd34"
python3 <skill-dir>/scripts/memory.py verify --cwd "$PWD" --id "mem_20260627_ab12cd34" --date 2026-06-27
```

Only verify after actually checking the fact. Do not use `verify` to make stale
memory look current.

## Review Mode

Review memory health without mutating anything:

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

## JSON Output

The `find`, `list`, `stats`, and `propose` commands support `--format json` for
programmatic consumption:

```bash
python3 <skill-dir>/scripts/memory.py find --cwd "$PWD" --query "test" --format json
```

JSON output includes `results`, `truncated`, and a `total` count for
pagination. `find --format json` preserves the text-mode read surface while
returning normalized ranked result records:

- `kind`: `canonical`, `explicit`, `auto`, or `topic`
- `scope`: `global` or `project`
- `path`: source file path
- `text`: source text when the result comes from canonical memory or a topic
- `score`: deterministic relevance score for ordering
- `matched_fields`: fields that matched the query
- `snippet`: compact matched context when available

Inbox note results keep their note metadata (`summary`, `type`, `priority`,
`source`, `confidence`, `created_at`, `agent_id`, `repo_key`, `tags`,
`evidence`, and `body`). Canonical `MEMORY.md` bullet entries also expose parsed
metadata when available, including `id`, `type`, `summary`, `confidence`,
`source_note`, `last_verified`, and `tags`.

## Helper Contract

The helper enforces the mechanical parts that agents are bad at doing manually:

- Stable `repo-key` generation with credential stripping and URL normalization.
- Unique inbox filenames using UTC timestamp, agent id, and random suffix.
- A memory-store lock around writes.
- Canonical updates by read/merge/dedupe under lock, temp write, and atomic rename.
- Sensitive-pattern rejection for note and canonical content.
- Promotion eligibility checks and stable canonical ids.
- Propose: conservative session-text candidate extraction into `inbox/auto` only.
- Budgeted ranked lookup with filters.
- Forget: inbox note deletion and optional canonical entry removal by summary or id.
- Verify: canonical `last_verified` updates by id.
- Review: non-mutating health findings for stale, duplicate, invalid, and promotable memory.
- Session handoffs: save, list, resume, and close project handoff notes.
- List: filtered enumeration of inbox notes.
- Stats: store-wide statistics aggregation.
- Cleanup: age-based inbox pruning with dry-run support.

Validation:

```bash
python3 <skill-dir>/scripts/memory.py check --cwd "$PWD"
```

Run `check` after manual memory maintenance or when memory behavior looks wrong.
It reports malformed frontmatter, stale locks, missing evidence, oversized
summaries, and overgrown canonical summaries.

If the helper is unavailable, read memory files directly but do not edit
canonical `MEMORY.md`. At most, create a uniquely named inbox note manually and
report that helper validation could not run.

## Report Discipline

When memory materially influenced the answer, say so briefly. If the memory was
not verified in the current turn and may drift, state that it is memory-derived
and may be stale. Do not present unverified memory as current repo truth.
