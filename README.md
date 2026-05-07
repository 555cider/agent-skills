# peer-review

Tool-neutral peer-review skill. Sends a plan/spec to a reviewer LLM and saves
the response to `<repo>/docs/reviews/` (or `./reviews/` outside a repo).

One skill within the `agent-skills` repo. See [root README](../../README.md)
for the wiring model — `install.sh` symlinks this directory into
`~/.agents/skills/peer-review/` and the detected harness skill dirs.

## Layout

- `SKILL.md` — canonical SKILL prompt for both harnesses. Describes both
  Claude Code (slash command) and codex CLI (natural language) invocation
  modes. The model picks the right branch from its harness context.
- `scripts/run-peer-review.sh` — the orchestration script. CLI-agnostic; takes
  a plan file and reviewer choice, returns a saved review path on stdout.

## Used by

Each harness's skill dir symlinks both `SKILL.md` and `scripts/` to here so
the canonical implementation stays in one place. Edit the canonical files
and both harnesses pick up the change immediately.

- **Claude Code:** `~/.claude/skills/peer-review/{SKILL.md,scripts}` →
  symlinks here. Slash command: `/peer-review`. Defaults `--reviewer=codex`.
- **Codex CLI:** `~/.codex/skills/peer-review/{SKILL.md,scripts}` → symlinks
  here. Wire up via `~/.codex/AGENTS.md` or codex's skill/plugin mechanism.
  The SKILL.md instructs codex to exclude itself from the reviewer list
  (codex reviewing codex defeats the purpose).

## Porting to a new harness

1. Create the harness skill dir (e.g. `~/.cursor/skills/peer-review/`).
2. Symlink `SKILL.md` → `~/.agents/skills/peer-review/SKILL.md`.
3. Symlink `scripts` → `~/.agents/skills/peer-review/scripts`.
4. If the harness has its own behavioral policy (e.g. allows proactive
   self-invocation), add a paragraph for it under "When to self-invoke" in
   the canonical SKILL.md — the model picks the branch matching its harness.

## Script usage

```
run-peer-review.sh <plan-file> \
  [--reviewer=<list>]         # default: codex; comma-separated list runs in parallel
                              #   choices: codex, claude, gemini, qwen, opencode, all,
                              #            any profile name from JSON config, or
                              #            1-based index / range when a config is loaded
                              #            (e.g., 2 / 1-3 / 1,3,my-claude)
                              #   `all` = every defined profile (or every CLI on PATH if no config)
  [--focus=all|feasibility|correctness|assumptions|repo-fit|choice]   # default: all
  [--source=file|chat]        # default: file (chat means caller wrote a temp file from chat content)
  [--exclude-cli=<cli>]       # filter `all` expansion by backing CLI (used to avoid self-review)
  [--list]          # print the index map for the loaded config and exit
```

## Optional config

Define named profiles in JSON, search order:

1. `<repo>/.peer-review.json` (project-local override)
2. `${XDG_CONFIG_HOME:-~/.config}/peer-review/config.json` (global)

```json
{
  "reviewers": {
    "codex-deep":  { "cli": "codex",   "model": "gpt-5",        "effort": "high" },
    "codex-fast":  { "cli": "codex",   "model": "gpt-5-mini",   "effort": "low"  },
    "claude-opus": { "cli": "claude",  "model": "claude-opus-4-7" },
    "gemini":      { "cli": "gemini",  "model": "gemini-2.5-pro" }
  }
}
```

- `cli` — required unless the profile name itself is one of the five known CLI names.
- `model` (optional) — passed to the CLI's model flag (`--model` or `-m` depending on CLI). Omit to let the CLI use whatever model/provider it's configured to default to.
- `effort` (optional) — passed where supported: codex (`-c model_reasoning_effort=...`),
  opencode (`--variant ...`). Silently ignored on claude/gemini/qwen. Omit to use the CLI's default.
