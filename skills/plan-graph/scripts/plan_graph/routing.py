from __future__ import annotations

import heapq
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from .model import Plan, recover_command, scope_matches, unexpanded
from .store import (
    active_children,
    ancestors,
    children_index,
    descendants,
    required_closure,
    retained_closure,
    reverse_dependents,
)


STOP_WORDS = {
    "and",
    "for",
    "from",
    "plan",
    "that",
    "the",
    "this",
    "with",
    "계획",
    "관련",
    "대한",
    "위한",
}


def tokens(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[^\W_]{2,}", value.casefold(), flags=re.UNICODE)
        if token not in STOP_WORDS
    }


def topological_order(
    plans: dict[str, Plan],
    subset: Iterable[str] | None = None,
    bases_of: dict[str, tuple[str, ...]] | None = None,
) -> list[str]:
    """Prerequisites first; `bases_of` overrides each plan's `requires` as its bases."""
    allowed = set(plans) if subset is None else set(subset)
    indegree = {plan_id: 0 for plan_id in allowed}
    dependents: dict[str, set[str]] = {plan_id: set() for plan_id in allowed}
    for dependent in allowed:
        bases = plans[dependent].requires if bases_of is None else bases_of[dependent]
        for base in bases:
            if base in allowed:
                indegree[dependent] += 1
                dependents[base].add(dependent)
    queue = [plan_id for plan_id, degree in indegree.items() if degree == 0]
    heapq.heapify(queue)
    ordered: list[str] = []
    while queue:
        plan_id = heapq.heappop(queue)
        ordered.append(plan_id)
        for dependent in sorted(dependents[plan_id]):
            indegree[dependent] -= 1
            if indegree[dependent] == 0:
                heapq.heappush(queue, dependent)
    return ordered + sorted(allowed - set(ordered))


def blockers(plans: dict[str, Plan], plan_id: str) -> list[str]:
    return sorted(
        base
        for base in required_closure(plans, [plan_id])
        if plans[base].status == "active"
    )


def readiness(plans: dict[str, Plan], plan_id: str) -> str:
    plan = plans[plan_id]
    if plan.status == "done":
        return "done"
    # Active children are implicit prerequisites: a parent is done when its pieces are.
    if blockers(plans, plan_id) or active_children(plans, plan_id):
        return "waiting"
    return "ready"


def _excerpt(value: str, limit: int = 1200) -> str:
    compact = value.strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def _query_score(plan: Plan, query: str) -> tuple[int, bool, list[str]]:
    query_folded = query.casefold().strip()
    query_tokens = tokens(query)
    if not query_tokens and not query_folded:
        return 0, False, []
    score = 0
    strong = False
    reasons: list[str] = []
    title_folded = plan.title.casefold()
    if query_folded and query_folded in title_folded:
        score += 50
        strong = True
        reasons.append("query:title-phrase")
    title_overlap = query_tokens & tokens(plan.title)
    if title_overlap:
        score += 10 * len(title_overlap)
        strong = True
        reasons.append("query:title=" + ",".join(sorted(title_overlap)))
    tag_overlap: set[str] = set()
    for tag in plan.tags:
        tag_tokens = tokens(tag)
        if query_folded and query_folded == tag.casefold():
            score += 20
            strong = True
            tag_overlap.add(tag.casefold())
        overlap = query_tokens & tag_tokens
        if overlap:
            score += 8 * len(overlap)
            strong = True
            tag_overlap.update(overlap)
    if tag_overlap:
        reasons.append("query:tags=" + ",".join(sorted(tag_overlap)))
    scope_words = tokens(" ".join(plan.scope).replace("/", " ").replace("*", " "))
    scope_overlap = query_tokens & scope_words
    if scope_overlap:
        score += 4 * len(scope_overlap)
        strong = True
        reasons.append("query:scope=" + ",".join(sorted(scope_overlap)))
    body_words = tokens(plan.sections.get("Outcome", "") + " " + plan.sections.get("Decisions", ""))
    body_overlap = query_tokens & body_words
    if body_overlap:
        score += len(body_overlap)
        reasons.append("query:body=" + ",".join(sorted(body_overlap)))
    qualifies = strong or len(body_overlap) >= 2
    return score, qualifies, reasons


