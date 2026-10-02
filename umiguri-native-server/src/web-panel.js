// 网页面板桥: 把 umiguri-server 的网页面板(/panel + /admin-panel)挂到原生服务端上。
//
// 两个服务端本来就是同一套账号库(共用 data/umiguri.db), 区别只在协议:
//   umiguri-server        —— 游戏端旧 REST + 面板, 端口 8787
//   umiguri-native-server —— 游戏端原生协议(/1/* 与 /sock) + 面板(本文件), 端口 8101
// 于是"联机"和"开面板"只需要跑一个进程, 不用记两个端口、开两个窗口。
//
// 挂载必须做对三件事:
//   1. 共用一个数据库连接。同一个进程里对同一个库开两个写连接, 一旦并发写就会
//      互相卡住(SQLite 的 busy_timeout 是跨进程用的, 同进程内那个锁等不到),
//      所以把原生服务端已经打开的连接交给 umiguri-server 的 db 模块(attachDb)。
//   2. 共用同一套表。面板要 panel_sessions / admin_sessions / plays / bests,
//      这些表定义在 umiguri-server/src/lib/db.js, 用 migrateSchema() 补齐(幂等)。
//   3. 只接面板相关的路径。原生服务端先处理自己的 /1/* 与 /sock, 未命中才轮到
//      面板, 所以面板不可能挡住游戏。

import { buildPanelRouter, authResolver } from "../../umiguri-server/src/routes/index.js";
import { attachDb, migrateSchema } from "../../umiguri-server/src/lib/db.js";
import { ADMIN_TOKEN_PATH, ensureAdminToken } from "../../umiguri-server/src/admin-panel.js";
import { getDb } from "./lib/db.js";

// /panel 玩家面板(用户名 + TOTP), /admin-panel 管理面板(管理员令牌换会话),
// /admin 是同一批管理能力的 Bearer 接口, 给脚本和 CI 用。
const PANEL_PREFIXES = ["/panel", "/admin-panel", "/admin"];

export function isPanelPath(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PANEL_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
}

// 在 openDb() 之后调用一次。返回的 handle(req, res, url) 与 native-http 的约定一致:
// true = 已经处理, false = 不是面板的路径, 调用方接着走自己的 404。
export function installWebPanel() {
  attachDb(getDb());
  migrateSchema();

  const handler = buildPanelRouter().handler(authResolver, { passthrough: true });
  const adminToken = ensureAdminToken();

  return {
    adminToken,
    adminTokenPath: ADMIN_TOKEN_PATH,
    async handle(req, res, url) {
      if (!isPanelPath(url.pathname)) return false;
      return (await handler(req, res)) !== false;
    }
  };
}
