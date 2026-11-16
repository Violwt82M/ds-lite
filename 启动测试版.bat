@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 ds-lite 测试版...
start "" /min cmd /c "node "%~dp0serve.mjs" 7788"
timeout /t 3 >nul
start "" http://127.0.0.1:7788
echo 已打开 http://127.0.0.1:7788
echo 关闭这个窗口即可停止服务（最小化的窗口里跑着服务器）
pause
