// 联机登录器: 游戏加载前弹出的卡号输入界面。
//
// 游戏端登录只认卡号, 没有密码 —— 与街机刷卡一致。卡号由网页面板
// (/panel, 用账号 + Google 验证器登录)注册, 一张卡绑一个账号。
//
// 与账号有关的三处写入, 缺一不可:
//   localStorage.umg_online_base / umg_online_token —— 给游戏侧 account 模块,
//     它启动时读这两个键恢复会话, 并在后续请求里带上 token;
//   window.umgr_elc.online.base                     —— 给宿主桥(同页内存);
//   window.__umgForceProfile.name                   —— 走游戏自带的「配置优先」
//     通道(见 src/host/main.js 的 force.name), 把服务端 displayName 顶进存档。
//
// 跳过条件: 本地已有 token 且校验通过就直接放行(老用户无感);
//           ?launcher=1 强制打开, ?nolaunch 强制跳过。
import {
  mkOverlay, mkBox, mkTitle, mkLabel, mkInput, mkBtn, mkRow, mkHint, onTap, setBtnDisabled,
} from "./uikit.js";

const LS_BASE = "umg_online_base";
const LS_TOKEN = "umg_online_token";

function readLS(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function writeLS(key, value) {
  try {
    if (value === null || value === undefined || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (e) {}
}

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// 卡号: 20 位、E004 开头。输入时容忍空格与连字符, 统一大写(与服务端规范化一致)。
export function normalizeCard(value) {
  return String(value || "").replace(/[\s-]/g, "").toUpperCase();
}

function isValidCard(value) {
  return /^E004[0-9]{16}$/.test(normalizeCard(value));
}

function onlineBridge() {
  return (window.umgr_elc && window.umgr_elc.online) || null;
}

// 走宿主桥发请求 —— 不经页面 origin, 自建服放哪都能连。
async function api(base, method, path, body, token) {
  const bridge = onlineBridge();
  if (!bridge) return { ok: false, status: 0, data: null, error: "宿主联机桥不可用" };
  bridge.setBase(base);
  return bridge.request(method, path, body, token);
}

// 用本地 token 拉一次资料, 确认登录态还有效
async function restore(base, token) {
  if (!base || !token) return null;
  const r = await api(base, "GET", "/auth/whoami", null, token);
  return r.ok ? r.data.user : null;
}

// 把登录结果落到游戏要读的地方
export function applyLogin(cfg) {
  writeLS(LS_BASE, cfg.base);
  writeLS(LS_TOKEN, cfg.token);
  const bridge = onlineBridge();
  if (bridge) bridge.setBase(cfg.base || "");
  const name = cfg.user && cfg.user.displayName;
  if (name) {
    try {
      window.__umgForceProfile = Object.assign({}, window.__umgForceProfile, { name });
    } catch (e) {}
  }
}

async function boot() {
  const force = /(?:^|[?&])launcher=1(?:&|$)/.test(location.search);
  if (/(?:^|[?&])nolaunch(?:&|$)/.test(location.search)) return null;

  const savedBase = readLS(LS_BASE) || "";
  const savedToken = readLS(LS_TOKEN) || "";
  if (!force && savedBase && savedToken) {
    // 有 token 就先静默校验; 服务器连不上时放行, 让游戏内自己去报错
    const user = await restore(savedBase, savedToken);
    if (user) {
      applyLogin({ base: savedBase, token: savedToken, user });
      return { base: savedBase, token: savedToken, user, skipped: true };
    }
  }

  return openUI(savedBase);
}

function openUI(savedBase) {
  const overlay = mkOverlay("ugv_launcher", 60000);
  const box = mkBox();
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.appendChild(mkTitle("联机登录"));
  box.appendChild(mkHint("输入卡号即可登录。卡号在网页面板注册, 无需密码。"));

  box.appendChild(mkLabel("服务端地址"));
  const baseInput = mkInput("http://127.0.0.1:8787");
  baseInput.value = savedBase;
  box.appendChild(baseInput);

  box.appendChild(mkLabel("AIME 卡号"));
  const cardInput = mkInput("E004 开头的 20 位卡号");
  cardInput.maxLength = 32;
  box.appendChild(cardInput);

  const state = mkHint("");
  box.appendChild(state);

  const row = mkRow();
  const loginBtn = mkBtn("登录", true);
  const skipBtn = mkBtn("跳过", false);
  row.appendChild(loginBtn);
  row.appendChild(skipBtn);
  box.appendChild(row);

  const panelHint = mkHint("还没有卡号? 打开服务端的 /panel 页面注册。");
  box.appendChild(panelHint);

  function setState(text) {
    state.textContent = text || "";
  }

  let finish = null;
  function done(cfg) {
    try {
      overlay.remove();
    } catch (e) {}
    if (finish) finish(cfg);
  }

  async function submit() {
    const base = normalizeBase(baseInput.value);
    const cardId = normalizeCard(cardInput.value);
    if (!base) return setState("请填写服务端地址");
    if (!isValidCard(cardId)) return setState("卡号格式不对: 应为 20 位、E004 开头");
    setBtnDisabled(loginBtn, true);
    setState("登录中…");
    writeLS(LS_BASE, base);
    const r = await api(base, "POST", "/auth/card", { cardId });
    setBtnDisabled(loginBtn, false);
    if (!r.ok) {
      setState(r.status === 0 ? "连不上服务端: " + (r.error || "") : (r.error || "登录失败"));
      return;
    }
    const cfg = { base, token: r.data.token, user: r.data.user };
    applyLogin(cfg);
    done(cfg);
  }

  onTap(loginBtn, submit);
  cardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  onTap(skipBtn, () => {
    // 只记住地址, 不写 token: 游戏内仍可登录, 且下次启动会再弹
    writeLS(LS_BASE, normalizeBase(baseInput.value));
    const b = onlineBridge();
    if (b) b.setBase(normalizeBase(baseInput.value));
    done({ base: normalizeBase(baseInput.value), token: null, user: null, skipped: true });
  });

  return new Promise((resolve) => {
    finish = resolve;
  });
}

export const installLauncher = boot;
