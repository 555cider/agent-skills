from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Sequence

from .util import MemoryError, atomic_write
from .util import user_home as default_user_home


INTEGRATION_MARKER = "agent-memory-v2-managed"
LEGACY_INTEGRATION_MARKER = "agent-memory-managed"
OPENCODE_MARKER = "AGENT_MEMORY_OPENCODE_ADAPTER_V2"
KNOWN_CONFLICT_TOKENS = ("remember-codex-bridge", "remember@")
HOOK_EVENTS: dict[str, tuple[tuple[str, str, int], ...]] = {
    "claude": (
        ("UserPromptSubmit", "user_prompt", 5),
        ("PostToolUse", "tool_completed", 5),
        ("Stop", "assistant_stop", 15),
        ("SessionEnd", "session_end", 15),
    ),
    "codex": (
        ("UserPromptSubmit", "user_prompt", 5),
        ("PostToolUse", "tool_completed", 5),
        ("Stop", "assistant_stop", 15),
    ),
}


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MemoryError(f"cannot safely merge JSON config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MemoryError(f"JSON config root must be an object: {path}")
    return value


def _hook_command(harness: str, event: str) -> str:
    skill_root = Path(__file__).resolve().parents[2]
    script = skill_root / "scripts" / "memory.py"
    candidates = [
        skill_root / ".venv" / "bin" / "python",
        skill_root / ".venv" / "Scripts" / "python.exe",
    ]
    python = next((path for path in candidates if path.exists()), Path(sys.executable))
    args = [
        str(item)
        for item in (python, script, "hook", "--harness", harness, "--event", event)
    ]
    if sys.platform == "win32":
        # Codex may invoke hooks through cmd.exe or Git Bash. Always quoting
        # Windows paths preserves backslashes in both shells.
        paths = " ".join(f'"{item}"' for item in args[:2])
        return f"{paths} {subprocess.list2cmdline(args[2:])}"
    return shlex.join(args)


def _managed_entry(harness: str, event: str, timeout: int) -> dict[str, Any]:
    return {
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": _hook_command(harness, event),
                "timeout": timeout,
                "statusMessage": f"Agent Memory v2 {event} ({INTEGRATION_MARKER})",
            }
        ],
    }


def _is_managed_entry(value: Any) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("hooks"), list):
        return False
    return any(
        isinstance(item, dict)
        and any(
            marker in str(item.get("statusMessage", ""))
            for marker in (INTEGRATION_MARKER, LEGACY_INTEGRATION_MARKER)
        )
        and "memory.py" in str(item.get("command", ""))
        for item in value["hooks"]
    )


def merge_hooks(config: dict[str, Any], harness: str, enabled: bool) -> dict[str, Any]:
    updated = json.loads(json.dumps(config))
    hooks = updated.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise MemoryError("hooks config must be an object")
    for hook_name, event, timeout in HOOK_EVENTS[harness]:
        current = hooks.get(hook_name, [])
        if not isinstance(current, list):
            raise MemoryError(f"hooks.{hook_name} must be a list")
        kept = [entry for entry in current if not _is_managed_entry(entry)]
        if enabled:
            kept.append(_managed_entry(harness, event, timeout))
        if kept:
            hooks[hook_name] = kept
        else:
            hooks.pop(hook_name, None)
    if not hooks:
        updated.pop("hooks", None)
    return updated


def set_toml_feature(text: str, key: str, enabled: bool) -> str:
    lines = text.splitlines()
    start: int | None = None
    end = len(lines)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[features]":
            start = index
            continue
        if start is not None and index > start and re.fullmatch(r"\s*\[[^]]+\]\s*", line):
            end = index
            break
    rendered = f"{key} = {'true' if enabled else 'false'}"
    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend(["[features]", rendered])
    else:
        for index in range(start + 1, end):
            if re.match(rf"\s*{re.escape(key)}\s*=", lines[index]):
                indent = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
                lines[index] = indent + rendered
                break
        else:
            lines.insert(end, rendered)
    return "\n".join(lines).rstrip() + "\n"


