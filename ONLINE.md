# UMIGURI 联机功能设计说明

分支 `feature/online`。本文件记录联机功能的现状、设计与落地计划。

## 一、重要前提: 游戏内联机功能的真实状态

游戏**有完整的联机房间 UI 资源, 但实现代码缺失**。这是本次开发最重要的前提,
先讲清楚, 避免后续误判工作量。

### 1.1 已存在的资源(可直接复用)

| 资源 | 内容 |
| --- | --- |
| `ui/openCoop.rsb` + `openCoop.js.js` | **房间号输入界面**: 6 位数字输入 |
| `ui/coopLobby.rsb` + `coopLobby.js.js` | **房间内大厅**: 玩家位、聊天气泡 |
| `ui/nameEntry.rsb` | 用户名输入键盘 |
| `tables/coopChatTable.krtbl` | 聊天表(`chatId`/`styleId`/`sceneFlag0~4`/`label`) |
| `tables/nameEntryTable.krtbl` | 名字输入字符表 |
| `sounds/ui/CoopLobbyBgm.mp3` | 大厅 BGM |
| `textures/txOpenCoop.dds` | 联机入口图标 |
| `textures/txMusicSelectCoop.dds` | 联机选曲标记 |

`openCoop` 关键控件(来自 `openCoop.js.js`):

- `inputDigit0`~`inputDigit5` —— **6 位房间号输入框**
- `numRoom0`~`numRoom9` + `numRoomA` —— 数字纹理(本次只用 0-9)
- `captionJoin` / `captionLobby` —— 加入 / 大厅标题
- `lobbyMessage0`~`lobbyMessage2` —— 大厅提示文案
- `playerBox` / `playerBoxEmpty` —— **4 个玩家位**

`coopLobby` 关键控件:

- `txChatBalloon` / `balloon0`~`balloon7` —— **8 个聊天气泡**
- `txDummyChara_2` / `txLoadingCircle`

### 1.2 缺失的部分

在 `src/game-esm/index.js`(游戏前端)中, 以下标识符**零引用**:

`openCoop`、`containerJoinCoop`、`coopChatTable`、`inputDigit*`、
`CoopLobbyBgm`、`txOpenCoop`、`txMusicSelectCoop`

`src/game-esm/modules/coopLobby/index.js`(251 行)**只有用户名输入逻辑**:
编辑 8 字符以内的名字, 结果写入 `scope.handshake.rm.om`。其中没有任何房间号、
聊天、玩家位或网络收发代码。

**结论**: 资源与 UI 定义完整保留, 但联机的**实现代码在反混淆/模块化过程中未被恢复**。
因此本功能的客户端部分不是"接上去", 而是"补回来"。

### 1.3 宿主当前能力

`src-tauri` 目前**没有任何网络层**:

- 唯一的网络命令是 `fetch_text`(`ureq` GET, 12 秒超时, 仅支持 GET, 返回字符串)
- 没有 WebSocket, 没有 POST

由于本次选定 **HTTP 轮询**方案, 需要在宿主补一个支持 POST + JSON 的命令
(见第四节)。

## 二、房间号规则

**6 位纯数字**, 校验正则 `^[0-9]{6}$`。

依据: `openCoop` 只有 `inputDigit0`~`inputDigit5` 六个输入位。
纹理中虽存在 `numRoomA`, 但按需求**仅使用 0-9**, `A` 暂不使用。

## 三、服务端

见 `umiguri-server/README.md`。要点:

- Node 内置模块实现, **零第三方依赖**
- SQLite 存储(`node:sqlite`), 单文件部署
- 账号: scrypt 口令哈希 + HS256 JWT
- 资料: `displayName`(8 字符上限, 与游戏一致) / `nameplate` / `title`
- 记录: 每局上报 + 个人最佳 + 总榜/单曲榜
- 房间: 创建/加入/准备/选曲/开局, 上限 4 人
- **实时分数**: `POST /rooms/:code/progress` + `GET /rooms/:code/state?since=`

已验证: `node test/smoke.mjs` 共 32 项断言全部通过。

## 四、客户端接入计划

### 阶段一: 账号 / 存档 / 用户名与称号

1. 宿主新增 `fetch_json` 命令(POST + JSON + Authorization 头),
   复用现有 `ureq` 依赖, 支持超时与错误返回
2. 新增 `src/game-esm/modules/account/index.js`:
   - 登录 / 注册界面
   - token 本地持久化
   - 启动时拉取 `/profile` 并写入 `handshake`
