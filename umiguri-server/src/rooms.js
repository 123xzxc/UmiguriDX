// 联机房间: 创建 / 加入 / 准备 / 选曲 / 实时分数同步(HTTP 轮询)。
//
// 房间号规则: 6 位纯数字(与 openCoop 的 inputDigit0~5 对应)。
// 实时分数: 客户端以固定间隔 PUT 自己的进度, 并 GET 房间快照拿对手分数。
//   为了让轮询足够轻, GET /rooms/:code/state 支持 since 参数 —— 只有对手进度
//   发生变化时才返回完整 players, 否则只回 version, 客户端据此跳过重绘。

import { getDb } from "./lib/db.js";
import { conflict, forbidden, notFound } from "./lib/http.js";
import { assertInt, assertRoomCode, assertScore, assertString } from "./lib/validate.js";
import { config } from "./config.js";

const now = () => Date.now();

// 生成未被占用的 6 位数字房间号
function allocateRoomCode(db) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(config.roomCodeLength, "0");
    const hit = db.prepare("SELECT code FROM rooms WHERE code = ?").get(code);
    if (!hit) return code;
  }
  throw conflict("房间号分配失败, 请重试", "room_code_exhausted");
}

function roomRow(db, code) {
  return db.prepare("SELECT * FROM rooms WHERE code = ?").get(code);
}

function playersOf(db, code) {
  return db.prepare(`
    SELECT rp.user_id, rp.ready, rp.score, rp.progress, rp.joined_at,
           u.display_name, u.nameplate, u.title, u.rating
    FROM room_players rp JOIN users u ON u.id = rp.user_id
    WHERE rp.code = ? ORDER BY rp.joined_at ASC
  `).all(code).map((r, i) => ({
    seat: i,
    userId: r.user_id,
    displayName: r.display_name,
    nameplate: r.nameplate,
    title: r.title,
    rating: r.rating,
    ready: !!r.ready,
    score: r.score,
    progress: r.progress
  }));
}

function snapshot(db, code) {
  const room = roomRow(db, code);
  if (!room) return null;
  const players = playersOf(db, code);
  // version: 玩家进度/准备状态的聚合指纹, 客户端据此判断是否需要重绘
  const version = players.reduce(
    (acc, p) => acc + p.userId * 31 + p.score * 7 + p.progress * 13 + (p.ready ? 1 : 0),
    room.updated_at
  );
  return {
    code: room.code,
    hostId: room.host_id,
    musicId: room.music_id,
    difficulty: room.difficulty,
    status: room.status,
    createdAt: room.created_at,
    version,
    players
  };
}

export function createRoom(userId, { musicId, difficulty } = {}) {
  const db = getDb();
  // 一人同时只能在一个房间
  const inRoom = db.prepare("SELECT code FROM room_players WHERE user_id = ?").get(userId);
  if (inRoom) throw conflict("你已在房间 " + inRoom.code + " 中", "already_in_room");

  const code = allocateRoomCode(db);
  const t = now();
  const mid = musicId === undefined ? null : assertString(musicId, "musicId", { min: 1, max: 128 });
  const diff = difficulty === undefined ? null : assertInt(difficulty, "difficulty", { min: 0, max: 10 });

  db.prepare(`
    INSERT INTO rooms (code, host_id, music_id, difficulty, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'lobby', ?, ?)
  `).run(code, userId, mid, diff, t, t);

  db.prepare(`
    INSERT INTO room_players (code, user_id, ready, score, progress, joined_at)
    VALUES (?, ?, 0, 0, 0, ?)
  `).run(code, userId, t);

  return snapshot(db, code);
}

export function joinRoom(userId, code) {
  const db = getDb();
  const room = roomRow(db, code);
  if (!room) throw notFound("房间不存在", "room_not_found");

  const existing = db.prepare("SELECT code FROM room_players WHERE user_id = ?").get(userId);
  if (existing) {
    if (existing.code === code) return snapshot(db, code);
    throw conflict("你已在房间 " + existing.code + " 中", "already_in_room");
  }

  const count = db.prepare("SELECT COUNT(*) AS n FROM room_players WHERE code = ?").get(code).n;
  if (count >= config.roomMaxPlayers) throw conflict("房间已满", "room_full");

  db.prepare(`
    INSERT INTO room_players (code, user_id, ready, score, progress, joined_at)
    VALUES (?, ?, 0, 0, 0, ?)
  `).run(code, userId, now());

  db.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").run(now(), code);
  return snapshot(db, code);
}

