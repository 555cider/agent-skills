# agent-skills

Collection of [agent skills](https://agentskills.io/specification) shared
across multiple coding-agent harnesses (Claude Code, Codex CLI).

Licensed under [MIT](LICENSE).

## Layout

Skills live under `skills/`, matching the convention of
[anthropics/skills](https://github.com/anthropics/skills) and
[agentskills.io](https://agentskills.io/specification):

```
skills/
  <skill-name>/
    SKILL.md          # frontmatter + prompt body (required)
    scripts/          # supporting scripts (optional)
    references/       # agent-loaded reference docs (optional)
    assets/           # static assets (optional)
    README.md         # human-facing maintainer notes (optional)
```

The directory name MUST match the `name:` field in `SKILL.md` frontmatter.

## Skills

- [`skills/agent-memory/`](skills/agent-memory/README.md) - authoritative,
  indexed local memory shared across Claude, Codex, OpenCode, and other agents;
  includes native-memory import and a documented shadow-to-primary rollout.
- [`skills/plan-graph/`](skills/plan-graph/) - review existing planning
  documents, then create, revise, or remove connected plans while tracking
  dependencies, including read-only dependency suggestions with provenance.
- [`skills/peer-review/`](skills/peer-review/) — second-opinion review of
  plans, specs, or design choices via one or more reviewer CLIs (`codex`,
  `claude`, `opencode`, `agy`). Multiple reviewers run in
  parallel; saves each review to `<repo>/.peer-review/reviews/`. Invoked by
  `/peer-review` in Claude Code or natural-language ask in Codex.
- [`skills/ui-splint/`](skills/ui-splint/) - visual QA gate for frontend work,
  built on **measure-don't-eyeball**: a deterministic browser-injected audit
  (`scripts/audit.js`) MEASURES contrast, overflow, sticky-bar overlap, collapsed
  regions, text clipping, tap targets, focus traps, fully obscured keyboard focus, layout shift, broken media,
  and more — then a judgment layer covers composition, hierarchy, data-state
  feedback, copy, and brand coherence. Detect-first-then-judge; severity is
  computed from thresholds, not taste. The audit runs via MCP, a zero-dependency
  Chrome/CDP runner (`scripts/audit-chrome.mjs`), or Playwright; both batch runners
  use real Tab/Shift+Tab input and structured interaction-state setup. Defect fixtures
  live under `tests/`.
- [`skills/dom-picker/`](skills/dom-picker/) — turn a UI issue the user
  points at in a **running** web app into a **minimal, validated frontend patch**.
  A transiently-injected DOM picker (`assets/element-picker.js`) captures the
  selected element's DOM, computed style, screenshot, and page metadata; the skill
  ranks local source-file candidates by signal (text, `data-testid`/`aria`/`id`,
  unique class sequences, route), reads the best, and emits a **unified diff** —
  validated with an apply-check and never auto-applied at low confidence. Browser
  control via Playwright/CDP/MCP; self-contained, no dependency on other skills.
  See the [DOM Picker demo](skills/dom-picker/README.md).

## Install

Clone this monorepo just to get `install.sh` — the script installs each
selected skill into its own location (you can `rm -rf` this monorepo
afterwards if you only want to use skills, not edit them).

```bash
git clone https://github.com/555cider/agent-skills.git
cd agent-skills
./install.sh                       # every skill
./install.sh peer-review           # one specific skill
./install.sh peer-review other     # multiple specific skills
./install.sh --local peer-review   # apply this checkout's local skill files
./install.sh --local agent-memory --shadow   # install + shared recall, keep native memory
./install.sh --local agent-memory --primary  # install + make Agent Memory primary
./install.sh --list                # print available skill names
```

The script wires each selected skill in two steps:

1. If `split/<skill-name>` is published, `git clone -b
   split/<skill-name> --single-branch <this-repo>` into
   `~/.agents/skills/<skill-name>/` — that directory is itself a small git
   repo whose history contains only commits that touched this skill. If the
   split branch is not published yet, the script syncs the local
   `skills/<skill-name>/` checkout instead. `~/.agents/skills/` is the
   [agentskills.io](https://agentskills.io/specification) runtime aggregation
   path; tool-neutral.
2. `~/.claude/skills/<skill-name>/`, `~/.codex/skills/<skill-name>/` →
   symlink (or NTFS junction on Windows) to `~/.agents/skills/<skill-name>/`.
   Each harness is auto-detected; missing harnesses are skipped.

Update a split-based install with:

```bash
cd ~/.agents/skills/<skill-name> && git pull
```

The harness links pick up the new content automatically. If a skill was
installed from a local fallback before its split branch existed, re-run
`./install.sh <skill-name>` from the monorepo checkout to refresh it.

For maintainer/dev testing, or when you want to force local files even if a
split branch exists, use local mode:

```bash
./install.sh --local               # copy every local skill into ~/.agents/skills
./install.sh --local ui-splint     # copy one local skill into ~/.agents/skills
```

Local mode does not read `origin` or clone `split/<skill-name>`. It
synchronizes the current checkout's `skills/<skill-name>/` into
`~/.agents/skills/<skill-name>/`, removes stale files there, and preserves
an existing `.git` directory if the target is already an installed split
clone. Claude/Codex harness links still point at `~/.agents/skills/<skill-name>/`.

For `agent-memory`, `--shadow` or `--primary` also performs the requested
Claude/Codex/OpenCode integration after installation. It installs the managed
`agent-memory` launcher under `~/.local/bin`, backs up changed harness configs,
and prints only the remaining hook-review/restart actions. These mode flags are
rejected unless `agent-memory` is among the selected skills.

Existing memory is imported separately so installation cannot silently ingest
large histories. Preview first, then apply only the sources you want:

```bash
agent-memory import-existing --cwd "$PWD" --format json  # preview
agent-memory import-existing --cwd "$PWD" --apply        # import all selected candidates
```

The combined command selects current-project Claude and `.remember` memory plus
conservatively matched Codex global preferences. Imports create reviewable
medium-confidence candidates, do not alter the originals, and never promote
automatically. See [`skills/agent-memory/README.md`](skills/agent-memory/README.md)
for lower-level source and history filters.

The `split/<skill-name>` branches are produced by
[`.github/workflows/split.yml`](.github/workflows/split.yml) on every push
to `main` that touches `skills/`, using `git subtree split`. Maintainers
edit only `main` in this monorepo — the split branches are derived
artifacts and must never be committed to directly.

The script is idempotent — safe to re-run after pulling new skills into
the monorepo. If `~/.agents/skills/<name>/` is already a clone, it's
left alone (run `git pull` there yourself). If the split branch is still
unpublished, it syncs or refreshes the local checkout. Other mismatched
directories or links are reported as warnings and left untouched; remove
them manually if you want the script to manage them. A plain directory is
only refreshed by the default fallback when it already looks like the same
local skill (`SKILL.md` declares the matching `name:`).

**Linking mechanism — POSIX vs Windows.** On macOS and Linux, the script uses
POSIX symlinks (`ln -s`). On Windows + Git Bash / MSYS2 / Cygwin, it uses
NTFS directory junctions (`mklink /J`) instead — junctions behave like a
directory symlink for read access and, unlike `ln -s`, do **not** require
admin rights or Developer Mode. The default `ln -s` on Windows silently
copies the directory contents when those privileges are missing, leaving
the install out of sync; junctions sidestep that. Junctions are local-NTFS
only, so installs from a UNC share or non-NTFS volume will fail with a
clear error rather than silently degrading to a copy.

## Uninstall

```bash
./uninstall.sh <name>              # remove one skill
./uninstall.sh peer-review other   # remove several
./uninstall.sh --all               # remove every skill declared by this repo
./uninstall.sh --list              # print this monorepo's skill names
```

For each skill, this removes:

- `~/.claude/skills/<name>` (harness link, if present)
- `~/.codex/skills/<name>` (harness link, if present)
- `~/.agents/skills/<name>/` (the installed skill directory, if present)

Idempotent — re-running is safe; already-absent paths are reported and
skipped. Works on POSIX symlinks, NTFS junctions, and plain
directories alike. Re-installing later just re-runs `./install.sh
<name>`; the install will clone `split/<name>` when available or sync the
local checkout while the split branch is still unpublished.

## Adding a new skill (maintainers)

1. Create `skills/<new-skill>/SKILL.md` with the
   [agentskills.io](https://agentskills.io/specification) frontmatter.
2. Commit and push to `main`.
3. [`.github/workflows/split.yml`](.github/workflows/split.yml) runs
   `git subtree split --prefix=skills/<new-skill>` and force-pushes the
   result to `split/<new-skill>`. This takes ~30 s.
4. Users get the skill via `./install.sh <new-skill>`. Before the split branch
   exists, maintainers can run the same command from the monorepo checkout and
   install the local copy.

The split branches are derived artifacts. Never commit to them
directly — your work will be overwritten on the next `main` push.

## Why this layout

- **Single source of truth for maintainers:** all skills live in one
  monorepo. Cross-cutting changes (frontmatter conventions, shared
  scripts, lint rules) land in one PR.
- **Per-skill independence for users:** once a split branch is published,
  each user's `~/.agents/skills/<name>/` is its own git clone with that
  skill's history only — small, no monorepo overhead, and `git pull` updates
  just that one skill. Before publication, maintainers can install the local
  synced directory from the monorepo checkout.
- **Tool-neutral:** `~/.agents/skills/` is the converging convention; any
  agent that reads it finds the skill without per-tool config.
- **No symlink chains:** harness dirs link directly to
  `~/.agents/skills/<name>/`. One hop, no intermediate.
