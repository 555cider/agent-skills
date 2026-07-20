#!/usr/bin/env python3
"""
Back-compat shim. The old capture.py took full-page screenshots and computed nothing —
which structurally hid sticky-bar overlaps and downscaled away small-text contrast.
It is replaced by the deterministic audit (audit.js). This shim forwards through
run-ui-audit.py to the canonical zero-dependency Node/CDP runner.
"""
import sys
import runpy
from pathlib import Path

if __name__ == "__main__":
    sys.stderr.write("note: capture.py forwards to the canonical ui-audit v2 Node runner.\n")
    sys.argv[0] = str(Path(__file__).resolve().parent / "run-ui-audit.py")
    runpy.run_path(sys.argv[0], run_name="__main__")
