# Agent Memory

Agent Memory is a local, agent-neutral memory store shared by Claude Code,
Codex, OpenCode, and any other harness that can run Python. Markdown files are
the source of truth; SQLite FTS5 is a disposable search index.

It is designed to be the primary memory layer instead of relying on each
harness's smaller, isolated native memory.

## Install

For a cautious rollout that keeps native memory enabled:

```bash
./install.sh --local agent-memory --shadow
```

To install Agent Memory directly as the primary memory layer:

```bash
./install.sh --local agent-memory --primary
```

Both commands install the skill, configure Claude/Codex/OpenCode, create
backups, install a short launcher under `~/.local/bin`, and print the remaining
Codex hook-review and OpenCode restart actions. Installation without integration
is still available as `./install.sh --local agent-memory`.

After installation, use the short launcher:

```bash
agent-memory --help
```

Memory data is stored under `~/.agents/memory/`. Set `AGENT_MEMORY_HOME` to use
a different location.

## Recommended rollout

Start in `shadow` mode. Agent Memory supplies prompt-time recall while Claude
and Codex native memory remain enabled:

```bash
./install.sh --local agent-memory --shadow
agent-memory doctor --format json
```

After installation:

- In Codex, open `/hooks` and trust the exact Agent Memory hook.
- Restart OpenCode so it loads the global plugin.
- Claude Code reads the merged user hook from `~/.claude/settings.json`.

Run in shadow mode long enough to compare recall quality. Once Agent Memory is
working reliably, switch with the same installation command:

```bash
./install.sh --local agent-memory --primary
```

Passing `--primary` is the explicit authorization to disable recognized native
and competing memory integrations. The installer:

- disables Claude auto memory and Codex native memories;
- disables recognized Codex `remember` plugin tables;
- preserves unrelated plugin and hook state;
- keeps the shared prompt adapters installed; and
- backs up every changed configuration file.

To remove only Agent Memory-owned adapters:

```bash
agent-memory integrate --mode off --harness all --apply
```

`off` does not silently re-enable native memory settings disabled in primary
mode.

## Import existing native memory

Imports are preview-first and create reviewable, medium-confidence candidates;
they never promote automatically or modify the source files. By default Codex
imports only its summary and curated `ad_hoc/notes`, while `.remember` imports
active `now.md`/`today-*.md` entries instead of duplicate archives:

```bash
# Recommended: handle the useful default subset from every store at once.
agent-memory import-existing --cwd "$PWD" --format json
agent-memory import-existing --cwd "$PWD" --apply
```

Use the lower-level command only when selecting one source or custom filters:

```bash
agent-memory import-native --harness claude --cwd "$PWD" --format json
agent-memory import-native --harness claude --cwd "$PWD" --apply

agent-memory import-native --harness remember --cwd "$PWD" --format json
agent-memory import-native --harness remember --cwd "$PWD" --apply

# Narrow mixed Codex notes before placing personal preferences in global scope.
agent-memory import-native --harness codex --scope global --only-type preference --match "user preference" --cwd "$PWD" --format json
agent-memory import-native --harness codex --scope global --only-type preference --match "user preference" --cwd "$PWD" --apply

# Import only Codex notes that mention the current project into project scope.
agent-memory import-native --harness codex --match "$(basename "$PWD")" --cwd "$PWD" --format json
```

Inspect the JSON preview before adding `--apply`. Add `--include-history` only
when you deliberately want Codex raw/rollout history or `.remember`
recent/archive files considered. Re-running the same import is idempotent;
duplicate content and secret-looking entries are reported under `skipped`.
Use repeatable `--match TERM` filters when a preview still mixes unrelated
projects or topics; repeated terms use OR matching.

Upgrade an older Agent Memory store from summary-only entries to durable topic
records with the same preview/apply flow:

```bash
agent-memory migrate --cwd "$PWD" --format json
agent-memory migrate --cwd "$PWD" --apply
```

Both operations are idempotent. Applied store-format migrations create backups.

## Everyday use

Recall memory relevant to the current prompt:

```bash
agent-memory recall --cwd "$PWD" --prompt "current task" --format json
```

Global memory is excluded from a repository until that repo is trusted:

```bash
agent-memory trust add --cwd "$PWD"
agent-memory trust list
```

Capture and promote an explicit memory:

```bash
NOTE="$(
  agent-memory note \
    --cwd "$PWD" \
    --scope project \
    --priority explicit \
    --type preference \
    --source user \
    --confidence high \
    --summary "Prefer targeted verification" \
    --alias "비례 검증" \
    --body "Run the narrowest useful checks for small scoped changes." |
  sed -n 's/^NOTE=//p'
)"
agent-memory promote --cwd "$PWD" --note "$NOTE"
```

When a promoted fact changes, preserve history instead of overwriting it:

```bash
agent-memory update \
  --id mem_20260715_ab12cd34 \
  --summary "Use the new verification command" \
  --body "Replacement details"
```

Useful maintenance commands:

```bash
agent-memory review --cwd "$PWD" --format json
agent-memory index status --format json
agent-memory index rebuild
agent-memory check --cwd "$PWD"
```

## Storage model

```text
~/.agents/memory/
  .index/memory.sqlite3       # rebuildable FTS5 index
  config/trust.json           # repos allowed global recall
  global/
    MEMORY.md                 # bounded summary view
    topics/memory/<id>.md     # authoritative promoted records
    inbox/{explicit,auto}/
  projects/<repo-key>/
    MEMORY.md
    topics/memory/<id>.md
    sessions/
    inbox/{explicit,auto}/
```

Promoted topic records retain the full body, evidence, aliases, verification
dates, and supersession history. `MEMORY.md` is only a compact pointer surface,
so reaching its line budget does not discard memory.

The index rebuilds automatically when dirty. If FTS5 is unavailable, the index
is corrupt, or the store is read-only, recall falls back to Markdown search.
Prompt adapters fail open and never block the host agent.

## Verification

```bash
bash skills/agent-memory/tests/run.sh
python3 skills/agent-memory/tests/benchmark.py
python3 skills/agent-memory/scripts/memory.py check --cwd "$PWD"
```

The benchmark uses the production FTS schema with 50,000 synthetic records and
gates 200 selective queries at a 25 ms p95 default.

For retention policy, promotion eligibility, forgetting, session handoffs, and
the complete command contract, see [SKILL.md](SKILL.md). JSON response fields
are documented in [references/json-output.md](references/json-output.md).
