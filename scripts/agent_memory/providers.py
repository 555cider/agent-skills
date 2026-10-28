from __future__ import annotations

import json
import os
import shlex
import subprocess
from abc import ABC, abstractmethod
from typing import Any, Sequence

from .constants import (
    DEFAULT_EMBEDDING_MODEL,
    DEFAULT_OPENAI_MODEL,
    PROVIDER_REQUEST_SCHEMA,
    PROVIDER_RESPONSE_SCHEMA,
)
from .models import Candidate
from .util import MemoryError, stable_json


class ProviderError(MemoryError):
    pass


class Provider(ABC):
    name = "provider"
    embedding_model = ""

    @abstractmethod
    def extract(self, events: list[dict[str, Any]], repo_key: str) -> list[Candidate]:
        raise NotImplementedError

    def reconcile(
        self, candidate: Candidate, existing: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return {"action": "create", "candidate": candidate.as_dict()}

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return []

    def status(self) -> dict[str, Any]:
        return {"name": self.name, "configured": True, "embedding_model": self.embedding_model}


class NullProvider(Provider):
    name = "off"

    def extract(self, events: list[dict[str, Any]], repo_key: str) -> list[Candidate]:
        return []

    def status(self) -> dict[str, Any]:
        return {"name": self.name, "configured": False, "embedding_model": ""}


class UnavailableProvider(Provider):
    """A configured provider that failed before a request could be made.

    Keeping the failure as a provider object lets hook capture and local recall
    remain available while queued work still follows the normal retry and
    dead-letter lifecycle.
    """

    def __init__(self, name: str, error: str) -> None:
        self.name = name or "unavailable"
        self.error = error

    def _raise(self) -> None:
        raise ProviderError(self.error)

    def extract(self, events: list[dict[str, Any]], repo_key: str) -> list[Candidate]:
        self._raise()

    def reconcile(
        self, candidate: Candidate, existing: list[dict[str, Any]]
    ) -> dict[str, Any]:
        self._raise()

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        self._raise()

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "configured": False,
            "embedding_model": "",
            "error": self.error,
        }


CANDIDATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "candidates": {
            "type": "array",
            "maxItems": 12,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["preference", "constraint", "decision", "procedure", "caveat", "handoff"],
                    },
                    "scope": {"type": "string", "enum": ["project", "global"]},
                    "statement": {"type": "string"},
                    "conditions": {"type": "array", "items": {"type": "string"}},
                    "path_globs": {"type": "array", "items": {"type": "string"}},
                    "authority": {
                        "type": "string",
                        "enum": ["explicit", "approved", "verified", "inferred", "assistant"],
                    },
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "properties": {
                                "kind": {"type": "string"},
                                "summary": {"type": "string"},
                                "event_id": {"type": ["string", "null"]},
                                "command": {"type": ["string", "null"]},
                                "exit_status": {"type": ["integer", "null"]},
                            },
                            "required": ["kind", "summary", "event_id", "command", "exit_status"],
                        },
                    },
                    "source_event_ids": {"type": "array", "items": {"type": "string"}},
                    "user_approved": {"type": "boolean"},
                },
                "required": [
                    "kind",
                    "scope",
                    "statement",
                    "conditions",
                    "path_globs",
                    "authority",
                    "confidence",
                    "evidence",
                    "source_event_ids",
                    "user_approved",
                ],
            },
        }
    },
    "required": ["candidates"],
}


def candidates_from_value(value: Any) -> list[Candidate]:
    if isinstance(value, dict):
        value = value.get("candidates", [])
    if not isinstance(value, list):
        raise ProviderError("provider candidates must be an array")
    output: list[Candidate] = []
    for item in value[:12]:
        if not isinstance(item, dict):
            continue
        try:
            output.append(
                Candidate(
                    kind=str(item.get("kind", "")),
                    scope=str(item.get("scope", "project")),
                    statement=str(item.get("statement", "")),
                    conditions=list(item.get("conditions") or []),
                    path_globs=list(item.get("path_globs") or []),
                    authority=str(item.get("authority", "inferred")),
                    confidence=float(item.get("confidence", 0.5)),
                    evidence=list(item.get("evidence") or []),
                    source_event_ids=list(item.get("source_event_ids") or []),
                    user_approved=bool(item.get("user_approved", False)),
                ).validate()
            )
        except (TypeError, ValueError):
            continue
    return output


