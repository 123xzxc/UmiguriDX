// 卡号: 注册 / 绑定 / 反查 / 吊销。
//
// 卡号是游戏端的登录凭据 —— 输卡号即登录, 不再要口令。
// 因此这里有两个必须守住的不变量:
//   1. card_id 全局唯一(PRIMARY KEY 保证), 同一张卡不能绑到两个账号;
//   2. 反查必须只认「未吊销」的卡, 吊销后立刻失效(旧卡作废给玩家换新卡用)。

import { getDb } from "./lib/db.js";
import { conflict, notFound, badRequest } from "./lib/http.js";
import { assertCardId, generateCardId, normalizeCardId } from "./lib/card.js";
import { getUserById } from "./users.js";

const now = () => Date.now();

function toPublic(row) {
  if (!row) return null;
  return {
    cardId: row.card_id,
    userId: row.user_id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}

// 给账号发一张卡。cardId 省略时随机生成一张。
// 生成时可能撞号(概率极低), 重试几次再放弃, 避免直接 500。
export function issueCard(userId, { cardId, label = "" } = {}) {
  const db = getDb();
  if (!getUserById(userId)) throw notFound("用户不存在", "user_not_found");

  const wanted = cardId === undefined || cardId === null || cardId === ""
    ? null
    : assertCardId(cardId);

  for (let attempt = 0; attempt < 8; attempt++) {
    const value = wanted || generateCardId();
    const existing = db.prepare("SELECT user_id FROM cards WHERE card_id = ?").get(value);
    if (existing) {
      // 指定卡号时直接报冲突; 随机生成时换一张再试
      if (wanted) throw conflict("该卡号已被占用", "card_taken");
      continue;
    }
    db.prepare(
      "INSERT INTO cards (card_id, user_id, label, created_at) VALUES (?, ?, ?, ?)"
    ).run(value, userId, String(label || ""), now());
    return toPublic(db.prepare("SELECT * FROM cards WHERE card_id = ?").get(value));
  }
  throw badRequest("卡号生成失败, 请重试", "card_generate_failed");
}

// 按卡号反查账号 —— 游戏端登录的唯一入口。
// 只认未吊销的卡: 已吊销的卡应当报「卡不存在」, 不泄露它曾经绑过谁。
export function resolveCard(cardId) {
  const db = getDb();
  const s = normalizeCardId(cardId);
  const row = db.prepare("SELECT * FROM cards WHERE card_id = ? AND revoked_at IS NULL").get(s);
  if (!row) throw notFound("卡号不存在或已失效", "card_not_found");
  return toPublic(row);
}

export function listCards(userId) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM cards WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId);
  return rows.map(toPublic);
}

// 吊销。置 revoked_at 而不是删行, 便于排查与支持「换卡」。
export function revokeCard(userId, cardId) {
  const db = getDb();
  const s = normalizeCardId(cardId);
  const row = db.prepare("SELECT * FROM cards WHERE card_id = ?").get(s);
  if (!row) throw notFound("卡号不存在", "card_not_found");
  if (row.user_id !== userId) throw notFound("卡号不存在", "card_not_found");
  if (row.revoked_at) return toPublic(row);
  db.prepare("UPDATE cards SET revoked_at = ? WHERE card_id = ?").run(now(), s);
  return toPublic(db.prepare("SELECT * FROM cards WHERE card_id = ?").get(s));
}
