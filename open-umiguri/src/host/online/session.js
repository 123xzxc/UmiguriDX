// 联机会话: 启动器与游戏内联机面板共用的登录态 + 请求封装。
//
// 与账号有关的三处写入(缺一不可, 详见 keypanel/launcher.js 的注释):
//   localStorage.umg_online_base / umg_online_token —— 游戏内 account 模块读它恢复会话;
//   window.umgr_elc.online.base                    —— 宿主桥的服务端地址;
//   window.__umgForceProfile.name                  —— 走游戏自带的「配置优先」通道,
//     把服务端 displayName 顶进存档, 游戏内名牌板据此显示。
// 集中在这里, 免得启动器与面板各写一遍。

export const LS_BASE = 'umg_online_base';
export const LS_TOKEN = 'umg_online_token';

export function readLS(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

export function writeLS(key, value) {
  try {
    if (value === null || value === undefined || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (e) {}
}

export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

// 卡号: 20 位、E004 开头。输入时容忍空格与连字符, 统一大写(与服务端规范化一致)。
export function normalizeCard(value) {
  return String(value || '').replace(/[\s-]/g, '').toUpperCase();
}

export function isValidCard(value) {
  return /^E004[0-9]{16}$/.test(normalizeCard(value));
}

export function onlineBridge() {
  return (window.umgr_elc && window.umgr_elc.online) || null;
}

// 当前登录态(内存副本)。启动器登录成功后 setSession 一次, 面板直接读。
export const session = { base: '', token: null, user: null };

// 只记地址(未登录 / 跳过 / 第一次进来时用)
export function setBase(url) {
  const base = normalizeBase(url);
  writeLS(LS_BASE, base);
  session.base = base;
  const bridge = onlineBridge();
  if (bridge) bridge.setBase(base);
  return base;
}

// 服务端地址线上的人话(仅用于界面显示)
export function maskCard(cardId) {
  const s = normalizeCard(cardId);
  if (s.length <= 8) return s;
  return s.slice(0, 4) + '…' + s.slice(-4);
}

// 把登录结果落到游戏要读的地方
export function setSession(cfg) {
  const base = setBase(cfg.base);
  writeLS(LS_TOKEN, cfg.token);
  session.token = cfg.token || null;
  session.token = cfg.token || null;
  session.user = cfg.user || null;
  const name = cfg.user && cfg.user.displayName;
  if (name) {
    try {
      window.__umgForceProfile = Object.assign({}, window.__umgForceProfile, { name });
    } catch (e) {}
    // 游戏侧握手对象就是宿主这个 umgr_elc._; 直接改它能立刻生效于「之后」任何一次
    // 读取。名牌板是启动时读一次, 所以换号后仍需重启才会刷新牌面。
    try {
      const hs = window.umgr_elc && window.umgr_elc._;
      if (hs && hs.rm) hs.rm.om = name;
    } catch (e) {}
  }
  return session;
}

export function clearSession() {
  writeLS(LS_TOKEN, null);
  session.token = null;
  session.user = null;
}

// 统一请求入口。useAuth=false 时只带服务端地址, 不带 token(登录接口用)。
export async function api(method, path, body, useAuth) {
  const bridge = onlineBridge();
  if (!bridge) return { ok: false, status: 0, data: null, error: '宿主联机桥不可用' };
  const base = session.base || normalizeBase(readLS(LS_BASE));
  if (!base) return { ok: false, status: 0, data: null, error: '未配置服务端地址' };
  if (bridge.base !== base) bridge.setBase(base);
  const token = useAuth === false ? null : session.token;
  return bridge.request(method, path, body, token);
}

// 用本地 token 拉一次资料, 确认登录态还有效
export async function restore() {
  const base = normalizeBase(readLS(LS_BASE));
  const token = readLS(LS_TOKEN);
  if (!base || !token) return null;
  session.base = base;
  const r = await api('GET', '/auth/whoami', null, true);
  if (!r.ok) return null;
  session.token = token;
  session.user = r.data.user;
  return r.data.user;
}

