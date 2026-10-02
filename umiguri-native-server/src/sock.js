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
import { cryptFrame, buildPushFrame, buildResponseFrame, parseFrame, Reader, Writer } from "./lib/wire.js";
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
// 115: 玩家角度/角色数据的分块上传(客户端 v_Ia_28059.zT 里每个待同步资源一组),
//     载荷 [u32 YC 局号][u32 hT 曲目序号][u32 分块标志] + 数据块, 服务端原样转发。
//     ⚠ 它不是「开局」: 推进对局状态(137)的是 op=6(开局)与 op=19(状态上报)。
export const OP_START_115 = 115;

// 服务端 -> 客户端推送
export const PUSH_ROOM_CLOSED = 129; // {ZT}             房主解散 -> 客户端直接退房
export const PUSH_JOIN = 130;        // {Hx}             有人进房(含自己)
export const PUSH_LEFT = 131;        // {nx, ZT}         有人离开
export const PUSH_PICK = 132;        // {yx, nx, ng}     选曲(ng 原样回放)
export const PUSH_UNPICK = 133;      // {yx, ZT}         取消选曲
export const PUSH_PLAY = 134;        // {yx, nx, ru, te} 开局
export const PUSH_DONE = 135;        // {yx, nx, ZT}     结束
export const PUSH_SCORE = 136;       // {cT, lT}         对局中实时单人分数(看对手分数)
export const PUSH_STATE = 137;       // {n1}             对局状态(1..5)
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
let rankSeq = 0; // 136 的批次号(u16 循环)

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
      // 载荷 = 客户端 $T() 的整段输出, 从 w0(曲目 id)开始:
      //   str w0, str lf, str C5, str y5, f64 m5, f64 S5, i32 A5, u8 难度个数,
      //   然后每个难度一项 { u8 0, u8 序号, str b5, str k5, str T5 }。
      //
      // ⚠ 必须**整段**原样回放给房间里的所有人(含选曲者自己), 不能只回放 w0 之后的部分:
      //   客户端的 qT() 是从 w0 开始读的, 少一个字符串会让后面每个字段整体前移 2 字节,
      //   读出来的「难度个数」变成元数据里的字节(那个字节是难度序号, 通常 3/4),
      //   于是循环越读越远 -> 抛 RangeError: Out of bounds access。
      //   (以前就是「读掉 w0 再回放剩余」的写法, 表现是「进房后一选曲就报错」。)
      const chart = Buffer.from(body.rest());
      const musicId = new Reader(chart).str(); // 只用来打日志
      room.yx = (room.yx % 0x7fffffff) + 1;
      room.selection = { yx: room.yx, musicId, diff, meta: chart, nx: conn.userId };
      room.scores.clear();
      room.state = 0;
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(room.selection.yx).u32(conn.userId).raw(chart);
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

    // 115: 不是「开局」, 而是玩家角度/角色数据的分块上传通道。
    // 客户端 v_Ia_28059.zT 对每个等待同步的资源都发一组 115, 每块载荷是:
    //   [u32 YC 局号][u32 hT 曲目序号][u32 分块标志(1=空数据/2|1=最后一块)] + 数据
    // 官方服务端原样转给同房间其他人(对端在大厅里要看到别人的角度/动作),
    // 自己回一个成功码。
    //
    // ⚠ 这里**必须**用「原样回放」而不是先解析再转发: 115 的载荷对老客户端也
    //   是自由格式, 服务端解释它的内部结构只会在字段变化时把整条链路弄断。
    //
    // 另外先前这里把 room.state 推到 5 —— 那是猜的, 并且会让房主在**还没开局**
    // 时状态就跳到「对局中」。真正推进状态的是 op=6(134 开局)与 op=19(上报),
    // 那两条才调 pushState。
    case OP_START_115: {
      const payload = Buffer.from(body.rest());
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.raw(payload);
      const out = w.bytes();
      forEachOther(room, member, (m) => push(m.conn, OP_START_115, out));
      trace("房间 #" + room.id + " " + conn.name + " 上传角度数据 " + payload.length + " 字节, 已转发");
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
      //
      // 推送码是 137(v_Ys_28026), 载荷只有一个 u16 —— 客户端 iT 的分支读的是
      // v_e_33881.n1, 多写一个 u32 会让后面每帧都错位。以前这里引用了从未定义的
      // PUSH_STATE, 一收到 19 就抛 ReferenceError(整个连接被打断) —— 对局中每次
      // 状态推进都会踩到, 是「多人玩不了」的直接原因。
      const n1 = body.u16();
      body.u16(); // 客户端把曲目序号写了两遍, 这里不用(局号以 room.selection 为准)
      member.state = n1;
      respond(conn, op, seq, 0);
      pushState(room, member, n1);
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
      // 136 是「对局中看对手分数」那条链路: 只带每个人的分数, 不带排名差值。
      // 138(排行榜)带的是名次/差值, 客户端在结算/大堂用; 136 在对局过程中刷新。
      // 两个都发, 客户端两条分支各取所需(幂等, 重复刷新不会出错)。
      pushScore(room);
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

    case OP_AVATAR: {
      // 头像/角色图不是服务端发的, 是玩家间 WebRTC P2P(v_Ia_28059.WI 建 RTCPeerConnection)。
      // 客户端把 SDP/ICE/请求都塞进 op=114 发给服务端, 服务端只负责转给同房间的其他人,
      // 对端在 OI() 里按 YC(帧类型) 分发。所以这里**必须原样转发**, 不能回非 0 ——
      // 以前直接回 1, 对局里就永远看不到对手的头像/角色图(P2P 握手从来没接上)。
      //
      // 载荷 = 客户端自己拼的一整段(u32 YC + 后续字段), 服务端不解释它的内部结构,
      // 原封不动转发即可(与官方一致)。
      // 整段原样转发(含开头 u32 YC): 接收端的 OI() 就是从这段里自己取 YC 的。
      const payload = Buffer.from(body.rest());
      respond(conn, op, seq, 0);
      relayAvatar(room, member, payload);
      return;
    }

    default:
      trace("未实现的操作码 op=" + op + "(回非 0, 避免客户端挂起)");
      respond(conn, op, seq, 1);
  }
}

