// 全部路由注册。
//
// 三套入口, 凭据各不相同:
//   /auth/card       游戏端 —— 卡号即登录, 无密码
//   /panel/*         网页面板 —— 用户名 + TOTP(见 panel.js), cookie 会话
//   /admin/*         管理 —— Bearer UMIGURI_ADMIN_TOKEN, 建号/发卡/重置验证器
// 游玩记录与房间接口仍走游戏端 JWT(游戏是唯一的产生者)。

import { timingSafeEqual } from "node:crypto";
import { createRouter, notFound, badRequest } from "../lib/http.js";
import { verifyToken } from "../lib/token.js";
import { assertUsername, assertRoomCode, assertInt } from "../lib/validate.js";
import { assertCardId } from "../lib/card.js";
import { createUser, getUserById, resetTotp, updateProfile } from "../users.js";
import { issueCard, listCards, resolveCard, revokeCard } from "../cards.js";
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

  // ---------- 网页面板 ----------
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

  return r;
}

export { authResolver };

