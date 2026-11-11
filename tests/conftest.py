from __future__ import annotations

from pathlib import Path

import pytest

from agent_memory.db import Database
from agent_memory.providers import NullProvider
from agent_memory.service import MemoryService


@pytest.fixture(autouse=True)
def _no_real_harness_dirs(monkeypatch):
    # The session running the suite may point these at a real profile; a subprocess
    # that inherits them would integrate into it.
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)


@pytest.fixture
def memory(tmp_path: Path):
    db = Database(tmp_path / "memory")
    service = MemoryService(db, NullProvider())
    try:
        yield db, service, "test-repo"
    finally:
        db.close()
