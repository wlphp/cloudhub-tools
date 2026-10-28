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
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready = $false; for ($i = 0; $i -lt 120; $i++) { $client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 1421); $ready = $true } catch {} finally { $client.Dispose() }; if ($ready) { break }; Start-Sleep -Milliseconds 500 }; if ($ready) { Start-Process 'http://127.0.0.1:1421'; exit 0 }; exit 1"
if errorlevel 1 (
  echo [ERROR] Mobile Web Debug did not become ready at http://127.0.0.1:1421.
  echo Check the debug console for a port conflict or startup error.
  pause
  exit /b 1
)

echo Mobile Web Debug is open at http://127.0.0.1:1421
exit /b 0
