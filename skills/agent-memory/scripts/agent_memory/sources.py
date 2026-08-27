"""Turn another agent's memory files into an `agent-memory.export.v2` payload.

This module reads only. It knows nothing about the database: `adopt` hands what
it returns to `MemoryService.import_records`, which is the same trust boundary a
hand-written export file crosses. That is deliberate — redaction, tombstones,
content-hash merging and the `inferred`/`provisional` ceiling are enforced once,
in the write path, for every source.

What it will and will not carry is the one judgement encoded here. agent-memory
is a rule store whose contents are injected into a 1,200-token recall budget, not
a transcript archive, so a durability line runs through these files: a statement
about how work should be done crosses it, a record of what was done once does
not. `MEMORY.md` straddles the line inside a single file, which is why its
`Task Group` scaffolding is read for scope routing and never turned into a
statement.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

from .constants import ADOPT_SOURCES, EXPORT_SCHEMA, RECORD_SCHEMA
from .redaction import redact_text
from .util import (
    MemoryError,
    expand_user_path,
    git_root,
    normalize_text,
    repo_key,
    resolve_cwd,
    user_home,
    utc_now,
)

# A statement shorter than this is a fragment ("see below", "TODO"); one longer
# than this is a section that was never a single rule. Both are noise in a recall
# packet, and neither is worth a reviewer's attention.
MIN_STATEMENT_CHARS = 12
MAX_STATEMENT_CHARS = 600

# The only `MEMORY.md` / `memory_summary.md` sections that survive the durability
# line. Everything else under a Task Group -- the task list, the rollout summary
# back-references, the keyword index -- records what happened, not what to do.
DURABLE_CODEX_SECTIONS = {"user preferences", "reusable knowledge", "user profile"}

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
BULLET_RE = re.compile(r"^(\s*)[-*+]\s+(.*)$")
ORDERED_RE = re.compile(r"^(\s*)\d+[.)]\s+(.*)$")
RULE_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
APPLIES_CWD_RE = re.compile(r"(?i)\bcwd\s*=\s*([^;]+)")
TASK_TAG_RE = re.compile(r"\s*\[Task\s+\d+\]\s*$", re.I)
EMPHASIS_RE = re.compile(r"(\*\*|__)")
GLOB_RE = re.compile(r"`([^`\s]*[/\\][^`\s]*)`")

# Home directories are rewritten rather than dropped: `create_memory` refuses a
# statement containing one outright, and Codex writes absolute rollout paths into
# its reusable-knowledge entries. Without this the most useful Codex records are
# the ones that never arrive.
EXTENDED_PREFIX_RE = re.compile(r"\\\\\?\\")
WINDOWS_HOME_RE = re.compile(r"(?i)\b[A-Za-z]:[\\/]Users[\\/][^\\/\s'\";,)\]}]+")
POSIX_HOME_RE = re.compile(r"(?<![\w.])/(?:home|Users)/[^/\s'\";,)\]}]+")

CONSTRAINT_RE = re.compile(
    r"(?i)\b(?:never|must not|do not|don't|cannot|forbidden|refuse)\b"
    r"|않는다|않기|말 것|하지 마|금지|절대|안 된다"
)
CAVEAT_RE = re.compile(
    r"(?i)\b(?:gotcha|caution|beware|pitfall|trap|watch out|careful)\b"
    r"|함정|주의|조심|유의|빠지기 쉬"
)
PROCEDURE_RE = re.compile(
    r"(?i)\b(?:step|first .* then|run |install |execute )\b|먼저 .*(?:그다음|다음에)|절차|순서대로"
)
# Korean past tense only at a clause boundary. Unanchored, `했다` also fires
# inside `발견했다면` — a conditional in a rule, not a record of a decision.
DECISION_RE = re.compile(
    r"(?i)\b(?:decided|chose|switched|migrated|adopted|settled on)\b"
    r"|기로 했|(?:했|였|졌|하였)다(?=[\s.,)\]\"'”]|$)"
)
# A sentence still giving an instruction is a rule, whatever it recalls on the
# way there: `... 발견했다면 더더욱 묻는다` decides nothing, it tells you to ask.
RULE_VOICE_RE = re.compile(
    r"(?:한다|않는다|된다|둔다|본다|준다|쓴다|묻는다|참조|하라|해라|하자|말 것)(?=[\s.,)\]\"'”]|$)"
)
PREFERENCE_RE = re.compile(
    r"(?i)\b(?:prefer|favor|rather than|default to|instead of)\b|선호|우선한다|기본으로"
)


@dataclass(frozen=True)
class SourceFile:
    """One external memory file this machine actually has."""

    source: str
    path: Path
    scope: str  # global | project | mixed (decided per record)
    project: str | None
    episodic: bool
    label: str


@dataclass
class Block:
    """One candidate statement lifted out of a markdown document."""

    text: str
    headings: tuple[str, ...]
    commands: tuple[str, ...]
    ordered: bool


# --------------------------------------------------------------------- helpers


def display_path(path: Path, home: Path) -> str:
    """Render a path the way it is safe to store: home collapsed to `~`."""
    try:
        return "~/" + path.relative_to(home).as_posix()
    except ValueError:
        return path.as_posix()


def normalize_home_paths(value: str) -> str:
    """Collapse this machine's home directory out of a statement.

    `redaction.PATTERNS` treats `C:\\Users\\...`, `/home/...` and `/Users/...` as
    personal data and `create_memory` refuses the whole record when it finds one.
    A rule that mentions `~/.codex/config.toml` is worth keeping; the account name
    in front of it is not.
    """
    value = EXTENDED_PREFIX_RE.sub("", value)
    value = WINDOWS_HOME_RE.sub("~", value)
    value = POSIX_HOME_RE.sub("~", value)
    return value


def _clean_statement(value: str) -> str:
    value = TASK_TAG_RE.sub("", value)
    value = EMPHASIS_RE.sub("", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value.strip(" -–—:;")


def classify(block: Block) -> str:
    """Pick a memory kind from the shape and vocabulary of the statement.

    Order matters: a prohibition stated as a caution is still a prohibition, and
    a numbered list of commands is a procedure even when it also expresses a
    preference. `preference` is the residue, which is what most of a CLAUDE.md is.
    """
    text = block.text
    if CONSTRAINT_RE.search(text):
        return "constraint"
    if CAVEAT_RE.search(text):
        return "caveat"
    if block.ordered or block.commands or PROCEDURE_RE.search(text):
        return "procedure"
    if DECISION_RE.search(text) and not RULE_VOICE_RE.search(text):
        return "decision"
    if PREFERENCE_RE.search(text):
        return "preference"
    return "preference"


def _conditions(headings: Sequence[str]) -> list[str]:
    """Use the heading path as retrieval context, minus the document title.

    The first H1 of a memory file names the file, not the rule underneath it, so
    it is dropped whenever a real section heading exists. At most the two
    innermost headings survive: they are indexed into FTS and they participate in
    the content hash, so a longer path would both bloat recall and stop the same
    rule mirrored in CLAUDE.md and AGENTS.md from merging.
    """
    items = [item.strip() for item in headings if item and item.strip()]
    if len(items) > 1:
        items = items[1:]
    items = [item[:120] for item in items[-2:]]
    return items


def _path_globs(block: Block) -> list[str]:
    globs: list[str] = []
    for match in GLOB_RE.findall(block.text):
        candidate = normalize_home_paths(match).strip()
        if candidate and candidate not in globs:
            globs.append(candidate)
        if len(globs) >= 5:
            break
    return globs


# ---------------------------------------------------------------- markdown scan


def parse_blocks(text: str) -> list[Block]:
    """Split markdown into statement-sized blocks under their heading path.

    One top-level bullet is one block; a nested bullet folds into its parent
    because it rarely means anything on its own. Fenced code leaves the statement
    and becomes evidence, so a rule keeps its prose and its command without the
    command drowning the sentence in the recall packet.
    """
    blocks: list[Block] = []
    stack: list[tuple[int, str]] = []
    headings: tuple[str, ...] = ()
    buf: list[str] = []
    commands: list[str] = []
    ordered = False
    fence: str | None = None
    fence_lines: list[str] = []

    def flush() -> None:
        nonlocal buf, commands, ordered
        joined = " ".join(part.strip() for part in buf if part.strip()).strip()
        if joined:
            blocks.append(
                Block(text=joined, headings=headings, commands=tuple(commands), ordered=ordered)
            )
        buf = []
        commands = []
        ordered = False

    for raw in text.splitlines():
        line = raw.rstrip()
        if fence is not None:
            if line.strip().startswith(fence):
                body = "\n".join(fence_lines).strip()
                if body:
                    commands.append(body)
                fence = None
                fence_lines = []
            else:
                fence_lines.append(line)
            continue
        fence_open = FENCE_RE.match(line)
        if fence_open:
            fence = fence_open.group(1)
            fence_lines = []
            continue
        heading = HEADING_RE.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, heading.group(2).strip()))
            headings = tuple(title for _, title in stack)
            continue
        if not line.strip() or RULE_RE.match(line) or line.lstrip().startswith("|"):
            flush()
            continue
        bullet = BULLET_RE.match(line)
        numbered = ORDERED_RE.match(line)
        if bullet or numbered:
            match = bullet or numbered
            indent = len(match.group(1))
            body = match.group(2)
            if indent <= 1:
                flush()
                ordered = numbered is not None
            buf.append(body)
            continue
        stripped = line.lstrip()
        if stripped.startswith(">"):
            stripped = stripped.lstrip(">").strip()
        buf.append(stripped)

    flush()
    return blocks


def _applies_to_repo(applies: str) -> Path | None:
    """Resolve the repository an `applies_to:` line names, or None.

    Codex sometimes writes two locations (`cwd=<repo> and ~/.codex`), so this
    takes the first that is actually a git repository on this machine rather than
    the first that merely exists — a configuration directory is not a project,
    and keying a project's rules to one would hide them from the repository they
    describe. Nothing is guessed: a line naming no local repository is skipped
    and reported, never widened to global.
    """
    match = APPLIES_CWD_RE.search(applies)
    if not match:
        return None
    raw = EXTENDED_PREFIX_RE.sub("", match.group(1))
    for part in re.split(r"\s+and\s+|,", raw):
        candidate = part.strip().strip("`\"'")
        if not candidate:
            continue
        try:
            path = expand_user_path(candidate)
        except (OSError, ValueError):
            continue
        if not path.is_dir():
            continue
        root = git_root(path)
        if root is not None:
            return root
    return None


def _codex_sections(text: str) -> list[tuple[str | None, str | None, str, list[str]]]:
    """Walk `MEMORY.md` as (task group, applies_to, section, body).

    The `applies_to:` line sits between the Task Group heading and its first
    section, and it is the only thing in the file that says which repository the
    knowledge below belongs to.
    """
    out: list[tuple[str | None, str | None, str, list[str]]] = []
    group: str | None = None
    applies: str | None = None
    section: str | None = None
    body: list[str] = []

    for raw in text.splitlines():
        line = raw.rstrip()
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            title = heading.group(2).strip()
            if level <= 2 and section is not None:
                out.append((group, applies, section, body))
                section = None
                body = []
            if level == 1:
                group, applies = title, None
            elif level == 2:
                section, body = title, []
            elif section is not None:
                body.append(line)
            continue
        if section is None:
            if line.strip().lower().startswith("applies_to:"):
                applies = line.split(":", 1)[1].strip()
            continue
        body.append(line)

    if section is not None:
        out.append((group, applies, section, body))
    return out


# ------------------------------------------------------------------- discovery


def _project_files(root: Path, project: str) -> list[SourceFile]:
    home = user_home()
    found: list[SourceFile] = []
    for name, source in (
        ("CLAUDE.md", "claude-md"),
        ("CLAUDE.local.md", "claude-md"),
        ("AGENTS.md", "codex-agents"),
    ):
        path = root / name
        if path.is_file():
            found.append(
                SourceFile(source, path, "project", project, False, display_path(path, home))
            )
    remember = root / ".remember"
    if remember.is_dir():
        core = remember / "core-memories.md"
        if core.is_file():
            found.append(
                SourceFile("remember", core, "project", project, False, display_path(core, home))
            )
        for name in ("recent.md", "archive.md"):
            path = remember / name
            if path.is_file():
                found.append(
                    SourceFile("remember", path, "project", project, True, display_path(path, home))
                )
    return found


def discover(
    *,
    home: Path | None = None,
    cwd: Path | None = None,
    scan_roots: Iterable[Path] = (),
) -> list[SourceFile]:
    """List the external memory files present on this machine.

    Project-scoped files are read from the repositories the caller names, never
    by walking the disk: which repositories matter is a question only the user
    can answer, and guessing would pull a stranger's checkout into their memory.
    """
    home = home or user_home()
    found: list[SourceFile] = []

    for relative, source in (
        (Path(".claude") / "CLAUDE.md", "claude-md"),
        (Path(".codex") / "AGENTS.md", "codex-agents"),
        (Path(".remember") / "core-memories.md", "remember"),
    ):
        path = home / relative
        if path.is_file():
            found.append(SourceFile(source, path, "global", None, False, display_path(path, home)))

    for name in ("recent.md", "archive.md"):
        path = home / ".remember" / name
        if path.is_file():
            found.append(SourceFile("remember", path, "global", None, True, display_path(path, home)))

    memories = home / ".codex" / "memories"
    for name in ("MEMORY.md", "memory_summary.md"):
        path = memories / name
        if path.is_file():
            found.append(
                SourceFile("codex-memory", path, "mixed", None, False, display_path(path, home))
            )
    raw = memories / "raw_memories.md"
    if raw.is_file():
        found.append(SourceFile("codex-memory", raw, "mixed", None, True, display_path(raw, home)))
    rollouts = memories / "rollout_summaries"
    if rollouts.is_dir():
        for path in sorted(rollouts.glob("*.md")):
            found.append(
                SourceFile("codex-memory", path, "mixed", None, True, display_path(path, home))
            )

    # Two roots inside one repository -- a worktree and its main tree, a
    # subdirectory and its parent -- resolve to the same key and must be read
    # once, or every rule in that repository arrives twice.
    seen_projects: set[str] = set()
    for candidate in ([cwd] if cwd else []) + [Path(item) for item in scan_roots]:
        resolved = resolve_cwd(str(candidate))
        if not resolved.is_dir():
            raise MemoryError(f"not a directory: {candidate}")
        project = repo_key(resolved)
        if project in seen_projects:
            continue
        seen_projects.add(project)
        found.extend(_project_files(resolved, project))

    return found


# ------------------------------------------------------------ payload assembly


def _record(
    *,
    block: Block,
    source: str,
    label: str,
    scope: str,
    project: str | None,
    heading: str,
) -> dict[str, Any] | None:
    statement = _clean_statement(normalize_home_paths(block.text))
    if len(statement) < MIN_STATEMENT_CHARS or len(statement) > MAX_STATEMENT_CHARS:
        return None
    conditions = [normalize_home_paths(item) for item in _conditions(block.headings)]
    globs = _path_globs(block)
    evidence: list[dict[str, Any]] = [
        {"kind": f"import.{source}", "summary": f"{label} § {heading}" if heading else label}
    ]
    for command in block.commands[:2]:
        evidence.append(
            {
                "kind": "command",
                "summary": f"quoted in {label}",
                "command": normalize_home_paths(command)[:2000],
            }
        )
    return {
        "schema": RECORD_SCHEMA,
        "kind": classify(block),
        "scope": scope,
        "repo_key": project if scope == "project" else None,
        "statement": statement,
        "conditions": conditions,
        "path_globs": globs,
        "state": "active",
        # Honest provenance: the user wrote these files. It changes nothing
        # unless someone later replays this payload through `import --trust`,
        # because `adopt` never trusts and the write path forces `inferred`.
        "authority": "explicit",
        "confidence": 0.6,
        "evidence": evidence,
    }


def _unsafe(record: dict[str, Any]) -> bool:
    """True when the write path would refuse this record outright.

    Checked here so a dry run reports the same numbers the real run produces;
    `import_records` only discovers it at `create_memory` time.
    """
    parts = [record["statement"], *record["conditions"], *record["path_globs"]]
    return any(redact_text(part).findings for part in parts)


def _identity(record: dict[str, Any]) -> str:
    """Mirror `service.content_digest` so one payload never carries a duplicate."""
    return "\x1f".join(
        [
            record["kind"],
            record["scope"],
            record["repo_key"] or "",
            normalize_text(record["statement"]),
            "\x1e".join(sorted(record["conditions"])),
            "\x1e".join(sorted(record["path_globs"])),
        ]
    )


def _plain_records(source: SourceFile, text: str) -> tuple[list[dict[str, Any]], list[dict]]:
    records: list[dict[str, Any]] = []
    skipped: list[dict] = []
    for block in parse_blocks(text):
        heading = block.headings[-1] if block.headings else ""
        record = _record(
            block=block,
            source=source.source,
            label=source.label,
            scope=source.scope,
            project=source.project,
            heading=heading,
        )
        if record is None:
            continue
        if _unsafe(record):
            skipped.append(
                {"statement": record["statement"][:200], "reason": "unsafe", "source": source.source}
            )
            continue
        records.append(record)
    return records, skipped


def _codex_records(source: SourceFile, text: str) -> tuple[list[dict[str, Any]], list[dict]]:
    records: list[dict[str, Any]] = []
    skipped: list[dict] = []
    for group, applies, section, body in _codex_sections(text):
        if section.strip().casefold() not in DURABLE_CODEX_SECTIONS:
            continue
        scope = "global"
        project: str | None = None
        if applies:
            target = _applies_to_repo(applies)
            if target is None:
                skipped.append(
                    {
                        "statement": f"{group or section} ({applies[:80]})",
                        "reason": "unknown-project",
                        "source": source.source,
                    }
                )
                continue
            scope = "project"
            project = repo_key(target)
        for block in parse_blocks("\n".join(body)):
            heading = f"{group} § {section}" if group else section
            record = _record(
                block=block,
                source=source.source,
                label=source.label,
                scope=scope,
                project=project,
                heading=heading,
            )
            if record is None:
                continue
            if _unsafe(record):
                skipped.append(
                    {
                        "statement": record["statement"][:200],
                        "reason": "unsafe",
                        "source": source.source,
                    }
                )
                continue
            records.append(record)
    return records, skipped


def build_payload(
    sources: Sequence[SourceFile],
    *,
    include_episodic: bool = False,
) -> dict[str, Any]:
    """Convert discovered files into one export payload plus a skip report."""
    memories: list[dict[str, Any]] = []
    skipped: list[dict] = []
    seen: set[str] = set()
    read: list[dict[str, Any]] = []

    for source in sources:
        if source.episodic and not include_episodic:
            continue
        try:
            text = source.path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise MemoryError(f"cannot read {source.label}: {exc}") from exc
        if source.source == "codex-memory" and source.path.name in {
            "MEMORY.md",
            "memory_summary.md",
        }:
            found, dropped = _codex_records(source, text)
        else:
            found, dropped = _plain_records(source, text)
        kept = 0
        for record in found:
            identity = _identity(record)
            if identity in seen:
                continue
            seen.add(identity)
            memories.append(record)
            kept += 1
        skipped.extend(dropped)
        read.append(
            {
                "source": source.source,
                "path": source.label,
                "scope": source.scope,
                "episodic": source.episodic,
                "records": kept,
            }
        )

    payload = {
        "schema": EXPORT_SCHEMA,
        "scope": "all",
        "repo_key": None,
        "repo_keys": sorted({item["repo_key"] for item in memories if item["repo_key"]}),
        "exported_at": utc_now(),
        "memories": memories,
    }
    return {"payload": payload, "skipped": skipped, "read": read, "groups": group_counts(memories)}


def group_counts(memories: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Summarize a payload the way a reviewer should be asked about it.

    One question over four groups beats forty questions over forty records, so
    the SKILL workflow renders this table and asks once.
    """
    buckets: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for record in memories:
        evidence = record.get("evidence") or [{}]
        source = str(evidence[0].get("kind", "import.unknown")).removeprefix("import.")
        key = (source, record["scope"], record["repo_key"] or "", record["kind"])
        bucket = buckets.setdefault(
            key,
            {
                "source": source,
                "scope": record["scope"],
                "repo_key": record["repo_key"],
                "kind": record["kind"],
                "count": 0,
                "examples": [],
            },
        )
        bucket["count"] += 1
        if len(bucket["examples"]) < 3:
            bucket["examples"].append(record["statement"][:120])
    return sorted(
        buckets.values(),
        key=lambda item: (item["scope"], item["repo_key"] or "", item["source"], item["kind"]),
    )