class OpenAIProvider(Provider):
    name = "openai"

    def __init__(self) -> None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise ProviderError("OPENAI_API_KEY is required when AGENT_MEMORY_PROVIDER=openai")
        self.model = os.environ.get("AGENT_MEMORY_OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
        self.embedding_model = os.environ.get(
            "AGENT_MEMORY_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL
        )
        try:
            from openai import OpenAI  # type: ignore
        except ImportError as exc:
            raise ProviderError(
                "OpenAI provider dependencies are missing; run the Agent Memory installer"
            ) from exc
        self.client = OpenAI()

    def _structured(self, system: str, payload: dict[str, Any], schema: dict[str, Any]) -> Any:
        try:
            response = self.client.responses.create(
                model=self.model,
                store=False,
                max_output_tokens=3000,
                reasoning={"effort": "low"},
                input=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": stable_json(payload)},
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "agent_memory_result",
                        "strict": True,
                        "schema": schema,
                    }
                },
            )
            return json.loads(response.output_text)
        except Exception as exc:  # SDK errors vary by release.
            raise ProviderError(f"OpenAI provider request failed: {type(exc).__name__}: {exc}") from exc

    def extract(self, events: list[dict[str, Any]], repo_key: str) -> list[Candidate]:
        system = (
            "Extract only durable work memory that could change a future coding-agent action. "
            "Do not infer secrets, personal data, file contents, ordinary progress, or facts derivable "
            "from code or git. Inferred preferences and assistant-only claims must use authority "
            "inferred or assistant. Explicit remember/correction requests use explicit. A procedure or "
            "caveat is verified only with command/test evidence. Keep statements concise and preserve "
            "the language useful to the user. List in source_event_ids the ids of the events each "
            "memory came from."
        )
        value = self._structured(system, {"events": events}, CANDIDATE_SCHEMA)
        return candidates_from_value(value)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            response = self.client.embeddings.create(model=self.embedding_model, input=list(texts))
            return [list(item.embedding) for item in response.data]
        except Exception as exc:
            raise ProviderError(f"OpenAI embedding request failed: {type(exc).__name__}: {exc}") from exc

    def status(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "configured": True,
            "model": self.model,
            "embedding_model": self.embedding_model,
            "remote_boundary": "redacted prompts/finals and tool name/command/exit only",
        }


def split_provider_command(command: str, windows: bool | None = None) -> list[str]:
    r"""Split AGENT_MEMORY_PROVIDER_COMMAND into argv.

    A value starting with `[` is a JSON array of strings, used verbatim. Otherwise
    the string is split shell-style: POSIX rules elsewhere, and on Windows the
    MS C runtime rules every Windows program parses its own command line with
    (POSIX `shlex` turns an unquoted `C:\tools\p.exe` into `C:toolsp.exe`).
    """
    if windows is None:
        windows = os.name == "nt"
    text = command.strip()
    if text.startswith("["):
        try:
            argv = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderError(f"AGENT_MEMORY_PROVIDER_COMMAND is not a JSON array: {exc}") from exc
        if not isinstance(argv, list) or not all(isinstance(part, str) and part for part in argv):
            raise ProviderError("AGENT_MEMORY_PROVIDER_COMMAND JSON form must be an array of non-empty strings")
        return argv
    if windows:
        return _split_windows_command_line(text)
    try:
        return shlex.split(text)
    except ValueError as exc:
        raise ProviderError(f"AGENT_MEMORY_PROVIDER_COMMAND cannot be parsed: {exc}") from exc