def _plan_item(
    root: Path,
    plans: dict[str, Plan],
    plan_id: str,
    *,
    role: str,
    matches: list[str] | None = None,
    include_sections: bool,
) -> dict[str, object]:
    plan = plans[plan_id]
    item: dict[str, object] = {
        "id": plan.id,
        "path": plan.path.relative_to(root).as_posix(),
        "title": plan.title,
        "role": role,
        "status": plan.status,
        "kind": plan.kind,
        "readiness": readiness(plans, plan_id),
        "blockers": blockers(plans, plan_id),
        "active_children": active_children(plans, plan_id),
        "parent": plan.parent,
        "requires": list(plan.requires),
        "replaces": list(plan.replaces),
        "scope": list(plan.scope),
        "tags": list(plan.tags),
    }
    if plan.is_loose:
        item["status_line"] = plan.status_line
    if matches:
        item["matched_by"] = matches
    if plan.replaces:
        item["lineage"] = [
            {
                "replaced": old,
                "recover": recover_command(root, plan, old),
            }
            for old in plan.replaces
        ]
    if include_sections:
        item["outcome"] = _excerpt(plan.sections.get("Outcome", ""))
        item["decisions"] = _excerpt(plan.sections.get("Decisions", ""))
        item["acceptance"] = _excerpt(plan.sections.get("Acceptance", ""))
    return item


OVERLAP_SAMPLE_REASONS = 3


