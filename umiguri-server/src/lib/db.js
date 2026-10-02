// SQLite 封装。
// 用 node 内置的 node:sqlite(Node 22.5+ 实验特性, Node 24 起稳定), 免外部依赖。
// 若运行环境没有 node:sqlite, 会在 load 时给出明确报错。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

let db = null;
// 连接是不是本模块开的。原生服务端会把自己的连接交过来(attachDb),
// 那种连接由它自己负责关闭, 这里只管放手, 免得 close 两次。
let ownsDb = true;

export function openDb(path = config.dbPath) {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // 另一个进程(原生服务端)可能正在写, 等一会儿而不是直接报 SQLITE_BUSY。
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  ownsDb = true;
  return db;
}

// 复用外部已经打开的连接。
// 为什么必须共用: 同一个进程里对同一个库开两个连接, 一旦并发写就会互相卡住 ——
// SQLite 的 busy_timeout 是给跨进程用的, 同进程内那个锁永远等不到。原生服务端
// 把自己的连接交过来, 面板那套模块(users/cards/panel/admin)就跟着用同一个句柄。
export function attachDb(handle) {
  if (!handle) throw new Error("attachDb 需要一个已打开的数据库连接");
  if (db && db !== handle) throw new Error("数据库已经初始化, 不能换成另一个连接");
  db = handle;
  ownsDb = false;
  return db;
}

// 建表(全部 IF NOT EXISTS, 幂等)。外部连接接上后由调用方执行一次。
export function migrateSchema(target = getDb()) {
  migrate(target);
  return target;
}

export function getDb() {
  if (!db) throw new Error("数据库未初始化, 请先调用 openDb()");
  return db;
}

export function closeDb() {
  if (db) {
    const handle = db;
    db = null;
    if (ownsDb) handle.close();
    ownsDb = true;
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

    -- 管理面板会话。与玩家面板会话分表: 玩家会话绝不能被当成管理员,
    -- 哪怕两边的 token 生成方式一样。
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token      TEXT    PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- 判定构成: 完整一局明细(JC/J/ATK/MISS、FAST/LATE、各曲种命中 + 最大连击 + 物量)。
    -- 老库靠 migrate 末尾的 ensureColumns 补列(ALTER TABLE), 所以这里可以放心加。
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
      judge_j     INTEGER NOT NULL DEFAULT 0,
      judge_atk   INTEGER NOT NULL DEFAULT 0,
      judge_fast  INTEGER NOT NULL DEFAULT 0,
      judge_late  INTEGER NOT NULL DEFAULT 0,
      lane_tap    INTEGER NOT NULL DEFAULT 0,
      lane_hold   INTEGER NOT NULL DEFAULT 0,
      lane_slide  INTEGER NOT NULL DEFAULT 0,
      lane_air    INTEGER NOT NULL DEFAULT 0,
      lane_flick  INTEGER NOT NULL DEFAULT 0,
      note_total  INTEGER NOT NULL DEFAULT 0,
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

  // 老库升级: 上面是 CREATE TABLE IF NOT EXISTS, 已有的 plays 表不会因此多出新列。
  // 逐列检查并 ALTER, 幂等可反复跑。
  ensureColumns(d, "plays", [
    ["judge_j", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_atk", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_fast", "INTEGER NOT NULL DEFAULT 0"],
    ["judge_late", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_tap", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_hold", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_slide", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_air", "INTEGER NOT NULL DEFAULT 0"],
    ["lane_flick", "INTEGER NOT NULL DEFAULT 0"],
    ["note_total", "INTEGER NOT NULL DEFAULT 0"]
  ]);
}

// 给已有表补列。SQLite 没有 ADD COLUMN IF NOT EXISTS, 所以先查 PRAGMA table_info,
// 缺一列补一列。
function ensureColumns(d, table, cols) {
  const have = new Set(d.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  for (const [name, decl] of cols) {
    if (have.has(name)) continue;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}
