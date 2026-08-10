from __future__ import annotations

import json
import re
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Iterable


PLAN_DIR = PurePosixPath(".agents/plans")
LEGACY_GRAPH = PurePosixPath(".agents/plan/graph.yaml")
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(?P<json>.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)
H1_RE = re.compile(r"^# (?P<title>\S.*)$", re.MULTILINE)
H2_RE = re.compile(r"^## (?P<title>[^\r\n]+)[ \t]*$", re.MULTILINE)
REQUIRED_SECTIONS = (
    "Outcome",
    "Evidence",
    "Decisions",
    "Implementation",
    "Acceptance",
    "Completion",
)
METADATA_KEYS = {"status", "requires", "replaces", "scope", "tags"}
VALID_STATUSES = {"active", "done"}
TBD_MARKER = "TBD"
GATE_SECTIONS = ("Outcome", "Decisions", "Completion")


class PlanGraphError(Exception):
    """Expected domain or filesystem error surfaced by the CLI."""

    def __init__(self, message: str, *, code: str = "plan_graph_error") -> None:
        super().__init__(message)
        self.code = code


def _strict_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-standard JSON constant: {value}")


@dataclass(frozen=True)
class Diagnostic:
    severity: str
    code: str
    message: str
    plan: str | None = None
    path: str | None = None

    def as_dict(self) -> dict[str, str]:
        data = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }
        if self.plan is not None:
            data["plan"] = self.plan
        if self.path is not None:
            data["path"] = self.path
        return data


@dataclass(frozen=True)
class Plan:
    id: str
    path: Path
    title: str
    status: str
    requires: tuple[str, ...]
    replaces: tuple[str, ...]
    scope: tuple[str, ...]
    tags: tuple[str, ...]
    body: str
    sections: dict[str, str]

    def metadata(self) -> dict[str, object]:
        return {
            "status": self.status,
            "requires": list(self.requires),
            "replaces": list(self.replaces),
            "scope": list(self.scope),
            "tags": list(self.tags),
        }

    def with_metadata(self, **updates: object) -> "Plan":
        return replace(self, **updates)

    def as_summary(self) -> dict[str, object]:
        return {
            "id": self.id,
            "path": self.path.as_posix(),
            "title": self.title,
            "status": self.status,
            "requires": list(self.requires),
            "replaces": list(self.replaces),
            "scope": list(self.scope),
            "tags": list(self.tags),
        }


def plan_path(root: Path, plan_id: str) -> Path:
    return root / PLAN_DIR / f"{plan_id}.md"


