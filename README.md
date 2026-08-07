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

A directory without `SKILL.md` is not a skill. `install.sh`, `uninstall.sh`,
and CI all enumerate `skills/*/SKILL.md`, so a leftover from a rename or an
interrupted checkout is reported and ignored instead of being installed as a
phantom skill. Nothing is ever deleted from the checkout — remove such
directories yourself.

## Skills

- [`skills/agent-memory/`](skills/agent-memory/README.md) - evidence-aware,
  SQLite-authoritative durable memory shared across Claude, Codex, OpenCode,
  and other agents, with redacted observation, lifecycle review, and a
  documented shadow-to-primary rollout.
- [`skills/plan-graph/`](skills/plan-graph/) - route current tasks and changed
  paths through persistent plan context, maintain explicit prerequisites and
  replacement lineage, and prune closed plan trees through a transactional CLI.
- [`skills/peer-review/`](skills/peer-review/) — second-opinion review of
  plans, specs, or design choices via one or more reviewer CLIs (`codex`,
  `claude`, `opencode`, `agy`). Multiple reviewers run in
  parallel; saves each review to `<repo>/.peer-review/reviews/`. Invoked by
  `/peer-review` in Claude Code or natural-language ask in Codex.
- [`skills/ui-audit/`](skills/ui-audit/) - visual QA gate for frontend work,
  built on **measure-don't-eyeball**: a deterministic browser-injected audit
  (`scripts/audit.js`) MEASURES contrast, overflow, sticky-bar overlap, collapsed
  regions, text clipping, tap targets, focus traps, fully obscured keyboard focus, desktop hover feedback, layout shift, broken media,
  image alternative text, skip links, data-table conventions, standard-widget contracts,
  and more — then a judgment layer covers composition, hierarchy, data-state
  feedback, copy, and brand coherence. Detect-first-then-judge; severity is
  computed from thresholds, not taste. The audit runs via MCP, a zero-dependency
  Chrome/CDP runner (`scripts/audit-chrome.mjs`), or Playwright; both batch runners
  use real Tab/Shift+Tab and pointer input plus structured interaction-state setup. Defect fixtures
  live under `tests/`.
- [`skills/dom-picker/`](skills/dom-picker/) — turn a UI issue the user
  points at in a **running** web app into a minimal source edit whose rendered
  result is verified on the same element. Its zero-dependency Chromium driver
  runs the transient picker in a named isolated world and closed Shadow DOM,
  persists trusted user requests with screenshots, and survives reloads. Rich DOM,
  accessibility, layout, matched-CSS, and React evidence feeds a deterministic
  source locator; only high-confidence safe edits are applied, and completion
  requires target reacquisition plus observable assertions. See the
  [DOM Picker v2 guide](skills/dom-picker/README.md).
- [`skills/worktree-cycle/`](skills/worktree-cycle/) — the git worktree
  lifecycle as two guarded scripts: **start** branches from the **local**
  integration branch HEAD (never the remote default) and asserts that base right
  after creation, so stale-base collisions surface at creation instead of at
  merge time; **finish** squash-merges back and removes the worktree and branch.
  Every guard runs before anything is modified, a merge conflict restores the
  main worktree untouched, untracked files the merge would overwrite are stashed
  rather than deleted, and incomplete cleanup exits non-zero with the remedy that
  matches the actual leftover. The one leftover that is **not** treated as failure
  is Windows' own: a process whose current directory sits inside the worktree locks
  that directory for its lifetime, so git empties and deregisters the worktree but
  cannot delete the directory — measured to defeat both retry and rename during the
  run. That empty residue exits zero and is reclaimed by the next **start** under the
  same name, so it never retires a worktree name. Never pushes.
- [`skills/screen-map/`](skills/screen-map/README.md) — an agent-readable map of a web
  app: which screens exist and the concrete action that moves between any two. One
  crawl writes a **snapshot** (`.screen-map/map.json`) pinned to the app commit; maps
  are never merged, so old and new observations cannot tangle. A node is a route
  template plus a deliberately lossy DOM signature, so `/items/1` and `/items/2`
  collapse into one screen while an open modal or dropdown stays its own. It is
  not a sitemap: it records what you click to move between screens, not a URL
  hierarchy. The action policy is **positive recognition** — an action runs only
  when a rule proves it safe,
  unrecognized ones need `--allow-mutating`, and destructive ones are never
  executed under any flag, though their edges are still recorded. Later sessions
  ask `route --to '/orders/:id'` and get an executable action sequence that was
  walked end to end, plus a freshness verdict against the current commit.
- [`skills/step-back/`](skills/step-back/) — the two ways effort goes wrong, treated
  as one dial: shipping the first thing that worked, and still verifying something
  that was fine forty tool calls ago. The premise is that the judgment already
  exists — an agent asked mid-grind whether the work should be taking this long
  answers *no*, and is right — and what is missing is a moment when that judgment
  runs. So the skill fixes three **countable** tripwires (about to declare done; the
  same failure or check for the third time; one subgoal past 15 tool calls) and
  replaces the free question with an expensive one: not "was this the best?" but
  "what would I do differently on a rewrite?", and not "should I keep going?" but
  "what am I trying to learn, in one sentence?". A first firing is decided alone and
  reported in one line; the **same** tripwire firing twice goes to the human, because
  the earlier decision to continue has already been shown wrong. Prompt only — no
  scripts, no hooks — and explicitly not permission to narrow the scope the user
  asked for.

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
./install.sh --local ui-audit      # copy one local skill into ~/.agents/skills
```

Local mode does not read `origin` or clone `split/<skill-name>`. It
synchronizes the current checkout's `skills/<skill-name>/` into
`~/.agents/skills/<skill-name>/`, removes stale files there, and preserves
an existing `.git` directory if the target is already an installed split
clone. Claude/Codex harness links still point at `~/.agents/skills/<skill-name>/`.

For `agent-memory`, `--shadow` or `--primary` also performs the requested
Claude/Codex/OpenCode integration after installation. It installs the managed
`agent-memory` launcher under `~/.local/bin`, backs up changed harness configs,
creates a private Python venv for its pinned optional provider/vector
dependencies, and prints only the remaining hook-review/restart actions. These
mode flags are rejected unless `agent-memory` is among the selected skills.

See [`skills/agent-memory/README.md`](skills/agent-memory/README.md) for the
storage, trust, provider, and lifecycle contracts.

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
   [agentskills.io](https://agentskills.io/specification) frontmatter, and copy
   the root `.gitattributes` into `skills/<new-skill>/`. `git subtree split`
   publishes only the skill directory, so the root copy never reaches
   `split/<new-skill>` — without one inside the skill, a Windows clone with
   `core.autocrlf=true` checks it out as CRLF and its scripts break under any
   shell stricter than Git Bash. `tests/validate-skill-evals.py` fails the build
   if the copy is missing or has drifted from the root rules.
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
