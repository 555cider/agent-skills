---
name: worktree-cycle
description: Use for the git worktree lifecycle — starting isolated work and folding it back. START creates a worktree branched from the LOCAL integration branch HEAD (default dev), not the remote default, and asserts the base, and reserves a dev-server port block for it so parallel worktrees do not fight over the same ports. FINISH squash-merges the worktree branch into the local integration branch and cleans up the branch and worktree. Triggers include "워크트리 시작/생성", "워크트리 정리", "dev 로 머지", "squash merge 후 브랜치·워크트리 정리", starting or closing out worktree work. Never pushes.
license: MIT
compatibility: POSIX shell and git. Works on Windows through Git Bash. No network access, no push.
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
<skill-dir>/scripts/start-worktree.sh <name> [--base dev] [--path <dir>] [--branch <branch>]
                                             [--port-base <n>]
```

- Base is the **local** `<base>` branch HEAD (default `dev`). If that local branch is missing,
  the script stops — it does not fall back to the remote, because that fallback is the accident.
- Default path: under an existing `.worktrees/` or `.claude/worktrees/`; warns when that
  directory is not gitignored.
- An **empty** directory already sitting at the target path is reclaimed, because that is the
  residue a locked finish leaves behind (see Traps) and refusing it would retire the name for
  good. Anything with content in it still stops the run — `rmdir` refuses a non-empty directory,
  so this can never delete real work.
- After creation the new worktree HEAD is compared against the integration branch HEAD, and a
  mismatch fails the run.
- If the local base trails its remote counterpart, that is **reported and the run continues** —
  see below.
- A **block of 10 ports** is reserved for the worktree and printed with the result.

### The reserved port block

```bash
cat "$(git rev-parse --absolute-git-dir)/worktree-ports"   # run inside the worktree
# WORKTREE_PORT_BASE=21400
# WORKTREE_PORT_COUNT=10
```

- **Range 20000–29999, ten ports per worktree.** Below every common ephemeral range (Linux
  32768–60999, Windows and macOS 49152–65535), so the OS cannot hand one of these out from
  under a running server, and above the usual application defaults (3000, 5173, 8000, 8080).
- **Derived from the repository path and the branch name, not random.** A worktree removed and
  recreated under the same name gets the same ports back, so anything configured against them
  still points at the right place. The repository path is in there because only worktrees of
  the *same* repository can see each other's reservations — without it, two repositories on one
  machine would hand the same worktree name the same block, and the names that collide are the
  common ones. Blocks already recorded by sibling worktrees are skipped.
- **The record lives in the worktree's git directory, not in the worktree.** This is not a
  detail: `finish` requires `git status --porcelain` in the worktree to be *completely* empty,
  untracked included, so a file in the tree would block every finish for the life of the
  worktree. In the git directory it is invisible to status, and `git worktree remove` deletes
  it — no reservation can go stale.
- `--port-base <n>` pins the block by hand (multiple of 10, inside the range). A failure to
  reserve anything is a **warning, not an error**: the worktree is the point, the ports are a
  convenience.

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
<skill-dir>/scripts/finish-worktree.sh -b <worktree-branch> -m "feat(scope): summary"
# preview: --dry-run  |  integration branch: --base dev  |  explicit worktree path: -w <path>
# refuse instead of stashing colliding untracked files: --no-autostash
# park the main worktree's tracked changes across the merge: --autostash-tracked
```

### One finish at a time

Every worktree of a repository shares **one index and one main working tree**, so two finishes
are not independent. `git merge --squash` *stages* its result without committing, so a second
finish sees that staged work as "local changes", fails, and its recovery would discard it —
someone else's merge, thrown away. The guard below cannot prevent this on its own: it looks
once, and the other session can stage in the window that follows.

So the mutating half runs under an exclusive lock in the repository's **common** git dir
(`worktree-cycle-finish.lock`), shared by every worktree. A second finish is refused by name
rather than racing; a lock whose owner process is gone is treated as stale and taken over, so a
killed run cannot block the repository forever. The clean guard is then re-checked under the
lock, because anything staged before it was acquired is only visible then.

A merge that fails is also no longer reset blindly. `reset --hard` runs **only** when the index
carries unmerged entries — proof that the merge really ran and left conflicts. When git refuses
*before* touching anything ("local changes would be overwritten"), the tree is left exactly as
found: whatever made it refuse is not ours to discard.

Guards — any violation stops the run **before anything is modified**:

- The caller is not standing inside the worktree being removed.
- The main worktree is on the base branch with a clean **tracked** tree (untracked scratch
  files are allowed), so the squash cannot swallow unrelated staged work and conflict recovery
  cannot destroy it. `--autostash-tracked` trades this stop for parking those changes and
  putting them back after the squash commit; a pop conflict leaves them in the stash and fails
  the run.
- The target branch exists and has commits beyond base, and shares a common ancestor with it.
- The target worktree is clean, so nothing uncommitted is lost. A branch whose worktree is
  already gone still merges and gets deleted.

### Untracked files the merge would overwrite

Untracked files are allowed in general, but git aborts a merge when an incoming path already
exists untracked in the main worktree. The usual cause is a draft written in the main tree and
then committed from the worktree — the same paths arrive from both sides. Left unhandled this
surfaces as a merge failure whose message points at the base, which is the wrong diagnosis.

Finish computes that collision set up front (`git diff --name-only base...branch` intersected
with `git ls-files --others --exclude-standard`) and **stashes exactly those files** before
merging. Nothing is deleted or moved aside invisibly:

