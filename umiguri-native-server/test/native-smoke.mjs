#!/usr/bin/env node
// 端到端冒烟测试: 用「模拟客户端」把游戏实际会发出去的字节原样打一遍。
//
// 覆盖:
//   1. 帧加密与客户端实现逐字节一致
//   2. /1/* HTTP: 登录 / 档案 / 设置 / 成绩 / 角色, 以及失败分支
//   3. /sock: 心跳、进房、第二人加入、选曲、实时分数、聊天、离房解散
//   4. 网页面板(/panel + /admin-panel): 与 umiguri-server 共用同一套账号库
//
// 跑法: node test/native-smoke.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, rmSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = resolve(here, "../data");
const dbPath = resolve(dbDir, "test-native.db");
mkdirSync(dbDir, { recursive: true });
for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
  try {
    rmSync(f);
  } catch {
    /* 第一次跑时不存在 */
  }
}
process.env.UMIGURI_DB = dbPath;
process.env.UMIGURI_LOG_LEVEL = "silent";
// 面板的管路要一起测, 所以给管理接口一把固定令牌。
process.env.UMIGURI_ADMIN_TOKEN = "native-smoke-admin";

// 环境变量必须在 import 之前设好, 所以这里用动态 import。
const wire = await import("../src/lib/wire.js");
const { startServer } = await import("../src/index.js");
const { totp } = await import("../../umiguri-server/src/lib/totp.js");
const { cryptFrame, parseFrame, Writer } = wire;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    pass++;
    return true;
  }
  fail++;
  failures.push(label);
  return false;
}

function eq(actual, expected, label) {
  return ok(actual === expected, label + " (期望 " + JSON.stringify(expected) + ", 实际 " + JSON.stringify(actual) + ")");
}

// ---- 1. 帧加密: 与客户端 helpers.js 的 v_ic_28200 逐字节对照 ----
// 下面这段是从客户端源码直接抄下来的, 只把 scope.v_y1_27885 换成本地常量。
// 必须和 src/lib/wire.js 的实现完全一致 —— 任何"顺手优化"都会让游戏连不上。
const CLIENT_KEY = [
  197, 238, 48, 6, 140, 192, 127, 129,
  135, 38, 19, 205, 31, 140, 194, 198,
  74, 128, 201, 166, 197, 85, 192, 237,
  122, 48, 82, 145, 241, 247, 232, 153
];

function clientCrypt(input, encrypt) {
  const n = CLIENT_KEY.length;
  const out = new Uint8Array(input.byteLength);
  const S = CLIENT_KEY.map((k) => 90 ^ k);
  let a = 0;
  let o = 0;
  let l = 0;
  for (let i = 0; i < input.length; ++i) {
    o = (o + S[(a = (a + 1) % n)]) % n;
    const tmp = S[a % n];
    S[a % n] = S[o];
    S[o] = tmp;
    const ks = S[(S[a] + S[o]) % n];
    out[i] = (ks ^ input[i] ^ (211 & l)) & 255;
    // ⚠ 必须照抄客户端的运算符优先级: 客户端是 l = l + (b + S[i]) & 255,
    // 因为 + 比 & 结合得紧, 等价于 (l + b + S[i]) & 255 —— 整体取模。
    // S 是普通数组, i >= 32 时 S[i] 为 undefined, (b + undefined) 是 NaN,
    // NaN & 255 === 0, 也就是第 32 字节之后 l 恒为 0。
    l = (l + ((encrypt ? out : input)[i] + S[i])) & 255;
  }
  return out;
}

{
  let mismatch = 0;
  for (let len = 1; len <= 300; len += 7) {
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = (i * 37 + len * 11) & 255;
    if (Buffer.compare(Buffer.from(cryptFrame(buf, true)), Buffer.from(clientCrypt(buf, true))) !== 0) mismatch++;
  }
  eq(mismatch, 0, "加密结果与客户端逐字节一致(1..300 字节, 步进 7)");

  // 长帧向量(input[i] = i, 64 字节)。差异只会在第 34 字节及以后出现, 所以上面
  // 那条循环对照如果参考实现也抄错了, 是发现不了的 —— 这条向量是硬锚点:
  // 它由「客户端源码逐字转写」的实现生成, 且编码/解码两个方向都用得上。
  {
    const vec = new Uint8Array(64);
    for (let i = 0; i < 64; i++) vec[i] = i;
    eq(
      Buffer.from(cryptFrame(vec, true)).toString("hex"),
      "fc3987a65e5a4ae11b80d614d34cc5cfcd86b2cd5d1b411cc74283da5b03a05d" +
        "de64e997049792bfbb09b53b2380440f79ae8023143d39388a53e7c7afebfd8d",
      "64 字节帧的密文与客户端一致(i>=32 时 l 归零的行为必须保住)"
    );
  }

  const plain = new TextEncoder().encode("联机测试 payload ~ \u0000\u00ff");
  const back = cryptFrame(cryptFrame(plain, true), false);
  ok(Buffer.from(back).equals(Buffer.from(plain)), "加密->解密可还原");
  ok(cryptFrame(new Uint8Array(64), true).length === 64, "64 字节帧(超过密钥长度)不报错");
}


// ---- 1b. 客户端读法: 服务端推送必须能被「客户端的读法」解开 ----
// 只对着服务端自己的 Writer 断言是不够的 —— 那只证明服务端自洽。真正要防的是
// 「服务端写的字段表」与「客户端 iT() 里读的字段表」不一致(132 少回放 w0、136 多写
// 一个 yx 都是这么来的)。下面这两个函数是客户端 $T()/qT() 的逐行转写
// (index.js 4813-4844), 一旦读法与服务端不同, 这里就会对不上或直接越界。
class CliReader {
  constructor(buf) {
    this.s_ = Buffer.from(buf);
    this.U2 = 0;
    this.kg = this.s_.length;
    this.o_ = null;
    this.l_ = 1;
  }
  get remaining() {
    return this.kg - this.U2;
  }
  need(n) {
    // 浏览器里的 DataView 越界会抛 RangeError: Out of bounds access, 这里也抛,
    // 别让 Buffer 的「静默截断」把越界读伪装成正常的空串。
    if (this.U2 < 0 || this.U2 + n > this.kg) throw new RangeError("Out of bounds access(客户端读越界)");
  }
  i3(enc) {
    this.o_ = enc;
    this.l_ = /^utf-16/.test(enc) ? 2 : 1;
  }
  o3() { this.need(1); const v = this.s_.readUInt8(this.U2); this.U2 += 1; return v; }
  u3() { this.need(2); const v = this.s_.readUInt16LE(this.U2); this.U2 += 2; return v; }
  _3() { this.need(4); const v = this.s_.readInt32LE(this.U2); this.U2 += 4; return v; }
  v3() { this.need(4); const v = this.s_.readUInt32LE(this.U2); this.U2 += 4; return v; }
  b3() { this.need(8); const v = this.s_.readDoubleLE(this.U2); this.U2 += 8; return v; }
  Ic() {
    if (null === this.o_) return "";
    const n = this.u3() * this.l_;
    this.need(n);
    this.U2 += n;
    return this.s_.toString("utf8", this.U2 - n, this.U2);
  }
}

// 把服务端 Reader 剩下的字节交给「客户端读法」去解(并把服务端那侧读空)。
function cliView(r) {
  const view = new CliReader(r.rest());
  r.skip(r.remaining);
  return view;
}

// 客户端 $T(writer, chart): 选曲请求体里「曲目」那一段的写法
function writeChart(w, c) {
  w.str(c.w0).str(c.lf).str(c.C5).str(c.y5);
  w.f64(c.m5).f64(c.S5).i32(c.A5);
  const list = c.meta.map((m, i) => [m, i]).filter((row) => row[0]);
  w.u8(list.length);
  for (const row of list) {
    w.u8(0).u8(row[1]).str(row[0].b5).str(row[0].k5).str(row[0].T5);
  }
}

