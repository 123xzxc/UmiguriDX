// 账号与资料。
//
// 本服务端全程无密码:
//   - 游戏端: 输卡号即登录(见 cards.js);
//   - 网页面板: 用户名 + TOTP(Google 验证器)登录。
// 因此 users 表不再有 password_hash 之类的字段 —— 没有口令就没有口令泄露。
//
// 账号由管理员(持有 UMIGURI_ADMIN_TOKEN)创建, 不做自助注册:
// TOTP 密钥若谁都能申请, 就等于谁都能接管任意用户名。

import { getDb } from "./lib/db.js";
import { conflict, notFound, unauthorized } from "./lib/http.js";
import { assertDisplayName, assertInt } from "./lib/validate.js";
import { generateSecret, verifyTotp } from "./lib/totp.js";

const now = () => Date.now();

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    nameplate: row.nameplate,
    title: row.title,
    rating: row.rating,
    createdAt: row.created_at
  };
}

// 建账号。同时生成 TOTP 密钥(未确认状态), 返回密钥供管理员出示给用户扫码。
// 密钥在用户首次用有效 TOTP 登录时置 confirmed_at —— 在那之前登录一律拒绝。
export function createUser(username) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) throw conflict("用户名已被占用", "username_taken");

  const t = now();
  const info = db.prepare(
    "INSERT INTO users (username, display_name, nameplate, title, rating, created_at, updated_at) VALUES (?, ?, 0, 0, 0, ?, ?)"
  ).run(username, username, t, t);
  const userId = Number(info.lastInsertRowid);

  const secret = generateSecret();
  db.prepare(
    "INSERT INTO totp_secrets (user_id, secret, confirmed_at, created_at) VALUES (?, ?, NULL, ?)"
  ).run(userId, secret, t);

  return { user: getUserById(userId), secret };
}

export function getUserById(id) {
  const db = getDb();
  return toPublic(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

export function getUserByUsername(username) {
  const db = getDb();
  return toPublic(db.prepare("SELECT * FROM users WHERE username = ?").get(username));
}

// 取 TOTP 凭据(内部用, 含密钥原文)
export function getTotp(userId) {
  const db = getDb();
  return db.prepare("SELECT * FROM totp_secrets WHERE user_id = ?").get(userId) ?? null;
}

// 校验并消费一次 TOTP 登录。成功时把首次登录的密钥标记为已确认。
// 返回用户; 失败抛 401(错误信息不区分「用户不存在」与「口令错误」)。
export function authenticateTotp(username, code) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!row) throw unauthorized("用户名或验证码错误", "bad_credentials");
  const t = getTotp(row.id);
  if (!t) throw unauthorized("该账号尚未绑定验证器", "totp_not_bound");
  if (!verifyTotp(t.secret, code)) throw unauthorized("用户名或验证码错误", "bad_credentials");
  if (!t.confirmed_at) {
    db.prepare("UPDATE totp_secrets SET confirmed_at = ? WHERE user_id = ?").run(now(), row.id);
  }
  return toPublic(row);
}

// 重置验证器: 换一把新密钥(用户换手机/密钥泄露时用)。需管理员操作。
export function resetTotp(userId) {
  const db = getDb();
  if (!getUserById(userId)) throw notFound("用户不存在", "user_not_found");
  const secret = generateSecret();
  db.prepare(
    "INSERT INTO totp_secrets (user_id, secret, confirmed_at, created_at) VALUES (?, ?, NULL, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, confirmed_at = NULL, created_at = excluded.created_at"
  ).run(userId, secret, now());
  return { user: getUserById(userId), secret };
}

// 更新资料: displayName(游戏内名字) / nameplate(称号牌) / title(称号)
export function updateProfile(userId, { displayName, nameplate, title } = {}) {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) throw notFound("用户不存在", "user_not_found");

  const nextName = displayName === undefined ? user.display_name : assertDisplayName(displayName);
  const nextPlate = nameplate === undefined
    ? user.nameplate
    : assertInt(nameplate, "nameplate", { min: 0, max: 999 });
  const nextTitle = title === undefined
    ? user.title
    : assertInt(title, "title", { min: 0, max: 999 });

  db.prepare(
    "UPDATE users SET display_name = ?, nameplate = ?, title = ?, updated_at = ? WHERE id = ?"
  ).run(nextName, nextPlate, nextTitle, now(), userId);

  return getUserById(userId);
}

export function setRating(userId, rating) {
  const db = getDb();
  db.prepare("UPDATE users SET rating = ?, updated_at = ? WHERE id = ?").run(rating, now(), userId);
}
