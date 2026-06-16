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

- [`skills/plan-graph/`](skills/plan-graph/) - review existing planning
  documents, then create, revise, or remove connected plans while tracking
  dependencies.
- [`skills/peer-review/`](skills/peer-review/) — second-opinion review of
  plans, specs, or design choices via one or more reviewer CLIs (`codex`,
  `claude`, `gemini`, `qwen`, `opencode`). Multiple reviewers run in
  parallel; saves each review to `<repo>/.peer-review/reviews/`. Invoked by
  `/peer-review` in Claude Code or natural-language ask in Codex.

## Install

Clone this monorepo just to get `install.sh` — the script then clones
each selected skill into its own location (you can `rm -rf` this
monorepo afterwards if you only want to use skills, not edit them).

```bash
git clone https://github.com/555cider/agent-skills.git
cd agent-skills
./install.sh                       # every skill
./install.sh peer-review           # one specific skill
./install.sh peer-review other     # multiple specific skills
./install.sh --list                # print available skill names
```

The script wires each selected skill in two steps:

1. `git clone -b split/<skill-name> --single-branch <this-repo>` into
   `~/.agents/skills/<skill-name>/` — that directory is itself a small git
   repo whose history contains only commits that touched this skill.
   `~/.agents/skills/` is the [agentskills.io](https://agentskills.io/specification)
   runtime aggregation path; tool-neutral.
2. `~/.claude/skills/<skill-name>/`, `~/.codex/skills/<skill-name>/` →
   symlink (or NTFS junction on Windows) to `~/.agents/skills/<skill-name>/`.
   Each harness is auto-detected; missing harnesses are skipped.

Update an installed skill with:

```bash
cd ~/.agents/skills/<skill-name> && git pull
```

The harness links pick up the new content automatically.

The `split/<skill-name>` branches are produced by
[`.github/workflows/split.yml`](.github/workflows/split.yml) on every push
to `main` that touches `skills/`, using `git subtree split`. Maintainers
edit only `main` in this monorepo — the split branches are derived
artifacts and must never be committed to directly.

The script is idempotent — safe to re-run after pulling new skills into
the monorepo. If `~/.agents/skills/<name>/` is already a clone, it's
left alone (run `git pull` there yourself). Mismatched directories or
links are reported as warnings and left untouched; remove them manually
if you want the script to manage them.

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
./uninstall.sh --all               # remove every installed skill
./uninstall.sh --list              # print currently installed skills
```

For each skill, this removes:

- `~/.claude/skills/<name>` (harness link, if present)
- `~/.codex/skills/<name>` (harness link, if present)
- `~/.agents/skills/<name>/` (the per-skill git clone, if present)

Idempotent — re-running is safe; already-absent paths are reported and
skipped. Works on POSIX symlinks, NTFS junctions, and plain
directories alike. Re-installing later just re-runs `./install.sh
<name>` and re-clones `split/<name>` from origin.

## Adding a new skill (maintainers)

1. Create `skills/<new-skill>/SKILL.md` with the
   [agentskills.io](https://agentskills.io/specification) frontmatter.
2. Commit and push to `main`.
3. [`.github/workflows/split.yml`](.github/workflows/split.yml) runs
   `git subtree split --prefix=skills/<new-skill>` and force-pushes the
   result to `split/<new-skill>`. This takes ~30 s.
4. Users get the skill via `./install.sh <new-skill>`.

The split branches are derived artifacts. Never commit to them
directly — your work will be overwritten on the next `main` push.

## Why this layout

- **Single source of truth for maintainers:** all skills live in one
  monorepo. Cross-cutting changes (frontmatter conventions, shared
  scripts, lint rules) land in one PR.
- **Per-skill independence for users:** each user's
  `~/.agents/skills/<name>/` is its own git clone with that skill's
  history only — small, no monorepo overhead, and `git pull` updates
  just that one skill.
- **Tool-neutral:** `~/.agents/skills/` is the converging convention; any
  agent that reads it finds the skill without per-tool config.
- **No symlink chains:** harness dirs link directly to
  `~/.agents/skills/<name>/`. One hop, no intermediate.
