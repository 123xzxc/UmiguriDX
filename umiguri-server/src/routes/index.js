// 全部路由注册。

import { createRouter, notFound, badRequest } from "../lib/http.js";
import { verifyToken } from "../lib/token.js";
import { assertUsername, assertPassword, assertRoomCode, assertInt } from "../lib/validate.js";
import { authenticate, createUser, getUserById, updateProfile } from "../users.js";
import { listBests, listPlays, musicLeaderboard, recordPlay, totalLeaderboard } from "../plays.js";
import {
  createRoom, finishMatch, getRoomState, joinRoom, leaveRoom,
  reportProgress, selectMusic, setReady, startMatch
} from "../rooms.js";
import { issueToken } from "../lib/token.js";

// 从 Authorization 头解析并校验 JWT
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

export function buildRouter() {
  const r = createRouter();

  // ---------- 健康检查 ----------
  r.get("/health", () => ({ status: "ok", time: Date.now() }));

  // ---------- 账号 ----------
  r.post("/auth/register", ({ body }) => {
    const username = assertUsername(body.username);
    const password = assertPassword(body.password);
    const user = createUser(username, password);
    return { token: issueToken({ sub: user.id, username: user.username }), user };
  });

  r.post("/auth/login", ({ body }) => {
    const username = assertUsername(body.username);
    const password = assertPassword(body.password);
    const user = authenticate(username, password);
    return { token: issueToken({ sub: user.id, username: user.username }), user };
  });

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
  r.post("/plays", ({ auth, body }) => {
    const result = recordPlay(auth.userId, body);
    return result;
  }, { auth: true });

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

  // ---------- 房间 ----------
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

  // 实时分数上报(对局中高频轮询)
  r.post("/rooms/:code/progress", ({ auth, params, body }) => ({
    room: reportProgress(auth.userId, assertRoomCode(params.code), {
      score: body.score,
      progress: body.progress
    })
  }), { auth: true });

  // 房间快照(对局中高频轮询, 支持 since 做增量)
  r.get("/rooms/:code/state", ({ auth, params, query }) => ({
    room: getRoomState(auth.userId, assertRoomCode(params.code), {
      since: query.get("since") ?? undefined
    })
  }), { auth: true });

  return r;
}

export { authResolver };
