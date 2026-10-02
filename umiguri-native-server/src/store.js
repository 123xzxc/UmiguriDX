// 数据访问层: 卡号 -> 账号 -> 会话 -> 档案/成绩。
// HTTP 与 /sock 两边都走这里, 免得同一套规则写两份(比如 token 有效期、卡号规范化)。

import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { getDb } from "./lib/db.js";

export const MS_OK = 0;
export const MS_ERROR = -1;

// 与 umiguri-server/src/lib/card.js 保持一致: 20 位, E004 开头, 后 16 位数字。
const CARD_PREFIX = "E004";
const CARD_LENGTH = 20;
const CARD_PATTERN = /^E004[0-9]{16}$/;

// 客户端 Ey() 里的默认联机档案(离线模式的默认值), 新账号直接照抄,
// 这样 /1/umiguri/getProfile 永远能返回一份完整数据, 客户端不会出现字段未定义。
const DEFAULT_CHAT_IDS = [10001, 10002, 30001, 30002, 0, 0, 0, 0, 0, 0, 0, 0, 10004, 20002, 40008, 40002, 0, 0, 0, 0];

// 客户端 index.js 的 scope.v_ji_27860[0](内置预设 0)。照抄它, 新账号的
// 设置项就等于游戏自己的默认值 —— 不能随便给 0, 比如 scrollSpeed=0 会直接没法玩。
const DEFAULT_OPTIONS = {
  optionPreset: 0,
  scrollSpeed: 4,
  mirror: 0,
  jdgTimingA: 20,
  jdgTimingB: 20,
  jdgTimingAir: 20,
  showLevel: 1,
  showRating: 1,
  showOverpower: 1,
  trackSkip: 0,
  autoPlay: 0,
  volGuide: 5,
  tapSe: 0,
  volTap: 5,
  volExTap: 5,
  volSlide: 5,
  volAir: 5,
  volFlick: 5,
  volSkill: 5,
  jTimingSeCond: 0,
  judgeAnsPos: 0,
  judgeAnsJcDetails: 0,
  judgeAnsJDetails: 0,
  judgeAnsADetails: 0,
  fieldLines: 1,
  fieldColor: 5,
  fieldWall: 0,
  fieldInfo: 1,
  masterVolume: 100
};

const now = () => Date.now();

