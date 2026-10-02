// 游戏内联机(/sock WebSocket 二进制协议)。
//
// 客户端实现在 open-umiguri/src/game-esm/index.js 的 v_Pa_28060.prototype:
//   - 帧: u32 魔数 + u8 操作码 + u8 序号, 整体过 v_ic_28200 加密(见 lib/wire.js)
//   - op < 128 : 客户端发出的请求。服务端必须回「同 op + 同序号」的响应,
//                响应体开头多一个 u16 结果码(客户端读作 wP), 0 = 成功。
//                序号是客户端自己 1..254 循环分配的, 不回它就永远挂在那里等。
//   - op >= 128: 服务端主动推送, 布局见客户端 iT() 的各个分支。
//
// 各操作的语义是从 gameCore / settingsStore(nLobby) / v_nr_27925 的调用点倒推的。
// 拿不准的地方都写了注释; 排障时开 UMIGURI_SOCK_TRACE=1 对照客户端行为。

import { config } from "./config.js";
import { cryptFrame, buildPushFrame, buildResponseFrame, parseFrame, Writer } from "./lib/wire.js";
import { acceptWebSocket } from "./lib/ws.js";
import { getProfileFor, resolveSession } from "./store.js";

// 客户端 -> 服务端(括号里是客户端 v_Pa_28060 的方法名)
export const OP_PING = 1;       // AL  心跳, 客户端每 2 秒一次
export const OP_ENTER = 2;      // tT  进入/新建房间(带身份)
export const OP_LEAVE = 3;      // UC  离开房间
export const OP_PICK = 4;       // HC  选曲
export const OP_UNPICK = 5;     // OC  取消选曲
export const OP_START = 6;      // VC  开局
export const OP_FINISH = 7;     // WC  结束
export const OP_STATE = 19;     // XC  上报自己的对局状态
export const OP_SCORE = 20;     // zC  实时上报分数
export const OP_QUERY = 21;     // KC  查询房间号
export const OP_READY = 22;     // oP  准备
export const OP_PROFILE = 23;   // tR  改名牌/称号/场墙
export const OP_CHAT = 24;      // II  快捷聊天
export const OP_CHAT_FREE = 25; // fL  自由文本
export const OP_AVATAR = 114;   // 客户端来要头像/角色图(见 v_Ia_28059._C)

// 服务端 -> 客户端推送
export const PUSH_ROOM_CLOSED = 129; // {ZT}             房主解散 -> 客户端直接退房
export const PUSH_JOIN = 130;        // {Hx}             有人进房(含自己)
export const PUSH_LEFT = 131;        // {nx, ZT}         有人离开
export const PUSH_PICK = 132;        // {yx, nx, ng}     选曲(ng 原样回放)
export const PUSH_UNPICK = 133;      // {yx, ZT}         取消选曲
export const PUSH_PLAY = 134;        // {yx, nx, ru, te} 开局
export const PUSH_DONE = 135;        // {yx, nx, ZT}     结束
export const PUSH_RANK = 138;        // {oT, lT}         实时排行榜
export const PUSH_ROOM_ID = 140;     // {uT}             房间号下发
export const PUSH_ALLREADY = 141;    // {n1}             准备状态
export const PUSH_PROFILE = 143;     // {Hx}             名牌/称号/场墙变更
export const PUSH_CHAT_PLAY = 144;   // {nx, yx, fI, MI} 对局内聊天
export const PUSH_CHAT_LOBBY = 145;  // {tL, nx, yx, _L, iL, MI} 大厅消息

const ROOM_ID_MAX = 65534;

const rooms = new Map();
let nextGuestId = 0xf0000000;
let feedSeq = 1;

function trace(...args) {
  if (config.traceSock) console.log("[native][sock]", ...args);
}

function randomRoomId() {
  for (let i = 0; i < 500; i++) {
    const id = 1 + Math.floor(Math.random() * ROOM_ID_MAX);
    if (!rooms.has(id)) return id;
  }
  return 1 + Math.floor(Math.random() * ROOM_ID_MAX);
}

