---
name: worktree-cycle
description: Use for the git worktree lifecycle — starting isolated work and folding it back. START creates a worktree branched from the LOCAL integration branch HEAD (default dev), not the remote default, and asserts the base. FINISH squash-merges the worktree branch into the local integration branch and cleans up the branch and worktree. Triggers include "워크트리 시작/생성", "워크트리 정리", "dev 로 머지", "squash merge 후 브랜치·워크트리 정리", starting or closing out worktree work. Never pushes.
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

## Lifecycle

| Step | How |
| --- | --- |
| 1. Start | `scripts/start-worktree.sh <name>` — branch `worktree-<name>` from the local integration branch HEAD, then assert the base. |
| 2. Work | `cd <path>`, implement, test. **Commit before finishing** so the worktree is clean. |
| 3. Return | Move back to the integration branch (main worktree). Required: `finish` refuses to run from inside the worktree it is about to delete. |
| 4. Finish | `scripts/finish-worktree.sh -b worktree-<name> -m "…"` — squash merge, then remove worktree and branch. |
| 5. Publish | After verifying: `git push <remote> <base>` (manual). |

## Start

```bash
<skill-dir>/scripts/start-worktree.sh <name> [--base dev] [--path <dir>] [--branch <branch>]
```

- Base is the **local** `<base>` branch HEAD (default `dev`). If that local branch is missing,
  the script stops — it does not fall back to the remote, because that fallback is the accident.
- Default path: under an existing `.worktrees/` or `.claude/worktrees/`; warns when that
  directory is not gitignored.
- After creation the new worktree HEAD is compared against the integration branch HEAD, and a
  mismatch fails the run.
- If the local base trails its remote counterpart, that is **reported and the run continues** —
  see below.

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

Behavior once the merge starts:

- A merge conflict restores the main worktree and stops (`reset --hard`, safe because of the
  clean guard; `git merge --abort` does not apply to a squash, which records no `MERGE_HEAD`).
- A failed commit (rejecting hook, or an empty diff because the changes are already in base)
  stops with the staged state and the recovery command spelled out. Nothing is removed.
- A failed worktree removal or branch deletion prints what is left over and **exits non-zero**.
  The squash commit is already on base at that point, so the run must not be repeated.

## Traps

- **junction/symlink `node_modules`**: frontend worktrees often link it. When
  `git worktree remove` fails, finish stops and reports it. Unlink first
  (`cmd //c rmdir <junction>` on Windows), then `git worktree prune`. Never delete with
  `Remove-Item -Recurse` / `rm -rf`, which deletes through the link and destroys the original.
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
- Reading a non-zero finish as "the merge failed" — after cleanup warnings the merge already
  landed. Read the message and finish the cleanup by hand instead of re-running.
