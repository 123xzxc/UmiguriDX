// 可拖动悬浮球: 常驻的小圆球, 拖一下就挪位置, 点一下弹出一列宿主按钮。
//
// 为什么要有它: 虚拟键盘面板(keypanel, z-index 99999)固定压在屏幕下方一整条, 里面的按键与
// AIR 条都是 pointer-events:auto —— 宿主以前把「联机」「刷卡」贴在画面角落, 一旦落进那条
// 带子里就被键盘吃掉点击, 玩家看到的现象就是「按钮点不动」。悬浮球自带拖动, 拖出键盘带
// 就能用, 而且位置会记住(localStorage, 按视口比例存, 换分辨率也不跑偏)。
//
// 交互约定:
//   按住拖动(超过 DRAG_SLOP 像素才算) -> 挪位置, 松手贴到最近的左/右边;
//   点一下                              -> 弹出按钮列, 再点一下/点别处收起。
// 按钮的文案与是否可用每次弹出时求值, 所以「游戏是不是正在等刷卡」这类状态不用手动推。
import { FONT, mkBtn, onTap, setBtnDisabled } from './uikit.js';

const LS_POS = 'umg_float_ball_pos'; // { rx, ry }: 0-1 的比例(相对可移动范围)
const DRAG_SLOP = 6;                 // 超过这么多像素才算拖动, 否则当成点击
const MENU_GAP = 10;                 // 球与按钮列的间距(px)
const EDGE = 8;                      // 贴边/离屏留白(px)

let ball = null;
let menu = null;
let menuOpen = false;
let buttons = [];
let statusFn = null;
let drag = null;
let ratio = { rx: 1, ry: 0.22 };
let hidden = false;

function ballSize() {
  const min = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(52, Math.min(96, Math.round(min * 0.1)));
}

// 底部虚拟键盘带的顶部 y(没有键盘就是视口底边)。按钮列不许压进去。
function keyboardTop() {
  const fn = window.umgKeyPanel && window.umgKeyPanel.keyboardBandTop;
  const v = typeof fn === 'function' ? fn() : null;
  return typeof v === 'number' && v > 0 ? v : window.innerHeight;
}

function clampX(x) {
  return Math.max(EDGE, Math.min(window.innerWidth - ballSize() - EDGE, x));
}

function clampY(y) {
  return Math.max(EDGE, Math.min(window.innerHeight - ballSize() - EDGE, y));
}

function saveRatio(x, y) {
  const s = ballSize();
  const aw = Math.max(1, window.innerWidth - s - EDGE * 2);
  const ah = Math.max(1, window.innerHeight - s - EDGE * 2);
  ratio = { rx: (x - EDGE) / aw, ry: (y - EDGE) / ah };
  try {
    localStorage.setItem(LS_POS, JSON.stringify(ratio));
  } catch (e) {}
}

function loadRatio() {
  try {
    const raw = localStorage.getItem(LS_POS);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.rx === 'number' && typeof o.ry === 'number' && isFinite(o.rx) && isFinite(o.ry)) {
      ratio = { rx: Math.max(0, Math.min(1, o.rx)), ry: Math.max(0, Math.min(1, o.ry)) };
    }
  } catch (e) {}
}

// snap=true 时贴到最近的左/右边(拖动松手用); 单纯重排(false)就按存下来的比例还原。
function place(x, y, snap) {
  const s = ballSize();
  const aw = Math.max(1, window.innerWidth - s - EDGE * 2);
  const ah = Math.max(1, window.innerHeight - s - EDGE * 2);
  let px = clampX(x);
  const py = clampY(y);
  if (snap) px = px + s / 2 < window.innerWidth / 2 ? EDGE : window.innerWidth - s - EDGE;
  ball.style.left = Math.round(px) + 'px';
  ball.style.top = Math.round(py) + 'px';
  saveRatio(px, py);
  return { x: px, y: py };
}

