# peer-review

Tool-neutral peer-review skill. Sends a plan/spec to a reviewer LLM and saves
the response to a repo-local temporary reviews directory.

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

Each harness's skill dir links to this directory (POSIX symlink on
macOS/Linux, NTFS directory junction on Windows — see the root README for
the mechanism) so the canonical implementation stays in one place. Edit
the canonical files and both harnesses pick up the change immediately.

- **Claude Code:** `~/.claude/skills/peer-review/{SKILL.md,scripts}` →
  links here. Slash command: `/peer-review`. Defaults `--reviewer=codex`.
- **Codex CLI:** `~/.codex/skills/peer-review/{SKILL.md,scripts}` → links
  here. Wire up via `~/.codex/AGENTS.md` or codex's skill/plugin mechanism.
  The SKILL.md instructs codex to exclude itself from the reviewer list
  (codex reviewing codex defeats the purpose).

## Porting to a new harness

1. Create the harness skill dir (e.g. `~/.cursor/skills/peer-review/`).
2. Link `SKILL.md` → `~/.agents/skills/peer-review/SKILL.md`.
3. Link `scripts` → `~/.agents/skills/peer-review/scripts`.
4. If the harness has its own behavioral policy (e.g. allows proactive
   self-invocation), add a paragraph for it under "When to self-invoke" in
   the canonical SKILL.md — the model picks the branch matching its harness.

## Script usage

```
run-peer-review.sh <plan-file> \
  [--reviewer=<list>]         # default: codex, unless --host would make that
                              #   accidental self-review and another reviewer is available;
                              #   comma-separated list runs in parallel
                              #   choices: codex, claude, gemini, qwen, opencode, all,
                              #            0 (self — host CLI; requires --host),
                              #            any profile name from JSON config, or
                              #            1-based index / range when a config is loaded
                              #            (e.g., 2 / 1-3 / 1,3,my-claude)
                              #   `all` = every defined profile (or every CLI on PATH if no config)
  [--focus=all|feasibility|correctness|assumptions|repo-fit|choice]   # default: all
  [--source=file|chat]        # default: file (chat means caller wrote a temp file from chat content)
  [--exclude-cli=<cli>]       # filter `all` expansion by backing CLI (used to avoid self-review)
  [--host=<cli>]              # identify the host CLI; required when --reviewer=0 (self-review)
  [--timeout=<seconds>]       # per-reviewer timeout; default 300 or PEER_REVIEW_TIMEOUT_SECONDS

run-peer-review.sh --stdin-plan \
  [--reviewer=<list>]         # read chat-sourced plan content from stdin
  [--focus=all|feasibility|correctness|assumptions|repo-fit|choice]
  [--source=chat]             # implied by --stdin-plan; --source=file is rejected
  [--exclude-cli=<cli>]
  [--host=<cli>]
  [--timeout=<seconds>]

run-peer-review.sh list [--host=<cli>]
                              # subcommand: print available reviewers
                              #   (config index map or PATH discovery) and exit

run-peer-review.sh --help      # print usage and exit without running a review
```

`--help` / `-h` must be the only argument. `run-peer-review.sh foo --help`
is treated as an invalid review invocation, not as help. `list --help` and
`list -h` print the general script help.

### Listing available reviewers (`list` subcommand)

Prints two sections and exits without running a review.

With a config loaded:

```
config: <repo>/.peer-review.json

Special:
  #    token        cli        status
  0    self         claude     on PATH

Reviewer CLIs (from config — index callable as --reviewer=N):
  #    profile              cli        model                     effort   status
  1    codex-deep           codex      gpt-5                     high    on PATH
  2    qwen-test            qwen       qwen-3                            not found
  3    claude-opus          claude     claude-opus-4-7                   on PATH
```

Without a config:

```
config: <none>

Special:
  #    token        cli        status
  0    self         claude     on PATH

Reviewer CLIs (no config — on-PATH numbers callable as --reviewer=N):
  #    cli        status
  1         codex      on PATH
  2         claude     on PATH
  3         gemini     on PATH
  -         qwen       not found
  4         opencode   on PATH
```

The Special row only renders when `--host=<cli>` is passed (the slash
command auto-forwards it). Without a config, numbered selection maps to the
on-PATH CLI rows shown by `list`; unavailable CLIs render as `-` and cannot be
selected by number. Names (`--reviewer=claude`) remain portable across machines.

