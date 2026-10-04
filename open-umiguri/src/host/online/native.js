// 游戏原生协议服务端的接入点(umiguri-native-server)。
//
// 游戏 bundle 里联机写死的是官方服务器 d.umgr-serv.inonote.jp:8101, 协议是:
//   /1/*   JSON(刷卡登录 / 云存档 / 资料 / 设置 / 成绩)
//   /sock  加密二进制 WebSocket(房间 / 选曲 / 实时对手分数)
// 自建服务端实现的就是这一套; 而 tools/game-patches.mjs 的「原生联机」补丁只在
// window.__umgServer 存在时才把游戏这两个客户端指过去 —— 不注入时游戏行为与
// 以前完全一致(纯单机 + 宿主联机面板)。
//
// 三件事必须一起给, 缺一不可:
//   host / port —— 服务端地址(默认端口 8101, 游戏里写死的那个)
//   cardBytes   —— 卡号转成读卡器吐的 10 字节: 桌面没有 AM 读卡器, 用绑定的卡号
//                  当作一次刷卡(游戏自带键盘假卡是 Ctrl+F9~F12)
//
// 刷卡有两条路, 都走游戏自己的读卡器(R9):
//   1. 进游戏前下发 cardBytes —— 游戏第一次读卡就拿到, 「开箱即用」;
//   2. 游戏停在「请刷卡」时由宿主喂进去 —— swipeNow(), 见下。
// 为什么不一直自动重刷: 卡是一次性的(读完即清), 否则服务端连不上会「登录失败 ->
// 回标题 -> 又自动刷卡」死循环, 玩家连游客模式都进不去。
//   nwToken     —— 装置号(握手 fe), 服务端用它识别「同一台机器」
import { LS_BASE, LS_CARD, LS_TOKEN, normalizeCard, readLS, writeLS } from './session.js';

export const LS_NATIVE_PORT = 'umg_native_port';
export const DEFAULT_NATIVE_PORT = 8101;

// 原生服务端端口。没配置过 -> 默认 8101; 显式留空 -> 0(不接原生联机)。
export function nativePort() {
  const raw = readLS(LS_NATIVE_PORT);
  if (raw === null) return DEFAULT_NATIVE_PORT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 0;
}

export function setNativePort(port) {
  const text = String(port === undefined || port === null ? '' : port).trim();
  writeLS(LS_NATIVE_PORT, text);
  return nativePort();
}

