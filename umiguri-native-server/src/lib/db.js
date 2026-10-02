// SQLite 封装(零依赖: node 内置 node:sqlite)。
//
// 与 umiguri-server 共用一个库文件是刻意设计: 卡号/账号体系只有一套,
// 网页面板注册的卡在游戏里直接能刷。两边都用 IF NOT EXISTS 建表, 谁先起来都能建。
// 并发靠 WAL + busy_timeout(见 openDb), 两个进程同时读写是安全的。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

let db = null;

export function openDb(path = config.dbPath) {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 另一个进程(umiguri-server)可能正在写, 等一会儿而不是直接报 SQLITE_BUSY。
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error("数据库未初始化, 请先调用 openDb()");
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// users / cards / totp_secrets 与 umiguri-server/src/lib/db.js 保持一致 ——
// 两边必须能认同一套账号与卡号, 改这里就要同步改那边。
function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      display_name  TEXT    NOT NULL,
      nameplate     INTEGER NOT NULL DEFAULT 0,
      title         INTEGER NOT NULL DEFAULT 0,
      rating        INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      card_id    TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);

    CREATE TABLE IF NOT EXISTS totp_secrets (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret       TEXT    NOT NULL,
      confirmed_at INTEGER,
      created_at   INTEGER NOT NULL
    );

    -- 游戏端登录会话。token 就是客户端 /1/user/login 拿到的那个, 随每次请求回传。
    -- nw_token 是客户端的设备标识(宿主下发), 只用于排查「同一账号多端登录」。
    CREATE TABLE IF NOT EXISTS native_sessions (
      token       TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id     TEXT    NOT NULL,
      nw_token    TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_native_sessions_user ON native_sessions(user_id);

    -- 玩家档案: 直接存 getProfile/setProfile 的原始 JSON。
    -- 字段太多(20 个)且语义随版本变, 拆成列除了好查没有任何好处, 反而要跟着版本改表。
    CREATE TABLE IF NOT EXISTS native_profiles (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS native_options (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data       TEXT    NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 单曲成绩: 每用户每曲每难度一行(客户端上传的就是个人最佳)。
    -- judge 列是判定构成(基线版客户端不上报, 全为 0): JC=JUSTICE CRITICAL,
    -- j=JUSTICE, atk=ATTACK, miss=MISS, fast/late, 以及 TAP/HOLD/SLIDE/AIR/FLICK 命中。
    CREATE TABLE IF NOT EXISTS native_records (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      music_id   TEXT    NOT NULL,
      difficulty INTEGER NOT NULL,
      score      INTEGER NOT NULL,
      flags      INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      judge_jc   INTEGER NOT NULL DEFAULT 0,
      judge_j    INTEGER NOT NULL DEFAULT 0,
      judge_atk  INTEGER NOT NULL DEFAULT 0,
      judge_miss INTEGER NOT NULL DEFAULT 0,
      judge_fast INTEGER NOT NULL DEFAULT 0,
      judge_late INTEGER NOT NULL DEFAULT 0,
      lane_tap   INTEGER NOT NULL DEFAULT 0,
      lane_hold  INTEGER NOT NULL DEFAULT 0,
      lane_slide INTEGER NOT NULL DEFAULT 0,
      lane_air   INTEGER NOT NULL DEFAULT 0,
      lane_flick INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, music_id, difficulty)
    );
    CREATE INDEX IF NOT EXISTS idx_native_records_music ON native_records(music_id, difficulty, score DESC);

    CREATE TABLE IF NOT EXISTS native_course_records (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      course_id  INTEGER NOT NULL,
      score      INTEGER NOT NULL,
      flags      INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, course_id)
    );

    CREATE TABLE IF NOT EXISTS native_chara_states (
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chara_id  TEXT    NOT NULL,
      rank      INTEGER NOT NULL DEFAULT 0,
      exp       INTEGER NOT NULL DEFAULT 0,
      skill_id  TEXT    NOT NULL DEFAULT '',
      trans_idx INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, chara_id)
    );
  `);

  // 加列迁移: 老库(判定构成之前建的)没有这些列, 这里逐条 ALTER 补上。
  // 幂等: 已经有了就跳过(PRAGMA table_info 查一次真实列名)。
  const have = new Set(db.prepare("PRAGMA table_info(native_records)").all().map((r) => r.name));
  const judgeCols = [
    ["judge_jc", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_j", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_atk", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_miss", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_fast", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_late", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_tap", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_hold", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_slide", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_air", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_flick", "INTEGER NOT NULL DEFAULT 0"]
  ];
  for (const [name, type] of judgeCols) {
    if (have.has(name)) continue;
    db.exec("ALTER TABLE native_records ADD COLUMN " + name + " " + type);
  }
}
