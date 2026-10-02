# open-umiguri

UMIGURI(inonote PC 音游)的反混淆重构工程: **宿主层(Tauri 2)模块化源码 + 游戏本体模块化源码 + 可复现构建链路**。

- 宿主层: Electron/原生桥 → Tauri 2(Rust 后端 + Web 前端桥),按职责拆成标准 ES 模块。
- 游戏本体: 由 `game_main.deobf.js` 拆分为 `vendor/`(第三方库)与 `logic/`(游戏逻辑片段),
  拼接顺序由 `manifest.json` 控制。
- 构建: `npm run build` 产出可注入的 `dist/www/tauri-bridge.js` 与加密包 `dist/www/main.js.enc`。

> 反混淆原则见仓库根目录 `js.md`。本工程遵循「不改变行为」优先。

## 目录

```
open-umiguri/
├── assets/                 解密/解包态资源(入库;构建时自动打包加密)
│   ├── core/una/*.una/     .una 归档解包后的目录
│   ├── data/**/data.arc/   data.arc 解包后的目录
│   └── core/{sounds,textures,config}, data/*, terms/, license.xml
├── build/
│   ├── pack-assets.mjs      assets/ -> dist/game_data(打包加密)
│   ├── bundle-host.mjs      宿主层打包(esbuild -> IIFE)
│   ├── assemble-game.mjs    按 manifest 拼接游戏源码
│   ├── bundle-game.mjs      拼接 + esbuild 压缩 + AES 加密
│   ├── encrypt.mjs          AES-256-CBC(与 desktop/encrypt.js 兼容)
│   ├── freevar-check.mjs    反混淆断裂检查
│   └── check.mjs            产物 node --check
├── tools/
│   ├── deobfuscate-fixed.mjs 修正版反混淆器(生成可运行源码)
│   ├── split-game.mjs        从 bundle 拆出 vendor/ 与 logic/(逐字节校验)
│   ├── analyze-bundle.mjs    闭包耦合分析
│   ├── analyze-props.mjs     对象字段使用分析
│   ├── import-assets.mjs     ../assets(仓库根) -> assets/(解密)
│   ├── umg.cjs               归档/AES 读写工具(pack/unpack/list/roundtrip)
│   └── symbols.json / prop-symbols.json / vendor-overrides.json
├── src/host/               宿主层 ES 模块
├── src/game/               游戏本体源码(vendor/ + vendor-upstream/ + logic/)
└── src-tauri/              Rust 后端(模块化) + tauri 配置
```

## 资源(assets)策略

仓库里**只存解密/解包形态**,运行时所需加密包在构建时自动生成:

| 形态 | 位置 | 说明 |
|---|---|---|
| 解密源 | `open-umiguri/assets/` | `.una`/`data.arc` 已解包为目录;`data`/`sounds`/`textures`/`terms`/`license.xml` 明文 |
| 运行时态 | `dist/game_data/`(不入库) | `npm run build:assets` 把目录重新打包加密为 `.una`(P2=2)/`data.arc`(P2=1) |
| 游戏脚本 | `dist/www/main.js.enc`(不入库) | 由 `src/game/**` 拼接压缩后 AES 加密 |

- 首次导入(从仓库根的上游资源解密):`npm run import:assets`。
- 打包:`npm run build`(含 assets + host + game)。
- 桌面读取分两层(避免构建清掉存档):
  - 只读资源 `dist/game_data`(构建产物,`UMIGURI_ASSETS_DIR` 可覆盖);
  - 可写层 `dist/userdata`(存档/配置,`UMIGURI_DATA_DIR` 可覆盖),读取时优先于只读层。
- Android 按 `src-tauri/tauri.android.conf.json` 打进 APK `assets/game_data/`;
  可写层用 Documents/UMIGURI(见 `android.rs`)。
- 校验:`node tools/umg.cjs roundtrip <archive> --p2 N` 可验证打包/解包可逆;
  实测 `.una` 重打包与原始**逐字节一致**,`data.arc` 条目名一致、解压数据相等。


## 宿主层模块

