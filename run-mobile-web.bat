@echo off
setlocal EnableExtensions
title CloudHub Tools - Mobile Web Debug

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 1421); exit 0 } catch { exit 1 } finally { $client.Dispose() }"
if errorlevel 1 (
  start "CloudHub Tools Mobile Web Debug" /D "%~dp0" cmd /k "set VITE_DEV_PORT=1421&& npm run dev:mobile"
) else (
  rem An existing frontend does not imply that its API is still running.
  powershell -NoProfile -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 1430); exit 0 } catch { exit 1 } finally { $client.Dispose() }"
  if errorlevel 1 (
    start "CloudHub Tools Mobile Web API" /D "%~dp0" cmd /k "npm run web:api"
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready = $false; for ($i = 0; $i -lt 60; $i++) { try { $front = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:1421' -TimeoutSec 1; $api = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:1430/api/accounts' -TimeoutSec 1; $ready = ($front.StatusCode -eq 200 -and $api.StatusCode -eq 200) } catch { $ready = $false }; if ($ready) { break }; Start-Sleep -Milliseconds 500 }; if ($ready) { Start-Process 'http://127.0.0.1:1421'; exit 0 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Mobile Web Debug or its API did not become ready.
  echo Frontend: http://127.0.0.1:1421  API: http://127.0.0.1:1430/api/accounts
  echo Check the debug console for a port conflict or startup error.
  pause
  exit /b 1
)

echo Mobile Web Debug is open at http://127.0.0.1:1421
exit /b 0