// 客户端 qT(reader): 132 推送里「曲目」那一段的读法 —— 注意它是从 w0 开始读的
function readChart(r) {
  r.i3("utf-8");
  const c = { w0: "", lf: "", C5: "", y5: "", m5: 0, S5: 0, A5: 0, meta: [null, null, null, null, null, null] };
  c.w0 = r.Ic(), c.lf = r.Ic(), c.C5 = r.Ic(), c.y5 = r.Ic();
  c.m5 = r.b3(), c.S5 = r.b3(), c.A5 = r._3();
  const n = r.o3();
  for (let i = 0; i < n; i++) {
    r.o3();
    const idx = r.o3();
    c.meta[idx] = { b5: r.Ic(), k5: r.Ic(), T5: r.Ic() };
  }
  return c;
}
// ---- 模拟客户端 ----
class Sock {
  constructor(port) {
    this.url = "ws://127.0.0.1:" + port + "/sock";
    this.seq = 0;
    this.pushes = new Map();
    this.waiters = new Map();
    this.pending = new Map();
  }

  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("websocket 连接失败"));
      ws.onmessage = (ev) => this.onMessage(new Uint8Array(ev.data));
      ws.onclose = () => this.onClose();
    });
  }

  onMessage(raw) {
    const frame = parseFrame(Buffer.from(clientCrypt(raw, false)));
    if (!frame) return;
    // 115 既是请求码又是转发推送码, 靠「有没有人在等这个 op:seq」区分:
    // 自己在等的那个是响应(进 pending), 其余是服务端转发给别人的(进推送队列)。
    const isResponse = !!this.pending.get(frame.op + ":" + frame.seq);
    if (frame.op >= 128 || (115 === frame.op && !isResponse)) {
      // ⚠ 同一个 Reader 只能交给一个消费者: 以前的写法是「既入队又投递给等待者」,
      // 于是那一帧会被消费两次 —— 第二次读到的是同一个 Reader(off 已经走到底),
      // 报 RangeError, 而且真正的「下一帧」被永远压在队列里。
      const w = this.waiters.get(frame.op);
      if (w && w.length) {
        w.shift()(frame.body);
        return;
      }
      const list = this.pushes.get(frame.op) || [];
      list.push(frame.body);
      this.pushes.set(frame.op, list);
      return;
    }
    const key = frame.op + ":" + frame.seq;
    const p = this.pending.get(key);
    if (p) {
      this.pending.delete(key);
      p(frame);
    }
  }

  onClose() {
    for (const p of this.pending.values()) p(null);
    this.pending.clear();
  }

  send(op, payload) {
    const w = new Writer().u32(Math.floor(Math.random() * 4294967295)).u8(op).u8(++this.seq & 255);
    if (payload) w.raw(payload.bytes());
    this.ws.send(clientCrypt(w.bytes(), true));
    return this.seq;
  }

  request(op, payload, timeoutMs = 3000) {
    const seq = this.send(op, payload);
    const key = op + ":" + seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        rej(new Error("op=" + op + " 等响应超时"));
      }, timeoutMs);
      this.pending.set(key, (frame) => {
        clearTimeout(timer);
        res(frame);
      });
    });
  }

  nextPush(op, timeoutMs = 3000) {
    const list = this.pushes.get(op);
    if (list && list.length) return Promise.resolve(list.shift());
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("等推送 op=" + op + " 超时")), timeoutMs);
      const w = this.waiters.get(op) || [];
      w.push((payload) => {
        clearTimeout(timer);
        res(payload);
      });
      this.waiters.set(op, w);
    });
  }

  pushCount(op) {
    const list = this.pushes.get(op);
    return list ? list.length : 0;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// 对应客户端 v_Bs_28013.Qy(): 三个头必带, Content-Type 是 JSON,
// 所以 WebView 会先打一次 OPTIONS 预检。
async function api(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-cli": "UMIGURI",
      "X-cliver": "test",
      "X-clitest": "false"
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

function checksum(partial) {
  let sum = 0;
  for (const ch of partial) if (ch >= "0" && ch <= "9") sum += Number(ch);
  return sum % 10;
}

function newCard() {
  let digits = "";
  for (let i = 0; i < 15; i++) digits += String(Math.floor(Math.random() * 10));
  const head = "E004" + digits;
  return head + String(checksum(head));
}

// 进房请求体(客户端 tT 的顺序):
// u16 版本, u32 房间号, str nw_token, str token, str 名字,
// u16 rating, u16 rating, u16 称号稀有度, str 称号, str 名牌, u16 名牌稀有度, str 场墙
function enterPayload(roomId, nwToken, token, name) {
  return new Writer()
    .u16(20)
    .u32(roomId)
    .str(nwToken)
    .str(token)
    .str(name)
    .u16(1000)
    .u16(1000)
    .u16(1)
    .str("TITLE")
    .str("PLATE")
    .u16(2)
    .str("WALL");
}

// ---- 2. HTTP ----
const server = startServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));
const port = server.address().port;
const base = "http://127.0.0.1:" + port;

{
  const pre = await fetch(base + "/1/umiguri/getProfile", { method: "OPTIONS" });
  eq(pre.status, 204, "OPTIONS 预检返回 204");
  eq(pre.headers.get("access-control-allow-origin"), "*", "预检响应带 CORS 允许源");
  await pre.text();
}

const card = newCard();
let token = "";
let userId = 0;
{
  const r = await api(base, "/1/user/login", { code: card, nw_token: "nw-test-0001" });
  eq(r.result, "ok", "刷卡登录成功");
  ok(typeof r.token === "string" && r.token.length > 10, "登录返回 token");
  ok(Number.isInteger(r.user_id) && r.user_id > 0, "登录返回 user_id");
  token = r.token;
  userId = r.user_id;
}

{
  const r = await api(base, "/1/user/login", { code: "1234567890", nw_token: "nw-bad" });
  eq(r.result, "card_not_found", "非法卡号回 card_not_found");
}

{
  const r = await api(base, "/1/umiguri/getProfile", { token: "not-a-real-token", nw_token: "x" });
  eq(r.result, "bad", "无效 token 回 bad");
}

{
  const r = await api(base, "/1/umiguri/getProfile", { token, nw_token: "nw-test-0001" });
  eq(r.result, "ok", "新卡 getProfile 直接给一份默认档案");
  eq(r.targetVersion, 1101, "默认档案 targetVersion=1101(与游戏内置常量一致)");
  eq(r.playerLevel, 1, "默认档案 playerLevel=1");
  eq(r.charaId, "UMIGURI/uni", "默认档案 charaId 与游戏离线默认一致");
  ok(Array.isArray(r.chatIds) && r.chatIds.length === 20, "默认档案 chatIds 有 20 项");
}

{
  const r = await api(base, "/1/umiguri/setProfile", {
    token,
    nw_token: "nw-test-0001",
    data: { playerName: "TESTER", playerLevel: 7, titleId: "s_00000001" }
  });
  eq(r.result, "ok", "setProfile 成功");
  const back = await api(base, "/1/umiguri/getProfile", { token, nw_token: "nw-test-0001" });
  eq(back.playerName, "TESTER", "setProfile 后名字已保存");
  eq(back.playerLevel, 7, "setProfile 后等级已保存");
  eq(back.titleId, "s_00000001", "setProfile 后称号已保存");
  eq(back.charaId, "UMIGURI/uni", "setProfile 没带的字段保持原值(不会被冲掉)");
}

{
  const r = await api(base, "/1/umiguri/getOptions", { token, nw_token: "nw-test-0001" });
  eq(r.result, "ok", "getOptions 成功");
  eq(r.scrollSpeed, 4, "默认 scrollSpeed=4(照抄游戏内置预设, 给 0 会没法玩)");
  eq(r.masterVolume, 100, "默认 masterVolume=100(给 0 会整机静音)");
  const s = await api(base, "/1/umiguri/setOptions", { token, nw_token: "nw-test-0001", data: { scrollSpeed: 9 } });
  eq(s.result, "ok", "setOptions 成功");
  const back = await api(base, "/1/umiguri/getOptions", { token, nw_token: "nw-test-0001" });
  eq(back.scrollSpeed, 9, "setOptions 后 scrollSpeed 已保存");
  eq(back.mirror, 0, "setOptions 没带的字段保持原值");
}

