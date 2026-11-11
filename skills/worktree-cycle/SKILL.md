---
name: worktree-cycle
description: Use when starting or finishing work in a git worktree ("워크트리 시작/생성/정리", "dev/main 으로 squash merge 후 정리"). Start branches from the local integration branch HEAD and reserves a dev-server port block; finish squash-merges back and removes the branch and worktree. Never pushes.
license: MIT
compatibility: Bash, git, and Python 3.10+ for coordinated port allocation. Works on Windows through Git Bash. No network access, no push.
---

# worktree-cycle

Open an isolated git worktree from the local integration branch HEAD, and close it back into
that branch as a single squash commit. The deterministic git sequence and its guards live in
the scripts, not in prose. `<skill-dir>` is the directory holding this file.

Use the user's language when reporting. Report cleanup exactly as it happened — the finish
script exits non-zero when the worktree or branch could not be removed, and that is a partial
result, not a success.

## Principles

- **Base is the LOCAL integration branch HEAD.** Branching from the remote default
  (`origin/main`, …) drops recent local commits, so the work sits on a stale base and collides
  at squash-merge time. `start` branches only from the local HEAD and asserts it immediately
  after creating the worktree.
- **Never push.** The merge lands on the local integration branch only. Publishing is a
  separate human step — the separation matters most in repositories where the integration
  branch is what actually runs.
- **Squash merge.** `feature/* → integration` as one commit: `git merge --squash` plus a commit.
- **Runtime isolation is part of the worktree.** Branch and filesystem isolation buys nothing
  while every worktree runs its dev servers on the same default ports: the second stack fails
  to bind, or binds elsewhere and quietly talks to the wrong backend. `start` therefore
  reserves a port block per worktree, and the rule that cannot be scripted is below —
  **never restart a server you did not start.**

## Lifecycle

| Step | How |
| --- | --- |
| 1. Start | `scripts/start-worktree.sh <name>` — branch `worktree-<name>` from the local integration branch HEAD, then assert the base. |
| 2. Work | `cd <path>`, implement, test. Run the stack you are changing on the **reserved port block**, not on the defaults. **Commit before finishing** so the worktree is clean. |
| 3. Return | Move back to the integration branch (main worktree), **as its own step**. Required: `finish` refuses to run from inside the worktree it is about to delete — and on Windows a shell that merely *started* inside it still locks the directory (see Traps). |
| 4. Finish | `scripts/finish-worktree.sh -b worktree-<name> -m "…"` — squash merge, then remove worktree and branch. |
| 5. Publish | After verifying: `git push <remote> <base>` (manual). |

## Start

```bash
<skill-dir>/scripts/start-worktree.sh <name> [--base <branch>] [--path <dir>] [--branch <branch>]
                                             [--port-base <n>]
```

- Base is the **local** `<base>` branch HEAD. Without `--base` it is `git config
  worktree-cycle.base` if set, else the branch checked out in the main worktree — the branch
  finish merges into. A base that differs from the main worktree's branch is warned about, and
  a detached main worktree with no `--base` stops the run. If the local base branch is missing,
  the script stops — it does not fall back to the remote, because that fallback is the accident.
- The base is recorded on the new branch (`branch.<branch>.worktreeCycleBase`), so finish merges
  back into the same branch without `--base`. A branch with no recorded base (started before
  this, or by a plain `git worktree add`) needs `--base` or `worktree-cycle.base` at finish.
- Default path: under an existing `.worktrees/` or `.claude/worktrees/`; warns when that
  directory is not gitignored.
- An **empty** directory already sitting at the target path is reclaimed, because that is the
  residue a locked finish leaves behind (see Traps) and refusing it would retire the name for
  good. Anything with content in it still stops the run — `rmdir` refuses a non-empty directory,
  so this can never delete real work.
- After creation the new worktree HEAD is compared against the integration branch HEAD, and a
  mismatch fails the run.
- If the local base trails its remote counterpart, that is **reported and the run continues**
  (see [references/finish.md](references/finish.md)).
- A **block of 10 ports** is reserved for the worktree and printed with the result.

### The reserved port block

```bash
cat "$(git rev-parse --absolute-git-dir)/worktree-ports"   # run inside the worktree
# WORKTREE_PORT_BASE=21400
# WORKTREE_PORT_COUNT=10
```

- **Range 20000–29999, ten ports per worktree.** The allocator probes IPv4 and
  IPv6 bind availability and imports legacy sibling reservations.
- **Cross-repository coordination.** Python's OS file lock serializes the per-user
  registry at `~/.cache/worktree-cycle/ports.json`. Tests can override its path
  with `WORKTREE_CYCLE_PORT_REGISTRY`. Dead allocator processes release the OS
  lock automatically; stale worktree entries are dropped when their git-dir
  reservation disappears. A corrupt registry fails closed instead of being erased.
- **Deterministic preference, not ownership.** Repository path and branch select a
  preferred block. A conflicting reservation or listener makes automatic allocation
  try another block. Unregistered older allocations in other repositories and other
  OS users are outside this registry; their running listeners are still checked.
- **Explicit ports use the same checks.** `--port-base <n>` must be aligned and free.
  Failure exits non-zero after worktree creation and reports that partial state;
  it never silently substitutes another block.
