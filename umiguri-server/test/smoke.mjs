// 冒烟测试: 覆盖 卡号登录 / TOTP 面板 / 资料 / 记录 / 排行榜 / 房间 全链路。
//
// 注意: src/config.js 在模块加载时读取 process.env, 因此环境变量必须在
// import 之前设好 —— 这要求 ESM 的动态 import, 不能写静态 import。

// 每次跑都用干净的库: 否则上次失败的残留数据会让「建号」直接撞 username_taken,
// 表现为与代码无关的假失败。
import { rmSync } from "node:fs";
rmSync("./data/smoke.db", { force: true });
rmSync("./data/smoke.db-shm", { force: true });
rmSync("./data/smoke.db-wal", { force: true });

process.env.UMIGURI_DB = "./data/smoke.db";
process.env.UMIGURI_JWT_SECRET = "smoke-secret";
process.env.UMIGURI_ADMIN_TOKEN = "smoke-admin";

const { startServer } = await import("../src/server.js");
const { totp } = await import("../src/lib/totp.js");
const { qrMatrix } = await import("../src/lib/qr.js");

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const server = startServer({ port: PORT, host: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

async function call(method, path, body, token, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: await res.json(), setCookie };
}

// 管理员建号 -> 拿 TOTP 密钥
async function adminCreateUser(username) {
  const r = await call("POST", "/admin/users", { username }, "smoke-admin");
  return r;
}

console.log("== 健康检查 ==");
const health = await call("GET", "/health");
check("health 200", health.status === 200);

console.log("== 管理员建号 ==");
const created = await adminCreateUser("player1");
check("建号成功", created.status === 200 && created.body.ok, JSON.stringify(created.body));
check("返回 TOTP 密钥", typeof created.body.totpSecret === "string" && created.body.totpSecret.length >= 16);
check("返回 otpauth 链接", String(created.body.otpauthUrl).startsWith("otpauth://totp/"));
check("返回绑定二维码", String(created.body.otpauthQr).startsWith("data:image/svg+xml;base64,"), String(created.body.otpauthQr).slice(0, 32));
const qrSvg1 = Buffer.from(String(created.body.otpauthQr).split(",")[1] || "", "base64").toString("utf8");
const qrM1 = qrMatrix(created.body.otpauthUrl);
check("二维码画的就是这个 otpauth 链接", !!qrM1 && qrSvg1.includes('viewBox="0 0 ' + (qrM1.size + 8) + " " + (qrM1.size + 8) + '"'), qrM1 ? "v" + qrM1.version + " size=" + qrM1.size : "null");
const secret1 = created.body.totpSecret;
const userId1 = created.body.user.id;

const dup = await adminCreateUser("player1");
check("重复用户名 409", dup.status === 409, String(dup.status));

const noAdmin = await call("POST", "/admin/users", { username: "hacker" });
check("无管理员令牌 400", noAdmin.status === 400, String(noAdmin.status));

const badAdmin = await call("POST", "/admin/users", { username: "hacker" }, "wrong-token");
check("错误管理员令牌 400", badAdmin.status === 400, String(badAdmin.status));

console.log("== 面板: TOTP 登录(无密码) ==");
const badCode = await call("POST", "/panel/login", { username: "player1", code: "000000" });
check("错误验证码 401", badCode.status === 401, String(badCode.status));

const login = await call("POST", "/panel/login", { username: "player1", code: totp(secret1) });
check("TOTP 登录成功", login.status === 200 && login.body.ok, JSON.stringify(login.body));
check("下发面板 cookie", typeof login.setCookie === "string" && login.setCookie.includes("umg_panel="));
const cookie1 = login.setCookie.split(";")[0];

const me = await call("GET", "/panel/me", undefined, undefined, cookie1);
check("面板会话有效", me.status === 200 && me.body.user?.username === "player1");

const meNoCookie = await call("GET", "/panel/me");
check("无 cookie 未登录", meNoCookie.status === 200 && meNoCookie.body.user === null);

const totpCode = await call("POST", "/panel/login", { username: "player1", code: "abcdef" });
check("非数字验证码 401", totpCode.status === 401, String(totpCode.status));

console.log("== 发卡与卡号登录 ==");
const issued = await call("POST", "/admin/cards", { userId: userId1, label: "主力卡" }, "smoke-admin");
check("管理员发卡", issued.status === 200 && /^E004[0-9]{16}$/.test(issued.body.card.cardId), JSON.stringify(issued.body));
const card1 = issued.body.card.cardId;

const cardLogin = await call("POST", "/auth/card", { cardId: card1 });
check("卡号登录成功", cardLogin.status === 200 && cardLogin.body.ok, JSON.stringify(cardLogin.body));
const token = cardLogin.body.token;
check("返回游戏端 token", typeof token === "string" && token.split(".").length === 3);
check("卡号登录即无密码", cardLogin.body.user.username === "player1");

const cardSpaced = await call("POST", "/auth/card", { cardId: card1.toLowerCase() });
check("小写卡号也能登录(规范化)", cardSpaced.status === 200, String(cardSpaced.status));

const badCard = await call("POST", "/auth/card", { cardId: "E0040000000000000000" });
check("未注册卡号 404", badCard.status === 404, String(badCard.status));

const malformed = await call("POST", "/auth/card", { cardId: "12345" });
check("非法卡号 400", malformed.status === 400, String(malformed.status));

console.log("== 卡号自助管理 ==");
const myCards = await call("GET", "/cards", undefined, token);
check("列出自己的卡", myCards.status === 200 && myCards.body.cards.length === 1);

const selfIssued = await call("POST", "/cards", { label: "备用卡" }, token);
check("自助发卡", selfIssued.status === 200 && selfIssued.body.card.cardId !== card1);
const card2 = selfIssued.body.card.cardId;

const revoked = await call("DELETE", `/cards/${card2}`, undefined, token);
check("吊销卡号", revoked.status === 200 && revoked.body.card.revokedAt > 0);

const revokedLogin = await call("POST", "/auth/card", { cardId: card2 });
check("已吊销卡号不能登录", revokedLogin.status === 404, String(revokedLogin.status));

console.log("== 资料: 用户名与称号 ==");
const prof = await call("GET", "/profile", undefined, token);
check("读取资料", prof.status === 200 && prof.body.user.username === "player1");

const upd = await call("PATCH", "/profile", { displayName: "ＵＭＩＧＵＲＩ", nameplate: 3, title: 7 }, token);
check("改显示名/称号牌", upd.status === 200 && upd.body.user.displayName === "ＵＭＩＧＵＲＩ"
  && upd.body.user.nameplate === 3 && upd.body.user.title === 7, JSON.stringify(upd.body));

const panelUpd = await call("PATCH", "/panel/profile", { displayName: "PANELNM" }, undefined, cookie1);
check("面板改资料", panelUpd.status === 200 && panelUpd.body.user.displayName === "PANELNM", JSON.stringify(panelUpd.body));

// 8 字符上限(与游戏 nameEntry 一致): 超长必须被拒, 否则游戏里名字会被截断
const tooLong = await call("PATCH", "/panel/profile", { displayName: "123456789" }, undefined, cookie1);
check("显示名超 8 字符 400", tooLong.status === 400, String(tooLong.status));

const noCookiePatch = await call("PATCH", "/panel/profile", { displayName: "X" });
check("无 cookie 改资料 401", noCookiePatch.status === 401, String(noCookiePatch.status));

console.log("== 面板页面 ==");
const page = await fetch(BASE + "/panel");
const html = await page.text();
check("面板页面 200", page.status === 200);
check("面板含登录表单", html.includes("panel/login") && html.includes("UMIGURI"));

console.log("== 游玩记录与排行榜 ==");
const play = await call("POST", "/plays", {
  musicId: "music001", difficulty: 3, score: 1008000, rank: "sss", clear: 1, combo: 1200
}, token);
check("上报游玩", play.status === 200, JSON.stringify(play.body));

const badPlay = await call("POST", "/plays", { musicId: "music001", difficulty: 3, score: 99999999 }, token);
check("分数越界 400", badPlay.status === 400, String(badPlay.status));

const plays = await call("GET", "/plays", undefined, token);
check("列出游玩", plays.status === 200 && plays.body.plays.length === 1);

const bests = await call("GET", "/plays/best", undefined, token);
check("个人最佳", bests.status === 200 && bests.body.bests.length === 1);

const board = await call("GET", "/leaderboard?musicId=music001&difficulty=3");
check("曲目排行榜", board.status === 200 && board.body.entries.length === 1 && board.body.entries[0].score === 1008000);

const total = await call("GET", "/leaderboard");
check("总排行榜", total.status === 200 && Array.isArray(total.body.total));

// player2: 房间测试用
const created2 = await adminCreateUser("player2");
const secret2 = created2.body.totpSecret;
const cardLogin2 = await (async () => {
  const c = await call("POST", "/admin/cards", { userId: created2.body.user.id }, "smoke-admin");
  return call("POST", "/auth/card", { cardId: c.body.card.cardId });
})();
const token2 = cardLogin2.body.token;
check("player2 卡号登录", cardLogin2.status === 200);

console.log("== 房间 ==");
const room = await call("POST", "/rooms", {}, token);
check("创建房间", room.status === 200, JSON.stringify(room.body));
const code = room.body.room?.code;
check("房间号是 6 位数字", /^[0-9]{6}$/.test(String(code)), String(code));
check("房主在房间内", room.body.room?.players?.length === 1 && room.body.room.players[0].userId === 1);

const join = await call("POST", `/rooms/${code}/join`, {}, token2);
check("玩家2 加入", join.status === 200 && join.body.room.players.length === 2, JSON.stringify(join.body));

const badRoomCode = await call("POST", "/rooms/abc/join", {}, token2);
check("非法房间号 400", badRoomCode.status === 400, String(badRoomCode.status));

const missing = await call("POST", "/rooms/999999/join", {}, token2);
check("不存在的房间 404", missing.status === 404, String(missing.status));

const ready = await call("POST", `/rooms/${code}/ready`, { ready: true }, token2);
check("准备", ready.status === 200 && ready.body.room.players[1].ready === true);

const music = await call("POST", `/rooms/${code}/music`, { musicId: "music_0001", difficulty: 3 }, token);
check("房主选曲", music.status === 200 && music.body.room.musicId === "music_0001");

const notHost = await call("POST", `/rooms/${code}/music`, { musicId: "x" }, token2);
check("非房主选曲 403", notHost.status === 403, String(notHost.status));

const start = await call("POST", `/rooms/${code}/start`, {}, token);
check("开始对局", start.status === 200 && start.body.room.status === "playing");

console.log("== 实时分数同步(本功能核心) ==");
await call("POST", `/rooms/${code}/progress`, { score: 300000, progress: 1000 }, token);
await call("POST", `/rooms/${code}/progress`, { score: 450000, progress: 2000 }, token2);

const state = await call("GET", `/rooms/${code}/state`, undefined, token);
check("读取对手分数", state.status === 200
  && state.body.room.players[0].score === 300000
  && state.body.room.players[1].score === 450000, JSON.stringify(state.body.room.players));

const since = state.body.room.version;
const unchanged = await call("GET", `/rooms/${code}/state?since=${since}`, undefined, token);
check("无变化时增量返回 unchanged", unchanged.body.room.unchanged === true, JSON.stringify(unchanged.body));

await call("POST", `/rooms/${code}/progress`, { score: 600000, progress: 4000 }, token2);
const changed = await call("GET", `/rooms/${code}/state?since=${since}`, undefined, token);
check("有变化时返回完整快照", changed.body.room.unchanged === undefined
  && changed.body.room.players[1].score === 600000, JSON.stringify(changed.body.room.unchanged));

const outsider = await call("GET", `/rooms/${code}/state`, undefined, undefined);
check("未认证读房间 401", outsider.status === 401, String(outsider.status));

console.log("== 离开与房主移交 ==");
const created3 = await adminCreateUser("player3");
const card3 = await call("POST", "/admin/cards", { userId: created3.body.user.id }, "smoke-admin");
const token3 = (await call("POST", "/auth/card", { cardId: card3.body.card.cardId })).body.token;
await call("POST", `/rooms/${code}/join`, {}, token3);
const leave = await call("POST", `/rooms/${code}/leave`, {}, token);
check("房主离开并移交", leave.status === 200 && leave.body.result.dissolved === false
  && typeof leave.body.result.newHostId === "number", JSON.stringify(leave.body));

console.log("== 管理面板(网页) ==");
const adminPageRes = await fetch(BASE + "/admin-panel");
const adminPageHtml = await adminPageRes.text();
check("管理面板页面 200", adminPageRes.status === 200, String(adminPageRes.status));
check("页面是 HTML", String(adminPageRes.headers.get("content-type")).includes("text/html"));
check("页面含登录表单", adminPageHtml.includes("管理员令牌"));

const meAnon = await call("GET", "/admin-panel/me");
check("未登录读 me 401", meAnon.status === 401, String(meAnon.status));

const badLogin = await call("POST", "/admin-panel/login", { token: "nope" });
check("错误令牌登录 401", badLogin.status === 401 && badLogin.body.code === "admin_unauthorized", JSON.stringify(badLogin.body));

const apLogin = await call("POST", "/admin-panel/login", { token: "smoke-admin" });
check("正确令牌登录成功", apLogin.status === 200, JSON.stringify(apLogin.body));
check("下发管理会话 cookie", String(apLogin.setCookie || "").includes("umg_admin="), String(apLogin.setCookie));
const adminCookie = String(apLogin.setCookie || "").split(";")[0];

const meOk = await call("GET", "/admin-panel/me", undefined, undefined, adminCookie);
check("带会话读 me 成功", meOk.status === 200 && meOk.body.userCount >= 3, JSON.stringify(meOk.body));

const users = await call("GET", "/admin-panel/users", undefined, undefined, adminCookie);
check("列出账号", users.status === 200 && users.body.users.length >= 3, JSON.stringify(users.body).slice(0, 160));
check("账号带卡号", users.body.users.some((u) => Array.isArray(u.cards) && u.cards.length > 0));
check("账号带验证器状态", users.body.users.every((u) => typeof u.totpBound === "boolean"));
check("账号带卡数", users.body.users.every((u) => typeof u.cardCount === "number"));

const panelUser = await call("POST", "/admin-panel/users", { username: "panelmade" }, undefined, adminCookie);
check("面板建号成功", panelUser.status === 200 && panelUser.body.user.username === "panelmade", JSON.stringify(panelUser.body));
check("面板建号返回密钥", typeof panelUser.body.totpSecret === "string" && panelUser.body.totpSecret.length >= 16);
const panelUserId = panelUser.body.user.id;

const panelCode = totp(panelUser.body.totpSecret);
check("面板建的密钥可用", /^[0-9]{6}$/.test(panelCode), panelCode);

const panelReset = await call("POST", "/admin-panel/users/" + panelUserId + "/totp-reset", {}, undefined, adminCookie);
check("面板重置验证器", panelReset.status === 200 && panelReset.body.totpSecret !== panelUser.body.totpSecret);
check("重置后换一张二维码", panelReset.status === 200 && String(panelReset.body.otpauthQr).startsWith("data:image/svg+xml;base64,") && panelReset.body.otpauthQr !== panelUser.body.otpauthQr);

const panelCard = await call("POST", "/admin-panel/users/" + panelUserId + "/cards", { label: "smoke" }, undefined, adminCookie);
check("面板发卡", panelCard.status === 200 && /^E004[0-9]{16}$/.test(String(panelCard.body.card.cardId)), JSON.stringify(panelCard.body));

const panelCards = await call("GET", "/admin-panel/users/" + panelUserId + "/cards", undefined, undefined, adminCookie);
check("面板列卡", panelCards.status === 200 && panelCards.body.cards.length === 1);

const panelRevoke = await call("DELETE", "/admin-panel/cards/" + panelCard.body.card.cardId, undefined, undefined, adminCookie);
check("面板吊销卡", panelRevoke.status === 200 && typeof panelRevoke.body.card.revokedAt === "number", JSON.stringify(panelRevoke.body));

const cardGone = await call("POST", "/auth/card", { cardId: panelCard.body.card.cardId });
check("吊销后不能登录", cardGone.status === 404, String(cardGone.status));

const usersNoAuth = await call("GET", "/admin-panel/users");
check("无会话列账号 401", usersNoAuth.status === 401, String(usersNoAuth.status));

// 节流用伪造的 XFF 头, 免得把 127.0.0.1 也锁掉, 影响后续用例。
let locked = false;
for (let i = 0; i < 10; i++) {
  const r = await fetch(BASE + "/admin-panel/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ token: "wrong-" + i })
  });
  const j = await r.json();
  if (j.code === "admin_locked") { locked = true; break; }
}
check("连续失败触发节流", locked);

const logout = await call("POST", "/admin-panel/logout", {}, undefined, adminCookie);
check("退出登录清 cookie", String(logout.setCookie || "").includes("Max-Age=0"), String(logout.setCookie));
const meAfter = await call("GET", "/admin-panel/me", undefined, undefined, adminCookie);
check("退出后会话失效", meAfter.status === 401, String(meAfter.status));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
server.close();
process.exit(fail === 0 ? 0 : 1);
