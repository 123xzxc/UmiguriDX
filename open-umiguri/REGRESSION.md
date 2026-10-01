# 回归验证清单

> 本工程做了三类**会触碰行为**的改动: 语义重命名(绑定)、property 字段改名、vendor 上游替换。
> 静态校验已通过(`npm run check`), 但**必须真机/桌面回归**。本文给出命令、清单与二分定位方法。

## 0. 构建

```bash
cd open-umiguri
npm install                # 首次
npm run deobf              # 从 ../game_main.original.js 生成可用反混淆源(修正版)
npm run build              # assets 打包 + 宿主 + 游戏(全部产物在 dist/)
npm run check              # 语法 + 契约 + 自由变量检查
```

> 资源:`assets/` 是解密态(入库),`npm run build:assets` 生成 `dist/game_data/`(加密态)。
> 若 `assets/` 缺失,先 `npm run import:assets` 从仓库根 `../assets` 解密导入。
> 桌面运行读 `dist/game_data`(`UMIGURI_ASSETS_DIR`/`UMIGURI_DATA_DIR` 可覆盖)。

## 1. 桌面运行

```bash
cd src-tauri
cargo tauri dev            # 先执行 npm run build(assets + host + game)
```

- 数据目录: 只读资源默认 `dist/game_data`(`UMIGURI_ASSETS_DIR` 可覆盖),
  可写层默认 `dist/userdata`(`UMIGURI_DATA_DIR` 可覆盖, 读取时优先)。
- 入口 `dist/www/index.html` 加载 `tauri-bridge.js` 后解密 `main.js.enc` 并执行游戏。

## 2. Android 运行

参考仓库根 `PROJECT_INFO.md` 的 Android 章节(noCompress / ignoreAssetsPattern / 清中间产物)。
`src-tauri/tauri.android.conf.json` 的 resources 指向 `../dist/game_data/`。
首次需要 `cargo tauri android init` 生成 `gen/android`。

## 3. 回归清单

| # | 场景 | 验证点 | 关联改动 |
|---|---|---|---|
| 1 | 启动 | 进入标题/主界面,无黑屏、无 `ReferenceError`/`DataView` 越界 | 全部(绑定+字段改名) |
| 2 | 语言 | 切换 ja-JP / zh-CN / en-US,文案正常 | `languagePackages`、`currentLang` 等 |
| 3 | 输入 | 物理键盘 + 触摸面板都能打击;`Esc+Enter` 开测试菜单 | `inputModule`、`kbd*Fn`、`__umgLanes` |
| 4 | 测试菜单 | 各页切换、光标、`elementByIndex/elementByName`、`visible` | `.yk/.ot/.lt/.Be` |
| 5 | UI 布局 | RSB 元素位置/尺寸正确(白 UI、信息板、菜单) | `.Te/.Qt/.Le/.G0` → `x/y/w/h` |
| 6 | 3D/背景 | 选曲背景 GLB 正常加载(无相机为空/`GLTFLoader` 报错) | GLTFLoader 上游替换 |
| 7 | 贴图 | DDS/DXT 正常显示(桌面 S3TC;iOS 软解) | THREE 上游替换 |
| 8 | 存档 | 选曲/成绩写入后重启仍在(`records.krtbl`/`player.krtbl`) | `recordsStore`/`settingsStore` |
| 9 | 语言包 | 归档模式读取 `.una` 正常(无「数据修复模式」) | `languagePackages`、`hostBridge` |
| 10 | 合作/课程 | 大厅、课程规则正常 | `coopLobby`、`chartParser`、`gameCore` |

> 重点观察 #6/#8/#10:property 改名最可能影响**序列化字段**与**数据表键**。

