// 入参校验。全部返回规范化后的值, 不合法直接抛 HttpError。

import { config } from "../config.js";
import { badRequest } from "./http.js";

export function assertString(value, field, { min = 1, max = 64 } = {}) {
  if (typeof value !== "string") throw badRequest(`${field} 必须是字符串`, "invalid_" + field);
  const s = value.trim();
  if (s.length < min) throw badRequest(`${field} 不能为空`, "invalid_" + field);
  if (s.length > max) throw badRequest(`${field} 长度不能超过 ${max}`, "invalid_" + field);
  return s;
}

export function assertInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw badRequest(`${field} 必须是整数`, "invalid_" + field);
  }
  if (n < min || n > max) {
    throw badRequest(`${field} 必须在 ${min}~${max} 之间`, "invalid_" + field);
  }
  return n;
}

// 用户名: 字母数字下划线连字符, 3~24 字符
export function assertUsername(value) {
  const s = assertString(value, "username", { min: 3, max: 24 });
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw badRequest("用户名只能包含字母、数字、下划线、连字符", "invalid_username");
  }
  return s;
}

export function assertPassword(value) {
  const s = assertString(value, "password", { min: 8, max: 128 });
  return s;
}

// 游戏内显示名: 与 nameEntry 一致, 最长 8 字符(全角也按 1 字符计)
export function assertDisplayName(value) {
  if (typeof value !== "string") throw badRequest("displayName 必须是字符串", "invalid_display_name");
  const s = value.trim();
  if (s.length === 0) throw badRequest("显示名不能为空", "invalid_display_name");
  // Array.from 按码点切分, 保证 emoji / 代理对按 1 个字符计
  const chars = Array.from(s);
  if (chars.length > config.nameMaxLength) {
    throw badRequest(`显示名最多 ${config.nameMaxLength} 个字符`, "invalid_display_name");
  }
  return chars.join("");
}

// 房间号: 6 位纯数字(与 openCoop 的 inputDigit0~5 对应)
export function assertRoomCode(value) {
  const s = assertString(value, "code", { min: config.roomCodeLength, max: config.roomCodeLength });
  if (!config.roomCodePattern.test(s)) {
    throw badRequest("房间号必须是 6 位数字", "invalid_room_code");
  }
  return s;
}

export function assertScore(value) {
  return assertInt(value, "score", config.scoreRange);
}

export function assertRating(value) {
  return assertInt(value, "rating", config.ratingRange);
}
