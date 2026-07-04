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

Each harness's skill dir is a single **whole-directory** link to
`~/.agents/skills/peer-review/` (POSIX symlink on macOS/Linux, NTFS
directory junction on Windows — see the root README for the mechanism), so
the canonical implementation stays in one place. `install.sh` creates that
one link per harness; it does not link individual files. Edit the canonical
files and both harnesses pick up the change immediately.

- **Claude Code:** `~/.claude/skills/peer-review/` → links to
  `~/.agents/skills/peer-review/`. Slash command: `/peer-review`. Defaults `--reviewer=codex`.
- **Codex CLI:** `~/.codex/skills/peer-review/` → links to
  `~/.agents/skills/peer-review/`. Wire up via `~/.codex/AGENTS.md` or codex's
  skill/plugin mechanism. The SKILL.md instructs codex to exclude itself from
  the reviewer list (codex reviewing codex defeats the purpose).

## Porting to a new harness

1. Ensure the skill is installed at `~/.agents/skills/peer-review/` (run
   `install.sh peer-review`).
2. Create a single whole-directory link `~/.<harness>/skills/peer-review/` →
   `~/.agents/skills/peer-review/` (symlink, or `mklink /J` junction on
   Windows). `install.sh` does this automatically for detected harnesses.
3. If the harness has its own behavioral policy (e.g. allows proactive
   self-invocation), add a paragraph for it under "When to self-invoke" in
   the canonical SKILL.md — the model picks the branch matching its harness.

## Usage & reference

The canonical contract lives in the script and the skill's `references/` —
this README does not restate it (copies drift). Instead:

- **Full CLI usage / flags:** `scripts/run-peer-review.sh --help`
  (`--help`/`-h` must be the only argument).
- **`list` subcommand output** (Special + Reviewer CLIs tables):
  `references/list-output.md`.
- **Self-review (`--reviewer=0`) and the `reviewer_matches_host` warning:**
  `references/cli-adapters.md`.
- **Profile config (`.peer-review.json` schema, search order, name rules):**
  `references/profile-config.md`.
- **Stdout/stderr line shapes and exit codes:** `references/exit-codes.md`.
- **Report-format templates the caller renders:** `references/report-format.md`.

Whether to commit `.peer-review.json` is your call: commit it to share
profiles with the team, or keep it local / `.gitignore`d for personal prefs.

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
  - opencode: creates a temporary repo-local `peer-review-readonly-*` agent
    that denies edit/shell/network/delegation tools, then runs
    `opencode run --agent <agent>`; model names without a provider prefix are
    sent as `opencode/<model>`; ANSI color codes are stripped from saved output.
  - agy: `agy -p "<prompt>" --sandbox`; model is forwarded when configured.
  The wrapper feeds the prompt over stdin where the CLI supports it; `agy`
  receives the prompt through `-p` because that is its headless prompt
  interface.
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
