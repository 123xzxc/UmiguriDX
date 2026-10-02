@echo off
chcp 65001 >nul
title UMIGURI 原生协议服务端
cd /d "%~dp0"
echo ================================================
echo  UMIGURI 原生协议服务端(游戏内联机 + 云存档 + 网页面板)
echo  端口 8101, 数据库与 umiguri-server 共用
echo ================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 node, 请先安装 Node.js 22.5 或更高版本
  pause
  exit /b 1
)
echo  网页面板 /panel, 管理面板 /admin-panel(管理员令牌启动后会打印)
echo  按 Ctrl+C 停止服务
echo.
node src/index.js
echo.
echo 服务已退出(如果是一闪而过, 说明启动时报错了, 把上面的内容发给开发者)
pause
