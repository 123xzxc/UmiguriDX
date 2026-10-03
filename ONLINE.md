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

> **2026-10 更新**: 这条路已经接上了(第七节)。宿主面板收缩成「绑定卡号 + 刷卡 +
> 状态」(见 6.2), 房间与实时分数交还给游戏自己的联机实现。

### 6.2 现在怎么做: 宿主层面板

`src/host/online/ui.js`, 打开方式 **Cmd/Ctrl+Shift+O**(或控制台
`window.umgOnline.open()`, 虚拟键盘右侧栏也有一个「联机」按钮)。

> **2026-10 收缩**: 面板只保留「进联机所需的最小动作」, 房间与战绩全部交还给游戏
> —— 游戏自己就带联机大厅与 6 位房间号输入, 面板再实现一套只会两边各记一份状态。

- 绑定卡号: 填服务端地址 + AIME 卡号(经 `/auth/card` 校验后记在本机),
  「换卡绑定」直接叫起启动器, 「登出」清 token 并撤回原生联机配置

面板与悬浮球的位置有讲究(踩过坑): 虚拟键盘面板 `panel.js` 是 `z-index:99999`、
底部整条是 `pointer-events:auto` 的按键与 AIR 条 —— 覆盖层(z-index 60000, 故意低于键盘,
这样键盘还能用来输入卡号)里落在底部那条带子上的按钮会被键盘吃掉, **点了没反应**。
所以 `mkOverlay` 把内容贴顶放、底部预留 28vh, `mkBox` 限高 64vh;
宿主自己的按钮则全部收进**可拖动悬浮球**(`keypanel/floatball.js`, z-index 100010):
球能拖出键盘带, 位置存 `localStorage`(`umg_float_ball_pos`)并贴边, 点一下才弹出按钮列,
`panel.js` 导出的 `keyboardBandTop()` 保证按钮列不会压进键盘带。
- 刷卡: 把绑定的卡交给**游戏自己的读卡器**(见 7.4), 之后的登录/云存档/房间
  都由游戏走原生协议 —— 面板不再自己调 `/rooms`、`/plays`
- 状态: 服务端地址 / 原生服务端 host:port / 游戏是否正停在读卡界面

房间(6 位数字、准备、开局)与对手实时分数是**游戏自带**的(`/sock`), 战绩也由游戏
自己写回服务端(`/1/umiguri/setRecord`, 会镜像进面板读的 `plays` 表)。

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
| `v_Ls_28008.prototype.R9`(键盘读卡桩) | 等 `Ctrl+F9`~`Ctrl+F12` | 宿主给了卡号就直接返回那 10 字节; 没给就把 resolver 挂到 `globalThis.__umgSwipe`, 供宿主的「刷卡」按钮喂卡(见 7.4) |
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

### 7.4 桌面怎么刷卡(2026-10 改)

桌面没有 AM 读卡器, 街机那块读卡器由宿主顶替; 但刷卡走的是**游戏自己的读卡器**
(`v_Ls_28008.prototype.R9`), 所以游戏内的登录、云存档、联机全都按原生协议走:

1. **自动**: 进游戏前 `installNativeServer()` 把 `cardBytes` 放好, 游戏第一次读卡就拿到
   —— 开箱即用。卡是**一次性**的(读完即清), 否则服务端连不上会「登录失败 -> 回标题 ->
   又自动刷卡」死循环, 玩家连游客模式都进不去。
2. **手动**: 游戏停在「请刷卡」时, 补丁把 resolver 挂到 `globalThis.__umgSwipe`,
   宿主 `src/host/online/native.js` 的 `swipeNow()` 就能把卡直接喂进去 —— 这就是
   「刷卡改为在游戏里完成」: 面板/启动器只**绑定**卡号, 不代替游戏登录。

- 宿主把「联机面板 / 刷卡 / 键盘显隐」都收进可拖动悬浮球; 「刷卡」只在游戏真停在读卡界面
  时可点(球底那行状态会写清楚为什么不能点);
- 面板里的「刷卡」按钮走同一条路; 登录失败或换号后可以反复重试, 不会卡在请刷卡。
- `waitingCard()` 就是「游戏是否正停在读卡界面」: 读卡时钩子在, 刷完/取消就摘掉。

游戏自带的 `Ctrl+F9`~`Ctrl+F12` 假卡仍然可用, 但那是 4 张固定卡
(`9000000000000100`~`9000000000000103`), 不符合 `E004` + 16 位数字的规则。

### 7.5 还需要真机回归的地方

- 进游戏 → 刷卡登录 → 名字/称号/名牌是否与服务端一致;
- 选曲页的联机房间: 建房 / 6 位房间号加入 / 准备 / 开局, 以及对手实时分数条;
- 悬浮球: 拖一下是否能挪出虚拟键盘带并贴边、重启后位置是否还记得;
- 「请刷卡」界面点球里「刷卡」→ 是否登录成功; 登录失败后能不能再点一次重试(不能卡死在请刷卡);
- 打完一局后 `/1/umiguri/setRecord` 是否把成绩存回服务端(换台机器能看到);
- 断线(关掉服务端)时的表现: 应该只是网络错误提示, 不能卡死进不去单机。

`umiguri-native-server` 侧开 `UMIGURI_SOCK_TRACE=1` / `UMIGURI_NATIVE_HTTP_TRACE=1`
可以把每一帧操作码与每个 HTTP 请求打出来, 是排障的第一手段。

### 7.6 「CO-OP 一点就报网络错误」的两个坑(2026-10-03 修)

**坑一: 宿主桥的 `si.sa` 是个恒返回 `null` 的桩。**

游戏侧 `modules/v_nr_27925` 的 `v_It_29787`(建房/进房入口)在连 `/sock` **之前**有一道门槛:

```js
let v_i_29999 = await scope.systemMisc.sa();
if (null === v_i_29999 || 0 !== v_i_29999.status) return ...弹 errorNetworkError...;
```

而 `si` 这一组桥桩里, 只有 `sa` 返回 `null`(`host/bridge/umgr-elc.js`), 于是判据恒命中:
**一点 CO-OP 就弹「网络错误」, `Fx()`/`Bx()` 根本不会执行**, 日志里连一条联机记录都没有 ——
看起来像「联机代码没跑」, 实际是卡在第一行。改成 `{ status: 0 }`(官方宿主的语义是「检查通过」)。

排障时 Co-op 入口现在会打一行 `[umg][coop] sa() -> status=0 (建房)` 与
`[umg][coop] 建房 -> 0 (0 成功 / -1 网络 / -2 版本 / -10 重复登录)`。

**坑二: macOS 的 WKWebView 拦掉明文 `ws://`。**

`/1/*` 的 http 早就改走宿主 Rust 桥了(见 7.2), 但 `/sock` 是 WebSocket, 走的是 WebView 自己
的 `new WebSocket("ws://<服务端>:8101/sock")` —— macOS 上同样被拦(和当初 http 一条命), 现象是
「宿主登录一切正常, 一进房间就报错」。loopback 属于 "potentially trustworthy" 不会被拦
(游戏自带的 LED 客户端连 `ws://localhost:8090` 一直是通的, 实机验证过), 所以:

- Rust 侧 `src-tauri/src/relay.rs`: 在 `127.0.0.1:0` 上开一条**纯 TCP 透传**(不解析
  WebSocket, 握手/帧/心跳端到端原样走), 由命令 `sock_relay(host, port)` 返回本地端口,
  同一目标复用同一条中继;
