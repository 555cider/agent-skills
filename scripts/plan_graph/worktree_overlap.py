#!/usr/bin/env python3
"""Files each git worktree of a repository changes, and where they overlap.

A worktree's changes are its branch's commits since the merge base with its base branch
plus everything uncommitted (staged, unstaged, untracked). The base is the one
worktree-cycle recorded on the branch (`branch.<b>.worktreeCycleBase`), else
`worktree-cycle.base`, else the branch checked out in the main worktree.

Git calls: `worktree list`, one `config`, then per worktree one `status` and, when its
branch is not the base, one `diff base...HEAD`, run concurrently.

One file, standard library only (Python 3.10+). worktree-cycle runs it as a script and
plan-graph imports it; the two copies are kept byte-identical by
tests/check-shared-copies.sh in the agent-skills repository. Edit one copy, copy it over.

Usage:
  worktree_overlap.py list  [--repo DIR] [--exclude PATH] [--json]
  worktree_overlap.py check --branch BRANCH [--base BASE] [--repo DIR] [--exclude PATH] [--json]

`list` prints one line per other active worktree with the area it changes. `check` warns
when BRANCH's changes touch files another active worktree also changes. Both always exit 0
once the arguments parse: the result is advice, never a gate.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Iterable

GIT_TIMEOUT = 15
AREA_LIMIT = 3
SAMPLE_LIMIT = 5


# `git status` refreshes the index and takes index.lock when it can; run in another agent's
# worktree that races its `git add` or `git commit`. This check only reads.
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def _git(cwd: str, args: list[str]) -> tuple[int, bytes]:
    try:
        result = subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            timeout=GIT_TIMEOUT,
            check=False,
            env=GIT_ENV,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, b""
    return result.returncode, result.stdout


def _split_z(raw: bytes) -> list[str]:
    return [item.decode("utf-8", errors="replace") for item in raw.split(b"\0") if item]


def same_path(first: str, second: str) -> bool:
    return os.path.normcase(os.path.abspath(first)) == os.path.normcase(os.path.abspath(second))


@dataclass
class Worktree:
    path: str
    head: str = ""
    branch: str = ""
    main: bool = False
    bare: bool = False
    prunable: bool = False
    base: str = ""
    committed: tuple[str, ...] = ()
    uncommitted: tuple[str, ...] = ()
    errors: list[str] = field(default_factory=list)

    @property
    def files(self) -> tuple[str, ...]:
        return tuple(sorted(set(self.committed) | set(self.uncommitted)))

    @property
    def label(self) -> str:
        return self.branch or (f"detached {self.head[:9]}" if self.head else "detached")

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "branch": self.branch,
            "head": self.head,
            "main": self.main,
            "base": self.base,
            "committed": list(self.committed),
            "uncommitted": list(self.uncommitted),
            "files": list(self.files),
            "area": area(self.files),
            "errors": list(self.errors),
        }


def parse_worktree_list(text: str) -> list[Worktree]:
    worktrees: list[Worktree] = []
    current: Worktree | None = None
    for line in text.splitlines():
        if line.startswith("worktree "):
            current = Worktree(path=line[len("worktree "):], main=not worktrees)
            worktrees.append(current)
        elif current is None:
            continue
        elif line.startswith("HEAD "):
            current.head = line[len("HEAD "):]
        elif line.startswith("branch "):
            ref = line[len("branch "):]
            current.branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        elif line == "bare":
            current.bare = True
        elif line == "prunable" or line.startswith("prunable "):
            current.prunable = True
    return worktrees


def read_bases(repo: str) -> tuple[dict[str, str], str]:
    """Per-branch recorded bases and `worktree-cycle.base`, from one `git config` call."""
    code, raw = _git(
        repo,
        ["config", "-z", "--get-regexp", r"^(branch\..*\.worktreecyclebase|worktree-cycle\.base)$"],
    )
    recorded: dict[str, str] = {}
    configured = ""
    if code != 0:
        return recorded, configured
    for entry in _split_z(raw):
        key, _, value = entry.partition("\n")
        if key == "worktree-cycle.base":
            configured = value
        elif key.startswith("branch.") and key.endswith(".worktreecyclebase"):
            recorded[key[len("branch."):-len(".worktreecyclebase")]] = value
    return recorded, configured


def _status_paths(raw: bytes) -> list[str]:
    # `--porcelain=v1 -z --no-renames`: "XY <path>" entries, one path each.
    return [entry[3:] for entry in _split_z(raw) if len(entry) > 3]


def _nested_prefixes(item: Worktree, worktrees: list[Worktree]) -> list[str]:
    """Other worktrees inside this one (an unignored `.worktrees/`) as path prefixes.

    Their files show up as untracked here; they are the other worktree's, not changes.
    """
    prefixes: list[str] = []
    for other in worktrees:
        if other is item:
            continue
        try:
            relative = os.path.relpath(other.path, item.path)
        except ValueError:  # another drive on Windows
            continue
        if relative != "." and not relative.startswith(".."):
            prefixes.append(relative.replace(os.sep, "/").rstrip("/") + "/")
    return prefixes


def snapshot(repo: str) -> tuple[list[Worktree], list[str]]:
    """Every live worktree with its base and changed files, plus warnings."""
    code, raw = _git(repo, ["worktree", "list", "--porcelain"])
    if code != 0:
        return [], ["git worktree list failed; is this a git repository?"]
    worktrees = parse_worktree_list(raw.decode("utf-8", errors="replace"))
    warnings: list[str] = []
    recorded, configured = read_bases(repo)
    main_branch = worktrees[0].branch if worktrees else ""
    live = [
        item for item in worktrees
        if not item.bare and not item.prunable and os.path.isdir(item.path)
    ]

    jobs: list[tuple[Worktree, str, list[str]]] = []
    for item in live:
        item.base = recorded.get(item.branch) or configured or main_branch
        jobs.append((item, "status", [
            "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames",
        ]))
        if item.base and item.head and item.branch != item.base:
            jobs.append((item, "diff", [
                "diff", "--name-only", "-z", "--no-renames", f"refs/heads/{item.base}...{item.head}",
            ]))

    def run(job: tuple[Worktree, str, list[str]]) -> tuple[Worktree, str, int, bytes]:
        item, kind, args = job
        code, out = _git(item.path if kind == "status" else repo, args)
        return item, kind, code, out

    if jobs:
        with ThreadPoolExecutor(max_workers=min(8, len(jobs))) as pool:
            for item, kind, code, out in pool.map(run, jobs):
                if code != 0:
                    detail = (
                        "git status failed" if kind == "status"
                        else f"cannot compare with base '{item.base}'"
                    )
                    item.errors.append(detail)
                    warnings.append(f"{item.path}: {detail}")
                elif kind == "status":
                    nested = _nested_prefixes(item, live)
                    item.uncommitted = tuple(sorted({
                        path for path in _status_paths(out)
                        if not any(path.startswith(prefix) for prefix in nested)
                    }))
                else:
                    item.committed = tuple(sorted(set(_split_z(out))))
    return live, warnings


def branch_changes(repo: str, branch: str, base: str) -> tuple[list[str], str]:
    """Files `branch` changed since its merge base with `base`, for a branch without a worktree."""
    code, out = _git(
        repo, ["diff", "--name-only", "-z", "--no-renames", f"refs/heads/{base}...refs/heads/{branch}"]
    )
    if code != 0:
        return [], f"cannot compare '{branch}' with base '{base}'"
    return sorted(set(_split_z(out))), ""


def covers(selector: str, path: str) -> bool:
    """A selector ending in `/` is a directory and covers every path below it."""
    if selector.endswith("/"):
        return path.startswith(selector)
    return selector == path


def shared(selectors: Iterable[str], files: Iterable[str]) -> list[str]:
    chosen = [item for item in selectors if item]
    return sorted({path for path in files if any(covers(item, path) for item in chosen)})


def find_overlaps(
    selectors: Iterable[str],
    worktrees: Iterable[Worktree],
    *,
    exclude: Iterable[str] = (),
) -> list[dict[str, object]]:
    """Other worktrees changing a file the selectors cover, in worktree-list order."""
    chosen = list(selectors)
    skipped = list(exclude)
    found: list[dict[str, object]] = []
    for item in worktrees:
        if any(same_path(item.path, other) for other in skipped):
            continue
        files = shared(chosen, item.files)
        if files:
            found.append({
                "path": item.path,
                "branch": item.branch,
                "main": item.main,
                "files": files,
            })
    return found


def area(files: Iterable[str], limit: int = AREA_LIMIT) -> str:
    """Where the changes sit: the busiest top directories, two levels deep."""
    counts: dict[str, int] = {}
    for path in files:
        parts = path.split("/")
        key = path if len(parts) == 1 else "/".join(parts[: min(2, len(parts) - 1)]) + "/"
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return ""
    ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    shown = [f"{key} ({count})" if count > 1 else key for key, count in ordered[:limit]]
    if len(ordered) > limit:
        shown.append(f"+{len(ordered) - limit} more")
    return ", ".join(shown)


def _sample(files: list[str], limit: int = SAMPLE_LIMIT) -> str:
    text = ", ".join(files[:limit])
    return text + (f" (+{len(files) - limit} more)" if len(files) > limit else "")


def _others(worktrees: list[Worktree], exclude: list[str]) -> list[Worktree]:
    """Linked worktrees other than the excluded ones; the main one only while it is dirty."""
    return [
        item for item in worktrees
        if not any(same_path(item.path, other) for other in exclude)
        and (not item.main or item.files)
    ]


def _cmd_list(args: argparse.Namespace) -> int:
    worktrees, warnings = snapshot(args.repo)
    others = _others(worktrees, args.exclude)
    if args.json:
        print(json.dumps({
            "worktrees": [item.as_dict() for item in others],
            "warnings": warnings,
        }, ensure_ascii=False, indent=2))
        return 0
    if not others:
        print("· no other active worktrees")
        return 0
    print(f"· other active worktrees ({len(others)}): read their plans before editing the same area")
    for item in others:
        tag = " (main)" if item.main else ""
        detail = f"{len(item.files)} changed: {area(item.files)}" if item.files else "no changes yet"
        print(f"    {item.label}{tag}  {item.path}  · {detail}")
    for line in warnings:
        print(f"    (unknown) {line}")
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    worktrees, warnings = snapshot(args.repo)
    mine = next((item for item in worktrees if item.branch == args.branch), None)
    base = args.base or (mine.base if mine else "")
    if mine is not None and (not args.base or args.base == mine.base):
        files = list(mine.files)
    elif base:
        files, problem = branch_changes(args.repo, args.branch, base)
        if problem:
            warnings.append(problem)
    else:
        files = []
        warnings.append(f"no base known for '{args.branch}'")
    exclude = [*args.exclude, *([mine.path] if mine else [])]
    overlaps = find_overlaps(files, _others(worktrees, exclude), exclude=exclude)
    if args.json:
        print(json.dumps({
            "branch": args.branch,
            "base": base,
            "files": files,
            "overlaps": overlaps,
            "warnings": warnings,
        }, ensure_ascii=False, indent=2))
        return 0
    if overlaps:
        print(
            f"⚠️  {args.branch} changes files that other active worktrees also change"
            " (warning only; finish continues):",
            file=sys.stderr,
        )
        for item in overlaps:
            label = item["branch"] or "detached"
            tag = " (main)" if item["main"] else ""
            print(f"    {label}{tag}  {item['path']}: {_sample(item['files'])}", file=sys.stderr)
        print(
            "    Landing first is fine; tell whoever owns those worktrees so they rebase"
            " and re-check the shared files.",
            file=sys.stderr,
        )
    for line in warnings:
        print(f"· overlap check incomplete: {line}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass
    parser = argparse.ArgumentParser(prog="worktree_overlap.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "check"):
        command = sub.add_parser(name)
        command.add_argument("--repo", default=".")
        command.add_argument("--exclude", action="append", default=[])
        command.add_argument("--json", action="store_true")
        if name == "check":
            command.add_argument("--branch", required=True)
            command.add_argument("--base", default="")
    args = parser.parse_args(argv)
    return _cmd_list(args) if args.command == "list" else _cmd_check(args)


if __name__ == "__main__":
    sys.exit(main())