{
  const s = await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: { musicId: "music_001", musicDiff: 3, score: 990000, flags: 5, playCount: 2, updatedAt: 111 }
  });
  eq(s.result, "ok", "setRecord(单曲) 成功");
  await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: { musicId: "music_001", musicDiff: 3, score: 100, flags: 0, playCount: 1, updatedAt: 222 }
  });
  const back = await api(base, "/1/umiguri/getRecords", { token, nw_token: "nw-test-0001" });
  eq(back.result, "ok", "getRecords 成功");
  eq(back.table.length, 1, "同一曲同一难度只留一行");
  eq(back.table[0].score, 990000, "低分不覆盖高分");
  eq(back.table[0].playCount, 2, "playCount 取最大值");
  eq(back.table[0].musicDiff, 3, "成绩里的 musicDiff 保留");
}

{
  // 判定构成: 高分那局的明细应当被保存, 且低分不覆盖。
  await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: {
      musicId: "judge_001",
      musicDiff: 3,
      score: 1000000,
      flags: 1,
      playCount: 1,
      updatedAt: 444,
      judge: {
        justiceCritical: 8,
        justice: 7,
        attack: 5,
        miss: 689,
        fast: 6,
        late: 6,
        maxCombo: 5,
        noteCount: 715,
        lanes: {
          tap: { hits: 16, total: 700 },
          hold: { hits: 0, total: 3 },
          slide: { hits: 4, total: 8 },
          air: { hits: 0, total: 2 },
          flick: { hits: 0, total: 2 }
        }
      }
    }
  });
  const rec = await api(base, "/1/umiguri/getRecords", { token, nw_token: "nw-test-0001" });
  const row = rec.table.find((r) => r.musicId === "judge_001");
  eq(!!row, true, "判定成绩已入库");
  eq(row.judge.justiceCritical, 8, "JUSTICE CRITICAL 已保存");
  eq(row.judge.justice, 7, "JUSTICE 已保存");
  eq(row.judge.attack, 5, "ATTACK 已保存");
  eq(row.judge.miss, 689, "MISS 已保存");
  eq(row.judge.fast, 6, "FAST 已保存");
  eq(row.judge.late, 6, "LATE 已保存");
  eq(row.lanes.tap, 16, "TAP 命中数已保存");
  eq(row.lanes.slide, 4, "SLIDE 命中数已保存");
  eq(row.lanes.hold, 0, "HOLD 命中数已保存");
  // 低分不覆盖高分, 判定明细也必须保持高分那局。
  await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: {
      musicId: "judge_001",
      musicDiff: 3,
      score: 500000,
      flags: 0,
      playCount: 2,
      updatedAt: 445,
      judge: { justiceCritical: 0, justice: 0, attack: 0, miss: 999, fast: 0, late: 0 }
    }
  });
  const rec2 = await api(base, "/1/umiguri/getRecords", { token, nw_token: "nw-test-0001" });
  const row2 = rec2.table.find((r) => r.musicId === "judge_001");
  eq(row2.score, 1000000, "低分不覆盖高分");
  eq(row2.judge.justiceCritical, 8, "判定明细仍属于最高分那一局");
  eq(row2.judge.miss, 689, "MISS 未被低分局覆盖");
  // 老客户端(不带 judge)也要能正常写, 不报错。
  const legacy = await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: { musicId: "legacy_001", musicDiff: 1, score: 900000, flags: 1, playCount: 1, updatedAt: 446 }
  });
  eq(legacy.result, "ok", "不带 judge 的老客户端仍能上报");
}

{
  await api(base, "/1/umiguri/setRecord", {
    token,
    nw_token: "nw-test-0001",
    data: { courseId: 12, score: 2000000, flags: 1, playCount: 1, updatedAt: 333 }
  });
  const back = await api(base, "/1/umiguri/getCourseRecords", { token, nw_token: "nw-test-0001" });
  eq(back.result, "ok", "getCourseRecords 成功");
  eq(back.table.length, 1, "course 记录有 1 行");
  eq(back.table[0].courseId, 12, "course 记录保留 courseId");
}

{
  await api(base, "/1/umiguri/setCharaState", {
    token,
    nw_token: "nw-test-0001",
    data: { charaId: "UMIGURI/uni", rank: 3, exp: 120, skillId: "skill_a", transIdx: 1 }
  });
  const back = await api(base, "/1/umiguri/getCharaStates", { token, nw_token: "nw-test-0001" });
  eq(back.result, "ok", "getCharaStates 成功");
  eq(back.table.length, 1, "角色状态有 1 行");
  eq(back.table[0].rank, 3, "角色 rank 已保存");
}

{
  const r = await api(base, "/1/umiguri/getProfile", { token, nw_token: "nw-test-0001" });
  eq(r.playerName, "TESTER", "重新取档案名字仍然是面板/游戏里改过的那个");
}

// ---- 3. /sock ----
const a = new Sock(port);
const b = new Sock(port);
const joiner = new Sock(port); // 专门用来做「加入房间号」的正反例, 不占用 B 的房内状态
await a.connect();
await b.connect();
await joiner.connect();
ok(true, "三个 WebSocket 客户端都连上了");

{
  const r = await a.request(1, null);
  eq(r.body.u16(), 0, "心跳 op=1 收到结果码 0");
}

let roomId = 0;
{
  const r = await a.request(2, enterPayload(0, "nw-a", token, "AAA"));
  const code = r.body.u16();
  const nx = r.body.u32();
  roomId = r.body.u32();
  eq(code, 0, "A 进房(新建)结果码 0");
  eq(nx, userId, "A 拿到自己的 user_id");
  ok(roomId > 0 && roomId <= 65535, "房间号落在 16 位范围内(客户端按 u16 用)");

  // 推送与响应是两个独立的帧, 必须按顺序从队列里取。
  const joinSelf = await a.nextPush(130);
  eq(joinSelf.u32(), userId, "130 里的 nx 是自己");
  eq(joinSelf.str(), "AAA", "130 里的名字来自进房请求");
  // ⚠ 这四个数值字段客户端是按 **u16**(u3) 读的, 只有名字和文本是 str。
  //   必须与 src/sock.js 的 Member.writeJoin 同宽 —— 曾误改成 u32, 整条帧从第 13 字节
  //   起错位 2 字节, 真机表现为「一进房间就卡死」(Length out of range of buffer)。
  //   客户端源码那一行: lm = u3(), CC = u3(), lx = u3(), MC = u3()。
  eq(joinSelf.u16(), 1000, "130 里的 rating 来自进房请求(档案里是 0, 用请求值兜底)");
  eq(joinSelf.u16(), 7, "130 里的等级取自云档案(setProfile 写进去的 7)");
  eq(joinSelf.u16(), 1, "130 里的称号稀有度");
  eq(joinSelf.str(), "TITLE", "130 里的称号文本");
  eq(joinSelf.str(), "PLATE", "130 里的名牌文本");
  eq(joinSelf.u16(), 2, "130 里的名牌稀有度");
  eq(joinSelf.str(), "WALL", "130 里的场墙文本");
  eq(joinSelf.remaining, 0, "130 的字段宽度与客户端读法完全对齐(无剩余字节)");
  eq((await a.nextPush(140)).u16(), roomId, "140 推送的房间号与响应一致");
}

