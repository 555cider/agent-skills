"""Plan documents without plan-graph frontmatter: the minimum worth routing on.

Repositories that plan in Markdown under their own convention (`docs/plans`, an ignored
`.plans/`) get read, never rewritten: the first `# ` title, the first status line above
the first `## ` section, and the repository paths the text names in backticks as scope.

Status lines follow the forms seen in practice, first match wins:

    > **상태 (코드 대조 2026-11-16)**: 남은 것 5건: …
    > **상태: 완료** (근거 — …)
    상태: dev 반영(2026-11-18, squash). …
    - 상태: 초안, …
    Status: done
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from .model import H1_RE, H2_RE, Plan, extract_sections, heading_matches, mask_fences, repo_relative

STATUS_RE = re.compile(
    r"^\s{0,3}(?:>\s*)*(?:[-*+]\s+)?(?:\*\*|__)?(?:상태|status)"
    r"(?:\s*[(（][^)）\n]*[)）])?\s*(?:\*\*|__)?\s*[:：]\s*(?P<value>\S.*)$",
    re.IGNORECASE,
)
# Korean words take suffixes (완료됨, 취소함); English ones must end at a word boundary.
DONE_RE = re.compile(
    r"^(?:완료|대체됨|취소|폐기|(?:done|complete|completed|landed|finished|superseded|cancell?ed)\b)",
    re.IGNORECASE,
)
REMAINING_RE = re.compile(
    r"남은|잔여|열린|미결|미착수|보류|\b(?:remaining|open|todo|pending)\b", re.IGNORECASE
)
CODE_SPAN_RE = re.compile(r"`[^`\n]*`")
SPAN_RE = re.compile(r"`([^`\n]{1,300})`")
PATH_CHARS_RE = re.compile(r"^[\w.\-/{},+@]+$")
EXTENSION_RE = re.compile(r"\.[A-Za-z][A-Za-z0-9]{0,7}$")
LINE_SUFFIX_RE = re.compile(r"(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$")
BRACE_RE = re.compile(r"^(?P<head>[^{}]*)\{(?P<items>[^{}]+)\}(?P<tail>[^{}]*)$")
SUFFIX_MATCH_LIMIT = 3
DIRECTORY_FILE_LIMIT = 50
SCOPE_LIMIT = 100
STATUS_LIMIT = 300


@dataclass
class FileIndex:
    """Repository files by basename, for paths a document gives relative to a subtree."""

    files: set[str]
    by_name: dict[str, list[str]] = field(default_factory=dict)

    @classmethod
    def build(cls, files: list[str] | None) -> "FileIndex | None":
        if files is None:
            return None
        index = cls(files=set(files))
        for path in files:
            index.by_name.setdefault(path.rsplit("/", 1)[-1], []).append(path)
        return index


def status_line(body: str) -> str:
    """The first status line between the title and the first `## ` section."""
    masked = mask_fences(body)
    h1 = heading_matches(H1_RE, body)
    start = h1[0].end() if h1 else 0
    sections = [match for match in heading_matches(H2_RE, body) if match.start() >= start]
    end = sections[0].start() if sections else len(body)
    for line in masked[start:end].splitlines():
        match = STATUS_RE.match(line)
        if match:
            value = match.group("value").replace("**", "").replace("__", "").strip()
            return value[:STATUS_LIMIT]
    return ""


def classify(status: str) -> str:
    """`done` for a status that opens with a finished word and names nothing left."""
    # Paths in backticks (`src/openapi.ts`) are evidence, not words about what is left.
    words = CODE_SPAN_RE.sub(" ", status)
    if status and DONE_RE.match(status) and not REMAINING_RE.search(words):
        return "done"
    return "active"


def _expand(candidate: str) -> list[str]:
    match = BRACE_RE.match(candidate)
    if not match:
        return [] if "{" in candidate or "}" in candidate else [candidate]
    return [
        f"{match.group('head')}{item.strip()}{match.group('tail')}"
        for item in match.group("items").split(",")
        if item.strip()
    ]


def _clean(span: str) -> str | None:
    candidate = span.strip().replace("\\", "/")
    while candidate.startswith("./"):
        candidate = candidate[2:]
    candidate = LINE_SUFFIX_RE.sub("", candidate).rstrip(".,;:")
    if not candidate or not PATH_CHARS_RE.match(candidate):
        return None
    if candidate.startswith(("/", "-", "@")) or "//" in candidate:
        return None
    if ".." in candidate.split("/"):
        return None
    return candidate


def extract_scope(body: str, root: Path, index: FileIndex | None, own_path: str) -> tuple[str, ...]:
    """Repository paths named in backticks that exist: files as-is, directories as `dir/**`.

    A path with a slash that is not at the root matches files ending in it (at most
    three); a bare file name matches only when exactly one file has that name.
    """
    found: dict[str, None] = {}
    for span in SPAN_RE.findall(mask_fences(body)):
        cleaned = _clean(span)
        if cleaned is None:
            continue
        for candidate in _expand(cleaned):
            for path in _resolve(candidate, root, index):
                if path != own_path:
                    found.setdefault(path, None)
            if len(found) >= SCOPE_LIMIT:
                return tuple(found)
    return tuple(found)


def _resolve(candidate: str, root: Path, index: FileIndex | None) -> list[str]:
    candidate = candidate.rstrip("/")
    if not candidate or candidate == ".":
        return []
    name = candidate.rsplit("/", 1)[-1]
    if "/" not in candidate and not EXTENSION_RE.search(candidate):
        return []
    target = root / candidate
    try:
        if target.is_file():
            return [candidate]
        if "/" in candidate and target.is_dir():
            # `src/backend` named in passing is context, not ownership: a directory
            # holding more files than a focused change would touch is not a scope.
            if index is not None:
                prefix = candidate + "/"
                count = sum(1 for path in index.files if path.startswith(prefix))
                if count > DIRECTORY_FILE_LIMIT:
                    return []
            return [f"{candidate}/**"]
    except OSError:
        return []
    if index is None:
        return []
    same_name = index.by_name.get(name, [])
    if "/" in candidate:
        matches = [path for path in same_name if path.endswith("/" + candidate)]
        return matches if 0 < len(matches) <= SUFFIX_MATCH_LIMIT else []
    return same_name if len(same_name) == 1 else []


def parse_loose(path: Path, root: Path, body: str, index: FileIndex | None) -> Plan:
    h1 = heading_matches(H1_RE, body)
    title = h1[0].group("title").strip() if h1 else path.stem
    status = status_line(body)
    sections = extract_sections(body)
    if "Outcome" not in sections:
        # The text above the first section is what such documents use as their summary;
        # routing and the decision pack read it as the outcome.
        start = h1[0].end() if h1 else 0
        h2 = [match for match in heading_matches(H2_RE, body) if match.start() >= start]
        sections["Outcome"] = body[start:h2[0].start() if h2 else len(body)].strip()
    relative = repo_relative(root, path)
    return Plan(
        id=path.stem,
        path=path,
        title=title,
        status=classify(status),
        requires=(),
        replaces=(),
        scope=extract_scope(body, root, index, relative),
        tags=(),
        body=body,
        sections=sections,
        kind="loose",
        status_line=status,
    )


def plan_dir_label(directory: PurePosixPath) -> str:
    return directory.as_posix().rstrip("/") + "/"
