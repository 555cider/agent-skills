#!/usr/bin/env bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 -m unittest discover -s "$TEST_DIR" -p 'test_*.py' -v
bash -n "$TEST_DIR/../bin/plan-graph"
"$TEST_DIR/../bin/plan-graph" --version >/dev/null && echo "launcher: ok"
