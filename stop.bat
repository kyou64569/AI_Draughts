@echo off
REM ============================================================
REM  AI 跳棋 · 一键停止服务（后端 3001 + 前端 5180）
REM  用法：双击本文件，或 cmd 中执行 stop.bat
REM ============================================================
setlocal EnableDelayedExpansion

set "BACKEND_PORT=3001"
set "FRONTEND_PORT=5180"
set "ROOT=%~dp0"

echo [1/3] 停止后端 (端口 %BACKEND_PORT%)...
set "KILLED_BACKEND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%BACKEND_PORT% " ^| findstr "LISTENING"') do (
  echo    结束后端进程 PID %%p
  taskkill /F /PID %%p >nul 2>&1
  set "KILLED_BACKEND=1"
)
if "!KILLED_BACKEND!"=="0" echo    后端端口未占用（可能已停止）。

echo [2/3] 停止前端 (端口 %FRONTEND_PORT%)...
set "KILLED_FRONTEND=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%FRONTEND_PORT% " ^| findstr "LISTENING"') do (
  echo    结束前端进程 PID %%p
  taskkill /F /PID %%p >nul 2>&1
  set "KILLED_FRONTEND=1"
)
if "!KILLED_FRONTEND!"=="0" echo    前端端口未占用（可能已停止）。

echo [3/3] 清理锁文件与残留临时文件...
if exist "%ROOT%server\data\.backend.lock" (
  del /q "%ROOT%server\data\.backend.lock" >nul 2>&1
  echo    已删除锁文件 .backend.lock
)
for %%f in ("%ROOT%server\data\*.tmp") do (
  if exist "%%f" del /q "%%f" >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

echo.
echo 服务已全部停止，可重新双击 ai-draughts-launch.bat 启动。
echo.
pause
