from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from .constants import AUTHORITIES, MEMORY_KINDS, SCOPES


@dataclass
class Candidate:
    kind: str
    scope: str
    statement: str
    conditions: list[str] = field(default_factory=list)
    path_globs: list[str] = field(default_factory=list)
    authority: str = "inferred"
    confidence: float = 0.5
    evidence: list[dict[str, Any]] = field(default_factory=list)
    valid_until: str | None = None
    source_event_ids: list[str] = field(default_factory=list)
    user_approved: bool = False

    def validate(self) -> "Candidate":
        if self.kind not in MEMORY_KINDS:
            raise ValueError(f"invalid memory kind: {self.kind}")
        if self.scope not in SCOPES:
            raise ValueError(f"invalid memory scope: {self.scope}")
        if self.authority not in AUTHORITIES:
            raise ValueError(f"invalid authority: {self.authority}")
        self.statement = self.statement.strip()
        if not self.statement:
            raise ValueError("memory statement is empty")
        self.confidence = min(1.0, max(0.0, float(self.confidence)))
        self.conditions = [str(item).strip() for item in self.conditions if str(item).strip()]
        self.path_globs = [str(item).strip() for item in self.path_globs if str(item).strip()]
        return self

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)
