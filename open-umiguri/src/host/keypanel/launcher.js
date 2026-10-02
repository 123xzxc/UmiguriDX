// 联机登录器: 游戏加载前弹出的卡号输入界面。
//
// 游戏端登录只认卡号, 没有密码 —— 与街机刷卡一致。卡号由网页面板
// (/panel, 用账号 + Google 验证器登录)注册, 一张卡绑一个账号。
//
// 与账号有关的写入全部集中在 host/online/session.js(setBase/setSession),
// 免得启动器、游戏内面板两处各写一遍(这里只负责界面与流程)。
//
// 跳过条件: 本地已有 token 且校验通过就直接放行(老用户无感);
//           ?launcher=1 强制打开, ?nolaunch 强制跳过。
// 游戏内换号: host/online/ui.js 的联机面板会再叫一次 openLauncher()。
import {
  mkOverlay, mkBox, mkTitle, mkLabel, mkInput, mkBtn, mkRow, mkHint, onTap, setBtnDisabled,
} from "./uikit.js";
import {
  LS_BASE, LS_TOKEN, readLS, normalizeBase, normalizeCard, isValidCard,
  onlineBridge, api, setBase, setSession, restore,
} from "../online/session.js";

export { normalizeCard } from "../online/session.js";

async function boot() {
  const force = /(?:^|[?&])launcher=1(?:&|$)/.test(location.search);
  if (/(?:^|[?&])nolaunch(?:&|$)/.test(location.search)) return null;

  const savedBase = normalizeBase(readLS(LS_BASE));
  const savedToken = readLS(LS_TOKEN) || "";
  if (!force && savedBase && savedToken) {
    // 有 token 就先静默校验; 服务器连不上时落到下面, 让用户自己决定
    const user = await restore();
    if (user) {
      setSession({ base: savedBase, token: savedToken, user });
      return { base: savedBase, token: savedToken, user, skipped: true };
    }
  }

  return openLauncher(savedBase);
}

// 打开登录界面。返回 Promise<登录结果|null>(nolaunch 时为 null, 跳过时为 {skipped:true})。
export function openLauncher(savedBase) {
  const overlay = mkOverlay("ugv_launcher", 60000);
  const box = mkBox();
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  box.appendChild(mkTitle("联机登录"));
  box.appendChild(mkHint("输入卡号即可登录。卡号在网页面板注册, 无需密码。"));

  box.appendChild(mkLabel("服务端地址"));
  const baseInput = mkInput("http://127.0.0.1:8787");
  baseInput.value = savedBase || "";
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
    setBase(base);
    const r = await api("POST", "/auth/card", { cardId }, false);
    setBtnDisabled(loginBtn, false);
    if (!r.ok) {
      setState(r.status === 0 ? "连不上服务端: " + (r.error || "") : (r.error || "登录失败"));
      return;
    }
    const cfg = { base, token: r.data.token, user: r.data.user };
    setSession(cfg);
    done(cfg);
  }

  onTap(loginBtn, submit);
  cardInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  baseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") cardInput.focus();
  });
  onTap(skipBtn, () => {
    // 只记住地址, 不写 token: 游戏内仍可登录, 且下次启动会再弹
    const base = setBase(baseInput.value);
    done({ base, token: null, user: null, skipped: true });
  });

  return new Promise((resolve) => {
    finish = resolve;
  });
}

export const installLauncher = boot;

