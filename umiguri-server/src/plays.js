// 游玩记录: 上报、查询、排行榜。

// 曲名/难度名的查表由原生服务端提供(两边共用同一份曲目目录)。
import { describeRecord as musicDescribe } from "../../umiguri-native-server/src/lib/music-catalog.js";
import { getDb } from "./lib/db.js";
import { assertInt, assertScore, assertString } from "./lib/validate.js";

const now = () => Date.now();

// 上报一局。同时维护 bests(每曲每难度个人最佳)。
export function recordPlay(userId, input) {
  const db = getDb();
  const musicId = assertString(input.musicId, "musicId", { min: 1, max: 128 });
  const difficulty = assertInt(input.difficulty, "difficulty", { min: 0, max: 10 });
  const score = assertScore(input.score);
  const rank = input.rank === undefined ? "" : assertString(input.rank, "rank", { min: 0, max: 8 });
  const clear = input.clear === undefined ? 0 : assertInt(input.clear, "clear", { min: 0, max: 1 });
  const combo = input.combo === undefined ? 0 : assertInt(input.combo, "combo", { min: 0, max: 100000 });
  const judgeCrit = input.judgeCrit === undefined ? 0 : assertInt(input.judgeCrit, "judgeCrit", { min: 0, max: 100000 });
  const judgeMiss = input.judgeMiss === undefined ? 0 : assertInt(input.judgeMiss, "judgeMiss", { min: 0, max: 100000 });
  const playedAt = input.playedAt === undefined ? now() : assertInt(input.playedAt, "playedAt");

  const info = db.prepare(`
    INSERT INTO plays (user_id, music_id, difficulty, score, rank, clear, combo, judge_crit, judge_miss, played_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, musicId, difficulty, score, rank, clear, combo, judgeCrit, judgeMiss, playedAt);

  // 个人最佳: 只在分数更高时更新
  const prev = db.prepare(
    "SELECT score FROM bests WHERE user_id = ? AND music_id = ? AND difficulty = ?"
  ).get(userId, musicId, difficulty);

  let isBest = false;
  if (!prev || score > prev.score) {
    db.prepare(`
      INSERT INTO bests (user_id, music_id, difficulty, score, rank, clear, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, music_id, difficulty) DO UPDATE SET
        score = excluded.score, rank = excluded.rank, clear = excluded.clear, updated_at = excluded.updated_at
    `).run(userId, musicId, difficulty, score, rank, clear, now());
    isBest = true;
  }

  return { id: Number(info.lastInsertRowid), isBest };
}

// 曲目目录(曲名/难度等级)来自游戏谱面表头, 见 umiguri-native-server/src/lib/music-catalog.js。
// 取不到就返回空串, 面板会退回显示 musicId。
function describe(musicId, difficulty) {
  try {
    // 动态 import: umiguri-server 单独跑时(没有原生服务端)也能用。
    return musicDescribe(musicId, difficulty);
  } catch {
    return { musicTitle: "", diffName: "", diffLevel: "", diffLabel: "" };
  }
}

export function listPlays(userId, { limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const lim = assertInt(limit, "limit", { min: 1, max: 200 });
  const off = assertInt(offset, "offset", { min: 0 });
  const rows = db.prepare(`
    SELECT * FROM plays WHERE user_id = ? ORDER BY played_at DESC LIMIT ? OFFSET ?
  `).all(userId, lim, off);
  return rows.map((r) => ({
    id: r.id,
    musicId: r.music_id,
    difficulty: r.difficulty,
    score: r.score,
    rank: r.rank,
    clear: r.clear,
    combo: r.combo,
    judgeCrit: r.judge_crit,
    judgeMiss: r.judge_miss,
    playedAt: r.played_at,
    ...describe(r.music_id, r.difficulty)
  }));
}

export function listBests(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT b.*, u.display_name FROM bests b
    JOIN users u ON u.id = b.user_id
    WHERE b.user_id = ? ORDER BY b.updated_at DESC
  `).all(userId).map((r) => ({
    musicId: r.music_id,
    difficulty: r.difficulty,
    score: r.score,
    rank: r.rank,
    clear: r.clear,
    updatedAt: r.updated_at,
    ...describe(r.music_id, r.difficulty)
  }));
}

// 单曲排行榜: 取每名玩家在该曲该难度的最佳成绩
export function musicLeaderboard(musicId, difficulty, { limit = 50 } = {}) {
  const db = getDb();
  const lim = assertInt(limit, "limit", { min: 1, max: 200 });
  return db.prepare(`
    SELECT b.score, b.rank, b.clear, b.updated_at, u.id AS user_id, u.display_name, u.nameplate, u.title
    FROM bests b JOIN users u ON u.id = b.user_id
    WHERE b.music_id = ? AND b.difficulty = ?
    ORDER BY b.score DESC, b.updated_at ASC
    LIMIT ?
  `).all(musicId, difficulty, lim).map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    displayName: r.display_name,
    nameplate: r.nameplate,
    title: r.title,
    score: r.score,
    grade: r.rank,
    clear: r.clear,
    updatedAt: r.updated_at
  }));
}

// 总榜: 按 rating 排
export function totalLeaderboard({ limit = 50 } = {}) {
  const db = getDb();
  const lim = assertInt(limit, "limit", { min: 1, max: 200 });
  return db.prepare(`
    SELECT id, display_name, nameplate, title, rating FROM users
    ORDER BY rating DESC, id ASC LIMIT ?
  `).all(lim).map((r, i) => ({
    rank: i + 1,
    userId: r.id,
    displayName: r.display_name,
    nameplate: r.nameplate,
    title: r.title,
    rating: r.rating
  }));
}