- 游戏侧 `v_Pa_28060.qu`: **先直连, 直连失败(4s 内没 open)才问宿主拿中继端口**再连
  `ws://127.0.0.1:<port>/sock`。Windows(WebView2)直连正常, 依然走原路, 行为不变。

日志: `[umg][coop] /sock 直连 <url>` → `直连成功` / `直连失败, 改走宿主中继 <url>` →
`中继连接成功`。服务端那边则能看到 `[umg][relay] /sock 中继 127.0.0.1:<port> -> <host>:<port>`
(宿主 stderr)。

上面这条链路修完, 7.5 的「建房 / 6 位房间号加入 / 准备 / 开局 / 对手实时分数」才算真的能跑。


### 7.7 `/sock` 帧加密的 `l` 反馈项抄错: 超过 33 字节的帧全解不开(2026-10-03 修)

**现象**: 直连/中继都通了(先看到 `[native][sock] 连接建立 …`), 紧接着服务端报
`处理 op=2 出错: RangeError [ERR_OUT_OF_RANGE]: … Received 4969`, 栈落在 `handleEnter` 的 `str()`。
注意它已经先打印出 `op=2 seq=1 载荷 152 字节` —— op/seq 是对的, 说明「帧头没错, 往后读才崩」,
也就是典型的「前 32 字节对、之后全错」。

**根因**: 客户端的 `v_ic_28200`(`helpers.js`)里, `l` 的更新是

```js
l = l + ((encrypt ? out : input)[i] + S[i]) & 255;   // 客户端原文
```

因为 `+` 比 `&` 结合得紧, 它实际等价于 `(l + b + S[i]) & 255` —— **整体取模**。而 `S` 是普通数组
(长 32), `i >= 32` 时 `S[i]` 是 `undefined` → `b + undefined` 是 `NaN` → `NaN & 255 === 0`,
于是**第 32 字节之后 `l` 恒为 0**。服务端原来写成了

```js
l = l + (((encrypt ? out : input)[i] + S[i]) & 255); // 错: 括号位置不对
```

`i < 32` 时两者低 8 位一致(`211 & l` 只看低 8 位, 所以帧头与开头几个字段照样对), 但 `i >= 32` 时
前者把 `l` 归零、后者让 `l` 保留第 31 字节的旧值, 于是**从第 34 字节(i=33)起密钥流就不一样了**。
结果是任何长度超过 33 字节的帧都解错 —— `/sock` 上除心跳外的每一个请求都远超 33 字节,
所以表现是「连得上、进不了房」。乱码里恰好读出个大长度前缀, 就是 `ERR_OUT_OF_RANGE` 的来源。

**为什么冒烟测试没抓住**: `test/native-smoke.mjs` 里那份「客户端参考实现」把同一句也抄错了,
两边互相抵消 —— 1..300 字节逐字节对照全过, 实际上测试在自证自己。现在的做法:

- 参考实现改成逐字符照抄客户端(含 `NaN` 语义), 并加一条 64 字节的硬向量
  (`input[i] = i` 的密文 hex)当锚点, 防「顺手优化」;
- 模拟客户端直接用这份参考实现收发(`clientCrypt`), 于是一整套端到端测试变成**真实互操作测试**;
- 反向验证过: 把旧写法放回去, 冒烟测试会在 `handleEnter` 报出与真机完全相同的 `ERR_OUT_OF_RANGE`。

**改动**: `umiguri-native-server/src/lib/wire.js`(一行 + 注释)、`test/native-smoke.mjs`(参考实现 + 向量),
宿主版本 2.9.3。**这条是服务端单侧的 bug, 游戏端不用改** —— 客户端一直是自洽的。

### 7.8 132 少回放一个 `w0` / 136 多写一个 `yx`: 选曲时 Out of bounds(2026-10-03 修)

**现象**: 进房一切正常, 一选曲就 `[DIAG] JS ERROR RangeError: Out of bounds access @ undefined:1`。
JS 侧的越界报错是没有字段线索的, 只能靠「服务端写的字段表 vs 客户端读的字段表」逐一对照。

**根因一(致命): 132 推送少了曲目 id。**

客户端 `iT()` 的 132 分支(`v_Vs_28021`)是: `u32 yx, u32 nx, qT(reader)`; 而 `qT()`
**从 `w0`(曲目 id)开始读**: `str w0, str lf, str C5, str y5, f64 m5, f64 S5, i32 A5, u8 难度个数`,
然后每个难度 `{ u8 0, u8 序号, str b5, str k5, str T5 }`。服务端原来是「先用 `str()` 读掉 w0 打日志,
再把剩下的原样回放」—— 少了一个字符串, 客户端读到的每个字段都整体前移, 4 个字符串读完还多读了 2 字节,
于是 `难度个数` 读成了元数据里的那个字节(它是难度序号, 通常 3/4), 循环按它继续读 -> 越读越远 ->
`Out of bounds access`。去掉的那个字节正好是 `Ag(0)`, 所以**有时**读出来是 0 就不炸 —— 这也是它看起来
「偶尔能进」的原因。修法: 132 一律**整段**回放 `$T()` 的输出(含 `w0`); 中途进房补发的那份同理。

**根因二: 136 多写了一个 `yx`。**

客户端的 136 分支(`v_Ks_28025`)严格是「跳过 1 个 u32, `cT`(u32), 行数(u32), 每行 `{nx: u32, Sr: u32}`」,
**没有局号**。服务端多写一个 u32 之后, 客户端把局号当成「行数」: 局号是跨局累加的, 只要它大于人数,
客户端就会按那个数字继续读行 -> 同样的 `Out of bounds access`。(1 人 1 局时局号恰好等于人数, 所以以前没暴露。)

**根因三: 中途进房补发的 137 少了局号。**

137(`v_Ys_28026`)是 `u32 yx, u16 n1`, 但 `handleEnter` 末尾补发那份只写了 `u16 n1` ——
第一个 `v3()` 就会越界(这条会报「二进制读取越界」)。已改成和 `pushState` 一致。

**为什么测试没抓住**: 测试里是用服务端自己的 `Writer`/`Reader` 对着服务端自己断言, 只能证明「服务端自洽」。
现在 `test/native-smoke.mjs` 里加了 `CliReader` + `writeChart`/`readChart`, 即**客户端读写器的逐行转写**
(含越界就抛 `RangeError` 的行为), 选曲/分数这些推送一律用「客户端的读法」复读一遍并断言正好读完。
反向验证过: 把 132 改回旧写法, 测试立刻在 `readChart` 抛 `Out of bounds access(客户端读越界)`。

**改动**: `umiguri-native-server/src/sock.js`(132 / 136 / 137 三处载荷), `test/native-smoke.mjs`, 宿主版本 2.9.4。
同样是服务端单侧问题, 游戏端不用改。

### 7.9 「输入房间号却进了随机房间」: 加入分支被旧房间劫持(2026-10-03 修)

**现象**: 在选曲页的「输入房间号」面板里, 6 位数字无论填什么, 确认后都会进到一个房间 ——
但那个房间号并不是填的那个(看起来像随机号); 有时连面板都不会关。

**根因**: 两段代码叠在一起才出现这个现象, 单独看每一段都「像是对的」。

