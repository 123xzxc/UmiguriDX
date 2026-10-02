// 管理面板: Web 版管理界面(建号 / 重置验证器 / 发卡 / 吊销卡)。
//
// 与玩家面板(/panel)的关系:
//   玩家面板  = 用户名 + TOTP, 只能管自己;
//   管理面板  = 管理员令牌 + 会话 cookie, 能管所有人。
// 会话分表存放(admin_sessions / panel_sessions), 玩家会话绝不可能被当成管理员。
//
// 为什么不直接把令牌塞进 cookie: 管理员令牌是长期凭据, 一旦落到浏览器里,
// 以后想换令牌就得让所有人重新登录, 而且它没有过期时间。这里换成随机会话
// token + TTL, 泄漏影响面小得多。

import { randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./lib/db.js";
import { config } from "./config.js";
import { readCookie, unauthorized, notFound } from "./lib/http.js";

const now = () => Date.now();

// 登录失败节流。内存态即可: 进程重启就清空, 而重启本身也不利于爆破。
// 按 IP 计数, 连续失败到上限后锁一段时间。
const failures = new Map();

function lockState(ip) {
  const rec = failures.get(ip);
  if (!rec) return { fails: 0, until: 0 };
  if (rec.until && rec.until <= now()) {
    failures.delete(ip);
    return { fails: 0, until: 0 };
  }
  return rec;
}

function noteFailure(ip) {
  const rec = lockState(ip);
  const fails = rec.fails + 1;
  const until = fails >= config.adminLoginMaxFails
    ? now() + config.adminLoginLockSeconds * 1000
    : 0;
  failures.set(ip, { fails, until });
  return { fails, until };
}

export function clientIp(req) {
  // 部署在反代后面时优先取转发头, 否则取 socket 地址。
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// 固定时间比较, 避免按字符比对泄露令牌前缀。长度不同直接判否。
export function adminTokenMatches(token) {
  const expected = config.adminToken;
  if (!expected) return false;
  const a = Buffer.from(String(token ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createAdminSession() {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const t = now();
  db.prepare(
    "INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)"
  ).run(token, t, t + config.adminSessionTtlSeconds * 1000);
  return token;
}

export function resolveAdminSession(req) {
  const token = readCookie(req, config.adminCookieName);
  if (!token) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM admin_sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
    return null;
  }
  return { token };
}

export function requireAdminSession(req) {
  const s = resolveAdminSession(req);
  if (!s) throw unauthorized("管理会话无效或已过期", "admin_panel_unauthorized");
  return s;
}

export function destroyAdminSession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM admin_sessions WHERE token = ?").run(token);
}

// 登录: 用管理员令牌换一把会话 token。带节流。
export function loginAdmin(token, ip) {
  if (!config.adminToken) throw notFound("管理员接口未启用", "admin_disabled");

  const rec = lockState(ip);
  if (rec.until && rec.until > now()) {
    const secs = Math.ceil((rec.until - now()) / 1000);
    throw unauthorized("登录失败次数过多, 请 " + secs + " 秒后重试", "admin_locked");
  }

  if (!adminTokenMatches(token)) {
    const next = noteFailure(ip);
    // 达到上限时, 这次请求本身就告诉调用方被锁了, 省一次往返。
    if (next.until > now()) {
      const secs = Math.ceil((next.until - now()) / 1000);
      throw unauthorized("登录失败次数过多, 请 " + secs + " 秒后重试", "admin_locked");
    }
    throw unauthorized("管理员令牌不正确", "admin_unauthorized");
  }

  failures.delete(ip);
  return createAdminSession();
}

export function adminCookieHeader(token, maxAgeSeconds) {
  // SameSite=Strict 直接堵掉 CSRF: 管理面板没有跨站跳转需求。
  const parts = [
    config.adminCookieName + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + maxAgeSeconds
  ];
  if (config.panelCookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearAdminCookieHeader() {
  return config.adminCookieName + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

// 清过期会话。由 server.js 的定时器调用。
export function reapExpiredAdminSessions() {
  getDb().prepare("DELETE FROM admin_sessions WHERE expires_at < ?").run(now());
}