// 136: 对局中实时单人分数。客户端 iT 的读法(v_Ks_28025 分支)是:
//   v3()  跳过 1 个 u32(服务端版本号)
//   v3()  cT  批次号(u32 —— 以前这里写的是 u16, 会让后面每个字段都错位)
//   v3()  yx  对局号
//   v3()  行数, 然后每行 {nx: u32, Sr: u32}
// cT 只给客户端原样存着(this.oC), 不参与逻辑, 但必须递增, 方便排障。
function pushScore(room) {
  rankSeq = (rankSeq + 1) & 0xffff;
  const rows = [...room.members.values()];
  const w = new Writer();
  w.u32(0); // 占位: 客户端先 v3() 跳过它
  w.u32(rankSeq); // cT: 批次号(客户端按 u32 读)
  // ⚠ 136 没有「局号」这一项 —— 客户端的 136 分支(v_Ks_28025)读法严格是:
  //   跳过 1 个 u32, cT(u32), 行数(u32), 然后每行 { nx: u32, Sr: u32 }。
  //   多写一个 u32 会让「行数」被读成局号: 局号是跨局累加的, 一旦大于人数,
  //   客户端就会按那个数字去读行 -> 直接抛 Out of bounds access。
  w.u32(rows.length);
  for (const m of rows) {
    const cell = room.scores.get(m.userId);
    w.u32(m.userId).u32(cell ? cell.score : 0);
  }
  const payload = w.bytes();
  for (const m of rows) push(m.conn, PUSH_SCORE, payload);
}

// 137: 对局状态(1..5) —— {yx: u32, n1: u16}。用房间全局状态而不是「谁发的」:
// 客户端只关心「现在的进度到没到某个值」, 谁先到不重要, 取最大值最稳。
function pushState(room, from, n1) {
  const next = Math.max(room.state || 0, n1 | 0);
  if (next === room.state) {
    // 状态没推进就不重复广播: 客户端是「等它 >= N」, 重复帧除了刷屏没别的作用,
    // 而且会把真正推进的那一帧挤到后面(测试/排障时更难看清顺序)。
    trace("房间 #" + room.id + " 状态 " + next + " 无变化, 不重发");
    return;
  }
  room.state = next;
  const w = new Writer();
  // 客户端 iT 的 137 分支先 v3() 读一个 u32 局号, 再读 u16 状态 ——
  // 少写这个 u32 会让状态错位成高半字, 表现为「联机状态永远对不上」。
  w.u32(room.selection ? room.selection.yx : room.yx);
  w.u16(room.state);
  const payload = w.bytes();
  for (const m of room.members.values()) push(m.conn, PUSH_STATE, payload);
  trace("房间 #" + room.id + " 状态 -> " + room.state + " (来自 " + from.name + ")");
}

// op=114 信令中继: 客户端发上来的 P2P 载荷(structured-clone 风格的自描述数据)
// 原样转给同房间其他人。
//
// 为什么要转成 226/227 再发: 客户端接收端在 v_Hs_28017.iT 里是按 *推送* 处理的 ——
// 只有 op >= 128 才会进 iT。114 是请求码(<128), 原样回 114 会被当成 response,
// 对面根本没人等这个响应。官方服务端就是把 114 拆成 226(需要回复)/227(不回) 再转发,
// 这里跟官方保持一致: 载荷里 YC 为 1(offer/sdp) 时用 226(接收端会回一个 227),
// 其余用 227。
function relayAvatar(room, from, payload) {
  if (!payload || payload.length < 4) return;
  // YC(载荷第一个 u32)是帧类型: 1 = SDP offer(需要对面回 227), 其它(2=ICE, 4/10/11=
  // 请求/应答)都走 227。官方也是这么分的 —— 只有需要「对面必须处理」的 offer 用 226。
  const yc = payload.readUInt32LE(0);
  const op = yc === 1 ? 226 : 227;
  trace("114 中继: YC=" + yc + " -> op " + op + " (" + payload.length + " 字节)");
  const w = new Writer();
  w.raw(payload);
  const bytes = w.bytes();
  forEachOther(room, from, (m) => push(m.conn, op, bytes));
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
    room = { id, hostId: conn.userId, members: new Map(), yx: 0, selection: null, scores: new Map(), state: 0, createdAt: Date.now() };
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

  // 中途进房的人补发当前对局状态(1..5), 否则他在「等状态 >= N」那一步会一直等下去。
  // 载荷必须和 pushState 一样是 { yx: u32, n1: u16 } —— 客户端的 137 分支先读 u32 局号,
  // 只写 u16 的话第一个 v3() 就直接越界(报「二进制读取越界」)。
  if (room.state) {
    const sw = new Writer();
    sw.u32(room.selection ? room.selection.yx : room.yx).u16(room.state);
    push(conn, PUSH_STATE, sw.bytes());
  }

  // 已经选好的曲子补一份, 不然中途进房的人看不到当前曲目。
  if (room.selection) {
    const w = new Writer();
    w.u32(room.selection.yx).u32(room.selection.nx).raw(room.selection.meta);
    push(conn, PUSH_PICK, w.bytes());
  }
}
