// SQLite 封装。
// 用 node 内置的 node:sqlite(Node 22.5+ 实验特性, Node 24 起稳定), 免外部依赖。
// 若运行环境没有 node:sqlite, 会在 load 时给出明确报错。

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

// 建表。全部 IF NOT EXISTS, 可重复执行。
function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      display_name  TEXT    NOT NULL,
      nameplate     INTEGER NOT NULL DEFAULT 0,
      title         INTEGER NOT NULL DEFAULT 0,
      rating        INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plays (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      music_id    TEXT    NOT NULL,
      difficulty  INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      rank        TEXT    NOT NULL DEFAULT '',
      clear       INTEGER NOT NULL DEFAULT 0,
      combo       INTEGER NOT NULL DEFAULT 0,
      judge_crit  INTEGER NOT NULL DEFAULT 0,
      judge_miss  INTEGER NOT NULL DEFAULT 0,
      played_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plays_user   ON plays(user_id, played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plays_music  ON plays(music_id, difficulty, score DESC);

    -- 每用户每曲每难度只保留个人最佳, 用于排行榜快速取数
    CREATE TABLE IF NOT EXISTS bests (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      music_id   TEXT    NOT NULL,
      difficulty INTEGER NOT NULL,
      score      INTEGER NOT NULL,
      rank       TEXT    NOT NULL DEFAULT '',
      clear      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, music_id, difficulty)
    );
    CREATE INDEX IF NOT EXISTS idx_bests_music ON bests(music_id, difficulty, score DESC);

    CREATE TABLE IF NOT EXISTS rooms (
      code       TEXT    PRIMARY KEY,
      host_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      music_id   TEXT,
      difficulty INTEGER,
      status     TEXT    NOT NULL DEFAULT 'lobby',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_players (
      code       TEXT    NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ready      INTEGER NOT NULL DEFAULT 0,
      score      INTEGER NOT NULL DEFAULT 0,
      progress   INTEGER NOT NULL DEFAULT 0,
      joined_at  INTEGER NOT NULL,
      PRIMARY KEY (code, user_id)
    );
  `);
}
