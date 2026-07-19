#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_venv="${AGENT_MEMORY_TEST_VENV:-/tmp/agent-memory-v2-test-venv}"

if [ ! -x "$test_venv/bin/python" ]; then
  python3 -m venv "$test_venv"
fi
if ! "$test_venv/bin/python" -c 'import pytest, openai, sqlite_vec' >/dev/null 2>&1; then
  "$test_venv/bin/python" -m pip install --disable-pip-version-check --quiet \
    --requirement "$skill_root/requirements.txt" \
    --requirement "$skill_root/requirements-dev.txt"
fi

PYTHONPATH="$skill_root/scripts" "$test_venv/bin/python" -m pytest -q "$skill_root/tests"
python3 -m py_compile "$skill_root/scripts/memory.py" "$skill_root"/scripts/agent_memory/*.py
node --check "$skill_root/adapters/opencode.js"
bash -n "$skill_root/bin/agent-memory"
