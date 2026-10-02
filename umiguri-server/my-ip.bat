@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if "%UMIGURI_PORT%"=="" set "UMIGURI_PORT=8787"

echo 本机在局域网里的地址(游戏启动器里填其中一个):
echo.
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { '   http://' + $_.IPAddress + ':8787' }"
echo.
echo 同一 WiFi / 局域网内的机器可用。异地玩家需要内网穿透或公网服务器。
echo.
pause >nul