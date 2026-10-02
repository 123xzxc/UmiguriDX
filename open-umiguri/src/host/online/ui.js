// 游戏内联机面板: 绑定卡号 + 刷卡 + 原生联机状态。
//
// 面板只做「进联机所需的最小动作」, 其余全部交给游戏自带的能力:
//   绑定 —— 填 AIME 卡号(经 /auth/card 校验后记在本机)。一张卡一个账号, 与街机一致。
//   刷卡 —— 把绑定的卡交给**游戏自己的读卡器**(host/online/native.js 的 swipeNow),
//           之后的登录、云存档、房间全部由游戏走原生协议(umiguri-native-server)。
//   状态 —— 服务端地址 / 原生服务端 / 游戏是否正停在读卡界面。
//
// 为什么房间不放在面板里: 游戏本身就带联机大厅与 6 位房间号输入(原生 /sock 协议),
// 面板再实现一套只会互相打架(两边各记一份房间状态)。对手实时分数同理, 游戏自己会画。
// 战绩也不用面板上报 —— 游戏的原生记录会自动镜像进面板读的 plays 表。
//
// 桌面没有 AM 读卡器, 所以游戏停在「请刷卡」时右下角会浮出一个「刷卡」按钮:
// 点一下就等于刷了一次卡。登录失败/换号后也能靠它重试, 不会永远卡在请刷卡。
//
// 打开方式: Cmd/Ctrl+Shift+O, 或控制台 window.umgOnline.open()。
import {
  FONT, mkOverlay, mkBox, mkTitle, mkBtn, mkRow, mkHint, mkCol, onTap, setBtnDisabled,
} from '../keypanel/uikit.js';
import { openLauncher } from '../keypanel/launcher.js';
import { session, setSession, clearSession, normalizeBase, readLS, maskCard, LS_BASE, LS_CARD } from './session.js';
import { installNativeServer, swipeNow, waitingCard } from './native.js';
import { diagLog } from '../core/diag.js';

const TICK_MS = 1000;

let overlay = null;
let bodyEl = null;
let statusEl = null;
let swipeBtn = null;
let floatBtn = null;
let open = false;
let busy = false;
let wasWaiting = false;

function log(msg) {
  diagLog('[umg][online] ' + msg);
}

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || '';
}

function mkSection(title) {
  const el = document.createElement('div');
  el.textContent = title;
  el.style.cssText = 'margin:1em 0 0.3em;padding-top:0.6em;border-top:1px solid rgba(255,255,255,0.15);' +
    'font-weight:700;font-size:clamp(13px,2.2vmin,18px);color:rgba(255,255,255,0.9);';
  return el;
}

function mkInfo(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = 'font-size:clamp(13px,2.1vmin,18px);line-height:1.6;color:rgba(255,255,255,0.82);';
  return el;
}

// 当前下发给游戏的原生联机配置(window.__umgServer); 没接时是 null。
function nativeServer() {
  const srv = window.__umgServer;
  return srv && srv.host ? srv : null;
}

// 重新把「原生联机」信息下发给游戏(window.__umgServer)。
// 绑定/换卡后必须重下发: 卡是一次性的(cardBytes 读完即清), 而且游戏 bootstrap
// 就会读它建联机客户端 —— 不重下发, 游戏里还拿着旧卡甚至根本没卡,
// 表现就是「已经绑好了, 游戏内却仍然提示刷卡」。
function pushNativeServer(cfg) {
  const hs = (window.umgr_elc && window.umgr_elc._) || null;
  const info = installNativeServer(cfg || {}, (hs && hs.fe) || '');
  if (info) log('原生联机 -> ' + info.host + ':' + info.port + ' 卡 ' + maskCard(info.card));
  else log('原生联机未启用(要绑定卡号 + 服务端地址 + 20 位 E004 卡号)');
  return info;
}

function build() {
  if (overlay) return;
  overlay = mkOverlay('ugv_online', 60000);
  const box = mkBox();
  overlay.appendChild(box);
  box.style.width = 'min(44em,94vw)';
  box.appendChild(mkTitle('联机'));
  bodyEl = mkCol();
  box.appendChild(bodyEl);
  statusEl = mkHint('');
  box.appendChild(statusEl);
  const row = mkRow();
  const closeBtn = mkBtn('关闭 (Cmd/Ctrl+Shift+O)', false);
  onTap(closeBtn, () => close());
  row.appendChild(closeBtn);
  box.appendChild(row);
  // 面板自身吞掉点击与滚轮, 不传给游戏
  overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  overlay.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  document.body.appendChild(overlay);
}