1. **加入分支先被 `Gi()` 劫持。** `v_nt_29730`(输入房间号) 分支走的是
   `v_It_29787(号码)`, 而 `v_It_29787` 的第一行是
   `if (v_oe_27649.Gi()) -> 退回自己当前所在的房间`。玩家**只要先建过一次房**(或者上局没退干净),
   这个 `Gi()` 就为真: 这次「加入」会变成「回到自己那个旧房间」, 填的号码根本没被使用 ——
   玩家看到的正是「无论输什么号都进同一个房间」。
2. **号码为 0 时面板不关。** 面板回调是
   `async n => 0 !== n && v_It_29787(n)`; 6 位全 0(`000000`) 解析成 0, 短路成 `false`,
   面板于是不关闭(看着像「没反应」)。这一条是**正确**行为(0 号不存在), 保留原样。

**修法**: 加入分支进入面板前先退出当前房间 —— `v_oe_27649.Gi() && await v_oe_27649.Gx()`,
让 `v_It_29787` 一定走 `Bx(号码)`(真加入), 而不是走「回旧房」那条短路。
`Gx()` 只负责断连清态, 随后 `Bx()` -> `NC()` 会重新建连接, 不依赖旧连接。

**排查日志**(本版加了三处, 下次真机直接搜 `[umg][coop]`):

- `[umg][coop] 房间号输入面板 -> 123456 (解析 123456)` —— 面板把号码解析成了什么;
- `[umg][coop] 进房参数 wantRoom=123456` / `(无, 建房)` —— 到进房入口时的参数;
- `[umg][coop] Bx(加入房间) roomId=123456` / `[umg][coop] Fx(建房) 被调用` —— 实际走的是加入还是建房;
- `[umg][coop] tT 即将写出的房间号 = 123456` —— 真正写进 op=2 的值;
- 服务端 `[native][sock] enter: 客户端请求的房间号 wantRoom=…`:
  **`wantRoom=0` 就说明客户端根本没把号码传上来**(0 是「建房」语义), 非 0 才是真来加入这个号。

**测试**: `test/native-smoke.mjs` 里正反都钉死了 —— 号不存在(4242/60000)必须被拒绝而不是顺手新建;
用 A 的房间号加入时, 响应里的房间号必须**等于**请求号(证明没有偷偷新建随机房); 建房(0)才新建。
这块以前只断言了「B 进的是 A 的房间」, 而 A 的号恰好就是请求号, 所以掩盖了「服务端可能新建一个号」的回归。

**改动**: `open-umiguri/src/game-esm/modules/v_nr_27925/index.js`(加入分支先退房 + 诊断日志)、
`open-umiguri/src/game-esm/modules/v_X1_27914/index.js`(面板出参日志)、
`open-umiguri/src/game-esm/index.js`(`Bx`/`Fx`/`tT` 日志)、`umiguri-native-server/src/sock.js`(wantRoom 日志),
宿主版本 2.9.5。**这一版要重编桌面端**(客户端改了), 只更新服务端不够。

### 7.10 真机日志: 房间号在 `Bx` 之后变成 `undefined`(2026-10-03 续)

2.9.5 的真机日志长这样(有用的是中间两行):

```
[umg][coop] 进房参数 wantRoom=38805
[umg][coop] Bx(加入房间) roomId=38805 type=number      <- 到 Bx 时号码还是对的
[umg][coop] /sock 直连 ws://192.168.31.15:8101/sock
[umg][coop] /sock 直连成功
[umg][coop] tT 即将写出的房间号 = undefined            <- 写帧时号码没了
[umg][coop] 加入 -> 0 (0 成功)
```

**结论**: 7.9 修的「加入被旧房劫持」是对的(这次确实走了 `Bx`, 也没再进旧的随机房),
但号码在 `Bx` 到 `tT` 之间丢了。服务端把 `0/空` 当「建房」语义(`pickRoom` 的 `if (!wantRoom)`),
所以它又新建了一个随机房 —— 玩家看到的还是「加入了随机房间」。

**这一版做的事**:

1. **兜底(功能不再错)**: `NC()` 每次把归一化后的房间号放在连接对象上(`this.LC.umgWantRoom`),
   `tT()` 收到空值时回退到它。`tT` 的 `this` 就是 `NC` 里那个 `LC`, 所以这条路一定拿得到值。
   即使某条调用链漏传, 写进 `op=2` 的也不会再退化成 0。
2. **诊断(把真凶钉住)**: 新增三行日志 ——
   `NC 入口 this.zS=… type=…`、`NC 调用 tT 的房间号实参 = … (raw=… type=… IC=…)`、
   `tT 形参房间号 = … (LC.umgWantRoom=…)`。

**为什么之前看不出来**: `tT` 里有一条 `var v_e_34053 = (…, this.GT.hg(v_e_34053), …)` ——
同一个名字既是形参又被 `var` 重新声明。源码里这是「先读形参、再整体重赋值」的写法, 没问题;
但混淆后形参改名与 `var` 声明一旦不同步, `hg()` 读到的就会是**未初始化的提升变量**(`undefined`),
而 `setUint32(offset, undefined)` 会静默写 0 —— 服务端于是当成「建房」。
兜底那步绕开了这个坑(先归一化再用), 同时也让日志能区分「真没传」与「传了读不到」。

**下一步**: 这一版如果还进随机房, 请把 `[umg][coop]` 五行(`NC 入口` / `NC 调用 tT` / `tT 形参`)一起发来;
`LC.umgWantRoom` 有值而 `形参` 为空, 就坐实是混淆把这次读取改坏了, 那就要在构建侧处理;
两者都有值却还建房, 就是服务端侧(看 `[native][sock] enter: 客户端请求的房间号 wantRoom=…`)。

**改动**: `open-umiguri/src/game-esm/index.js`(NC 归一化 + LC 传递 + 三处日志, `tT` 兜底), 宿主版本 2.9.6。

### 7.11 真机日志: 头像/角色读不到 + 自己发的聊天看不到 + 跳过匹配后非房主不进歌曲(2026-10-03 补)

三个问题一起看, 都不是「缺功能」而是**协议通道用错了**。宿主版本 2.9.7。
**这一版要重编桌面端**(客户端改了), 只更新服务端不够。

#### (1) 读取不到头像/角色 —— `226` 与 `227` 是两条不同的通道

真机日志里的关键一行:

```
REJECTION 二进制读取越界: 18 > 16 @ v3@ | @ | XI@
```

客户端 `v_Ia_28059.OI` 对两个推送码的**读法完全不同**(`index.js` 4404/4422 起):

- `226`: `u32 YC` + `u8 子类型(1=SDP 2=ICE 4=冲刷 10=要资源 11=取消)` + 参数
  —— 和客户端发上来的 `op=114` 载荷**逐字节相同**;
- `227`: `u32 YC` + `u32 资源 id` + `u32 分块标志` + 数据 ——
  正是 `op=115`(`v_Ia_28059.zT` 发资源数据块)的载荷布局。

旧 `relayAvatar` 两个错:

1. 用**载荷第一个 u32(`YC` = 发送者的玩家槽位)**去判断 «是不是 offer», 但那个位置是槽位不是类型,
   于是几乎全部信令都被判成 227;
2. 把 `op=114` 原样转成 227 —— 对面 `XI` 会拿 `u8 子类型`当 `u32 id` 读、再读一个 `u32 标志`,
   帧里根本没有那 4 个字节, 直接抛「二进制读取越界」。

