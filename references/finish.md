# worktree-cycle — finish in detail

How `scripts/finish-worktree.sh` behaves once its guards have passed, and why. The script is
the source of truth; SKILL.md carries the summary.

## One finish at a time

Each worktree has its own index, but these finish operations all target **the main
worktree's index and working tree**, so two finishes are not independent. `git merge
--squash` *stages* its result without committing, so a second finish sees that staged work as
"local changes", fails, and its recovery would discard it — someone else's merge, thrown away.
The clean-tree guard cannot prevent this on its own: it looks once, and the other session can
stage in the window that follows.

So the mutating half runs under an exclusive lock in the repository's **common** git dir
(`worktree-cycle-finish.lock`), shared by every worktree. A second finish is refused by name
rather than racing; a lock whose owner process is gone is treated as stale and taken over, so a
killed run cannot block the repository forever. The clean guard is then re-checked under the
lock, because anything staged before it was acquired is only visible then.

A merge that fails is also no longer reset blindly. `reset --hard` runs **only** when the index
carries unmerged entries — proof that the merge really ran and left conflicts. When git refuses
*before* touching anything ("local changes would be overwritten"), the tree is left exactly as
found: whatever made it refuse is not ours to discard.

## Untracked files the merge would overwrite

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

## When the base trails its remote

Both scripts compare the base against its remote counterpart and print a warning when the
local branch is behind — then carry on, because working off the local branch is the point.
Nothing fetches; only refs already on disk are read. `@{upstream}` alone is not enough to find
that counterpart: a branch commonly has no upstream configured while `refs/remotes/origin/<base>`
exists and has moved ahead, so the check falls back to `origin/<base>` and stays silent when
neither exists.

## When cleanup fails

The merge has landed by then, so the run reports leftovers and exits non-zero — never re-run it.
Two different leftovers get two different remedies:

- **git could not touch the worktree at all** (the junction case; its `.git` file is still
  there) → unlink the junction, then `git worktree remove --force`.
- **git emptied and deregistered it but the directory survived** (Windows keeps a directory
  locked while a process holds it open) → `git worktree remove` now answers "is not a working
  tree"; the directory itself has to go. Finish handles the common form of this itself: if the
  leftover is empty it is simply `rmdir`-ed and the run succeeds.
- **even the empty directory refuses to go** → this is **not** a failed cleanup and the run
  **exits zero**. See the cwd trap in [traps.md](traps.md) for why nothing in the run can
  clear it, and why the residue blocks nothing.

Behavior once the merge starts:

- A merge conflict restores the main worktree and stops (`reset --hard`, safe because of the
  clean guard; `git merge --abort` does not apply to a squash, which records no `MERGE_HEAD`).
- A failed commit (rejecting hook, or an empty diff because the changes are already in base)
  stops with the staged state and the recovery command spelled out. Nothing is removed.
- A failed worktree removal or branch deletion prints what is left over and **exits non-zero**.
  The squash commit is already on base at that point, so the run must not be repeated. The
  empty-directory residue above is the one exception: it exits zero.
