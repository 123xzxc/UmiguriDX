// 游戏内联机面板: 账号 / 房间 / 对手实时分数 / 对局上报。
//
// 为什么在宿主层做:
//   游戏前端保留了 openCoop / coopLobby 的 UI 资源与文案, 但实现代码在反混淆
//   时丢了 —— 联机客户端实例 scope.v_Xt_27648 全库只有 `= null` 一处赋值, 因此
//   游戏自身的联机分支永远走不到(详见 ONLINE.md 第一节)。与其去补一套二进制
//   协议, 不如在宿主这一层把同一套能力补回来。
//
// 面板做什么:
//   账号   —— 显示登录态, 换卡/登出(复用启动器 keypanel/launcher.js)
//   房间   —— 6 位数字房间号, 创建/加入/准备/开始/离开
//   分数   —— 对局中把 {score, progress} 上报 /rooms/:code/progress,
//             同时按 1s 轮询 /rooms/:code/state 拿对手分数
//   记录   —— 对局结束(play -> result)后上报 /plays
//
// 打开方式: Cmd/Ctrl+Shift+O, 或控制台 window.umgOnline.open()。
import {
  mkOverlay, mkBox, mkTitle, mkLabel, mkInput, mkBtn, mkRow, mkHint, mkCol, onTap, setBtnDisabled,
} from '../keypanel/uikit.js';
import { openLauncher } from '../keypanel/launcher.js';
import { session, api, setSession, clearSession, normalizeBase, readLS, maskCard } from './session.js';
import { installNativeServer } from './native.js';
import { diagLog } from '../core/diag.js';

const POLL_MS = 1000;

let overlay = null;
let bodyEl = null;
let statusEl = null;
let open = false;
let room = null;
let version = 0;
let busy = false;
// 对局跟踪: 只在 play -> result 那一刻上报一次
let play = { scene: '', musicId: null, difficulty: null, reported: true, lastTick: 0 };

function log(msg) {
  diagLog('[umg][online] ' + msg);
}

function fmtScore(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US');
}

// ---- 服务端调用 ----

async function call(method, path, body) {
  const r = await api(method, path, body, true);
  if (!r.ok) {
    const msg = r.status === 0 ? '连不上服务端: ' + (r.error || '') : (r.error || '请求失败');
    setStatus(msg);
    return null;
  }
  return r.data;
}

function applyRoom(next) {
  if (!next || next.unchanged) return false;
  room = next;
  version = next.version || 0;
  return true;
}

// ---- 界面 ----

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || '';
}

// 重新把「原生联机」信息下发给游戏(window.__umgServer)。
// 游戏侧刷卡读的就是它, 而且卡是一次性的(cardBytes 读完即清空) —— 登录/换卡后
// 必须重下发, 否则游戏里还拿着旧卡、甚至根本没卡, 表现就是「已经登录了,
// 游戏内却仍然提示刷卡」。
function pushNativeServer(cfg) {
  const hs = (window.umgr_elc && window.umgr_elc._) || null;
  const info = installNativeServer(cfg || {}, (hs && hs.fe) || '');
  if (info) log('原生联机 -> ' + info.host + ':' + info.port + ' 卡 ' + maskCard(info.card));
  else log('原生联机未启用(要已登录 + 服务端地址 + 20 位 E004 卡号)');
  return info;
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

function mkPlayerRow(p, me) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:0.6em;padding:0.35em 0;' +
    'font-size:clamp(13px,2.1vmin,18px);' + (me ? 'color:#9fe0ff;' : 'color:rgba(255,255,255,0.88);');
  const name = document.createElement('div');
  name.textContent = (p.seat + 1) + '. ' + (p.displayName || '???') + (me ? ' (我)' : '');
  name.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const ready = document.createElement('div');
  ready.textContent = p.ready ? '已准备' : '未准备';
  ready.style.cssText = 'flex:0 0 auto;color:' + (p.ready ? '#8ef0a0' : 'rgba(255,255,255,0.5)') + ';';
  const score = document.createElement('div');
  score.textContent = fmtScore(p.score);
  score.style.cssText = 'flex:0 0 6em;text-align:right;font-variant-numeric:tabular-nums;';
  row.appendChild(name);
  row.appendChild(ready);
  row.appendChild(score);
  return row;
}

