#!/usr/bin/env python3
"""Compatibility shim for the canonical Node/CDP ui-audit v2 runner.

Existing Python invocations remain valid, but all behavior now lives in
``audit-chrome.mjs`` so state mocking, adaptations, probes, schemas, and exit gates
cannot drift between two implementations.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
NODE_RUNNER = HERE / "audit-chrome.mjs"


def main() -> int:
    if not NODE_RUNNER.exists():
        sys.stderr.write(f"Error: canonical Node runner not found at {NODE_RUNNER}\n")
        return 2

    node = os.environ.get("NODE", "node")
    command = [node, str(NODE_RUNNER), *sys.argv[1:]]
    try:
        return subprocess.run(command, check=False).returncode
    except FileNotFoundError:
        sys.stderr.write(
            f"Error: {node!r} was not found. ui-audit requires Node.js 22 or newer.\n"
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
