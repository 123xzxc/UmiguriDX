# umiguri-server

UMIGURI 联机服务端: 账号登录、游玩记录、用户名与称号、房间联机(含实时对手分数)。

零外部依赖 —— 只用 Node 内置模块(`node:http` / `node:sqlite` / `node:crypto`),
`npm start` 即可运行。

## 环境要求

- Node.js >= 22.5(依赖内置的 `node:sqlite`; 开发环境实测 Node 24)
- 无需 npm install(没有第三方依赖)

## 运行

```bash
node src/index.js
# 或
npm start
```

默认监听 `0.0.0.0:8787`, 数据库文件 `./data/umiguri.db`(自动创建)。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UMIGURI_PORT` | `8787` | 监听端口 |
| `UMIGURI_HOST` | `0.0.0.0` | 监听地址 |
| `UMIGURI_DB` | `./data/umiguri.db` | SQLite 文件路径 |
| `UMIGURI_JWT_SECRET` | `umiguri-dev-secret-change-me` | **生产必须覆盖** |
| `UMIGURI_JWT_TTL` | `2592000`(30 天) | token 有效期(秒) |
| `UMIGURI_ROOM_TTL` | `600` | 空房间保留秒数 |
| `UMIGURI_LOG_LEVEL` | `info` | `info` / `silent` |

## 测试

```bash
node test/smoke.mjs
```

覆盖账号、资料、记录、排行榜、房间与实时分数同步的 32 项断言。

## API

除 `/health`、`/auth/*`、`GET /leaderboard` 外, 全部需要
`Authorization: Bearer <token>`。

### 账号

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | `{username, password}` -> `{token, user}` |
| POST | `/auth/login` | `{username, password}` -> `{token, user}` |

用户名 3~24 位(字母数字下划线连字符), 口令至少 8 位。
口令用 scrypt 哈希存储, token 为 HS256 JWT。

### 个人资料(用户名与称号)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/profile` | 读取当前用户 |
| PATCH | `/profile` | `{displayName?, nameplate?, title?}` |

- `displayName`: 游戏内显示名, **最多 8 字符**(与游戏 `nameEntry` 的 `v_g_29009.Ny.length < 8` 一致, 按码点计)
- `nameplate`: 称号牌索引(对应 `nameplates`, 8 个)
- `title`: 称号索引(对应 `titles/title_%04d.txt`)

### 游玩记录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/plays` | 上报一局, 返回 `{id, isBest}` |
| GET | `/plays?limit=&offset=` | 最近记录 |
| GET | `/plays/best` | 个人最佳(每曲每难度一条) |

上报字段: `musicId` `difficulty` `score` `rank` `clear` `combo`
`judgeCrit` `judgeMiss` `playedAt`。
分数限定在 `0~1010000`, 越界返回 400(防刷分)。

### 排行榜

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/leaderboard` | 总榜(按 rating) |
| GET | `/leaderboard?musicId=&difficulty=` | 单曲榜 |

### 房间联机

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/rooms` | 创建房间, 返回 6 位数字房间号 |
| POST | `/rooms/:code/join` | 加入 |
| POST | `/rooms/:code/leave` | 离开(房主离开自动移交) |
| POST | `/rooms/:code/ready` | `{ready}` 准备 |
| POST | `/rooms/:code/music` | `{musicId, difficulty}` 仅房主 |
| POST | `/rooms/:code/start` | 开局, 重置全体进度 |
| POST | `/rooms/:code/finish` | 进入结算 |
| POST | `/rooms/:code/progress` | **实时上报** `{score, progress}` |
| GET | `/rooms/:code/state?since=` | **实时读取**房间快照 |

房间号规则 `^[0-9]{6}$`, 对应游戏 `openCoop` 的 `inputDigit0`~`inputDigit5`。
单房间上限 4 人, 对应 `coopLobby` 的 4 个 `playerBox`。
一人同时只能在一个房间。

## 实时对手分数怎么工作

客户端在对局中做两件事:

1. 按固定间隔 `POST /rooms/:code/progress` 上报自己的 `score` 与 `progress`
2. 按固定间隔 `GET /rooms/:code/state?since=<version>` 拿对手分数

服务端给每次快照算一个 `version`(玩家分数/进度的聚合指纹)。
若传入的 `since` 与当前 `version` 相同, 只返回 `{unchanged: true}`,
客户端直接跳过重绘 —— 心跳轮询的带宽与渲染开销都能压到最低。

## 已知限制

- 采用 HTTP 轮询而非 WebSocket(按需求选定), 对手分数存在一个轮询间隔的延迟
- 尚未接入游戏客户端: 客户端侧还需补回 `openCoop` 房间入口与 `coopLobby`
  房间态逻辑(见仓库根 `ONLINE.md`)
- 无对局结果防篡改: 当前只做区间校验, 未做服务端重放校验
