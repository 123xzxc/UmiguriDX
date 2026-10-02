// 全部路由注册。
//
// 三套入口, 凭据各不相同:
//   /auth/card       游戏端 —— 卡号即登录, 无密码
//   /panel/*         网页面板 —— 用户名 + TOTP(见 panel.js), cookie 会话
//   /admin/*         管理(接口) —— Bearer UMIGURI_ADMIN_TOKEN, 供脚本/CI 调用
//   /admin-panel/*   管理(网页) —— 管理员令牌换 cookie 会话, 供人工操作
// 游玩记录与房间接口仍走游戏端 JWT(游戏是唯一的产生者)。

import { timingSafeEqual } from "node:crypto";
import { createRouter, notFound, badRequest } from "../lib/http.js";
import { verifyToken } from "../lib/token.js";
import { assertUsername, assertRoomCode, assertInt } from "../lib/validate.js";
import { assertCardId } from "../lib/card.js";
import { createUser, getUserById, listUsers, resetTotp, updateProfile } from "../users.js";
import { findCard, issueCard, listCards, resolveCard, revokeCard } from "../cards.js";
import { otpauthUrl } from "../lib/totp.js";
import {
  clearCookieHeader, cookieHeader, destroyPanelSession, loginWithTotp,
  requirePanelSession, resolvePanelSession
} from "../panel.js";
import { config } from "../config.js";
import { listBests, listPlays, musicLeaderboard, recordPlay, totalLeaderboard } from "../plays.js";
import {
  createRoom, finishMatch, getRoomState, joinRoom, leaveRoom,
  reportProgress, selectMusic, setReady, startMatch
} from "../rooms.js";
import { issueToken } from "../lib/token.js";
import { renderPanel } from "../panel-ui.js";
import { ADMIN_PAGE } from "../admin-ui.js";
import {
  adminCookieHeader, clearAdminCookieHeader, clientIp, destroyAdminSession,
  loginAdmin, requireAdminSession, resolveAdminSession
} from "../admin-panel.js";

// 从 Authorization 头解析并校验 JWT(游戏端)
function authResolver(req) {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const claims = verifyToken(m[1]);
  if (!claims || typeof claims.sub !== "number") return null;
  const user = getUserById(claims.sub);
  return user ? { userId: user.id, user } : null;
}

// 管理员鉴权。用固定时间比较, 避免按字符比对泄露 token。
function requireAdmin(req) {
  const header = req.headers["authorization"];
  const token = config.adminToken;
  if (!token) throw notFound("管理员接口未启用", "admin_disabled");
  const m = typeof header === "string" ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!m) throw badRequest("缺少管理员令牌", "admin_unauthorized");
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw badRequest("管理员令牌不正确", "admin_unauthorized");
  }
}

export function buildRouter() {
  const r = createRouter();
  registerGameRoutes(r);
  registerPanelRoutes(r);
  return r;
}

// 只挂网页面板的 router。
// 原生服务端(umiguri-native-server)用它把面板挂到自己的 HTTP 循环上, 这样
// 玩家只跑一个进程就能既联机又开面板。
export function buildPanelRouter() {
  const r = createRouter();
  registerPanelRoutes(r);
  return r;
}

// 只挂游戏端旧 REST 的 router: /auth、/profile、/plays、/cards、/leaderboard、/rooms。
// 也是给原生服务端用的: 启动器和自制面板走的是这套 REST, 玩家把启动器里的服务端
// 地址填成 8101 时, 如果 8101 上只有 /1/*, 每个请求都会 404。
// 两套 router 的响应格式不同(这套是 {ok:...}, 原生是 {result:...}), 所以只能并存,
// 不能合并 —— 各自的客户端按各自的约定解析。
export function buildRestRouter() {
  const r = createRouter();
  registerGameRoutes(r);
  return r;
}

