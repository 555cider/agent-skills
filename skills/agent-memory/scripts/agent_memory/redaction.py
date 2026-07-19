from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RedactionResult:
    value: str
    findings: tuple[str, ...]


PATTERNS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    (
        "private-key",
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
        "[REDACTED_PRIVATE_KEY]",
    ),
    ("bearer", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}"), "Bearer [REDACTED]"),
    (
        "secret-assignment",
        re.compile(
            r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)"
            r"\s*[:=]\s*(['\"]?)[^\s,'\"}]{6,}\2"
        ),
        r"\1=[REDACTED]",
    ),
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "[REDACTED_API_KEY]"),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"), "[REDACTED_TOKEN]"),
    ("aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_AWS_KEY]"),
    ("email", re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])"), "[REDACTED_EMAIL]"),
    (
        "phone",
        re.compile(r"(?<!\d)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)\d{3,4}[ .-]\d{4}(?!\d)"),
        "[REDACTED_PHONE]",
    ),
    (
        "absolute-path",
        re.compile(r"(?<![\w.])(?:/(?:home|Users|private|var/folders|tmp)/[^\s'\";,)}\]]+|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s'\";,)}\]]+)", re.I),
        "[REDACTED_PATH]",
    ),
)


def redact_text(value: str) -> RedactionResult:
    findings: list[str] = []
    redacted = value.replace("\x00", "")
    for name, pattern, replacement in PATTERNS:
        redacted, count = pattern.subn(replacement, redacted)
        if count:
            findings.extend([name] * count)
    return RedactionResult(redacted, tuple(findings))


def redact_value(value: Any) -> tuple[Any, list[str]]:
    findings: list[str] = []
    if isinstance(value, str):
        result = redact_text(value)
        return result.value, list(result.findings)
    if isinstance(value, list):
        output = []
        for item in value:
            redacted, nested = redact_value(item)
            output.append(redacted)
            findings.extend(nested)
        return output, findings
    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            redacted, nested = redact_value(item)
            output[str(key)] = redacted
            findings.extend(nested)
        return output, findings
    return value, findings