3. 用户名与称号接到现有链路:
   - 用户名沿用 `coopLobby` 的输入结果(`handshake.rm.om`), 改为提交到 `PATCH /profile`
   - 称号牌 / 称号用 `nameplates`(8 个)与 `titles`(3 个)索引
4. 对局结束调 `POST /plays` 上报

### 阶段二: 房间联机 + 实时对手分数

1. 补回 `openCoop` 场景: 房间号输入(6 位数字)→ 创建/加入房间
2. 补回 `coopLobby` 房间态: 玩家位列表(4)、准备状态、房主选曲、聊天收发
3. 实时分数:
   - 对局中定时 `POST /rooms/:code/progress` 上报自己的分数与进度
   - 定时 `GET /rooms/:code/state?since=<version>` 拉对手分数, 渲染到对手分数条
   - 收到 `{unchanged: true}` 时跳过重绘

### 每一步都要注意

游戏前端是**混淆打包**的, 新增模块必须走 `scope` 注入, 且要在
`--obfuscate` 构建后**反解 `dist/www/main.js.enc` 验证**。
此前 `A3` 的形参被同名局部变量遮蔽, 就是混淆后行为与源码不一致导致的
macOS 无文字问题, 详见 `open-umiguri/REGRESSION.md`。

## 五、当前进度

- [x] 服务端项目(资料/记录/排行榜/房间/实时分数)
- [x] 宿主 `fetch_json` 命令(ureq + `online` 桥)
- [x] 客户端 account 模块(卡号登录/资料/房间/实时分数, 已注册进 `index.js`)
- [x] 用户名与称号接入(`applyProfileToHandshake` 写 `handshake.rm.om`)
- [x] **认证改型: 全程无密码** —— 游戏端卡号登录, 面板 TOTP
- [x] 服务端卡号体系(`cards` 表 + 发卡/吊销 + 反查)
- [x] 网页面板 `/panel`(单文件 HTML, TOTP 登录, 发卡/改资料/看记录)
- [x] 管理接口(`/admin/*`, Bearer 管理员令牌, 建号 + TOTP 重置)
- [x] 宿主启动器(`keypanel/launcher.js`, 游戏加载前输卡号登录)
- [x] 服务端冒烟测试(77 项断言, 覆盖卡号/TOTP/面板/管理面板/房间全链路)
- [x] 管理面板 `/admin-panel`(网页建号/重置验证器/发卡/吊销, 令牌换会话 cookie)
- [x] 面板挂到原生服务端上 —— 一个进程(8101)同时提供游戏协议与 `/panel`、`/admin-panel`
- [ ] 自助注册面板(**刻意不做** —— 谁能自助申请 TOTP 密钥, 谁就能接管任意用户名)
- [x] 对局上报接入(游玩桥 `__umgPlay` 暴露 `musicId`, play -> result 时上报 `/plays`)
- [x] 游戏内房间入口 —— 宿主层联机面板, 取代丢失的 `openCoop`
- [x] 房间态与实时对手分数 —— 面板内 1s 轮询房间快照 + 上报自己的分数
- [x] 游戏内换号/登出 —— 面板里可直接叫起启动器
- [x] 游戏原生联机路径(`scope.v_Xt_27648`)—— 新服务端 `umiguri-native-server` 实现了
      `/1/*` HTTP 与 `/sock` 二进制协议, 客户端由宿主注入 `window.__umgServer` 打开(见第七节)

### 认证模型速查

| 入口 | 凭据 | 落地位置 |
| --- | --- | --- |
| 游戏端 | AIME 卡号(20 位, `E004` 开头) | `POST /auth/card` -> JWT |
| 网页面板 | 用户名 + TOTP | `POST /panel/login` -> HttpOnly cookie |
| 管理(接口) | Bearer 管理员令牌 | `/admin/*` (`POST /admin/users` 等) |
| 管理(网页) | 管理员令牌换会话 cookie | `/admin-panel/login` -> HttpOnly cookie |

不开放自助注册: 账号由管理员建, TOTP 密钥随建号返回(`otpauthUrl`)。
游戏端启动器写在 `localStorage.umg_online_token`, 游戏内 account 模块读它恢复会话。
## 六、游戏内联机面板(宿主层)

### 6.1 为什么不接游戏自己的 openCoop

