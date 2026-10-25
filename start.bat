@echo off
chcp 65001 >nul
title 3D 钢琴演奏台
cd /d "%~dp0"
echo ============================================
echo   3D 钢琴演奏台  - 正在启动本地服务器...
echo ============================================
echo.

rem 尝试 python
where python >nul 2>nul
if %errorlevel%==0 (
    start "" "http://127.0.0.1:8765"
    python serve.py
    goto :eof
)
rem 尝试 py launcher
where py >nul 2>nul
if %errorlevel%==0 (
    start "" "http://127.0.0.1:8765"
    py -3 serve.py
    goto :eof
)
rem 尝试 node
where node >nul 2>nul
if %errorlevel%==0 (
    start "" "http://127.0.0.1:8765"
    node serve.js
    goto :eof
)
echo [错误] 未找到 Python 或 Node.js，无法启动本地服务器。
echo 请安装 Python 3 后重试：https://www.python.org/downloads/
pause