def refine_with_provider(
    provider: Any, memories: Sequence[dict[str, Any]], *, batch_size: int = 12
) -> list[dict[str, Any]]:
    """Let the configured model restate a batch the parser already delimited.

    Block boundaries stay deterministic — the model is asked to classify and
    tidy statements, never to decide what counts as one — and routing is not
    negotiable: scope, repo key and evidence are re-stamped from the batch
    afterwards, so a model that answers `scope: global` cannot move a project's
    rules into every repository on the machine.

    Any failure keeps the deterministic result. A missing or broken provider must
    cost the run nothing, because the parser alone is the supported path.
    """
    from .providers import ProviderError  # local: keeps this module import-light

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for record in memories:
        evidence = record.get("evidence") or [{}]
        source = str(evidence[0].get("kind", ""))
        grouped.setdefault((source, record["scope"], record["repo_key"] or ""), []).append(record)

    refined: list[dict[str, Any]] = []
    for (_, scope, project), records in grouped.items():
        for start in range(0, len(records), batch_size):
            chunk = records[start : start + batch_size]
            events = [
                {
                    "id": f"adopt-{index}",
                    "kind": "user_prompt",
                    "harness": "generic",
                    "prompt": " / ".join([*item["conditions"], item["statement"]]),
                }
                for index, item in enumerate(chunk)
            ]
            try:
                candidates = provider.extract(events, project)
            except ProviderError:
                candidates = []
            if not candidates:
                refined.extend(chunk)
                continue
            template = chunk[0]
            for candidate in candidates:
                statement = _clean_statement(normalize_home_paths(candidate.statement))
                if len(statement) < MIN_STATEMENT_CHARS or len(statement) > MAX_STATEMENT_CHARS:
                    continue
                record = dict(template)
                record["kind"] = candidate.kind
                record["scope"] = scope
                record["repo_key"] = project or None
                record["statement"] = statement
                record["conditions"] = [
                    normalize_home_paths(str(item)) for item in candidate.conditions
                ][:2]
                record["path_globs"] = [
                    normalize_home_paths(str(item)) for item in candidate.path_globs
                ][:5]
                if _unsafe(record):
                    continue
                refined.append(record)

    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for record in refined:
        identity = _identity(record)
        if identity in seen:
            continue
        seen.add(identity)
        output.append(record)
    return output


def select(sources: Sequence[SourceFile], wanted: Sequence[str]) -> list[SourceFile]:
    names = set(wanted or ())
    if not names or "all" in names:
        return list(sources)
    unknown = names - set(ADOPT_SOURCES)
    if unknown:
        raise MemoryError(f"unknown source: {', '.join(sorted(unknown))}")
    return [item for item in sources if item.source in names]
