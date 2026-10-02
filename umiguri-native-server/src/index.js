#!/usr/bin/env node
// 服务端入口: node src/index.js
//
// 同一个端口同时提供两件事(客户端就是这么设计的, 它连的是 http://<host>:8101):
//   - POST /1/...  游戏原生 HTTP(登录/云存档/成绩), 见 native-http.js
//   - GET  /sock   游戏内联机 WebSocket, 见 sock.js

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { config } from "./config.js";
import { closeDb, openDb } from "./lib/db.js";
import { isWebSocketUpgrade } from "./lib/ws.js";
import { handleNativeHttp } from "./native-http.js";
import { handleSocketUpgrade } from "./sock.js";

function localAddresses() {
  const out = [];
  const nics = networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const info of nics[name] || []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export function startServer({ port = config.port, host = config.host } = {}) {
  openDb();

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      res.writeHead(400).end();
      return;
    }
    handleNativeHttp(req, res, url)
      .then((handled) => {
        if (handled) return;
        const payload = JSON.stringify({ result: "bad" });
        res.writeHead(404, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload)
        });
        res.end(payload);
      })
      .catch((err) => {
        console.error("[native] 处理请求失败:", err);
        if (!res.headersSent) {
          const payload = JSON.stringify({ result: "bad" });
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(payload);
        } else {
          res.end();
        }
      });
  });

  // 联机握手: 只有 /sock 是 WebSocket, 其它 upgrade 直接断开。
  server.on("upgrade", (req, socket, head) => {
    let path = "";
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (path !== "/sock" || !isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }
    handleSocketUpgrade(req, socket, head);
  });

  server.listen(port, host, () => {
    if (config.logLevel === "silent") return;
    const addr = server.address();
    const shown = typeof addr === "object" && addr ? addr.port : port;
    console.log("[umg-native] 监听 " + host + ":" + shown);
    console.log("[umg-native] 数据库 " + config.dbPath);
    console.log("[umg-native] 游戏里把联机地址指到本机即可, 例如:");
    for (const ip of localAddresses()) console.log("             http://" + ip + ":" + shown);
    console.log("             (本机自测可用 http://127.0.0.1:" + shown + ")");
    if (config.traceSock) console.log("[umg-native] 已开启 /sock 帧跟踪(UMIGURI_SOCK_TRACE=1)");
  });

  const shutdown = () => {
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("src/index.js");
if (invokedDirectly) startServer();