def repo_relative(root: Path, path: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _string_array(
    metadata: dict[str, object],
    key: str,
    *,
    plan_id: str,
    diagnostics: list[Diagnostic],
) -> tuple[str, ...]:
    value = metadata.get(key)
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        diagnostics.append(
            Diagnostic("error", "invalid_metadata", f"{key} must be an array of strings", plan_id)
        )
        return ()
    cleaned = tuple(item.strip() for item in value)
    if any(not item for item in cleaned):
        diagnostics.append(
            Diagnostic("error", "invalid_metadata", f"{key} contains an empty value", plan_id)
        )
    if any("\n" in item or "\r" in item for item in cleaned):
        diagnostics.append(
            Diagnostic("error", "invalid_metadata", f"{key} values must be single-line", plan_id)
        )
    folded = [item.casefold() for item in cleaned]
    if len(folded) != len(set(folded)):
        diagnostics.append(
            Diagnostic("error", "duplicate_metadata", f"{key} contains duplicate values", plan_id)
        )
    return cleaned


def _validate_scope(plan_id: str, patterns: Iterable[str]) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    for pattern in patterns:
        pure = PurePosixPath(pattern)
        if (
            pattern.startswith("/")
            or "\\" in pattern
            or ".." in pure.parts
            or pattern in {"", "."}
        ):
            diagnostics.append(
                Diagnostic(
                    "error",
                    "invalid_scope",
                    f"scope must be a repository-relative POSIX glob: {pattern!r}",
                    plan_id,
                )
            )
            continue
        try:
            compile_scope(pattern)
        except ValueError as exc:
            diagnostics.append(
                Diagnostic("error", "invalid_scope", str(exc), plan_id)
            )
    return diagnostics


def parse_plan(path: Path, root: Path) -> tuple[Plan | None, list[Diagnostic]]:
    diagnostics: list[Diagnostic] = []
    relative = repo_relative(root, path)
    plan_id = path.stem
    if not ID_RE.fullmatch(plan_id):
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_id",
                "plan filename must be a lowercase kebab-case ID",
                plan_id,
                relative,
            )
        )
    if path.is_symlink():
        diagnostics.append(
            Diagnostic("error", "symlink_plan", "plan files may not be symlinks", plan_id, relative)
        )
        return None, diagnostics
    try:
        content = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        diagnostics.append(
            Diagnostic("error", "read_failed", f"failed to read plan: {exc}", plan_id, relative)
        )
        return None, diagnostics

    match = FRONTMATTER_RE.match(content)
    if not match:
        diagnostics.append(
            Diagnostic(
                "error",
                "missing_frontmatter",
                "plan must start with JSON inside --- frontmatter delimiters",
                plan_id,
                relative,
            )
        )
        return None, diagnostics
    try:
        metadata = json.loads(
            match.group("json"),
            object_pairs_hook=_strict_json_object,
            parse_constant=_reject_json_constant,
        )
    except json.JSONDecodeError as exc:
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_json",
                f"invalid JSON frontmatter: line {exc.lineno} column {exc.colno}: {exc.msg}",
                plan_id,
                relative,
            )
        )
        return None, diagnostics
    except ValueError as exc:
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_json",
                f"invalid JSON frontmatter: {exc}",
                plan_id,
                relative,
            )
        )
        return None, diagnostics
    if not isinstance(metadata, dict):
        diagnostics.append(
            Diagnostic("error", "invalid_metadata", "frontmatter must be a JSON object", plan_id, relative)
        )
        return None, diagnostics
    missing_keys = sorted(METADATA_KEYS - set(metadata))
    unknown_keys = sorted(set(metadata) - METADATA_KEYS)
    if missing_keys:
        diagnostics.append(
            Diagnostic(
                "error",
                "missing_metadata",
                "missing metadata keys: " + ", ".join(missing_keys),
                plan_id,
                relative,
            )
        )
    if unknown_keys:
        diagnostics.append(
            Diagnostic(
                "error",
                "unknown_metadata",
                "unknown metadata keys: " + ", ".join(unknown_keys),
                plan_id,
                relative,
            )
        )

    status = metadata.get("status")
    if status not in VALID_STATUSES:
        diagnostics.append(
            Diagnostic(
                "error",
                "invalid_status",
                "status must be 'active' or 'done'",
                plan_id,
                relative,
            )
        )
        status = "active"
    requires = _string_array(metadata, "requires", plan_id=plan_id, diagnostics=diagnostics)
    replaces = _string_array(metadata, "replaces", plan_id=plan_id, diagnostics=diagnostics)
    scope = _string_array(metadata, "scope", plan_id=plan_id, diagnostics=diagnostics)
    tags = _string_array(metadata, "tags", plan_id=plan_id, diagnostics=diagnostics)
    if not scope and not tags:
        diagnostics.append(
            Diagnostic(
                "error",
                "unroutable_plan",
                "at least one scope or tag is required",
                plan_id,
                relative,
            )
        )
    diagnostics.extend(_validate_scope(plan_id, scope))
    for relation, values in (("requires", requires), ("replaces", replaces)):
        for value in values:
            if not ID_RE.fullmatch(value):
                diagnostics.append(
                    Diagnostic(
                        "error",
                        "invalid_relation_id",
                        f"{relation} contains invalid plan ID {value!r}",
                        plan_id,
                        relative,
                    )
                )

    body = content[match.end():]
    h1_matches = list(H1_RE.finditer(body))
    h1 = h1_matches[0] if h1_matches else None
    if h1 is None:
        diagnostics.append(
            Diagnostic("error", "missing_title", "plan body must contain a '# Title' heading", plan_id, relative)
        )
        title = plan_id
    else:
        title = h1.group("title").strip()
        if body[: h1.start()].strip():
            diagnostics.append(
                Diagnostic(
                    "error",
                    "title_not_first",
                    "the H1 title must be the first non-empty body content",
                    plan_id,
                    relative,
                )
            )
        if len(h1_matches) > 1:
            diagnostics.append(
                Diagnostic(
                    "error",
                    "duplicate_title",
                    "plan body must contain exactly one H1 title",
                    plan_id,
                    relative,
                )
            )

    sections = extract_sections(body)
    section_headings = [match.group("title").strip() for match in H2_RE.finditer(body)]
    duplicate_sections = sorted(
        {title for title in section_headings if section_headings.count(title) > 1}
    )
    for section in duplicate_sections:
        diagnostics.append(
            Diagnostic(
                "error",
                "duplicate_section",
                f"duplicate section '## {section}'",
                plan_id,
                relative,
            )
        )
    for section in REQUIRED_SECTIONS:
        if section not in sections:
            diagnostics.append(
                Diagnostic(
                    "error",
                    "missing_section",
                    f"missing required section '## {section}'",
                    plan_id,
                    relative,
                )
            )

    plan = Plan(
        id=plan_id,
        path=path,
        title=title,
        status=str(status),
        requires=requires,
        replaces=replaces,
        scope=scope,
        tags=tags,
        body=body,
        sections=sections,
    )
    return plan, diagnostics


