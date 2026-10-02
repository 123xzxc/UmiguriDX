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

// 装配并下发 window.__umgServer。返回 null 表示「这次不接原生联机」(保持单机)。
export function installNativeServer(sessionCfg, nwToken) {
  try {
    const cfg = sessionCfg || {};
    // 启动器跑过(返回了对象)就以它的结果为准: 点「跳过」时 token 是 null,
    // 这时不能因为 localStorage 里还留着上次的 token 就把玩家拖进联机。
    // 启动器没跑(nolaunch / 异常)才回退到 localStorage。
    const logged = sessionCfg ? !!cfg.token : !!readLS(LS_TOKEN);
    const host = hostFromBase(cfg.base || readLS(LS_BASE));
    const port = nativePort();
    const card = normalizeCard(cfg.cardId || readLS(LS_CARD));
    const cardBytes = cardToBytes(card);
    if (!logged || !host || !port || !cardBytes) {
      delete window.__umgServer;
      return null;
    }
    const info = { host, port, card, cardBytes, nwToken: String(nwToken || '') };
    window.__umgServer = info;
    return info;
  } catch (e) {
    return null;
  }
}

// 游戏此刻是否停在「请刷卡」界面。
// 补丁(v_Ls_28008.prototype.R9)在等刷卡时把 resolver 挂到 globalThis.__umgSwipe,
// 刷卡成功或被取消后立刻摘掉 —— 所以它就是个可靠的「在读卡」标志, 宿主的悬浮
// 「刷卡」按钮只在它为真时露出来。
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
  const hook = window.__umgSwipe;
  if (typeof hook === 'function' && hook(bytes) !== false) return true;
  srv.cardBytes = bytes;
  return true;
}
