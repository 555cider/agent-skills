from __future__ import annotations

from pathlib import Path

import pytest

from agent_memory.db import Database
from agent_memory.providers import NullProvider
from agent_memory.service import MemoryService


@pytest.fixture
def memory(tmp_path: Path):
    db = Database(tmp_path / "memory")
    service = MemoryService(db, NullProvider())
    try:
        yield db, service, "test-repo"
    finally:
        db.close()
