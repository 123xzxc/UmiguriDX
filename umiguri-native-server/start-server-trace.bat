@echo off
chcp 65001 >nul
title UMIGURI 原生协议服务端(帧跟踪)
cd /d "%~dp0"
echo 这个脚本会打开 /sock 的逐帧日志, 用于排查联机问题。
echo 把游戏里复现一次"进房间/选曲/上报分数", 然后把输出发出来。
echo.
set UMIGURI_SOCK_TRACE=1
set UMIGURI_NATIVE_HTTP_TRACE=1
node src/index.js
pause