| 模块 | 职责 |
|---|---|
| `core/invoke.js` | Tauri `invoke` 封装 |
| `core/protocol.js` | 虚拟路径 → `umg://`;Image/XHR/fetch/iframe 拦截;整文件缓存 |
| `core/encoding.js` | base64 ⇄ Uint8Array/string |
| `core/diag.js` | `[DIAG]` 日志、错误捕获、GL 扩展探测 |
| `input/vk.js` | 字符/`code` → VK 映射(纯函数) |
| `input/lanes.js` | 档位直连 `window.__umgLanes`、触摸状态 |
| `input/keyboard.js` | 物理键盘、DIK→VK、`di8KbdHeld` |
| `input/hit.js` | 圆形范围命中检测 |
| `input/touch.js` | 指针输入、功能键长按重复 |
| `input/pad.js` | 测试菜单白色 UI 触摸区 |
| `keypanel/config.js` | 面板参数默认值与持久化 |
| `keypanel/panel.js` | 虚拟按键面板 DOM |
| `keypanel/editor.js` | 可视化编辑器 + 参考圆 + 命中高亮 |
| `keypanel/api.js` | `window.umgKeyPanel` |
| `bridge/handshake.js` | 握手数据 |
| `bridge/umgr-elc.js` | `window.umgr_elc`(游戏 → 宿主) |
| `bridge/native-input.js` | `kbd*` / `di8Kbd*` / 串口桩 |
| `platform/gestures.js` | 禁缩放/滑动 |
| `platform/textures-dxt.js` | DXT 软解(iOS 缺 S3TC 时) |
| `platform/compression-stream.js` | Compression/DecompressionStream 兜底(WebKit < 16.4 缺该 API, 否则归档解压失败 -> 启动黑屏) |
| `platform/storage-access.js` | 「所有文件访问」权限 UI |
| `platform/window-drag.js` | 拖动暂停 RAF |
| `loader/decrypt-loader.js` | 解密并执行 `main.js.enc` |

## Rust 后端模块

| 文件 | 职责 |
|---|---|
| `lib.rs` | 应用入口、窗口、`umg://` 协议注册、命令表 |
| `paths.rs` | 数据根、`PATH_MAP`、虚拟路径归一化、磁盘→APK→归档解析 |
| `fs.rs` | `fs_list/fs_file/fs_size/fs_read/fs_write/debug_probe` |
| `bundle.rs` | 子树批量读取(`fs_bundle_tree`)与子树签名(曲库缓存失效判断) |
| `archive.rs` | 归档: 解包目录按需合成字节(dev) + 打包态 `.una/.arc` **文件**内条目读取(release/Android) |
| `protocol.rs` | URI 解析、MIME 推断 |
| `handshake.rs` | `handshake` / `diag` |
| `android.rs` | Android 数据根、APK Asset 只读、权限、重启 |
| `hardware/*` | 手台与灯光: `serial.rs`(串口 + 协议识别)、`protocol.rs`(chu2board 0xB0/0xAF/0xB1/0xB2)、`affine.rs`(Affine_IO / 官方滑块板帧协议)、`mapping.rs`(档位↔灯光映射)、`led_server.rs`(UMIGURI LED WebSocket 服务端) |

## 手台(串口控制器)与灯光

两种固件都支持,连接时逐个端口自动识别(先 chu2board 握手,再 Affine 探测):

