// 口令哈希: scrypt(node 内置, 无外部依赖)。
// 存储格式: scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384, r = 8, p = 1, KEYLEN = 32;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, sN, sR, sP, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(sN), r: Number(sR), p: Number(sP)
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
