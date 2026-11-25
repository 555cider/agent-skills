"""Rules a host already loads from its own instruction files.

Claude Code reads CLAUDE.md (with its `@path` imports) and the project's
auto-memory index on every turn; Codex and OpenCode read AGENTS.md. A memory that
restates one of those rules adds nothing when recalled into that host, so recall
skips it there -- and still serves it to the hosts that do not read that file,
which is why the memory is kept rather than deleted. Records `adopt` took from
the project's auto-memory folder are skipped for Claude Code the same way.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Sequence

from .util import base_tokens, expand_user_path, user_home

# Per host: files under the user's home, and file names read in every directory
# from the working directory up to the filesystem root. A host whose config
# directory is relocated by an environment variable reads its file from there.
HOST_HOME_ENV = {"claude": ("CLAUDE_CONFIG_DIR", "CLAUDE.md"), "codex": ("CODEX_HOME", "AGENTS.md")}
HOST_FILES: dict[str, tuple[tuple[Path, ...], tuple[str, ...]]] = {
    "claude": ((Path(".claude/CLAUDE.md"),), ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md")),
    "codex": ((Path(".codex/AGENTS.md"),), ("AGENTS.md",)),
    "opencode": ((Path(".config/opencode/AGENTS.md"),), ("AGENTS.md",)),
}
# Share of the shorter side's words that must also appear in the other side.
# Measured on a real store: restated rules score 0.5-0.92, unrelated rules
# under 0.3.
MIRROR_CONTAINMENT = 0.5
MIN_RULE_WORDS = 3
_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
# Claude Code follows `@path` imports in CLAUDE.md up to four hops deep, never
# inside code, and loads the first 200 lines of the auto-memory index.
MAX_IMPORT_HOPS = 4
AUTO_MEMORY_LINES = 200
_IMPORT_RE = re.compile(r"(?:^|(?<=[\s(]))@((?:~|\.{1,2}|[A-Za-z]:)?[\\/]?[^\s`'\"()<>\[\]]+)", re.M)
_FENCE_RE = re.compile(r"(?ms)^\s*(```|~~~).*?^\s*\1[^\n]*$")
_CODE_SPAN_RE = re.compile(r"`[^`\n]*`")
_UNIT_STOP = frozenset({"않는다", "한다", "the", "a", "an", "to", "of", "and", "or", "is", "in", "for"})


def _units(text: str) -> list[str]:
    """Bullets and paragraphs, with a bullet's wrapped lines kept together."""

    units: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or _BULLET_RE.match(line):
            if current:
                units.append(" ".join(current))
            current = []
            if stripped and not stripped.startswith("#"):
                current = [_BULLET_RE.sub("", line).strip()]
            continue
        current.append(stripped)
    if current:
        units.append(" ".join(current))
    return units


def _expand(raw: str, base: Path, home: Path) -> Path:
    if raw == "~" or raw.startswith(("~/", "~\\")):
        return home / raw[2:]
    path = Path(raw)
    return path if path.is_absolute() else base / path


def _imports(text: str) -> list[str]:
    """`@path` imports outside code, the way Claude Code reads CLAUDE.md."""

    text = _FENCE_RE.sub("", text)
    text = _CODE_SPAN_RE.sub("", text)
    # Sentence punctuation after a path is prose, not part of the file name.
    return [raw.rstrip(".,;:!?") for raw in _IMPORT_RE.findall(text)]


def _config_dir(harness: str, home: Path) -> Path | None:
    variable, _ = HOST_HOME_ENV.get(harness, ("", ""))
    if variable and os.environ.get(variable):
        return Path(os.environ[variable]).expanduser()
    home_files, _ = HOST_FILES.get(harness, ((), ()))
    return (home / home_files[0]).parent if home_files else None


def native_memory_dirs(
    harness: str, cwd: Path, *, home: Path | None = None, project_root: Path | None = None
) -> list[Path]:
    """Claude Code's auto-memory folders for this project, which it loads itself.

    The folder is `<config>/projects/<slug>/memory`, the slug being the project
    path with every non-alphanumeric turned into `-`. Worktrees share the main
    checkout's folder, so the repository root is tried as well as `cwd`.
    """

    if harness != "claude":
        return []
    config = _config_dir(harness, home or user_home())
    if config is None:
        return []
    found: list[Path] = []
    for directory in dict.fromkeys(item.resolve() for item in (cwd, project_root) if item is not None):
        memory = config / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(directory)) / "memory"
        try:
            if memory.is_dir() and memory.resolve() not in found:
                found.append(memory.resolve())
        except OSError:
            continue
    return found


NATIVE_MEMORY_EVIDENCE = "import.claude-memory"
# `adopt` writes "<file> § <name>" or "<file> — why: <reason>" as the summary.
_SUMMARY_FILE_RE = re.compile(r"^(.*?)(?: § | — why: |$)")


def from_native_memory(record: dict[str, Any], directories: Sequence[Path]) -> bool:
    """True when `adopt` took the record from one of these auto-memory folders."""

    wanted = {os.path.normcase(str(item)) for item in directories}
    for item in record.get("evidence") or []:
        if item.get("kind") != NATIVE_MEMORY_EVIDENCE:
            continue
        label = _SUMMARY_FILE_RE.match(str(item.get("summary") or "")).group(1).strip()
        if not label:
            continue
        try:
            parent = expand_user_path(label).resolve().parent
        except OSError:
            continue
        if os.path.normcase(str(parent)) in wanted:
            return True
    return False


def loaded_rules(
    harness: str, cwd: Path, *, home: Path | None = None, project_root: Path | None = None
) -> list[str]:
    home_files, local_names = HOST_FILES.get(harness, ((), ()))
    home = home or user_home()
    paths = [home / relative for relative in home_files]
    variable, file_name = HOST_HOME_ENV.get(harness, ("", ""))
    if variable and os.environ.get(variable):
        paths = [Path(os.environ[variable]).expanduser() / file_name]
    for directory in (cwd, *cwd.parents):
        paths.extend(directory / name for name in local_names)
    rules: list[str] = []
    seen: set[Path] = set()
    follows_imports = harness == "claude"

    def read(path: Path, depth: int, max_lines: int | None = None) -> None:
        try:
            resolved = path.resolve()
            if resolved in seen or not resolved.is_file():
                return
            seen.add(resolved)
            text = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        if max_lines is not None:
            text = "\n".join(text.splitlines()[:max_lines])
        rules.extend(_units(text))
        if follows_imports and depth < MAX_IMPORT_HOPS:
            for raw in _imports(text):
                read(_expand(raw, resolved.parent, home), depth + 1)

    for path in paths:
        read(path, 0)
    for memory in native_memory_dirs(harness, cwd, home=home, project_root=project_root):
        # Claude Code loads the index's first 200 lines into every session.
        read(memory / "MEMORY.md", MAX_IMPORT_HOPS, max_lines=AUTO_MEMORY_LINES)
    return rules


def _words(text: str) -> set[str]:
    return {word for word in base_tokens(text) if len(word) >= 2 and word not in _UNIT_STOP}


def mirrored(statement: str, rules: Sequence[str]) -> bool:
    words = _words(statement)
    if len(words) < MIN_RULE_WORDS:
        return False
    for rule in rules:
        other = _words(rule)
        if len(other) >= MIN_RULE_WORDS and len(words & other) / min(len(words), len(other)) >= MIRROR_CONTAINMENT:
            return True
    return False
