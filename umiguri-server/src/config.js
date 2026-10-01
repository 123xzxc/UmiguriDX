// 服务端配置: 全部可用环境变量覆盖, 便于部署。
// 默认值面向本地开发(单机跑起来就能用), 生产部署请务必改 UMIGURI_JWT_SECRET。

const env = process.env;

function int(name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int("UMIGURI_PORT", 8787),
  host: env.UMIGURI_HOST || "0.0.0.0",

  // SQLite 数据库文件路径
  dbPath: env.UMIGURI_DB || "./data/umiguri.db",

  // JWT 签名密钥。默认值仅供本地开发; 生产必须覆盖。
  jwtSecret: env.UMIGURI_JWT_SECRET || "umiguri-dev-secret-change-me",
  jwtTtlSeconds: int("UMIGURI_JWT_TTL", 60 * 60 * 24 * 30),

  // 房间号: 6 位纯数字(与游戏 openCoop 的 inputDigit0~5 对应)
  roomCodeLength: 6,
  roomCodePattern: /^[0-9]{6}$/,

  // 房间空闲回收(秒): 最后一名玩家离开后保留多久, 便于重连
  roomIdleTtlSeconds: int("UMIGURI_ROOM_TTL", 600),

  // 单房间最大玩家数(与 coopLobby 的 4 个 playerBox 对应)
  roomMaxPlayers: 4,

  // 战绩上报的合理性区间(防刷分)
  scoreRange: { min: 0, max: 1010000 },
  // 偏差值区间(游戏内 rating)
  ratingRange: { min: 0, max: 20000 },

  // 用户名规则: 与游戏 nameEntry 一致, 最长 8 字符
  nameMaxLength: 8,

  logLevel: env.UMIGURI_LOG_LEVEL || "info"
};