- **Reservation lifetime follows git-dir.** `worktree-ports` lives outside tracked
  content and is removed with the worktree. A missing Python or failed automatic
  allocation leaves a usable worktree with an explicit no-reservation warning.
- **On any allocation failure, start prints the retry command** (`reserve-ports.py
  --repo … --branch … --git-dir …`, plus `--port-base` when given). Run that, not
  `start` again. It blames Python only when no Python 3.10+ was found.
- Probing releases its sockets; another process can bind afterwards. Always use
  strict server binding, check listeners before launch, and probe the resulting
  endpoint. A reservation file is not evidence that the intended code is serving.

### Dev servers across worktrees

The script can hand out ports. It cannot know which stack you are changing — that part is
yours:

- **Never restart a server you did not start.** A listener you did not launch belongs to
  another worktree, another session, or the main worktree. Killing it to run your own build
  breaks someone else's work with no trace of why.
- **The main worktree's instance is the shared one.** Treat it as read-only infrastructure.
- **Start only the stack you are changing**, on your own block. Point everything else at the
  shared instances — changing the frontend means running the frontend on your port and leaving
  its API base aimed at the shared backend. Nothing else needs restarting.
- **Pin the port.** Use the strict flag (`vite --strictPort`, and the equivalent elsewhere).
  Without it a taken port silently rolls to the next one, and which frontend talks to which
  backend stops being knowable.
- **Check before binding** when something looks wrong: `Get-NetTCPConnection -LocalPort <p>`
  on Windows, `lsof -i :<p>` or `ss -ltnp` on POSIX. "It built" is not "my code is answering".

> Claude Code can enter the session directly with the native `EnterWorktree`. If you use it,
> confirm that `settings.local.json` sets `worktree.baseRef=head`, since the harness default
> branches from the remote default and reintroduces the stale base. The start script is the
> deterministic alternative that needs neither that setting nor the harness.

## Finish

```bash
<skill-dir>/scripts/finish-worktree.sh -b <worktree-branch> -m "feat(scope): summary" [-m "body"]
# repeated -m become paragraphs, as with git commit
# preview: --dry-run  |  explicit worktree path: -w <path>
# integration branch: --base <branch> (default: the base recorded at start, then
#   git config worktree-cycle.base; with neither, --base is required)
# refuse instead of stashing colliding untracked files: --no-autostash
# park the main worktree's tracked changes across the merge: --autostash-tracked
```

Guards — any violation stops the run **before anything is modified**:

- The caller is not standing inside the worktree being removed.
- The main worktree is on the base branch with a clean **tracked** tree (untracked scratch
  files are allowed), so the squash cannot swallow unrelated staged work and conflict recovery
  cannot destroy it. `--autostash-tracked` trades this stop for parking those changes and
  putting them back after the squash commit; a pop conflict leaves them in the stash and fails
  the run.
- The target branch exists and has commits beyond base, and shares a common ancestor with it.
- The target worktree is clean, so nothing uncommitted is lost. A branch whose worktree is
  already gone (even a directory deleted by hand, whose stale registration is dropped) still
  merges and gets deleted.

Once the merge starts:

- **One finish at a time per repository.** Every worktree shares the main worktree's index, so
  the mutating half runs under a lock in the common git dir and a second finish is refused.
- **Untracked files the merge would overwrite are stashed**, never deleted: kept after a
  successful merge, popped after a failed one. `--no-autostash` makes them a hard stop.
- **A merge conflict restores the main worktree** and stops; a refusal before git touched
  anything leaves the tree exactly as found (no blind `reset --hard`).
- **A failed commit** stops with the merged changes staged and the recovery command printed.
- **A cleanup failure** means the squash already landed: the run exits non-zero and must not be
  re-run — finish by hand as printed. An empty, deregistered directory left by a Windows lock
  is the exception: reported, exit zero.
- A base that trails its remote is reported, never blocked. Nothing fetches or pushes.

Details and the reasoning behind each: [references/finish.md](references/finish.md).

## Traps

- **Windows: any live process holding the worktree locks its directory** — a shell whose cwd is
  inside, or a dev server the harness "stopped" but whose child still runs. Leave in a separate
  step; find leftover servers by port.
- **junction/symlink `node_modules`**: never delete through the link; an own `pnpm install` is
  the cleaner choice.
- **The base can move or be rewritten while you work** — check `HEAD..<base>` before the final
  review; colliding migration numbers merge without conflict.
- **Never write per-worktree state into the worktree itself**; finish needs an empty status.
- **Branch deletion uses `-D`** (a squash is not recorded as a merge); publishing is never
  automatic.

Full explanations: [references/traps.md](references/traps.md).

## Common Mistakes

The guards above already stop the scripted mistakes; these are the ones they cannot see.

- **Drifting into the main worktree to work, and restarting its dev server there.** The change
  leaves the isolation the skill exists to provide, and the shared instance other sessions
  depend on is replaced with half-finished code. Work in your own worktree, on your own block.
- **Running the dev server on the default port** because the block "seems unnecessary right
  now". The collision appears only once a second worktree exists, and then looks like a broken
  build, not a port clash.
- **Misreading finish's exit.** Non-zero after cleanup warnings means the merge already landed:
  finish the cleanup by hand as printed, do not re-run. The empty-directory residue exits
  **zero**: say the merge landed and mention the leftover. Remove it with `rmdir` from a shell
  that is not standing in it, or leave it for the next `start` to reclaim.