class Member {
  constructor(conn) {
    this.conn = conn;
    this.userId = conn.userId;
    this.name = conn.name;
    this.rating = conn.rating;
    this.level = conn.level;
    this.titleRarity = conn.titleRarity;
    this.titleText = conn.titleText;
    this.nameplateText = conn.nameplateText;
    this.nameplateRarity = conn.nameplateRarity;
    this.fieldWallText = conn.fieldWallText;
    this.ready = 0;
    this.score = 0;
    this.flags = 0;
  }

  // PUSH_JOIN(130) 载荷布局 —— 客户端 iT 里的读法:
  //   u32 nx, str om, u16 lm, u16 CC, u16 lx, str ox, str TC, u16 MC, str RC
  //   nx=玩家id om=显示名 lm=rating CC=等级 lx=称号稀有度 ox=称号文本
  //   TC=名牌文本 MC=名牌稀有度 RC=场墙文本
  // 正好与 OP_ENTER 客户端发上来的字段一一对应(所以这里不需要猜)。
  writeJoin(w) {
    w.u32(this.userId);
    w.str(this.name);
    w.u16(this.rating);
    w.u16(this.level);
    w.u16(this.titleRarity);
    w.str(this.titleText);
    w.str(this.nameplateText);
    w.u16(this.nameplateRarity);
    w.str(this.fieldWallText);
  }

  // PUSH_PROFILE(143): u32 nx, str TC, u16 MC, str RC
  writeProfile(w) {
    w.u32(this.userId);
    w.str(this.nameplateText);
    w.u16(this.nameplateRarity);
    w.str(this.fieldWallText);
  }

  joinPayload() {
    const w = new Writer();
    this.writeJoin(w);
    return w.bytes();
  }
}

// 房间: 一个选曲 + 一张实时榜。id 取 16 位(客户端把它当 u16 用, 见 OP_QUERY)。
function pickRoom(conn, wantRoom) {
  if (!wantRoom) return { room: null, error: null };
  const room = rooms.get(wantRoom);
  if (!room) return { room: null, error: "not_found" };
  if (room.members.size >= config.roomMaxPlayers) return { room: null, error: "full" };
  return { room, error: null };
}

export function handleSocketUpgrade(req, socket, head) {
  const conn = {
    ws: null,
    userId: 0,
    guest: false,
    session: null,
    member: null,
    room: null,
    name: "",
    rating: 0,
    level: 1,
    titleRarity: 0,
    titleText: "",
    nameplateText: "",
    nameplateRarity: 0,
    fieldWallText: "",
    remote: (socket.remoteAddress || "?") + ":" + (socket.remotePort || 0)
  };

  const ws = acceptWebSocket(req, socket, head, {
    onMessage: (buf) => onMessage(conn, buf),
    onClose: () => leaveRoom(conn, "socket 关闭")
  });
  if (!ws) return;
  conn.ws = ws;
  trace("连接建立 " + conn.remote);
}

function onMessage(conn, raw) {
  const plain = cryptFrame(new Uint8Array(raw), false);
  const frame = parseFrame(Buffer.from(plain));
  if (!frame) {
    trace(conn.remote + " 丢弃过短帧(" + raw.length + " 字节)");
    return;
  }
  trace(conn.remote + " <- op=" + frame.op + " seq=" + frame.seq + " 载荷 " + frame.body.remaining + " 字节");
  try {
    dispatch(conn, frame);
  } catch (err) {
    console.log("[native][sock] 处理 op=" + frame.op + " 出错: " + ((err && err.stack) || err));
    respond(conn, frame.op, frame.seq, 1);
  }
}