export function normalizeCardId(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

export function isValidCardId(value) {
  const s = normalizeCardId(value);
  return s.length === CARD_LENGTH && CARD_PATTERN.test(s);
}

// 给网页面板没有的卡补一张: 自建服默认允许「刷一张新卡就是新号」。
export function generateCardId() {
  let digits = "";
  for (let i = 0; i < 15; i++) digits += String(Math.floor(Math.random() * 10));
  const head = CARD_PREFIX + digits;
  let sum = 0;
  for (const ch of head) if (ch >= "0" && ch <= "9") sum += Number(ch);
  return head + String(sum % 10);
}

export function newToken() {
  return randomBytes(24).toString("base64url");
}

// ---- 账号与卡 ----

export function findUserByCard(cardId) {
  const db = getDb();
  const row = db
    .prepare("SELECT c.card_id AS card_id, u.* FROM cards c JOIN users u ON u.id = c.user_id WHERE c.card_id = ? AND c.revoked_at IS NULL")
    .get(cardId);
  return row || null;
}

function createUserWithCard(cardId) {
  const db = getDb();
  const tail = cardId.slice(-8);
  let username = "card" + tail;
  for (let i = 2; i < 200; i++) {
    const hit = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
    if (!hit) break;
    username = "card" + tail + "_" + i;
  }
  const t = now();
  const info = db
    .prepare("INSERT INTO users (username, display_name, nameplate, title, rating, created_at, updated_at) VALUES (?, ?, 0, 0, 0, ?, ?)")
    .run(username, "ＵＭＩＧＵＲＩ", t, t);
  const userId = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO cards (card_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(cardId, userId, "自动注册", t);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

// 刷卡 -> 账号。返回 { user } 或 null(卡不存在且不允许自动注册)。
export function ensureUserForCard(rawCardId) {
  const cardId = normalizeCardId(rawCardId);
  if (!isValidCardId(cardId)) return null;
  const hit = findUserByCard(cardId);
  if (hit) return { user: hit, cardId };
  if (!config.autoRegister) return null;
  try {
    return { user: createUserWithCard(cardId), cardId };
  } catch {
    // 并发刷卡时可能被另一个请求抢先建号, 再查一次即可。
    const again = findUserByCard(cardId);
    return again ? { user: again, cardId } : null;
  }
}

// ---- 会话 ----

export function createSession(userId, cardId, nwToken) {
  const db = getDb();
  const token = newToken();
  const t = now();
  if (config.rejectDuplicateLogin) {
    const live = db
      .prepare("SELECT token FROM native_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND nw_token <> ?")
      .get(userId, t, nwToken || "");
    if (live) return { error: "card_dup_login" };
  }
  // 顶掉旧会话: 同一账号换机器/重装后还能继续玩, 不会把自己锁死。
  db.prepare("UPDATE native_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(t, userId);
  db.prepare("INSERT INTO native_sessions (token, user_id, card_id, nw_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    token,
    userId,
    cardId,
    nwToken || "",
    t,
    t + config.sessionTtlSeconds * 1000
  );
  return { token, userId };
}

export function resolveSession(token) {
  if (!token || typeof token !== "string") return null;
  const db = getDb();
  const row = db
    .prepare("SELECT s.*, u.username, u.display_name FROM native_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.revoked_at IS NULL AND s.expires_at > ?")
    .get(token, now());
  return row || null;
}

export function revokeSession(token) {
  if (!token) return false;
  const db = getDb();
  const info = db.prepare("UPDATE native_sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL").run(now(), token);
  return Number(info.changes) > 0;
}

// ---- 档案 ----

export function readProfile(userId) {
  const row = getDb().prepare("SELECT data FROM native_profiles WHERE user_id = ?").get(userId);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function makeDefaultProfile(userRow) {
  return {
    targetVersion: 1101,
    termsAgreed: 1,
    playerName: (userRow && userRow.display_name) || "ＵＭＩＧＵＲＩ",
    playerLevel: 1,
    playerRating: 0,
    playerMaxRating: 0,
    charaId: "UMIGURI/uni",
    charaTransIdx: 0,
    nameplateId: "_0000000_sys_default",
    titleId: "s_00000000",
    voiceId: "_0000000_sys_silence",
    voiceLong: false,
    readNewsIdx: 0,
    lastMusicId: "",
    lastMusicDiff: 0,
    lastActivePlayLevel: 0,
    lastActiveLevelSelect: false,
    lastActiveUltimaSelect: false,
    musicListSort: 0,
    chatIds: DEFAULT_CHAT_IDS.slice()
  };
}

// 取档案。没有行时: 按 newCardProfile 配置决定是「现给一份默认档案」还是
// 「回 -11 让客户端自己建档」。
export function getProfileFor(userId, userRow) {
  const saved = readProfile(userId);
  if (saved) return saved;
  if (config.newCardProfile !== "ok") return null;
  const fresh = makeDefaultProfile(userRow);
  writeProfile(userId, fresh);
  return fresh;
}

export function writeProfile(userId, data) {
  const db = getDb();
  db.prepare("INSERT INTO native_profiles (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(
    userId,
    JSON.stringify(data),
    now()
  );
}

// ---- 设置 ----

export function readOptions(userId) {
  const row = getDb().prepare("SELECT data FROM native_options WHERE user_id = ?").get(userId);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function getOptionsFor(userId) {
  const saved = readOptions(userId);
  if (saved) return saved;
  const fresh = { ...DEFAULT_OPTIONS };
  writeOptions(userId, fresh);
  return fresh;
}

export function writeOptions(userId, data) {
  getDb()
    .prepare("INSERT INTO native_options (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(userId, JSON.stringify(data), now());
}

// ---- 成绩 ----

export function listRecords(userId) {
  return getDb()
    .prepare("SELECT music_id, difficulty, score, flags, play_count, updated_at FROM native_records WHERE user_id = ?")
    .all(userId)
    .map((r) => ({
      musicId: r.music_id,
      musicDiff: r.difficulty,
      score: r.score,
      flags: r.flags,
      playCount: r.play_count,
      updatedAt: r.updated_at
    }));
}

export function putRecord(userId, { musicId, musicDiff, score, flags, playCount, updatedAt }) {
  const d = getDb();
  const prev = d.prepare("SELECT score, play_count FROM native_records WHERE user_id = ? AND music_id = ? AND difficulty = ?").get(userId, String(musicId), musicDiff | 0);
  const best = Math.min(Math.max(score | 0, 0), 1010000);
  const finalScore = prev ? Math.max(prev.score, best) : best;
  const finalCount = Math.max(prev ? prev.play_count : 0, playCount | 0);
  d.prepare(
    "INSERT INTO native_records (user_id, music_id, difficulty, score, flags, play_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, music_id, difficulty) DO UPDATE SET score = excluded.score, flags = excluded.flags, play_count = excluded.play_count, updated_at = excluded.updated_at"
  ).run(userId, String(musicId), musicDiff | 0, finalScore, flags | 0, finalCount, updatedAt || now());
  return { musicId, musicDiff, score: finalScore, flags, playCount: finalCount, updatedAt };
}

export function listCourseRecords(userId) {
  return getDb()
    .prepare("SELECT course_id, score, flags, play_count, updated_at FROM native_course_records WHERE user_id = ?")
    .all(userId)
    .map((r) => ({
      courseId: r.course_id,
      score: r.score,
      flags: r.flags,
      playCount: r.play_count,
      updatedAt: r.updated_at
    }));
}

export function putCourseRecord(userId, { courseId, score, flags, playCount, updatedAt }) {
  const d = getDb();
  const prev = d.prepare("SELECT score, play_count FROM native_course_records WHERE user_id = ? AND course_id = ?").get(userId, courseId | 0);
  const best = Math.min(Math.max(score | 0, 0), 3030000);
  const finalScore = prev ? Math.max(prev.score, best) : best;
  const finalCount = Math.max(prev ? prev.play_count : 0, playCount | 0);
  d.prepare(
    "INSERT INTO native_course_records (user_id, course_id, score, flags, play_count, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id, course_id) DO UPDATE SET score = excluded.score, flags = excluded.flags, play_count = excluded.play_count, updated_at = excluded.updated_at"
  ).run(userId, courseId | 0, finalScore, flags | 0, finalCount, updatedAt || now());
  return { courseId, score: finalScore, flags, playCount: finalCount, updatedAt };
}

export function listCharaStates(userId) {
  return getDb()
    .prepare("SELECT chara_id, rank, exp, skill_id, trans_idx FROM native_chara_states WHERE user_id = ?")
    .all(userId)
    .map((r) => ({
      charaId: r.chara_id,
      rank: r.rank,
      exp: r.exp,
      skillId: r.skill_id,
      transIdx: r.trans_idx
    }));
}

export function putCharaState(userId, { charaId, rank, exp, skillId, transIdx }) {
  getDb()
    .prepare(
      "INSERT INTO native_chara_states (user_id, chara_id, rank, exp, skill_id, trans_idx) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, chara_id) DO UPDATE SET rank = excluded.rank, exp = excluded.exp, skill_id = excluded.skill_id, trans_idx = excluded.trans_idx"
    )
    .run(userId, String(charaId), rank | 0, exp | 0, String(skillId === undefined || skillId === null ? "" : skillId), transIdx | 0);
}

// 联机房间要把「我是谁」发给别人, 这里统一从用户行 + 档案里拼。
export function playerCard(userRow, profile) {
  const p = profile || {};
  return {
    nx: userRow.id,
    name: (userRow && userRow.display_name) || "PLAYER",
    rating: Number.isFinite(p.playerRating) ? p.playerRating : 0,
    level: Number.isFinite(p.playerLevel) ? p.playerLevel : 1
  };
}
