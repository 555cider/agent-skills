#!/usr/bin/env python3
"""Validate the Claude Code marketplace, bundle-plugin manifests and plugin hooks.

The plugin channel is a second delivery surface for the same skills/<name>/
directories that install.sh ships. Nothing inside skills/ knows about it: the
per-skill plugins are declared entirely in .claude-plugin/marketplace.json,
each entry pointing at ./skills/<name> and declaring `skills: ["."]` because
SKILL.md sits at that directory's root. That decoupling is exactly why the
manifest can drift — adding a skill does not touch the manifest, and CI would
happily publish a marketplace that has never heard of it. This check is what
makes the drift fail the build instead of shipping.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"
PLUGIN = ROOT / ".claude-plugin" / "plugin.json"

# The bundle entry ships every skill at once from the repository root, so it is
# the one entry with no skills/<name> directory behind it.
BUNDLE = "agent-skills"

# Anthropic reserves a set of marketplace names for its own GitHub org; adding
# a marketplace under one of them fails at `claude plugin marketplace add`
# time, i.e. for the user, not for us. "agent-skills" is on that list, which is
# why the marketplace is named after its owner and only the bundle plugin keeps
# the bare name.
RESERVED_MARKETPLACE_NAMES = {
    "agent-skills",
    "anthropic-agent-skills",
    "anthropic-marketplace",
    "anthropic-plugins",
    "claude-code-marketplace",
    "claude-code-plugins",
    "claude-plugins-official",
    "first-party-plugins",
}

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


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


def skill_name_in(skill_md: Path) -> str | None:
    """Read the frontmatter `name:` the way install.sh does — one grep, no YAML."""
    for line in skill_md.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\s*name:\s*['\"]?([^'\"\s]+)['\"]?\s*$", line)
        if match:
            return match.group(1)
    return None


def validate_bundle_plugin(skills: list[str]) -> None:
    data = load_json(PLUGIN)
    rel = PLUGIN.relative_to(ROOT)
    require(isinstance(data, dict), f"{rel} must be a JSON object")
    require(data.get("name") == BUNDLE, f"{rel}.name must be {BUNDLE!r}")
    version = data.get("version")
    require(
        isinstance(version, str) and bool(SEMVER.match(version)),
        f"{rel}.version must be semver — `claude plugin validate --strict` fails without it",
    )
    require(
        isinstance(data.get("description"), str) and data["description"].strip(),
        f"{rel}.description must be a non-empty string",
    )
    # The bundle declares no components: it is served from the repository root,
    # where skills/ is auto-loaded. Declaring them here as well would collide
    # with the marketplace entry, which Claude Code rejects as a conflict.
    require(
        "skills" not in data,
        f"{rel} must not declare `skills`; the repository root auto-loads skills/",
    )
    require(skills, "no skills found under skills/")


def validate_marketplace(skills: list[str]) -> int:
    data = load_json(MARKETPLACE)
    rel = MARKETPLACE.relative_to(ROOT)
    require(isinstance(data, dict), f"{rel} must be a JSON object")

    name = data.get("name")
    require(isinstance(name, str) and name.strip(), f"{rel}.name must be a non-empty string")
    require(
        name not in RESERVED_MARKETPLACE_NAMES,
        f"{rel}.name {name!r} is reserved for Anthropic marketplaces; users cannot add it",
    )
    require(isinstance(data.get("owner"), dict), f"{rel}.owner must be an object")

    entries = data.get("plugins")
    require(isinstance(entries, list) and entries, f"{rel}.plugins must be a non-empty array")

    seen: list[str] = []
    for index, entry in enumerate(entries, 1):
        where = f"{rel}.plugins[{index}]"
        require(isinstance(entry, dict), f"{where} must be an object")
        entry_name = entry.get("name")
        require(
            isinstance(entry_name, str) and entry_name.strip(),
            f"{where}.name must be a non-empty string",
        )
        require(entry_name not in seen, f"{where}.name {entry_name!r} is declared twice")
        seen.append(entry_name)
        require(
            isinstance(entry.get("description"), str) and entry["description"].strip(),
            f"{where}.description must be a non-empty string",
        )

        source = entry.get("source")
        require(isinstance(source, str) and source, f"{where}.source must be a string path")

        if entry_name == BUNDLE:
            require(source == "./", f"{where}.source must be './' for the bundle entry")
            require(
                "skills" not in entry,
                f"{where} must not declare `skills`; the root plugin.json owns the bundle",
            )
            continue

        require(
            source == f"./skills/{entry_name}",
            f"{where}.source must be './skills/{entry_name}'",
        )
        skill_dir = ROOT / "skills" / entry_name
        require(skill_dir.is_dir(), f"{where}.source points at a missing directory")
        skill_md = skill_dir / "SKILL.md"
        require(skill_md.is_file(), f"{where}.source has no SKILL.md")
        declared = skill_name_in(skill_md)
        require(
            declared == entry_name,
            f"{where}.name is {entry_name!r} but skills/{entry_name}/SKILL.md declares {declared!r}",
        )
        # SKILL.md is at the plugin root, not under skills/, so the entry has to
        # say so; without this the plugin installs with zero skills.
        require(
            entry.get("skills") == ["."],
            f'{where}.skills must be ["."] — SKILL.md sits at the plugin root',
        )
        version = entry.get("version")
        require(
            isinstance(version, str) and bool(SEMVER.match(version)),
            f"{where}.version must be semver",
        )

    listed = sorted(n for n in seen if n != BUNDLE)
    require(BUNDLE in seen, f"{rel} is missing the {BUNDLE!r} bundle entry")
    require(
        listed == sorted(skills),
        "marketplace entries and skills/ disagree: "
        f"only in manifest={sorted(set(listed) - set(skills))}, "
        f"only in skills/={sorted(set(skills) - set(listed))}",
    )
    return len(entries)


# A hook command reaches into its plugin through this placeholder; Claude Code
# sets CLAUDE_PLUGIN_ROOT and Codex PLUGIN_ROOT, so the shipped commands spell
# `${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT}}`. Either name alone is accepted too.
PLUGIN_ROOT_PATH = re.compile(
    r"\$\{(?:CLAUDE_PLUGIN_ROOT(?::-\$\{PLUGIN_ROOT\})?|PLUGIN_ROOT)\}/([^\s\"']+)"
)


def validate_hooks_file(path: Path, plugin_root: Path) -> list[tuple[str, str, object]]:
    """Check one hooks.json and return its (event, command, timeout) entries.

    Plugin hooks run on every prompt; a command pointing at a renamed or
    deleted script fails in each session instead of in CI.
    """
    rel = path.relative_to(ROOT).as_posix()
    data = load_json(path)
    require(isinstance(data, dict), f"{rel} must be a JSON object")
    events = data.get("hooks")
    require(isinstance(events, dict) and events, f"{rel}.hooks must be a non-empty object")
    entries: list[tuple[str, str, object]] = []
    for event, groups in events.items():
        require(isinstance(groups, list) and groups, f"{rel}.hooks.{event} must be a non-empty array")
        for gi, group in enumerate(groups, 1):
            where = f"{rel}.hooks.{event}[{gi}]"
            require(isinstance(group, dict), f"{where} must be an object")
            hooks = group.get("hooks")
            require(isinstance(hooks, list) and hooks, f"{where}.hooks must be a non-empty array")
            for hi, hook in enumerate(hooks, 1):
                hwhere = f"{where}.hooks[{hi}]"
                require(isinstance(hook, dict), f"{hwhere} must be an object")
                require(hook.get("type") == "command", f"{hwhere}.type must be 'command'")
                command = hook.get("command")
                require(
                    isinstance(command, str) and command.strip(),
                    f"{hwhere}.command must be a non-empty string",
                )
                timeout = hook.get("timeout")
                require(
                    timeout is None
                    or (isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0),
                    f"{hwhere}.timeout must be a positive number",
                )
                for target in PLUGIN_ROOT_PATH.findall(command):
                    resolved = (plugin_root / target).resolve()
                    require(
                        resolved.is_relative_to(plugin_root.resolve()),
                        f"{hwhere}.command points outside its plugin: {target}",
                    )
                    require(
                        resolved.is_file(),
                        f"{hwhere}.command runs a missing file: {resolved.relative_to(ROOT).as_posix()}",
                    )
                entries.append((event, command, timeout))
    return entries


def validate_hooks(skills: list[str]) -> int:
    """Validate the bundle's hooks/hooks.json and each skill's own copy.

    The bundle plugin is served from the repository root and the per-skill
    plugin from skills/<name>, so one skill's hooks exist twice with different
    paths. They must stay the same hooks apart from that prefix.
    """
    count = 0
    bundle_file = ROOT / "hooks" / "hooks.json"
    bundle = validate_hooks_file(bundle_file, ROOT) if bundle_file.is_file() else []
    count += bool(bundle)
    for name in skills:
        skill_file = SKILLS / name / "hooks" / "hooks.json"
        prefix = "}/skills/" + name + "/"
        bundled = [(e, c.replace(prefix, "}/"), t) for e, c, t in bundle if prefix in c]
        if not skill_file.is_file():
            require(
                not bundled,
                f"hooks/hooks.json runs skills/{name} but skills/{name}/hooks/hooks.json is missing; "
                "the per-skill plugin would ship without its hooks",
            )
            continue
        own = validate_hooks_file(skill_file, SKILLS / name)
        count += 1
        require(
            sorted(own, key=repr) == sorted(bundled, key=repr),
            f"skills/{name}/hooks/hooks.json and the skills/{name} entries in hooks/hooks.json disagree",
        )
    return count


def main() -> int:
    skills = sorted(d.name for d in SKILLS.iterdir() if (d / "SKILL.md").is_file())
    validate_bundle_plugin(skills)
    count = validate_marketplace(skills)
    hook_files = validate_hooks(skills)
    print(
        f"OK plugin manifests ({count} marketplace entries, {len(skills)} skills, "
        f"{hook_files} hooks files)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