// 出站帧必须加密(客户端 onmessage 里会 crypt(false) 解一次)。漏了这一步的表现是
// 客户端收到一堆乱码 -> 匹配不上 op/seq -> 所有请求全部超时。
function respond(conn, op, seq, code, payload) {
  conn.ws.send(cryptFrame(buildResponseFrame(op, seq, code, payload), true));
}

function push(conn, op, payload) {
  feedSeq = (feedSeq + 1) & 0xffffffff;
  conn.ws.send(cryptFrame(buildPushFrame(op, feedSeq, payload), true));
}

function forEachOther(room, member, fn) {
  for (const m of room.members.values()) if (m !== member) fn(m);
}

function leaveRoom(conn, reason) {
  const member = conn.member;
  const room = conn.room;
  conn.member = null;
  conn.room = null;
  if (!member || !room) return;
  room.members.delete(member.userId);
  trace("离开房间 #" + room.id + ", 剩 " + room.members.size + " 人 (" + reason + ")");
  if (room.members.size === 0) {
    rooms.delete(room.id);
    return;
  }
  if (room.hostId === member.userId) {
    // 房主走了: 客户端收到 129 会直接退房(iT 里把 v_Js_28018 映射到 this.Gx())。
    const w = new Writer();
    w.u32(room.id);
    const payload = w.bytes();
    for (const m of room.members.values()) {
      m.conn.member = null;
      m.conn.room = null;
      push(m.conn, PUSH_ROOM_CLOSED, payload);
    }
    rooms.delete(room.id);
    console.log("[native] 房间 #" + room.id + " 房主离开, 已解散");
    return;
  }
  const w = new Writer();
  w.u32(member.userId).u16(0);
  const payload = w.bytes();
  for (const m of room.members.values()) push(m.conn, PUSH_LEFT, payload);
}

