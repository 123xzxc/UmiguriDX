// AIME 卡号: 20 位, 以 E004 开头, 后面 16 位数字。
// 这是街机通行的卡号格式; 尾部 1 位是校验位。

// 卡号在本服务端是「凭据之一」: 绑定到账号后, 游戏内输入卡号即可登录,
// 不需要口令。网页面板则走 TOTP, 两套凭据互相独立。

import { badRequest } from "./http.js";

const CARD_PREFIX = "E004";
const CARD_LENGTH = 20;
const CARD_PATTERN = /^E004[0-9]{16}$/;

export { CARD_PREFIX, CARD_LENGTH, CARD_PATTERN };

// 规范化: 去空白与连字符、统一大写。用户在游戏里可能带空格输入。
export function normalizeCardId(value) {
  return String(value || "").replace(/[\s-]/g, "").toUpperCase();
}

export function assertCardId(value) {
  const s = normalizeCardId(value);
  if (s.length !== CARD_LENGTH || !CARD_PATTERN.test(s)) {
    throw badRequest("卡号必须是 20 位、以 E004 开头的数字串", "invalid_card_id");
  }
  return s;
}

export function isValidCardId(value) {
  const s = normalizeCardId(value);
  return s.length === CARD_LENGTH && CARD_PATTERN.test(s);
}

// 生成一张随机卡号。管理面板注册时用。
// 校验位 = 前 19 位中数字之和 mod 10 —— 简单可校验, 不追求密码学强度。
export function generateCardId() {
  let digits = "";
  for (let i = 0; i < 15; i++) digits += String(Math.floor(Math.random() * 10));
  return CARD_PREFIX + digits + String(checksum(CARD_PREFIX + digits));
}

function checksum(partial) {
  let sum = 0;
  for (const ch of partial) {
    if (ch >= "0" && ch <= "9") sum += Number(ch);
  }
  return sum % 10;
}

export function verifyChecksum(cardId) {
  const s = normalizeCardId(cardId);
  if (s.length !== CARD_LENGTH) return false;
  return Number(s[19]) === checksum(s.slice(0, 19));
}