function build() {
  if (overlay) return;
  overlay = mkOverlay('ugv_online', 60000);
  const box = mkBox();
  overlay.appendChild(box);
  box.style.width = 'min(52em,94vw)';
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

  // ---- 账号 ----
  bodyEl.appendChild(mkSection('账号'));
  const u = session.user;
  if (u) {
    bodyEl.appendChild(mkInfo('显示名: ' + (u.displayName || '') + '   用户名: ' + (u.username || '')));
    bodyEl.appendChild(mkInfo('服务端: ' + (session.base || readLS('umg_online_base') || '(未设置)')));
  } else {
    bodyEl.appendChild(mkInfo('未登录。卡号登录后才会记录成绩、才能加入房间。'));
    bodyEl.appendChild(mkInfo('服务端: ' + (session.base || readLS('umg_online_base') || '(未设置)')));
  }
  const accRow = mkRow();
  const loginBtn = mkBtn(u ? '换卡登录' : '登录', !u);
  const logoutBtn = mkBtn('登出', false);
  setBtnDisabled(logoutBtn, !u);
  onTap(loginBtn, () => doLogin());
  onTap(logoutBtn, () => doLogout());
  accRow.appendChild(loginBtn);
  accRow.appendChild(logoutBtn);
  bodyEl.appendChild(accRow);

  // ---- 房间 ----
  bodyEl.appendChild(mkSection('房间'));
  if (!u) {
    bodyEl.appendChild(mkInfo('先登录再创建或加入房间。'));
    return;
  }
  if (!room) {
    bodyEl.appendChild(mkInfo('未加入房间。房间号为 6 位数字, 由房主创建后告知。'));
    const createRow = mkRow();
    const createBtn = mkBtn('创建房间', true);
    onTap(createBtn, () => doCreate());
    createRow.appendChild(createBtn);
    bodyEl.appendChild(createRow);
    bodyEl.appendChild(mkLabel('房间号'));
    const codeInput = mkInput('6 位数字');
    codeInput.maxLength = 6;
    codeInput.inputMode = 'numeric';
    bodyEl.appendChild(codeInput);
    const joinRow = mkRow();
    const joinBtn = mkBtn('加入', true);
    onTap(joinBtn, () => doJoin(normalizeCode(codeInput.value)));
    joinRow.appendChild(joinBtn);
    bodyEl.appendChild(joinRow);
    return;
  }

  const meId = u.id;
  bodyEl.appendChild(mkInfo('房间号 ' + room.code + '   状态 ' + room.status +
    (room.musicId ? '   曲目 ' + room.musicId + ' / 难度 ' + room.difficulty : '')));
  for (const p of room.players || []) bodyEl.appendChild(mkPlayerRow(p, p.userId === meId));

  const actRow = mkRow();
  const mine = (room.players || []).find((p) => p.userId === meId);
  const isHost = room.hostId === meId;
  const readyBtn = mkBtn(mine && mine.ready ? '取消准备' : '准备', false);
  onTap(readyBtn, () => doReady(!(mine && mine.ready)));
  actRow.appendChild(readyBtn);
  const startBtn = mkBtn('开始', true);
  setBtnDisabled(startBtn, !isHost);
  onTap(startBtn, () => doStart());
  actRow.appendChild(startBtn);
  const leaveBtn = mkBtn('离开房间', false);
  onTap(leaveBtn, () => doLeave());
  actRow.appendChild(leaveBtn);
  bodyEl.appendChild(actRow);
}

function normalizeCode(v) {
  return String(v || '').replace(/\D/g, '').slice(0, 6);
}

// ---- 动作 ----

