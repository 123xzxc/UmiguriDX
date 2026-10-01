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
- [x] 服务端冒烟测试(53 项断言, 覆盖卡号/TOTP/面板/房间全链路)
- [ ] 对局上报接入
- [ ] `openCoop` 房间入口
- [ ] `coopLobby` 房间态与实时对手分数
- [ ] 游戏内卡号输入界面(现在只有启动器, 游戏中无法换号)

### 认证模型速查

| 入口 | 凭据 | 落地位置 |
| --- | --- | --- |
| 游戏端 | AIME 卡号(20 位, `E004` 开头) | `POST /auth/card` -> JWT |
| 网页面板 | 用户名 + TOTP | `POST /panel/login` -> HttpOnly cookie |
| 管理 | Bearer 管理员令牌 | `/admin/*` |

不开放自助注册: 账号由管理员建, TOTP 密钥随建号返回(`otpauthUrl`)。
游戏端启动器写在 `localStorage.umg_online_token`, 游戏内 account 模块读它恢复会话。