### Self-review (`--reviewer=0`)

`0` resolves to the host CLI named via `--host=<cli>` — e.g. from Claude
Code, the slash command passes `--host=claude --reviewer=0` to ask Claude
to review its own plan. Same CLI, fresh session: no conversation history,
no in-context anchoring on the chat that produced the plan. The model is
not pinned to the host session — the CLI runs with whatever model it
defaults to (or what its profile pins, if a config defines one), which may
not match the model the host session is using. Useful when no other
reviewer is available, or as a quick "look at this fresh" pass; signal is
weaker than cross-vendor review when models do overlap (shared training →
shared blind spots). The script does not flag the output as self-review;
the caller surfaces the source verbatim.

When any non-`0` reviewer token resolves to the host CLI, the script emits a
stdout warning before the review lines:

```
WARN=reviewer_matches_host reviewer=<reviewer> host=<host> self_opt_in=0
```

`--reviewer=0` is explicit self-review and does not emit this warning.
Current warning codes:

- `reviewer_matches_host` — a non-`0` reviewer token resolves to the host CLI.

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
  Use `list` to see the current index map.

Requires `python3` to parse. Without it, the script logs a warning and falls
back to the no-config behavior.

Whether to commit `.peer-review.json` to your repo is your call: commit it if
the team should share the same profiles; keep it local (or `.gitignore` it)
if it encodes personal preferences only.

Stdout (one line per successful reviewer):
```
REVIEW=<reviewer-name> <absolute path to saved review>
EXCLUDE_NOTE=<optional message about .git/info/exclude update>
WARN=<optional machine-readable warning>
```

Stderr (one line per failed reviewer):
```
ERROR=<reviewer-name> <message>
```

Exit codes: 0 ok (at least one reviewer succeeded), 2 usage, 3 reviewer CLI
missing, 4 filename claim failed, 5 empty response (single-reviewer mode),
6 every reviewer failed (multi-reviewer mode), 124 timeout
(single-reviewer mode), * reviewer's own exit (single-reviewer mode).

## Implementation notes

- **Output dir:** repo-local temporary state — `<repo>/.peer-review/reviews/`
  when inside a git repo, else `./.peer-review/reviews/`. Falls back to
  `/tmp/peer-review/` if mkdir fails.
- **Per-clone exclude:** `.peer-review/` is added to `.git/info/exclude` (not
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
- **Timeout:** each reviewer call is bounded by a configurable timeout. Default
  is 300s, override with `--timeout=<seconds>` or
  `PEER_REVIEW_TIMEOUT_SECONDS`. Uses `timeout` / `gtimeout` when available
  and falls back to a shell watchdog otherwise. Timed-out reviewers report
  `timed out after Ns` instead of silently waiting for the old long cap.
- **Path migration:** earlier versions wrote to `<repo>/docs/reviews/` or
  `<repo>/reviews/`. Those paths are no longer used. Existing files and any
  stale `.git/info/exclude` entries can be removed manually if desired.
- **Chat-sourced plan input:** `--stdin-plan` reads the plan from stdin, stores
  it in a repo-local temporary file, builds the prompt, then deletes the temp
  plan before reviewer subprocesses run. It rejects empty stdin, positional
  plan files, and `--source=file`; reviewer/profile validation runs before
  stdin is consumed. Temp dirs prefer the repo-local `.peer-review/` state
  tree and fall back to local or `/tmp/peer-review/` when needed.
- **Temp path boundary:** repo/content temp files use explicit-template
  `mktemp "$dir/..."` so paths stay under the chosen review/temp tree. Config
  parsing uses `mktemp -t` only for files consumed by the same shell process,
  not for paths passed between harness tools.

## Why `.agents/`

Multiple AI coding tools (Claude Code, Codex, Cursor, etc.) are converging on
`AGENTS.md` as the standard agent-instruction format. `.agents/skills/`
follows that convention as a tool-neutral skill location. Each tool's own
skill dir (`.claude/skills/`, `~/.codex/...`) symlinks or references files
here so the canonical implementation stays in one place.

## History

Originally designed and iterated through 5 rounds of self-review — the
script was used to review its own design spec.