**修法**(服务端): `114` 一律原样转 `226`; 新增 `115 -> 227` 的中继(资源数据块)。

#### (2) 自己发的聊天自己看不到

服务端 `broadcastChat` 里有一句 `if (m === from) continue;` —— 推送时把自己跳过了,
而客户端**不做本地回显**(只把收到的 144/145 铺进聊天框), 于是自己发的自己看不到。

**修法**: 服务端连同发送者一起推(接收端按载荷里的 `nx` 自己判断是不是我发的)。
但光改服务端不够 —— 客户端 `settingsStore` 的 `$S`(可显示玩家槽)**刻意装的是对手**,
`144` 分支里 `$S.findIndex(id => id === nx)` 对自己永远落空。
所以客户端补了一支「发送者是自己」的分支: 借一个专用气泡回显,
**不动 `$S` 的槽位含义**(那三个槽对应 `playerContainer0/1/2`, 把自己塞进去会在 4 人房挤掉一个对手)。

#### (3) 跳过匹配后非房主不进歌曲界面

**两个真 bug**:

1. **`iP()` 被改坏了返回值语义**(上一版引入)。原版是:
   `return this.aP >= n || (this.nP = n, new Promise(r => this.rP = r));`
   —— 已经到位返回 `true`, 否则返回**一个 Promise**, 等 `137` 把状态推上来才 resolve。
   调用方(`settingsStore` 的 `v_g_29168`、`gameCore`)都是 `await v_oe_27649.iP(n)`。
   上一版把它改成同步返回布尔, `await` 立刻拿到 `false` 不等待, 真等状态的 `rP` 再也没人挂上
   —— 表现就是「点了开始/跳过匹配, 非房主一直停在原界面」。现已恢复原语义,
   同时保留「上报服务端」的副作用。
2. **服务端 `pushState` 在状态没变时提前 return**。客户端是「先挂 Promise, 再等 137」,
   所以「等的人已经挂上、状态又恰好等于目标值」时, 只有**再来一帧**才会醒;
   服务端因为 `next === room.state` 就不发, 等的人永久卡住。
   现在每一帧都广播(对客户端幂等); 中途进房的人也**无条件**补一帧(包括状态 0)。

**改动**: `umiguri-native-server/src/sock.js`(`relaySignaling`/`relayAssetData`、`115->227`、
`broadcastChat` 回声、`pushState` 每帧都发、进房无条件补 137),
`open-umiguri/src/game-esm/index.js`(`iP` 恢复 Promise 语义),
`open-umiguri/src/game-esm/modules/settingsStore/index.js`(自己的聊天回显),
`umiguri-native-server/test/native-smoke.mjs`(217 项, 含用客户端真实读法复核 226/227 的回归)。

### 7.12 房主点跳过/Next 之后, 其他玩家回不到选歌界面(2026-10-03 续)

上一版(7.11)修了「非房主不进歌曲」的等待语义, 但**一局打完之后**又卡住了 ——
房主在结算界面按 Next 离开, 其他人停在结算/原地, 回不到选歌界面。宿主版本 2.9.8。

#### (1) 结算界面的 Next 只推进本地状态机, 不发任何 coop 状态帧

看客户端真机路径: `0065-gameCore_x4.js` 里结算界面(`v_A_30193`)的 Next 回调只有
`menuSystem.kt("next", !0)` + `v_a_30331()`, 状态机随后走
`v_A_30193 → v_$_30194 → … → v_tt_30196`(退出对局)。而 `v_tt_30196` 里那句
`v_E_30309() && (v_oe_27649.uC(!1), audioFontHub.XS())` —— `uC(false)` 在**原版里
只清本地座位**(把 `GC` 归零、释放对手名牌), 不上报任何东西。

于是: 房主自己走到「可以开下一局了」, 服务端 `room.state` 还留着上一局的 5,
其他玩家那边既没有 137 可等、也没有任何事件让他们离开对局/结算界面。

**修法**: `uC(false)`(退出对局)时补一次 `LC.XC(1, 0)` —— 也就是 op=19 上报状态 1。
服务端收到就广播 137(状态 1), 非房主在选歌界面等的 `await v_oe_27649.Tx(1)`
(见 `0063-v_Ae_27892_x29.js` 的开始游戏)当场醒来, 一起回到选歌。

#### (2) 服务端 `pushState` 用 `Math.max` 累积状态, 状态**从来降不回去**

这是本轮真正的拦路虎。7.11 那版为了「重复上报也要回帧」把 `pushState` 改成了
`Math.max(room.state, n1)` —— 出发点是「客户端只关心进度到没到」, 但**状态是有回退的**:
一局打完回大堂/选歌, 房主上报的是 1。

被 `Math.max` 顶住之后是两个相反的坏结果同时发生:

- 非房主在选歌界面等 `Tx(1)`: 房间状态还是 5, `5 >= 1` 立刻满足 —— 看起来「没卡」,
  但他其实是在**上一局的错误时机**就放行了, 界面状态机与房主错开;
- 房主重开一局后上报 3/4/5 时, 房间状态本来就已经 >= 5, 广播出去的帧带着陈旧的高值,
  非房主游戏内那几处 `await Tx(3/4/5)` 全被瞬间放行, 该等的加载/开局步骤全跳过。

**修法**: `pushState` 按**最后一个上报者的状态**走(`room.state = n1`), 不再取最大值;
每一帧仍无条件广播(维持 7.11 的「挂上 waiter 后必须再来一帧才醒」语义)。
另外 `OP_PICK`(重新选曲)在把 `room.state` 清 0 之后立刻广播一次状态 1,
否则站在大堂等 `Tx(1)` 的人会因为「没有帧」而一直等。

#### (3) 取证日志

本轮保留了 `[umg][coop]` 系列日志, 关键几条:

- `-> 19 上报状态 N` —— 本端把什么状态发给了服务端;
- `137 收到: 房状态 sP=N (本地 137 等待值 DC=M)` —— 服务端广播回来的状态与本端在等的值;
- `137 唤醒了等 N 的人` —— 一次 137 真正 resolve 了谁;
- `退出对局 -> 上报状态 1 (离开座位 slot=N)` —— 结算 Next/退出的收尾是否上报了;
- `Tx(n) 等待/已满足`、`iP(n) 等待中/已满足` —— 谁卡在哪个状态上。

配合服务端 `UMIGURI_SOCK_TRACE=1` 的 `[native][sock] 房间 #N 状态 -> M` 一起看,
就能直接判断「是本端没上报、还是服务端没广播、还是对面没在等」。

**改动**: `open-umiguri/src/game-esm/index.js`(`uC(false)` 上报状态 1 + 诊断日志),
`umiguri-native-server/src/sock.js`(`pushState` 允许回退, `OP_PICK` 补广播状态 1),
`umiguri-native-server/test/native-smoke.mjs`(218 项: 状态回退到 1 且仍广播、重复上报仍回帧)。
**这一版要重编桌面端**(客户端改了)。

### 7.13 真机日志: `iP(1) 等待中 aP=0` —— 上报发错了通道(2026-10-03 续)

7.12 让服务端能广播状态 1 之后, 137 通了, 但人还是进不去选歌界面。真机日志给了指纹:

```
[umg][coop] iP(1) 等待中 aP=0
[umg][coop] -> 19 上报状态 1 (曲目序号 0)
[umg][coop] 137 收到: 房状态 sP=1 (本地 137 等待值 DC=-1)
```

