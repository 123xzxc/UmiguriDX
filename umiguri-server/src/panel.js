// 网页面板: 会话与登录。
//
// 面板只认 TOTP, 没有密码。会话 token 与游戏端 JWT 刻意分开 ——
// 面板 cookie 一旦泄露, 攻击者也只是能开网页, 不能冒充游戏客户端刷分。

import { randomBytes } from "node:crypto";
import { getDb } from "./lib/db.js";
import { config } from "./config.js";
import { readCookie, unauthorized } from "./lib/http.js";
import { getUserById, authenticateTotp } from "./users.js";

const now = () => Date.now();

export function createPanelSession(userId) {
  const db = getDb();
  const token = randomBytes(32).toString("base64url");
  const t = now();
  db.prepare(
    "INSERT INTO panel_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(token, userId, t, t + config.panelSessionTtlSeconds * 1000);
  return token;
}

// 从 Cookie 里取会话 token。面板是网页, 用 HttpOnly cookie 比 localStorage 安全
// (XSS 拿不到), 且天然随请求发送。
export function readPanelToken(req) {
  return readCookie(req, config.panelCookieName);
}

export function resolvePanelSession(req) {
  const token = readPanelToken(req);
  if (!token) return null;
  const db = getDb();
  const row = db.prepare("SELECT * FROM panel_sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM panel_sessions WHERE token = ?").run(token);
    return null;
  }
  const user = getUserById(row.user_id);
  return user ? { userId: user.id, user, token } : null;
}

export function destroyPanelSession(token) {
  if (!token) return;
  getDb().prepare("DELETE FROM panel_sessions WHERE token = ?").run(token);
}

export function cookieHeader(token, maxAgeSeconds) {
  // SameSite=Strict: 面板不需要跨站跳转, 直接堵掉 CSRF。
  // Secure 只在 https 下有意义, 本地 http 调试会失败, 故按配置开关。
  const parts = [
    config.panelCookieName + "=" + encodeURIComponent(token),
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + maxAgeSeconds
  ];
  if (config.panelCookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader() {
  return config.panelCookieName + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

// 登录: 用户名 + TOTP 验证码 -> 会话
export function loginWithTotp(username, code) {
  const user = authenticateTotp(username, code);
  const token = createPanelSession(user.id);
  return { user, token };
}

export function requirePanelSession(req) {
  const s = resolvePanelSession(req);
  if (!s) throw unauthorized("面板会话无效或已过期", "panel_unauthorized");
  return s;
}