function dispatch(conn, frame) {
  const { op, seq, body } = frame;

  if (op === OP_PING) {
    respond(conn, op, seq, 0);
    return;
  }

  if (op === OP_ENTER) {
    handleEnter(conn, seq, body);
    return;
  }

  if (!conn.member || !conn.room) {
    // 没进房间就来的请求: 回非 0, 让客户端早点收手而不是干等。
    trace("未进房就收到 op=" + op);
    respond(conn, op, seq, 1);
    return;
  }

  const room = conn.room;
  const member = conn.member;
  const currentYx = () => (room.selection ? room.selection.yx : room.yx);

  switch (op) {
    case OP_LEAVE:
      respond(conn, op, seq, 0);
      leaveRoom(conn, "客户端主动退房");
      return;

    case OP_PICK: {
      body.u16(); // 客户端固定写 0
      const diff = body.u16();
      const musicId = body.str();
      const meta = Buffer.from(body.rest());
      room.yx = (room.yx % 0x7fffffff) + 1;
      room.selection = { yx: room.yx, musicId, diff, meta, nx: conn.userId };
      room.scores.clear();
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(room.selection.yx).u32(conn.userId).raw(meta);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_PICK, payload);
      console.log("[native] 房间 #" + room.id + " 选曲 " + musicId + " (难度 " + diff + ") by " + conn.name);
      return;
    }

    case OP_UNPICK: {
      const yx = currentYx();
      respond(conn, op, seq, 0);
      room.selection = null;
      const w = new Writer();
      w.u32(yx).u16(0);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_UNPICK, payload);
      return;
    }

    case OP_START: {
      const yx = body.u32();
      const te = body.u16();
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(yx || currentYx()).u32(conn.userId).u8(0).u8(te & 255);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_PLAY, payload);
      return;
    }

    case OP_FINISH: {
      const yx = currentYx();
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(yx).u32(conn.userId).u16(0);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_DONE, payload);
      return;
    }

    case OP_STATE: {
      // xx(flag, n) / Lx(n): n 是客户端自己的对局状态(1..5), 客户端用
      // v_Hs_28017.iP/Tx 等它 >= 某个值, 所以必须广播回去。
      const n1 = body.u16();
      const yx2 = body.u16();
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(yx2 || currentYx()).u16(n1);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_STATE, payload);
      return;
    }

    case OP_SCORE: {
      // zC(a, isLast, score, flags, count) + count x (f32 数值, u8 标志)
      // a == 0xFFFFFFFF 是 rC 发出的「一局结束」包, 它同样带着完整分数, 一起记。
      const a = body.u32();
      body.u32();
      const score = body.u32();
      const flags = body.u32();
      const count = body.u32();
      for (let i = 0; i < count && body.remaining >= 5; i++) {
        body.f32();
        body.u8();
      }
      void a;
      const cell = room.scores.get(conn.userId) || { score: 0, flags: 0 };
      cell.score = Math.max(cell.score, score);
      cell.flags = flags;
      room.scores.set(conn.userId, cell);
      member.score = cell.score;
      member.flags = cell.flags;
      respond(conn, op, seq, 0);
      broadcastRank(room);
      return;
    }

    case OP_QUERY: {
      // 客户端把这个 u16 当房间号用, 65535 特判成「房间已关闭」(见 _x / settingsStore)。
      // n 是客户端带上来的原值, 这里只是照抄回去。
      const n = body.u16();
      void n;
      respond(conn, op, seq, room.id & 0xffff);
      return;
    }

    case OP_READY: {
      const n = body.u16();
      member.ready = n;
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u16(n);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_ALLREADY, payload);
      return;
    }

    case OP_PROFILE: {
      member.titleText = body.str();
      member.nameplateRarity = body.u16();
      member.fieldWallText = body.str();
      respond(conn, op, seq, 0);
      const w = new Writer();
      member.writeProfile(w);
      const payload = w.bytes();
      forEachOther(room, member, (m) => push(m.conn, PUSH_PROFILE, payload));
      return;
    }

    case OP_CHAT:
    case OP_CHAT_FREE: {
      const yx = body.u32();
      const chatId = body.u32();
      const text = body.str();
      respond(conn, op, seq, 0);
      broadcastChat(room, member, yx, chatId, text);
      return;
    }

    case OP_AVATAR:
      // 客户端来要头像/角色图(v_Ia_28059._C)。我们不发图, 但必须明确回一个非 0 码,
      // 否则客户端那条 promise 会一直挂着, 并且每 5 秒重试一次。
      respond(conn, op, seq, 1);
      return;

    default:
      trace("未实现的操作码 op=" + op + "(回非 0, 避免客户端挂起)");
      respond(conn, op, seq, 1);
  }
}

function broadcastRank(room) {
  const rows = [];
  for (const m of room.members.values()) {
    const cell = room.scores.get(m.userId);
    rows.push({ nx: m.userId, Sr: cell ? cell.score : 0, ru: cell ? cell.flags : 0 });
  }
  rows.sort((x, y) => y.Sr - x.Sr);
  const w = new Writer();
  w.u32(0); // 客户端 iT 会先 v3() 跳过一个 u32
  w.u32(room.selection ? room.selection.yx : room.yx);
  w.u32(rows.length);
  for (const r of rows) w.u32(r.nx).u32(r.Sr).u32(r.ru);
  const payload = w.bytes();
  for (const m of room.members.values()) push(m.conn, PUSH_RANK, payload);
}

function broadcastChat(room, from, yx, chatId, text) {
  const play = new Writer();
  play.u32(from.userId).u32(yx).u32(chatId).str(text);
  const playPayload = play.bytes();

  feedSeq = (feedSeq + 1) & 0xffffffff;
  const lobby = new Writer();
  lobby.u32(feedSeq); // tL: 客户端用它排序, 必须是递增的
  lobby.u32(from.userId);
  lobby.u32(yx);
  lobby.u32(chatId);
  lobby.f64(0); // iL: 信息行里的数值(这里不用)
  lobby.str(text);
  const lobbyPayload = lobby.bytes();

  for (const m of room.members.values()) {
    if (m === from) continue;
    push(m.conn, PUSH_CHAT_PLAY, playPayload);
    push(m.conn, PUSH_CHAT_LOBBY, lobbyPayload);
  }
  console.log("[native] 房间 #" + room.id + " " + from.name + ": " + text);
}