let guestB = 0;
{
  const r = await b.request(2, enterPayload(roomId, "nw-b", "", "BBB"));
  eq(r.body.u16(), 0, "B 加入已有房间结果码 0");
  guestB = r.body.u32();
  ok(guestB > 0, "B 拿到一个游客号");
  // ⚠ 游客号必须是「普通的小号」, 不能是 0xF0000000 这类高位掩码。
  //   客户端拿 nx 做有序比较(sx() < 对端 nx)来定 WebRTC 主叫方, 游客号一旦恒大于
  //   所有真实玩家, 那两处比较永远为 false, 头像/角色那条 P2P 通道就建不起来。
  ok(guestB < 0x7fffffff, "游客号落在普通整数范围(不占用高位, 比较不会错)" + " (实际 " + guestB + ")");
  eq(r.body.u32(), roomId, "B 进的是 A 的房间");

  // ⚠ 140(房间号下发)除了进房那一刻, 还必须在 **op=21(QUERY)** 之后补一帧。
  //   客户端的推送分发 iT() 整体被 `if (this.EC)` 包着: EC 是 settingsStore.T0() 里
  //   才 vx(v_w_29167) 装上的, 而进房那一刻服务端就把 140 推出来了 —— 回调还没装,
  //   这一帧会被**直接丢弃**。140 又恰好是**非房主在大堂收尾进选歌界面的唯一入口**
  //   (房主被 `tx` 那个条件短路排除, 只能手动点 Skip), 丢了就永久卡在大堂。
  //   补在 QUERY 之后能对上时序: T0() 里 QS(100) 是 await 的, 响应一 resolve 下一句
  //   就是 vx()(微任务), 而补发的 140 是紧随响应的下一条 WS 消息(宏任务)。
  eq((await b.nextPush(140)).u16(), roomId, "B 进房时的 140 房间号正确");
  const bq = await b.request(21, new Writer().u16(100));
  eq(bq.body.u16(), roomId, "op=21(QUERY) 响应的结果码就是房间号");
  eq((await b.nextPush(140)).u16(), roomId, "op=21 之后补发的 140 房间号正确(非房主收尾的唯一入口)");

  const bFirst = await b.nextPush(130);
  const bSecond = await b.nextPush(130);
  eq(bFirst.u32(), userId, "B 先收到 A 的信息");
  eq(bSecond.u32(), guestB, "B 再收到自己的信息");
  const aSecond = await a.nextPush(130);
  eq(aSecond.u32(), guestB, "A 收到 B 的进房推送");
  eq(aSecond.str(), "BBB", "A 看到 B 的名字");
}

// 「输入房间号却进了随机房间」是这条链路上最容易回归的地方, 所以这里正反都钉死:
//   1. 带一个不存在的号 -> 拒绝, 绝不能顺手新建一个随机房把玩家糊进去;
//   2. 带一个存在的号 -> 必须进那个号, 而不是又新建;
//   3. 建房(wantRoom=0)时才是真的新建, 且新号与已有房间不同。
// (客户端把 6 位数字拼成 u32 交给 tT, 服务端 pickRoom 用 0 表示「建房」。)
{
  const r = await b.request(2, enterPayload(4242, "nw-b", "", "BBB"));
  eq(r.body.u16(), 1, "加入不存在的房间被拒绝(非 0)");

  const missing = await joiner.request(2, enterPayload(60000, "nw-j", "", "JJJ"));
  eq(missing.body.u16(), 1, "60000 号不存在 -> 依然拒绝(不会被当成建房)");

  const rejoin = await joiner.request(2, enterPayload(roomId, "nw-j", "", "JJJ"));
  eq(rejoin.body.u16(), 0, "用 A 的房间号加入 -> 结果码 0");
  rejoin.body.u32(); // nx(自己的 id), 这里不关心
  eq(rejoin.body.u32(), roomId, "响应里的房间号 == 请求的房间号(没有新建随机房)");
  await joiner.request(3, null); // 退出, 免得后面 A 房解散断言被多出来的人影响
}

{
  // 选曲请求体 = u16 0 + u16 难度 + $T(曲目) —— 曲目那一段必须**整段**回放到 132 里,
  // 只回放 w0 之后的部分会让客户端的 qT() 把所有字段往前挪(以前就是这个错)。
  const chart = {
    w0: "music_alpha",
    lf: "曲名",
    C5: "作曲家",
    y5: "pop",
    m5: 12.5,
    S5: 96.25,
    A5: 7,
    meta: [null, null, { b5: "谱面作者", k5: "3", T5: "notes.json" }, null, null, null]
  };
  const req = new Writer().u16(0).u16(3);
  writeChart(req, chart);
  const r = await a.request(4, req);
  eq(r.body.u16(), 0, "选曲结果码 0");
  const pa = await a.nextPush(132);
  const pb = await b.nextPush(132);
  const yxA = pa.u32();
  eq(pa.u32(), userId, "132 的 nx 是选曲者");
  {
    // 用客户端的读法解一遍: 字段必须逐一还原(含中文与 f64)
    const ca = cliView(pa);
    const c = readChart(ca);
    eq(c.w0, chart.w0, "132 的 w0 是曲目 id(客户端 qT 从这里开始读)");
    eq(c.lf, chart.lf, "132 还原 lf(中文)");
    eq(c.C5, chart.C5, "132 还原 C5(中文)");
    eq(c.y5, chart.y5, "132 还原 y5");
    eq(c.m5, chart.m5, "132 还原 m5");
    eq(c.S5, chart.S5, "132 还原 S5");
    eq(c.A5, chart.A5, "132 还原 A5");
    eq(c.meta[2].b5, chart.meta[2].b5, "132 还原难度 2 的 b5(中文)");
    eq(c.meta[2].k5, chart.meta[2].k5, "132 还原难度 2 的 k5");
    eq(c.meta[2].T5, chart.meta[2].T5, "132 还原难度 2 的 T5");
    eq(c.meta[0], null, "没被选中的难度不占位(客户端读法下就是 null)");
    eq(ca.remaining, 0, "132 载荷正好读完, 没有多余字节");
  }
  eq(pb.u32(), yxA, "B 拿到的对局号 yx 与 A 相同");
  eq(pb.u32(), userId, "B 看到的也是 A 在选曲");
  {
    const cb = cliView(pb);
    const c = readChart(cb);
    eq(c.w0, chart.w0, "B 收到的 132 里 w0 一致");
    eq(c.meta[2].T5, chart.meta[2].T5, "B 收到的 132 里谱面信息一致");
    eq(cb.remaining, 0, "B 的 132 载荷也正好读完");
  }
}

{
  const req = new Writer().u32(1).u32(1).u32(888000).u32(0).u32(0);
  const r = await a.request(20, req);
  eq(r.body.u16(), 0, "上报分数结果码 0");
  const rankB = await b.nextPush(138);
  eq(rankB.u32(), 0, "138 开头那个 u32 是占位(客户端会先跳过)");
  ok(rankB.u32() > 0, "138 带上了对局号");
  eq(rankB.u32(), 2, "138 榜单里有 2 人");
  eq(rankB.u32(), userId, "榜首是 A");
  eq(rankB.u32(), 888000, "榜首分数正确");
  eq(rankB.u32(), 0, "榜首的 flags 透传");

  // 136: 对局中「看对手分数」那条推送。以前服务端只发 138, 客户端那条分支
  // (v_Ks_28025) 永远收不到, 对局画面里就看不到别人实时涨分。
  const scoreB = await b.nextPush(136);
  const scoreRaw = Buffer.from(scoreB.rest()); // 留一份, 后面用客户端读法重读
  eq(scoreB.u32(), 0, "136 开头那个 u32 是占位(客户端会先跳过)");
  ok(scoreB.u32() > 0, "136 带批次号 cT(客户端按 u32 读)");
  // 客户端的 136 分支(v_Ks_28025)读法严格是: 跳过 u32, cT(u32), 行数(u32),
  // 每行 { nx: u32, Sr: u32 } —— 这里读出来的「行数」必须正好是人数。
  // 以前多写了一个局号 yx, 客户端会把局号当行数: 局号跨局累加, 一旦大于人数
  // 就会按那个数字继续读行 -> RangeError: Out of bounds access。
  eq(scoreB.u32(), 2, "136 的行数就是房间人数(客户端拿它当循环次数)");
  eq(scoreB.u32(), userId, "136 第一行是 A");
  eq(scoreB.u32(), 888000, "136 里 A 的实时分数正确");
  const nB = scoreB.u32();
  scoreB.u32();
  eq(nB, guestB, "136 第二行是 B(分数 0)");
  eq(scoreB.remaining, 0, "136 载荷正好读完(没有客户端会误读的多余字段)");
  {
    // 再用「客户端的读法」把同一帧重读一遍(客户端的 136 分支: 跳过 u32 -> cT ->
    // 行数 -> 每行 {nx, Sr}), 行数必须正好是人数、且正好读完 —— 多一个字段就会挂。
    const r136 = new CliReader(scoreRaw);
    r136.v3();
    ok(r136.v3() > 0, "136 第二项是 cT(客户端读法)");
    eq(r136.v3(), 2, "136 第三项是行数 = 人数(客户端拿它当循环次数)");
    eq(r136.v3(), userId, "136 第一行 nx");
    eq(r136.v3(), 888000, "136 第一行 Sr");
    eq(r136.v3(), guestB, "136 第二行 nx");
    eq(r136.v3(), 0, "136 第二行 Sr");
    eq(r136.remaining, 0, "136 按客户端读法正好读完");
  }
}