> **资源名分隔符约定(踩过坑)**: 游戏侧的资源名来自 RSB/归档表的字符串池, 用的是**反斜杠**
> (`textures\txLogoMono.dds`、`fonts\NtkwGothicDB16.rgf`), 而宿主侧(bundle/目录预取缓存键、
> Rust `paths::collapse_vpath`、归档条目名)一律用 `/`。任何「按虚拟路径读文件」的新入口都
> 必须先把 `\` 归一化成 `/`(见 `src/host/core/protocol.js` 的 `normKey`), 否则预取缓存全部
> 失效, 且 macOS(WKWebView)上编码出 `%5C` 的 URL 会**静默** fetch 失败 —— 表现就是启动
> 画面资源读不到、卡在黑屏。

> **归档/松散模式判定(又一个坑)**: `languagePackages` 用 `/reverie/_VERSION` 的探测结果
> 决定「从 `.una` 归档读」还是「读散文件」—— 官方 Web 版资源是散文件, 该路径可读; 打包版
> 把它封进 `.una`, 该路径 404。我们的宿主会把归档内部条目也映射成 `umg://` 路径, 打包态
> 下 `/reverie/_VERSION` 因而返回 200, 被误判成「松散模式」-> 按 `/reverie/<文件>` 去找,
> 而真实内容在 `hiiragi.una` 里 -> 字体(`fonts/Debug.rgf`、`fonts/NtkwGothic*.rgf`)与
> 字符串表(`tables/stringTable.rvs`)全部读不到 -> **界面能渲染但一个字都没有**。
> 现在改为直接尝试打开基础包(`/una/hiiragi.una`)来判定, 不要再引入依赖「某路径是否 404」
> 来区分打包/松散的分支。

> **RGF 字形表纹理段偏移(第三个坑)**: `A3` 解析 `fonts/*.rgf` 时, 纹理项结构里的 `L3` 是该
> 纹理**数据段在文件内的起始偏移**, `E3` 是数据长度(实测所有字体条目都满足 `L3 + E3 ==
> 文件长度`)。旧代码读出了 `L3` 却从未使用, 直接 `I3(E3)` 取数据 —— 而 `I3` 是「从当前
> 位置前进 n 字节并返回该段」, 此时游标停在纹理表末尾(约偏移 110), 于是取到的是**字形表
> 中段**而不是纹理, 解压必然抛异常, 被调用方(`d5` 的 `Id` 循环 / `h5`)吞成「表解析失败」。
> 表现同样是**界面一个字都没有**, 但日志形态不同: 归档判定那个坑是「资源读不到」
> (`A3(null)`), 这个是「读到了但解析失败」(`Id 表解析失败` 且既非「坏数据」也非「空」)。
> 已修为在 `I3` 之前先 `y3(L3 - 当前位置)` 定位; 并给纹理阶段和整个 `A3` 各兜一层
> `try/catch`, 失败时打印阶段/序号/格式/尺寸。
> 校验方法: 解包 `dist/game_data/core/una/hiiragi.una`, 从 `L3` 起读 `E3` 字节应为 zlib 流
> (`78 9C`), `zlib.inflateSync` 后长度恰好等于 `k_ * b_`(如 `NtkwGothicDB48`
> 4096x4096 = 16777216, `TwiColEmj` DXT5 1024x1024 = 1048576)。

## 4. 二分定位(定位是哪类改动引入问题)

`tools/split-game.mjs` 支持逐类关闭:

```bash
# 只做拆分, 不改名/不替换(等价原始 bundle)
GAME_SRC=../../game_main.deobf.js node tools/split-game.mjs --no-rename
node build/bundle-game.mjs

# 只绑定改名, 不改字段
node tools/split-game.mjs --no-props
node build/bundle-game.mjs

# 只绑定+字段改名, 不换上游库
node tools/split-game.mjs --no-upstream
node build/bundle-game.mjs
```

按「原始 → 绑定改名 → +字段改名 → +上游替换」四档依次构建/运行, 即可定位问题档位。
定位到字段改名时, 再从 `tools/prop-symbols.json` 逐个回退字段(重跑 split-game + build)。

## 5. 已知风险点(优先回归)

1. JSON 序列化不会在源码留下字符串字面量 → 安全门槛无法完全识别, 存档字段可能有漏判。
2. vendor 上游替换: 已做 API 面/字符串集合校验, 但未做运行时验证(THREE 若曾被定制会暴露)。
3. 游戏内部 `yk(序号)` 索引与 RSB 元素结构未改动;但若改名影响元素字段顺序解析, 会在 #4/#5 暴露。
