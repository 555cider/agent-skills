#!/usr/bin/env python3
"""
Back-compat shim. The old capture.py took full-page screenshots and computed nothing —
which structurally hid sticky-bar overlaps and downscaled away small-text contrast.
It is replaced by the deterministic audit (audit.js). This shim forwards to the Playwright
runner (run-ui-splint.py) so existing invocations keep working.

If Playwright isn't installed, prefer the zero-dependency runner instead:
    node audit-chrome.mjs <url> [--config audit-config.json]
"""
import sys
import runpy
from pathlib import Path

if __name__ == "__main__":
    sys.stderr.write("note: capture.py now forwards to run-ui-splint.py (deterministic audit).\n")
    sys.argv[0] = str(Path(__file__).resolve().parent / "run-ui-splint.py")
    runpy.run_path(sys.argv[0], run_name="__main__")