// 137: 对局状态上报(op=19)。服务端以前在这里引用了未定义的 PUSH_STATE,
// 一收到就抛 ReferenceError 把连接打断 —— 对局流程根本走不下去。
{
  // 进房时服务端无条件补发过一帧 137(状态 0), 先排空, 只看这次上报触发的。
  a.pushes.set(137, []);
  b.pushes.set(137, []);
  const r = await a.request(19, new Writer().u16(3).u16(0));
  eq(r.body.u16(), 0, "上报对局状态结果码 0");
  const stA = await a.nextPush(137);
  ok(stA.u32() > 0, "137 带上对局号 yx(客户端先读它)");
  eq(stA.u16(), 3, "137 广播回状态 3(A 自己)");
  const stB = await b.nextPush(137);
  ok(stB.u32() > 0, "137 也带对局号");
  eq(stB.u16(), 3, "137 也广播给 B");
  // 回退(关键回归): 一局打完回大堂/选歌时房主重报状态 1, **必须真的降到 1**。
  //   以前这里是 Math.max(room.state, n1), 房间状态到过 5 之后永远回不去 ——
  //   非房主在选歌界面等的 `Tx(1)` 被 5 直接满足、而游戏内的 Tx(3/4/5) 又被陈旧的
  //   高状态放行, 两边状态机错开: 真机表现「房主点跳过/Next, 其他人回不到选歌界面」。
  //   同时每次上报都仍要**回一帧** 137(客户端是「挂上 waiter, 再收一帧才醒」)。
  b.pushes.set(137, []); // 排空历史上压下的 137, 只看这次请求触发的那一帧
  const r2 = await b.request(19, new Writer().u16(1).u16(0));
  eq(r2.body.u16(), 0, "B 上报更小状态也成功");
  const stBack = await b.nextPush(137);
  ok(stBack.u32() > 0, "回退时那帧 137 同样先带对局号");
  eq(stBack.u16(), 1, "状态回退必须真的降到 1(不能停留在旧的高状态)");
  a.pushes.set(137, []);
  const stBackA = await a.nextPush(137);
  eq(stBackA.u16(), 1, "回退的 137 也广播给房主自己");
  // 把状态推回 3(上一段刚降到 1), 后面这句才是「同一状态重复上报也要回帧」的回归。
  await b.request(19, new Writer().u16(3).u16(0));
  b.pushes.set(137, []);
  a.pushes.set(137, []);
  // ⚠ 关键回归: 同一个状态值**再报一次**, 也必须回一帧 137。
  //   客户端的等待是「aP/sP < n → 挂 Promise, 等 137 来 resolve」(v_Hs_28017.iP/Tx),
  //   所以「等的人已经挂上、状态又恰好等于目标值」时, 只有再来一帧才会醒。
  //   以前服务端 next === room.state 就 return, 真机表现就是「跳过匹配/点开始之后,
  //   非房主玩家停在大厅不进歌曲界面」。
  b.pushes.set(137, []);
  const rRepeat = await b.request(19, new Writer().u16(3).u16(0));
  eq(rRepeat.body.u16(), 0, "重复上报同一状态结果码 0");
  const stRepeat = await b.nextPush(137);
  ok(stRepeat.u32() > 0, "重复上报也回 137(带对局号)");
  eq(stRepeat.u16(), 3, "重复上报回的还是那个状态值(不能被吞掉)");

  const r3 = await b.request(19, new Writer().u16(4).u16(0));
  eq(r3.body.u16(), 0, "B 上报状态 4 成功");
  const stB2 = await b.nextPush(137);
  ok(stB2.u32() > 0, "137 推进到 4 时同样带对局号");
  eq(stB2.u16(), 4, "137 推进到 4(按最后上报者的状态)");

  // ⚠ 状态重播回归: 房主点「开始」只发一次 op=19, 广播也只有一帧 137。
  //   非房主那一刻若还没挂上 `Tx(1)` 的 waiter(刚进房/正在切界面), 这一帧就被
  //   永久错过, 后面不会再有 137 —— 真机表现「房主点开始, 别人进不去选歌界面」。
  //   服务端现在在非 0 状态期间每 500ms 重播一次, 这里断言「不再上报也会自己来一帧」。
  a.pushes.set(137, []);
  b.pushes.set(137, []);
  const stReplay = await b.nextPush(137, 3000);
  ok(stReplay.u32() > 0, "重播的 137 同样先带对局号");
  ok(stReplay.u16() >= 0, "没再上报时, 服务端也会重播状态(唤醒错过的 waiter)");
  // 房主那边可能压着更早的帧, 这里只断言「不主动上报也能收到重播」。
  // 具体值不做断言: 定时器是 500ms 一轮, 断言期间别的用例可能已经把房间状态改掉。
  const stReplayA = await a.nextPush(137, 3000);
  ok(stReplayA.u32() > 0, "重播同时发给房主自己(带对局号)");
}