def build_context(
    root: Path,
    plans: dict[str, Plan],
    *,
    explicit_plans: Iterable[str] = (),
    paths: Iterable[str] = (),
    query: str = "",
    index: dict[str, set[str]] | None = None,
) -> dict[str, object]:
    match_reasons: dict[str, list[str]] = defaultdict(list)
    selected: set[str] = set()
    explicit = list(dict.fromkeys(explicit_plans))
    route_paths: list[str] = []
    for raw_path in paths:
        path = raw_path.replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        if path not in route_paths:
            route_paths.append(path)

    for plan_id in explicit:
        if plan_id in plans:
            selected.add(plan_id)
            match_reasons[plan_id].append("explicit:plan")
    plan_files = {}
    for plan_id, plan in plans.items():
        try:
            plan_files[plan.path.relative_to(root).as_posix()] = plan_id
        except ValueError:
            continue
    for path in route_paths:
        plan_file_id = plan_files.get(path)
        if plan_file_id is not None:
            selected.add(plan_file_id)
            match_reasons[plan_file_id].append("path:plan-file")
        for plan_id, plan in plans.items():
            matching = [pattern for pattern in plan.scope if scope_matches(pattern, path)]
            if matching:
                selected.add(plan_id)
                for pattern in matching:
                    match_reasons[plan_id].append(f"path:{path}~{pattern}")

    query_candidates: list[tuple[int, str, list[str]]] = []
    scored_out: list[tuple[int, str, list[str]]] = []
    if query.strip():
        for plan_id, plan in plans.items():
            score, qualifies, reasons = _query_score(plan, query)
            if score <= 0:
                continue
            if qualifies:
                query_candidates.append((score, plan_id, reasons))
            else:
                scored_out.append((score, plan_id, reasons))
        query_candidates.sort(key=lambda item: (-item[0], item[1]))
        for score, plan_id, reasons in query_candidates[:3]:
            selected.add(plan_id)
            match_reasons[plan_id].extend([*reasons, f"query:score={score}"])
        scored_out.extend(query_candidates[3:])
    near_misses = [
        {"id": plan_id, "score": score, "reasons": reasons}
        for score, plan_id, reasons in sorted(
            scored_out, key=lambda item: (-item[0], item[1])
        )[:3]
        if plan_id not in selected
    ]

    # The chain above each selected plan is read first, root first: a child plan is a
    # piece of its parent and is understood through it.
    ancestor_order: list[str] = []
    for plan_id in topological_order(plans, selected):
        for ancestor in ancestors(plans, plan_id):
            if ancestor not in ancestor_order:
                ancestor_order.append(ancestor)
    ancestor_set = set(ancestor_order) - selected
    required = required_closure(plans, selected) - selected - ancestor_set
    affected = (
        reverse_dependents(plans, selected, active_only=True) - selected - required - ancestor_set
    )
    included = selected | required | affected | ancestor_set
    overlapping: set[str] = set()
    if index and selected:
        selected_files: set[str] = set()
        graph_files: set[str] = set()
        for plan_id in selected:
            selected_files |= index.get(plan_id, set())
            if not plans[plan_id].is_loose:
                graph_files |= index.get(plan_id, set())
        # A parent's scope covers its pieces on purpose (see advice._in_line).
        in_line: set[str] = set()
        for plan_id in selected:
            in_line |= set(ancestors(plans, plan_id)) | descendants(plans, plan_id)
        for plan_id, files in index.items():
            if plan_id in included or plan_id in in_line:
                continue
            # Two loose documents never overlap: see advice.scope_overlaps.
            shared = files & (graph_files if plans[plan_id].is_loose else selected_files)
            if shared:
                overlapping.add(plan_id)
                for sample in sorted(shared)[:OVERLAP_SAMPLE_REASONS]:
                    match_reasons[plan_id].append(f"overlap:{sample}")
    order = [plan_id for plan_id in ancestor_order if plan_id in included]
    order += [plan_id for plan_id in topological_order(plans, included) if plan_id not in order]
    overlap_order = sorted(overlapping)
    role_order = {
        "ancestors": [plan_id for plan_id in ancestor_order if plan_id in ancestor_set],
        "required": [plan_id for plan_id in order if plan_id in required],
        "selected": [plan_id for plan_id in order if plan_id in selected],
        "affected": [plan_id for plan_id in order if plan_id in affected],
        "overlapping": overlap_order,
    }
    decision_pack = [
        _plan_item(
            root,
            plans,
            plan_id,
            role=(
                "selected"
                if plan_id in selected
                else "ancestor"
                if plan_id in ancestor_set
                else "required"
                if plan_id in required
                else "affected"
            ),
            matches=match_reasons.get(plan_id),
            include_sections=True,
        )
        for plan_id in order
    ]
    decision_pack.extend(
        _plan_item(
            root,
            plans,
            plan_id,
            role="overlapping",
            matches=match_reasons.get(plan_id),
            include_sections=False,
        )
        for plan_id in overlap_order
    )

    candidates: list[dict[str, object]] = []
    if not selected:
        active_order = topological_order(
            plans, [plan_id for plan_id, plan in plans.items() if plan.status == "active"]
        )
        candidate_ids = [plan_id for plan_id in active_order if readiness(plans, plan_id) == "ready"]
        if not candidate_ids:
            candidate_ids = active_order
        candidates = [
            _plan_item(root, plans, plan_id, role="candidate", include_sections=False)
            for plan_id in candidate_ids
        ]

    return {
        "selectors": {
            "plans": explicit,
            "paths": route_paths,
            "query": query,
        },
        "selected": role_order["selected"],
        "ancestors": role_order["ancestors"],
        "required": role_order["required"],
        "affected": role_order["affected"],
        "overlapping": role_order["overlapping"],
        "read_order": order,
        "decision_pack": decision_pack,
        "candidates": candidates,
        "near_misses": near_misses,
    }


def critical_path(plans: dict[str, Plan]) -> list[str]:
    # A parent waits for its children as for its prerequisites; a done child still
    # passes on the depth of an active piece below it.
    children = children_index(plans)
    bases_of = {
        plan_id: (*plan.requires, *(c for c in children.get(plan_id, ()) if c in plans))
        for plan_id, plan in plans.items()
    }
    order = topological_order(plans, bases_of=bases_of)
    depth: dict[str, int] = {}
    tail: dict[str, str | None] = {}
    previous: dict[str, str | None] = {}
    for plan_id in order:
        bases = [base for base in bases_of[plan_id] if base in depth]
        best = (
            min(
                bases,
                key=lambda base: (-depth[base], tail[base] or "", base),
            )
            if bases
            else None
        )
        inherited_depth = depth[best] if best is not None else 0
        inherited_tail = tail[best] if best is not None else None
        if plans[plan_id].status == "active":
            depth[plan_id] = inherited_depth + 1
            tail[plan_id] = plan_id
            previous[plan_id] = inherited_tail
        else:
            depth[plan_id] = inherited_depth
            tail[plan_id] = inherited_tail
    active = [plan_id for plan_id in order if plans[plan_id].status == "active"]
    if not active:
        return []
    end = min(active, key=lambda plan_id: (-depth[plan_id], plan_id))
    if depth[end] < 2:
        return []
    path: list[str] = []
    current: str | None = end
    while current is not None:
        path.append(current)
        current = previous[current]
    path.reverse()
    return path


