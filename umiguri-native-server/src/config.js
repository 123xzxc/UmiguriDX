// 配置: 全部可用环境变量覆盖。
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const env = process.env;

function int(name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

const here = dirname(fileURLToPath(import.meta.url));

export const config = {
  // 游戏内置的联机地址是 d.umgr-serv.inonote.jp:8101, 所以默认也听 8101,
  // 客户端那边只要把主机名换成本机就能直连。
  port: int("UMIGURI_NATIVE_PORT", 8101),
  host: env.UMIGURI_NATIVE_HOST || "0.0.0.0",

  // 默认与 umiguri-server 共用同一个库 —— 网页面板发的卡, 游戏里直接能刷。
  // (两个进程同时开着也没问题: 开了 WAL + busy_timeout。)
  dbPath: env.UMIGURI_DB || resolve(here, "..", "..", "umiguri-server", "data", "umiguri.db"),

  // 会话(登录 token)存活时间
  sessionTtlSeconds: int("UMIGURI_NATIVE_SESSION_TTL", 60 * 60 * 24 * 30),

  // 未注册但格式合法的卡号是否自动建号(自建服默认开: 刷一张新卡就能玩)。
  autoRegister: bool("UMIGURI_NATIVE_AUTO_REGISTER", true),

  // 全新账号的 getProfile 返回什么:
  //   ok              —— 直接给一份默认档案(推荐: 客户端拿到完整数据, 不会出现未定义字段)
  //   card_not_found  —— 返回 -11, 让客户端走「新卡建档」流程(Ey + setProfile 上传)
  newCardProfile: env.UMIGURI_NATIVE_NEW_CARD || "ok",

  // 同一张卡重复登录: false = 顶掉旧会话(默认), true = 回 card_dup_login
  rejectDuplicateLogin: bool("UMIGURI_NATIVE_DUP_LOGIN", false),

  // 联机房间
  roomMaxPlayers: int("UMIGURI_NATIVE_ROOM_MAX", 4),
  roomIdleTtlSeconds: int("UMIGURI_NATIVE_ROOM_TTL", 300),

  // 打印 /sock 每一帧的操作码与解析结果(排查联机问题的第一手材料)
  traceSock: bool("UMIGURI_SOCK_TRACE", false),
  // 打印 HTTP /1/* 的请求与结果
  traceHttp: bool("UMIGURI_NATIVE_HTTP_TRACE", false),

  logLevel: env.UMIGURI_LOG_LEVEL || "info"
};