function registerGameRoutes(r) {
  // ---------- 健康检查 ----------
  r.get("/health", () => ({ status: "ok", time: Date.now() }));

  // ---------- 游戏端: 卡号登录(无密码) ----------
  // 卡号是唯一凭据。返回的 token 与面板会话无关, 只用于游戏接口。
  r.post("/auth/card", ({ body }) => {
    const cardId = assertCardId(body.cardId);
    const card = resolveCard(cardId);
    const user = getUserById(card.userId);
    return { token: issueToken({ sub: user.id, username: user.username }), user, card };
  });

  // 已登录时校验卡号是否仍有效(游戏启动时确认自己没被换卡)
  r.get("/auth/whoami", ({ auth }) => ({ user: auth.user }), { auth: true });

  // ---------- 卡号自助管理(需游戏端登录态) ----------
  r.get("/cards", ({ auth }) => ({ cards: listCards(auth.userId) }), { auth: true });
  r.post("/cards", ({ auth, body }) => ({
    card: issueCard(auth.userId, { cardId: body.cardId, label: body.label })
  }), { auth: true });
  r.delete("/cards/:cardId", ({ auth, params }) => ({
    card: revokeCard(auth.userId, params.cardId)
  }), { auth: true });

  // ---------- 个人资料: 用户名与称号 ----------
  r.get("/profile", ({ auth }) => ({ user: auth.user }), { auth: true });

  r.patch("/profile", ({ auth, body }) => {
    const user = updateProfile(auth.userId, {
      displayName: body.displayName,
      nameplate: body.nameplate,
      title: body.title
    });
    return { user };
  }, { auth: true });

  // ---------- 游玩记录 ----------
  r.post("/plays", ({ auth, body }) => recordPlay(auth.userId, body), { auth: true });

  r.get("/plays", ({ auth, query }) => ({
    plays: listPlays(auth.userId, {
      limit: query.get("limit") ?? 50,
      offset: query.get("offset") ?? 0
    })
  }), { auth: true });

  r.get("/plays/best", ({ auth }) => ({ bests: listBests(auth.userId) }), { auth: true });

  // ---------- 排行榜 ----------
  r.get("/leaderboard", ({ query }) => {
    const musicId = query.get("musicId");
    if (!musicId) return { total: totalLeaderboard({ limit: query.get("limit") ?? 50 }) };
    const difficulty = assertInt(query.get("difficulty") ?? 0, "difficulty", { min: 0, max: 10 });
    return {
      musicId,
      difficulty,
      entries: musicLeaderboard(musicId, difficulty, { limit: query.get("limit") ?? 50 })
    };
  });

  // ---------- 房间(游戏端) ----------
  r.post("/rooms", ({ auth, body }) => ({
    room: createRoom(auth.userId, { musicId: body.musicId, difficulty: body.difficulty })
  }), { auth: true });

  r.post("/rooms/:code/join", ({ auth, params }) => ({
    room: joinRoom(auth.userId, assertRoomCode(params.code))
  }), { auth: true });

  r.post("/rooms/:code/leave", ({ auth, params }) => ({
    result: leaveRoom(auth.userId, assertRoomCode(params.code))
  }), { auth: true });

  r.post("/rooms/:code/ready", ({ auth, params, body }) => {
    const ready = body.ready === undefined ? true : !!body.ready;
    return { room: setReady(auth.userId, assertRoomCode(params.code), ready) };
  }, { auth: true });

  r.post("/rooms/:code/music", ({ auth, params, body }) => ({
    room: selectMusic(auth.userId, assertRoomCode(params.code), {
      musicId: body.musicId,
      difficulty: body.difficulty
    })
  }), { auth: true });

  r.post("/rooms/:code/start", ({ auth, params }) => ({
    room: startMatch(auth.userId, assertRoomCode(params.code))
  }), { auth: true });

  r.post("/rooms/:code/finish", ({ auth, params }) => ({
    room: finishMatch(auth.userId, assertRoomCode(params.code))
  }), { auth: true });

  r.post("/rooms/:code/progress", ({ auth, params, body }) => ({
    room: reportProgress(auth.userId, assertRoomCode(params.code), {
      score: body.score,
      progress: body.progress
    })
  }), { auth: true });

  r.get("/rooms/:code/state", ({ auth, params, query }) => ({
    room: getRoomState(auth.userId, assertRoomCode(params.code), {
      since: query.get("since") ?? undefined
    })
  }), { auth: true });

}

