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
import { mkdirSync, rmSync } from "node:fs";

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
    l = l + (((encrypt ? out : input)[i] + S[i]) & 255);
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

  const plain = new TextEncoder().encode("联机测试 payload ~ \u0000\u00ff");
  const back = cryptFrame(cryptFrame(plain, true), false);
  ok(Buffer.from(back).equals(Buffer.from(plain)), "加密->解密可还原");
  ok(cryptFrame(new Uint8Array(64), true).length === 64, "64 字节帧(超过密钥长度)不报错");
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
    const frame = parseFrame(Buffer.from(cryptFrame(raw, false)));
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
    this.ws.send(cryptFrame(w.bytes(), true));
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
await a.connect();
await b.connect();
ok(true, "两个 WebSocket 客户端都连上了");

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
  eq(joinSelf.u16(), 1000, "130 里的 rating 来自进房请求(档案里是 0, 用请求值兜底)");
  eq(joinSelf.u16(), 7, "130 里的等级取自云档案(setProfile 写进去的 7)");
  eq(joinSelf.u16(), 1, "130 里的称号稀有度");
  eq(joinSelf.str(), "TITLE", "130 里的称号文本");
  eq(joinSelf.str(), "PLATE", "130 里的名牌文本");
  eq(joinSelf.u16(), 2, "130 里的名牌稀有度");
  eq(joinSelf.str(), "WALL", "130 里的场墙文本");
  eq((await a.nextPush(140)).u16(), roomId, "140 推送的房间号与响应一致");
}

let guestB = 0;
{
  const r = await b.request(2, enterPayload(roomId, "nw-b", "", "BBB"));
  eq(r.body.u16(), 0, "B 加入已有房间结果码 0");
  guestB = r.body.u32();
  ok(guestB > 0, "B 拿到一个游客号");
  eq(r.body.u32(), roomId, "B 进的是 A 的房间");

  const bFirst = await b.nextPush(130);
  const bSecond = await b.nextPush(130);
  eq(bFirst.u32(), userId, "B 先收到 A 的信息");
  eq(bSecond.u32(), guestB, "B 再收到自己的信息");
  const aSecond = await a.nextPush(130);
  eq(aSecond.u32(), guestB, "A 收到 B 的进房推送");
  eq(aSecond.str(), "BBB", "A 看到 B 的名字");
}

{
  const r = await b.request(2, enterPayload(4242, "nw-b", "", "BBB"));
  eq(r.body.u16(), 1, "加入不存在的房间被拒绝(非 0)");
}

{
  const meta = Buffer.from([9, 8, 7, 6, 5]);
  const req = new Writer().u16(0).u16(3).str("song_alpha").raw(meta);
  const r = await a.request(4, req);
  eq(r.body.u16(), 0, "选曲结果码 0");
  const pa = await a.nextPush(132);
  const pb = await b.nextPush(132);
  const yxA = pa.u32();
  eq(pa.u32(), userId, "132 的 nx 是选曲者");
  ok(pa.rest().equals(meta), "132 原样回放曲目元数据");
  eq(pb.u32(), yxA, "B 拿到的对局号 yx 与 A 相同");
  eq(pb.u32(), userId, "B 看到的也是 A 在选曲");
  ok(pb.rest().equals(meta), "B 收到的曲目元数据一致");
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
  eq(scoreB.u32(), 0, "136 开头那个 u32 是占位(客户端会先跳过)");
  ok(scoreB.u32() > 0, "136 带批次号 cT(客户端按 u32 读)");
  ok(scoreB.u32() > 0, "136 带上对局号 yx");
  eq(scoreB.u32(), 2, "136 列出 2 名玩家");
  eq(scoreB.u32(), userId, "136 第一行是 A");
  eq(scoreB.u32(), 888000, "136 里 A 的实时分数正确");
  const nB = scoreB.u32();
  scoreB.u32();
  eq(nB, guestB, "136 第二行是 B(分数 0)");
}