def unfilled_sections(plan: Plan, sections: Iterable[str] = REQUIRED_SECTIONS) -> tuple[str, ...]:
    return tuple(
        section
        for section in sections
        if plan.sections.get(section, "").strip() == TBD_MARKER
    )


def extract_sections(body: str) -> dict[str, str]:
    matches = list(H2_RE.finditer(body))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        title = match.group("title").strip()
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections[title] = body[start:end].strip()
    return sections


def render_plan(plan: Plan) -> str:
    metadata = json.dumps(plan.metadata(), ensure_ascii=False, indent=2)
    body = plan.body.lstrip("\r\n")
    return f"---\n{metadata}\n---\n{body}"


def make_plan(
    *,
    root: Path,
    plan_id: str,
    title: str,
    requires: Iterable[str] = (),
    replaces: Iterable[str] = (),
    scope: Iterable[str] = (),
    tags: Iterable[str] = (),
) -> Plan:
    body_lines = [f"# {title.strip()}", ""]
    for section in REQUIRED_SECTIONS:
        body_lines.extend([f"## {section}", "", "TBD", ""])
    body = "\n".join(body_lines).rstrip() + "\n"
    return Plan(
        id=plan_id,
        path=plan_path(root, plan_id),
        title=title.strip(),
        status="active",
        requires=tuple(dict.fromkeys(requires)),
        replaces=tuple(dict.fromkeys(replaces)),
        scope=tuple(dict.fromkeys(scope)),
        tags=tuple(dict.fromkeys(tags)),
        body=body,
        sections=extract_sections(body),
    )


def replace_title(plan: Plan, title: str) -> Plan:
    match = H1_RE.search(plan.body)
    if not match:
        raise PlanGraphError(f"{plan.id} has no H1 title", code="missing_title")
    body = plan.body[: match.start()] + f"# {title.strip()}" + plan.body[match.end():]
    return replace(plan, title=title.strip(), body=body, sections=extract_sections(body))


def compile_scope(pattern: str) -> re.Pattern[str]:
    """Compile the documented POSIX glob subset: *, **, and ?."""
    pieces: list[str] = ["^"]
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                index += 2
                if index < len(pattern) and pattern[index] == "/":
                    pieces.append("(?:.*/)?")
                    index += 1
                else:
                    pieces.append(".*")
                continue
            pieces.append("[^/]*")
        elif char == "?":
            pieces.append("[^/]")
        elif char == "[":
            raise ValueError(f"scope character classes are unsupported: {pattern!r}")
        else:
            pieces.append(re.escape(char))
        index += 1
    pieces.append("$")
    return re.compile("".join(pieces))


def scope_matches(pattern: str, path: str) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return bool(compile_scope(pattern).fullmatch(normalized))