// AIME 卡号(20 位十六进制) -> 游戏读卡器吐出的 10 字节
export function cardToBytes(cardId) {
  const s = normalizeCard(cardId).replace(/[^0-9A-F]/g, '');
  if (s.length !== 20) return null;
  const bytes = new Uint8Array(10);
  for (let i = 0; i < 10; i++) bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// 从服务端地址里取主机名: http://192.168.1.23:8787 -> 192.168.1.23
export function hostFromBase(base) {
  const s = String(base || '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : 'http://' + s).hostname || '';
  } catch (e) {
    return '';
  }
}

// 「游戏原生联机」到底接上了没有 + 没接上的原因。
//
// 为什么要把原因算出来: 少任何一项, 游戏那边就是**纯单机** —— 打歌不上传成绩、进游戏
// 会走游客登录(玩家看到的是「游客登录」确认框 + 本地存档里的名字, 名字对得上, 所以
// 容易误以为已经登录成功了)。以前日志只有一句「未接原生联机」, 面板也只说「未启用」,
// 看不出缺的是哪一项, 玩家只能靠猜。
export function nativeStatus(sessionCfg) {
  const cfg = sessionCfg || null;
  // 启动器跑过(返回了对象)就以它的结果为准: 点「跳过」时 token 是 null,
  // 这时不能因为 localStorage 里还留着上次的 token 就把玩家拖进联机。
  // 启动器没跑(nolaunch / 异常)才回退到 localStorage。
  const logged = cfg ? !!cfg.token : !!readLS(LS_TOKEN);
  const host = hostFromBase((cfg && cfg.base) || readLS(LS_BASE));
  const port = nativePort();
  const card = normalizeCard((cfg && cfg.cardId) || readLS(LS_CARD));
  const cardBytes = cardToBytes(card);
  const reasons = [];
  if (!logged) reasons.push('没有服务端登录态(启动器里点了「跳过」?)');
  if (!host) reasons.push('没填服务端地址');
  if (!port) reasons.push('原生服务端端口留空(默认应是 8101)');
  if (!cardBytes) reasons.push('没绑定卡号(要 20 位、E004 开头的 AIME 卡号)');
  const live = window.__umgServer || null;
  return { on: !!live, host, port, card, cardBytes, reasons, live };
}

// 装配并下发 window.__umgServer。返回 null 表示「这次不接原生联机」(保持单机)。
export function installNativeServer(sessionCfg, nwToken) {
  try {
    const st = nativeStatus(sessionCfg);
    if (st.reasons.length) {
      delete window.__umgServer;
      // 原因进诊断日志: 「游戏里变游客登录 / 成绩不上传」八成都是这里。
      console.warn('[umg][native] 未接原生联机(游戏会是单机 + 游客登录): ' + st.reasons.join('; '));
      return null;
    }
    const info = {
      host: st.host,
      port: st.port,
      card: st.card,
      cardBytes: st.cardBytes,
      nwToken: String(nwToken || ''),
    };
    window.__umgServer = info;
    // 游戏侧读卡器(R9)探卡时问这个: 只有玩家点过「刷卡」才放行一次。
    // 不装的话游戏会一直探到那张常驻的绑定卡, 于是自动进刷卡画面。
    installArmHook();
    // 诊断: 刷卡全 0 时, 先看这里打出来的卡号对不对 —— 卡号对了说明问题在游戏侧
    // 的 Py/R9(已加归一化), 卡号本来就空/不对就是绑定/登录那一步的事。
    try {
      console.log("[umg][native] 下发联机: card=" + st.card + " bytes=" +
        (st.cardBytes ? Array.prototype.map.call(st.cardBytes, (b) => ("0" + b.toString(16)).slice(-2)).join(" ") : "null") +
        " -> " + st.host + ":" + st.port);
    } catch (e) {}
    return info;
  } catch (e) {
    return null;
  }
}

// 游戏此刻是否停在「请刷卡」界面。
// 补丁(v_Ls_28008.prototype.R9)在等刷卡时把 resolver 挂到 globalThis.__umgSwipe,
// 刷卡成功或被取消后立刻摘掉 —— 所以它就是个可靠的「在读卡」标志, 宿主的悬浮
// 「刷卡」按钮只在它为真时露出来。
// 放行**一次**游戏侧的探卡。游戏 R9() 每次探卡都会调它, 返回 true 就消耗掉这次放行。
// 做成「一次性令牌」而不是布尔: 主菜单会反复探卡, 布尔置真会导致连续自动刷卡。
// 设计: 点一次「刷卡」后开一个**时间窗**(默认 8s), 窗内所有探卡都供卡。
//   为什么不是「消费一次」: 主菜单(v_N1_27904.v_c_28776)总会先探一次卡, 再把结果
//   传给登录流程(v_G1_27905.v_k_28809); 登录流程内部还会再探一次。
//   「消费一次」的语义下, 第一次探卡就吃掉令牌, 第二次探卡拿到的是「没卡」,
//   于是 v_p_28808 走到「宿主也没有可用卡」直接 return —— 界面停在中间态,
//   真机表现就是「点了刷卡, 卡死在主菜单」。
//   时间窗既能覆盖同一轮的所有探卡, 又不会长期供卡(窗一过自动失效, 不会循环)。
const SWIPE_ARM_MS = 8000;
let swipeArmedUntil = 0;
export function armCardSwipe() {
  swipeArmedUntil = Date.now() + SWIPE_ARM_MS;
}

// 游戏侧读卡器 R9() 会调这个全局(见 tools/game-patches.mjs 注入与 game-esm/index.js)。
function installArmHook() {
  window.__umgArmCardSwipe = function () {
    return Date.now() < swipeArmedUntil;
  };
}

export function waitingCard() {
  return typeof window.__umgSwipe === 'function';
}

// 手动刷卡: 把绑定的卡号交给游戏自己的读卡器, 与街机刷卡是同一条路径。
//   游戏正等着  -> 直接喂进去(之后的登录/云存档/联机都由游戏走原生协议)
//   游戏还没等  -> 放进 __umgServer.cardBytes, 下一次读卡就能拿到
// 返回 false = 没接原生联机 / 没有可用的卡号。
export function swipeNow() {
  const srv = window.__umgServer;
  if (!srv || !srv.host) return false;
  const bytes = cardToBytes(normalizeCard(srv.card || readLS(LS_CARD)));
  if (!bytes) return false;
  // 桌面语义是「手动刷卡」: 游戏侧的 R9() 探卡只在 armed 时供卡一次
  // (见 game-esm/index.js 的 R9)。点一次「刷卡」只放行一次, 这样刷完卡 / 游戏结束
  // 回到主界面以后不会被自动拉回刷卡画面(循环进入)。
  armCardSwipe();
  // cardToBytes 已经返回 Uint8Array; 这里再兜一层: 万一 srv.card 被别处改成了
  // 非字符串(比如面板直接塞了数组), normalizeCard 出来的长度不对会返回 null ——
  // 上面那行已经挡掉。保留这一层只是为了让「交出去的永远是 Uint8Array」这条
  // 不变量显式可见(游戏侧 Py 也做了同样的归一化, 两边互为保险)。

  const hook = window.__umgSwipe;
  if (typeof hook === 'function') {
    // 读卡桩真的接下了这次刷卡(它自己会把钩子摘掉): 顺手清掉「在等刷卡」探针。
    if (hook(bytes) !== false) {
      window.__umgSwipeResolved = false;
      return true;
    }
  }
  // ⚠ 游戏**没在**等刷卡(登录画面/读卡桩两条路都没接)时, 不要把这张卡吊在
  //   srv.cardBytes 上。cardBytes 是游戏 R9()/登录画面「自己取卡」的来源, 留着它
  //   会在下一次任意探卡时被消费掉: 真机现象就是玩家在大厅/主菜单随手点一下,
  //   人就被那张卡「在线登录」进去(而不是停在原地等他自己点「刷卡」/「游客登录」)。
  //   玩家真的想在登录画面刷卡时, 宿主会走上面的 hook 或 login-screen 分支,
  //   这两条都不依赖一个长期驻留的 cardBytes。
  srv.cardBytes = null;
  return true;
}

// 游戏侧读卡桩当前处于什么状态 —— 判断「刷卡」按钮该不该露、以及诊断用。
//
//   inLoginScreen  __umgLoginScreen: 游戏**正停在登录画面**(v_k_28809 的循环里),
//                  这是唯一会消费「刷卡」/卡片的位置。
//   waiting        __umgSwipe 挂着: 读卡桩正等一次刷卡(桌面没有 AM 读卡器时,
//                  游戏第一次探卡就会走到这里)。
//   pendingCard    还有一次「已下单、没被消费」的刷卡: armed 时间窗内, 或宿主自己
//                  还留着没送出去的 cardBytes。登录画面第一次探卡没被 armed 挡下的话
//                  会直接消费它, 所以它存在就说明「接下来一定能刷上」。
//
// 为什么要暴露它: 7.34 之前, 登录画面的循环因为「没 armed 拿不到卡」直接 return,
// 刷卡按钮只在 __umgSwipe 挂着时才露 —— 而那条路径根本走不到, 于是玩家看到的是
// 「明明绑了卡, 却只有『游客登录』可点」。宿主可以据此在登录画面里就把按钮亮出来。
export function cardScreen() {
  const srv = window.__umgServer || null;
  return {
    inLoginScreen: window.__umgLoginScreen === true,
    waiting: typeof window.__umgSwipe === 'function',
    pendingCard: (typeof window.__umgArmCardSwipe === 'function' && window.__umgArmCardSwipe()) || !!(srv && srv.cardBytes),
  };
}

// 宿主直接登录(不依赖游戏那个只认读卡器的登录窗口)。
//
// 游戏点「GuestLogin」后走 v_k_28809, 那是个只认读卡器的循环; 桌面没读卡器时基本走不通
// (实测日志里 R9 从未被调用), 玩家最后只能游客进去 —— 而游客态会跳过成绩上报。
// 游戏侧后门 globalThis.__umgHostLogin 由 tools/game-patches.mjs 注入, 内部就是
// /1/user/login + 拉档案 + 灌 handshake; 这里负责在 loadMain() 之前调它。
// 返回 { ok, name?, error? }; 失败不抛异常(游戏照旧游客, 不至于连单机都进不去)。
export async function hostLoginNow() {
  const fn = window.__umgHostLogin;
  if (typeof fn !== 'function') return { ok: false, error: '游戏侧没有直登后门(补丁未生效?)' };
  try {
    const r = await fn(window.__umgServer && window.__umgServer.card);
    return r && typeof r === 'object' ? r : { ok: false, error: '后门返回了非对象' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// 等游戏侧后门注册(__umgHostLogin 是游戏 bootstrap 跑起来才挂上的, 见 loadMain 的 eval)。
// 宿主以前是在 loadMain() 之前 await 直登, 那时游戏代码一行都还没执行 -> 必然
// 「没有直登后门」。改成轮询等待, 拿到就登录 —— 此时游戏还停在启动流程前面,
// 远早于 v_Ns_28014.cA() 读档案那一步, 名字仍然来得及生效。
export async function waitHostLoginBackdoor(timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (typeof window.__umgHostLogin === 'function') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((res) => setTimeout(res, stepMs));
  }
}

// 启动时自动直登: 有卡号 + 接了原生服务端才做。
// 调用点已改到 loadMain() 之后(见 main.js): 后门要等游戏 bootstrap 跑完才存在,
// 而游戏真正读档案(v_Ns_28014.cA) 还要更晚, 所以这里等待再登录仍来得及。
export async function autoHostLogin(sessionCfg) {
  const srv = window.__umgServer;
  const card = normalizeCard((sessionCfg && sessionCfg.cardId) || readLS(LS_CARD));
  if (!srv || !srv.host) return { ok: false, skipped: true, error: '未接原生联机' };
  if (!cardToBytes(card)) return { ok: false, skipped: true, error: '没绑定卡号' };
  srv.card = card;
  if (typeof window.__umgHostLogin !== 'function') {
    const ok = await waitHostLoginBackdoor();
    if (!ok) return { ok: false, error: '游戏侧没有直登后门(补丁未生效?)' };
  }
  return hostLoginNow();
}
