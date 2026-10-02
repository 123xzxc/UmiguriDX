# umiguri-native-server

游戏**原生协议**服务端: 卡号登录、云存档、游戏内联机房间, 外加网页面板和启动器要的旧 REST。

## 它解决什么问题

游戏本体其实带了一整套联机实现(登录刷卡、云存档、游戏内房间),但它连的是官方服务器
`d.umgr-serv.inonote.jp:8101`,而且客户端把协议写死在了 bundle 里。`umiguri-server`
那套 REST 接口**游戏一行都不会调** —— 它是给网页面板、自制面板和**启动器**用的
(启动器的卡号登录/房间都走它, 见下)。

这个服务端做的事情就是:**按游戏本来就在说的那套协议回答它**。

| | umiguri-server | umiguri-native-server(本项目) |
|---|---|---|
| 面向 | 网页面板 / 自制联机面板 / 管理后台 | 游戏本体 + 网页面板 |
| 协议 | 自家 REST(JSON + JWT) | `POST /1/*` (JSON) + `GET /sock` (加密二进制 WebSocket) |
| 默认端口 | 8787 | **8101**(游戏写死的端口) |
| 数据库 | `umiguri-server/data/umiguri.db` | **同一个库**(账号/卡号共用) |
| 网页面板 | 有(`/panel`, `/admin-panel`) | **有**(同一套页面, 直接挂在 8101 上) |
| 游戏端旧 REST | 有(`/auth/card` 等) | **有**(整套一起挂在 8101 上, 见下) |

也就是说: **只跑这一个进程就够了** —— 游戏联机、云存档、网页面板、管理后台、
启动器要的 REST 都在 8101。`umiguri-server` 现在只是"不带游戏协议的那半边",
需要时可以两个一起跑(同一个库, 各听自己的端口), 账号与卡号完全互通。

## 快速开始

需要 Node.js 22.5 或更高版本(用了内置的 `node:sqlite`, 不需要任何第三方依赖)。

```bat
:: Windows 直接双击
start-server.bat

:: 或者
node src/index.js
```

启动后会打印本机可以做联机地址的 IP,形如 `http://192.168.1.23:8101`。

跑一遍自检(会临时建一个测试库, 不影响正式数据):

```bat
node test/native-smoke.mjs
```

## 网页面板

面板(玩家面板 + 管理面板)与游戏接口**同一个端口**, 页面和凭据体系都复用
`umiguri-server` 那一套(见 `src/web-panel.js`)。同一份代码顺带把游戏端旧 REST
也挂上了(启动器就是靠它登录的, 见下一节):

| 地址 | 用途 | 登录方式 |
|---|---|---|
| `http://<地址>:8101/panel` | 玩家面板: 改用户名/称号、看自己的卡、看最近游玩 | 用户名 + Google 验证器(TOTP) |
| `http://<地址>:8101/admin-panel` | 管理面板: 建号、重置验证器、发卡、吊销卡 | 管理员令牌 |
| `/admin/*` | 同一批管理能力的接口版(给脚本/CI 用) | `Authorization: Bearer <管理员令牌>` |

管理员令牌存在 `umiguri-server/data/admin-token`(与两个服务端共用), 优先级是
`UMIGURI_ADMIN_TOKEN` 环境变量 > 该文件 > 随机生成并写盘。启动时会在控制台打印,
复制它就能登管理面板。

要注意的两点:

- **面板只认 TOTP, 没有密码**(这是刻意的: 有口令就有口令泄露)。所以新账号要开面板,
  得由管理员在管理面板里点一次"重置验证器", 把密钥/扫码链接发给本人。
- 自动注册的卡号(直接刷卡建出来的号)一开始没有验证器密钥, 同理需要管理员发一次。
- 面板里的"最近游玩"读的是 `plays` / `bests` 表(与 umiguri-server 共用的表),
  原生成绩写进 `native_records` 时会**顺手镜像一份**过去, 所以原生模式下面板也有记录,
  等级按分数算(阈值与客户端 `scope.rankLabel` 一致), 通关状态取 `flags` 第 0 位。

## 启动器要的旧 REST