把全库搜了一遍: 联机客户端实例 `scope.v_Xt_27648` 只有 `= null` 一处赋值
(`src/game-esm/index.js` 的 bootstrap), 之后再没有任何地方写它。而游戏里所有
联机分支都是 `if (v_Xt_27648 ...)` 开头:

| 位置 | 分支 |
| --- | --- |
| `modules/v_G1_27905` | 登录/建档流程(刷卡 -> 拉资料) |
| `modules/v_nr_27925` | 选曲确认后进入联机对局(`handshake.Bm.Fm > 2`) |
| `modules/audioFontHub` | 对手名字(读 `v_oe_27649.ix` 玩家表) |

因此这份产物里游戏自身的联机路径**永远不会被走到**, 也不会去连
`d.umgr-serv.inonote.jp:8101`(所以现在跑起来没有网络报错)。

> **2026-10 更新**: 这条路已经接上了(第七节)。下面这套宿主面板仍然保留 ——
> 它是纯 HTTP 轮询、不依赖混淆产物的内部结构, 当作备用入口与排障工具。

### 6.2 现在怎么做: 宿主层面板

`src/host/online/ui.js`, 打开方式 **Cmd/Ctrl+Shift+O**(或控制台
`window.umgOnline.open()`):

- 账号: 显示名/用户名/服务端地址; 「换卡登录」直接叫起启动器, 「登出」清 token
- 房间: 创建 / 加入(6 位数字) / 准备 / 开始 / 离开, 玩家列表带每人分数
- 实时分数: 对局中每 1s 把 `{score, progress}` 上报 `/rooms/:code/progress`,
  同时轮询 `/rooms/:code/state?since=` 拿对手分数(命中 `unchanged` 就跳过重绘)
- 对局上报: `play -> result` 那一刻上报 `/plays`(曲目 id 由游玩桥新暴露的
  `__umgPlay.state.musicId` 提供)

登录态/地址集中放在 `src/host/online/session.js`(`setBase` / `setSession`),
启动器与面板共用, 免得两处各写一遍。

注意: 面板里换号后, 服务端 displayName 会立刻写进 `__umgForceProfile` 与
`umgr_elc._.rm.om`, 但游戏的名牌板是**启动时读一次**, 所以名字要重启才刷新。

## 七、游戏原生联机路径(已接上)

### 7.1 服务端: `umiguri-native-server`

游戏本体从来不是连我们的 REST 接口, 而是连 `d.umgr-serv.inonote.jp:8101` 那套协议。
`umiguri-native-server` 就是按**游戏本来就在说的协议**回答它, 零第三方依赖
(`node:sqlite`), 端口 8101, 与 `umiguri-server` **共用同一个 `data/umiguri.db`** ——
网页面板发的卡, 游戏里直接就能刷。细节见 `umiguri-native-server/README.md`。

| | umiguri-server | umiguri-native-server |
|---|---|---|
| 面向 | 网页面板 / 宿主联机面板 | 游戏本体 + 网页面板 |
| 协议 | 自家 REST(JSON + JWT) | `POST /1/*`(JSON) + `GET /sock`(加密二进制 WS) |
| 端口 | 8787 | **8101**(游戏里写死的) |
| 面板 | `/panel`, `/admin-panel` | **同样挂在这上面**(见 7.1.1) |
| 游戏端旧 REST | `/auth/card`、`/rooms` 等 | **同样挂在这上面**(见 7.1.2) |

#### 7.1.1 面板也挂在原生服务端上(2026-10 补)

面板原先只在 `umiguri-server`(8787), 于是"想开面板就得再跑一个进程"。现在把
`routes/index.js` 拆成 `registerGameRoutes` / `registerPanelRoutes` 两半,
原生服务端用 `buildPanelRouter()` 把面板挂到自己的 HTTP 循环上(`src/web-panel.js`),
**一个进程、一个端口**同时给游戏和网页用。

三处必须一起做对, 否则会踩坑:

- **共用一个数据库连接**: 同一个进程里对同一个库开两个写连接会互相卡死(SQLite 的
  `busy_timeout` 只在跨进程时有用), 所以用 `attachDb()` 把原生服务端的连接交给
  umiguri-server 那套模块, 再由 `migrateSchema()` 补上面板用的表(幂等)。
- **只挂自己那批路径**: 原生服务端先处理 `/1/*` 与 `/sock`, 未命中才轮到面板, 所以
  面板不可能挡住游戏。
