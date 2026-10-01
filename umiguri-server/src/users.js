// 账号与资料。

import { getDb } from "./lib/db.js";
import { hashPassword, verifyPassword } from "./lib/password.js";
import { conflict, notFound, unauthorized } from "./lib/http.js";
import { assertDisplayName, assertInt } from "./lib/validate.js";

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

export function createUser(username, password) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) throw conflict("用户名已被占用", "username_taken");

  const t = now();
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, nameplate, title, rating, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, 0, ?, ?)
  `).run(username, hashPassword(password), username, t, t);

  return getUserById(Number(info.lastInsertRowid));
}

export function getUserById(id) {
  const db = getDb();
  return toPublic(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

export function getUserByUsername(username) {
  const db = getDb();
  return toPublic(db.prepare("SELECT * FROM users WHERE username = ?").get(username));
}

// 登录: 校验口令, 返回用户。失败统一给同一个错误, 不泄露用户名是否存在。
export function authenticate(username, password) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw unauthorized("用户名或密码错误", "bad_credentials");
  }
  return toPublic(row);
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

  db.prepare(`
    UPDATE users SET display_name = ?, nameplate = ?, title = ?, updated_at = ? WHERE id = ?
  `).run(nextName, nextPlate, nextTitle, now(), userId);

  return getUserById(userId);
}

export function setRating(userId, rating) {
  const db = getDb();
  db.prepare("UPDATE users SET rating = ?, updated_at = ? WHERE id = ?").run(rating, now(), userId);
}