def _known_plugin_token(header: str) -> str:
    if not header.strip().startswith("[plugins."):
        return ""
    return next((token for token in KNOWN_CONFLICT_TOKENS if token in header), "")


def enabled_toml_conflicts(text: str) -> set[str]:
    lines = text.splitlines()
    conflicts: set[str] = set()
    index = 0
    while index < len(lines):
        token = _known_plugin_token(lines[index])
        if token:
            end = index + 1
            enabled = True
            while end < len(lines) and not re.fullmatch(r"\s*\[[^]]+\]\s*", lines[end]):
                match = re.fullmatch(
                    r"\s*enabled\s*=\s*(true|false)\s*(?:#.*)?", lines[end], re.I
                )
                if match:
                    enabled = match.group(1).lower() == "true"
                end += 1
            if enabled:
                conflicts.add(token)
            index = end
            continue
        match = re.fullmatch(r"\s*[A-Za-z0-9_.-]+\s*=\s*\[(.*)\]\s*(?:#.*)?", lines[index])
        if match:
            conflicts.update(token for token in KNOWN_CONFLICT_TOKENS if token in match.group(1))
        index += 1
    return conflicts


def remove_known_conflicts_from_toml(text: str) -> str:
    source = text.splitlines()
    lines: list[str] = []
    index = 0
    while index < len(source):
        line = source[index]
        token = _known_plugin_token(line)
        if token:
            end = index + 1
            block = [line]
            while end < len(source) and not re.fullmatch(r"\s*\[[^]]+\]\s*", source[end]):
                block.append(source[end])
                end += 1
            for block_index in range(1, len(block)):
                if re.match(r"\s*enabled\s*=", block[block_index]):
                    indent = block[block_index][: len(block[block_index]) - len(block[block_index].lstrip())]
                    block[block_index] = indent + "enabled = false"
                    break
            else:
                block.insert(1, "enabled = false")
            lines.extend(block)
            index = end
            continue
        match = re.fullmatch(r"(\s*[A-Za-z0-9_.-]+\s*=\s*)\[(.*)\](\s*(?:#.*)?)", line)
        if match and any(token in match.group(2) for token in KNOWN_CONFLICT_TOKENS):
            items = re.findall(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'', match.group(2))
            kept = [item for item in items if not any(token in item for token in KNOWN_CONFLICT_TOKENS)]
            line = match.group(1) + "[" + ", ".join(kept) + "]" + match.group(3)
        lines.append(line)
        index += 1
    return "\n".join(lines).rstrip() + ("\n" if text else "")