function handleEnter(conn, seq, body) {
  const version = body.u16();
  const wantRoom = body.u32();
  const nwToken = body.str();
  const token = body.str();
  const displayName = body.str();
  const rating = body.u16();
  body.u16(); // 客户端把 rating 写了两遍
  const titleRarity = body.u16();
  const titleText = body.str();
  const nameplateText = body.str();
  const nameplateRarity = body.u16();
  const fieldWallText = body.str();

  const s = resolveSession(token);
  if (!s && !displayName) {
    trace("enter: token 无效且没带名字, 拒绝");
    respond(conn, OP_ENTER, seq, 16);
    return;
  }
  const profile = s ? getProfileFor(s.user_id, s) : null;

  conn.session = s || null;
  conn.guest = !s;
  conn.userId = s ? s.user_id : nextGuestId++;
  conn.name = displayName || (profile && profile.playerName) || (s && s.display_name) || "PLAYER";
  conn.rating = Number((s && profile && profile.playerRating) || rating) || 0;
  conn.level = Number((s && profile && profile.playerLevel) || 1) || 1;
  conn.titleRarity = titleRarity;
  conn.titleText = titleText;
  conn.nameplateText = nameplateText;
  conn.nameplateRarity = nameplateRarity;
  conn.fieldWallText = fieldWallText;

  // 先校验目标房间, 通过了再离开当前房间 —— 加入失败不该把人从原来的房里踢出去。
  const picked = pickRoom(conn, wantRoom);
  if (picked.error) {
    trace("enter: 房间 #" + wantRoom + " 进不去(" + picked.error + ")");
    respond(conn, OP_ENTER, seq, 1);
    return;
  }
  if (conn.member) leaveRoom(conn, "换房间");
  let room = picked.room;
  if (!room) {
    const id = randomRoomId();
    room = { id, hostId: conn.userId, members: new Map(), yx: 0, selection: null, scores: new Map(), createdAt: Date.now() };
    rooms.set(id, room);
    console.log("[native] 新建房间 #" + id + " by " + conn.name);
  }

  const joining = room.members.size > 0;
  const member = new Member(conn);
  conn.member = member;
  conn.room = room;

  const out = new Writer();
  out.u32(conn.userId).u32(room.id);
  respond(conn, OP_ENTER, seq, 0, out.bytes());
  trace(
    "enter: " + (s ? "user#" + s.user_id : "guest#" + conn.userId) +
      " -> 房间 #" + room.id + " (" + (joining ? "加入" : "新建") +
      ", 现有 " + room.members.size + " 人, 协议版本字段 " + version + ", nw=" + nwToken.slice(0, 8) + ")"
  );

  for (const m of room.members.values()) push(conn, PUSH_JOIN, m.joinPayload());
  room.members.set(conn.userId, member);
  const selfPayload = member.joinPayload();
  // 自己也要收到一份: 客户端把它填进 ix(大厅里那份玩家列表), 自己是在列表里的
  // (渲染时按 nx === 自己 过滤)。少了这条, 进房后大厅是空的。
  push(conn, PUSH_JOIN, selfPayload);
  forEachOther(room, member, (m) => push(m.conn, PUSH_JOIN, selfPayload));

  const rid = new Writer();
  rid.u16(room.id & 0xffff);
  push(conn, PUSH_ROOM_ID, rid.bytes());

  // 已经选好的曲子补一份, 不然中途进房的人看不到当前曲目。
  if (room.selection) {
    const w = new Writer();
    w.u32(room.selection.yx).u32(room.selection.nx).raw(room.selection.meta);
    push(conn, PUSH_PICK, w.bytes());
  }
}