**sP 动了, aP 没动** —— 这就是根因。

客户端有**两个独立的值**, 由两条**不同的推送码**喂:

| 值 | 谁在等 | 推送码 | 喂它的入口 |
| --- | --- | --- | --- |
| `sP` | `Tx(n)` | 137 `PUSH_STATE` | op=19 `XC`(对局状态) |
| `aP` | `iP(n)` | 141 `PUSH_ALLREADY` | op=22 `oP`(准备) |

7.11 为了让「房主推进状态时也能唤醒别人」, 在 `iP()` 里加了一句 `this.LC.XC(n, 0)` ——
那是 **op=19**, 只会喂 `sP`。而 `iP` 等的是 `aP`, 所以:

- `tP(1)`(op=22)虽然也发了, 但它发在 `iP(1)` **之前**, 那帧 141 到达时还没有 waiter, 白丢;
- `iP(1)` 挂上 Promise 之后, 唯一的上报是 op=19, 回的 137 只碰 `sP`;
- `aP` 永远是 0 → `iP(1)` 的 Promise 永不 resolve → `v_g_29168` 停在
  `await scope.v_oe_27649.iP(scope.v_pa_28050)` 那句, 大堂收尾动画和 `qS` 回调都不执行。

表现就是「拿着房号进来的人站在大堂不动, 进不了选歌界面」。

**修法**:

1. `open-umiguri/src/game-esm/index.js` —— `iP()` 里的上报改成 **`this.LC.oP(n)`(op=22)**,
   也就是 `tP()` 走的那条通道。这样服务端回 141, `iT` 的 `v_Qs_28030` 分支写 `aP`,
   `iP` 的 Promise 才能 resolve。守卫也统一成 `this.Gi() && this.LC && …`。
2. `umiguri-native-server/src/sock.js` —— `OP_READY` 回的改成**房间整体的就绪值**
   (`room.ready = Math.max(room.ready, n)`), 而不是发起者这次写的那个数字:
   否则房主先 `oP(1)`、晚进的人再收到别人(或补发)的低值, `iP(1)` 对不上。
   每次上报仍回一帧(客户端是「挂上 Promise, 再收一帧才醒」)。
3. 进房时除了 137 **再补一帧 141**, 让中途进房 / 重连的人也能立刻唤醒 `iP(1)`。

**日志对照**: `iP(n) 等待中 aP=N -> 发 22(ready)` 是新加的, 一眼能看出这次上报走对了通道;
配合 `137 收到: 房状态 sP=N` 就能同时看到两条通道各自的值。

**改动**: `open-umiguri/src/game-esm/index.js`(`iP` 改走 op=22),
`umiguri-native-server/src/sock.js`(`OP_READY` 回整体就绪值、进房补 141),
`umiguri-native-server/test/native-smoke.mjs`(225 项: 新增一整段 141 通道回归 ——
回帧给发起者与其他人、重复上报也回帧、不被单次 0 拉低、进房必补一帧)。
**这一版要重编桌面端**, 服务端也要一起更新。

### 7.14 真机日志续: 141 那一支在客户端**根本不存在**(2026-10-03 续)

7.13 把 `iP()` 的上报改走 op=22 之后, 客户端日志变成了:

```
[umg][coop] iP(1) 等待中 aP=0 -> 发 22(ready)
```

上报确实发出去了(服务端 trace 能看到两帧 op=22), 但 `iP(1)` **还是没醒**。原因很直接:

**`v_Hs_28017.iT` 里没有 141(`v_Qs_28030`)的分支。**

这个函数是 `/sock` 推送的总入口, 结构是一长串
`if (码 === 129) … else if (码 === 130) … else if (码 === 137) … else { … }`。
服务端发的 141 到了这里, 匹配不到任何分支, **落进最后的 `else` 被静默丢弃**:

- `this.aP` 永远是 0;
- `iP(n)` 里 `aP >= n` 不成立 → 挂上 `rP` 等;
- 后续服务端再发多少帧 141 都一样, 没人处理;
- `v_g_29168` 停在 `await iP(1)` 那句, 大堂收尾动画和 `qS` 回调都不执行。

表现就是「拿着房号进来的人站在大堂不动, 进不了选歌界面」。

有意思的是**原版(未混淆)的 `0134-ExpressionStatement.js` 里这一支是有的**:

```js
else if (v_i_33880 === v_Qs_28030) this.aP = v_e_33881.n1,
  this.nP === v_e_33881.n1 && this.rP && (this.rP(!0), this.rP = void 0);
```

是 esm 版在改写 / 拆分的过程中漏掉了这一条 —— 属于「实现缺失」而不是「协议理解错」。
(同时它也就解释了 7.13 里为什么会去猜通道: 因为 `aP` 这条链在客户端本来就是断的。)

**修法**:

1. `open-umiguri/src/game-esm/index.js` —— 在 `v_Hs_28017.iT` 的 137 分支后面补回 141 分支,
   并把 `aP` / `rP` 的写入带上日志(`141 收到: 准备 aP=…`、`141 唤醒了等 N 的 iP`)。
2. `umiguri-native-server/test/native-smoke.mjs` —— 新增**客户端分支完整性静态回归**:
   从源码里切出 `v_Hs_28017.iT` 的函数体, 逐条断言每个推送码都有分支
   (130/132/134/135/136/137/138/141/143/226/227), 并单独断言 141 必须写 `this.aP`、
   必须唤醒 `this.rP`。以后任何一条分支再被漏掉, 这个用例会直接报出来。
   (144 对局内聊天不在这层, 由 gameCore 的 `v_Gi_30328` 处理, 已在用例里标注。)
3. `umiguri-native-server/src/sock.js` —— `push()` 补一条出站 trace
   (`-> op=… 载荷 N 字节`)。以前只有入站 trace, 排障时「收包有、发包没有」和
   「根本没发」是两种完全不同的故障, 靠猜很费时间。

**改动**: `open-umiguri/src/game-esm/index.js`(补 141 分支 + 日志),
`umiguri-native-server/src/sock.js`(出站 trace),
`umiguri-native-server/test/native-smoke.mjs`(239 项)。
**这一版要重编桌面端。**

### 7.15 141 通了但还是进不去 + 2.9.11

7.14 之后真机日志变成了:

```
[umg][coop] 网络层收到 141 准备状态 n=1
[umg][coop] 141 收到: 准备 aP=1 (本地 iP 等待值 nP=-1)
```

`aP` 确实写进去了, 而且 `nP=-1` 说明 **141 比 `iP(1)` 先到** —— 那按代码 `iP` 应该直接
返回 `!0` 才对。所以卡点已经不在 141 这条链上了, 需要把「进房到进选歌」中间每一步
都变成可观测的, 而不是继续推理。

一个真实的可疑点:`ix`(房内玩家表, 大厅界面按它渲染、`v_g_29168` 用 `ix.size` 判空)
**唯一**的填充处是 130 分支里的 `this.ix.set(...)`。而 137/141 都不碰 `ix`。
如果自己那份 130 没到(或到了但 `nx` 对不上), 表现就是:

- 大堂里自己那一格是空的;
- `ix.size` 为 0 → 走 `copClosedModeByNoGuests` 那条路;
- 选歌界面进不去。

**这一版只加观测, 不改行为**(行为改动等日志确认真凶再上):

