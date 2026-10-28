@echo off
rem Plan Graph launcher for cmd and PowerShell. Each candidate is probed for Python 3.10+
rem before use, as bin/plan-graph does: `python` on Windows is often the Microsoft Store
rem stub, which prints a prompt and exits without running anything.
setlocal
set "PG_SCRIPT=%~dp0..\scripts\plan-graph.py"
set "PG_PROBE=import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if defined PLAN_GRAPH_PYTHON (
  "%PLAN_GRAPH_PYTHON%" "%PG_SCRIPT%" %*
  goto :done
)
py -3 -c "%PG_PROBE%" >nul 2>nul
if not errorlevel 1 (
  py -3 "%PG_SCRIPT%" %*
  goto :done
)
python -c "%PG_PROBE%" >nul 2>nul
if not errorlevel 1 (
  python "%PG_SCRIPT%" %*
  goto :done
)
echo plan-graph: no Python 3.10+ found (tried py -3, python); set PLAN_GRAPH_PYTHON 1>&2
endlocal & exit /b 127
:done
endlocal & exit /b %ERRORLEVEL%
