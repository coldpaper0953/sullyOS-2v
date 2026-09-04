@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  SullyOS 本地全套一键启动（SillyTavern 式，仓库根目录版）
rem  1) backend: docker compose 起 PG + migrate + api（127.0.0.1:43210）
rem  2) 前端: 4173 端口静态服务（需要先 pnpm install + pnpm build 出 dist）
rem  3) 开浏览器 http://127.0.0.1:4173
rem ─────────────────────────────────────────────────────────────
cd /d "%~dp0"

rem ── Node 探测（静态服务用）──
set "NODE_EXE="
where node >nul 2>nul && for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.node\node.exe" set "NODE_EXE=%USERPROFILE%\.node\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

rem ── Docker 探测 ──
set "DOCKER_EXE="
where docker >nul 2>nul && for /f "delims=" %%i in ('where docker') do if not defined DOCKER_EXE set "DOCKER_EXE=%%i"
if not defined DOCKER_EXE if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" set "DOCKER_EXE=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
if defined DOCKER_EXE (
  echo [1/4] 检查 Docker…
  "%DOCKER_EXE%" info >nul 2>nul
  if errorlevel 1 (
    echo   Docker 未运行。先启动 Docker Desktop 再重新跑本脚本。
    if defined NODE_EXE start "" "%NODE_EXE%" "scripts\local-static-server.cjs" "dist"
    if defined NODE_EXE start "" "http://127.0.0.1:4173"
    pause
    exit /b 1
  )
) else (
  echo 未找到 docker，跳过后端（只起 4173 前端静态服务）。
  if defined NODE_EXE start "" "%NODE_EXE%" "scripts\local-static-server.cjs" "dist"
  if defined NODE_EXE start "" "http://127.0.0.1:4173"
  pause
  exit /b 0
)

echo [2/4] 启动 backend（postgres + migrate + api，只在 127.0.0.1:43210）…
pushd backend
"%DOCKER_EXE%" compose up -d --build
set "COMPOSE_RC=%errorlevel%"
popd
if not "%COMPOSE_RC%"=="0" (
  echo compose 启动失败，退出码 %COMPOSE_RC%。检查 backend\.env 与 Docker 状态。
  pause
  exit /b 1
)

echo [3/4] 等 API 就绪（最长 60 秒）…
set /a WAITED=0
:wait_api
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:43210/health' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  if %WAITED% lss 60 (
    set /a WAITED+=2
    timeout /t 2 /nobreak >nul
    goto wait_api
  )
  echo API 60 秒内没就绪。用 docker compose logs api 看日志。
) else (
  echo   API 已就绪: http://127.0.0.1:43210/health
)

echo [4/4] 起前端静态服务并打开浏览器…
if not defined NODE_EXE (
  echo 未找到 Node，无法起 4173 静态服务；后端仍在运行。
  pause
  exit /b 1
)
set "APP_URL=http://127.0.0.1:4173"
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri '%APP_URL%' -UseBasicParsing -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  if not exist dist\index.html (
    echo dist 不存在：先在本目录跑 pnpm install ^&^& pnpm build。
  )
  start "" "%NODE_EXE%" "scripts\local-static-server.cjs" "dist"
  timeout /t 2 /nobreak >nul
)
start "" "%APP_URL%"
echo 全套已启动：后端 http://127.0.0.1:43210  前端 http://127.0.0.1:4173
echo 窗口可以关掉；停止后端用: cd backend ^&^& docker compose down
timeout /t 5 >nul
exit /b 0
