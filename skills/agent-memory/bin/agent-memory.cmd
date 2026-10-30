@echo off
rem agent-memory-managed-launcher-v2
rem Windows shim: PowerShell/cmd resolve `agent-memory` to this file instead of
rem ShellExecute-ing the extensionless bash launcher (open-with dialog).
setlocal
set "AM_ROOT=%USERPROFILE%\.agents\skills\agent-memory"
if defined HOME if exist "%HOME%\.agents\skills\agent-memory\scripts\memory.py" set "AM_ROOT=%HOME%\.agents\skills\agent-memory"
if exist "%AM_ROOT%\scripts\memory.py" goto run
rem Hooks fail open: python would exit 2 here, which blocks the host's prompt.
if /i "%~1"=="hook" (
  echo {}
  endlocal & exit /b 0
)
echo agent-memory: skill not found: %AM_ROOT% 1>&2
endlocal & exit /b 127
:run
if exist "%AM_ROOT%\.venv\Scripts\python.exe" (
  "%AM_ROOT%\.venv\Scripts\python.exe" "%AM_ROOT%\scripts\memory.py" %*
) else (
  python "%AM_ROOT%\scripts\memory.py" %*
)
endlocal & exit /b %ERRORLEVEL%