def build_status(root: Path, plans: dict[str, Plan]) -> dict[str, object]:
    ordered = topological_order(plans)
    ready = [plan_id for plan_id in ordered if readiness(plans, plan_id) == "ready"]
    waiting = [plan_id for plan_id in ordered if readiness(plans, plan_id) == "waiting"]
    retained = retained_closure(plans)
    retained_done = [
        plan_id
        for plan_id in ordered
        if plans[plan_id].status == "done" and plan_id in retained
    ]
    return {
        "ready": [
            _plan_item(root, plans, plan_id, role="ready", include_sections=False)
            for plan_id in ready
        ],
        "waiting": [
            _plan_item(root, plans, plan_id, role="waiting", include_sections=False)
            for plan_id in waiting
        ],
        "retained_done": [
            _plan_item(root, plans, plan_id, role="retained", include_sections=False)
            for plan_id in retained_done
        ],
        "critical_path": critical_path(plans),
        "edges": [
            {"from": plan_id, "to": base, "kind": "requires"}
            for plan_id in ordered
            for base in plans[plan_id].requires
            if base in plans
        ],
    }


def build_tree(plans: dict[str, Plan], top: str | None = None) -> dict[str, object]:
    """Plans as a parent/child forest, flattened in display order with a depth each.

    Siblings follow `requires` order. A plan whose parent is missing, or that sits on a
    parent cycle, is listed after the roots with `detached` set, so a broken link is
    visible instead of silently dropped. With `top`, only that plan's subtree is listed.
    """
    order = {plan_id: index for index, plan_id in enumerate(topological_order(plans))}
    children = {
        parent: sorted(ids, key=lambda plan_id: order[plan_id])
        for parent, ids in children_index(plans).items()
    }
    nodes: list[dict[str, object]] = []
    visited: set[str] = set()

    def walk(start: str, detached: str | None) -> None:
        stack: list[tuple[str, int]] = [(start, 0)]
        while stack:
            plan_id, depth = stack.pop()
            if plan_id in visited:
                continue
            visited.add(plan_id)
            plan = plans[plan_id]
            kids = [child for child in children.get(plan_id, []) if child in plans]
            node: dict[str, object] = {
                "id": plan_id,
                "title": plan.title,
                "status": plan.status,
                "kind": plan.kind,
                "readiness": readiness(plans, plan_id),
                "unexpanded": unexpanded(plan, bool(kids)),
                "depth": depth,
                "parent": plan.parent,
                "children": kids,
            }
            if detached and depth == 0:
                node["detached"] = detached
            nodes.append(node)
            stack.extend((child, depth + 1) for child in reversed(kids))

    if top is not None:
        walk(top, None)
    else:
        roots = sorted((p for p, plan in plans.items() if plan.parent is None), key=order.get)
        for plan_id in roots:
            walk(plan_id, None)
        missing = sorted(
            (p for p, plan in plans.items() if plan.parent is not None and plan.parent not in plans),
            key=order.get,
        )
        for plan_id in missing:
            walk(plan_id, "missing_parent")
        for plan_id in sorted(plans, key=order.get):
            if plan_id in visited:
                continue
            # Everything left hangs below a parent cycle; start at a plan on the cycle
            # so its other children stay under it.
            seen: set[str] = set()
            current = plan_id
            while current not in seen:
                seen.add(current)
                current = str(plans[current].parent)
            walk(current, "parent_cycle")
    return {
        "top": top,
        "ancestors": ancestors(plans, top) if top is not None else [],
        "nodes": nodes,
        "counts": {
            "plans": len(nodes),
            "unexpanded": sum(bool(node["unexpanded"]) for node in nodes),
            "detached": sum("detached" in node for node in nodes),
        },
    }