// 状态回退到 1 时必须清掉选曲并广播 133(回归)。
//   真机: 一局打完房主结算回大堂, 非房主却回不到选歌/主菜单 —— 因为服务端
//   还留着上一局的 selection, 下一局/中途进房的人立刻收到 PICK 补发, 状态机错开。
{
  const chartBack = {
    w0: "music_back",
    lf: "回退测试",
    C5: "composer",
    y5: "pop",
    m5: 1.5,
    S5: 120.5,
    A5: 3,
    meta: [null, null, { b5: "author", k5: "3", T5: "n.json" }, null, null, null]
  };
  // 选曲(建立 selection, 服务端会把状态置 1), 再把状态推到对局中, 最后回退到 1。
  const backReq = new Writer().u16(0).u16(3);
  writeChart(backReq, chartBack);
  await a.request(4, backReq);
  await b.nextPush(132);
  await a.request(19, new Writer().u16(3).u16(0));
  await b.nextPush(137);
  b.pushes.set(133, []);
  b.pushes.set(137, []);
  const rBack = await a.request(19, new Writer().u16(1).u16(0));
  eq(rBack.body.u16(), 0, "回退到状态 1 结果码 0");
  // 500ms 重播可能插进来旧帧, 这里只断言「确实降下来了」(不再停在 3)。
  let stBack137 = await b.nextPush(137, 3000);
  if (stBack137.u16() >= 3) stBack137 = await b.nextPush(137, 3000);
  ok(stBack137.u16() < 3, "137 从 3 回退到 1(不再停在已开局状态)");
  const unpick = await b.nextPush(133, 3000);
  ok(unpick.u32() >= 0, "回退到 1 时广播了 133(带局号)");
  eq(unpick.u16(), 0, "133 的状态位是 0(与 OP_UNPICK 一致)");
}
// op=6「开局」必须把房间状态从 1 推到 2(回归)。
//   真机: 房主点开始只走 xx(true)=op=19 状态 1, 非房主进对局等的是 Tx(3) 那一档,
//   而 2/3 只有 Lx 会上报、在自建服务端上不一定落到线上 —— 房间状态永远停在 1,
//   日志里就是非房主侧无限刷 "137 收到: 房状态 sP=1", 一直不进选歌界面。
{
  // 先把房间状态压回 1(模拟刚进房/刚回到选歌), 再发 op=6。
  b.pushes.set(137, []);
  await a.request(19, new Writer().u16(1).u16(0));
  await b.nextPush(137);
  a.pushes.set(137, []);
  b.pushes.set(137, []);
  const rStart = await a.request(6, new Writer().u32(1234).u16(0));
  eq(rStart.body.u16(), 0, "op=6(开局)结果码 0");
  const stStartB = await b.nextPush(137);
  ok(stStartB.u32() > 0, "开局那帧 137 同样先带对局号");
  ok(stStartB.u16() >= 2, "开局必须把 137 状态推过 1(非房主才不会永久卡住)");
  // 房主那边同时也应拿到开局帧。这里只排空「本用例之前」的旧帧, 再取一帧;
  // 具体值由上面的 B 断言覆盖(500ms 重播可能插进来同值帧, 值断言在 B 上做)。
  const stStartA = await a.nextPush(137, 3000);
  ok(stStartA.u32() > 0, "开局帧也广播给房主自己(带对局号)");
}
// op=115 是「资源提供方回给请求方」的数据块通道(客户端 v_Ia_28059.zT):
//   [u32 YC 自己的玩家槽位][u32 hT 资源 id][u32 分块标志(bit1=2 数据/bit2=4 头/bit0=1 末块)] + 数据
// 请求方在 v_Ia_28059.XI() 里等的是 **227**, 且读法正好是这三项, 所以服务端
// 必须把 115 改写成 227 再转发(115 是请求码, 原样转会被当成响应而进不了推送分发)。
// 以前原样转 115 -> 对端永远收不到资源 -> 对局里看不到对手角色/头像。
{
  const wx115 = new Writer().u32(1).u32(0).u32(1).raw(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const r115 = await a.request(115, wx115);
  eq(r115.body.u16(), 0, "115(资源数据块)结果码 0");
  // B 应当收到的是转发的 227(布局与载荷逐字节一致)。
  const relay115 = await b.nextPush(227);
  eq(relay115.u32(), 1, "转发的 227 带上了原样回放的 YC(发送者槽位)");
  eq(relay115.u32(), 0, "转发的 227 带上了原样回放的资源 id");
  eq(relay115.u32(), 1, "转发的 227 带上了原样回放的分块标志");
  ok(relay115.rest().equals(Buffer.from([0xde, 0xad, 0xbe, 0xef])), "转发的 227 原样带回数据块");
  await new Promise((v) => setTimeout(v, 120));
  eq(a.pushCount(227), 0, "资源数据不回声给发送者自己");

  // 开局推进靠 op=6(134)/op=19: 这里补一次 op=19 到 5, 后面的「中途进房」
  // 用例期望的当前状态就是 5。
  // 先排空前面 (3→4 那一步) 压下的旧帧, 再看「推进到 5」的新帧。
  a.pushes.set(137, []);
  b.pushes.set(137, []);
  const r19 = await a.request(19, new Writer().u16(5).u16(0));
  eq(r19.body.u16(), 0, "上报状态 5 结果码 0");
  const st5a = await a.nextPush(137);
  ok(st5a.u32() > 0, "137 带对局号");
  eq(st5a.u16(), 5, "137 把房间状态推到 5");
  const st5b = await b.nextPush(137);
  ok(st5b.u32() > 0, "137 也带对局号");
  eq(st5b.u16(), 5, "137 的状态也广播给其他玩家");
}

// 中途进房的人必须补发当前对局状态, 否则他在「等状态 >= N」那步会一直等下去。
{
  const c = new Sock(port);
  await c.connect();
  const r = await c.request(2, enterPayload(roomId, "", "nw-c", "CCC"));
  eq(r.body.u16(), 0, "C 中途进房成功");
  r.body.u32();
  r.body.u32();
  await c.nextPush(130);
  // 进房会补发一帧当前状态(现在无条件发, 包括 0)。
  const stC = await c.nextPush(137);
  // 载荷与 pushState 一致: 先 u32 局号, 再 u16 状态(客户端的 137 分支就是这么读的)
  ok(stC.u32() > 0, "C 收到的 137 也带局号");
  eq(stC.u16(), 5, "C 进房立刻收到当前状态 5");
  // 同时补一帧 141(准备状态): 客户端 iP(n) 等的是 aP, 而 aP **只**由 141 推进。
  //   137 走的是另一条值(sP), 两者不能互相代替 —— 真机日志「iP(1) 等待中 aP=0」
  //   加「137 收到: 房状态 sP=1」就是这个 bug 的指纹。
  const rdC = await c.nextPush(141);
  eq(rdC.u16(), 0, "C 进房立刻收到一帧 141(此刻房间还没人 oP, 所以是 0; 关键是这帧必须在)");
  c.close();
  await new Promise((v) => setTimeout(v, 50));
}

// 141: 准备状态(op=22 oP)。客户端 iP(n) 等的是 aP —— **只有 141 能推进它**。
// 之前客户端的 iP() 错把上报发成 op=19(137/sP 那条), aP 永远是 0, iP 挂的
// Promise 永不 resolve: 拿着房号进来的人站在大堂不动, 进不了选歌界面。
// 服务端这边要保证: 每次 oP 都回一帧, 且回的是「房间整体的就绪值」。
{
  a.pushes.set(141, []);
  b.pushes.set(141, []);
  const r1 = await a.request(22, new Writer().u16(1));
  eq(r1.body.u16(), 0, "oP(1) 结果码 0");
  const rdA = await a.nextPush(141);
  eq(rdA.u16(), 1, "141 回给发起者自己(唤醒了 aP)");
  const rdB = await b.nextPush(141);
  eq(rdB.u16(), 1, "141 也广播给房间里其他人");
  // 重复上报同一个值也必须回帧(客户端是「挂上 Promise, 再收一帧才醒」)。
  a.pushes.set(141, []);
  await a.request(22, new Writer().u16(1));
  eq((await a.nextPush(141)).u16(), 1, "重复上报 22 也要回一帧 141");
  // 回的是房间整体的就绪值, 不是发起者这次写的那个数字。
  const r0 = await a.request(22, new Writer().u16(0));
  eq(r0.body.u16(), 0, "oP(0) 结果码 0");
  eq((await a.nextPush(141)).u16(), 1, "回的是房间整体就绪值 1(不被单次 0 拉低)");
  // ⚠ 141 只写客户端的 aP, 那**只对已经挂上 iP(1) 的人**有用。而「拿着房号加入」的
  //   非房主在大堂里根本没人挂 iP —— 他等的是 137(sP, 走 Tx(1))。房主点 Skip 时发出
  //   的唯一信号就是这条 op=22, 所以服务端必须**同时**给非房主补一帧 137 状态 1,
  //   否则 2 人房里非房主永远停在大堂(真机表现: 「玩家2进不来选歌界面」)。
  //   137 的载荷是 { yx: u32, n1: u16 } —— 少了那个 u32 客户端第一个读法就越界。
  const stB = await b.nextPush(137);
  ok(stB.u32() > 0, "137 里带一个 u32 局号(客户端先读它再读状态)");
  eq(stB.u16(), 1, "非房主收到 137 状态 1(房主收尾信号)");
  eq(stB.remaining, 0, "137 的字段宽度与客户端读法完全对齐(无剩余字节)");
}

{
  const req = new Writer().u32(1).u32(0).str("hello 联机");
  const r = await b.request(25, req);
  eq(r.body.u16(), 0, "聊天结果码 0");
  const p144 = await a.nextPush(144);
  eq(p144.u32(), guestB, "144(对局内聊天)的发送者是 B");
  p144.u32();
  p144.u32();
  eq(p144.str(), "hello 联机", "144 带上了聊天文本");
  const p145 = await a.nextPush(145);
  ok(p145.u32() > 0, "145 带递增的消息序号 tL(客户端靠它排序)");
  eq(p145.u32(), guestB, "145(大厅消息)的发送者是 B");
  ok(p145.u32() > 0, "145 带上对局号");
  eq(p145.u32(), 0, "145 里的聊天 id 透传(自由文本为 0)");
  p145.f64();
  eq(p145.str(), "hello 联机", "145 带上了聊天文本");
}

// 客户端「gg」写串 = u32 字节长度 + UTF-8; 这里配一个读法用来逐字节复核原样透传。
const ggRead = (r) => { const n = r.u32(); return r.rest() ? Buffer.from(r.slice(n)).toString("utf8") : ""; };

// op=114 是玩家间 P2P 信令(头像/角色图): 服务端只负责转给同房间其他人, 不能回非 0。
//
// ⚠ 114 **一律**转成 226, 不能按载荷内容拆 226/227:
//   226 的读法 = u32 YC + u8 子类型 + 参数(= 114 载荷本身);
//   227 的读法 = u32 YC + u32 资源 id + u32 分块标志(= op=115 的载荷)。
//   以前按「YC 是不是 1」拆, 于是槽位不是 1 的玩家发什么都被丢进 227,
//   对面 XI 拿 u8 子类型当 u32 读 -> 抛「二进制读取越界」。
{
  // 子类型 10 = 「请把这个资源 id 发给我」-> 226 原样转发
  const req114 = new Writer().u32(1).u8(10).u32(7).u8(3);
  const r = await a.request(114, req114);
  eq(r.body.u16(), 0, "信令转发结果码 0(不是非 0)");
  const relayB = await b.nextPush(226);
  eq(relayB.u32(), 1, "226 里第一个 u32 是 YC(发送者槽位)");
  eq(relayB.u8(), 10, "226 原样带上子类型");
  eq(relayB.u32(), 7, "226 原样带上请求 id");
  eq(relayB.u8(), 3, "226 原样带上资源类型");
  await new Promise((v) => setTimeout(v, 120));
  eq(a.pushCount(226), 0, "信令不回声给发送者自己");

  // 槽位不是 1 的玩家发的信令同样走 226(以前会被误判成 227)
  const reqIce = new Writer().u32(2).u8(2).raw(Buffer.from([0x7b, 0x7d]));
  const r2 = await a.request(114, reqIce);
  eq(r2.body.u16(), 0, "ICE 转发结果码 0");
  const relayIce = await b.nextPush(226);
  eq(relayIce.u32(), 2, "226 里 YC 是发送者槽位 2");
  eq(relayIce.u8(), 2, "226 原样带上子类型(ICE)");
  await new Promise((v) => setTimeout(v, 120));
  eq(a.pushCount(227), 0, "114 不会被误转成 227");

  // 114 转成 227 时曾经越界: 用 226 的读法逐字节复核一遍载荷没有被动过。
  // 客户端写串用的是「u32 长度 + UTF-8」(gg), 不是服务端底层的 u16 str。
  const gg = (w, v) => { const b = Buffer.from(v, "utf8"); w.u32(b.length); w.raw(b); return w; };
  const reqOffer = gg(gg(new Writer().u32(1).u8(1), "v=0"), "o=- 1 1 IN IP4 0.0.0.0");
  await a.request(114, reqOffer);
  const relayOffer = await b.nextPush(226);
  eq(relayOffer.u32(), 1, "226 的 YC");
  eq(relayOffer.u8(), 1, "226 的子类型(SDP offer)");
  eq(ggRead(relayOffer), "v=0", "226 载荷里的 SDP 原样透传(第一段)");
  eq(ggRead(relayOffer), "o=- 1 1 IN IP4 0.0.0.0", "226 载荷里的 SDP 原样透传(第二段)");


// ---- 3b. 头像/角色 P2P: 用客户端**真实读法**复核 226/227 两条通道 ----
// 这段把 v_Ia_28059.OI / XI 的读法逐行搬过来, 直接喂服务端发出去的那一帧,
// 目的: 一旦有人再把 114 转成 227(或把 115 原样转), 这里会立刻抛「二进制读取越界」,
// 而不是等到真机上「看不到对手头像/角色」才发现。
//
// nextPush 交回来的 Reader 已经读掉了 magic/op/seq(off=6), buf 是整帧。
// 客户端 onmessage 也是这么读的, 所以这里从同一个位置接着读即可。
const clientReaderClass = (() => {
  // 等价于 open-umiguri/src/game-esm/index.js 的 v_Po_28121:
  //   th = new Uint8Array(input.buffer || input);  kg = th.byteLength;  Bp() = th.buffer
  return class ClientReader {
    constructor(input) {
      const th = new Uint8Array(input ? input.buffer || (input.byteLength ? input : 1) : 1);
      this.th = th;
      this.s_ = new DataView(th.buffer);
      this.U2 = 0;
      this.kg = th.byteLength;
    }
    o3() { if (this.U2 + 1 > this.kg) throw new Error("二进制读取越界: " + (this.U2 + 1) + " > " + this.kg); return this.s_.getUint8(this.U2++); }
    v3() { if (this.U2 + 4 > this.kg) throw new Error("二进制读取越界: " + (this.U2 + 4) + " > " + this.kg); this.U2 += 4; return this.s_.getUint32(this.U2 - 4, true); }
    y3(n) { this.U2 += n; }
    Bp() { return this.th.buffer; }
  };
})();

// 从「服务端 Reader(已读掉帧头)」还原出客户端视角的位置: 同一块 buf, 同一个 off。
function asClient(serverReader) {
  // 客户端拿到的是 WebSocket 的 ArrayBuffer, 而 Node 的 Buffer 是共享内存池的视图
  // (.buffer 可能是 8KB 的池) —— 这里先拷成独立 Uint8Array, 才是客户端真正的视角。
  const buf = Uint8Array.from(serverReader.buf);
  const r = new clientReaderClass(buf);
  r.y3(serverReader.off);
  return r;
}

{
  const req114b = new Writer().u32(7).u8(10).u32(4242).u8(3);
  await a.request(114, req114b);
  const f226 = asClient(await b.nextPush(226));
  // —— 客户端 226 分支(v_Hs_28017.OI, 桌面路径)原样读: YC, 子类型, id, type ——
  eq(f226.v3(), 7, "226 客户端读法: YC = 发送者槽位(不是 1 也必须走 226)");
  eq(f226.o3(), 10, "226 客户端读法: 子类型 10(要资源)");
  eq(f226.v3(), 4242, "226 客户端读法: 资源 id");
  eq(f226.o3(), 3, "226 客户端读法: 资源类型");
  ok(f226.U2 === f226.kg, "226 载荷恰好读满, 没有多余/缺失字节");

  // 资源提供方回 115(u32 YC + u32 id + u32 标志 + 数据) -> 服务端必须转成 227
  const data = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
  const wx = new Writer().u32(7).u32(4242).u32(2 | 1).raw(data);
  await a.request(115, wx);
  const f227 = asClient(await b.nextPush(227));
  // —— 客户端 227 分支(v_Ia_28059.XI)原样读: 先 YC, 再 y3(U2) 之后 id, flag, data ——
  eq(f227.v3(), 7, "227 客户端读法: YC");
  const off = f227.U2;
  const r2 = new clientReaderClass(f227.Bp());
  r2.y3(off);
  eq(r2.v3(), 4242, "227 客户端读法: 资源 id(把 114 转成 227 时这里会读到子类型字节)");
  eq(r2.v3(), 3, "227 客户端读法: 分块标志 2|1(数据+末块)");
  const payload = new Uint8Array(f227.Bp()).subarray(8 + off);
  ok(Buffer.from(payload).equals(data), "227 客户端读法: 数据块原样");
}

  const r3 = await a.request(99, new Writer().u32(1));
  ok(r3.body.u16() !== 0, "未实现的操作码回非 0");
}

{
  const r = await a.request(3, null);
  eq(r.body.u16(), 0, "离房结果码 0");
  const closed = await b.nextPush(129);
  eq(closed.u32(), roomId, "房主离开后 B 收到 129(房间解散)");
  const r2 = await b.request(1, null);
  eq(r2.body.u16(), 0, "房间解散后 B 仍然能心跳(连接没断)");
}

// ---- 4. 网页面板(面板挂在原生服务端上, 见 src/web-panel.js) ----
{
  const page = await fetch(base + "/panel");
  eq(page.status, 200, "玩家面板返回 200");
  ok(String(page.headers.get("content-type")).includes("text/html"), "玩家面板是 HTML");
  const html = await page.text();
  ok(html.includes("UMIGURI 玩家面板"), "玩家面板页面内容正确");

  const adminPage = await fetch(base + "/admin-panel");
  eq(adminPage.status, 200, "管理面板返回 200");
  const adminHtml = await adminPage.text();
  ok(adminHtml.includes("管理员令牌"), "管理面板页面内容正确");
}

const adminHeaders = {
  authorization: "Bearer " + process.env.UMIGURI_ADMIN_TOKEN,
  "content-type": "application/json"
};
const panelUser = await (await fetch(base + "/admin/users", {
  method: "POST",
  headers: adminHeaders,
  body: JSON.stringify({ username: "panel01" })
})).json();
ok(panelUser.user && panelUser.user.id > 0, "管理接口建号成功");
ok(typeof panelUser.totpSecret === "string" && panelUser.totpSecret.length >= 16, "管理接口给出 TOTP 密钥");

let panelCard = "";
{
  const r = await (await fetch(base + "/admin/cards", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ userId: panelUser.user.id, label: "面板卡" })
  })).json();
  panelCard = r.card && r.card.cardId;
  ok(/^E004[0-9]{16}$/.test(String(panelCard)), "管理接口发的卡是 20 位 E004 卡: " + panelCard);
}