def known_conflicts(paths: Sequence[Path]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for path in paths:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        tokens = (
            enabled_toml_conflicts(text)
            if path.name == "config.toml"
            else {token for token in KNOWN_CONFLICT_TOKENS if token in text}
        )
        findings.extend({"path": str(path), "token": token} for token in sorted(tokens))
    return findings


def _adapter_source() -> str:
    path = Path(__file__).resolve().parents[2] / "adapters" / "opencode.js"
    if not path.exists():
        raise MemoryError(f"OpenCode adapter missing: {path}")
    return path.read_text(encoding="utf-8")


def _backup_files(memory_home: Path, paths: Sequence[Path]) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    root = memory_home / "backups" / "integrations" / stamp
    suffix = 1
    while root.exists():
        root = root.with_name(f"{stamp}-{suffix}")
        suffix += 1
    root.mkdir(parents=True, exist_ok=False)
    os.chmod(root, 0o700)
    for path in paths:
        if not path.exists():
            continue
        relative = str(path).lstrip("/\\").replace(":", "_")
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    return root


def integration_paths(user_home: Path | None = None) -> dict[str, Path]:
    home = user_home or default_user_home()
    return {
        "claude": home / ".claude" / "settings.json",
        "codex_hooks": home / ".codex" / "hooks.json",
        "codex_config": home / ".codex" / "config.toml",
        "opencode": home / ".config" / "opencode" / "plugins" / "agent-memory.js",
    }


def integrate(
    *,
    memory_home: Path,
    mode: str,
    harness: str,
    apply: bool,
    disable_known_conflicts: bool = False,
    user_home: Path | None = None,
) -> dict[str, Any]:
    if mode not in {"shadow", "primary", "off"}:
        raise MemoryError(f"invalid integration mode: {mode}")
    if harness not in {"all", "claude", "codex", "opencode"}:
        raise MemoryError(f"invalid harness: {harness}")
    selected = ["claude", "codex", "opencode"] if harness == "all" else [harness]
    paths = integration_paths(user_home)
    conflict_list = known_conflicts(list(paths.values()))
    blocked = mode == "primary" and bool(conflict_list) and not disable_known_conflicts
    if apply and blocked:
        raise MemoryError(
            "known memory integration conflict found; review doctor output and rerun with --disable-known-conflicts"
        )
    enabled = mode != "off"
    planned: dict[Path, str | None] = {}
    if "claude" in selected:
        value = merge_hooks(_read_json(paths["claude"]), "claude", enabled)
        if mode == "primary":
            value["autoMemoryEnabled"] = False
        planned[paths["claude"]] = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if "codex" in selected:
        value = merge_hooks(_read_json(paths["codex_hooks"]), "codex", enabled)
        planned[paths["codex_hooks"]] = (
            json.dumps(value, indent=2, ensure_ascii=False) + "\n" if value else None
        )
        if mode == "primary":
            text = paths["codex_config"].read_text(encoding="utf-8") if paths["codex_config"].exists() else ""
            if disable_known_conflicts:
                text = remove_known_conflicts_from_toml(text)
            planned[paths["codex_config"]] = set_toml_feature(text, "memories", False)
    if "opencode" in selected:
        source = _adapter_source()
        if enabled:
            planned[paths["opencode"]] = source
        elif paths["opencode"].exists() and OPENCODE_MARKER in paths["opencode"].read_text(
            encoding="utf-8", errors="replace"
        ):
            planned[paths["opencode"]] = None

    changes = []
    for path, content in planned.items():
        current = path.read_text(encoding="utf-8", errors="replace") if path.exists() else None
        if (content is None and path.exists()) or (content is not None and current != content):
            changes.append({"path": str(path), "action": "remove" if content is None else "write"})
    backup: Path | None = None
    if apply and changes:
        backup = _backup_files(memory_home, [Path(item["path"]) for item in changes])
        for path, content in planned.items():
            if not any(item["path"] == str(path) for item in changes):
                continue
            if content is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, content)
    return {
        "mode": mode,
        "harnesses": selected,
        "changes": changes,
        "conflicts": conflict_list,
        "blocked": blocked,
        "applied": apply,
        "backup": str(backup) if backup else "",
    }


def _managed_hook_commands(text: str) -> list[str]:
    try:
        value = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return []
    hooks = value.get("hooks") if isinstance(value, dict) else None
    if not isinstance(hooks, dict):
        return []
    commands: list[str] = []
    for entries in hooks.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not _is_managed_entry(entry):
                continue
            for item in entry.get("hooks", []):
                command = str(item.get("command", "")) if isinstance(item, dict) else ""
                if command:
                    commands.append(command)
    return commands


def _stale_command(command: str) -> bool:
    """A managed hook whose python or script path no longer exists is dead.

    This happened in the field: an integrate run from a sandboxed skill copy
    left real configs pointing into a temp directory.
    """

    try:
        parts = shlex.split(command)
    except ValueError:
        return True
    if len(parts) < 2:
        return True
    return not (Path(parts[0]).exists() and Path(parts[1]).exists())


def integration_status(user_home: Path | None = None) -> dict[str, Any]:
    paths = integration_paths(user_home)
    status: dict[str, Any] = {}
    for name, path in paths.items():
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        managed = INTEGRATION_MARKER in text or OPENCODE_MARKER in text
        stale = False
        if managed and name in {"claude", "codex_hooks"}:
            commands = _managed_hook_commands(text)
            stale = any(_stale_command(command) for command in commands)
        status[name] = {
            "path": str(path),
            "exists": path.exists(),
            "managed": managed,
            "stale": stale,
        }
    return {"adapters": status, "conflicts": known_conflicts(list(paths.values()))}