1. `iP()` —— 先上报再判一次 `aP`: 若「上报之后」`aP` 已达标, 直接返回 `!0` 不挂 Promise。
   原版就有这层(`return this.aP >= n || (…Promise…)`), 只是 7.13 改成显式上报时
   顺序反了, 会白挂一次等待。现在的日志把两种情况分开:
   - `iP(1) 上报后 aP=1 已满足, 不挂等待`
   - `iP(1) 挂等待 aP=0 (nP=1), 等 141 >= 1`
2. 130 分支 —— 打印 `130 进房 nx=… (自己=…) ix.size=…`, 直接看得到谁进了表。
3. 131 分支 —— 打印 `131 离开 nx=… ix.size=…`。
4. `umiguri-native-server/src/sock.js` 的 `enter` —— trace 里补一行房间成员清单
   (`房间 #N 成员 K 人: user#a(名), … | 已向 user#x 补发 K 条 130(含自己)`)。
   客户端 `ix` 和服务端 `room.members` 两边一比就知道是不是「服务端没发」还是
   「发了但客户端没认」。

**改动**: `open-umiguri/src/game-esm/index.js`, `umiguri-native-server/src/sock.js`。
**这一版要重编桌面端**, 服务端也该一起更新(不然拿不到那条成员 trace)。

排障时请把这三行贴回来(`UMIGURI_SOCK_TRACE=1` 起服务端):

```
[umg][coop] 130 进房 nx=… (自己=…) ix.size=…
[umg][coop] iP(1) 上报后 … / iP(1) 挂等待 …
[native][sock] 房间 #N 成员 K 人: …
```

### 7.16 141 已通、iP 已被唤醒, 但还是不进选歌 + 2.9.12

7.15 的观测点一上, 真机日志立刻给出了关键信息:

```
[umg][coop] 130 进房 nx=1 (自己=2) ix.size=1
[umg][coop] 130 进房 nx=2 (自己=2) ix.size=2          <- 自己(2)也在 ix 里
[umg][coop] 137 收到: 房状态 sP=0 (本地 137 等待值 DC=-1)
[umg][coop] 141 收到: 准备 aP=0 (本地 iP 等待值 nP=-1)
...
[umg][coop] 130 进房 nx=2 (自己=1) ix.size=2
[umg][coop] iP(1) 挂等待 aP=0 (nP=1), 等 141 >= 1     <- 先挂等待
[umg][coop] 141 收到: 准备 aP=1 (本地 iP 等待值 nP=1)
[umg][coop] 141 唤醒了等 1 的 iP                      <- 确实唤醒了
```

两条结论:

1. **141 这条链完全正常** —— `iP(1)` 挂上等待、141 回来、`rP` 被唤醒, 一步不差。
   之前怀疑的「141 没到 / 分支缺失 / 等待值对不上」全部排除。
2. `ix` 是**对的**: 自己和对手都在里面, `nx` 也没串。
   所以 `v_g_29168` 里 `ix.size = 0` 那条分支也不会走。

那卡点只可能在 `v_g_29168` **唤醒之后**的那几段里 —— 尤其是这两个 `if` 的弹窗分支,
它们会「弹个 2 秒提示 + 直接退回菜单」, 表现和「进不去选歌」一模一样:

- `ix.size >= (tx ? 3 : 4)` → `copClosedInviteByMemberLimit`(人数已满)
- `!tx` → `copClosedInviteByHost`(房主已关闭邀请)
- 以及 `ix.size` 为 0 → `copClosedModeByNoGuests`
- 还有「等所有非自己成员都连上」那个 30ms 空转循环

**这一版继续只加观测**(这些分支是否真被走到, 目前全是推测, 不再猜):

1. `v_g_29168` 入口 —— `g29168 收尾 kind=… 房主tx=… ix.size=… 自己=… Gi=…`;
2. 三个弹窗分支各自一行(`走「人数已满」弹窗` / `走「房主已关闭邀请」弹窗` / `走「房里没人」分支`);
3. 空转循环 —— 打印到底在等哪个成员的连接就绪;
4. 收尾真跑完 —— `g29168 收尾完成, 回调 qS(…)`。

+ 上一版保留的 `130 进房` / `iP 挂等待` / `iP 上报后已满足` 三行。

下一次日志按这四条对号入座即可定位:

- 没有 `g29168` 那一行 → 压根没走到收尾(上游 `sa/uC` 没触发);
- 有「走「房主已关闭邀请」弹窗」→ 客户端把自己当成非房主(`tx=false`), 那是 `Bx` 加入路径的问题;
- 有「等待成员」刷屏 → 对手连接一直没就绪;
- 有「收尾完成, 回调 qS(0)」但界面不动 → 问题已经离开联机层, 去看选歌界面自己。

**改动**: `open-umiguri/src/game-esm/modules/settingsStore/index.js`。**要重编桌面端。**

### 7.17 真凶: 房主点开始只广播**一次** 137, 非房主没赶上就永久卡住 + 2.9.13

用户明确了一下场景: **房主点开始后, 别人进不去**(不是房主自己退房那条路)。

顺着这条链看, 已经排除的:

- 141 正常(7.16 日志里 `141 唤醒了等 1 的 iP` 出现了);
- `ix` 正常(自己与对手都在, `nx` 没串);
- 服务端 op=19 -> `pushState` **无条件**广播 137 给所有成员, 单看这一段没问题。

于是只剩一种可能: **那一帧 137 到的时候, 非房主还没挂上 waiter。**

客户端的等待语义是「先挂 waiter, 再收一帧 137 才醒」(见 `v_Hs_28017.Tx`), 而房主按
「开始」只发 **一次** op=19 —— 广播也就只有一帧。非房主此刻若正在切界面/刚进房/
还在处理上一帧, 这一帧就被永久错过, 之后不会再有任何 137 把他唤醒。

**修法(服务端为主, 客户端补一道兜底):**

1. `umiguri-native-server/src/sock.js` —— 新增 `ensureStateReplay(room)`:
   房间状态进入非 0 之后, 每 500ms 重播一次当前 137, 直到状态回到 0 或房间清空。
   重播是幂等的(客户端 `sP >= n` 时直接返回, 不会重复入座), 因此比「只发一次」
   健壮得多。房间解散/状态归零时用 `clearStateReplay` 停掉定时器。
2. `open-umiguri/src/game-esm/index.js` —— `Tx(n)` 补「挂等待前回读一次 sP」:
   设完 `DC` 后若 `sP` 已达标就直接返回, 不挂 Promise。
3. `iP(n)` 同样处理(7.15 已加, 这次整理掉了排查用的临时日志)。

**回归用例**: `umiguri-native-server/test/native-smoke.mjs` 新增「没再上报时服务端也会
重播状态」一项 —— 242 项全过。

**改动**: `umiguri-native-server/src/sock.js`(状态重播),
`open-umiguri/src/game-esm/index.js`(Tx/iP 回读兜底),
`umiguri-native-server/test/native-smoke.mjs`。**这一版客户端与服务端都要一起更新。**
### 7.18 开局只广播状态 1 -> 非房主永久卡在 1; 外加触摸键/卡号历史/刷卡不再循环 + 2.9.15

这一版四个改动, 前三个是用户点名的产品需求, 第四个是顺着 7.17 之后真机日志继续追出来的。

#### (1) 开局状态推进: `op=6` 也要推 137

7.17 修掉了「只广播一次, 没赶上就永久卡住」, 但真机日志显示非房主侧仍然无限刷:

```
[DIAG] [umg][coop] 137 收到: 房状态 sP=1 (本地 137 等待值 DC=-1)
```

`sP` **一直是 1**, 说明房间状态从没被推到 2。追下来是房主侧的上报分布问题:

- 房主点「开始」在 `modules/v_nr_27925/index.js` 里只做 `xx(true, te)` = `XC(1, te)`,
  即 op=19 状态 **1**; 之后 `await Tx(1)` 本地立刻满足, 进入曲目准备;
- 2/3/4/5 这几档只有 `Lx()` 会上报(`modules/gameCore/index.js`), 而它们都带
  `v_E_30309()`(`Y1.Rx` 非 0, 即「自己是房主且在对局中」)这类守卫;
- 于是**开局这条路上, 服务端唯一能看到的房主动作只有 op=19 状态 1**。
  非房主进对局等的是 `Tx(3)` 那一档, 拿到的却永远是 1。

**修法**: `umiguri-native-server/src/sock.js` 的 `case OP_START`(op=6) 在发完 134
(`PUSH_PLAY`) 之后补一档 `pushState(room, member, 2)` —— 把房间从 1 推出来,
并触发 7.17 的 500ms 重播链路。2 是安全中间档: 134 已经发出去, 客户端据此进歌曲界面;
而 `room.state < 2` 的守卫保证重复收到 op=6 时不会把状态往回压。

**回归用例**: `native-smoke.mjs` 新增 4 项(把状态压回 1 -> 发 op=6 -> 断言 137 >= 2),
**246 项全过**。

#### (2) PC 版默认隐藏左上角那列触摸按键

`host/keypanel/panel.js` 的 `navBox`(Test/Service/FN + 「联机」)在桌面端默认隐藏:
PC 玩家有键盘, 那列触摸键会挡住画面左上角。移动端(Android/iOS)仍常显。

- 新键 `umg_nav_visible`(`"1"`/`"0"`)记用户选择, 用户显式选择优先于平台默认;
- 导出 `isNavVisible()` / `setNavVisible(on)`, 启动器里有对应的开关按钮;
- `applyNavMode()` 现在同时看 `navHidden`(进测试界面临时收起)与用户/平台意愿,
  「联机」按钮用 `colVisible` 单独跟随整列显示。

#### (3) 卡号历史: 开始的时候可以直接挑一张

`host/online/session.js` 新增 `LS_CARD_HISTORY = "umg_online_card_history"`,
存 `[{ card, base, name, ts }]`(同卡去重、按时间倒序、上限 12 条), 配套
`cardHistory()` / `rememberCard()` / `forgetCard()`。启动器(`host/keypanel/launcher.js`)
在卡号输入框下面列出历史: 点一条即填入, `×` 删掉。绑定成功与「静默放行」两条路径都会
`rememberCard()`。

#### (4) 刷完卡/结算回主菜单不再自动循环进刷卡界面

游戏主菜单会反复探卡(`v_D_27646.R9()`), 以前只要 `window.__umgServer.cardBytes` 在,
就一直供卡 —— 每次回主菜单都被拉进登录/刷卡画面。现在改成**一次性令牌**:

- 宿主侧 `host/online/native.js` 增加 `armCardSwipe()` / `installArmHook()`,
  挂上 `window.__umgArmCardSwipe`(一次性: `swipeArmed <= 0` 返回 false);
  `swipeNow()`(点「刷卡」按钮)才 `armCardSwipe()`;
- 游戏侧 `R9()` 在装了 hook 时: 未 armed 直接返回「读卡器上没卡」, 不再供卡;
- `modules/v_G1_27905/index.js` 的探卡循环里, 未 armed 时静默回主界面,
  而不是被当成「读到卡了」去登录。没装 hook 时(直连环境)行为保持不变。

**验证**: `node tools/verify-online-bundle.mjs` 新增两条断言(宿主桥里的
`umg_online_card_history` 与 `umg_nav_visible`), 加上产物里的 `__umgArmCardSwipe`,
共 19 项全过; `build/check.mjs` 三项产物检查通过。

**改动**: `open-umiguri/src/host/keypanel/{panel,launcher}.js`、
`open-umiguri/src/host/online/{session,native}.js`、
`open-umiguri/src/game-esm/index.js`、`open-umiguri/src/game-esm/modules/v_G1_27905/index.js`、
`umiguri-native-server/src/sock.js`、`umiguri-native-server/test/native-smoke.mjs`、
`open-umiguri/tools/verify-online-bundle.mjs`。

**这一版客户端与服务端都要一起更新**(服务端改了 op=6 的状态推进)。
### 7.19 主界面死循环: R9 未 armed 返回了 undefined + 2.9.16

7.18 把 `R9()` 改成「一刷一次」之后, 真机出现**主界面死循环**: 主菜单反复重绘, 日志里
每 ~1.0s 一次 `[umg][lp] 读不到: "textures\\txDummyChara_0.dds"` 一直刷。

根因是返回值语义没对齐。主菜单 `modules/v_N1_27904/index.js` 的 `v_c_28776()` 长这样:

```js
let v_t_28780 = await scope.v_D_27646.R9();
v_t_28780 !== scope.v_Ts_28004 && (... scope.v_N1_27904.T0(v_t_28780) ...);
```

`v_Ts_28004 = 1` 是「读卡超时 / 读卡器上没卡」的语义值。7.18 让未 armed 时返回
`undefined`, 而 `undefined !== 1` 成立, 于是:

`R9() 返回 undefined` -> `v_c_28776` 继续 -> `T0()` -> 第 60 行又调 `v_c_28776()` ->
再探卡 -> 无限递归。表现就是主界面反复重绘、占位贴图日志每秒刷一次。

**修法**: 未 armed 时返回 `v_Ts_28004`(而不是 `undefined`) —— 主菜单判定为「没读到卡」,
停在原地等玩家主动点「刷卡」; `v_k_28809` 探卡循环里那条多余的 `void 0 === ...` 分支
也随之删掉(上面那行 `=== v_Ts_28004` 已经 return)。

**注意**: `tools/game-patches.mjs` 的 `NATIVE_SWIPE_BODY` 是 `src/game-esm/` 的**生成源**
(modularize 之前作用于 AST 的补丁), 这次两处**同时**改了 —— 否则下次重新 modularize
会把修复冲掉。

**改动**: `open-umiguri/tools/game-patches.mjs`、`open-umiguri/src/game-esm/index.js`、
`open-umiguri/src/game-esm/modules/v_G1_27905/index.js`。**只需更新客户端。**
### 7.20 点了「刷卡」卡死在主菜单: armed 是「消费一次」+ 自愈补卡走了 armed 的 R9 + 2.9.17

7.19 修完死循环后, 真机出现新的卡死: 点「刷卡」后日志只有

```
[umg][card] 本次没读到卡, 尝试从宿主补一张
[umg][card] 宿主也没有可用卡, 保持当前状态(不登出/不降级游客)
```

然后就停在主菜单不动了。两处问题叠在一起:

**(a) armed 做成「消费一次」太窄。** 主菜单 `v_N1_27904.v_c_28776()` 总会先探一次卡,
把结果传给 `v_G1_27905.v_k_28809()`; 登录流程内部(`v_p_28808` 的自愈补卡、`v_k_28809`
的探卡循环)还会**再探一次**。旧的「返回 true 就 `swipeArmed -= 1`」语义下, 第一次探卡
就把令牌吃掉, 第二次探卡拿到「没卡」, 于是 `v_p_28808` 判定失败直接 `return` ——
界面停在中间态(卡死)。