function render() {
  if (!open) return;
  build();
  while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

  // ---- 账号(卡号绑定) ----
  bodyEl.appendChild(mkSection('账号'));
  const u = session.user;
  const card = readLS(LS_CARD) || '';
  if (u) {
    bodyEl.appendChild(mkInfo('显示名: ' + (u.displayName || '') + '   用户名: ' + (u.username || '')));
    bodyEl.appendChild(mkInfo('卡号: ' + (card ? maskCard(card) : '(未记录)')));
  } else {
    bodyEl.appendChild(mkInfo('未绑定卡号。绑定后进游戏刷一次卡, 就能登录、存成绩、联机。'));
  }
  bodyEl.appendChild(mkInfo('服务端: ' + (session.base || readLS(LS_BASE) || '(未设置)')));

  const accRow = mkRow();
  const bindBtn = mkBtn(u ? '换卡绑定' : '绑定卡号', !u);
  const logoutBtn = mkBtn('登出', false);
  setBtnDisabled(logoutBtn, !u);
  onTap(bindBtn, () => doBind());
  onTap(logoutBtn, () => doLogout());
  accRow.appendChild(bindBtn);
  accRow.appendChild(logoutBtn);
  bodyEl.appendChild(accRow);

  // ---- 原生联机 ----
  bodyEl.appendChild(mkSection('原生联机'));
  const srv = nativeServer();
  if (srv) {
    bodyEl.appendChild(mkInfo('服务端: ' + srv.host + ':' + srv.port + '    卡号 ' + maskCard(srv.card || '')));
    bodyEl.appendChild(mkInfo(waitingCard()
      ? '游戏正停在读卡界面 —— 点下面的「刷卡」即可。'
      : '游戏没在等刷卡(已经登录, 或还没走到刷卡界面)。'));
  } else {
    bodyEl.appendChild(mkInfo('未接原生联机: 先在上面「绑定卡号」里填好服务端地址与卡号。'));
    bodyEl.appendChild(mkInfo('原生服务端端口默认 8101(与游戏写死的端口一致), 留空则不接。'));
  }
  bodyEl.appendChild(mkInfo('房间号、准备、对手实时分数都用游戏自带的联机功能, 面板不再重复一套。'));

  const swRow = mkRow();
  swipeBtn = mkBtn('刷卡', true);
  setBtnDisabled(swipeBtn, !srv);
  onTap(swipeBtn, () => doSwipe());
  swRow.appendChild(swipeBtn);
  bodyEl.appendChild(swRow);

  wasWaiting = waitingCard();
}

// ---- 悬浮「刷卡」按钮 ----

// 桌面没有 AM 读卡器, 游戏停在「请刷卡」时这个按钮就是那块读卡器。
// 只在真的读卡时露出来, 平时不挡游戏画面。
function buildFloat() {
  if (floatBtn || !document.body) return;
  floatBtn = document.createElement('div');
  floatBtn.textContent = '刷卡';
  floatBtn.style.cssText =
    'position:fixed;right:3vmin;bottom:14vmin;z-index:59999;display:none;' +
    'align-items:center;justify-content:center;min-width:4.6em;padding:0.7em 1.4em;border-radius:0.6em;' +
    'color:#fff;background:rgba(20,20,20,0.72);border:1px solid rgba(255,255,255,0.6);' +
    'box-shadow:0 0 1em rgba(0,0,0,0.5);' + FONT +
    'font-weight:700;font-size:clamp(15px,2.4vmin,22px);line-height:1.2;cursor:pointer;touch-action:none;' +
    'box-sizing:border-box;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;';
  floatBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    doSwipe();
  });
  document.body.appendChild(floatBtn);
}

function refreshFloat() {
  if (!floatBtn) buildFloat();
  if (!floatBtn) return;
  floatBtn.style.display = (nativeServer() && waitingCard()) ? 'flex' : 'none';
}

// ---- 动作 ----

// 绑定/换卡: 界面与流程都在启动器里(地址 + 卡号), 这里只负责接上原生联机。
async function doBind() {
  if (busy) return;
  busy = true;
  try {
    const prev = session.user;
    const cfg = await openLauncher(normalizeBase(session.base || readLS(LS_BASE)));
    if (cfg && cfg.user) {
      setSession(cfg);
      pushNativeServer(cfg);
      setStatus('已绑定 ' + maskCard(cfg.cardId || readLS(LS_CARD)));
    }
    if (cfg && cfg.user && (!prev || prev.id !== cfg.user.id)) {
      log('换号为 ' + cfg.user.displayName + ' (游戏内名字重启后刷新)');
    }
    render();
  } finally {
    busy = false;
  }
}

function doLogout() {
  clearSession();
  pushNativeServer(null); // 登出后撤掉, 免得游戏继续用旧卡/旧服
  setStatus('已登出(卡号绑定已清除, 游戏回到单机)');
  render();
}

function doSwipe() {
  if (swipeNow()) {
    setStatus('已刷卡, 游戏正在登录…');
    log('手动刷卡');
  } else {
    setStatus('刷卡失败: 先在「绑定卡号」里填好服务端地址与 E004 卡号');
  }
  render();
}

// ---- 轮询(只为了「是否在等刷卡」这一件事) ----
function tick() {
  try {
    refreshFloat();
    const now = waitingCard();
    if (open && now !== wasWaiting) render();
    else if (open && swipeBtn) setBtnDisabled(swipeBtn, !nativeServer());
  } catch (e) {}
}

// ---- 开关 ----
function show() {
  build();
  open = true;
  overlay.style.display = 'flex';
  setStatus('');
  render();
}

function close() {
  open = false;
  if (overlay) overlay.style.display = 'none';
}

function toggle() {
  if (open) close();
  else show();
}

export function installOnlineUI() {
  // Cmd/Ctrl+Shift+O —— 与虚拟键盘面板的 Cmd/Ctrl+Shift+H 同一套路
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'KeyO' || e.key === 'O' || e.key === 'o')) {
      e.preventDefault();
      toggle();
    }
  });
  buildFloat();
  setInterval(tick, TICK_MS);
  window.umgOnline = {
    open: show,
    close: close,
    toggle: toggle,
    refresh: render,
    swipe: doSwipe,
    get state() {
      return {
        bound: !!session.user,
        user: session.user,
        base: session.base,
        card: readLS(LS_CARD) || '',
        native: nativeServer(),
        waitingCard: waitingCard()
      };
    }
  };
}

export { show as openOnlineUI, close as closeOnlineUI };