- The merge succeeds → the stash is **kept, not popped**: the merged commit supersedes those
  drafts, and popping would overwrite the merged content. The run prints the `stash show` and
  `stash drop` commands.
- The merge fails → the stash is **popped**, so a run that changed nothing really leaves
  nothing changed.
- `--no-autostash` turns this back into a hard guard that names the colliding files.

Note that `git stash pop` and `git stash drop` reject a raw commit SHA ("is not a stash
reference"); the entry must be addressed as `stash@{0}`. The SHA is only good for
`stash show`. That is why **push order is a contract** when `--autostash-tracked` is also in
play: the untracked-collision stash goes in first and the tracked one second, so right after
the commit `stash@{0}` is always the tracked stash to pop, and the untracked one takes its
place afterwards.

### When the base trails its remote

Both scripts compare the base against its remote counterpart and print a warning when the
local branch is behind — then carry on, because working off the local branch is the point.
Nothing fetches; only refs already on disk are read. `@{upstream}` alone is not enough to find
that counterpart: a branch commonly has no upstream configured while `refs/remotes/origin/<base>`
exists and has moved ahead, so the check falls back to `origin/<base>` and stays silent when
neither exists.

### When cleanup fails

The merge has landed by then, so the run reports leftovers and exits non-zero — never re-run it.
Two different leftovers get two different remedies:

- **git could not touch the worktree at all** (the junction case; its `.git` file is still
  there) → unlink the junction, then `git worktree remove --force`.
- **git emptied and deregistered it but the directory survived** (Windows keeps a directory
  locked while a process holds it open) → `git worktree remove` now answers "is not a working
  tree"; the directory itself has to go. Finish handles the common form of this itself: if the
  leftover is empty it is simply `rmdir`-ed and the run succeeds.
- **even the empty directory refuses to go** → this is **not** a failed cleanup and the run
  **exits zero**. See the cwd trap below for why nothing in the run can clear it, and why the
  residue blocks nothing.

Behavior once the merge starts:

- A merge conflict restores the main worktree and stops (`reset --hard`, safe because of the
  clean guard; `git merge --abort` does not apply to a squash, which records no `MERGE_HEAD`).
- A failed commit (rejecting hook, or an empty diff because the changes are already in base)
  stops with the staged state and the recovery command spelled out. Nothing is removed.
- A failed worktree removal or branch deletion prints what is left over and **exits non-zero**.
  The squash commit is already on base at that point, so the run must not be repeated. The
  empty-directory residue above is the one exception: it exits zero.

## Traps

- **Windows: a cwd inside the worktree locks its directory.** Windows holds a handle on a
  process's current directory, so while any process stands inside the worktree — the agent's own
  persistent shell after a `cd`, a test runner, an editor — the directory itself cannot be
  deleted. Its *contents* still go, so `git worktree remove` empties and deregisters the
  worktree, then fails with `Permission denied` and leaves an empty directory.

  The lock is bound to that process's lifetime, not to elapsed time. Retrying `rmdir` and
  renaming the directory both fail while the holder is alive, and both succeed once it exits —
  measured, not assumed. **Nothing finish can do during its own run clears it**, which is why
  finish reports the residue and exits zero instead of calling it a failed cleanup, and why
  `start` reclaims an empty directory at the target path rather than refusing it.

  To avoid it entirely: leave the worktree in a **separate step** before running finish, so the
  shell that invokes finish never had its cwd inside. Working with absolute paths instead of
  `cd`-ing in avoids it too.
- **junction/symlink `node_modules`**: frontend worktrees often link it. When
  `git worktree remove` fails, finish stops and reports it. Unlink first
  (`cmd //c rmdir <junction>` on Windows), then `git worktree prune`. Never delete with
  `Remove-Item -Recurse` / `rm -rf`, which deletes through the link and destroys the original.
- **Never write per-worktree state into the worktree itself.** `finish` requires a completely
  empty `git status --porcelain` there, untracked included, so a bookkeeping file dropped in
  the tree turns into "the worktree has uncommitted changes" on every finish from then on.
  That is why the port reservation goes in the worktree's git directory — where git also
  deletes it for you.
- **Branch deletion uses `-D`**: a squash is not recorded as a merge, so `-d` refuses it as
  "not merged". Finish only reaches `-D` after the merge commit succeeded.
- **Publishing is never automatic**: the finish script prints the push command and stops.

## Common Mistakes

- Running finish **from inside** the worktree — blocked by a guard; return to the main worktree.
- Running finish with uncommitted work in the worktree — blocked by a guard; commit first.
- Running finish with unrelated tracked changes in the main worktree — blocked by a guard;
  this is deliberate.
- Expecting `start` to branch from the remote default — it branches only from the **local**
  integration branch HEAD, which is the entire point.
- **Drifting into the main worktree to work, and restarting its dev server there.** Two
  failures at once: the change is being made outside the isolation the skill exists to
  provide, and the shared instance other sessions depend on gets killed and replaced with
  half-finished code. Work in your own worktree, on your own port block.
- Running the dev server on the default port because the reserved block "seems unnecessary
  right now" — the collision only appears once a second worktree exists, and by then the
  failure looks like a broken build, not a port clash.
- Reading a non-zero finish as "the merge failed" — after cleanup warnings the merge already
  landed. Read the message and finish the cleanup by hand instead of re-running.
- Reporting the empty-directory residue as a failed cleanup — it exits **zero**. Say the merge
  landed and mention the leftover; do not re-run finish and do not present it as lost work.
- Deleting a leftover empty directory by hand from a shell standing inside it — that shell is
  usually what holds the lock. Run `rmdir` from somewhere else, or just leave it: the next
  `start` under the same name reclaims it.
