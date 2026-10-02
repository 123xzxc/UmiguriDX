// HTTP 服务装配: 建库 + 挂路由 + 定时清理。

import { createServer } from "node:http";
import { config } from "./config.js";
import { openDb, closeDb } from "./lib/db.js";
import { buildRouter, authResolver } from "./routes/index.js";
import { reapIdleRooms } from "./rooms.js";
import { reapExpiredAdminSessions } from "./admin-panel.js";
import { randomBytes } from "node:crypto";

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
      // 管理员令牌: 未配置时随机生成并打印。它是建号/发卡的唯一凭据,
      // 每次重启都换一把(除非设了 UMIGURI_ADMIN_TOKEN), 避免默认值被猜到。
      if (!config.adminToken) {
        config.adminToken = randomBytes(24).toString("base64url");
        console.log("[umg-server] 管理员令牌(本次运行有效): " + config.adminToken);
        console.log("[umg-server] 建号示例:");
        console.log("  curl -X POST http://127.0.0.1:" + shown + "/admin/users" +
          " -H \"content-type: application/json\"" +
          " -H \"authorization: Bearer " + config.adminToken + "\"" +
          " -d '{\"username\":\"yourname\"}'");
      }
    }
  });

  // 定时维护: 回收空闲房间 + 清过期面板会话。
  // 过期会话不清理也能用(校验时会拒), 但会一直堆在库里。
  const timer = setInterval(() => {
    try {
      reapIdleRooms();
      reapExpiredAdminSessions();
    } catch (e) {
      if (config.logLevel !== "silent") console.error("[umg-server] 定时维护失败:", e);
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
