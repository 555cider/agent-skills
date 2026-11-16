# Landing: choosing the strategy, and pull-request repositories

## Choosing the strategy

| Strategy | Result on base | `-m` |
| --- | --- | --- |
| `squash` | one new commit | required |
| `merge` | a `--no-ff` merge commit, branch commits kept | required |
| `ff` | base moves to the branch tip, no new commit | not used |
| `pr` | nothing — the PR was merged on the server; cleanup only | not used |

- **Source of truth**: the repository's contributing rules (AGENTS.md, CONTRIBUTING, docs,
  branch protection). With none, read base's first-parent history: `Merge pull request #n` or
  `(#n)` subjects mean `pr`, other merge commits mean `merge`, a straight line of feature-sized
  commits means `squash` or `ff`.
- **Record it once** so every finish agrees: `git config worktree-cycle.strategy <s>`. When
  bases differ (feature → dev squashed, hotfix → main fast-forwarded), set it per base:
  `git config branch.<base>.worktreeCycleStrategy <s>`, which wins over the repository value.
- **Unset**, finish squashes — unless base's recent first-parent history has merge commits;
  then it stops and asks for `--strategy` rather than guess.
- **Rebase-and-fast-forward repositories** use `ff`. Finish never rebases for you: the rebased
  tree is not the one you verified. When base moved on, ff stops before anything changes;
  rebase in the worktree, verify again, re-run.

## Pull-request repositories

Work reaches base through a PR merged on the server, so there is no local merge to make.

1. **Start** as usual; name the branch the way the repository does (`--branch feature/<name>`).
   Nobody commits to local base here, so it falls behind the server — `git pull --ff-only` on
   base first when start reports it behind.
2. **Report and ask** "push `<branch>` and open a PR into `<base>`?". Pushing and opening a PR
   are outward-facing — do them only on that answer, never as part of "done".
3. **Publish the branch** from the worktree: `git push -u <remote> <branch>`, then open the PR
   with the repository's forge CLI (`gh pr create --base <base>`, `glab mr create`,
   `tea pr create`, …). Gerrit has no branch to push: `git push <remote> HEAD:refs/for/<base>`.
   Push to the remote PRs come from — a fork remote in a fork-based repository. Review fixes
   are more commits in the same worktree, pushed the same way.
4. **After the server merged it**: `git fetch <remote>`, then
   `scripts/finish-worktree.sh -b <branch> --strategy pr`. It merges nothing, does not need the
   main worktree on base or clean, and removes the worktree and branch only when the branch
   content is in `<remote>/<base>` or the local base. Not landed yet, it changes nothing and says
   so. The remote branch, if the server kept it, is named for the user to delete.

How the landed check works and where it refuses on purpose: [finish.md](finish.md).
