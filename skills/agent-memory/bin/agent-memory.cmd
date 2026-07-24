@echo off
rem agent-memory-managed-launcher-v2
rem Windows shim: PowerShell/cmd resolve `agent-memory` to this file instead of
rem ShellExecute-ing the extensionless bash launcher (open-with dialog).
setlocal
set "AM_ROOT=%USERPROFILE%\.agents\skills\agent-memory"
if defined HOME if exist "%HOME%\.agents\skills\agent-memory\scripts\memory.py" set "AM_ROOT=%HOME%\.agents\skills\agent-memory"
if exist "%AM_ROOT%\.venv\Scripts\python.exe" (
  "%AM_ROOT%\.venv\Scripts\python.exe" "%AM_ROOT%\scripts\memory.py" %*
) else (
  python "%AM_ROOT%\scripts\memory.py" %*
)
endlocal & exit /b %ERRORLEVEL%
