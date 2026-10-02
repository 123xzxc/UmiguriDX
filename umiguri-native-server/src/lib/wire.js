// 帧加解密与二进制读写 —— 1:1 复刻游戏端实现, 不要凭直觉改。
//
// 客户端对应位置:
//   open-umiguri/src/game-esm/runtime/helpers.js   v_ic_28200 / v_ec_28201 / v_y1_27885
//   open-umiguri/src/game-esm/index.js             v_Po_28121 (读写器) / v_Pa_28060 (sock 客户端)
//
// /sock 上的每个字节都过这里的函数。改动前先跑 test/native-smoke.mjs,
// 里面有一条「与客户端逐字节一致」的用例。

// 客户端 scope.v_y1_27885, 硬编码在 bundle 里(index.js 约 751 行)。
export const CRYPT_KEY = [
  197, 238, 48, 6, 140, 192, 127, 129,
  135, 38, 19, 205, 31, 140, 194, 198,
  74, 128, 201, 166, 197, 85, 192, 237,
  122, 48, 82, 145, 241, 247, 232, 153
];

// 与客户端 v_ic_28200(buf, encrypt) 逐字节等价。收发对称:
// 发(客户端->服务端 或 服务端->客户端)用 encrypt=true, 收用 encrypt=false。
//
// 三个必须照抄的点:
//   1. 载荷字节是 (ks ^ in) ^ (211 & l)。JS 里 & 比 ^ 结合得紧, 所以是「先算 211 & l」,
//      而不是「先异或 211 再与 l」。写串了整条链路都解不出来。
//   2. l 的反馈项用的是 S[i] —— 下标 i, 不是 i % 32。
//   3. l 必须照客户端的写法整体取模: l = (l + (b + S[i])) & 255。
//      客户端的 S 是普通数组, i >= 32 时 S[i] 是 undefined, (b + undefined) 是 NaN,
//      NaN & 255 === 0 —— 也就是「第 32 字节之后 l 恒为 0」。
//      若写成 l = l + ((b + S[i]) & 255), i < 32 时低 8 位一样(211 的 & 只看低 8 位),
//      但 i >= 32 时 l 会保留第 31 字节的旧值, 于是从第 34 字节起整帧解错:
//      表现是「头几个字段(含 op/seq)都对, 后面 offset 越界 / 字符串乱码」。
//      同理 S 必须是普通数组, 不能换成 Uint8Array(会读成 0 而不是 undefined)。
export function cryptFrame(input, encrypt) {
  const n = CRYPT_KEY.length;
  const out = new Uint8Array(input.length);
  const S = CRYPT_KEY.map((k) => 90 ^ k);
  let a = 0;
  let o = 0;
  let l = 0;
  for (let i = 0; i < input.length; i++) {
    a = (a + 1) % n;
    o = (o + S[a]) % n;
    const tmp = S[a];
    S[a] = S[o];
    S[o] = tmp;
    const ks = S[(S[a] + S[o]) % n];
    out[i] = (ks ^ input[i] ^ (211 & l)) & 255;
    l = (l + ((encrypt ? out : input)[i] + S[i])) & 255;
  }
  return out;
}

// 帧头: u32 魔数 + u8 操作码 + u8 序号 (客户端 v_Pa_28060.UT 的写入顺序)。
export const FRAME_HEADER_BYTES = 6;
// 响应帧在此基础上还有一个 u16 结果码(wP)。客户端 onmessage 对它取 u3()。
// 推送帧(op >= 128)没有这一项 —— 客户端直接进 iT(op, reader)。
export const RESPONSE_CODE_BYTES = 2;

// 客户端 v_ec_28201(): 0 .. 2^32-1 的随机数。客户端收到后只跳过、不校验。
export function randomMagic() {
  return Math.floor(Math.random() * 4294967295);
}

// 读: 对应客户端 v_Po_28121 的读方法。
//   u8  -> o3      u16 -> u3      u32 -> v3      i32 -> _3
//   f32 -> w3      f64 -> b3      str -> Ic      skip -> y3
// 注意 str 读的是「u16 字节长度 + UTF-8」, 与客户端一致(客户端在读串前会先 i3("utf-8"))。
export class Reader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }

  get remaining() {
    return this.buf.length - this.off;
  }

  u8() {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }

  u16() {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  i32() {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }

  f32() {
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }

  f64() {
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }

  str() {
    const n = this.u16();
    const s = this.buf.toString("utf8", this.off, this.off + n);
    this.off += n;
    return s;
  }

  skip(n) {
    this.off += n;
    return this;
  }

  slice(n) {
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  rest() {
    return this.buf.subarray(this.off);
  }
}

// 写: 对应客户端 v_Po_28121 的写方法(u8 -> Ag, u16 -> _g, u32 -> hg, str -> vg ...)。
export class Writer {
  constructor() {
    this.chunks = [];
    this.len = 0;
  }

  raw(buf) {
    const b = Buffer.from(buf);
    this.chunks.push(b);
    this.len += b.length;
    return this;
  }

  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 255, 0);
    return this.raw(b);
  }

  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v & 65535, 0);
    return this.raw(b);
  }

  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return this.raw(b);
  }

  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v | 0, 0);
    return this.raw(b);
  }

  f32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(Number(v) || 0, 0);
    return this.raw(b);
  }

  f64(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(Number(v) || 0, 0);
    return this.raw(b);
  }

  str(v) {
    const b = Buffer.from(String(v === undefined || v === null ? "" : v), "utf8");
    this.u16(b.length);
    return this.raw(b);
  }

  bytes() {
    return Buffer.concat(this.chunks, this.len);
  }
}

// 服务端 -> 客户端的推送帧(op >= 128): 魔数 + op + 序号 + 载荷。
export function buildPushFrame(op, seq, payload) {
  const head = new Writer().u32(randomMagic()).u8(op).u8(seq & 255).bytes();
  return Buffer.concat([head, Buffer.from(payload || [])]);
}

// 服务端 -> 客户端的响应帧(op < 128): 魔数 + op + 序号 + u16 结果码 + 载荷。
export function buildResponseFrame(op, seq, code, payload) {
  const head = new Writer()
    .u32(randomMagic())
    .u8(op)
    .u8(seq & 255)
    .u16(code)
    .bytes();
  return Buffer.concat([head, Buffer.from(payload || [])]);
}

// 解析客户端发来的帧(已解密)。长度不足 6 的直接丢掉(和服务端一样不猜)。
export function parseFrame(buf) {
  if (buf.length < FRAME_HEADER_BYTES) return null;
  const r = new Reader(buf);
  const magic = r.u32();
  const op = r.u8();
  const seq = r.u8();
  return { magic, op, seq, body: r, raw: buf };
}
