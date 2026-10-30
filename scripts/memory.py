#!/usr/bin/env python3
"""Agent Memory v2 command entrypoint.

The implementation lives in ``agent_memory`` so hooks and tests exercise the
same code as the CLI.  This file intentionally stays tiny: installers may move
the skill directory, while Python always adds this script's directory to
``sys.path``.
"""

import sys

if sys.version_info < (3, 11):
    # Hooks fail open; an old interpreter must not print a traceback per prompt.
    if "hook" in sys.argv[1:4]:  # also after --memory-home DIR
        print("{}")
        raise SystemExit(0)
    raise SystemExit("agent-memory requires Python 3.11+")

from agent_memory.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
