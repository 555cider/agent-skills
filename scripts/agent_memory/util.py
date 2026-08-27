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
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def repo_identity(cwd: Path) -> tuple[str, Path]:
    top = _git_value(cwd, "rev-parse", "--show-toplevel")
    root = Path(top).resolve() if top else cwd.resolve()
    origin = _git_value(root, "config", "--get", "remote.origin.url")
    if origin:
        # Strip URL credentials without retaining a reversible local path.
        origin = re.sub(r"(?i)(https?://)[^/@]+@", r"\1", origin)
        identity = "origin:" + origin.rstrip("/").removesuffix(".git").casefold()
    else:
        identity = "path:" + str(root)
    return identity, root


def git_root(cwd: Path) -> Path | None:
    """The git toplevel containing `cwd`, or None when it is not in a repository.

    `repo_identity` deliberately falls back to a path identity for a plain
    directory, which is right for the working directory the user is standing in
    and wrong for a path parsed out of someone's notes: a directory that merely
    exists should not mint a project key.
    """
    top = _git_value(cwd, "rev-parse", "--show-toplevel")
    return Path(top).resolve() if top else None


def repo_key(cwd: Path) -> str:
    identity, root = repo_identity(cwd)
    slug = re.sub(r"[^a-z0-9]+", "-", root.name.casefold()).strip("-") or "repo"
    return f"{slug}-{digest_text(identity)[:16]}"


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
    "verify": ("verify", "verification", "validate", "check", "test", "검증", "테스트", "확인"),
    "targeted": ("targeted", "narrow", "focused", "minimal", "선별", "좁은", "최소", "필요한"),
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


def semantic_tokens(text: str) -> list[str]:
    normalized = normalize_text(text)
    raw_tokens = WORD_TOKEN_RE.findall(normalized)
    ordered: list[str] = []

    def add(value: str) -> None:
        if value and value not in ordered:
            ordered.append(value)

    for token in raw_tokens:
        add(token)
    for concept, aliases in CONCEPTS.items():
        if any(alias in normalized for alias in aliases):
            add(f"concept_{concept}")
            for alias in aliases:
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
