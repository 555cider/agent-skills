#!/usr/bin/env python3
"""Validate skill trigger and behavior eval assets."""

from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"


def fail(message: str) -> None:
    print(f"ERROR={message}", file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"missing {path.relative_to(ROOT)}")
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path.relative_to(ROOT)}: {exc}")


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def validate_trigger_evals(skill: str, path: Path) -> None:
    data = load_json(path)
    rel = path.relative_to(ROOT)
    require(isinstance(data, list), f"{rel} must be a JSON array")
    require(len(data) >= 20, f"{rel} must contain at least 20 cases")

    positives = 0
    negatives = 0
    seen_queries: set[str] = set()
    for index, item in enumerate(data, 1):
        require(isinstance(item, dict), f"{rel}[{index}] must be an object")
        query = item.get("query")
        should_trigger = item.get("should_trigger")
        require(isinstance(query, str) and query.strip(), f"{rel}[{index}].query must be a non-empty string")
        require(query not in seen_queries, f"{rel}[{index}].query duplicates another case")
        seen_queries.add(query)
        require(isinstance(should_trigger, bool), f"{rel}[{index}].should_trigger must be boolean")
        positives += int(should_trigger)
        negatives += int(not should_trigger)

    require(positives >= 10, f"{rel} must include at least 10 positive trigger cases")
    require(negatives >= 10, f"{rel} must include at least 10 negative trigger cases")


def validate_behavior_evals(skill: str, path: Path) -> None:
    data = load_json(path)
    rel = path.relative_to(ROOT)
    require(isinstance(data, dict), f"{rel} must be an object")
    require(data.get("skill_name") == skill, f"{rel}.skill_name must be {skill!r}")
    evals = data.get("evals")
    require(isinstance(evals, list) and len(evals) >= 4, f"{rel}.evals must contain at least 4 cases")

    seen_ids: set[str] = set()
    for index, item in enumerate(evals, 1):
        require(isinstance(item, dict), f"{rel}.evals[{index}] must be an object")
        case_id = item.get("id")
        require(isinstance(case_id, str) and case_id.strip(), f"{rel}.evals[{index}].id must be non-empty")
        require(case_id not in seen_ids, f"{rel}.evals[{index}].id duplicates another case")
        seen_ids.add(case_id)
        for key in ("prompt", "expected_output"):
            value = item.get(key)
            require(isinstance(value, str) and value.strip(), f"{rel}.evals[{index}].{key} must be non-empty")
        assertions = item.get("assertions")
        require(isinstance(assertions, list) and assertions, f"{rel}.evals[{index}].assertions must be a non-empty array")
        require(all(isinstance(entry, str) and entry.strip() for entry in assertions),
                f"{rel}.evals[{index}].assertions must contain only non-empty strings")
        files = item.get("files", [])
        require(isinstance(files, list), f"{rel}.evals[{index}].files must be an array when present")
        require(all(isinstance(entry, str) for entry in files),
                f"{rel}.evals[{index}].files must contain only strings")


def line_endings_rules(path: Path) -> list[str]:
    """Significant (non-comment, non-blank) lines of a .gitattributes file."""
    text = path.read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines()
            if line.strip() and not line.lstrip().startswith("#")]


def validate_line_endings(skill: str, skill_dir: Path, expected: list[str]) -> None:
    """Each skill carries its own copy of the root line-ending rules.

    `git subtree split --prefix=skills/<name>` publishes only the skill directory, so the
    monorepo's root .gitattributes never reaches split/<name> — the branch install.sh clones
    for a normal install. Without a copy inside the skill, a Windows clone with
    core.autocrlf=true checks the skill out as CRLF and its scripts break under any shell
    stricter than Git Bash. Drift here is silent, so it is enforced rather than documented.
    """
    path = skill_dir / ".gitattributes"
    require(path.is_file(),
            f"{skill}/.gitattributes is missing "
            "(the root copy does not reach split/<name>; see tests/validate-skill-evals.py)")
    rules = line_endings_rules(path)
    require(rules == expected,
            f"{skill}/.gitattributes rules differ from the root .gitattributes: "
            f"{rules} != {expected}")


def main() -> int:
    skill_dirs = sorted(path for path in SKILLS.iterdir() if path.is_dir())
    require(skill_dirs, "no skills found")

    root_attributes = ROOT / ".gitattributes"
    require(root_attributes.is_file(), "root .gitattributes is missing")
    expected_rules = line_endings_rules(root_attributes)
    require(expected_rules, "root .gitattributes declares no rules")

    for skill_dir in skill_dirs:
        skill = skill_dir.name
        require((skill_dir / "SKILL.md").is_file(), f"{skill}/SKILL.md is missing")
        eval_dir = skill_dir / "evals"
        require(eval_dir.is_dir(), f"{skill}/evals is missing")
        validate_trigger_evals(skill, eval_dir / "trigger-evals.json")
        validate_behavior_evals(skill, eval_dir / "behavior-evals.json")
        # Every skill must ship an executable regression suite.
        require((skill_dir / "tests" / "run.sh").is_file(), f"{skill}/tests/run.sh is missing")
        validate_line_endings(skill, skill_dir, expected_rules)

    print(f"OK skill evals ({len(skill_dirs)} skills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
