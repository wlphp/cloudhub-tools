@echo off
setlocal EnableExtensions
title CloudHub Tools - Desktop Development

cd /d "%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

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
) do if exist "%%~D" (
  call "%%~D" -arch=x64 -host_arch=x64
  set "VSDEV_FOUND=1"
  goto :vs_done
)

:vs_done
if "%VSDEV_FOUND%"=="0" echo [WARN] Visual Studio C++ build environment was not found. Tauri may fail to compile.

rem whisper-rs uses bindgen, which needs the libclang shared library.
rem Keep an explicit user configuration; otherwise try LLVM and pip installations.
if defined LIBCLANG_PATH goto :clang_done
for %%D in (
  "%ProgramFiles%\LLVM\bin"
  "%ProgramFiles%\LLVM\lib"
) do (
  if exist "%%~D\libclang.dll" (
    set "LIBCLANG_PATH=%%~D"
    goto :clang_done
  )
  if exist "%%~D\clang.dll" (
    set "LIBCLANG_PATH=%%~D"
    goto :clang_done
  )
)
for /d %%P in ("%APPDATA%\Python\Python*" "%LOCALAPPDATA%\Programs\Python\Python*") do (
  for %%S in (site-packages Lib\site-packages) do (
    if exist "%%~P\%%S\clang\native\libclang.dll" (
      set "LIBCLANG_PATH=%%~P\%%S\clang\native"
      goto :clang_done
    )
  )
)

:clang_done
if not defined LIBCLANG_PATH (
  echo [ERROR] libclang was not found. Install LLVM or set LIBCLANG_PATH to its DLL directory.
  pause
  exit /b 1
)
echo.
echo Starting CloudHub Tools desktop development window...
echo Close this console or press Ctrl+C to stop the development server.
echo.

rem 开发版使用独立 identifier，避免与生产版共用同一个 WebView2 用户数据目录
rem (%LOCALAPPDATA%\com.wanglei.cloudhub.tools\EBWebView) 导致后者启动即崩溃。
call npm run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Desktop development exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
