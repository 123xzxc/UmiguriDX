// HTTP 服务装配: 建库 + 挂路由 + 定时清理。

import { createServer } from "node:http";
import { config } from "./config.js";
import { openDb, closeDb } from "./lib/db.js";
import { buildRouter, authResolver } from "./routes/index.js";
import { reapIdleRooms } from "./rooms.js";

export function createApp() {
  openDb();
  const router = buildRouter();
  return createServer(router.handler(authResolver));
}

export function startServer({ port = config.port, host = config.host } = {}) {
  const server = createApp();

  server.listen(port, host, () => {
    if (config.logLevel !== "silent") {
      const addr = server.address();
      const shown = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[umg-server] 监听 http://${host}:${shown}`);
      console.log(`[umg-server] 数据库 ${config.dbPath}`);
      if (config.jwtSecret === "umiguri-dev-secret-change-me") {
        console.warn("[umg-server] 警告: 正在使用默认 JWT 密钥, 生产部署请设置 UMIGURI_JWT_SECRET");
      }
    }
  });

  // 空闲房间回收
  const timer = setInterval(() => {
    try {
      reapIdleRooms();
    } catch (e) {
      if (config.logLevel !== "silent") console.error("[umg-server] 房间清理失败:", e);
    }
  }, 60 * 1000);
  timer.unref?.();

  const shutdown = () => {
    clearInterval(timer);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
