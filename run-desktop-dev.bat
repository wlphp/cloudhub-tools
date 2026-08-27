@echo off
setlocal EnableExtensions
title CloudHub Tools - Desktop Development

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

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Rust Cargo was not found. Please install Rust from https://rustup.rs
  pause
  exit /b 1
)

set "VSDEV_FOUND=0"
for %%D in (
  "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Professional\Common7\Tools\VsDevCmd.bat"
  "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\Tools\VsDevCmd.bat"
) do if exist %%~D (
  call "%%~D" -arch=x64 -host_arch=x64
  set "VSDEV_FOUND=1"
  goto :vs_done
)

:vs_done
if "%VSDEV_FOUND%"=="0" echo [WARN] Visual Studio C++ build environment was not found. Tauri may fail to compile.

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
echo.
echo Starting CloudHub Tools desktop development window...
echo Close this console or press Ctrl+C to stop the development server.
echo.

npm run tauri dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Desktop development exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
