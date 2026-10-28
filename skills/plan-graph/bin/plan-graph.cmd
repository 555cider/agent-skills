@echo off
rem Plan Graph launcher for cmd and PowerShell: prefers the py launcher, since
rem `python3` on Windows is often missing or the Microsoft Store stub.
setlocal
set "PG_SCRIPT=%~dp0..\scripts\plan-graph.py"
if defined PLAN_GRAPH_PYTHON (
  "%PLAN_GRAPH_PYTHON%" "%PG_SCRIPT%" %*
  goto :done
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%PG_SCRIPT%" %*
  goto :done
)
python "%PG_SCRIPT%" %*
:done
endlocal & exit /b %ERRORLEVEL%
