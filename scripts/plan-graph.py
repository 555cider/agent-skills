#!/usr/bin/env python3
"""Check or repair the compact plan-graph YAML subset."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path


CHANGES: list[dict] = []


def record_change(verb: str, node_id: int, path: str | None = None, extra: str | None = None, silent: bool = False):
    CHANGES.append({
        "verb": verb,
        "id": node_id,
        "path": path,
        "extra": extra
    })
    if not silent:
        if verb in {"mark", "clear", "remove"}:
            print(f"CHANGE={verb} {node_id} {extra}")
        elif verb in {"dedup"}:
            print(f"CHANGE={verb} {node_id}")
        elif verb in {"add-frontmatter"}:
            print(f"CHANGE={verb} {node_id} {path}")
        elif verb in {"sync-frontmatter"}:
            print(f"CHANGE={verb} {node_id} {path} {extra}")


def acquire_lock(lock_path: Path) -> bool:
    """Atomically claim the lockfile via O_CREAT|O_EXCL so two concurrent
    --fix runs can never both believe they hold it (the old exists()->write
    sequence had a TOCTOU race). Returns True only if we created it.

    A lock older than 10s is treated as stale: removed and re-claimed once.
    A genuine I/O error (e.g. a read-only plan dir) raises OSError so the
    caller can distinguish it from live contention rather than silently
    reporting 'locked by another process'."""
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        try:
            mtime = lock_path.stat().st_mtime
        except FileNotFoundError:
            # Lock vanished between the failed create and the stat — retry once.
            return acquire_lock(lock_path)
        if time.time() - mtime < 10:
            return False  # a live lock holds it
        # Stale: drop it and re-claim atomically.
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False  # someone else won the re-claim race
    try:
        os.write(fd, str(os.getpid()).encode("utf-8"))
    finally:
        os.close(fd)
    return True


def release_lock(lock_path: Path):
    try:
        # Only remove the lock if it is still ours — never delete another
        # process's lock (e.g. if ours was overtaken as stale mid-run).
        if lock_path.exists() and lock_path.read_text(encoding="utf-8").strip() == str(os.getpid()):
            lock_path.unlink()
    except Exception:
        pass



NEXT_RE = re.compile(r"^\s*next:\s*(\d+)\s*$")
SCALAR = r'"(?:\\.|[^"])*"|.*?'
NODE_RE = re.compile(
    rf"^\s*(\d+):\s*\{{p:\s*({SCALAR}),\s*s:\s*({SCALAR})(?:,\s*x:\s*({SCALAR}))?\}}\s*$"
)
DEPS_RE = re.compile(r"^\s*(\d+):\s*\[([0-9,\s]*)\]\s*$")
VALID_X = {"done", "dropped", "missing"}


@dataclass
class Node:
    path: str
    summary: str
    x: str | None = None


def parse_scalar(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if value.startswith('"') and value.endswith('"'):
        return str(json.loads(value))
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def format_scalar(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def is_safe_path(path_str: str) -> bool:
    """A node path is safe to touch on disk only if it stays inside the root:
    non-empty, relative, and free of `..` traversal. Filesystem writes are
    gated on this so --fix never mutates a file outside the repo before
    validate() rejects the path."""
    if not path_str:
        return False
    parts = Path(path_str)
    return not parts.is_absolute() and ".." not in parts.parts


def parse_graph(path: Path):
    next_id = None
    saw_next = False
    nodes: dict[int, Node] = {}
    deps: dict[int, list[int]] = {}
    section = None

    for lineno, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "nodes:":
            section = "nodes"
            continue
        if stripped == "deps:":
            section = "deps"
            continue

        if section is None:
            match = NEXT_RE.match(line)
            if match:
                if saw_next:
                    raise ValueError(f"{lineno}: duplicate next line")
                next_id = int(match.group(1))
                saw_next = True
                continue
            raise ValueError(f"{lineno}: unsupported line: {line}")

        if section == "nodes":
            match = NODE_RE.match(line)
            if not match:
                raise ValueError(f"{lineno}: invalid node line: {line}")
            node_id = int(match.group(1))
            if node_id in nodes:
                raise ValueError(f"{lineno}: duplicate node id: {node_id}")
            nodes[node_id] = Node(
                path=parse_scalar(match.group(2)) or "",
                summary=parse_scalar(match.group(3)) or "",
                x=parse_scalar(match.group(4)),
            )
            continue

        if section == "deps":
            match = DEPS_RE.match(line)
            if not match:
                raise ValueError(f"{lineno}: invalid deps line: {line}")
            raw = match.group(2).strip()
            node_id = int(match.group(1))
            if node_id in deps:
                raise ValueError(f"{lineno}: duplicate deps key: {node_id}")
            deps[node_id] = [
                int(part.strip()) for part in raw.split(",") if part.strip()
            ]

    if next_id is None:
        raise ValueError("missing required next line")
    return next_id, nodes, deps


def write_graph(path: Path, next_id: int, nodes: dict[int, Node], deps: dict[int, list[int]]):
    target = path.resolve() if path.is_symlink() else path
    deps = {node_id: values for node_id, values in deps.items() if values}
    lines = [f"next: {next_id}", "", "nodes:"]
    for node_id in sorted(nodes):
        node = nodes[node_id]
        x = f", x: {format_scalar(node.x)}" if node.x else ""
        lines.append(
            f"  {node_id}: {{p: {format_scalar(node.path)}, s: {format_scalar(node.summary)}{x}}}"
        )
    lines.extend(["", "deps:"])
    for node_id in sorted(deps):
        values = ", ".join(str(value) for value in deps[node_id])
        lines.append(f"  {node_id}: [{values}]")
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.replace(tmp, target)
    except Exception:
        # Don't leave a half-written .tmp behind if the swap fails.
        try:
            tmp.unlink()
        except Exception:
            pass
        raise


def fix_missing_files(root: Path, nodes: dict[int, Node], deps: dict[int, list[int]], silent: bool = False):
    changed = False
    for node_id in sorted(list(nodes)):
        node = nodes[node_id]
        if not is_safe_path(node.path):
            continue  # unsafe path: leave it for validate() to reject, don't touch disk
        exists = (root / node.path).exists()
        if node.x == "missing" and exists:
            node.x = None
            record_change("clear", node_id, extra="missing", silent=silent)
            changed = True
            continue
        if node.x or exists:
            continue
        node.x = "missing"
        record_change("mark", node_id, extra="missing", silent=silent)
        changed = True

    for node_id, values in list(deps.items()):
        deduped = list(dict.fromkeys(values))
        if deduped != values:
            deps[node_id] = deduped
            record_change("dedup", node_id, silent=silent)
            changed = True
        if not deps[node_id]:
            deps.pop(node_id)
            record_change("remove", node_id, extra="empty-deps", silent=silent)
            changed = True
    return changed


def has_cycle(deps: dict[int, list[int]]) -> tuple[bool, list[int]]:
    # Iterative DFS (explicit stack) so a very long dependency chain can't blow
    # the Python recursion limit. `color` is shared across roots so already-
    # settled subtrees are not re-walked (the old `visited` memo).
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[int, int] = {}

    for root in deps:
        if color.get(root, WHITE) != WHITE:
            continue
        # Each frame is [node, next-base-index]; `path` is the live DFS path.
        stack: list[list[int]] = [[root, 0]]
        path: list[int] = [root]
        color[root] = GRAY
        while stack:
            node, i = stack[-1]
            bases = deps.get(node, [])
            if i < len(bases):
                stack[-1][1] = i + 1
                base = bases[i]
                state = color.get(base, WHITE)
                if state == GRAY:
                    start = path.index(base)
                    return True, path[start:] + [base]
                if state == WHITE:
                    color[base] = GRAY
                    stack.append([base, 0])
                    path.append(base)
            else:
                color[node] = BLACK
                stack.pop()
                path.pop()
    return False, []


FRONTMATTER_RE = re.compile(r"^---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)", re.DOTALL)


def strip_frontmatter_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(value):
        if quote == '"':
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if quote == "'":
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
            continue
        if char == "#" and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.strip()


def parse_frontmatter(content: str) -> dict[str, str]:
    match = FRONTMATTER_RE.match(content)
    if not match:
        return {}
    data = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            data[k.strip()] = strip_frontmatter_comment(v.strip())
    return data


def make_frontmatter(node_id: int, node: Node, bases: list[int]) -> str:
    lines = [
        "---",
        f"id: {node_id}",
        f"summary: {format_scalar(node.summary)}",
    ]
    if node.x:
        lines.append(f"x: {format_scalar(node.x)}")
    if bases:
        lines.append(f"deps: [{', '.join(str(b) for b in bases)}]")
    lines.extend(["---", ""])
    return "\n".join(lines)


def sync_markdown_frontmatter(
    root: Path,
    node_id: int,
    node: Node,
    bases: list[int],
    fix: bool,
    silent: bool = False,
) -> str | None:
    if not is_safe_path(node.path):
        return None  # never read/write a file outside root; validate() reports the path error
    path = root / node.path
    if not path.exists() or path.is_dir():
        return None
    try:
        # utf-8-sig read + utf-8 write intentionally normalizes away a BOM on
        # any --fix that rewrites the file; plan files are managed markdown, not
        # BOM-sensitive.
        content = path.read_text(encoding="utf-8-sig")
    except Exception as e:
        return f"failed to read {node.path}: {e}"

    match = FRONTMATTER_RE.match(content)
    expected_fm = make_frontmatter(node_id, node, bases)

    if not match:
        if fix:
            try:
                path.write_text(expected_fm + content, encoding="utf-8")
                record_change("add-frontmatter", node_id, path=node.path, silent=silent)
                return None
            except Exception as e:
                return f"failed to prepend frontmatter to {node.path}: {e}"
        else:
            return f"missing frontmatter in {node.path}"

    fm_text = match.group(0)
    body = content[len(fm_text):]
    fm_data = parse_frontmatter(content)

    fm_id = int(fm_data.get("id")) if fm_data.get("id", "").isdigit() else None
    fm_summary = parse_scalar(fm_data.get("summary")) or ""
    fm_x = parse_scalar(fm_data.get("x"))
    raw_deps = fm_data.get("deps", "").strip("[] ")
    fm_deps = (
        [int(d.strip()) for d in raw_deps.split(",") if d.strip().isdigit()]
        if raw_deps
        else []
    )

    mismatch: list[tuple[str, str]] = []
    if fm_id != node_id:
        mismatch.append(("id", f"id mismatch ({fm_id} != {node_id})"))
    if fm_summary != node.summary:
        mismatch.append(("summary", "summary mismatch"))
    if fm_x != node.x:
        mismatch.append(("x", f"x mismatch ({fm_x} != {node.x})"))
    if fm_deps != bases:
        mismatch.append(("deps", "deps mismatch"))

    if mismatch:
        if fix:
            try:
                path.write_text(expected_fm + body, encoding="utf-8")
                details = ",".join(field for field, _ in mismatch)
                record_change("sync-frontmatter", node_id, path=node.path, extra=details, silent=silent)
                return None
            except Exception as e:
                return f"failed to update frontmatter in {node.path}: {e}"
        else:
            details = ", ".join(message for _, message in mismatch)
            return f"frontmatter mismatch in {node.path}: {details}"
    return None


def get_roadmap_and_critical_path(
    nodes: dict[int, Node],
    deps: dict[int, list[int]],
) -> tuple[list[int], list[int], list[int]]:
    active = {n_id for n_id, n in nodes.items() if n.x is None}

    adj: dict[int, set[int]] = {n_id: set() for n_id in active}
    in_degree = {n_id: 0 for n_id in active}

    for dep, bases in deps.items():
        if dep not in active:
            continue
        for base in dict.fromkeys(bases):  # dedup: a repeated base must not inflate in-degree
            if base in active:
                adj[base].add(dep)
                in_degree[dep] += 1

    queue = sorted([n_id for n_id in active if in_degree[n_id] == 0])
    roadmap: list[int] = []

    while queue:
        u = queue.pop(0)
        roadmap.append(u)
        for v in sorted(adj[u]):
            in_degree[v] -= 1
            if in_degree[v] == 0:
                queue.append(v)
                queue.sort()

    excluded = sorted(active - set(roadmap))
    path_active = set(roadmap)
    memo_depth: dict[int, int] = {}
    memo_next: dict[int, int | None] = {}

    def compute_longest(start: int) -> None:
        # Iterative post-order over the active DAG so a deep chain can't recurse
        # past the stack limit. path_active is acyclic (cycle nodes are excluded
        # from the roadmap), but `on_stack` still guards against re-expansion.
        stack: list[tuple[int, bool]] = [(start, False)]
        on_stack: set[int] = set()
        while stack:
            u, processed = stack.pop()
            if u in memo_depth:
                continue
            if not processed:
                if u in on_stack:
                    memo_depth[u] = 0  # defensive: only reachable via an unexpected cycle
                    memo_next[u] = None
                    continue
                on_stack.add(u)
                stack.append((u, True))
                for v in deps.get(u, []):
                    if v in path_active and v not in memo_depth:
                        stack.append((v, False))
            else:
                on_stack.discard(u)
                max_d = 0
                best_next = None
                for v in deps.get(u, []):
                    if v in path_active:
                        d = memo_depth.get(v, 0)
                        if d > max_d:
                            max_d = d
                            best_next = v
                memo_depth[u] = 1 + max_d
                memo_next[u] = best_next

    for u in sorted(path_active):
        compute_longest(u)

    critical_path: list[int] = []
    if path_active:
        start_node = max(
            sorted(path_active),
            key=lambda x: memo_depth.get(x, 0),
            default=None,
        )
        if start_node is not None and memo_depth.get(start_node, 0) > 1:
            curr = start_node
            while curr is not None:
                critical_path.append(curr)
                curr = memo_next.get(curr)
            critical_path.reverse()

    return roadmap, critical_path, excluded


def validate(root: Path, next_id: int, nodes: dict[int, Node], deps: dict[int, list[int]], silent: bool = False):
    errors: list[str] = []
    warning_messages: list[str] = []

    for node_id, node in sorted(nodes.items()):
        if node.x != "missing":
            bases = deps.get(node_id, [])
            err = sync_markdown_frontmatter(root, node_id, node, bases, fix=False, silent=silent)
            if err:
                if err.startswith("missing frontmatter in "):
                    warning_messages.append(err)
                else:
                    errors.append(err)

    seen_paths: dict[str, int] = {}
    max_id = max(nodes.keys(), default=0)
    if next_id <= max_id:
        errors.append(f"next must be greater than max node id: next={next_id} max={max_id}")
    for node_id, node in sorted(nodes.items()):
        if node.x and node.x not in VALID_X:
            errors.append(f"{node_id} has invalid x={node.x}")
        node_path = Path(node.path)
        invalid_path = False
        if not node.path:
            errors.append(f"{node_id} has empty path")
            invalid_path = True
        elif node_path.is_absolute():
            errors.append(f"{node_id} has absolute path: {node.path}")
            invalid_path = True
        elif ".." in node_path.parts:
            errors.append(f"{node_id} path escapes root: {node.path}")
            invalid_path = True
        if not invalid_path:
            if node.path in seen_paths:
                # Keep the first id as the cited original so a 3rd duplicate
                # still names the earliest offender, not the previous one.
                errors.append(f"duplicate node path: {seen_paths[node.path]} and {node_id} use {node.path}")
            else:
                seen_paths[node.path] = node_id
        if not invalid_path and not node.x and not (root / node.path).exists():
            errors.append(f"{node_id} missing file: {node.path}")
    for dependent, bases in sorted(deps.items()):
        if dependent not in nodes:
            errors.append(f"deps key missing from nodes: {dependent}")
        if not bases:
            errors.append(f"empty deps entry: {dependent}")
        if len(bases) != len(set(bases)):
            errors.append(f"duplicate deps for {dependent}")
        for base in bases:
            if dependent == base:
                errors.append(f"self dependency: {dependent}")
            if base not in nodes:
                errors.append(f"dangling dep: {dependent}->{base}")
            elif nodes[base].x in {"dropped", "missing"}:
                errors.append(f"active dependency on non-active base: {dependent}->{base} x={nodes[base].x}")
    cyclic, cycle = has_cycle(deps)
    if cyclic:
        errors.append(f"cycle detected: {' -> '.join(str(part) for part in cycle)}")
    return errors, warning_messages


def warnings(nodes: dict[int, Node], deps: dict[int, list[int]]) -> list[str]:
    active_done_bases = {
        base
        for dependent, bases in deps.items()
        if dependent in nodes and nodes[dependent].x is None
        for base in bases
        if base in nodes and nodes[base].x == "done"
    }
    done_without_active_dependents = [
        f"{node_id} is done with no active dependent; prune unless removal is blocked"
        for node_id, node in sorted(nodes.items())
        if node.x == "done" and node_id not in active_done_bases
    ]
    return done_without_active_dependents + [
        f"{node_id} file is missing"
        for node_id, node in sorted(nodes.items())
        if node.x == "missing"
    ]


def significant_words(value: str) -> set[str]:
    return {
        part
        for part in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", value.lower())
        if part not in {"the", "and", "for", "with", "plan", "this", "that"}
    }


def suggest_deps(
    root: Path,
    nodes: dict[int, Node],
    deps: dict[int, list[int]],
) -> list[dict[str, object]]:
    suggestions: list[dict[str, object]] = []
    existing = {(dependent, base) for dependent, bases in deps.items() for base in bases}

    for dependent_id, dependent in sorted(nodes.items()):
        if dependent.x is not None or not is_safe_path(dependent.path):
            continue
        dependent_path = root / dependent.path
        if not dependent_path.exists() or dependent_path.is_dir():
            continue
        try:
            content = dependent_path.read_text(encoding="utf-8-sig", errors="replace")
        except Exception:
            continue
        lowered = content.lower()

        for base_id, base in sorted(nodes.items()):
            if base_id == dependent_id or base.x in {"dropped", "missing"}:
                continue
            if (dependent_id, base_id) in existing:
                continue
            confidence = ""
            reason = ""
            base_path = base.path.lower()
            base_name = Path(base.path).name.lower()
            if base_path and base_path in lowered:
                confidence = "EXTRACTED"
                reason = f"path reference {base.path}"
            elif base_name and base_name in lowered:
                confidence = "EXTRACTED"
                reason = f"filename reference {Path(base.path).name}"
            elif base.summary and base.summary.lower() in lowered:
                confidence = "EXTRACTED"
                reason = f"summary reference {base.summary}"
            else:
                base_words = significant_words(base.summary)
                dep_words = significant_words(content)
                overlap = sorted(base_words & dep_words)
                if (
                    len(overlap) >= 2
                    and re.search(r"\b(depends?|before|after|blocks?|requires?)\b", lowered)
                ):
                    confidence = "INFERRED"
                    reason = "keyword overlap " + ",".join(overlap[:4])
            if confidence:
                suggestions.append({
                    "dependent": dependent_id,
                    "base": base_id,
                    "confidence": confidence,
                    "reason": reason,
                })
    return suggestions


def render_tree(nodes: dict[int, Node], deps: dict[int, list[int]]) -> list[str]:
    if not nodes:
        return ["(empty plan graph)"]

    bases_used: set[int] = set()
    for bases in deps.values():
        bases_used.update(bases)
    roots = sorted(node_id for node_id in nodes if node_id not in bases_used)
    if not roots:
        roots = sorted(nodes)

    lines: list[str] = []
    shown: set[int] = set()

    def label(node_id: int, repeated: bool) -> str:
        node = nodes.get(node_id)
        if node is None:
            return f"[{node_id}] <missing from nodes>"
        state = f" ({node.x})" if node.x else ""
        repeat = " ↑" if repeated else ""
        return f"[{node_id}] {node.summary}{state}{repeat}"

    def walk(root_id: int) -> None:
        # Iterative pre-order DFS: children are pushed in reverse so they pop
        # left-to-right, reproducing the recursive line order without a call
        # stack that a deep tree could overflow.
        work: list[tuple[int, str, str]] = [(root_id, "", "")]
        while work:
            node_id, prefix, connector = work.pop()
            repeated = node_id in shown
            lines.append(f"{prefix}{connector}{label(node_id, repeated)}")
            if repeated or node_id not in nodes:
                continue
            shown.add(node_id)
            children = sorted(set(deps.get(node_id, [])))
            if connector == "":
                extension = ""
            elif connector.startswith("└"):
                extension = "    "
            else:
                extension = "│   "
            frames: list[tuple[int, str, str]] = []
            for index, child_id in enumerate(children):
                last = index == len(children) - 1
                child_connector = "└── " if last else "├── "
                frames.append((child_id, prefix + extension, child_connector))
            work.extend(reversed(frames))

    for index, root_id in enumerate(roots):
        if root_id in shown:
            continue
        if index > 0:
            lines.append("")
        walk(root_id)
    for node_id in sorted(node_id for node_id in nodes if node_id not in shown):
        if node_id in shown:
            continue  # a node pulled in by walking an earlier component must not reprint
        if lines:
            lines.append("")
        walk(node_id)
    return lines


def default_root(graph: Path) -> Path:
    try:
        result = subprocess.run(
            ["git", "-C", str(graph.parent), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return Path(result.stdout.strip())
    except Exception:
        pass
    parts = graph.parts
    if len(parts) >= 4 and parts[-3:] == (".agents", "plan", "graph.yaml"):
        return graph.parents[2]
    return Path.cwd()


def main(argv: list[str]) -> int:
    CHANGES.clear()  # reset the module-level accumulator so repeated in-process calls don't report stale changes
    # The tree renderer prints box-drawing (└──) and arrows (➔); force UTF-8 so a
    # non-UTF-8 console (e.g. Windows cp1252) degrades gracefully instead of
    # dying with UnicodeEncodeError.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(
        description="Check or repair a compact plan-graph YAML index (.agents/plan/graph.yaml).",
        epilog=(
            "modes (precedence: --show > --suggest-deps > --fix):\n"
            "  (default)       validate; exit 0 valid, 1 errors, 2 unparseable\n"
            "  --fix           persist drift repairs, then validate (writes files; takes a lock)\n"
            "  --show          print the plan tree + roadmap (read-only)\n"
            "  --suggest-deps  print read-only dependency candidates\n"
            "add --json to any mode for a single machine-readable object.\n"
            "examples:\n"
            "  plan-graph.py .agents/plan/graph.yaml\n"
            "  plan-graph.py .agents/plan/graph.yaml --fix\n"
            "  plan-graph.py .agents/plan/graph.yaml --show --json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("graph", type=Path)
    parser.add_argument("--fix", action="store_true", help="repair missing-file graph drift (writes files)")
    parser.add_argument("--show", action="store_true", help="print the plan tree and exit (read-only)")
    parser.add_argument(
        "--suggest-deps",
        action="store_true",
        help="print read-only dependency suggestions and exit",
    )
    parser.add_argument("--root", type=Path, default=None, help="repo root for plan paths")
    parser.add_argument("--json", action="store_true", help="output result in JSON format")
    args = parser.parse_args(argv)
    graph = args.graph
    root = (args.root.resolve() if args.root else default_root(graph.resolve()).resolve())

    if not graph.exists():
        if args.fix and not args.suggest_deps and not args.show:
            graph.parent.mkdir(parents=True, exist_ok=True)
            write_graph(graph, 1, {}, {})
        else:
            err_msg = f"graph file does not exist: {graph}. Run with --fix to initialize."
            if args.json:
                print(json.dumps({"status": "ERROR", "errors": [err_msg], "warnings": [], "changes": []}, ensure_ascii=False, indent=2))
            else:
                print(f"ERROR={err_msg}", file=sys.stderr)
                print("FAIL plan graph", file=sys.stderr)
            return 1

    lock_path = graph.with_name(graph.name + ".lock")
    lock_acquired = False
    if args.fix and not args.show and not args.suggest_deps:
        # Only write-capable fix mode locks; read-only modes take precedence.
        lock_error: str | None = None
        for _ in range(3):
            try:
                if acquire_lock(lock_path):
                    lock_acquired = True
                    break
            except OSError as exc:
                lock_error = f"cannot create lockfile {lock_path}: {exc}"
                break
            time.sleep(1)
        if not lock_acquired:
            err_msg = lock_error or f"graph locked by another process (lockfile: {lock_path})"
            if args.json:
                print(json.dumps({"status": "ERROR", "errors": [err_msg], "warnings": [], "changes": []}, ensure_ascii=False, indent=2))
            else:
                print(f"ERROR={err_msg}", file=sys.stderr)
                print("FAIL plan graph", file=sys.stderr)
            return 1

    try:
        next_id, nodes, deps = parse_graph(graph)
    except Exception as exc:
        err_msg = f"parse: {exc}"
        if args.json:
            print(json.dumps({"status": "ERROR", "errors": [err_msg], "warnings": [], "changes": []}, ensure_ascii=False, indent=2))
        else:
            print(f"ERROR={err_msg}", file=sys.stderr)
        if args.fix and lock_acquired:
            release_lock(lock_path)
        return 2

    if args.show:
        roadmap, critical_path, excluded = get_roadmap_and_critical_path(nodes, deps)
        tree_lines = render_tree(nodes, deps)
        if args.json:
            json_out = {
                "status": "OK",
                "tree": tree_lines,
                "roadmap": [{"id": r_id, "summary": nodes[r_id].summary} for r_id in roadmap],
                "excluded": [{"id": r_id, "summary": nodes[r_id].summary} for r_id in excluded],
                "critical_path": critical_path,
                "changes": [],
                "errors": [],
                "warnings": []
            }
            print(json.dumps(json_out, ensure_ascii=False, indent=2))
        else:
            for line in tree_lines:
                print(line)
            if roadmap or excluded:
                print("\nSuggested Implementation Roadmap (Active Plans):")
                for idx, r_id in enumerate(roadmap, 1):
                    print(f"  {idx}. [{r_id}] {nodes[r_id].summary}")
                for r_id in excluded:
                    print(f"  - [{r_id}] {nodes[r_id].summary} (cycle, excluded from roadmap)")
            if critical_path:
                path_str = " ➔ ".join(f"[{node_id}]" for node_id in critical_path)
                print(f"\nCritical Path (Longest unresolved chain):\n  {path_str}")
        if args.fix and lock_acquired:
            release_lock(lock_path)
        return 0

    if args.suggest_deps:
        suggestions = suggest_deps(root, nodes, deps)
        if args.json:
            print(json.dumps({
                "status": "OK",
                "suggestions": suggestions,
                "changes": [],
                "errors": [],
                "warnings": [],
            }, ensure_ascii=False, indent=2))
        else:
            for item in suggestions:
                print(
                    f"SUGGEST={item['dependent']}->{item['base']} "
                    f"{item['confidence']} {item['reason']}"
                )
            if not suggestions:
                print("OK no dependency suggestions")
        return 0

    changed = False
    fix_errors: list[str] = []
    if args.fix:
        try:
            changed = fix_missing_files(root, nodes, deps, silent=args.json)
            for node_id, node in sorted(nodes.items()):
                if node.x != "missing":
                    bases = deps.get(node_id, [])
                    err = sync_markdown_frontmatter(root, node_id, node, bases, fix=True, silent=args.json)
                    if err:
                        fix_errors.append(err)
            if changed:
                try:
                    write_graph(graph, next_id, nodes, deps)
                except Exception as exc:
                    fix_errors.append(f"failed to write graph: {exc}")
        finally:
            if lock_acquired:
                release_lock(lock_path)

    errors, frontmatter_warnings = validate(root, next_id, nodes, deps, silent=args.json)
    errors = fix_errors + errors
    all_warnings = frontmatter_warnings + warnings(nodes, deps)

    if args.json:
        json_out = {
            "status": "OK" if not errors else "FAIL",
            "changes": CHANGES,
            "errors": errors,
            "warnings": all_warnings
        }
        print(json.dumps(json_out, ensure_ascii=False, indent=2))
    else:
        for error in errors:
            print(f"ERROR={error}", file=sys.stderr)
        for warning in all_warnings:
            print(f"WARN={warning}", file=sys.stderr)
        if errors:
            print("FAIL plan graph", file=sys.stderr)
        else:
            print("OK plan graph")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
