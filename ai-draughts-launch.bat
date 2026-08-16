@echo off
REM [REMOVED self-unblock line] Old top line ran powershell Unblock-File on %~f0 and caused
REM cmd to report "command syntax incorrect" due to nested quotes, braces and redirection
REM under the default codepage. Script runs locally with no Mark-of-the-Web lock, so the
REM unblock is unneeded. To unblock a downloaded file manually, run in PowerShell:
REM   Unblock-File -Path "full-path-to-file.cmd"
setlocal EnableExtensions
cd /d "%~dp0"
set "ROOT=%~dp0"
set "BACKEND_PORT=3001"
set "FRONTEND_PORT=5180"
set "LOG=%ROOT%start.log"

echo [%date% %time%] start.bat invoked > "%LOG%"
echo ============================================================ >> "%LOG%"

REM ---- 0. Safety guard: do NOT start a second install while one may be running ----
REM (handled by the user; this script only installs if deps are clearly missing)

REM ---- 1. Make sure node/npm are on PATH (managed runtime + system) ----
set "NODE_OK=0"
if exist "C:\Users\asus\.workbuddy\binaries\node\versions\22.22.2\node.exe" (
  set "PATH=C:\Users\asus\.workbuddy\binaries\node\versions\22.22.2;%PATH%"
  set "NODE_OK=1"
)
if exist "C:\Program Files\nodejs\node.exe" (
  set "PATH=C:\Program Files\nodejs;%PATH%"
  set "NODE_OK=1"
)
where node >> "%LOG%" 2>&1
if not "%NODE_OK%"=="1" (
  echo [ERROR] node.exe not found on PATH. >> "%LOG%"
  echo.
  echo [ERROR] 未在系统 PATH 中找到 node。请先安装 Node.js，或在已含 node 的终端里运行本脚本。
  echo 详情见 %LOG%
  pause
  goto :eof
)

REM ---- 2. Install backend deps only if missing ----
if not exist "%ROOT%server\node_modules\express" (
  echo [1/4] Installing backend dependencies... >> "%LOG%"
  echo [1/4] 正在安装后端依赖（首次较慢）...
  pushd "%ROOT%server"
  call npm install --prefer-offline --no-audit --no-fund >> "%LOG%" 2>&1
  if errorlevel 1 (
    popd
    echo [ERROR] backend npm install failed. >> "%LOG%"
    echo.
    echo [ERROR] 后端依赖安装失败，详见 %LOG%
    pause
    goto :eof
  )
  popd
)

REM ---- 3. Install frontend deps only if missing ----
if not exist "%ROOT%client\node_modules\.bin\vite" (
  echo [2/4] Installing frontend dependencies - first run is slow, using cache + npmmirror... >> "%LOG%"
  echo [2/4] 正在安装前端依赖（首次较慢，已用本地缓存+npmmirror 镜像）...
  pushd "%ROOT%client"
  call npm install --registry=https://registry.npmjs.org --no-audit --no-fund --fetch-retries=5 >> "%LOG%" 2>&1
  if errorlevel 1 (
    popd
    echo [ERROR] frontend npm install failed. >> "%LOG%"
    echo.
    echo [ERROR] 前端依赖安装失败，详见 %LOG%
    pause
    goto :eof
  )
  popd
)

REM ---- 4.0 Single-instance guard: refuse to start a second backend ----
netstat -ano | findstr ":%BACKEND_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [提示] 后端已在运行（端口 %BACKEND_PORT%），无需重复启动。
  echo        若确需重启：请先关闭现有后端窗口（或任务管理器结束 node），再运行本脚本。
  echo        重复启动会导致多个后端进程争锁数据文件，引发写入失败。
  echo.
  pause
  exit /b 0
)
REM ---- 4. Start backend (new window, port %BACKEND_PORT%, logs -> backend.log) ----
echo [3/4] Starting backend on port %BACKEND_PORT%... >> "%LOG%"
echo [3/4] 启动后端 (port %BACKEND_PORT%)...
start "AI-Draughts Backend" cmd /k "cd /d %ROOT%server && set PORT=%BACKEND_PORT% && node start.mjs > %ROOT%backend.log 2>&1"

REM ---- 5. Start frontend (new window, Vite dev on %FRONTEND_PORT%, logs -> frontend.log) ----
echo [4/4] Starting frontend on port %FRONTEND_PORT%... >> "%LOG%"
echo [4/4] 启动前端 (port %FRONTEND_PORT%)...
start "AI-Draughts Frontend" cmd /k "cd /d %ROOT%client && npm run dev -- --port %FRONTEND_PORT% > %ROOT%frontend.log 2>&1"

REM ---- Open browser after a short wait ----
timeout /t 6 >nul
start "" "http://localhost:%FRONTEND_PORT%/"

echo. >> "%LOG%"
echo ============================================================ >> "%LOG%"
echo  Backend : http://localhost:%BACKEND_PORT% >> "%LOG%"
echo  Frontend: http://localhost:%FRONTEND_PORT%/ >> "%LOG%"
echo ============================================================ >> "%LOG%"

echo.
echo ============================================================
echo  后端  : http://localhost:%BACKEND_PORT%
echo  前端  : http://localhost:%FRONTEND_PORT%/
echo  两个控制台窗口正在运行服务（关闭它们即可停止）。
echo  日志文件: start.log / backend.log / frontend.log
echo ============================================================
echo.
echo  若前端页面打不开，请把 backend.log 和 frontend.log 的内容发我排查。
echo.
pause