// ---------- 网页面板 + 管理面板 ----------
// 与游戏端路由分开注册, 因为原生服务端也要挂这一半(见 buildPanelRouter)。
export function registerPanelRoutes(r) {
  r.get("/panel", ({ res }) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderPanel());
    return undefined;
  });

  // 登录: 用户名 + TOTP
  r.post("/panel/login", ({ body, res }) => {
    const username = assertUsername(body.username);
    const code = String(body.code || "").trim();
    const { user, token } = loginWithTotp(username, code);
    res.setHeader("set-cookie", cookieHeader(token, config.panelSessionTtlSeconds));
    return { user };
  });

  r.post("/panel/logout", ({ req, res }) => {
    const s = resolvePanelSession(req);
    if (s) destroyPanelSession(s.token);
    res.setHeader("set-cookie", clearCookieHeader());
    return { ok: true };
  });

  r.get("/panel/me", ({ req }) => {
    const s = resolvePanelSession(req);
    if (!s) return { user: null };
    return { user: s.user, cards: listCards(s.userId) };
  });

  // 面板内改资料(与游戏端同一套字段)
  r.patch("/panel/profile", ({ req, body }) => {
    const s = requirePanelSession(req);
    const user = updateProfile(s.userId, {
      displayName: body.displayName,
      nameplate: body.nameplate,
      title: body.title
    });
    return { user };
  });

  // 面板内发卡 / 吊销
  r.post("/panel/cards", ({ req, body }) => {
    const s = requirePanelSession(req);
    return { card: issueCard(s.userId, { cardId: body.cardId, label: body.label }) };
  });

  r.delete("/panel/cards/:cardId", ({ req, params }) => {
    const s = requirePanelSession(req);
    return { card: revokeCard(s.userId, params.cardId) };
  });

  r.get("/panel/plays", ({ req, query }) => {
    const s = requirePanelSession(req);
    return {
      plays: listPlays(s.userId, {
        limit: query.get("limit") ?? 50,
        offset: query.get("offset") ?? 0
      })
    };
  });

  r.get("/panel/bests", ({ req }) => {
    const s = requirePanelSession(req);
    return { bests: listBests(s.userId) };
  });

  // ---------- 管理面板(网页) ----------
  // 与下面的 /admin/* 是同一批能力的两种壳:
  //   /admin/*       给脚本和 CI 用, 每次带 Bearer 令牌;
  //   /admin-panel/* 给人用, 令牌换一次会话 cookie, 免得反复粘贴。
  // 会话 token 与管理员令牌是两码事 —— 换会话不影响长期令牌。

  r.get("/admin-panel", ({ res }) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(ADMIN_PAGE);
    return undefined;
  });

  r.post("/admin-panel/login", ({ req, body, res }) => {
    const session = loginAdmin(String(body.token || "").trim(), clientIp(req));
    res.setHeader("set-cookie", adminCookieHeader(session, config.adminSessionTtlSeconds));
    return undefined;
  });

  r.post("/admin-panel/logout", ({ req, res }) => {
    const s = resolveAdminSession(req);
    if (s) destroyAdminSession(s.token);
    res.setHeader("set-cookie", clearAdminCookieHeader());
    return undefined;
  });

  // 探活: 页面打开时先问一次, 有效就直接进主界面。
  r.get("/admin-panel/me", ({ req }) => {
    requireAdminSession(req);
    return { userCount: listUsers().length };
  });

  // 账号列表带上各自的卡, 前端点「卡号」时就不用再请求一次。
  // 账号数量在单机部署规模下很小, 一次全给比按需拉取更省事。
  r.get("/admin-panel/users", ({ req }) => {
    requireAdminSession(req);
    const users = listUsers().map((u) => ({ ...u, cards: listCards(u.id) }));
    return { users };
  });

  r.post("/admin-panel/users", ({ req, body }) => {
    requireAdminSession(req);
    const username = assertUsername(body.username);
    const { user, secret } = createUser(username);
    return {
      user,
      totpSecret: secret,
      otpauthUrl: otpauthUrl({ secret, account: username, issuer: "UMIGURI" })
    };
  });

  r.post("/admin-panel/users/:id/totp-reset", ({ req, params }) => {
    requireAdminSession(req);
    const id = assertInt(params.id, "id", { min: 1 });
    const { user, secret } = resetTotp(id);
    return {
      user,
      totpSecret: secret,
      otpauthUrl: otpauthUrl({ secret, account: user.username, issuer: "UMIGURI" })
    };
  });

  r.get("/admin-panel/users/:id/cards", ({ req, params }) => {
    requireAdminSession(req);
    const id = assertInt(params.id, "id", { min: 1 });
    if (!getUserById(id)) throw notFound("用户不存在", "user_not_found");
    return { cards: listCards(id) };
  });

  r.post("/admin-panel/users/:id/cards", ({ req, params, body }) => {
    requireAdminSession(req);
    const id = assertInt(params.id, "id", { min: 1 });
    return { card: issueCard(id, { cardId: body.cardId, label: body.label }) };
  });

  // 吊销: 路径里只有卡号, 归属从库里查。已吊销的卡也允许再查一次(幂等)。
  r.delete("/admin-panel/cards/:cardId", ({ req, params }) => {
    requireAdminSession(req);
    const card = findCard(params.cardId);
    if (!card) throw notFound("卡号不存在", "card_not_found");
    return { card: revokeCard(card.userId, card.cardId) };
  });
  // ---------- 管理接口(Bearer 管理员令牌) ----------
  // 建账号: 返回 TOTP 密钥 + otpauth 链接, 交给用户扫码绑定。
  r.post("/admin/users", ({ req, body }) => {
    requireAdmin(req);
    const username = assertUsername(body.username);
    const { user, secret } = createUser(username);
    return {
      user,
      totpSecret: secret,
      otpauthUrl: otpauthUrl({ secret, account: username, issuer: "UMIGURI" })
    };
  });

  r.post("/admin/users/:id/totp-reset", ({ req, params }) => {
    requireAdmin(req);
    const id = assertInt(params.id, "id", { min: 1 });
    const { user, secret } = resetTotp(id);
    return {
      user,
      totpSecret: secret,
      otpauthUrl: otpauthUrl({ secret, account: user.username, issuer: "UMIGURI" })
    };
  });

  r.post("/admin/cards", ({ req, body }) => {
    requireAdmin(req);
    const userId = assertInt(body.userId, "userId", { min: 1 });
    return { card: issueCard(userId, { cardId: body.cardId, label: body.label }) };
  });

}

export { authResolver };