- **面板要有数据**: 面板读 `plays`/`bests`, 原生成绩写在 `native_records`, 所以
  `setRecord` 时顺手镜像一份(`rankLabelOf()` 按客户端 `scope.rankLabel` 的阈值定级,
  `clear` 取 `flags` 第 0 位), 否则面板永远是"暂无记录"。

管理员令牌统一放在 `umiguri-server/data/admin-token`(两个服务端共用), 环境变量
`UMIGURI_ADMIN_TOKEN` 优先于该文件。

#### 7.1.2 游戏端旧 REST 也挂上来(2026-10 补)

面板挂上去之后还剩一个坑: **启动器**走的是 `umiguri-server` 那套 REST
(`/auth/card`、`/auth/whoami`、`/profile`、`/plays`、`/rooms`…), 而原生服务端只认
`/1/*` 与 `/sock`。玩家要是把启动器里的服务端地址填成 8101, 就会每个请求都 **404**
(现象就是"连不上新服务端")。

所以 `routes/index.js` 再加一个 `buildRestRouter()`(只含 `registerGameRoutes`),
由 `src/web-panel.js` 按 **面板 -> 旧 REST** 的顺序挂在同一个端口后面: 两边都用
`passthrough: true`, 谁都没命中才落到原生服务端的 `{result:"bad"}` 404。

两套响应格式不同(旧 REST 是 `{ok:true,...}`, 原生是 `{result:"ok",...}`), 所以只并存
不合并 —— 各自的客户端按各自的约定解析。JWT 密钥走 `umiguri-server/src/config.js`
的 `UMIGURI_JWT_SECRET`, 默认值仅供本地开发。

### 7.2 客户端: 三个锚点

补丁在 `open-umiguri/tools/game-patches.mjs`, 并且**手写进了生成物**
`open-umiguri/src/game-esm/index.js`(改补丁时必须两边一致, 跑
`node tools/verify-online-bundle.mjs` 会在混淆产物里复查)。

| 锚点 | 原值 | 打补丁后 |
| --- | --- | --- |
| bootstrap 的 `scope.v_Xt_27648 = null` | 恒 `null` | `new scope.v_Bs_28013(host, port, nwToken)` |
| `v_Ls_28008.prototype.R9`(键盘读卡桩) | 等 `Ctrl+F9`~`Ctrl+F12` | 宿主给了卡号就直接返回那 10 字节 |
| `new scope.v_Hs_28017("d.umgr-serv.inonote.jp", 8101, …)` | 官方地址 | 配置地址(未配置时仍是官方地址) |

三者都只在宿主下发了 `window.__umgServer` 时才生效, 否则游戏行为与改动前一致。

### 7.3 宿主: `window.__umgServer`

`open-umiguri/src/host/online/native.js` 在 `loadMain()` 之前装配(游戏 bootstrap
就会读它):

```js
window.__umgServer = {
  host: "192.168.1.23",    // 启动器里填的服务端地址的主机名
  port: 8101,              // 启动器的「原生服务端端口」, 留空 = 不接原生联机
  card: "E004…",           // 启动器里填的卡号
  cardBytes: Uint8Array,   // 卡号转成的 10 字节(游戏读卡器的卡格式)
  nwToken: "…"             // 握手 fe, 装置号
};
```

桌面没有 AM 读卡器, 所以用启动器里那张卡号当一次刷卡 —— 这就是「无密码, 有卡号就行」
在桌面端的落地方式。游戏自带的 `Ctrl+F9`~`Ctrl+F12` 假卡仍然可用, 但那是 4 张固定卡
(`9000000000000100`~`9000000000000103`), 不符合 `E004` + 16 位数字的规则。

### 7.4 还需要真机回归的地方

- 进游戏 → 刷卡登录 → 名字/称号/名牌是否与服务端一致;
- 选曲页的联机房间: 建房 / 6 位房间号加入 / 准备 / 开局, 以及对手实时分数条;
- 打完一局后 `/1/umiguri/setRecord` 是否把成绩存回服务端(换台机器能看到);
- 断线(关掉服务端)时的表现: 应该只是网络错误提示, 不能卡死进不去单机。

`umiguri-native-server` 侧开 `UMIGURI_SOCK_TRACE=1` / `UMIGURI_NATIVE_HTTP_TRACE=1`
可以把每一帧操作码与每个 HTTP 请求打出来, 是排障的第一手段。
