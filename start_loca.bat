@echo off
REM ============================================================
REM  3D 钢琴演奏台 · 国外免费网址一键启动（localtunnel，无需账号）
REM  每次启动会分配一个新的国外 https 网址（loca.lt）
REM ============================================================
start "3DPiano Server" cmd /c "python serve.py"
timeout /t 3 /nobreak >nul
echo.
echo  正在启动国外隧道（localtunnel），首次约 10-30 秒...
echo  看到 "your url is: https://xxx.loca.lt" 即为网址
echo  打开网址时若出现 "Tunnel Reminder" 页面，点 "Click to Continue"
echo  关闭本窗口 = 关闭网址
echo.
npx --yes localtunnel --port 8765
pause
