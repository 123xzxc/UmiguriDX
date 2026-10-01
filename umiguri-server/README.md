# umiguri-server

UMIGURI 联机服务端: 卡号登录、游玩记录、用户名与称号、房间联机(含实时对手分数),
外加一个网页面板用于注册卡号与改资料。

## 认证模型(重要)

全程无密码, 两套凭据各管一边:

| 入口 | 凭据 | 说明 |
| --- | --- | --- |
| 游戏端 | **AIME 卡号** | 20 位、`E004` 开头。输卡号即登录, 无密码 |
| 网页面板 `/panel` | **用户名 + TOTP** | Google 验证器等 TOTP App 的 6 位验证码 |
| `/admin/*` | **管理员令牌** | Bearer `UMIGURI_ADMIN_TOKEN`, 用于建号/发卡 |

账号由管理员创建, **不开放自助注册** —— TOTP 密钥若能自助申请, 谁都能绑上任意用户名。
创建后管理员拿到 `otpauth://` 链接, 用户扫码即完成绑定。

卡号是「凭据之一」: 一张卡绑一个账号, 一个账号可持多张卡。卡号泄露等于账号被盗,
因此支持吊销(`DELETE /cards/:cardId`), 换卡时旧卡立即失效。

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
| `UMIGURI_ADMIN_TOKEN` | 空(启动时随机生成并打印) | 管理员令牌 |
| `UMIGURI_PANEL_TTL` | `604800`(7 天) | 面板会话有效期(秒) |
| `UMIGURI_PANEL_COOKIE` | `umg_panel` | 面板会话 cookie 名 |
| `UMIGURI_PANEL_SECURE` | `0` | 置 1 给 cookie 加 `Secure`(生产 https 用) |
| `UMIGURI_LOG_LEVEL` | `info` | `info` / `silent` |

## 测试

```bash
node test/smoke.mjs
```

覆盖 卡号登录 / TOTP 面板 / 发卡与吊销 / 资料 / 记录 / 排行榜 / 房间与实时分数同步 的 53 项断言。
测试每次使用干净的 `data/smoke.db`, 可重复运行。

## API

除 `/health`、`/auth/*`、`GET /leaderboard` 外, 全部需要
`Authorization: Bearer <token>`。

### 游戏端登录(卡号)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/card` | `{cardId}` -> `{token, user, card}` |
| GET | `/auth/whoami` | 校验当前 token 并返回用户 |

卡号 20 位、`E004` 开头。服务端先规范化(去空格/连字符、转大写),
所以输入 `e004 xxxx ...` 也能登录。token 为 HS256 JWT。

### 卡号管理(需游戏端登录态)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cards` | 列出自己的卡号 |
| POST | `/cards` | `{cardId?, label?}` 发卡(省略 cardId 则随机生成) |
| DELETE | `/cards/:cardId` | 吊销卡号 |

### 网页面板 `/panel`

浏览器打开 `/panel` 即是界面(单文件, 无前端构建)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/panel` | 面板 HTML |
| POST | `/panel/login` | `{username, code}` —— TOTP 登录, 下发 HttpOnly cookie |
| POST | `/panel/logout` | 退出 |
| GET | `/panel/me` | 面板会话 + 自己的卡号(未登录返回 `{user: null}`) |
| PATCH | `/panel/profile` | 改显示名/称号 |
| POST | `/panel/cards` | 面板内发卡 |
| DELETE | `/panel/cards/:cardId` | 面板内吊销 |
| GET | `/panel/plays` / `/panel/bests` | 游玩记录 / 个人最佳 |

面板会话用 `HttpOnly` + `SameSite=Strict` cookie, 与游戏端 JWT 完全分开 ——
网页会话泄露不会连带游戏端身份。

### 管理接口(Bearer 管理员令牌)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/users` | `{username}` -> `{user, totpSecret, otpauthUrl}` |
| POST | `/admin/users/:id/totp-reset` | 换一把新 TOTP 密钥 |
| POST | `/admin/cards` | `{userId, cardId?, label?}` 给指定账号发卡 |

`otpauthUrl` 交给用户用 Google 验证器扫码即可。密钥在用户首次用有效验证码
登录前处于「未确认」状态, 该状态下登录会被拒绝 —— 避免建号后被人抢绑。

### 建号流程示例

```bash
# 1. 拿管理员令牌: 未设 UMIGURI_ADMIN_TOKEN 时, 启动日志里会打印
# 2. 建号, 记下返回的 otpauthUrl
curl -X POST http://127.0.0.1:8787/admin/users \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"username":"yourname"}'
# 3. 把 otpauthUrl 变成二维码让用户扫(或直接手输密钥)
# 4. 用户用验证器里的 6 位码登录 /panel, 自行生成卡号
```
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
