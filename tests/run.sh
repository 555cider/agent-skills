#!/usr/bin/env bash
set -euo pipefail

skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_venv="${AGENT_MEMORY_TEST_VENV:-/tmp/agent-memory-v2-test-venv}"

venv_python() {
  if [ -x "$test_venv/bin/python" ]; then
    printf '%s\n' "$test_venv/bin/python"
  elif [ -x "$test_venv/Scripts/python.exe" ]; then
    printf '%s\n' "$test_venv/Scripts/python.exe"
  fi
}

[ -n "$(venv_python)" ] || python3 -m venv "$test_venv"
python_bin="$(venv_python)"
[ -n "$python_bin" ] || { echo "error: no python in test venv $test_venv" >&2; exit 1; }

if ! "$python_bin" -c 'import pytest, openai, sqlite_vec' >/dev/null 2>&1; then
  "$python_bin" -m pip install --disable-pip-version-check --quiet \
    --requirement "$skill_root/requirements.txt" \
    --requirement "$skill_root/requirements-dev.txt"
fi

PYTHONPATH="$skill_root/scripts" "$python_bin" -m pytest -q "$skill_root/tests"
python3 -m py_compile "$skill_root/scripts/memory.py" "$skill_root"/scripts/agent_memory/*.py
node --check "$skill_root/adapters/opencode.js"
bash -n "$skill_root/bin/agent-memory"
