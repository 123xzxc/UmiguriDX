// 游戏原生 HTTP 协议(客户端 open-umiguri/src/game-esm/index.js 的 v_Bs_28013)。
//
// 客户端固定发 POST http://<host>:<port>/1/... , Content-Type: application/json,
// 带 X-cli / X-cliver / X-clitest 三个头, 浏览器侧因此会先来一次 OPTIONS 预检 ——
// 漏了 OPTIONS 的表现是「游戏里登录一直失败」而且没有任何报错。
//
// 约定(必须严格遵守, 客户端就是按这个判断的):
//   result: "ok"             正常, 其余字段直接当数据用
//   result: "card_not_found" 卡/档案不存在 -> 客户端映射成 -11
//   result: "card_dup_login" 重复登录     -> 客户端映射成 -10
//   其它任何 result           -> 客户端映射成 -1(通用错误)
//   整个请求失败(超时/非 JSON) -> 客户端自己兜底成 {result:"bad"}

import { config } from "./config.js";
import { getDb } from "./lib/db.js";
import {
  createSession,
  ensureUserForCard,
  getOptionsFor,
  getProfileFor,
  listCharaStates,
  listCourseRecords,
  listRecords,
  normalizeCardId,
  putCharaState,
  putCourseRecord,
  putRecord,
  resolveSession,
  revokeSession,
  writeOptions,
  writeProfile
} from "./store.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-cli, x-cliver, x-clitest, authorization",
  "access-control-max-age": "600"
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

// 客户端把响应当 JSON 读; 读不到就自己按 {result:"bad"} 处理。
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) return null;
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return null;
  }
}

function trace(...args) {
  if (config.traceHttp) console.log("[native][http]", ...args);
}

function fail(res) {
  sendJson(res, 200, { result: "bad" });
}

// 档案里的名字/rating 同步回 users 表, 网页面板与管理端才能看到同一份数据。
function syncUserRow(userId, profile) {
  try {
    const name = String(profile.playerName === undefined || profile.playerName === null ? "" : profile.playerName).slice(0, 32);
    const rating = Number(profile.playerRating) || 0;
    getDb()
      .prepare("UPDATE users SET display_name = ?, rating = ?, updated_at = ? WHERE id = ?")
      .run(name || "ＵＭＩＧＵＲＩ", rating, Date.now(), userId);
  } catch {
    /* 面板相关表不可用时不影响游戏 */
  }
}

export async function handleNativeHttp(req, res, url) {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  if (path === "/" || path === "/health") {
    sendJson(res, 200, { ok: true, server: "umiguri-native", protocol: "umiguri/1" });
    return true;
  }

  if (!path.startsWith("/1/")) return false;

  if (req.method !== "POST") {
    sendJson(res, 405, { result: "bad" });
    return true;
  }

  const body = await readBody(req);
  if (body === null) {
    trace(path, "body 不是 JSON");
    fail(res);
    return true;
  }
  trace(path, "token=" + String(body.token || "").slice(0, 8), "nw=" + String(body.nw_token || "").slice(0, 12));

  // 除登录外都要求有效会话。
  if (path !== "/1/user/login" && path !== "/1/user/logout") {
    const s = resolveSession(body.token);
    if (!s) {
      trace(path, "会话无效");
      fail(res);
      return true;
    }
    handleAuthed(req, res, path, body, s);
    return true;
  }

  if (path === "/1/user/login") {
    const cardId = normalizeCardId(body.code);
    const found = ensureUserForCard(cardId);
    if (!found) {
      trace("login: 卡号不可用或未注册", cardId);
      sendJson(res, 200, { result: "card_not_found" });
      return true;
    }
    const s = createSession(found.user.id, cardId, String(body.nw_token || ""));
    if (s.error) {
      trace("login: 重复登录", cardId);
      sendJson(res, 200, { result: s.error });
      return true;
    }
    console.log("[native] 登录: " + cardId + " -> user#" + found.user.id + " (" + found.user.display_name + ")");
    sendJson(res, 200, { result: "ok", token: s.token, user_id: found.user.id });
    return true;
  }

  // /1/user/logout: 客户端不校验返回值, 恒回 ok。
  revokeSession(body.token);
  sendJson(res, 200, { result: "ok" });
  return true;
}

function handleAuthed(req, res, path, body, s) {
  switch (path) {
    case "/1/umiguri/getProfile": {
      const profile = getProfileFor(s.user_id, s);
      if (!profile) {
        sendJson(res, 200, { result: "card_not_found" });
        return;
      }
      sendJson(res, 200, { result: "ok", ...profile });
      return;
    }

    case "/1/umiguri/setProfile": {
      const data = body.data && typeof body.data === "object" ? body.data : null;
      if (!data) return fail(res);
      // 只覆盖客户端确实带过来的字段, 缺的沿用旧值 ——
      // 否则一次 setProfile 就能把玩家名字/等级冲成 undefined。
      const prev = getProfileFor(s.user_id, s) || {};
      const merged = { ...prev, ...data };
      writeProfile(s.user_id, merged);
      syncUserRow(s.user_id, merged);
      sendJson(res, 200, { result: "ok" });
      return;
    }

    case "/1/umiguri/getOptions":
      sendJson(res, 200, { result: "ok", ...getOptionsFor(s.user_id) });
      return;

    case "/1/umiguri/setOptions": {
      const data = body.data && typeof body.data === "object" ? body.data : null;
      if (!data) return fail(res);
      writeOptions(s.user_id, { ...getOptionsFor(s.user_id), ...data });
      sendJson(res, 200, { result: "ok" });
      return;
    }

    case "/1/umiguri/getRecords":
      sendJson(res, 200, { result: "ok", table: listRecords(s.user_id) });
      return;

    case "/1/umiguri/getCourseRecords":
      sendJson(res, 200, { result: "ok", table: listCourseRecords(s.user_id) });
      return;

    case "/1/umiguri/getCharaStates":
      sendJson(res, 200, { result: "ok", table: listCharaStates(s.user_id) });
      return;

    case "/1/umiguri/setRecord": {
      const d = body.data && typeof body.data === "object" ? body.data : null;
      if (!d) return fail(res);
      // 单曲与 Course 共用一个端点: 看 data 里带的是 courseId 还是 musicId。
      if (d.courseId !== undefined && d.musicId === undefined) {
        putCourseRecord(s.user_id, {
          courseId: Number(d.courseId) || 0,
          score: Number(d.score) || 0,
          flags: Number(d.flags) || 0,
          playCount: Number(d.playCount) || 0,
          updatedAt: Number(d.updatedAt) || 0
        });
      } else {
        putRecord(s.user_id, {
          musicId: d.musicId,
          musicDiff: Number(d.musicDiff) || 0,
          score: Number(d.score) || 0,
          flags: Number(d.flags) || 0,
          playCount: Number(d.playCount) || 0,
          updatedAt: Number(d.updatedAt) || 0
        });
      }
      sendJson(res, 200, { result: "ok" });
      return;
    }

    case "/1/umiguri/setCharaState": {
      const d = body.data && typeof body.data === "object" ? body.data : null;
      if (!d || d.charaId === undefined) return fail(res);
      putCharaState(s.user_id, {
        charaId: d.charaId,
        rank: Number(d.rank) || 0,
        exp: Number(d.exp) || 0,
        skillId: d.skillId,
        transIdx: Number(d.transIdx) || 0
      });
      sendJson(res, 200, { result: "ok" });
      return;
    }

    default:
      trace("未知端点", path);
      fail(res);
  }
}