function relayout() {
  if (!ball) return;
  ball.style.width = ballSize() + 'px';
  ball.style.height = ballSize() + 'px';
  const s = ballSize();
  const aw = Math.max(1, window.innerWidth - s - EDGE * 2);
  const ah = Math.max(1, window.innerHeight - s - EDGE * 2);
  const p = place(EDGE + ratio.rx * aw, EDGE + ratio.ry * ah, false);
  if (menuOpen) positionMenu(p);
}

function buildBall() {
  if (ball || !document.body) return;
  ball = document.createElement('div');
  ball.id = 'umg_float_ball';
  ball.textContent = '菜单';
  ball.style.cssText =
    'position:fixed;left:0;top:0;z-index:100010;display:flex;align-items:center;justify-content:center;' +
    'border-radius:50%;box-sizing:border-box;cursor:pointer;touch-action:none;' +
    'background:rgba(20,20,20,0.66);border:1px solid rgba(255,255,255,0.55);' +
    'box-shadow:0 0 0.8em rgba(0,0,0,0.5);color:#fff;opacity:0.62;' +
    'font-weight:700;font-size:clamp(13px,1.9vmin,18px);line-height:1;text-align:center;' +
    'transition:opacity .15s,background .15s;' + FONT +
    'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-user-drag:none;';
  ball.addEventListener('pointerdown', onBallDown);
  ball.addEventListener('pointerenter', () => { ball.style.opacity = '0.95'; });
  ball.addEventListener('pointerleave', () => { if (!drag) ball.style.opacity = '0.62'; });
  ball.style.display = hidden ? 'none' : 'flex';
  document.body.appendChild(ball);
  loadRatio();
  relayout();
}

function onBallDown(e) {
  if (!ball) return;
  e.preventDefault();
  e.stopPropagation();
  const r = ball.getBoundingClientRect();
  drag = {
    id: e.pointerId,
    ox: e.clientX - r.left,
    oy: e.clientY - r.top,
    x0: e.clientX,
    y0: e.clientY,
    moved: false
  };
  try { ball.setPointerCapture(e.pointerId); } catch (err) {}
  ball.addEventListener('pointermove', onBallMove);
  ball.addEventListener('pointerup', onBallUp);
  ball.addEventListener('pointercancel', onBallUp);
}

function onBallMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  e.stopPropagation();
  if (!drag.moved) {
    if (Math.abs(e.clientX - drag.x0) < DRAG_SLOP && Math.abs(e.clientY - drag.y0) < DRAG_SLOP) return;
    drag.moved = true;
    closeMenu(); // 拖动时不再弹按钮列, 免得挡住落点
  }
  ball.style.left = Math.round(clampX(e.clientX - drag.ox)) + 'px';
  ball.style.top = Math.round(clampY(e.clientY - drag.oy)) + 'px';
}

function onBallUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  e.preventDefault();
  e.stopPropagation();
  try { ball.releasePointerCapture(e.pointerId); } catch (err) {}
  ball.removeEventListener('pointermove', onBallMove);
  ball.removeEventListener('pointerup', onBallUp);
  ball.removeEventListener('pointercancel', onBallUp);
  const moved = drag.moved;
  drag = null;
  ball.style.opacity = '0.62';
  if (moved) {
    const r = ball.getBoundingClientRect();
    place(r.left, r.top, true); // 松手贴边
  } else {
    toggleMenu();
  }
}

// ---------- 按钮列 ----------

function labelOf(b) {
  return typeof b.label === 'function' ? String(b.label()) : String(b.label || '');
}

function enableOf(b) {
  return typeof b.enabled === 'function' ? !!b.enabled() : b.enabled !== false;
}

function buildMenu() {
  if (menu || !document.body) return;
  menu = document.createElement('div');
  menu.id = 'umg_float_menu';
  menu.style.cssText =
    'position:fixed;left:0;top:0;z-index:100011;display:none;flex-direction:column;gap:0.5em;' +
    'padding:0.9em;box-sizing:border-box;border-radius:0.8em;max-height:64vh;overflow:auto;' +
    'background:rgba(18,18,18,0.94);border:1px solid rgba(255,255,255,0.18);' +
    'box-shadow:0 0 1.4em rgba(0,0,0,0.6);color:#fff;' + FONT +
    'user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;';
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(menu);
}