export function leaveRoom(userId, code) {
  const db = getDb();
  const room = roomRow(db, code);
  if (!room) throw notFound("房间不存在", "room_not_found");

  db.prepare("DELETE FROM room_players WHERE code = ? AND user_id = ?").run(code, userId);

  const remaining = db.prepare("SELECT COUNT(*) AS n FROM room_players WHERE code = ?").get(code).n;
  if (remaining === 0) {
    db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
    return { code, dissolved: true };
  }

  // 房主离开 -> 移交给最早加入的剩余玩家
  if (room.host_id === userId) {
    const next = db.prepare(
      "SELECT user_id FROM room_players WHERE code = ? ORDER BY joined_at ASC LIMIT 1"
    ).get(code);
    db.prepare("UPDATE rooms SET host_id = ?, updated_at = ? WHERE code = ?").run(next.user_id, now(), code);
    return { code, dissolved: false, newHostId: next.user_id };
  }

  db.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").run(now(), code);
  return { code, dissolved: false };
}

export function setReady(userId, code, ready) {
  const db = getDb();
  const member = db.prepare("SELECT code FROM room_players WHERE code = ? AND user_id = ?").get(code, userId);
  if (!member) throw forbidden("你不在该房间中", "not_in_room");

  db.prepare("UPDATE room_players SET ready = ? WHERE code = ? AND user_id = ?")
    .run(ready ? 1 : 0, code, userId);
  db.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").run(now(), code);
  return snapshot(db, code);
}

// 房主选曲
export function selectMusic(userId, code, { musicId, difficulty }) {
  const db = getDb();
  const room = roomRow(db, code);
  if (!room) throw notFound("房间不存在", "room_not_found");
  if (room.host_id !== userId) throw forbidden("只有房主可以选曲", "not_host");

  const mid = musicId === undefined ? null : assertString(musicId, "musicId", { min: 1, max: 128 });
  const diff = difficulty === undefined ? null : assertInt(difficulty, "difficulty", { min: 0, max: 10 });

  db.prepare("UPDATE rooms SET music_id = ?, difficulty = ?, updated_at = ? WHERE code = ?")
    .run(mid, diff, now(), code);
  return snapshot(db, code);
}

// 开局: 房主触发, 重置所有玩家进度并进入 playing
export function startMatch(userId, code) {
  const db = getDb();
  const room = roomRow(db, code);
  if (!room) throw notFound("房间不存在", "room_not_found");
  if (room.host_id !== userId) throw forbidden("只有房主可以开始游戏", "not_host");
  if (!room.music_id) throw conflict("尚未选择乐曲", "no_music_selected");

  const players = playersOf(db, code);
  if (players.length < 1) throw conflict("房间内没有玩家", "empty_room");

  const t = now();
  db.prepare("UPDATE room_players SET score = 0, progress = 0 WHERE code = ?").run(code);
  db.prepare("UPDATE rooms SET status = 'playing', updated_at = ? WHERE code = ?").run(t, code);
  return snapshot(db, code);
}

export function finishMatch(userId, code) {
  const db = getDb();
  const room = roomRow(db, code);
  if (!room) throw notFound("房间不存在", "room_not_found");
  if (room.host_id !== userId) throw forbidden("只有房主可以结束游戏", "not_host");

  db.prepare("UPDATE rooms SET status = 'result', updated_at = ? WHERE code = ?").run(now(), code);
  return snapshot(db, code);
}

// 实时进度上报: 这是"实时看对手分数"的写入端。
// 客户端在对局中按固定间隔调用, 只更新自己的分数与进度, 轻量。
export function reportProgress(userId, code, { score, progress }) {
  const db = getDb();
  const member = db.prepare("SELECT code FROM room_players WHERE code = ? AND user_id = ?").get(code, userId);
  if (!member) throw forbidden("你不在该房间中", "not_in_room");

  const s = assertScore(score);
  const p = assertInt(progress, "progress", { min: 0, max: 10000 });

  db.prepare("UPDATE room_players SET score = ?, progress = ? WHERE code = ? AND user_id = ?")
    .run(s, p, code, userId);
  // updated_at 参与 version 计算, 但为避免每次心跳都刷新 version, 这里不动 rooms.updated_at
  return snapshot(db, code);
}

// 房间快照(读取端)。
// since 传入客户端持有的 version: 若无变化, 只回 unchanged, 省带宽。
export function getRoomState(userId, code, { since } = {}) {
  const db = getDb();
  const member = db.prepare("SELECT code FROM room_players WHERE code = ? AND user_id = ?").get(code, userId);
  if (!member) throw forbidden("你不在该房间中", "not_in_room");

  const snap = snapshot(db, code);
  if (!snap) throw notFound("房间不存在", "room_not_found");

  if (since !== undefined && Number(since) === snap.version) {
    return { code, unchanged: true, version: snap.version };
  }
  return snap;
}

// 清理空闲房间。由定时器调用。
export function reapIdleRooms() {
  const db = getDb();
  const cutoff = now() - config.roomIdleTtlSeconds * 1000;
  const idle = db.prepare("SELECT code FROM rooms WHERE updated_at < ?").all(cutoff);
  for (const { code } of idle) {
    const n = db.prepare("SELECT COUNT(*) AS n FROM room_players WHERE code = ?").get(code).n;
    if (n === 0) db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
  }
  return idle.length;
}
