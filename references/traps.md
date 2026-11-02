# worktree-cycle — traps

Platform and workflow traps behind the guards in the scripts.

## Windows: what keeps a worktree from being deleted

Windows will not delete a directory that a live process holds — as its cwd or through an open
file. `git worktree remove` then empties and deregisters the worktree but fails on the directory
itself. The lock lasts as long as the holder process, not a set time: retrying or renaming fails
while it lives and succeeds once it exits. Nothing finish does during its own run can clear it,
which is why finish reports an empty residue and exits zero, and `start` reclaims an empty
directory at the target path.

The usual holders:

- **A shell whose cwd is inside**, including the agent's own persistent shell after a `cd`.
  Leave the worktree in a separate step before finish, or work with absolute paths throughout.
- **A dev server you "stopped".** Stopping a backgrounded server through the agent harness kills
  the shell, not its node child, which keeps the port (a relaunch fails with `EADDRINUSE` and the
  old code keeps answering) and the directory. Find the PID by port
  (`Get-NetTCPConnection -LocalPort <p>`, then `Win32_Process` `CommandLine`), confirm you started
  it from this worktree, and stop it.
- **A Gradle daemon** started from the worktree holds `gradle-wrapper.jar`. Kill only the
  `java.exe` processes whose command line contains the worktree path; `gradlew --stop` stops
  every worktree's daemons, including the shared instance.

## `node_modules` links

A frontend worktree often links `node_modules` to the main tree's. Never delete through the link
(`Remove-Item -Recurse`, `rm -rf`) — that destroys the original; unlink first
(`cmd //c rmdir <junction>`), then `git worktree prune`. With the link in place, `pnpm run` may
also decide to reinstall and purge the shared directory, so call binaries from `node_modules/.bin`.

An own `pnpm install` in the worktree avoids both: it costs little (hardlinks into the global
store) and its leftovers are cleaned as described in [finish.md](finish.md).

## The base changes while you work

- **It moves.** Another session lands overlapping changes, and finish stops on a conflict with the
  main worktree restored. Merge the base into the branch
  (`git -C <worktree> merge <base> --no-commit --no-ff`), resolve, retest, commit, finish again.
  On a long branch check `git log --oneline HEAD..<base> --stat` before the final review: a
  numbered migration with the same number as yours (Flyway `V<n>__`, drizzle `NNNN_*.sql`) merges
  without a textual conflict, and a review of the branch's own diff cannot see it.
- **It is rewritten.** An amend or re-squash of the base tip drops the commit you branched from
  out of its history, and finish conflicts everywhere although nothing diverged. If
  `git diff --stat <commit-you-branched-from> <base>` is empty, merge the base in, keep the
  branch's side of every conflict (`git checkout --ours -- <file>`), and confirm
  `git diff HEAD --stat` is empty before committing.

## Bookkeeping

- **Never write per-worktree state into the worktree itself.** `finish` requires a completely
  empty `git status --porcelain` there, untracked included. That is why the port reservation lives
  in the worktree's git directory, where git also deletes it.
- **Branch deletion uses `-D`**: a squash is not recorded as a merge, so `-d` refuses it. Finish
  reaches `-D` only after the merge commit succeeded.
- **Publishing is never automatic**: finish prints the push command and stops.