// 管理接口建的号 + 发的卡, 直接走游戏原生登录 —— 两个服务端必须是同一个库。
let panelToken = "";
{
  const r = await api(base, "/1/user/login", { code: panelCard, nw_token: "nw-panel-0001" });
  eq(r.result, "ok", "管理接口发的卡能走原生刷卡登录");
  eq(r.user_id, panelUser.user.id, "原生登录认的就是管理接口建的那个账号");
  panelToken = r.token;
}

{
  const r = await api(base, "/1/umiguri/setRecord", {
    token: panelToken,
    nw_token: "nw-panel-0001",
    data: { musicId: "song_panel", musicDiff: 2, score: 1009500, flags: 1, playCount: 1, updatedAt: 1 }
  });
  eq(r.result, "ok", "面板账号上报成绩成功");
}

let panelCookie = "";
{
  const res = await fetch(base + "/panel/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "panel01", code: totp(panelUser.totpSecret) })
  });
  const setCookie = String(res.headers.get("set-cookie") || "");
  await res.text();
  eq(res.status, 200, "面板 TOTP 登录成功");
  ok(setCookie.startsWith("umg_panel="), "下发面板会话 cookie");
  panelCookie = setCookie.split(";")[0];
}

{
  const res = await fetch(base + "/panel/me", { headers: { cookie: panelCookie } });
  const me = await res.json();
  eq(res.status, 200, "带面板会话读 me 返回 200");
  eq(me.user && me.user.username, "panel01", "面板会话指向正确账号");
  eq((me.cards || []).length, 1, "面板能看到自己名下的卡");
}