| 协议 | 手台 | 识别方式 |
|---|---|---|
| `chu2board` | chu2board 固件: 单字节命令(0xB0 握手 / 0xAF 问 API / 0xB1 读输入 / 0xB2 灯光),主机轮询 | API 版本(0x11)与握手都有响应 |
| `affine` | Affine_IO 手台([QHPaeek/Affine_IO](https://github.com/QHPaeek/Affine_IO)): 官方滑块板帧协议 `FF cmd nbytes payload chk`(0xFD 转义),主机发一次 `AUTO_SCAN_START` 后设备主动推「32 压力 + 1 天键位图」。实机帧长 **38 字节**(`FF 01 21 <32 压力> <天键> <x> <y>`,末尾两字节的算法还没对上 —— `x` 像漏算了 cmd,`y` 恒为 0),所以收侧**只按结构收帧**,不拿校验和当门槛 | 开扫描后 8s 窗口内收到 `AUTO_SCAN`(0x01)或 `AUTO_AIR`(0x05)帧(每秒补发一次扫描命令, 慢启动的设备也能等到) |

`/config/game.json` 里的可选配置(全在顶层 `hardware` 段,不写则自动):

```json
"hardware": {
  "autoConnect": true,
  "port": "/dev/cu.usbmodem103",
  "protocol": "auto",
  "ledOrder": "brg"
}
```

- `autoConnect`: 启动时自动探测并连接(桌面与 **Android** 默认开;iOS 没有串口/USB Host 通道,默认关)。
- Android 走 **USB Host + bulkTransfer**(不是 `/dev/*` 串口):插上 OTG 后系统弹「允许访问该 USB 设备」,
  勾「一律允许」即可;`AndroidManifest.xml` 由 `npm run android:perms` 补上 `android.hardware.usb.host`
  (缺它系统不会弹框,`openDevice()` 直接返回 null)。协议解析与桌面共用 `affine.rs`,不重复实现。
- `port`: 固定串口名(Windows `COM3`、macOS `/dev/cu.usbmodem*`、Android `usb:vid:pid#deviceId`);留空则遍历自动探测。
- `protocol`: `auto`(默认)/ `chu2board` / `affine`,探测不到时可强制指定。
- `ledOrder`: 灯光字节序 `rgb|bgr|grb|brg|gbr|rbg`(默认 `brg`,即 3 字节按 设备 B,R,G 解释)。

行为:

- 输入不走键位映射:Rust 端把 38 个档位(32 触摸 + 6 air)直接写进 `window.__umgLanes`,有变化才通知。
- **力度(压力值)只用来判断「这一格按没按下」**(`touch[i] > 0`),不参与游戏逻辑:38 个档位是 0/1
  的开关量,UMIGURI 与街机版一样只认「按下/松开」。所以「灯和按键都认、力度没反应」是**正常**的 ——
  设备推的那 32 个字节是触摸判定的原始读数,不是给游戏用的力度值。
- 灯光:游戏自带 `ledOutput` 连 `ws://localhost:<led_controller.port>`(默认 8090),
  宿主把 SetLED 载荷转成手台灯光帧;Affine 手台还额外驱动整条 AIR(侧)灯(自定义命令 0x07)。
- 帧格式与官方参考实现一致(segatools `board/slider-frame.c`),帧内的 `0xFF`/`0xFD` 按规范转义;
  但**收侧不硬校验校验和**(Affine 的参考宿主收侧也不校验):结构对就收,校验和结果只记在
  `Frame::checksum_ok` 里当参考 —— 实测手台那两字节的算法和官方发送侧不一致,硬校验会
  「明明每 100ms 都在推帧却一帧都不认」,报成「未收到 Affine 扫描帧」。
- 识别出的天键(0x05 `AUTO_AIR` 帧)与 `AUTO_SCAN` 里的天键位图都会算进 AIR 档位(两者可能是分开的两帧)。
- **设备要收到一帧灯光才会推帧**(顺序不能换):实测打开端口后什么都不发听 20 秒是 0 字节,
  发开扫描是 0 字节, 手指按在触摸条上也是 0 字节 —— **直到发出第一帧灯光才开始持续推帧**。
  所以探测的第一步就是点灯(AIR 灯 + 32 格白灯), 之后每秒补发一次, 再发开扫描。
  只发开扫描的宿主永远等不到帧, 这就是「必须先手工跑一遍 `mac-hw-probe.py` 才连得上」的真正原因
  (那个脚本后面恰好会发灯光帧); 也是玩家说的「灯亮了才可以连接手台」。
- **连上就点灯**:连接成功后宿主立刻发一次全白灯光帧(Affine:`SET_AIR_LED` + 32 格 `SET_LED`;
  chu2board:`0xB2` + 96 字节),因为**手台灯亮 = 固件跑完初始化、真的在听命令**。早期只有游戏的
  `ledOutput` 推 SetLED 时才点灯,于是「连上」和「灯亮」互相等,看着就像没连上。
- 自动连接会重试:前 6 次每 2s,接着 6 次每 5s,之后每 60s,直到连上或用户手动断开 —— 手台比游戏晚插/晚就绪也能自己连上。
- 排查:日志里 `[umg][hw] 手台已连接: <端口> (<协议>)`;`window.umgHardware.status()` 可查当前协议。
  连接失败时是 `[umg][hw] 未连接手台(第 N 次尝试): 试过 X 个串口, 都不像手台 —— <端口>: <原因> | …`,
  也就是会把**每个**串口的结论都列出来, 免得排在最后的蓝牙口把有用信息顶掉。
  结论里还带**串口上实际收到的原始字节**(如 `轮询轮: 一个字节都没收到; 开扫描轮: FF 01 20 …`),
  据此能分清「设备没说话」(线/驱动/固件)和「说话了但协议不对」(命令/解码)。
- 探测窗口 **8 秒**(旧版 1.2 秒太短:设备上电后往往要好几秒才开口,每轮都被提前放弃,表现就是
  「必须先手工跑一遍 `mac-hw-probe.py` 才连得上」)。窗口里每 1 秒补发一次开扫描。
  等满还失败时会直接打一行结论,`[umg][hw] Affine 探测: …`:「N 秒内一个字节都没收到」= 线/驱动/供电;
  「收到 N 个字节,但没拆出完整帧」= 波特率或噪声;「拆出了帧,但没有 AUTO_SCAN」= 协议/固件版本不对。

### macOS 上连不上时(macOS 最容易踩的几个坑)

1. **先看系统认没认出手台**: 插上后 `ls /dev/cu.*` 应该多出一个 `/dev/cu.usbmodem*` 或
   `/dev/cu.usbserial-*`。只有一个 `Bluetooth-Incoming-Port` 就说明问题在系统/硬件这一侧:
   线是纯充电线、USB 口/集线器供电不足, 或者缺这颗 USB 串口芯片的驱动
   (CH34x / CP210x / FTDI 在 macOS 上可能要自己装)。这种情况宿主怎么改都没用。
   手台在 USB 里的名字是 `Linnea ...`、`idVendor = 0xAFF1`(`0x52A4` 旧版 / `0x52A7` C 版),
   `system_profiler SPUSBDataType` 或「系统信息 → USB」里能直接看到 —— 看不到就是没认出来。
2. **macOS 上 `tty.*` 与 `cu.*` 是同一个口的两个名字**: 宿主只留 `cu.*` —— `tty.*`
   在载波(DCD)为低时会卡住打开/读取, 是「Windows 能连、macOS 连不上」的常见原因。
   `hardware.port` 也请写 `/dev/cu.*`。
3. **DTR**: 手台固件要 DTR 拉高才开始推帧(Affine 的参考实现 `serialslider.c` 里就有一句
   `EscapeCommFunction(SETDTR)`)。Windows 那边不显式设也常常是拉高的, macOS/Linux 打开串口
   默认不拉 —— 所以宿主在非 Windows 平台上打开串口后会主动拉 DTR。
4. **不放心自动探测就手动指定**(`/config/game.json` 的 `hardware` 段):
   `"port": "/dev/cu.usbmodem103"`, 需要的话再加 `"protocol": "affine"`。
5. **先用脚本分清是哪一层**: `open-umiguri/tools/mac-hw-probe.py`(只用 Python 标准库,
   几十秒出结果)。它会依次打印: 系统枚举到的串口、**USB 设备树**(手台到底在不在总线上、
   VID/PID/序列号对得上吗)、**AppleUSBCDCACMData 把哪个 `/dev/cu.*` 挂在哪个 USB 设备上**、
   内核日志里跟 USB 串口有关的报错; 然后对每个候选口: 静听 → 发 `AUTO_AIR_START` +
   `AUTO_SCAN_START` → **提示你用一根手指在手台上左右来回划 12 秒**并统计收到的字节
(收到就顺手按协议拆帧) → 发一帧灯光(顺便看灯带变不变色) → 关掉重开再听一遍。据此分清:
   - USB 树里没有手台 / 候选口选错了 → 系统这一层就没认出来(线、口、集线器、驱动);
   - 树里有, 但出现 `!! 读失败 EIO(...)` → macOS 自带 CDC 驱动这一层收不了数据;
   - 树里有、读口干净、摸着手台也不发 → 设备侧不发数据: 把同一台手台插到 Windows 机器上
     用 Affine_IO Releases 里的 `chuni_test.exe` 对照, 就能确定是手台本身还是 macOS 兼容性。
   用法 `python3 tools/mac-hw-probe.py`(自动挑 usbmodem/usbserial 口, 也可以直接把端口名传进去)。
6. 报问题时把 `[umg][hw] 未连接手台…` 那一行发出来: 里面列了系统枚举到的每个串口、各自的结论,
   以及**设备到底回了什么字节**。

## 构建与运行

```bash
npm install            # 安装 esbuild + Babel(若 /tmp/deobf 已有 Babel 可复用)

# 1) (可选)从反混淆 bundle 重新生成模块化源码
GAME_SRC=/path/to/game_main.deobf.js npm run extract:game
npm run analyze:game   # 生成 src/game/logic/COUPLING.md

# 2) 构建
npm run build          # 宿主 + 游戏,产物在 dist/
npm run check          # 产物语法校验

# 3) 运行 Tauri
cd src-tauri
cargo tauri dev        # 桌面
cargo tauri android build --debug --apk --target aarch64   # Android

Android 首次构建前: `npx tauri android init` → `npm run android:perms`(声明「所有文件访问」)
→ `npm run android:sign`(接入签名)。
```

- 桌面数据目录默认 `../assets`(可用 `UMIGURI_ASSETS_DIR` 或 `UMIGURI_DATA_DIR` 覆盖)。
- `npm run encrypt -- <in> <out>` 单独加密;`build/bundle-game.mjs --no-minify` 不压缩。

## 游戏本体: 两种源码形态

### A. ES 模块版(推荐, 目标形态)

```
src/game-esm/
  index.js                    入口: bootstrap(原 IIFE 顶层语句, 保持顺序) + 创建各模块
  runtime/scope.js            export const scope = {}   共享运行时作用域
  runtime/helpers.js          189 个顶层辅助函数(挂到 scope.*, 保持 hoisting 语义)
  modules/<name>/index.js     55 个功能模块: export function create<Name>(scope)
```

- **不再依赖 manifest.json 拼接**;`index.js` 用显式 `import` 引用每个模块工厂。
- 模块之间通过 `scope.xxx` 互相引用(`scope.inputModule.oe()` / `scope.renderer`),
  避免循环 `import` 与 TDZ。
- 生成:`npm run deobf && npm run modularize`(由 `dist/game_main.deobf.js` 自动转换)。
- 构建:`npm run build:game:esm` —— vendor(经典片段按文件名顺序) + esbuild 打包
  `src/game-esm/index.js` → 压缩 → AES 加密 `dist/www/main.js.enc`。

> 转换原理:`tools/modularize-game.mjs` 在原 AST(作用域完整)上把所有指向 IIFE 闭包
> 绑定的引用改写为 `scope.<name>`;模块 IIFE → 工厂;顶层 function → helpers;
> 其余顶层语句按原顺序留在 `index.js`。静态校验(bundle 后无任何未绑定的游戏作用域名)通过。

### 资源格式模块 `src/game-esm/formats/`(手写, 不被重新生成清掉)

一个模块收齐所有「加密/打包格式」与资源加载 API:

| 文件 | 内容 |
|---|---|
| `constants.js` | MAGIC/种子/VA·WA 表/AES 密钥/P2 约定 |
| `cipher.js` | 位置相关 XOR 表、Na 流密码(正/逆) |
| `gzip.js` | gzip 解/压缩(CompressionStream, 浏览器与 Node18+ 通用) |
| `archive.js` | `.una/.arc` 头部与表解析、文件体解密、解包、打包、扩展名识别 |
| `stringTable.js` | RVST 字符串表解析/构建 |
| `dds.js` | DDS 头部解析 + DXT1/3/5 软解 |
| `aes.js` | AES-256-CBC(WebCrypto, main.js.enc) |
| `index.js` | 统一导出 + `createResourceLoader(io)` / `openArchive(io,path,p2)` |

算法移植自已验证逐字节可逆的 `tools/umg.cjs`。实测:
`.una` 解包与 umg 结果一致;重打包与原始**逐字节一致**;RVST 往返一致;DDS 头部/DXT 正常。

> 下一步:把游戏内散落的归档读取(`scope.v_ds_27991` / `scope.v_vs_27992` / 语言包)
> 改为调用本模块(行为一致, 但需要真机回归)。

### B. 片段版(旧, 保留为回退)

`src/game/logic/` + `manifest.json` 字符串拼接, 见下节。构建:`npm run build:game`。

## 游戏本体拆分策略(片段版, 重要)

> ⚠️ 上游的 `game_main.deobf.js` **不可运行**: 原 `tools/deobfuscate.js` 在改名时对每个
> 标识符现场 `getBinding`，而声明已被就地改过名，导致约 106 个名字「有引用、无声明」
> (例: `function t(){}` → 声明名 `v_t_28361`，但 `new t()` → 不存在的 `v_t_28347`)。
> 本工程用修正版 `tools/deobfuscate-fixed.mjs` 重新生成可用源码:
> ```bash
> npm run deobf        # ../game_main.original.js -> dist/game_main.deobf.js
> npm run extract:game # 再按 symbols/props/upstream 拆分
> ```
> 修正点: 函数/类声明的名字标识符必须用**外层作用域**的绑定(Babel 在函数名节点上会
> 解析到函数自身的同名形参绑定)。`npm run check` 含 `freevar-check`, 会拦截此类断裂。

`tools/split-game.mjs` 按**顶层语句**与**游戏 IIFE 体内语句**切分,并且:

1. 生成 `logic/entry.preamble|footer|postamble.js` 与 277 个体内片段;
2. 断言 `preamble + 全部片段 + footer + postamble` **逐字节等于**原 bundle 区间;
3. `vendor/` 与 `logic/` 片段**按 manifest 顺序拼接**后即为完整 bundle,运行时与原件一致。

**为什么不是 55 个独立 ES 模块?**
游戏主逻辑是一个大 IIFE,内部 55 个模块 IIFE 通过**闭包**共享 655 个外层绑定
(见 `src/game/logic/COUPLING.md`:单个模块最多引用 264 个外层变量,合计 1332 处)。
把它们直接改成 `import/export` 必须先把闭包变量提升为显式 `scope` 对象并改写全部引用,
这属于**语义等价但不可用本仓库环境验证**的改造(需要 WebView + 游戏资源才能回归)。

当前做法选择「保留原逻辑」(js.md §13),并把后续改造所需的耦合数据
(`COUPLING.md` + `MODULE_MAP.md`)一并产出,便于按模块逐个安全提升。

> ⚠️ 不确定项: 游戏 `vendor/` 内 emscripten / Effekseer 生成代码依赖 `this`/全局,
> 不适合作为原生 ESM 直接 `import`;本工程以经典脚本片段拼接(等价于原 bundle 执行环境)。

## 对象字段改名(property)

> ⚠️ 默认**关闭**(`--props` 才启用)。原因: 新字段名可能与对象上**已有的同名属性**
> 冲突(如 `.Te→x`/`.Be→visible`, 而 `visible`/`x` 本身已是其它对象的属性),
> 实测曾导致启动异常。改名映射保留在 `tools/prop-symbols.json`, 分析见
> `tools/analyze-props.mjs` 生成的 `src/game/logic/PROPERTIES.md`。

`tools/prop-symbols.json` 维护被 terser **property mangling** 的字段名映射。启用时
`applyProps` 有安全门槛: 若该名字以**字符串字面量**出现或以 `obj["x"]` 动态访问,
或简写/解构, 一律拒绝。

已收录: `Be→visible`、`Te→x`、`Qt→y`、`Le→w`、`G0→h`、`yk→elementByIndex`、
`ot→elementByName`、`lt→rsbTree`。

## vendor 上游替换

`tools/vendor-overrides.json` 把 bundle 内可识别的第三方片段替换为**上游官方源码**:

| 片段 | 替换为 | 依据 |
|---|---|---|
| THREE 核心 | `vendor-upstream/three.r137.js` | `three@0.137.0` build/three.js(MIT) |
| BufferGeometryUtils | `vendor-upstream/BufferGeometryUtils.r137.js` | 同上 examples/js |
| GLTFLoader | `vendor-upstream/GLTFLoader.r137.js` | 同上 examples/js |

- 替换前已用「字符串字面量集合」比对确认与上游一致;并校验游戏引用的 201 个
  `THREE.*` 名称在上游中均存在(仅 `GLTFLoader` 由独立文件提供)。
- 未替换的: Emscripten 版 Effekseer(8.8MB, 编译产物, 非公开源码)、Babel 辅助函数、
  游戏自有 WebGL 包装 `glRuntime`、字形/字符数据。
- 重新拆分时自动应用覆盖;`--no-upstream` 可关闭。

## 与上游仓库的关系

本目录独立可构建,不修改 `../game_main.original.js`。资产(68M)不在本目录,
桌面端通过路径解析读取父级 `assets/`;Android 打包资源路径见 `tauri.android.conf.json`。
