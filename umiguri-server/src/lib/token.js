// JWT(HS256) 签发与校验。只用 node:crypto, 不引第三方库。

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(data) {
  return b64url(createHmac("sha256", config.jwtSecret).update(data).digest());
}

export function issueToken(payload, ttlSeconds = config.jwtTtlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(body));
  return `${head}.${claims}.${sign(`${head}.${claims}`)}`;
}

// 校验失败返回 null(不抛异常), 调用方统一按 401 处理。
export function verifyToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, claims, sig] = parts;
  const expected = sign(`${head}.${claims}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(b64urlDecode(claims).toString("utf8"));
    if (typeof body.exp !== "number" || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}
