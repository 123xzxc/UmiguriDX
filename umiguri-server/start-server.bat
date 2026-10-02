@echo off
chcp 65001 >nul
setlocal
title UMIGURI 服务端
cd /d "%~dp0"

rem Generate random secrets on first run, store under data\.
rem Do NOT hardcode secrets here: this script is committed to the repo.
if not exist "data" mkdir "data"

if not exist "data\jwt-secret" (
  powershell -NoProfile -Command "[Convert]::ToBase64String((1..48|%%{Get-Random -Max 256}))" > "data\jwt-secret"
  echo [umg] 已生成 JWT 密钥: data\jwt-secret
)
if not exist "data\admin-token" (
  powershell -NoProfile -Command "[Convert]::ToBase64String((1..24|%%{Get-Random -Max 256})).Replace('+','A').Replace('/','B').Replace('=','')" > "data\admin-token"
  echo [umg] 已生成管理员令牌: data\admin-token
)

set /p UMIGURI_JWT_SECRET=<"data\jwt-secret"
set /p UMIGURI_ADMIN_TOKEN=<"data\admin-token"
if "%UMIGURI_PORT%"=="" set "UMIGURI_PORT=8787"

echo.
echo   服务地址   http://127.0.0.1:%UMIGURI_PORT%
echo   管理面板   http://127.0.0.1:%UMIGURI_PORT%/admin-panel
echo   玩家面板   http://127.0.0.1:%UMIGURI_PORT%/panel
echo   管理员令牌 %UMIGURI_ADMIN_TOKEN%
echo.
echo   管理面板要用上面这串令牌登录, 现在复制走。
echo   局域网联机: 先跑 my-ip.bat 拿到本机地址, 填进游戏启动器。
echo.

node src\index.js

echo.
echo [umg] 服务端已退出, 按任意键关闭窗口。
pause >nul