# umiguri-server

UMIGURI 联机服务端: 卡号登录、游玩记录、用户名与称号、房间联机(含实时对手分数),
外加两个网页界面: 玩家面板(注册卡号/改资料)与管理面板(建号/发卡)。

## 认证模型(重要)

全程无密码, 两套凭据各管一边:

| 入口 | 凭据 | 说明 |
| --- | --- | --- |
| 游戏端 | **AIME 卡号** | 20 位、`E004` 开头。输卡号即登录, 无密码 |
| 网页面板 `/panel` | **用户名 + TOTP** | Google 验证器等 TOTP App 的 6 位验证码 |
| `/admin/*` | **管理员令牌** | Bearer `UMIGURI_ADMIN_TOKEN`, 用于建号/发卡 |
| 管理面板 `/admin-panel` | **管理员令牌** | 同上, 登录后换 12 小时会话 cookie |

账号由管理员创建, **不开放自助注册** —— TOTP 密钥若能自助申请, 谁都能绑上任意用户名。
创建后管理面板直接给出**二维码**, 用户扫一下就绑好了(密钥与 `otpauth://` 链接同时给出)。

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

> 这套 REST 与网页面板**同时也挂在原生服务端**[`umiguri-native-server`](../umiguri-native-server)(端口 8101)
> 上(见那边的 `src/web-panel.js`)。启动器的服务端地址填 8101 时, 请求由原生服务端接;
> 填 8787 时由这里接 —— 两边同一个库、同一套 JWT 密钥, 账号与卡号完全互通。
> 只想跑一个进程就用原生服务端。

### Windows 一键启动

双击 `start-server.bat` 即可。它会:

1. 首次运行时生成随机的 JWT 密钥与管理员令牌, 存到 `data\jwt-secret`、
   `data\admin-token`, 之后复用(这两个文件在 `.gitignore` 里, 不会进仓库);
2. 把管理员令牌打印在窗口里 —— 管理面板与建号都要用它;
3. 启动服务端。

`my-ip.bat` 用来查本机在局域网里的地址, 填进游戏启动器即可让同网段的机器连上。
异地联机不行, 那需要内网穿透(如 Cloudflare Tunnel)或公网服务器。
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
| `UMIGURI_ADMIN_TTL` | `43200`(12 小时) | 管理面板会话有效期(秒) |
| `UMIGURI_ADMIN_COOKIE` | `umg_admin` | 管理面板会话 cookie 名 |
| `UMIGURI_PANEL_SECURE` | `0` | 置 1 给 cookie 加 `Secure`(生产 https 用) |
| `UMIGURI_LOG_LEVEL` | `info` | `info` / `silent` |

## 测试

```bash
node test/smoke.mjs   # 或 npm test      —— 全链路(HTTP)
node test/qr.mjs      # 或 npm run test:qr —— 二维码编码器(离线)
```

覆盖 卡号登录 / TOTP 面板 / 发卡与吊销 / 资料 / 记录 / 排行榜 / 房间与实时分数同步
的 100 项断言。测试每次使用干净的 `data/smoke.db`, 可重复运行。其中包括一条页面自检:
把 `/panel` 与 `/admin-panel` 的内联 `<script>` 抠出来做语法检查 —— 页面是字符串拼出来的,
拼错一个引号就会交付一个「能打开、但所有按钮都点不动」的页面, 而服务端不会有任何日志。

二维码那 78 项是纯离线自检: 版本与分块表对照规范公布的总码字数/容量、格式信息与版本
信息的 BCH 常数、矩阵结构(定位/定时/校正图形), 以及把画好的矩阵**反向解码回原文**。

## 打包部署

```bash
node tools/pack.mjs   # 或 npm run pack
```

产出 `dist/umiguri-server-<版本>.tar.gz`。服务端零第三方依赖, 所以包里只有
`src/` + `package.json` + `README.md` + `DEPLOY.md`, 解包后直接 `node src/index.js`,
**不需要** `npm install`。

## CI

服务端与联机版客户端由 `.github/workflows/release.yml` 一起构建
(手动触发或推 `v*` 标签)。服务端相关的两个 job 排在最前, 跑得快:

| job | 内容 |
| --- | --- |
| `server-test` | 语法检查 + 77 项冒烟断言(卡号/面板/管理面板/房间/实时分数) |
| `server-pack` | 产出可部署的 tar.gz(依赖 `server-test` 通过) |
| `windows` / `macos` / `linux` / `ios` / `android` | 客户端构建 |

客户端产物**不预置服务端地址** —— 用户首次启动时在启动器里填, 因此一份包
可以连任意服务器。
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

