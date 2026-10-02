// HTTP 服务装配: 建库 + 挂路由 + 定时清理。

import { createServer } from "node:http";
import { config } from "./config.js";
import { openDb, closeDb } from "./lib/db.js";
import { buildRouter, authResolver } from "./routes/index.js";
import { reapIdleRooms } from "./rooms.js";
import { ADMIN_TOKEN_PATH, ensureAdminToken, reapExpiredAdminSessions } from "./admin-panel.js";

export function createApp() {
  openDb();
  const router = buildRouter();
  return createServer(router.handler(authResolver));
}

export function startServer({ port = config.port, host = config.host } = {}) {
  const server = createApp();

  // 管理员令牌: 环境变量 > data/admin-token > 随机生成并写盘(见 admin-panel.js)。
  // 必须在 listen 之前准备好 —— 否则日志静默的部署里这个进程根本没有管理令牌。
  const adminToken = ensureAdminToken();

  server.listen(port, host, () => {
    if (config.logLevel !== "silent") {
      const addr = server.address();
      const shown = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[umg-server] 监听 http://${host}:${shown}`);
      console.log(`[umg-server] 数据库 ${config.dbPath}`);
      if (config.jwtSecret === "umiguri-dev-secret-change-me") {
        console.warn("[umg-server] 警告: 正在使用默认 JWT 密钥, 生产部署请设置 UMIGURI_JWT_SECRET");
      }
      console.log("[umg-server] 玩家面板 http://127.0.0.1:" + shown + "/panel");
      console.log("[umg-server] 管理面板 http://127.0.0.1:" + shown + "/admin-panel");
      // 管理员令牌是建号/发卡的唯一凭据, 打印出来好复制。
      console.log("[umg-server] 管理员令牌 " + adminToken + " (存于 " + ADMIN_TOKEN_PATH + ")");
      console.log("[umg-server] 建号示例:");
      console.log("  curl -X POST http://127.0.0.1:" + shown + "/admin/users" +
        " -H \"content-type: application/json\"" +
        " -H \"authorization: Bearer " + adminToken + "\"" +
        " -d '{\"username\":\"yourname\"}'");
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
