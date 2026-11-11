@echo off
rem agent-memory-managed-launcher-v2
rem Windows shim: PowerShell/cmd resolve `agent-memory` to this file instead of
rem ShellExecute-ing the extensionless bash launcher (open-with dialog).
rem Find the skill in the same order as bin/agent-memory, first match wins:
rem 1. the skill this shim ships in, when that is a plugin cache install;
rem 2. the install.sh copy under ~/.agents/skills;
rem 3. the skill beside this shim (a checkout run directly);
rem 4. the bash launcher beside this shim, which looks up Claude Code and Codex
rem    plugin installs (their paths carry the plugin version).
setlocal
set "AM_DIR=%~dp0"
set "AM_ROOT="
if not exist "%~dp0..\scripts\memory.py" goto installed
if not "%AM_DIR:\plugins\cache\=%"=="%AM_DIR%" set "AM_ROOT=%~dp0.."
if defined AM_ROOT goto run
:installed
if defined HOME if exist "%HOME%\.agents\skills\agent-memory\scripts\memory.py" set "AM_ROOT=%HOME%\.agents\skills\agent-memory"
if defined AM_ROOT goto run
if exist "%USERPROFILE%\.agents\skills\agent-memory\scripts\memory.py" set "AM_ROOT=%USERPROFILE%\.agents\skills\agent-memory"
if defined AM_ROOT goto run
if exist "%~dp0..\scripts\memory.py" set "AM_ROOT=%~dp0.."
if defined AM_ROOT goto run
if not exist "%~dp0agent-memory" goto missing
set "AM_BASH="
rem WSL's bash (System32, WindowsApps) cannot run a Windows path; Git Bash can.
for /f "delims=" %%B in ('where bash.exe 2^>nul') do if not defined AM_BASH call :pickbash "%%B"
if not defined AM_BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "AM_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined AM_BASH goto missing
set "AM_SH=%~dp0agent-memory"
"%AM_BASH%" "%AM_SH:\=/%" %*
endlocal & exit /b %ERRORLEVEL%
:missing
rem Hooks fail open: python would exit 2 here, which blocks the host's prompt.
if /i "%~1"=="hook" (
  echo {}
  endlocal & exit /b 0
)
echo agent-memory: skill not found beside this launcher, in ~/.agents/skills/agent-memory, or through bash for a plugin install 1>&2
endlocal & exit /b 127
:pickbash
set "AM_CAND=%~1"
if not "%AM_CAND:\System32\=%"=="%AM_CAND%" exit /b 0
if not "%AM_CAND:\WindowsApps\=%"=="%AM_CAND%" exit /b 0
set "AM_BASH=%AM_CAND%"
exit /b 0
:run
if exist "%AM_ROOT%\.venv\Scripts\python.exe" (
  "%AM_ROOT%\.venv\Scripts\python.exe" "%AM_ROOT%\scripts\memory.py" %*
) else (
  python "%AM_ROOT%\scripts\memory.py" %*
)
endlocal & exit /b %ERRORLEVEL%
