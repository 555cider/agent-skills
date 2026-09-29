from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
import unicodedata
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable


class MemoryError(RuntimeError):
    """Expected operational error shown without a traceback by the CLI."""


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_after(*, days: int = 0, seconds: int = 0) -> str:
    return (datetime.now(UTC) + timedelta(days=days, seconds=seconds)).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def user_home() -> Path:
    # Path.home() and expanduser() consult USERPROFILE on Windows and ignore
    # HOME, so an overridden HOME resolves back to the real profile and writes
    # outside the caller's sandbox. Honor HOME first on every platform.
    raw = os.environ.get("HOME")
    return Path(raw) if raw else Path.home()


def expand_user_path(raw: str | Path) -> Path:
    text = str(raw)
    if text == "~":
        return user_home()
    if text.startswith(("~/", "~\\")):
        return user_home() / text[2:]
    return Path(text).expanduser()


def memory_home(explicit: str | None = None) -> Path:
    raw = explicit or os.environ.get("AGENT_MEMORY_HOME") or str(user_home() / ".agents" / "memory")
    return expand_user_path(raw).resolve()


def resolve_cwd(raw: str | None = None) -> Path:
    return expand_user_path(raw or os.getcwd()).resolve()


def _git_value(cwd: Path, *args: str) -> str:
    # Bytes, decoded here as UTF-8: git prints paths as UTF-8, and `text=True` decodes
    # with the locale codec instead. On a cp949 Windows console a Korean worktree name
    # failed that decode inside subprocess's reader thread, which swallows the error
    # and leaves stdout as None -- so every lookup from such a directory crashed, and
    # hooks, which fail open, silently recorded nothing there.
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if result.returncode != 0 or not result.stdout:
        return ""
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError:
        return ""