def _split_windows_command_line(text: str) -> list[str]:
    """Split like the MS C runtime: backslashes are literal unless they precede a
    double quote (2n backslashes + quote -> n backslashes and a quote toggle,
    2n+1 -> n backslashes and a literal quote), `""` inside quotes is a literal
    quote, and whitespace outside quotes separates arguments. Single quotes also
    group, literally, as POSIX `shlex` did here before: configs written as
    `'C:\\Program Files\\p.exe'` kept working."""
    args: list[str] = []
    current: list[str] = []
    in_token = False
    in_quotes = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            run = 0
            while index < len(text) and text[index] == "\\":
                run += 1
                index += 1
            if index < len(text) and text[index] == '"':
                current.append("\\" * (run // 2))
                if run % 2:
                    current.append('"')
                    index += 1
            else:
                current.append("\\" * run)
            in_token = True
            continue
        if char == '"':
            if in_quotes and index + 1 < len(text) and text[index + 1] == '"':
                current.append('"')
                index += 2
                in_token = True
                continue
            in_quotes = not in_quotes
            in_token = True
            index += 1
            continue
        if char == "'" and not in_quotes:
            end = text.find("'", index + 1)
            if end < 0:
                raise ProviderError("AGENT_MEMORY_PROVIDER_COMMAND cannot be parsed: No closing quotation")
            current.append(text[index + 1:end])
            index = end + 1
            in_token = True
            continue
        if char in " \t" and not in_quotes:
            if in_token:
                args.append("".join(current))
                current, in_token = [], False
            index += 1
            continue
        current.append(char)
        in_token = True
        index += 1
    if in_token:
        args.append("".join(current))
    return args


class CommandProvider(Provider):
    name = "command"

    def __init__(self, command: str) -> None:
        self.argv = split_provider_command(command)
        if not self.argv:
            raise ProviderError("AGENT_MEMORY_PROVIDER_COMMAND is empty")
        self.timeout = float(os.environ.get("AGENT_MEMORY_PROVIDER_TIMEOUT", "30"))
        self.embedding_model = os.environ.get("AGENT_MEMORY_EMBEDDING_MODEL", "command")

    def _call(self, operation: str, payload: dict[str, Any]) -> Any:
        request = {
            "schema": PROVIDER_REQUEST_SCHEMA,
            "operation": operation,
            "payload": payload,
        }
        # Bytes in both directions, UTF-8 on the wire: `text=True` would use the locale
        # codec (cp949 on a Korean Windows console), and the payload is serialized with
        # ensure_ascii=False, so an emoji raised UnicodeEncodeError past every
        # `except ProviderError` handler.
        try:
            stdin = stable_json(request).encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ProviderError(f"command provider payload is not encodable: {exc}") from exc
        try:
            result = subprocess.run(
                self.argv,
                input=stdin,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout,
                check=False,
                env={
                    **os.environ,
                    "AGENT_MEMORY_PROVIDER_OPERATION": operation,
                    "PYTHONIOENCODING": "utf-8",
                },
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProviderError(f"command provider failed: {exc}") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()[-500:]
            raise ProviderError(f"command provider exited {result.returncode}: {detail}")
        try:
            response = json.loads(result.stdout.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ProviderError("command provider returned non-UTF-8 output") from exc
        except json.JSONDecodeError as exc:
            raise ProviderError("command provider returned malformed JSON") from exc
        if not isinstance(response, dict) or response.get("schema") != PROVIDER_RESPONSE_SCHEMA:
            raise ProviderError(f"command provider must return schema={PROVIDER_RESPONSE_SCHEMA}")
        if response.get("error"):
            raise ProviderError(f"command provider error: {response['error']}")
        return response.get("result")

    def extract(self, events: list[dict[str, Any]], repo_key: str) -> list[Candidate]:
        return candidates_from_value(self._call("extract", {"events": events}))

    def reconcile(
        self, candidate: Candidate, existing: list[dict[str, Any]]
    ) -> dict[str, Any]:
        result = self._call(
            "reconcile", {"candidate": candidate.as_dict(), "existing": existing}
        )
        if not isinstance(result, dict):
            raise ProviderError("command provider reconcile result must be an object")
        return result

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        result = self._call("embed", {"texts": list(texts), "model": self.embedding_model})
        if isinstance(result, dict):
            result = result.get("vectors")
        if not isinstance(result, list):
            raise ProviderError("command provider embed result must be an array")
        return [[float(value) for value in vector] for vector in result]


def provider_from_env() -> Provider:
    selected = os.environ.get("AGENT_MEMORY_PROVIDER", "off").strip().casefold()
    if selected in {"", "off", "none", "local"}:
        return NullProvider()
    if selected == "openai":
        return OpenAIProvider()
    if selected == "command":
        command = os.environ.get("AGENT_MEMORY_PROVIDER_COMMAND", "")
        return CommandProvider(command)
    raise ProviderError(f"unknown AGENT_MEMORY_PROVIDER: {selected}")
