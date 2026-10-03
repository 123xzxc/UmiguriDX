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
  // 发包也打一条 trace: 排障时「收包有、发包没有」和「根本没发」是两种完全不同的
  // 故障(前者看客户端解码, 后者看服务端分支)。以前只有入站 trace, 定位要猜。
  trace(conn.remote + " -> op=" + op + " seq=" + feedSeq + " 载荷 " + (payload ? payload.length : 0) + " 字节");
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
    clearStateReplay(room);
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
    clearStateReplay(room);
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
      // 重新选曲 = 回到「准备中」: 立刻广播一次 137(状态 1), 让在大堂/选歌界面
      // 等 `Tx(1)` 的人醒来(上一局的 5 现在已被清成 0, 不广播的话他们会一直等)。
      pushState(room, member, 1);
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
      // op=6「开局」。客户端在房主点开始时会先 xx(true) 上报状态 1(进入对局准备),
      // 然后房主本地 await Tx(1) 通过；**但非房主进对局等的是 Tx(3)**
      // (gameCore 的 v_E_30309 分支: Lx(3) -> Tx(3)), 而 2/3/4/5 这几档只有 Lx
      // 会上报。房主随后在 gameCore 里依次 Lx(2/3), 可是那几处都带 `Gi()`/对局已开始
      // 的守卫, 实测在自建服务端上并不会全部落到线上, 于是房间状态一直停在 1,
      // 非房主永久卡在选歌界面(真机日志: 反复 "137 收到: 房状态 sP=1")。
      //
      // 这里在开局这条**服务端唯一能看到的房主动作**上补一档: 收到 op=6 就把房间
      // 状态推到 2(「已开始, 正在进入曲目」)再广播 137。非房主的进对局分支等的是
      // >= 3, 但 2 会把房间从 1 推出来并触发后续 Lx(3) 的重播链路；同时 pushPlay
      // (134) 也已经发出去, 客户端据此进歌曲界面, 所以推 2 是安全的中间档。
      const yx = body.u32();
      const te = body.u16();
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u32(yx || currentYx()).u32(conn.userId).u8(0).u8(te & 255);
      const payload = w.bytes();
      for (const m of room.members.values()) push(m.conn, PUSH_PLAY, payload);
      // 推一档对局状态, 把非房主从「等 137 >= 2」里放出来(见上方注释)。
      if (room.state < 2) pushState(room, member, 2);
      return;
    }

    // 115: 资源提供方回给请求方的「资源数据块」通道。客户端 v_Ia_28059.zT 对每个
    // 等待同步的资源发一组 115, 每块载荷是:
    //   [u32 YC 自己的玩家槽位][u32 hT 资源 id][u32 分块标志(bit1=2 数据/bit2=4 头/bit0=1 末块)] + 数据
    //
    // ⚠ 转发时必须改写成 **227**, 不能原样回 115:
    //   - 115 是请求码(<128), 原样转会被接收端当成「自己的请求的响应」, 进不了推送分发;
    //   - 请求方真正在等的是 v_Ia_28059.XI() 里的 227, 布局就是上面这三项。
    //   以前这里原样转 115, 于是「请求发出去了、数据也回上来了, 但对端永远收不到」,
    //   对局里看不到对手的角色/头像(P2P 建链直接卡死在第一次要资源)。
    //
    // 同样必须用「原样回放」而不是先解析再重组: 115 的载荷对老客户端也是自由格式,
    // 服务端解释内部结构只会在字段变化时把整条链路弄断(这里只读前 12 字节改 op, 不动载荷)。
    //
    // 另外先前这里把 room.state 推到 5 —— 那是猜的, 并且会让房主在**还没开局**
    // 时状态就跳到「对局中」。真正推进状态的是 op=6(134 开局)与 op=19(上报),
    // 那两条才调 pushState。
    case OP_START_115: {
      const payload = Buffer.from(body.rest());
      respond(conn, op, seq, 0);
      relayAssetData(room, member, payload);
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
      // oP(n) = op=22「准备」。客户端 iP(n) 等的就是这个通道:
      //   服务端回 141(PUSH_ALLREADY) -> iT 的 v_Qs_28030 分支写 this.aP。
      //   ⚠ 与 137(PUSH_STATE -> sP) 是**两个不同的值**, 不能互相替代。
      //
      // 回的必须是「房间当前的整体就绪值」而不是发起者写的那个 n:
      //   房主先进房并 oP(1) 之后, 晚进的人若只收到别人上一次上报的值,
      //   他等的 iP(1) 就永远对不上。取房间最大值既能唤醒等待者, 也符合
      //   「有人准备好了」的原意(全员准备由客户端自己看成员列表判断)。
      //   每次上报都要回一帧(客户端是「挂上 Promise, 再收一帧才醒」)。
      const n = body.u16();
      member.ready = n;
      room.ready = Math.max(room.ready || 0, n | 0);
      respond(conn, op, seq, 0);
      const w = new Writer();
      w.u16(room.ready);
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
      // 载荷 = 客户端自己拼的一整段(u32 YC + u8 子类型 + 请求 id + 参数), 服务端不解释,
      // 但**必须原样转成 226**, 不能转 227 —— 见 relaySignaling() 的说明。
      const payload = Buffer.from(body.rest());
      respond(conn, op, seq, 0);
      relaySignaling(room, member, payload);
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
// 客户端只关心「现在的进度到没到某个值」。
//   ⚠ 不能用「取最大值」: 状态是要能降回去的(结算完回大堂/选歌 = 1), 取最大值会让
//     房间永久停在 5, 房主开的下一局对其他人完全不可见(见函数内注释)。
//
// ⚠ **每一帧都要广播**, 不能因为「状态没变」就提前返回。
//   客户端的等待语义是:
//     v_Hs_28017.iP(n) / Tx(n)  ->  aP/sP < n 时挂一个 Promise, 等 137 来 resolve;
//     settingsStore 与 gameCore 的调用方都是 `await v_oe_27649.iP(n)`。
//   也就是说「等的人已经挂上了, 但状态已经等于 n」时, 只有再收到一帧 137 才会醒。
//   以前这里 `next === room.state` 就 return, 于是:
//     - 房主原地重报同一个状态(结算 → 下一局回到同一步), 谁也收不到, 一直等;
//     - 中途进房的人在「把 waiter 挂上」和「服务端补发当前状态」之间有竞态。
//   表现就是「跳过匹配 / 点开始之后, 非房主玩家停在原界面不进歌曲」。
//   重复帧对客户端是幂等的(它只比较 >= 然后 resolve), 代价可以忽略。
function pushState(room, from, n1) {
  // 状态既可以升(0 → 1 → … → 5)也可以降: 一局打完回到选歌/大堂时, 房主会重报
  // 状态 1(见客户端 uC(false) 的说明)。**必须允许回退**:
  //   以前是 Math.max(room.state, n1), 于是房间状态一旦到过 5 就永远 >= 5,
  //   房主重开一局时广播出来的还是 5 —— 非房主在选歌界面等的 `Tx(1)` 会被立刻
  //   满足(5 >= 1), 而游戏内那几处 `Tx(3/4/5)` 又被陈旧的高状态直接放行,
  //   两边状态机彻底错开, 真机表现就是「房主点跳过/Next, 其他人回不到选歌界面」。
  //   现在按「最后一个上报者的状态」走, 并把每次上报都原样广播一遍
  //   (客户端的等待语义是「挂上 waiter 之后再收一帧 137 才醒」, 见下方注释)。
  const next = n1 | 0;
  const changed = next !== room.state;
  const prev = room.state;
  room.state = next;
  // 回到 0(重开/清场)就别再重播了, 否则会朝空房间一直发。
  if (!(next > 0)) clearStateReplay(room);
  // 结算/回大堂: 状态从「对局中(>=2)」掉回 1 时, 把这局的选曲清掉并广播 133。
  //   非房主结算后要回到选歌界面靠两件事: 137(sP 从 5 降回 1) + 本地选曲状态复位。
  //   若服务端还留着上一局 selection, 下一局/中途进房的人会立刻收到 PICK 补发,
  //   两边状态机错开, 真机表现「玩家2回不到选歌/主菜单」。
  if (prev >= 2 && next === 1 && room.selection) {
    room.selection = null;
    const uw = new Writer();
    uw.u32(room.yx).u16(0);
    const upayload = uw.bytes();
    for (const m of room.members.values()) push(m.conn, PUSH_UNPICK, upayload);
    trace("房间 #" + room.id + " 状态回退到 1, 已清选曲并广播 133");
  }
  const w = new Writer();
  // 客户端 iT 的 137 分支先 v3() 读一个 u32 局号, 再读 u16 状态 ——
  // 少写这个 u32 会让状态错位成高半字, 表现为「联机状态永远对不上」。
  w.u32(room.selection ? room.selection.yx : room.yx);
  w.u16(room.state);
  const payload = w.bytes();
  for (const m of room.members.values()) push(m.conn, PUSH_STATE, payload);
  trace("房间 #" + room.id + " 状态 -> " + room.state + (changed ? "" : "(未变化, 但仍广播)") + " (来自 " + from.name + ")");
  ensureStateReplay(room);
}

// 状态重播 —— 解决「房主已经开局, 但非房主那一帧没赶上」的竞态。
//
// 客户端的等待语义是「挂 waiter -> 再收一帧 137 才醒」(`Tx(n)` 见 index.js)。
// 房主按「开始」只发**一次** op=19, 于是广播也只有一帧 137 —— 如果某个非房主
// 此刻还没挂上 waiter(刚进房、正在切界面、上一帧还在处理), 这一帧就被永久错过,
// 后面不会再有任何 137 把他唤醒。真机表现: 「房主点开始, 别人进不去选歌界面」。
//
// 修法不是让客户端更聪明, 而是让服务端在「非 0 状态」期间每 500ms 重播一次,
// 直到房间回到 0(解散/重开)。重播是幂等的: 客户端 sP >= n 时直接返回, 不重复入座。
function clearStateReplay(room) {
  if (room && room.stateReplayTimer) {
    clearInterval(room.stateReplayTimer);
    room.stateReplayTimer = null;
  }
}

function ensureStateReplay(room) {
  if (room.stateReplayTimer) return;
  if (!(room.state > 0)) return;
  room.stateReplayTimer = setInterval(() => {
    // 房间已经清空/回到 0 就停。
    if (!rooms.has(room.id) || !(room.state > 0) || room.members.size === 0) {
      clearInterval(room.stateReplayTimer);
      room.stateReplayTimer = null;
      return;
    }
    const w = new Writer();
    w.u32(room.selection ? room.selection.yx : room.yx);
    w.u16(room.state);
    const payload = w.bytes();
    for (const m of room.members.values()) push(m.conn, PUSH_STATE, payload);
    trace("房间 #" + room.id + " 状态重播 -> " + room.state + " (" + room.members.size + " 人)");
  }, 500);
  if (room.stateReplayTimer.unref) room.stateReplayTimer.unref();
}

// op=114/115 信令中继 —— 226 与 227 是两条**语义不同**的通道, 不能混用。
//
// 为什么要转成 226/227 再发: 客户端接收端在 v_Hs_28017.iT 里是按 *推送* 处理的 ——
// 只有 op >= 128 才会进 iT。114/115 是请求码(<128), 原样回会被人当成自己的响应,
// 对面根本没人等它。
//
// 客户端的两个接收分支(都在 v_Ia_28059.OI, 见 index.js 4404/4422)读法完全不同:
//
//   226 (桌面路径 v_Hs_28017.OI -> 非 VI 分支):
//       u32 YC (发送者的玩家槽位, 用来挑出是哪一对 P2P)
//       u8  子类型 (1=SDP, 2=ICE, 4=冲刷, 10=要资源, 11=取消)
//       ... 子类型各自的参数
//     —— 与客户端发上来的 114 载荷**逐字节相同**, 所以要原样转发。
//
//   227 (桌面路径 v_Ia_28059.XI):
//       u32 YC
//       u32 资源 id
//       u32 分块标志 (bit1=2 数据块 / bit2=4 头信息 / bit0=1 最后一块)
//       ... 数据
//     —— 这正是客户端 zT() 发上来的 **op=115** 载荷布局。
//
// 所以: 114 一律转 226; 115 一律转 227。以前把 114 按「YC 是不是 1」拆成 226/227,
// 两个错都在里面: (a) YC 是发送者槽位不是帧类型, 槽位 1 的玩家发的所有信令都会被
// 误判; (b) 114 一旦转成 227, 对面 XI 会拿 u8 子类型当 u32 id 读、再读一个 u32 标志,
// 帧里根本没有那 4 个字节 -> 抛「二进制读取越界: N > M」, 头像/角色图永远同步不过去。
function relaySignaling(room, from, payload) {
  if (!payload || payload.length < 5) return;
  const yc = payload.readUInt32LE(0);
  const subtype = payload.readUInt8(4);
  trace("114 中继: YC=" + yc + " 子类型=" + subtype + " -> op 226 (" + payload.length + " 字节)");
  const w = new Writer();
  w.raw(payload);
  const bytes = w.bytes();
  // 226 = 「对面必须处理」的信令通道, 原样转发(不回声给发送者: 对面才要处理)。
  forEachOther(room, from, (m) => push(m.conn, 226, bytes));
}

// op=115 上行(资源提供方回给请求方): 载荷 u32 YC + u32 资源 id + u32 分块标志 + 数据。
// 请求方在 OI/XI 里等的就是按这个布局来的 227, 所以这里必须转成 **227**(而不是 115),
// 并且同样不回声给发送者自己。
function relayAssetData(room, from, payload) {
  if (!payload || payload.length < 12) return;
  const yc = payload.readUInt32LE(0);
  const assetId = payload.readUInt32LE(4);
  const flags = payload.readUInt32LE(8);
  trace("115 中继: YC=" + yc + " id=" + assetId + " 标志=" + flags + " -> op 227 (" + payload.length + " 字节)");
  const w = new Writer();
  w.raw(payload);
  const bytes = w.bytes();
  forEachOther(room, from, (m) => push(m.conn, 227, bytes));
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

  // ⚠ 必须**连同发送者自己**一起推: 客户端不做本地回显(它只把大厅里收到的
  //   144/145 铺进聊天框), 少了这条, 玩家自己发的快捷聊天自己看不到(别人能看到)。
  //   接收端按载荷里的 nx 自己判断「这条是不是我发的」, 不需要服务端过滤。
  for (const m of room.members.values()) {
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

  // 排障: 「输入房间号却进了随机房间」先看这一行 —— wantRoom=0 表示客户端根本没把号码传上来
  // (建房语义), 服务端只能新建; 非 0 才是真的来加入这个号。
  trace("enter: 客户端请求的房间号 wantRoom=" + wantRoom + (wantRoom ? "" : " (0=新建房间)") + " by " + (displayName || "?"));
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
    room = { id, hostId: conn.userId, members: new Map(), yx: 0, selection: null, scores: new Map(), state: 0, stateReplayTimer: null, createdAt: Date.now() };
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

  // 把「房间里现在有谁」记进 trace: 客户端 ix(玩家表)只由 130 填, 而且大厅要 ix.size >= 1
  // 才放行。排查「进不了选歌界面」时, 需要一眼看出自己那份 130 到底发出去没有、
  // 房间成员和客户端看到的是不是同一批(两边 nx 对不上就是另一个方向的 bug)。
  trace(
    "房间 #" + room.id + " 成员 " + room.members.size + " 人: " +
      [...room.members.values()].map((m) => "user#" + m.userId + "(" + m.name + ")").join(", ") +
      " | 已向 user#" + conn.userId + " 补发 " + room.members.size + " 条 130(含自己)"
  );

  const rid = new Writer();
  rid.u16(room.id & 0xffff);
  push(conn, PUSH_ROOM_ID, rid.bytes());

  // 中途进房的人补发当前对局状态(1..5), 否则他在「等状态 >= N」那一步会一直等下去。
  // 载荷必须和 pushState 一样是 { yx: u32, n1: u16 } —— 客户端的 137 分支先读 u32 局号,
  // 只写 u16 的话第一个 v3() 就直接越界(报「二进制读取越界」)。
  //
  // 不管当前状态是几(包括 0)**都要补一帧**: 客户端是「先挂 Promise 再等 137」,
  // 而挂 waiter 和进房补发之间存在竞态 —— 漏发一次就永久卡住(真机表现: 进房后
  // 非房主玩家不进歌曲界面)。0 对客户端是「还没开始」, 幂等无害。
  {
    const sw = new Writer();
    sw.u32(room.selection ? room.selection.yx : room.yx).u16(room.state || 0);
    push(conn, PUSH_STATE, sw.bytes());
  }

  // 同理补一帧 141(准备状态): 客户端的 iP(n) 等的是 aP, 而 aP 只由 141 推进。
  // 晚进房 / 重连的人如果没人再上报 22, aP 会一直是 0, 他等的 iP(1) 永不 resolve
  // (真机表现: 拿着房号进来的人站在大堂不动, 进不了选歌界面)。
  {
    const rw = new Writer();
    rw.u16(room.ready || 0);
    push(conn, PUSH_ALLREADY, rw.bytes());
  }

  // 已经选好的曲子补一份, 不然中途进房的人看不到当前曲目。
  if (room.selection) {
    const w = new Writer();
    w.u32(room.selection.yx).u32(room.selection.nx).raw(room.selection.meta);
    push(conn, PUSH_PICK, w.bytes());
  }
}
