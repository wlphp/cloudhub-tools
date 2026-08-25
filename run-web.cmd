@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js was not found. Please install Node.js and try again.
  pause
  exit /b 1
)

where npm >nul 2>nul || (
  echo npm was not found. Please install Node.js and try again.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$listener = Get-NetTCPConnection -State Listen -LocalPort 1430 -ErrorAction SilentlyContinue; if ($listener) { exit 0 }; exit 1"
if errorlevel 1 (
  start "CloudHub Tools Web API" /b cmd /c "node web-api.mjs"
  powershell -NoProfile -Command "Start-Sleep -Seconds 1"
)

powershell -NoProfile -Command "$listener = Get-NetTCPConnection -State Listen -LocalPort 1420 -ErrorAction SilentlyContinue; if ($listener) { exit 0 }; exit 1"
if not errorlevel 1 (
  start "" "http://127.0.0.1:1420"
  exit /b 0
)

npm run dev -- --host 0.0.0.0