function renderMenu() {
  buildMenu();
  while (menu.firstChild) menu.removeChild(menu.firstChild);
  for (const b of buttons) {
    const el = mkBtn(labelOf(b), !!b.primary);
    el.style.minWidth = '8em';
    const on = enableOf(b);
    setBtnDisabled(el, !on);
    if (on) onTap(el, () => { closeMenu(); b.onTap(); });
    menu.appendChild(el);
  }
  const st = document.createElement('div');
  st.textContent = statusFn ? String(statusFn() || '') : '';
  st.style.cssText =
    'font-size:clamp(11px,1.8vmin,15px);line-height:1.5;color:rgba(255,255,255,0.66);' +
    'max-width:16em;min-height:1em;margin-top:0.1em;';
  menu.appendChild(st);
}

function positionMenu(p) {
  const s = ballSize();
  const pos = p || { x: ball.offsetLeft, y: ball.offsetTop };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  // 球在右半屏就摆到球左边, 否则摆右边; 摆不下就翻到另一侧
  let left = pos.x - mw - MENU_GAP;
  if (left < EDGE) left = pos.x + s + MENU_GAP;
  if (left + mw > window.innerWidth - EDGE) left = Math.max(EDGE, window.innerWidth - mw - EDGE);
  // 纵向: 与球顶对齐, 但不许顶出视口、也不许压进虚拟键盘带(压上去就被键盘吃掉点击)
  let top = pos.y;
  const limit = Math.min(window.innerHeight - EDGE, keyboardTop() - EDGE);
  if (top + mh > limit) top = limit - mh;
  if (top < EDGE) top = EDGE;
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function openMenu() {
  if (!ball) return;
  renderMenu();
  menuOpen = true;
  menu.style.display = 'flex';
  positionMenu({ x: ball.offsetLeft, y: ball.offsetTop });
}

function closeMenu() {
  menuOpen = false;
  if (menu) menu.style.display = 'none';
}

function toggleMenu() {
  if (menuOpen) closeMenu();
  else openMenu();
}

// 点别处收起(捕获阶段, 不改事件传播 —— 游戏/键盘该怎么收还怎么收)
function onDocPointerDown(e) {
  if (!menuOpen) return;
  if (menu && menu.contains(e.target)) return;
  if (ball && (e.target === ball || ball.contains(e.target))) return;
  closeMenu();
}

// ---------- 对外 ----------

const api = {
  addButton(b) {
    if (!b || !b.id) return api;
    const i = buttons.findIndex((x) => x.id === b.id);
    if (i >= 0) buttons[i] = b;
    else buttons.push(b);
    if (menuOpen) openMenu(); // 开着就顺手刷新状态
    return api;
  },
  removeButton(id) {
    buttons = buttons.filter((b) => b.id !== id);
    if (menuOpen) openMenu();
    return api;
  },
  // 游戏或别的东西重建过 DOM 时球可能被摘掉, 这里补一次; 顺便让菜单跟着窗口变化。
  ensure() {
    if (!ball || !ball.isConnected) {
      ball = null;
      menu = null;
      menuOpen = false;
      buildBall();
      return;
    }
    if (menu && !menu.isConnected) {
      menu = null;
      menuOpen = false;
    }
    if (menuOpen) openMenu(); // 开着就重建按钮列, 状态(能不能刷卡)跟着刷新
  },
  hide(on) {
    hidden = !!on;
    if (ball) ball.style.display = hidden ? 'none' : 'flex';
    if (hidden) closeMenu();
  },
  get isOpen() {
    return menuOpen;
  },
  close: closeMenu
};

export function installFloatBall(opts) {
  if (!ball) {
    buttons = [];
    statusFn = (opts && opts.getStatus) || null;
    buildBall();
    buildMenu();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    document.addEventListener('pointerdown', onDocPointerDown, true);
  } else if (opts && opts.getStatus) {
    statusFn = opts.getStatus;
  }
  return api;
}