**修法**: 改成**时间窗**(`host/online/native.js`, `SWIPE_ARM_MS = 8000`): 点一次「刷卡」
后 8 秒内所有 `R9()` 探卡都供卡。既覆盖同一轮里的多次探卡, 又不会长期供卡(窗一过自动
失效, 不会回到「自动进刷卡画面」的循环)。

**(b) `v_p_28808` 的自愈补卡走了 armed 的 `R9()`。** 它是 `await scope.v_D_27646.R9()`,
在没 armed 时只会拿到 `v_Ts_28004`, 等于补了个空。改成**直接读常驻的
`window.__umgServer.cardBytes`**(10 字节直接喂 `Py`, 否则回退到 `card` 卡号字符串) ——
这张卡是宿主长期持有的绑定卡, 与 armed 无关。

**注意**: `tools/game-patches.mjs` 的 `NATIVE_SWIPE_BODY` 是 `src/game-esm/` 的生成源,
两处语义要保持一致。

**改动**: `open-umiguri/src/host/online/native.js`(时间窗)、
`open-umiguri/src/game-esm/modules/v_G1_27905/index.js`(自愈补卡直接读 cardBytes)、
`open-umiguri/tools/game-patches.mjs`(注释同步)。**只需更新客户端。**
### 7.21 「玩家2回不到主菜单」: 结算回退没上报 + 服务端没清选曲 + 2.9.18

7.18～7.20 修的是「进不去对局」, 这条是反方向: 一局打完, 房主回大堂了, 玩家 2 却卡在
结算/对局界面回不到主菜单。两个原因:

**(a) 客户端 `uC(false)` 的回退上报被 `GC` 门槛挡住。**
`open-umiguri/src/game-esm/index.js` 的 `uC`(进入/退出对局)里, 退出分支写的是

```js
if (v_t_33867) this.GC = this.Px;
else if (this.GC) { ... this.LC.XC(scope.v_ha_28044, 0); }
```

`this.GC` 是座位槽: 房主结算离开时它可能已经是 0(从没入座/上一轮已清), 于是这条
「回退到状态 1」的上报**永远不发**, 服务端 `room.state` 停在 5, 玩家 2 收不到 137,
没有任何理由自己走回选歌/主菜单。改成退出分支**无条件上报一次 1**(有座位就顺手清掉)。

**(b) 服务端回退时没清 `selection`。**
`umiguri-native-server/src/sock.js` 的 `pushState` 现在在「状态从 >= 2 掉回 1」时
把上一局的 `room.selection` 清掉并广播 **133**(`PUSH_UNPICK`, 载荷 `{yx, u16 0}`,
与 `OP_UNPICK` 同一格式)。否则服务端还留着上一局的选曲, 下一局/中途进房的人会立刻
收到 `PICK`(132)补发, 两边状态机错开。

**回归用例**: `native-smoke.mjs` 新增「状态回退到 1 时清选曲并广播 133」,
**250 项全过**。

**改动**: `open-umiguri/src/game-esm/index.js`、`umiguri-native-server/src/sock.js`、
`umiguri-native-server/test/native-smoke.mjs`。**客户端与服务端都要更新。**

### 7.22 PUSH_JOIN(130) 字段宽度全错(u16 -> u32): 大厅 rating/等级乱掉 + 2.9.19

这条是**纯服务端**的编解码 bug, 客户端一字未改。

`umiguri-native-server/src/sock.js` 的 `Member.writeJoin`(拼 130 载荷)原来写的是:

```js
w.u32(userId).str(name).u16(rating).u16(level).u16(titleRarity)
 .str(titleText).str(nameplateText).u16(nameplateRarity).str(fieldWallText);
```

但客户端 `open-umiguri/src/game-esm/index.js` 的 `iT` 里 `v_js_28019`(=130)分支读的是:

```js
nx = v3()   // u32
om = Ic()   // str
lm = v3()   // u32  rating
CC = v3()   // u32  等级
lx = v3()   // u32  称号稀有度
ox = Ic(), TC = Ic()
MC = v3()   // u32  名牌稀有度
RC = Ic()
```

也就是 **四个数值字段客户端全按 u32 读**, 服务端却按 u16 写。整条帧从第一个 u16 起
就错位 2 字节:

- `rating` 实际读到的是「rating 的 u16 + 等级的 u16」拼成的 u32(`1000|0x0007<<16` 这种);
- `level` / `lx` / `MC` 依次读到相邻的字节, 全是垃圾;
- 末尾还会多出 4 个字节, 客户端读到 `str` 时把后面帧的数据当字符串读 —— 这就是真机
  日志里那个 `RangeError: Out of bounds access @ getUint32` 的来源;
- 大厅里别人的 rating/等级显示错乱, 房内状态机跟着错位, 表现为「进不去选歌界面」。

**修法**: `writeJoin` 的四个数值字段改成 `u32()`, 并在注释里把客户端的读法逐字列出。

**回归用例**: `native-smoke.mjs` 的 130 断言同步改成 `u32`, 并加一条
`eq(joinSelf.remaining, 0, ...)` —— 只要两边宽度不一致(多写或少写一个字节), 这条就会
红。**251 项全过**。

另外本轮还修了服务端排障日志本身的一个错:`OP_NAMES` 表把 1/2/3 写反了
(`1:"ENTER",2:"LEAVE",3:"PING"`), 于是 `UMIGURI_SOCK_TRACE=1` 打出来的 op 名字全是错的,
把「客户端每 2 秒一次的心跳」显示成「反复进房」, 差点把排查带偏。正确映射是
`1:"PING", 2:"ENTER", 3:"LEAVE"`(与文件顶部 `OP_PING/OP_ENTER/OP_LEAVE` 常量一致)。

**改动**: `umiguri-native-server/src/sock.js`、`umiguri-native-server/test/native-smoke.mjs`。
**只需更新服务端(客户端不用重编译)。**

### 7.23 给二进制读串(Ic)加越界检查: 坏帧报可读错误 + 2.9.20

接 7.22。用户反馈「进房间会卡死」, 复查日志后确认**当时跑的还是没重启的旧服务端**
(宿主版本 2.9.17), 加入房间成功后立刻:

```
JS ERROR RangeError: Length out of range of buffer @ undefined:1
```

这正是 7.22 那个 130 帧宽度错位的下游症状。重跑新版服务端即可。

**但这次顺手补了一处排障可观测性缺陷**(不改任何正常路径行为):
客户端 `Reader.Ic()` 原来把 `(offset, len)` 直接交给 `Uint8Array` 构造函数,
`len` 越界时抛的是引擎内部的 `RangeError`, **既没有偏移量也没有字段名**;
而且它**不会**触发 `v3()/o3()` 里那套用 `this.kg` 维护的越界检查(两者口径不同),
于是这种「帧内字段宽度对不上」的错只能看到一个光秃秃的 RangeError。

改成先判后读, 抛 `字符串读取越界: 偏移 X 长度 Y > 缓冲 Z`。
以后再遇到同类问题, 日志里直接就能定位到是哪一帧第几个字段错位。

**改动**: `open-umiguri/src/game-esm/index.js`(仅 `Ic`)。**需重新编译客户端。**
