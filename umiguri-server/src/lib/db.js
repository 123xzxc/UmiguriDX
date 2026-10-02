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
      display_name  TEXT    NOT NULL,
      nameplate     INTEGER NOT NULL DEFAULT 0,
      title         INTEGER NOT NULL DEFAULT 0,
      rating        INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    -- 卡号体系(见 lib/card.js 与 users.js 的卡号函数)。
    -- cards 独立成表而不是塞进 users.cards 字段, 因为: 一个账号可持多张卡,
    -- 而卡号登录要求「按卡号反查账号」是 O(1), 需要 UNIQUE 索引。
    CREATE TABLE IF NOT EXISTS cards (
      card_id    TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT    NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);

    -- 网页面板的 TOTP 凭据。一个账号一行; secret 在用户首次绑定时生成。
    -- 绑定前 confirmed_at 为 NULL, 登录时拒绝未确认的密钥(否则等于谁都能绑)。
    CREATE TABLE IF NOT EXISTS totp_secrets (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret       TEXT    NOT NULL,
      confirmed_at INTEGER,
      created_at   INTEGER NOT NULL
    );
    -- 面板会话(无密码登录后签发), 与游戏端 JWT 分开: 面板 cookie 只用于网页,
    -- 不下发给游戏, 避免网页会话被拿去冒充游戏客户端。
    CREATE TABLE IF NOT EXISTS panel_sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_panel_sessions_user ON panel_sessions(user_id);

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
