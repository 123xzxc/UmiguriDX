// 校验联机链路真的进了混淆产物。
//
// 为什么需要这个: 游戏前端经 --obfuscate 打包, 字符串会被抽进数组并转义
// (空格变 \x20 之类), 因此不能拿明文串去比对产物。这里先按 build/encrypt.mjs
// 的参数解密 dist/www/main.js.enc, 再在解密后的明文上检索。
//
// 它防的是两类回归:
//   1. account 模块被 tree-shake 掉 / 忘了注册进 index.js —— 产物里搜不到卡号链路;
//   2. 认证改型后旧接口残留 —— /auth/register 与 /auth/login 必须已消失。
//      (模块内部逻辑是否被混淆破坏, 由 contract-check 与 freevar-check 兜底。)
//
// 用法: node tools/verify-online-bundle.mjs

import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const encPath = join(root, "dist", "www", "main.js.enc");

if (!existsSync(encPath)) {
  console.error("[verify] 找不到 " + encPath + " —— 请先跑 npm run build:esm");
  process.exit(1);
}

// 与 build/encrypt.mjs 保持一致
const KEY = "umiguri-2025-inonote-16bytes-key";
const IV = "umiguri-iv-16byt";

const enc = readFileSync(encPath);
const decipher = createDecipheriv("aes-256-cbc", Buffer.from(KEY), Buffer.from(IV));
decipher.setAutoPadding(false);
let plain = Buffer.concat([decipher.update(enc), decipher.final()]);
const pad = plain[plain.length - 1];
if (pad >= 1 && pad <= 16) plain = plain.slice(0, plain.length - pad);
const js = plain.toString("utf8");

// 每条: [说明, 必须出现的字面量]
const REQUIRED = [
  ["卡号登录接口", "/auth/card"],
  ["会话校验接口", "/auth/whoami"],
  ["卡号格式校验", "E004[0-9]{16}"],
  ["token 持久化键", "umg_online_token"],
  ["服务端地址键", "umg_online_base"],
  ["房间实时分数接口", "/progress"],
  ["玩家显示名字段", "displayName"],
  // 游戏原生联机: tools/game-patches.mjs 的「原生联机」补丁只在宿主下发
  // window.__umgServer 时才把联机客户端指向自建服务端(umiguri-native-server)。
  // 属性名不参与混淆重命名, 所以能直接在产物里数。
  ["原生联机开关", "__umgServer"],
  ["刷卡虚拟按钮钩子", "__umgSwipe"],
  ["刷卡一次性令牌钩子", "__umgArmCardSwipe"],
  ["宿主直登后门", "__umgHostLogin"],
  ["游客兜底(vA 守卫)", "__umgGuestGuard"],
  ["官方服务端回退地址", "d.umgr-serv.inonote.jp"],
];

let bad = 0;
for (const [label, needle] of REQUIRED) {
  const n = js.split(needle).length - 1;
  if (n > 0) {
    console.log("  OK   " + label + "  (" + needle + " x" + n + ")");
  } else {
    console.error("  FAIL " + label + "  未在产物中找到: " + needle);
    bad++;
  }
}

// 旧接口不应残留: 认证已改为无密码, 这两个必须消失。
for (const stale of ["/auth/register", "/auth/login"]) {
  if (js.includes(stale)) {
    console.error("  FAIL 过期代码残留: " + stale);
    bad++;
  } else {
    console.log("  OK   已移除旧登录接口 " + stale);
  }
}

// 原生联机补丁至少要落在 3 处(账号客户端 / 房间客户端 host / port + 刷卡桩);
// 少于这个数说明补丁没进产物(或被 tree-shake 掉了)。
{
  const n = js.split("__umgServer").length - 1;
  if (n >= 3) {
    console.log("  OK   原生联机补丁完整  (__umgServer x" + n + ")");
  } else {
    console.error("  FAIL 原生联机补丁不完整: 只在产物里找到 " + n + " 处 __umgServer(应 >= 3)");
    bad++;
  }
}

// 启动器侧的卡号历史存在宿主桥产物里(不是游戏产物)。
{
  const hostPath = join(root, "dist", "www", "tauri-bridge.js");
  const hostJs = existsSync(hostPath) ? readFileSync(hostPath, "utf8") : "";
  for (const [label, needle] of [
    ["卡号历史键", "umg_online_card_history"],
    ["触摸按键显示开关", "umg_nav_visible"],
  ]) {
    if (hostJs.includes(needle)) {
      console.log("  OK   " + label + "  (" + needle + ")");
    } else {
      console.error("  FAIL " + label + "  未在宿主桥产物中找到: " + needle);
      bad++;
    }
  }
}

if (bad > 0) {
  console.error("[verify] 联机链路校验失败: " + bad + " 项");
  process.exit(1);
}
console.log("[verify] 联机链路校验通过 (产物 " + enc.length + " 字节)");
