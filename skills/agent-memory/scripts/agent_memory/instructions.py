"""Rules a host already loads from its own instruction files.

Claude Code reads CLAUDE.md on every turn; Codex and OpenCode read AGENTS.md. A
memory that restates one of those rules adds nothing when recalled into that
host, so recall skips it there -- and still serves it to the hosts that do not
read that file, which is why the memory is kept rather than deleted.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Sequence

from .util import base_tokens, user_home

# Per host: files under the user's home, and file names read in every directory
# from the working directory up to the filesystem root.
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


def loaded_rules(harness: str, cwd: Path, *, home: Path | None = None) -> list[str]:
    home_files, local_names = HOST_FILES.get(harness, ((), ()))
    home = home or user_home()
    paths = [home / relative for relative in home_files]
    for directory in (cwd, *cwd.parents):
        paths.extend(directory / name for name in local_names)
    rules: list[str] = []
    seen: set[Path] = set()
    for path in paths:
        try:
            resolved = path.resolve()
            if resolved in seen or not resolved.is_file():
                continue
            seen.add(resolved)
            rules.extend(_units(resolved.read_text(encoding="utf-8", errors="replace")))
        except OSError:
            continue
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