async function doLogin() {
  if (busy) return;
  busy = true;
  try {
    const prev = session.user;
    const cfg = await openLauncher(normalizeBase(session.base || readLS('umg_online_base')));
    if (cfg && cfg.user) {
      setSession(cfg);
      pushNativeServer(cfg);
    }
    if (cfg && cfg.user && (!prev || prev.id !== cfg.user.id)) {
      room = null;
      version = 0;
      log('换号为 ' + cfg.user.displayName + ' (游戏内名字重启后刷新)');
    }
    render();
  } finally {
    busy = false;
  }
}

async function doLogout() {
  if (room) await doLeave();
  clearSession();
  pushNativeServer(null); // 登出后撤掉, 免得游戏继续用旧卡/旧服
  setStatus('已登出');
  render();
}

async function doCreate() {
  const data = await call('POST', '/rooms', {});
  if (!data) return;
  applyRoom(data.room);
  log('已创建房间 ' + (data.room && data.room.code));
  render();
}

async function doJoin(code) {
  if (code.length !== 6) return setStatus('房间号必须是 6 位数字');
  const data = await call('POST', '/rooms/' + code + '/join', {});
  if (!data) return;
  applyRoom(data.room);
  setStatus('');
  render();
}

async function doReady(ready) {
  const data = await call('POST', '/rooms/' + room.code + '/ready', { ready: !!ready });
  if (data) applyRoom(data.room);
  render();
}

async function doStart() {
  const data = await call('POST', '/rooms/' + room.code + '/start', {});
  if (data) applyRoom(data.room);
  render();
}

async function doLeave() {
  if (room) await call('POST', '/rooms/' + room.code + '/leave', {});
  room = null;
  version = 0;
  setStatus('');
  render();
}

// ---- 对局: 上报进度与成绩 ----

function playState() {
  const api2 = window.__umgPlay;
  if (!api2) return null;
  try {
    return api2.state;
  } catch (e) {
    return null;
  }
}

function onPlayTick() {
  const st = playState();
  if (!st) return;
  const scene = st.practice ? 'practice' : st.scene;

  if (scene === 'play') {
    if (play.scene !== 'play') {
      // 新的一局: 记下曲目信息, 准备结束时上报
      play = { scene: 'play', musicId: st.musicId || null, difficulty: st.difficulty, reported: false, lastTick: 0 };
    }
    if (st.musicId) play.musicId = st.musicId;
    if (st.difficulty !== null && st.difficulty !== undefined) play.difficulty = st.difficulty;
    // 房间内: 1s 上报一次自己的分数(对手读的是同一份快照)
    const now = Date.now();
    if (room && !play.reported && now - play.lastTick >= POLL_MS) {
      play.lastTick = now;
      api('POST', '/rooms/' + room.code + '/progress', {
        score: st.score | 0,
        progress: Math.round(st.progress || 0)
      }, true).catch(() => {});
    }
    return;
  }

  if (play.scene === 'play' && scene !== 'play' && !play.reported) {
    play.reported = true;
    reportPlay(play.musicId, play.difficulty, st.score);
  }
  play.scene = scene;
}

async function reportPlay(musicId, difficulty, score) {
  if (!session.token || !musicId) return;
  const diff = Number(difficulty) || 0;
  const data = await call('POST', '/plays', {
    musicId: String(musicId),
    difficulty: diff,
    score: Number(score) || 0,
    playedAt: Date.now()
  });
  if (data) log('成绩已上报 ' + musicId + ' / ' + diff + ' -> ' + (Number(score) || 0));
}

// ---- 轮询 ----

// setInterval 里的 async 若抛异常会变成 unhandledrejection, 这里一并吞掉。
async function tick() {
  try {
    onPlayTick();
    if (!room || !session.token) return;
    const data = await api('GET', '/rooms/' + room.code + '/state?since=' + version, null, true);
    if (!data || !data.ok || !data.data) return;
    if (applyRoom(data.data.room) && open) render();
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
  setInterval(tick, POLL_MS);
  window.umgOnline = {
    open: show,
    close: close,
    toggle: toggle,
    refresh: render,
    get state() {
      return { logged: !!session.user, user: session.user, base: session.base, room: room };
    }
  };
}

export { show as openOnlineUI, close as closeOnlineUI };

