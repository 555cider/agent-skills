# worktree-cycle — traps

Platform and workflow traps behind the guards in the scripts.

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
