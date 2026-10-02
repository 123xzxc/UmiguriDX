// 绑定卡号: 游戏加载前弹出的卡号输入界面。
//
// 游戏端登录只认卡号, 没有密码 —— 与街机刷卡一致。卡号由服务端发卡
// (/admin-panel 用管理员令牌发, /panel 用账号 + Google 验证器绑到账号上)。
// 这里只把「服务端地址 + 卡号」记在本机: 真正刷卡发生在游戏里
// (桌面没有 AM 读卡器, 见 host/online/native.js 与 ui.js 的悬浮「刷卡」按钮)。
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
import { nativePort, setNativePort, DEFAULT_NATIVE_PORT } from "../online/native.js";

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

  box.appendChild(mkTitle("绑定卡号"));
  box.appendChild(mkHint("填服务端地址 + AIME 卡号即完成绑定。一张卡一个账号, 无需密码。"));
  box.appendChild(mkHint("地址填 umiguri-native-server 即可: 它同时提供游戏原生联机(8101)与启动器/面板要的 REST。"));

  box.appendChild(mkLabel("服务端地址"));
  const baseInput = mkInput("http://127.0.0.1:8101");
  baseInput.value = savedBase || "";
  box.appendChild(baseInput);

  box.appendChild(mkLabel("AIME 卡号"));
  const cardInput = mkInput("E004 开头的 20 位卡号");
  cardInput.maxLength = 32;
  box.appendChild(cardInput);

  box.appendChild(mkLabel("原生服务端端口"));
  const nativeInput = mkInput(String(DEFAULT_NATIVE_PORT));
  nativeInput.value = nativePort() ? String(nativePort()) : "";
  nativeInput.maxLength = 5;
  box.appendChild(nativeInput);
  // 这一栏留空 = 游戏回到纯单机: 游戏里会走游客登录, 打完的歌也不会上传到服务端
  // (本地存档还在)。玩家看不出这层因果, 所以状态要说清楚, 并在他清空时给出提醒。
  const nativeHint = mkHint("");
  box.appendChild(nativeHint);
  function updateNativeHint() {
    const empty = !String(nativeInput.value).trim();
    nativeHint.textContent = empty
      ? "留空 = 不接游戏原生联机: 游戏里会是游客登录, 成绩只存本地、不上传。想存到服务端就把端口填回 8101。"
      : "接游戏原生联机: 游戏内的刷卡登录 / 云存档 / 联机房间都走它。";
  }
  nativeInput.addEventListener("input", updateNativeHint);
  updateNativeHint();

  const state = mkHint("");
  box.appendChild(state);

  const row = mkRow();
  const loginBtn = mkBtn("绑定", true);
  const skipBtn = mkBtn("跳过", false);
  row.appendChild(loginBtn);
  row.appendChild(skipBtn);
  box.appendChild(row);

  const panelHint = mkHint("还没有卡号? 用管理员令牌打开服务端 /admin-panel 发一张, 再在 /panel 绑到账号上。");
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
    setState("绑定中…");
    setBase(base);
    setNativePort(nativeInput.value);
    const r = await api("POST", "/auth/card", { cardId }, false);
    setBtnDisabled(loginBtn, false);
    if (!r.ok) {
      setState(r.status === 0 ? "连不上服务端: " + (r.error || "") : (r.error || "绑定失败"));
      return;
    }
    const cfg = { base, cardId, token: r.data.token, user: r.data.user };
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
    setNativePort(nativeInput.value);
    done({ base, token: null, user: null, skipped: true });
  });

  return new Promise((resolve) => {
    finish = resolve;
  });
}

export const installLauncher = boot;

