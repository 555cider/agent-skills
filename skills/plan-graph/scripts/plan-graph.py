#!/usr/bin/env python3
"""Check or repair the compact plan-graph YAML subset."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


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


def parse_graph(path: Path):
    next_id = None
    saw_next = False
    nodes: dict[int, Node] = {}
    deps: dict[int, list[int]] = {}
    section = None

    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
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
    os.replace(tmp, target)


def fix_missing_files(root: Path, nodes: dict[int, Node], deps: dict[int, list[int]]):
    changed = False
    for node_id in sorted(list(nodes)):
        node = nodes[node_id]
        exists = (root / node.path).exists()
        if node.x == "missing" and exists:
            node.x = None
            print(f"CHANGE=clear {node_id} missing")
            changed = True
            continue
        if node.x or exists:
            continue
        node.x = "missing"
        print(f"CHANGE=mark {node_id} missing")
        changed = True

    for node_id, values in list(deps.items()):
        deduped = list(dict.fromkeys(values))
        if deduped != values:
            deps[node_id] = deduped
            print(f"CHANGE=dedup {node_id}")
            changed = True
        if not deps[node_id]:
            deps.pop(node_id)
            print(f"CHANGE=remove {node_id} empty-deps")
            changed = True
    return changed


def has_cycle(deps: dict[int, list[int]]) -> tuple[bool, list[int]]:
    visiting: set[int] = set()
    visited: set[int] = set()
    stack: list[int] = []

    def visit(node_id: int) -> bool:
        if node_id in visiting:
            start = stack.index(node_id)
            stack[:] = stack[start:] + [node_id]
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        stack.append(node_id)
        for base_id in deps.get(node_id, []):
            if visit(base_id):
                return True
        visiting.remove(node_id)
        visited.add(node_id)
        stack.pop()
        return False

    for node_id in deps:
        stack.clear()
        if visit(node_id):
            return True, stack
    return False, []


def validate(root: Path, next_id: int, nodes: dict[int, Node], deps: dict[int, list[int]]):
    errors: list[str] = []
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
        if not invalid_path and node.path in seen_paths:
            errors.append(f"duplicate node path: {seen_paths[node.path]} and {node_id} use {node.path}")
        if not invalid_path:
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
    return errors


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

    def walk(node_id: int, prefix: str, connector: str) -> None:
        repeated = node_id in shown
        lines.append(f"{prefix}{connector}{label(node_id, repeated)}")
        if repeated or node_id not in nodes:
            return
        shown.add(node_id)
        children = sorted(deps.get(node_id, []))
        for index, child_id in enumerate(children):
            last = index == len(children) - 1
            child_connector = "└── " if last else "├── "
            if connector == "":
                extension = ""
            elif connector.startswith("└"):
                extension = "    "
            else:
                extension = "│   "
            walk(child_id, prefix + extension, child_connector)

    for index, root_id in enumerate(roots):
        if index > 0:
            lines.append("")
        walk(root_id, "", "")
    return lines


def default_root(graph: Path) -> Path:
    try:
        result = subprocess.run(
            ["git", "-C", str(graph.parent), "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip())
    except Exception:
        pass
    parts = graph.parts
    if len(parts) >= 4 and parts[-3:] == (".agents", "plan", "graph.yaml"):
        return graph.parents[2]
    return Path.cwd()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Check or fix a plan graph.")
    parser.add_argument("graph", type=Path)
    parser.add_argument("--fix", action="store_true", help="repair missing-file graph drift")
    parser.add_argument("--show", action="store_true", help="print the plan tree and exit")
    parser.add_argument("--root", type=Path, default=None, help="repo root for plan paths")
    args = parser.parse_args(argv)
    graph = args.graph
    root = (args.root.resolve() if args.root else default_root(graph.resolve()).resolve())

    if not graph.exists() and args.fix:
        graph.parent.mkdir(parents=True, exist_ok=True)
        write_graph(graph, 1, {}, {})

    try:
        next_id, nodes, deps = parse_graph(graph)
    except Exception as exc:
        print(f"ERROR=parse: {exc}", file=sys.stderr)
        return 2

    if args.show:
        for line in render_tree(nodes, deps):
            print(line)
        return 0

    changed = False
    if args.fix:
        changed = fix_missing_files(root, nodes, deps)
        if changed:
            write_graph(graph, next_id, nodes, deps)

    errors = validate(root, next_id, nodes, deps)
    for error in errors:
        print(f"ERROR={error}", file=sys.stderr)
    for warning in warnings(nodes, deps):
        print(f"WARN={warning}", file=sys.stderr)

    if errors:
        print("FAIL plan graph", file=sys.stderr)
        return 1

    print("OK plan graph")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
