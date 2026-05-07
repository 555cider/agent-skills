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

- [`skills/peer-review/`](skills/peer-review/) — second-opinion review of
  plans, specs, or design choices via one or more reviewer CLIs (`codex`,
  `claude`, `gemini`, `qwen`, `opencode`). Multiple reviewers run in
  parallel; saves each review to `<repo>/docs/reviews/`. Invoked by
  `/peer-review` in Claude Code or natural-language ask in Codex.

## Install

Clone this repo anywhere on your machine, then run:

```bash
./install.sh                       # every skill
./install.sh peer-review           # one specific skill
./install.sh peer-review other     # multiple specific skills
./install.sh --list                # print available skill names
```

The script wires the selected skills via two symlink layers:

1. `~/.agents/skills/<skill-name>/` → this clone's `skills/<skill-name>/`
   (the [agentskills.io](https://agentskills.io/specification) runtime
   aggregation path; tool-neutral).
2. `~/.claude/skills/<skill-name>/`, `~/.codex/skills/<skill-name>/` → the
   `~/.agents/skills/<skill-name>/` link above. Each harness is auto-
   detected; missing harnesses are skipped.

Edits to a `SKILL.md` here are visible to every wired harness immediately.

The script is idempotent — safe to re-run after pulling new skills.
Existing real directories or mismatched symlinks are reported as warnings
and left untouched; remove them manually if you want the script to manage
them.

To uninstall a skill, remove its symlinks under `~/.agents/skills/<name>/`,
`~/.claude/skills/<name>/`, `~/.codex/skills/<name>/` — they are plain
symlinks created by this script.

## Why this layout

- **Single source of truth:** edit one file, all harnesses see it. No
  cross-harness drift.
- **Tool-neutral:** `~/.agents/skills/` is the converging convention; any
  agent that reads it finds the skill without per-tool config.
- **Portable:** clone anywhere on a new machine, run `install.sh`, all
  harnesses are wired.
