#!/usr/bin/env python3
"""Agent Memory v2 command entrypoint.

The implementation lives in ``agent_memory`` so hooks and tests exercise the
same code as the CLI.  This file intentionally stays tiny: installers may move
the skill directory, while Python always adds this script's directory to
``sys.path``.
"""

from agent_memory.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
