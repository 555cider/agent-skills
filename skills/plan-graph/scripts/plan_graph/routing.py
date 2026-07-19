from __future__ import annotations

import heapq
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from .model import Plan, scope_matches
from .store import required_closure, reverse_dependents


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


def topological_order(plans: dict[str, Plan], subset: Iterable[str] | None = None) -> list[str]:
    allowed = set(plans) if subset is None else set(subset)
    indegree = {plan_id: 0 for plan_id in allowed}
    dependents: dict[str, set[str]] = {plan_id: set() for plan_id in allowed}
    for dependent in allowed:
        for base in plans[dependent].requires:
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
    return "waiting" if blockers(plans, plan_id) else "ready"


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
        "readiness": readiness(plans, plan_id),
        "blockers": blockers(plans, plan_id),
        "requires": list(plan.requires),
        "replaces": list(plan.replaces),
        "scope": list(plan.scope),
        "tags": list(plan.tags),
    }
    if matches:
        item["matched_by"] = matches
    if include_sections:
        item["outcome"] = _excerpt(plan.sections.get("Outcome", ""))
        item["decisions"] = _excerpt(plan.sections.get("Decisions", ""))
        item["acceptance"] = _excerpt(plan.sections.get("Acceptance", ""))
    return item


def build_context(
    root: Path,
    plans: dict[str, Plan],
    *,
    explicit_plans: Iterable[str] = (),
    paths: Iterable[str] = (),
    query: str = "",
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
    for path in route_paths:
        if path.startswith(".agents/plans/") and path.endswith(".md"):
            plan_file_id = Path(path).stem
            if plan_file_id in plans:
                selected.add(plan_file_id)
                match_reasons[plan_file_id].append("path:plan-file")
        for plan_id, plan in plans.items():
            matching = [pattern for pattern in plan.scope if scope_matches(pattern, path)]
            if matching:
                selected.add(plan_id)
                for pattern in matching:
                    match_reasons[plan_id].append(f"path:{path}~{pattern}")

    query_candidates: list[tuple[int, str, list[str]]] = []
    if query.strip():
        for plan_id, plan in plans.items():
            score, qualifies, reasons = _query_score(plan, query)
            if qualifies and score > 0:
                query_candidates.append((score, plan_id, reasons))
        query_candidates.sort(key=lambda item: (-item[0], item[1]))
        for score, plan_id, reasons in query_candidates[:3]:
            selected.add(plan_id)
            match_reasons[plan_id].extend([*reasons, f"query:score={score}"])

    required = required_closure(plans, selected) - selected
    affected = reverse_dependents(plans, selected, active_only=True) - selected - required
    included = selected | required | affected
    order = topological_order(plans, included)
    role_order = {
        "required": [plan_id for plan_id in order if plan_id in required],
        "selected": [plan_id for plan_id in order if plan_id in selected],
        "affected": [plan_id for plan_id in order if plan_id in affected],
    }
    decision_pack = [
        _plan_item(
            root,
            plans,
            plan_id,
            role=(
                "selected"
                if plan_id in selected
                else "required"
                if plan_id in required
                else "affected"
            ),
            matches=match_reasons.get(plan_id),
            include_sections=True,
        )
        for plan_id in order
    ]

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
        "required": role_order["required"],
        "affected": role_order["affected"],
        "read_order": order,
        "decision_pack": decision_pack,
        "candidates": candidates,
    }


def critical_path(plans: dict[str, Plan]) -> list[str]:
    order = topological_order(plans)
    depth: dict[str, int] = {}
    tail: dict[str, str | None] = {}
    previous: dict[str, str | None] = {}
    for plan_id in order:
        bases = [base for base in plans[plan_id].requires if base in depth]
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
    active = {plan_id for plan_id, plan in plans.items() if plan.status == "active"}
    retained = required_closure(plans, active)
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
    }
