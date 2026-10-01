// TOTP (RFC 6238) 实现。基座是 HMAC-SHA1 + 30 秒步长, 与 Google 验证器兼容。
// 只用 node:crypto, 保持服务端零第三方依赖。

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DIGITS = 6;
const PERIOD = 30; // 秒
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // Base32 (RFC 4648)

// 生成 20 字节随机密钥, 用 Base32 表示 —— 这是验证器 App 认的格式。
export function generateSecret() {
  return base32Encode(randomBytes(20));
}

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("非法的 Base32 字符: " + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 指定时间片的口令。counter 是「从纪元起第几个 30 秒」。
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secretBuf).update(buf).digest();
  // 动态截断: 末字节低 4 位决定偏移, 取 4 字节并按 31 位解释
  const off = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[off] & 0x7f) << 24) |
    ((mac[off + 1] & 0xff) << 16) |
    ((mac[off + 2] & 0xff) << 8) |
    (mac[off + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totp(secret, atMs = Date.now()) {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD));
}

// 校验口令。window 允许前后各几个时间片, 容忍手机与服务器的时钟偏差。
// 比对用 timingSafeEqual, 避免按字符比较泄露信息。
export function verifyTotp(secret, code, opts) {
  const window = opts && opts.window !== undefined ? opts.window : 1;
  const atMs = opts && opts.atMs !== undefined ? opts.atMs : Date.now();
  const input = String(code || "").replace(/\s/g, "");
  if (!/^[0-9]{6}$/.test(input)) return false;
  const counter = Math.floor(atMs / 1000 / PERIOD);
  let secretBuf;
  try {
    secretBuf = base32Decode(secret);
  } catch (e) {
    return false;
  }
  const a = Buffer.from(input);
  for (let i = -window; i <= window; i++) {
    const b = Buffer.from(hotp(secretBuf, counter + i));
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

// otpauth:// 链接, 前端据此渲染二维码。Google 验证器扫码即绑定。
export function otpauthUrl(o) {
  const issuer = o.issuer || "UMIGURI";
  const label = encodeURIComponent(issuer + ":" + o.account);
  const q = new URLSearchParams({
    secret: o.secret,
    issuer: issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD)
  });
  return "otpauth://totp/" + label + "?" + q.toString();
}