// 137: 对局状态上报(op=19)。服务端以前在这里引用了未定义的 PUSH_STATE,
// 一收到就抛 ReferenceError 把连接打断 —— 对局流程根本走不下去。
{
  const r = await a.request(19, new Writer().u16(3).u16(0));
  eq(r.body.u16(), 0, "上报对局状态结果码 0");
  const stA = await a.nextPush(137);
  ok(stA.u32() > 0, "137 带上对局号 yx(客户端先读它)");
  eq(stA.u16(), 3, "137 广播回状态 3(A 自己)");
  const stB = await b.nextPush(137);
  ok(stB.u32() > 0, "137 也带对局号");
  eq(stB.u16(), 3, "137 也广播给 B");
  // 回退: 更小的状态不应该把房间状态拉低。状态没推进 => 服务端不重复广播,
  // 所以这里断言「没有新的 137」, 而不是等一帧。
  const r2 = await b.request(19, new Writer().u16(1).u16(0));
  eq(r2.body.u16(), 0, "B 上报更小状态也成功");
  await new Promise((v) => setTimeout(v, 120));
  eq(b.pushCount(137), 0, "状态回退不产生新的 137 广播");
  // 推进到 4 就应该再广播一次, 且是 4(取最大)
  const r3 = await b.request(19, new Writer().u16(4).u16(0));
  eq(r3.body.u16(), 0, "B 上报状态 4 成功");
  const stB2 = await b.nextPush(137);
  ok(stB2.u32() > 0, "137 推进到 4 时同样带对局号");
  eq(stB2.u16(), 4, "137 推进到 4");
}

// op=115 是房主「角度/角色数据通道」的分块上传 —— 客户端 v_Ia_28059.zT 里
// 每一块都带 [u32 YC 局号][u32 hT 曲目序号][u32 分块标志], 最后一块收尾。
// 客户端(以及所有等待方)下一步要 await 137 状态 >= 4/5, 而 137 只有服务端
// pushState 会发 —— 以前 115 落到 default 回非 0, 房主打完第一局就卡在「等待
// 对手」, 只好退房; 退房会解散房间, 所有人一起掉线。
// 所以 115 只负责「回 0 + 把上行的角度数据转给同房间其他人」, 真正推进状态的
// 是开局(134 / op=6)与状态上报(19), 那两条走 pushState。
{
  const wx115 = new Writer().u32(1).u32(0).u32(1).raw(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const r115 = await a.request(115, wx115);
  eq(r115.body.u16(), 0, "115(角色数据块)结果码 0");
  // B 应当收到转发的 115(与官方一致: 大厅里其他人的角度数据也要同步)。
  const relay115 = await b.nextPush(115);
  eq(relay115.u32(), 1, "转发的 115 带上了原样回放的局号");
  eq(relay115.u32(), 0, "转发的 115 带上了原样回放的曲目序号");
  eq(relay115.u32(), 1, "转发的 115 带上了原样回放的分块标志");
  ok(relay115.rest().equals(Buffer.from([0xde, 0xad, 0xbe, 0xef])), "转发的 115 原样带回数据块");

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
  const stC = await c.nextPush(137);
  eq(stC.u16(), 5, "C 进房立刻收到当前状态 5(!=2 的 0/1 值已随 115 推高)");
  c.close();
  await new Promise((v) => setTimeout(v, 50));
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

// op=114 是玩家间 WebRTC 信令(头像/角色图 P2P): 服务端只负责转给同房间其他人,
// 不能回非 0 —— 以前回 1 导致对局里永远看不到对手头像。
{
  // YC=1(offer) 应转成 226
  const req114 = new Writer().u32(1).u8(10).u32(7).u8(3);
  const r = await a.request(114, req114);
  eq(r.body.u16(), 0, "信令转发结果码 0(不是非 0)");
  const relayB = await b.nextPush(226);
  eq(relayB.u32(), 1, "226 里第一个 u32 是 YC(offer=1)");
  eq(relayB.u8(), 10, "226 原样带上子类型");
  eq(relayB.u32(), 7, "226 原样带上请求 id");
  eq(relayB.u8(), 3, "226 原样带上角色 id");
  await new Promise((v) => setTimeout(v, 120));
  eq(a.pushCount(226), 0, "信令不回声给发送者自己");

  // YC=2(ICE candidate) 应转成 227
  const reqIce = new Writer().u32(2).u8(9);
  const r2 = await a.request(114, reqIce);
  eq(r2.body.u16(), 0, "ICE 转发结果码 0");
  const relayIce = await b.nextPush(227);
  eq(relayIce.u32(), 2, "227 里 YC=2");
  eq(relayIce.u8(), 9, "227 原样带上子类型");

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
await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => server.close(r));

console.log("");
console.log("通过 " + pass + " 项, 失败 " + fail + " 项");
if (fail) {
  for (const f of failures) console.log("  x " + f);
  process.exit(1);
}
console.log("全部通过");
process.exit(0);