- A profile entry can be empty (`"opencode": { "cli": "opencode" }`) — that just labels the CLI without overriding anything. Equivalent to `--reviewer=opencode` with no config at all.
- Profile names: `[A-Za-z0-9._-]+`. Can repeat the same `cli` across profiles
  (`codex-deep` + `codex-fast` etc.) — each gets its own review file. Names
  matching `^[0-9]+$` or `^[0-9]+-[0-9]+$` (e.g. `"3"`, `"1-2"`) are rejected
  to avoid clashing with index/range notation.
- Profiles are listed in the order they appear in the JSON file; `--reviewer=N`
  refers to the N-th entry (1-based), `--reviewer=L-H` to a contiguous range.
  Use `--list` to see the current index map.

Requires `python3` to parse. Without it, the script logs a warning and falls
back to the no-config behavior.

Whether to commit `.peer-review.json` to your repo is your call: commit it if
the team should share the same profiles; keep it local (or `.gitignore` it)
if it encodes personal preferences only.

Stdout (one line per successful reviewer):
```
REVIEW=<reviewer-name> <absolute path to saved review>
EXCLUDE_NOTE=<optional message about .git/info/exclude update>
```

Stderr (one line per failed reviewer):
```
ERROR=<reviewer-name> <message>
```

Exit codes: 0 ok (at least one reviewer succeeded), 2 usage, 3 reviewer CLI
missing, 4 filename claim failed, 5 empty response (single-reviewer mode),
6 every reviewer failed (multi-reviewer mode), * reviewer's own exit
(single-reviewer mode).

## Implementation notes

- **Output dir:** 3-tier resolution — `<repo>/docs/reviews/` if `<repo>/docs/`
  exists, else `<repo>/reviews/`, else `./reviews/`. Falls back to
  `/tmp/peer-review/` if mkdir fails.
- **Per-clone exclude:** review outputs are added to `.git/info/exclude` (not
  `.gitignore`), worktree-safe via `git rev-parse --git-path`. Avoids
  committing review files while not polluting shared `.gitignore`.
- **Atomic filename claim:** `set -C` (noclobber) + retry-on-collision (5
  attempts) for safe concurrent runs. Slug derived from plan filename or
  first heading.
- **Reviewer sandboxing / headless mode:**
  - codex: `codex exec --sandbox read-only` (read-only sandbox)
  - claude: `claude -p` (relies on claude's permission system)
  - gemini: `gemini --approval-mode plan --output-format text -p ""` (plan mode = read-only)
  - qwen: `qwen --approval-mode plan -p ""` (plan mode = read-only)
  - opencode: `opencode run` (relies on opencode's permission defaults; ANSI
    color codes stripped from saved output)
  All five accept the prompt over stdin.
- **Parallel execution:** multiple reviewers spawn as background subprocesses,
  each with its own temp files and claimed `OUT_FILE`. The script waits for
  all, emits one `REVIEW=` per success and one `ERROR=` per failure. Wall
  clock = slowest reviewer, not sum.
- **Prompt injection guard:** plan content wrapped in `<PLAN-{nonce}>` markers
  with a random 12-byte hex nonce; reviewer instructed to treat content as
  data, not instructions. Nonce regenerated if it collides with plan text.
- **Timeout:** reviewer call bounded to 600s via `timeout` / `gtimeout` if
  available; runs unbounded otherwise.
- **No auto-cleanup** of old review files. **No automated tests** against the
  script (TODO: bats fixtures for slug derivation, collision retry, exclude
  update, delimiter collision).

## Why `.agents/`

Multiple AI coding tools (Claude Code, Codex, Cursor, etc.) are converging on
`AGENTS.md` as the standard agent-instruction format. `.agents/skills/`
follows that convention as a tool-neutral skill location. Each tool's own
skill dir (`.claude/skills/`, `~/.codex/...`) symlinks or references files
here so the canonical implementation stays in one place.

## History

Originally designed and iterated through 5 rounds of self-review — the
script was used to review its own design spec.
