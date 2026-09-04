@echo off
setlocal
cd /d "%~dp0"

rem Node 探测链：先找 PATH，再扫常见安装位置，都找不到才报错退出。
set "NODE_EXE="
where node >nul 2>nul && for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.node\node.exe" set "NODE_EXE=%USERPROFILE%\.node\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo Node.js not found: not in PATH, Program Files, %%USERPROFILE%%\.node or LocalAppData.
  pause
  exit /b 1
)

set "APP_URL=http://127.0.0.1:4173"

powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "" "%NODE_EXE%" "scripts\local-static-server.cjs" "dist"
  timeout /t 2 /nobreak >nul
)

start "" "%APP_URL%"
