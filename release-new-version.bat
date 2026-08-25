@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\release-version.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Release failed. See the message above.
  pause
)

exit /b %EXIT_CODE%