启动器(以及任何自制前端)用的是 `umiguri-server` 的那套 REST, 不是游戏的 `/1/*`。
这套接口原先只在 8787 上有, 所以把启动器里的服务端地址填成 `http://<IP>:8101` 时
**每个请求都会 404** —— 原生服务端只认 `/1/*` 与 `/sock`。现在它与面板一起挂在
同一个端口上, **启动器的服务端地址直接填 `http://<IP>:8101` 就行**:

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/card` | `{cardId}` -> `{token, user, card}`, 卡号即登录 |
| GET | `/auth/whoami` | 校验 token 并返回用户 |
| GET / PATCH | `/profile` | 读 / 改用户名与称号 |
| GET / POST | `/cards`, `DELETE /cards/:cardId` | 卡号自助管理 |
| POST / GET | `/plays`, `GET /plays/best` | 上报一局 / 最近记录 / 个人最佳 |
| GET | `/leaderboard` | 总分榜; 带 `musicId`+`difficulty` 则为单曲榜 |
| POST | `/rooms` | 建房 |
| POST | `/rooms/:code/{join,leave,music,ready,start,progress,finish}` | 房间操作 |
| GET | `/rooms/:code/state` | 房间状态(对手分数) |

两个要注意的点:

- 响应格式是 `{ok:true, ...}`, 与原生 `/1/*` 的 `{result:"ok", ...}` **不一样**。两套
  并存, 各按各的约定解析, 别混用。
- 用的是 `umiguri-server/src/config.js` 的 JWT 密钥(`UMIGURI_JWT_SECRET`), 沿用默认值时
  启动会打一行警告。生产部署务必设置。两个端口共用同一个密钥与同一个库, 所以 8101
  签发的 token 在 8787 上也认; 房间记录也在库里, 两个端口看到的是同一份。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `UMIGURI_NATIVE_PORT` | `8101` | 监听端口。游戏写死 8101, 除非客户端打了补丁, 否则别改 |
| `UMIGURI_NATIVE_HOST` | `0.0.0.0` | 监听地址 |
| `UMIGURI_DB` | `../umiguri-server/data/umiguri.db` | 数据库。与 umiguri-server 共用同一份账号与卡号 |
| `UMIGURI_ADMIN_TOKEN` | 空 | 管理面板/管理接口的令牌。留空则读 `umiguri-server/data/admin-token`, 还没有就随机生成并写盘 |
| `UMIGURI_PANEL_TTL` | `604800` | 面板会话有效期(秒), 默认 7 天 |
| `UMIGURI_PANEL_SECURE` | `0` | 面板 cookie 是否带 `Secure`。挂在 https 反代后面时置 `1` |
| `UMIGURI_NATIVE_AUTO_REGISTER` | `1` | 格式合法但没注册过的卡号是否自动建号 |
| `UMIGURI_NATIVE_NEW_CARD` | `ok` | 新账号 getProfile 返回什么。`card_not_found` 则回 -11 让客户端走"新卡建档"流程 |
| `UMIGURI_NATIVE_DUP_LOGIN` | `0` | 同一张卡重复登录: `0`=顶掉旧会话, `1`=回 `card_dup_login` |
| `UMIGURI_NATIVE_ROOM_MAX` | `4` | 单房间人数上限(游戏大厅是 4 个位置) |
| `UMIGURI_NATIVE_SESSION_TTL` | `2592000` | 登录 token 有效期(秒), 默认 30 天 |
| `UMIGURI_SOCK_TRACE` | `0` | `1` 时逐帧打印 /sock 的操作码(排障用, 见下) |
| `UMIGURI_NATIVE_HTTP_TRACE` | `0` | `1` 时打印 /1/* 请求 |

## 卡号

卡号沿用 AIME 格式: 20 位、`E004` 开头、后 16 位数字。两种来源:

1. **网页面板发卡**(umiguri-server 的管理面板), 游戏里直接刷这张卡即可;
2. **自动注册**: 默认开着, 刷一张格式合法但没见过的卡会自动建号(名字是 `ＵＭＩＧＵＲＩ`,
   进游戏后在游戏里改)。想关掉就设 `UMIGURI_NATIVE_AUTO_REGISTER=0`。

游戏内改名字/称号/名牌后, 会通过 `/1/umiguri/setProfile` 存回服务端, 同时同步进
`users` 表, 所以网页面板里也能看到同一个名字。

## 已实现的协议

### HTTP(`POST /1/...`)

| 路径 | 说明 |
|---|---|
| `/1/user/login` | 刷卡登录, 回 `{result:"ok", token, user_id}` |
| `/1/user/logout` | 注销 |
| `/1/umiguri/getProfile` | 取档案(名字/等级/rating/角色/称号/名牌/上次选曲/20 个聊天槽) |
| `/1/umiguri/setProfile` | 存档案(只覆盖带上来的字段) |
| `/1/umiguri/getOptions` `setOptions` | 设置项(scrollSpeed / 判定偏移 / 音量 / 各种显示开关) |
| `/1/umiguri/getRecords` `setRecord` | 单曲成绩(同一曲同一难度只留最高分) |
| `/1/umiguri/getCourseRecords` `setRecord` | Course 成绩 |
| `/1/umiguri/getCharaStates` `setCharaState` | 角色等级/经验/技能 |

新账号的设置项会照抄游戏内置的预设 0(`scrollSpeed=4`、`masterVolume=100` 等)。
这点很重要: 直接回 0 的话, `scrollSpeed=0` 会让人没法玩、`masterVolume=0` 会整机静音。

游戏在 WebView 里发请求, `Content-Type: application/json` 会触发 CORS 预检,
所以 `OPTIONS` 也必须正确应答(不然表现是"登录一直失败而且没报错")。

### WebSocket(`GET /sock`)

帧格式: `u32 魔数 + u8 操作码 + u8 序号`, 整帧用一个硬编码密钥的 RC4 变体加解密
(实现在 `src/lib/wire.js`, 与客户端 `v_ic_28200` 逐字节一致, 有测试守着)。

- op < 128 是客户端请求, 服务端必须回**同操作码 + 同序号**, 载荷开头多一个 `u16` 结果码;
- op >= 128 是服务端推送。

| 操作码 | 方向 | 说明 | 状态 |
|---|---|---|---|
| 1 | C→S | 心跳(客户端每 2 秒一次) | 已实现 |
| 2 | C→S | 进房 / 新建房间(带卡号 token 与玩家信息) | 已实现 |
| 3 / 4 / 5 | C→S | 退房 / 选曲 / 取消选曲 | 已实现 |
| 6 / 7 | C→S | 开局 / 结束 | 已实现 |
| 19 / 20 | C→S | 上报自己的对局状态 / 实时分数 | 已实现 |
| 21 / 22 | C→S | 查房间号 / 准备 | 已实现 |
| 23 / 24 / 25 | C→S | 改名牌称号场墙 / 快捷聊天 / 自由聊天 | 已实现 |
| 114 | C→S | 请求玩家头像/角色图 | **明确拒绝**(回非 0, 不然客户端一直挂着重试) |
| 129 | S→C | 房间解散(房主离开) | 已实现 |
| 130 / 131 | S→C | 有人进房 / 有人离开 | 已实现 |
| 132 / 133 | S→C | 选曲 / 取消选曲(曲目元数据原样回放) | 已实现 |
| 134 / 135 | S→C | 开局 / 结束 | 已实现 |
| 137 / 138 | S→C | 对局状态 / 实时排行榜 | 已实现 |
| 140 / 141 | S→C | 房间号下发 / 准备状态 | 已实现 |
| 143 / 144 / 145 | S→C | 名牌变更 / 对局内聊天 / 大厅消息 | 已实现 |
| 136 / 139 | S→C | 最终成绩表 / 进度 | 尚未使用(客户端会用, 服务端暂未推) |

**注意**: 客户端里那套联机逻辑是打包时混淆过的, 上面这些"语义"是从调用点
(`gameCore` / `settingsStore`(大厅) / `v_nr_27925`(选曲))倒推的, 字段布局是按
客户端读字节的顺序 1:1 对齐的(这部分是确定的)。个别操作码在官方服务器上到底还
附带什么含义(比如 136/139 什么时候推)没有把握, 需要拿真机日志再对。

## 排障

出问题时第一件事是开帧跟踪:

```bat
start-server-trace.bat
```

然后在游戏里复现一次(进房间 / 选曲 / 打完一局), 控制台会打印每一帧的操作码、
序号和长度, 以及服务端的处理结果。把这些输出发出来就能定位。

常见现象:

- **游戏里根本连不上**: 先确认客户端被指到了这个地址。游戏 bundle 里写死的是
  `http://d.umgr-serv.inonote.jp:8101`, 需要客户端补丁(见下)才能改。
- **点进房间没反应 / 大厅是空的**: 看有没有 `<- op=2`。没有就是请求没发到;
  有的话看服务端回的响应码(非 0 表示拒绝了)。
- **登录失败**: 开 `UMIGURI_NATIVE_HTTP_TRACE=1`, 确认卡号有没有打错、有没有注册。
- **启动器/自制面板报 404**: 那是它走的是旧 REST。先确认服务端地址填的是 8101(不是
  8787), 再确认服务端是含这一节的新版本(`curl -X POST http://<地址>:8101/auth/card
  -H "content-type: application/json" -d '{"cardId":"E0040000000000000000"}'` 不该是 404)。

## 让游戏连过来

补丁写在 `open-umiguri/tools/game-patches.mjs`(并**同时**手写进生成物
`open-umiguri/src/game-esm/index.js`, 两者必须一致), **只在宿主下发了
`window.__umgServer` 时才生效** —— 不下发时游戏行为与改动前逐字节一致, 仍是纯单机。

游戏里一共三个锚点:

| 锚点 | 原值 | 打补丁后 |
|---|---|---|
| `index.js` bootstrap 的 `scope.v_Xt_27648 = null` | 恒为 `null`(所以游戏里所有联机分支原本都是死代码) | `new scope.v_Bs_28013(host, port, nwToken)` |
| `v_Ls_28008.prototype.R9`(没接 AM 读卡器时的键盘读卡桩) | 挂起, 等 `Ctrl+F9`~`Ctrl+F12` 假卡 | 宿主给了卡号就直接返回那 10 个字节 |
| `scope.v_oe_27649 = new v_Hs_28017("d.umgr-serv.inonote.jp", 8101, …)` | 官方地址写死 | 换成配置地址(没配置时仍是官方地址) |

宿主侧(`open-umiguri/src/host/online/native.js`)在 `loadMain()` 之前装配:

```js
window.__umgServer = {
  host: "192.168.1.23",    // 取自启动器里填的服务端地址的主机名
  port: 8101,              // 启动器的「原生服务端端口」, 默认 8101; 留空 = 不接原生联机
  card: "E004…",           // 启动器里填的卡号
  cardBytes: Uint8Array,   // 上面那张卡转成的 10 字节(游戏读卡器的卡格式)
  nwToken: "…"             // 握手 fe, 装置号
};
```

### 桌面怎么刷卡

街机是 AM 读卡器刷卡, 桌面没有, 所以有两条路:

1. **启动器里填的卡号**(推荐): 宿主在游戏启动前把它当一次刷卡喂进去, 开箱即用;
2. **游戏自带的键盘假卡**: `Ctrl+F9`~`Ctrl+F12` 是 4 张写死的卡
   (`9000000000000100`~`9000000000000103`)。它们不符合本服务端的卡号规则
   (`E004` + 16 位数字), 想用就得先放宽 `src/store.js` 里的 `CARD_PATTERN`。

注入成功后控制台会打一行 `[umg][native] 联机服务端 <host>:<port>`; 没接上则是
`[umg][native] 未接原生联机(保持单机)`。

## 目录结构

```
src/index.js        入口: 一个端口同时提供 /1/* 、/sock 与网页面板
src/web-panel.js    把网页面板与游戏端旧 REST 挂到这个进程上(共用一个连接与一套表)
src/native-http.js  游戏原生 HTTP 协议
src/sock.js         /sock 协议与房间状态机
src/store.js        账号/卡号/档案/成绩的数据访问
src/config.js       全部可用环境变量覆盖
src/lib/wire.js     帧加解密与二进制读写(与客户端逐字节一致)
src/lib/ws.js       极简 WebSocket 服务端(零依赖)
src/lib/db.js       SQLite 建表(账号/卡与 umiguri-server 共用)
test/native-smoke.mjs  端到端自检(模拟客户端把字节原样打一遍)
```