def repo_root(cwd: Path) -> Path:
    """The directory that names a repository: its main worktree, not the one `cwd` is in.

    `--show-toplevel` answers with the *linked* worktree when `cwd` is inside one, and
    keying on that gave every worktree its own project: memory written while working in
    a worktree never surfaced in the main tree or in the next worktree, so the same trap
    was rediscovered and re-remembered once per worktree. The common git dir is shared
    by all of them, and for an ordinary repository it is `<main worktree>/.git`.

    Anything else -- a bare repository, a submodule whose common dir sits under
    `.git/modules/` -- keeps the toplevel, which is what it was keyed on before.
    """

    top = _git_value(cwd, "rev-parse", "--show-toplevel")
    if not top:
        return cwd.resolve()
    common = _git_value(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common:
        common_path = Path(common).resolve()
        if common_path.name == ".git":
            return common_path.parent
    return Path(top).resolve()


def root_identity(root: Path) -> str:
    origin = _git_value(root, "config", "--get", "remote.origin.url")
    if origin:
        # Strip URL credentials without retaining a reversible local path.
        origin = re.sub(r"(?i)(https?://)[^/@]+@", r"\1", origin)
        return "origin:" + origin.rstrip("/").removesuffix(".git").casefold()
    return "path:" + str(root)


def repo_identity(cwd: Path) -> tuple[str, Path]:
    root = repo_root(cwd)
    return root_identity(root), root


def git_root(cwd: Path) -> Path | None:
    """The git toplevel containing `cwd`, or None when it is not in a repository.

    `repo_identity` deliberately falls back to a path identity for a plain
    directory, which is right for the working directory the user is standing in
    and wrong for a path parsed out of someone's notes: a directory that merely
    exists should not mint a project key.
    """
    top = _git_value(cwd, "rev-parse", "--show-toplevel")
    return Path(top).resolve() if top else None


def key_for(root: Path, identity: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", root.name.casefold()).strip("-") or "repo"
    return f"{slug}-{digest_text(identity)[:16]}"


def repo_key(cwd: Path) -> str:
    identity, root = repo_identity(cwd)
    return key_for(root, identity)


# Hosts deliver some non-user turns through the prompt hook: background task
# notifications and subagent reports. They are not requests, so they neither
# recall memory nor count as a remember/forget instruction.
HARNESS_MESSAGE_RE = re.compile(
    r"^\s*(?:<task-notification>|<agent-message\b|<system-reminder>|<local-command-|\[SYSTEM NOTIFICATION)"
)


def is_harness_message(prompt: str) -> bool:
    return HARNESS_MESSAGE_RE.match(prompt) is not None


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub(r"[`*_#>|]", " ", value)
    value = re.sub(r"[^\w가-힣./:+-]+", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


WORD_TOKEN_RE = re.compile(r"[\w가-힣][\w가-힣.+/-]*")


def word_tokens(text: str) -> list[str]:
    """Raw word tokens only — no concept or alias expansion.

    Destructive matching (forget) must use this instead of semantic_tokens:
    alias expansion makes unrelated statements share many tokens.
    """
    return WORD_TOKEN_RE.findall(normalize_text(text))


CONCEPTS: dict[str, tuple[str, ...]] = {
    "verify": (
        "verify", "verification", "validate", "check", "test", "inspect", "review",
        "검증", "테스트", "확인", "검사", "점검",
    ),
    "targeted": (
        "targeted", "narrow", "focused", "minimal", "small", "minor",
        "선별", "좁은", "최소", "필요한", "작은",
    ),
    "docs": ("docs", "documentation", "document", "readme", "문서", "도큐먼트"),
    "visual": ("visual", "rendered", "screen", "ui", "browser", "화면", "렌더", "시각"),
    "direct": ("direct", "execute", "action", "implement", "직접", "실행", "구현"),
    "concise": ("concise", "brief", "short", "compact", "간결", "짧게", "압축"),
    "avoid": ("avoid", "never", "don't", "do not", "stop", "금지", "말고", "쓰지", "하지"),
    "prefer": ("prefer", "preference", "favor", "rather", "선호", "우선"),
    "package": ("package", "dependency", "npm", "pnpm", "yarn", "패키지", "의존성"),
    "commit": ("commit", "git", "branch", "pr", "커밋", "브랜치", "풀리퀘"),
    "memory": ("memory", "remember", "recall", "기억", "메모리", "회상"),
    "plan": ("plan", "design", "architecture", "계획", "설계", "아키텍처"),
    "error": ("error", "failure", "bug", "issue", "오류", "실패", "버그", "문제"),
}


# Korean attaches particles and endings to the word ("배포가", "린트를",
# "커밋해줘"), so an exact-token index never matches the bare word. Longest
# first; a stem must keep two syllables so short nouns are not eaten.
HANGUL_SUFFIXES = tuple(
    sorted(
        (
            "에서는", "으로는", "이라고", "했는데", "합니다", "해주세요",
            "에서", "으로", "까지", "부터", "처럼", "하고", "이랑", "에게", "한테", "보다",
            "라고", "해줘", "했어", "할게", "하자", "해요", "해서", "하면", "하는", "된다",
            "한다", "는데", "지만", "였다", "이다", "하게", "해야", "하려면", "하지",
            "은", "는", "이", "가", "을", "를", "에", "의", "도", "만", "로", "와", "과",
            "랑", "줘", "다", "고", "면", "해", "한",
        ),
        key=len,
        reverse=True,
    )
)
HANGUL_END_RE = re.compile(r"[가-힣]$")


# One word in each language for the same specific thing. Unlike the broad
# CONCEPTS above, sharing one of these is real evidence on its own.
TRANSLATIONS: dict[str, tuple[str, ...]] = {
    "build": ("build", "builds", "빌드"),
    "deploy": ("deploy", "deployment", "release", "배포", "릴리스"),
    "lint": ("lint", "linter", "린트"),
    "layout": ("layout", "레이아웃"),
    "python": ("python", "파이썬"),
    "decision": ("decision", "decisions", "결정"),
    "state": ("state", "status", "상태"),
    "summary": ("summary", "summaries", "report", "요약", "보고"),
    "clear": ("clear", "obvious", "straightforward", "명확"),
    "local": ("local", "로컬"),
    "remote": ("remote", "external", "원격", "외부"),
    "cache": ("cache", "캐시"),
    "migration": ("migration", "migrations", "마이그레이션"),
    "database": ("database", "db", "데이터베이스", "디비"),
    "worktree": ("worktree", "worktrees", "워크트리"),
    "component": ("component", "components", "컴포넌트"),
    "screenshot": ("screenshot", "screenshots", "스크린샷", "캡처"),
}


def hangul_stem(token: str) -> str:
    """The token without one trailing Korean particle or ending, or "" if none."""

    if not HANGUL_END_RE.search(token):
        return ""
    for suffix in HANGUL_SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 2:
            return token[: -len(suffix)]
    return ""


def base_tokens(text: str, *, parts: bool = True) -> list[str]:
    """Word tokens plus their Korean stems, without concept expansion."""

    ordered: list[str] = []
    for token in WORD_TOKEN_RE.findall(normalize_text(text)):
        # Sentence punctuation sticks to the last word ("돌린다.", "check-token-7.").
        token = token.rstrip(".:/+-")
        # A compound identifier also matches its parts: "3.1 flash lite"
        # should find "gemini-3.1-flash-lite".
        pieces = (
            [piece for piece in re.split(r"[-/:+]|(?<![0-9])\.|\.(?![0-9])", token) if len(piece) >= 2]
            if parts
            else []
        )
        for value in (token, hangul_stem(token), *(pieces if len(pieces) > 1 else ())):
            if value and value not in ordered:
                ordered.append(value)
    return ordered


def _alias_present(alias: str, tokens: set[str], normalized: str) -> bool:
    # Whole tokens only: a substring test let "pr" fire on "prompt" and "ui" on
    # "build", dragging a whole alias bundle into unrelated prompts.
    if " " in alias:
        return re.search(rf"(?<!\w){re.escape(alias)}(?!\w)", normalized) is not None
    return alias in tokens


def concepts_in(text: str, table: dict[str, tuple[str, ...]] | None = None) -> list[str]:
    normalized = normalize_text(text)
    tokens = set(base_tokens(text))
    return [
        concept
        for concept, aliases in (CONCEPTS if table is None else table).items()
        if any(_alias_present(alias, tokens, normalized) for alias in aliases)
    ]


def semantic_tokens(text: str) -> list[str]:
    ordered: list[str] = []

    def add(value: str) -> None:
        if value and value not in ordered:
            ordered.append(value)

    for token in base_tokens(text):
        add(token)
    for concept in concepts_in(text):
        add(f"concept_{concept}")
        for alias in CONCEPTS[concept]:
            add(alias)
    for concept in concepts_in(text, TRANSLATIONS):
        for alias in TRANSLATIONS[concept]:
            add(alias)
    # Cheap English stemming gives local paraphrase recall without a model.
    for token in list(ordered):
        if len(token) > 5:
            for suffix in ("ation", "ments", "ment", "ing", "ed", "es", "s"):
                if token.endswith(suffix) and len(token) - len(suffix) >= 3:
                    add(token[: -len(suffix)])
                    break
    return ordered


def fts_query(tokens: Iterable[str], *, limit: int = 18) -> str:
    clean: list[str] = []
    for token in tokens:
        token = token.replace('"', "").strip()
        if len(token) >= 2 and token not in clean:
            clean.append(token)
        if len(clean) >= limit:
            break
    return " OR ".join(f'"{token}"' for token in clean)


def rough_tokens(text: str) -> int:
    # Korean and code are denser than English words; bytes/4 is conservative.
    return max(1, len(text.encode("utf-8")) // 4)


def head_tail(value: str, max_bytes: int) -> str:
    raw = value.encode("utf-8", errors="replace")
    if len(raw) <= max_bytes:
        return value
    half = max_bytes // 2
    return (
        raw[:half].decode("utf-8", errors="replace")
        + "\n[...TRUNCATED...]\n"
        + raw[-half:].decode("utf-8", errors="replace")
    )


def atomic_write(path: Path, content: str, *, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    temporary.write_text(content, encoding="utf-8")
    try:
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def jsonable_row(row: Any) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}
