// 面板与旧 REST 桥: 把 umiguri-server 的网页面板(/panel + /admin-panel + /admin)
// 和游戏端旧 REST(/auth、/profile、/plays、/cards、/leaderboard、/rooms)
// 一起挂到原生服务端上。
//
// 两个服务端本来就是同一套账号库(共用 data/umiguri.db), 区别只在协议:
//   umiguri-server        —— 游戏端旧 REST + 面板, 端口 8787
//   umiguri-native-server —— 游戏端原生协议(/1/* 与 /sock) + 面板 + 旧 REST(本文件),
//                            端口 8101
// 于是"联机""开面板""启动器登录"只需要跑一个进程, 不用记两个端口、开两个窗口。
//
// 挂载必须做对三件事:
//   1. 共用一个数据库连接。同一个进程里对同一个库开两个写连接, 一旦并发写就会
//      互相卡住(SQLite 的 busy_timeout 是跨进程用的, 同进程内那个锁等不到),
//      所以把原生服务端已经打开的连接交给 umiguri-server 的 db 模块(attachDb)。
//   2. 共用同一套表。面板要 panel_sessions / admin_sessions / plays / bests,
//      旧 REST 要 users / cards / rooms, 这些表定义在 umiguri-server/src/lib/db.js,
//      用 migrateSchema() 补齐(幂等)。
//   3. 只接自己那批路径。原生服务端先处理自己的 /1/* 与 /sock, 未命中才轮到这两套
//      router, 所以它们不可能挡住游戏。
//
// 旧 REST 为什么也要挂: 启动器(宿主里的联机面板)与自制前端用的是 umiguri-server
// 那套 REST。不挂的话, 玩家把启动器里的服务端地址填成 8101, 每个请求都会 404 ——
// 这正是"连不上新服务端"的常见原因。

import { buildPanelRouter, buildRestRouter, authResolver } from "../../umiguri-server/src/routes/index.js";
import { attachDb, migrateSchema } from "../../umiguri-server/src/lib/db.js";
import { ADMIN_TOKEN_PATH, ensureAdminToken } from "../../umiguri-server/src/admin-panel.js";
import { config as serverConfig } from "../../umiguri-server/src/config.js";
import { getDb } from "./lib/db.js";

// /panel 玩家面板(用户名 + TOTP), /admin-panel 管理面板(管理员令牌换会话),
// /admin 是同一批管理能力的 Bearer 接口, 给脚本和 CI 用。
const PANEL_PREFIXES = ["/panel", "/admin-panel", "/admin"];
// 游戏端旧 REST 的入口前缀。都是一级路径, 与原生服务端的 /1/* 不可能撞车。
const REST_PREFIXES = ["/auth", "/profile", "/plays", "/cards", "/leaderboard", "/rooms"];

function matchesPrefix(pathname, prefixes) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return prefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

export function isPanelPath(pathname) {
  return matchesPrefix(pathname, PANEL_PREFIXES);
}

export function isRestPath(pathname) {
  return matchesPrefix(pathname, REST_PREFIXES);
}

// 这两套 router 里到底有没有可能处理这个路径。返回 false 就说明请求该走原生服务端
// 自己的 404。
export function shouldHandle(pathname) {
  return isPanelPath(pathname) || isRestPath(pathname);
}

// 在 openDb() 之后调用一次。返回的 handle(req, res, url) 与 native-http 的约定一致:
// true = 已经处理, false = 不归这两套 router 管, 调用方接着走自己的 404。
export function installWebPanel() {
  attachDb(getDb());
  migrateSchema();

  const panelHandler = buildPanelRouter().handler(authResolver, { passthrough: true });
  const restHandler = buildRestRouter().handler(authResolver, { passthrough: true });
  const adminToken = ensureAdminToken();

  // 旧 REST 用 umiguri-server 的 JWT 密钥签发 token, 默认值仅供本地开发。
  if (serverConfig.logLevel !== "silent" && serverConfig.jwtSecret === "umiguri-dev-secret-change-me") {
    console.warn("[umg-native] 警告: 旧 REST 正在使用默认 JWT 密钥, 生产部署请设置 UMIGURI_JWT_SECRET");
  }

  return {
    adminToken,
    adminTokenPath: ADMIN_TOKEN_PATH,
    async handle(req, res, url) {
      if (!shouldHandle(url.pathname)) return false;
      if (isPanelPath(url.pathname) && (await panelHandler(req, res)) !== false) return true;
      return (await restHandler(req, res)) !== false;
    }
  };
}
