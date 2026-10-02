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

  // ---- 网页面板 ----
  // 面板会话: 与游戏端 JWT 分开的两套凭据(见 panel.js)。
  panelSessionTtlSeconds: int("UMIGURI_PANEL_TTL", 60 * 60 * 24 * 7),
  panelCookieName: env.UMIGURI_PANEL_COOKIE || "umg_panel",
  // 本地 http 调试时不能带 Secure, 否则浏览器不收 cookie。生产 https 请置 1。
  panelCookieSecure: env.UMIGURI_PANEL_SECURE === "1",

  // ---- 管理面板 ----
  // 与玩家面板分开的第三套凭据: 管理员令牌 -> 管理会话。
  // 会话时长刻意比玩家面板短, 管理权限更大, 泄漏窗口要更小。
  adminCookieName: env.UMIGURI_ADMIN_COOKIE || "umg_admin",
  adminSessionTtlSeconds: int("UMIGURI_ADMIN_TTL", 60 * 60 * 12),
  // 登录失败节流: 连续失败到上限后锁定一段时间, 防在线暴力猜令牌。
  adminLoginMaxFails: int("UMIGURI_ADMIN_MAX_FAILS", 8),
  adminLoginLockSeconds: int("UMIGURI_ADMIN_LOCK", 5 * 60),

  // 管理员令牌: 用于创建账号 / 重置验证器 / 发卡。
  // 留空时启动阶段随机生成并打印到控制台(见 server.js), 不落盘。
  adminToken: env.UMIGURI_ADMIN_TOKEN || "",

  logLevel: env.UMIGURI_LOG_LEVEL || "info"
};
