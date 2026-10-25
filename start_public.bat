@echo off
REM ============================================================
REM  3D 钢琴演奏台 · 公网访问一键启动
REM  本脚本同时启动本地服务 8765 和 Cloudflare 免费公网隧道
REM  （无需账号，地址为 https://xxx.trycloudflare.com）
REM ============================================================
start "3DPiano Server" cmd /c "python serve.py"
timeout /t 3 /nobreak >nul
echo.
echo  正在建立公网隧道，请稍候（首次约 10-30 秒）...
echo  出现 "https://xxxx.trycloudflare.com" 即为公网地址，可发给任何人访问
echo  关闭本窗口 = 关闭公网地址（地址会变化）
echo.
cloudflared.exe tunnel --url http://127.0.0.1:8765 --no-autoupdate
pause