{
  const res = await fetch(base + "/panel/plays?limit=20", { headers: { cookie: panelCookie } });
  const data = await res.json();
  eq(res.status, 200, "带面板会话读 plays 返回 200");
  ok(Array.isArray(data.plays) && data.plays.length >= 1, "面板能看到游玩记录(原生成绩已镜像到 plays)");
  if (data.plays && data.plays.length) {
    eq(data.plays[0].musicId, "song_panel", "面板记录里的曲目正确");
    eq(data.plays[0].score, 1009500, "面板记录里的分数正确");
    eq(data.plays[0].rank, "SSS+", "面板按分数算出的等级正确");
    eq(data.plays[0].clear, 1, "面板记录里的通关状态取自 flags 第 0 位");
  }
}

{
  const res = await fetch(base + "/panel/nonexistent", { headers: { cookie: panelCookie } });
  await res.text();
  eq(res.status, 404, "面板下的未知路径仍然 404");
}

let restToken = "";

{
  const res = await fetch(base + "/auth/card", {
    method: "POST",
    headers: { "content-type": "application/json", "X-cli": "UMIGURI" },
    body: JSON.stringify({ cardId: panelCard })
  });
  const data = await res.json();
  eq(res.status, 200, "游戏端旧 REST(/auth/card)也挂到了原生服务端上");
  eq(data.ok, true, "旧 REST 回的是自己的 {ok:...} 格式, 不是原生格式");
  ok(typeof data.token === "string" && data.token.length > 0, "卡号登录拿到游戏端 JWT");
  restToken = data.token;
}

// 启动器拿到 token 之后紧接着会调 /auth/whoami 和 /profile, 这两个也必须通。
{
  const res = await fetch(base + "/auth/whoami", { headers: { authorization: "Bearer " + restToken } });
  const data = await res.json();
  eq(res.status, 200, "旧 REST 的 /auth/whoami 认可 /auth/card 签发的 token");
  eq(data.user && data.user.username, "panel01", "whoami 指向卡号所属账号");
}

{
  const res = await fetch(base + "/profile", { headers: { authorization: "Bearer " + restToken } });
  await res.json();
  eq(res.status, 200, "旧 REST 的 /profile 认可 /auth/card 签发的 token");
}

// /rooms 是启动器联机用的, 建房间要通(否则启动器会显示联机不可用)。
{
  const res = await fetch(base + "/rooms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + restToken },
    body: JSON.stringify({})
  });
  const data = await res.json();
  eq(res.status, 200, "旧 REST 能建房");
  ok(/^[0-9]{6}$/.test(String(data.room && data.room.code)), "房间号是 6 位数字");
}

// 不在两套 router 路径里的东西必须维持原来的 404(原生格式), 免得把游戏接口吃掉。
{
  const res = await fetch(base + "/nope/deep");
  const data = await res.json();
  eq(res.status, 404, "未挂载的路径仍然 404");
  eq(data.result, "bad", "未挂载路径回的是原生格式的错误");
}

{
  const res = await fetch(base + "/1/umiguri/nope", {
    method: "POST",
    headers: { "content-type": "application/json", "X-cli": "UMIGURI" },
    body: JSON.stringify({})
  });
  const data = await res.json();
  eq(data.result, "bad", "原生接口的未知端点仍然是原生格式的错误");
}

a.close();
b.close();
joiner.close();
await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => server.close(r));

console.log("");
// ============================================================================
// 客户端分支完整性静态回归(不需要跑游戏):
//   v_Hs_28017.iT 是 /sock 推送的总入口, 每条推送码都必须有分支, 否则那一帧会被
//   最后的 else 静默丢掉。真机上「iP(1) 等待中 aP=0」就是 141 这一支缺失造成的 ——
//   服务端发了 141, 客户端收到了, 但没人处理, aP 永远是 0, iP 挂的 Promise 永不 resolve。
//   以后再加/删推送码时, 这份表会直接报出来。
{
  const src = readFileSync(new URL("../../open-umiguri/src/game-esm/index.js", import.meta.url), "utf8");
  const iT = src.slice(src.indexOf("  iT: function (v_i_33880, v_e_33881) {"), src.indexOf("  ZC: function (v_t_33904) {"));
  ok(iT.length > 500, "取到了 v_Hs_28017.iT 函数体");
  // 每条推送码 -> 它必须写的那块状态。
  const required = [
    ["130", "v_js_28019", "加入房间(PUSH_JOIN)"],
    ["132", "v_Vs_28021", "选曲(PUSH_PICK)"],
    ["134", "v_Xs_28023", "开局(PUSH_PLAY)"],
    ["135", "v_zs_28024", "结束(PUSH_DONE)"],
    ["136", "v_Ks_28025", "实时分数(PUSH_SCORE)"],
    ["137", "v_Ys_28026", "对局状态(PUSH_STATE) -> sP, 服务 Tx()"],
    ["138", "v_qs_28027", "排行榜(PUSH_RANK)"],
    ["141", "v_Qs_28030", "准备(PUSH_ALLREADY) -> aP, 服务 iP()"],
    ["143", "v_ta_28031", "资料(PUSH_PROFILE)"],
    // 144(对局内聊天)不在这一层: 它由 gameCore 的 v_Gi_30328 处理, 见 7.11 (2)。
    ["226", "v_na_28034", "信令(WebRTC SDP/ICE)"],
    ["227", "v_ra_28035", "资源数据块"],
  ];
  for (const [code, sym, what] of required) {
    ok(iT.includes(sym), "客户端 iT 有 " + code + " 分支 (" + what + ")");
  }
  // 141 必须真的写 aP 并唤醒 rP —— 这两个字段是 iP() 的全部依赖。
  ok(/v_Qs_28030\)[^]*?this\.aP = /.test(iT) || /v_Qs_28030[^;]*this\.aP = /.test(iT), "141 分支把状态写进 this.aP");
  ok(/v_Qs_28030[^]*?this\.nP === [^]*?this\.rP/.test(iT), "141 分支会唤醒 iP 挂的 rP");
}

console.log("通过 " + pass + " 项, 失败 " + fail + " 项");
if (fail) {
  for (const f of failures) console.log("  x " + f);
  process.exit(1);
}
console.log("全部通过");
process.exit(0);

