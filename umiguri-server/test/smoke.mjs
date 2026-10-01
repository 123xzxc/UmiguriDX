// 冒烟测试: 覆盖账号/资料/记录/排行榜/房间全链路。
import { startServer } from "../src/server.js";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.UMIGURI_DB = "./data/smoke.db";
process.env.UMIGURI_JWT_SECRET = "smoke-secret";

const server = startServer({ port: PORT, host: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

console.log("== 健康检查 ==");
const health = await call("GET", "/health");
check("health 200", health.status === 200);

console.log("== 账号 ==");
const reg = await call("POST", "/auth/register", { username: "player1", password: "password123" });
check("注册成功", reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));
const token = reg.body.token;
check("返回 token", typeof token === "string" && token.split(".").length === 3);
check("返回用户", reg.body.user?.username === "player1");

const dup = await call("POST", "/auth/register", { username: "player1", password: "password123" });
check("重复用户名 409", dup.status === 409, String(dup.status));

const login = await call("POST", "/auth/login", { username: "player1", password: "password123" });
check("登录成功", login.status === 200 && login.body.ok);

const badLogin = await call("POST", "/auth/login", { username: "player1", password: "wrongpassword" });
check("错误口令 401", badLogin.status === 401, String(badLogin.status));

const noAuth = await call("GET", "/profile");
check("无 token 访问 /profile 401", noAuth.status === 401, String(noAuth.status));

console.log("== 资料: 用户名与称号 ==");
const prof = await call("GET", "/profile", undefined, token);
check("读取资料", prof.status === 200 && prof.body.user.username === "player1");

const upd = await call("PATCH", "/profile", { displayName: "ＵＭＩＧＵＲＩ", nameplate: 3, title: 7 }, token);
check("改显示名/称号牌", upd.status === 200 && upd.body.user.displayName === "ＵＭＩＧＵＲＩ"
  && upd.body.user.nameplate === 3 && upd.body.user.title === 7, JSON.stringify(upd.body));

const tooLong = await call("PATCH", "/profile", { displayName: "123456789" }, token);
check("超过 8 字符被拒 400", tooLong.status === 400, String(tooLong.status));

console.log("== 游玩记录 ==");
const play1 = await call("POST", "/plays", {
  musicId: "music_0001", difficulty: 3, score: 998500, rank: "SSS",
  clear: 1, combo: 1200, judgeCrit: 1100, judgeMiss: 2
}, token);
check("上报成绩", play1.status === 200 && play1.body.isBest === true, JSON.stringify(play1.body));

const play2 = await call("POST", "/plays", {
  musicId: "music_0001", difficulty: 3, score: 981000, rank: "SS"
}, token);
check("低分不覆盖最佳", play2.status === 200 && play2.body.isBest === false);

const plays = await call("GET", "/plays", undefined, token);
check("列出记录", plays.status === 200 && plays.body.plays.length === 2, JSON.stringify(plays.body.plays?.length));

const bests = await call("GET", "/plays/best", undefined, token);
check("个人最佳只留最高分", bests.body.bests.length === 1 && bests.body.bests[0].score === 998500);

console.log("== 排行榜 ==");
const reg2 = await call("POST", "/auth/register", { username: "player2", password: "password123" });
const token2 = reg2.body.token;
await call("POST", "/plays", { musicId: "music_0001", difficulty: 3, score: 1005000, rank: "SSS+" }, token2);

const lb = await call("GET", "/leaderboard?musicId=music_0001&difficulty=3");
check("单曲榜按分数降序", lb.status === 200 && lb.body.entries.length === 2
  && lb.body.entries[0].displayName === "player2", JSON.stringify(lb.body.entries));

const total = await call("GET", "/leaderboard");
check("总榜可用", total.status === 200 && Array.isArray(total.body.total));

console.log("== 房间 ==");
const room = await call("POST", "/rooms", {}, token);
check("创建房间", room.status === 200, JSON.stringify(room.body));
const code = room.body.room?.code;
check("房间号是 6 位数字", /^[0-9]{6}$/.test(String(code)), String(code));
check("房主在房间内", room.body.room?.players?.length === 1 && room.body.room.players[0].userId === 1);

const join = await call("POST", `/rooms/${code}/join`, {}, token2);
check("玩家2 加入", join.status === 200 && join.body.room.players.length === 2, JSON.stringify(join.body));

const badCode = await call("POST", "/rooms/abc/join", {}, token2);
check("非法房间号 400", badCode.status === 400, String(badCode.status));

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
const reg3 = await call("POST", "/auth/register", { username: "player3", password: "password123" });
await call("POST", `/rooms/${code}/join`, {}, reg3.body.token);
const leave = await call("POST", `/rooms/${code}/leave`, {}, token);
check("房主离开并移交", leave.status === 200 && leave.body.result.dissolved === false
  && typeof leave.body.result.newHostId === "number", JSON.stringify(leave.body));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
server.close();
process.exit(fail === 0 ? 0 : 1);