### 管理面板 `/admin-panel`

浏览器打开 `/admin-panel`, 粘贴管理员令牌即可登录。这是给人工操作用的网页;
`/admin/*` 那套接口保留给脚本与 CI, 两者能力相同。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin-panel` | 管理面板 HTML |
| POST | `/admin-panel/login` | `{token}` —— 管理员令牌换会话 cookie |
| POST | `/admin-panel/logout` | 退出 |
| GET | `/admin-panel/me` | 探活(有效则返回账号总数) |
| GET | `/admin-panel/users` | 账号列表, 每项带自己的卡号 |
| POST | `/admin-panel/users` | `{username}` -> `{user, totpSecret, otpauthUrl, otpauthQr}` |
| POST | `/admin-panel/users/:id/totp-reset` | 换一把新 TOTP 密钥, 同样回 `otpauthQr` |
| GET | `/admin-panel/users/:id/cards` | 该账号的卡号 |
| POST | `/admin-panel/users/:id/cards` | 给该账号发卡 |
| DELETE | `/admin-panel/cards/:cardId` | 吊销卡号 |

几个设计取舍:

- **不把管理员令牌直接写进 cookie**: 令牌是长期凭据且不过期, 落到浏览器里就没法单独作废。登录换取的是随机会话 token + 12 小时 TTL, 换令牌不影响已发会话。
- **会话用 `HttpOnly` + `SameSite=Strict`**: 管理面板无跨站跳转需求, 直接堵掉 CSRF。
- **登录失败节流**: 同一 IP 连续失败 8 次锁 5 分钟(见 `UMIGURI_ADMIN_MAX_FAILS` / `UMIGURI_ADMIN_LOCK`), 防在线爆破。可用 `X-Forwarded-For` 走反代时按真实 IP 计。
- **密钥只显示一次**: TOTP 密钥与二维码在创建/重置的响应里返回, 之后从不再吐。页面提示管理员当场交给玩家扫码。
- **没有自助注册**: 这是刻意的。若允许自助申请 TOTP 密钥, 任何人都能对已存在的用户名重新申请, 等于接管账号。建号只能由管理员做。
- **二维码自己画**: 面板不外链任何 CDN(要能离线部署), Node 又没内置二维码, 所以 `src/lib/qr.js` 是一个零依赖编码器(byte 模式 + 纠错等级 M + 版本 1-10 自适应)。它的正确性由 `test/qr.mjs` 反向解码验证, 而不是只靠肉眼看图。
### 管理接口(Bearer 管理员令牌)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/users` | `{username}` -> `{user, totpSecret, otpauthUrl, otpauthQr}` |
| POST | `/admin/users/:id/totp-reset` | 换一把新 TOTP 密钥, 同样回 `otpauthQr` |
| POST | `/admin/cards` | `{userId, cardId?, label?}` 给指定账号发卡 |

`otpauthQr` 是服务端直接画好的二维码(data: URI 的 SVG, 零依赖, 见 `src/lib/qr.js`),
`otpauthUrl` 是它编码的原文, 两者内容一致 —— 前端不想要 data URI 也可以自己拿链接去渲染。
密钥在用户首次用有效验证码登录前处于「未确认」状态, 该状态下登录会被拒绝 —— 避免建号后被人抢绑。

### 建号流程示例

**推荐用网页**: 打开 `/admin-panel`, 粘贴管理员令牌登录, 在「建号」里填用户名。
页面会显示一张**二维码**, 让玩家用验证器 App(Google Authenticator 等)直接扫 —— 扫一下就绑好了,
不用手抄密钥。二维码与密钥只显示这一次, 之后再也拿不到(换手机就点「重置验证器」重发一张)。

**脚本方式**(CI / 批量建号):

```bash
# 管理员令牌: 启动日志里打印, 或读 data/admin-token
ADMIN_TOKEN=$(cat data/admin-token)

curl -X POST http://127.0.0.1:8787/admin/users \
  -H "content-type: application/json" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"username":"yourname"}'
# 返回 {user, totpSecret, otpauthUrl, otpauthQr}
```

拿到密钥后交给玩家绑定; 玩家登录 `/panel` 后可在面板里自行生成卡号,
或由管理员用 `/admin-panel` 的「发卡」按钮代发。
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
- 无自助注册: 建号只能由管理员做(设计取舍, 见上方「管理面板」小节的安全说明),
  玩家拿到密钥后自行接管账号
- 无对局结果防篡改: 当前只做区间校验, 未做服务端重放校验
