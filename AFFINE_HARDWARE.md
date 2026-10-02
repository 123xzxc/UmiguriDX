# Affine_IO 手台接入说明(给宿主项目)

> 目标读者: 想给自己的 UMIGURI / CHUNITHM 系宿主加 `Affine_IO` 手台支持的开发者(或替你干活的 AI)。
> 本文只讲**协议与落点**, 不假设你看过任何一方的源码。
>
> 素材来源:
> - 手台侧参考实现: [QHPaeek/Affine_IO](https://github.com/QHPaeek/Affine_IO) —— `chuniio/serialslider.{c,h}`、`chuniio/chuniio.c`、`chuniio/test.c`(master `4092cdb`)
> - 已跑通的宿主侧实现: [123xzxc/UmiguriDX](https://github.com/123xzxc/UmiguriDX) —— Rust 宿主 `open-umiguri/src-tauri/src/hardware/*`, 手台支持落在 `bc2d064`(2026-10-02), 本文对应 `2.1.9`
>
> 标 ⚠ 的是**实测与参考实现不一致**的地方, 也是这份文档最值钱的部分 —— 照着参考实现写会踩坑。

## 0. 给 AI 的摘要(先读这段)

- 协议就是**官方 Sega 滑块板帧协议** `FF cmd size payload... checksum`, `0xFD` 转义。Affine 在它之上追加了 AIR(天键) 命令, 让同一个串口顺带当 JVS 板。
- 设备收到 `AUTO_SCAN_START(0x03)` / `AUTO_AIR_START(0x06)` 后**主动按周期推帧**(实测约 100ms 一帧), 主机**不需要轮询**。这跟 chu2board 的「发命令 → 收响应」完全不同。
- ⚠ **设备发出的帧校验和对不上任何已知规则** —— 收侧**必须「结构收满就收」**, 拿校验和当门槛会把每 100ms 都在推的帧全丢掉(我们就是这么踩的坑, 见 §2.4)。
- ⚠ **macOS / Linux 必须把 DTR 拉高**才能让设备开口。Windows 的 USB 串口驱动默认拉高, 所以那边一直正常 —— 少这一下, 现象是「设备在, 但一个字节都不回」。
- 与 chu2board 共用同一个串口时, 靠「发扫描命令后有没有 `0x01`/`0x05` 帧」区分, 两种协议互不干扰(§8)。

## 1. 硬件与物理层

| 项 | 值 | 出处 |
|---|---|---|
| 串口参数 | 115200, 8 数据位, 无校验, 1 停止位 | `serialslider.c::open_port()` |
| DTR | **必须拉高** | `open_port()` 里 `EscapeCommFunction(hPort, SETDTR)` |
| USB 标识 | `VID_AFF1`; `PID_52A4`(Linnea Legacy) / `PID_52A7`(Linnea C) | `chuniio/test.c`; 产品名 "Linnea Series" |
| Windows 找端口 | setupapi 按 VID/PID 查 `PortName`, 查不到回落 `COM1` | `GetSerialPortByVidPid()` |
| macOS 端口名 | 优先 `/dev/cu.*`, 并与 `/dev/tty.*` 去重 | `tty.*` 在载波(DCD)为低时会挡住打开/读取, 是「Windows 能连、macOS 连不上」的经典坑 |

设备只在**收到开扫描命令之后**才推帧; 上电后静听是收不到任何字节的, 别据此判断「设备不在」。

## 2. 帧格式

### 2.1 结构

```text
FF         同步字节
cmd        命令(见 §3)
size       载荷长度(1 字节, 0..255)
payload    size 个字节
checksum   1 字节
```

### 2.2 转义

`cmd` / `size` / `payload` / `checksum` 里出现特殊字节要转义:

| 原始字节 | 线上字节 |
|---|---|
| `0xFF` | `FD FE` |
| `0xFD` | `FD FC` |

收侧反过来: `FD x` → `x + 1`。因为载荷里不会出现裸 `0xFF`, 排查时也可以直接按 `0xFF` 把字节流切成帧。

⚠ 参考实现的**发送侧转义是坏的**: `sliderserial_writeresp()` 里写的是
`if ((data[i] == 0xff) && (data[i] == 0xfd))` —— 恒假, 永远不会转义; 而且它只看前 `size` 个字节, 校验和那一位根本不查。
收侧 `serial_read_cmd()` 是**会**解转义的。所以: 主机发给设备时, 载荷里避开 `0xFF`/`0xFD` 最稳(或者干脆按规范转义; 我们按规范转义, 实机接受)。

### 2.3 校验和(官方 / 参考发送侧)

```text
checksum = 0x100 - ((0xFF + cmd + size + sum(payload)) & 0xFF)
```

即「整帧(含 sync 与 checksum)各字节之和 ≡ 0 (mod 256)」。这是官方滑块板的规则, 参考实现发送侧也是这么算的。

### 2.4 ⚠ 实测偏差: 设备发出的帧对不上校验和

在 macOS 上对实机(Linnea C, PID `0x52A7`)抓包, `AUTO_SCAN` 帧是 **38 字节**:

```text
FF 01 21 <32 字节压力> <1 字节天键> E0 00
      ^^ size = 0x21 = 33
```

- 按官方 `size = 33` 算, 结构上只该有 `3 + 33 + 1 = 37` 字节, 实机多出 1 字节。
- 末尾 `E0 00` **不满足**「整帧和为 0」, 也不满足我们试过的任何变体(转义前算 / 转义后算 / 取负补码…)。
- 在「32 个压力全 `0xFE`、天键 `0x00`」这一帧上: `sum(payload) ≡ 0xC0`, 而 `FF + 21 + C0 = 0xE0`。也就是说这个字节
  **恰好等于 `sync + size + payload`**(没取负, 也没算 `cmd`)。按官方规则它应该是 `0x1F`。
- 第 38 字节目前**恒为 `0x00`**。

**对主机侧的要求**: 帧判定**只看结构**(`0xFF` 同步 + `cmd` + `size` + 载荷收满), 多出来的字节丢掉。校验和可以算出来当参考信息记日志, 但**不能拿它当门槛**。
(踩坑现场: 一度要求「未转义后整帧和为 0」才收, 结果设备每 100ms 推一帧、宿主一帧都不认, 报成「未收到 Affine 扫描帧」。)

**对固件作者的请求**: 请核对发送侧的校验和 —— 是「漏算 `cmd` + 忘了取负」, 还是 `x` 本来是别的字段(比如累计计数)而 `y` 才是校验和 / 占位? 仓库里的 `open-umiguri/tools/mac-hw-probe.py`(v4, 纯标准库、不需要 pyserial)可以在真机上按 `0xFF` 切帧并统计候选规则的吻合数, 直接拿去验证就行。

## 3. 命令表

| cmd | 方向 | 名称 | 载荷 | 说明 |
|---|---|---|---|---|
| `0x00` | — | NOP | 0 | 未使用 |
| `0x01` | 设备→主机 | `AUTO_SCAN` | 32 或 33 | 32 个压力; `size == 33` 时后面跟 1 字节天键位图。周期主动推(约 100ms) |
| `0x02` | 主机→设备 | `SET_LED` | 97 | 1 字节未知(官方固定 `0x28`) + 96 字节 RGB(32 格) |
| `0x03` | 主机→设备 | `AUTO_SCAN_START` | 0 | 开始推 `AUTO_SCAN` |
| `0x04` | 主机→设备 | `AUTO_SCAN_STOP` | 0 | 停止推 |
| `0x05` | 设备→主机 | `AUTO_AIR` | 1 | 天键位图(低 6 位)。**部分固件用这条单独报天键**, 触摸仍走 `AUTO_SCAN` |
| `0x06` | 主机→设备 | `AUTO_AIR_START` | 0 | 开始推 `AUTO_AIR` |
| `0x07` | 主机→设备 | `SET_AIR_LED` | 3 | 整条 AIR 灯一个 RGB 颜色 |
| `0x10` | 主机→设备 | `RESET` | 0 | 复位 |

⚠ 参考实现里 `AUTO_AIR_STOP` 被注释掉了, 停止只能靠 `AUTO_SCAN_STOP`。

## 4. 推荐的主机侧实现

### 4.1 移植清单

最小可用集就三段:

| 职责 | 要做的事 |
|---|---|
| **协议本体** | 组帧 / 转义 / 拆帧 / 命令常量 + 单元测试 |
| **串口** | 枚举端口 → 打开(115200/8N1 **+ DTR**)→ 逐字节读循环 |
| **接进游戏** | 解析出的 32 压力 / 6 天键送进输入层; 游戏侧 LED 数据转成 `SET_LED` |

在 UmiguriDX 里的落点(供对照, 文件在 `open-umiguri/src-tauri/src/hardware/`):

| 文件 | 职责 |
|---|---|
| `affine.rs`(新增) | 协议本体: 组帧 / 转义 / 拆帧 / 命令常量 / 压力与天键解析 + 单元测试 |
| `serial.rs` | 端口枚举与排序、打开(含 DTR)、`read_byte`、扫描与灯光下发、`affine_probe()`、`connect_auto()` |
| `mod.rs` | 协议枚举 `Kind`、输入线程(累积状态 / 空闲补发 / 连续失败断开)、`hw_init` / `hw_connect` / `hw_disconnect` / `hw_status` / `hw_list_ports`、自动重连退避 |
| `mapping.rs` | 通道 ↔ 档位映射、灯光 96 字节组装、`LedOrder` |
| `led_server.rs` | UMIGURI 的 LED WebSocket 服务端 → 手台灯光帧(另含 AIR 灯去重) |

### 4.1b Android(USB Host)

Android 没有 `/dev/*` 串口, 手台要走 **USB Host + bulkTransfer**。这条通道在官方
Tauri 工程里是默认缺的, 需要自己接:

| 步骤 | 要点 |
|---|---|
| 权限 | `AndroidManifest.xml` 必须有 `<uses-feature android:name="android.hardware.usb.host" />`。缺它时系统**不会弹 USB 授权框**, `UsbManager.openDevice()` 直接返回 `null`。 |
| 枚举 | `UsbManager.getDeviceList()`, 按 `getInterfaceClass()==0x0A`(CDC Data) 优先认手台, 排掉 HUB(0x09)/大容量存储(0x08)。 |
| 打开 | `openDevice()` 返回 null ⇒ 没授权(提示用户勾「一律允许」) 或被内核驱动占用。 |
| 端点 | 找该接口下的 **BULK** 端点(type==2), `getDirection()==0` 是 OUT, `==128` 是 IN。 |
| 声明 | `claimInterface(iface, true)`; 失败说明内核 USB 串口驱动占着, 要换 OTG 线/口。 |
| DTR | CDC `controlTransfer(0x21, 0x22, 1, ifaceId, null, 0, 200)` 补发 DTR —— 和桌面端拉 DTR 等价, 少了它固件不开口。 |
| 线程 | **JNIEnv 不能跨线程保存**: 每次收发都 `vm.attach_current_thread()` 重新拿。 |
| 读法 | 固定开一个长度足够的 buffer(如 64B) bulk 读, 只把**第一个字节**交给流式 `Decoder`, 其余仍记进原始字节环形缓冲做诊断。 |

其余协议部分(组帧/转义/拆帧/命令/灯光)与桌面**完全共用** `affine.rs`, 不重复实现。
UmiguriDX 里落在 `serial.rs` 的 `mod imp { #[cfg(target_os = "android")] ... }`。

### 4.2 时序

```text
主机                                设备
 │  FF 07 03 00 FD FE 40 B8 SET_AIR_LED(白) →           (1. 先点灯唤醒!)
 │  FF 02 61 28 ... SET_LED(全白)  →                     (同上, 32 格白灯)
 │  FF 06 00 FB   AUTO_AIR_START  →
 │  FF 03 00 FE   AUTO_SCAN_START →
 │                                 ←  FF 01 21 <32 压力> <天键> E0 00   (约 10 帧/秒, 一直推)
 │  FF 07 xx xx xx SET_AIR_LED    →                     (游戏推 LED 时才发)
 │  FF 02 61 28 ... SET_LED       →
 │  FF 04 00 FD FC AUTO_SCAN_STOP →                     (断开前)
```

- 开扫描顺序: **先 `AUTO_AIR_START` 再 `AUTO_SCAN_START`**(与 `chuni_io_slider_start()` 一致)。有的固件只认其中一条, 两条都发最省事。
- 闲置一段时间没收到帧时**重发一次开扫描**即可; 我们踩过的坑是设备偶尔在第一次开扫描时还没准备好, 重发就能推流。
- 断开前发 `AUTO_SCAN_STOP`, 免得设备继续占着串口推数据。
- **⚠ 顺序不是随便排的: 必须先点灯, 设备才肯说话。** 实测(Linnea 固件, macOS)打开端口之后:
  什么都不发听 20 秒 —— 0 字节; 发开扫描命令 —— 0 字节; 手指按住/来回划触摸条 —— 0 字节;
  **直到发出第一帧灯光, 设备才开始持续推帧**。也就是说固件把「收到灯光帧」当成启动条件,
  这正是玩家说的「灯亮了才可以连接手台」。只发开扫描的宿主永远等不到 AUTO_SCAN 帧, 于是
  连不上; 而手工跑 `mac-hw-probe.py`(它后面会发灯光帧)就能连上 —— 这个现象就是它造成的。
  所以**探测阶段第一步就必须点灯**(`serial.rs` 的 `affine_wake()`: 先 AIR 灯再 32 格白灯),
  之后每秒补发一次(整帧约 200 字节 ≈ 17ms@115200, 可以忽略)。
- **「灯亮 = 固件真正就绪」: 连上之后也要再点一次灯。** LED 点亮是手台跑完初始化、真的在听命令的标志。
  宿主早期只在游戏的 LED 服务端推 `SetLED` 时才点灯, 于是「连上」与「灯亮」互相等: 灯不亮以为没连上, 没连上就不点灯。
  现在连接成功后立刻发一次全白 `SET_AIR_LED` + `SET_LED`(见 `hardware/mod.rs` 的 `install()` 与 `serial.rs` 的 `affine_wake()`), 先点亮再进输入循环。
  ⚠ 全白灯光帧最长约 200 字节(96 个 `0xFF` 每个经 `0xFD` 转义成 2 字节, ≈17ms@115200), 写返回时串口缓冲里可能还没发完, 所以进读循环前要等 ~60ms, 否则读写会抢锁; 这里也**忽略写错误** —— 点不亮不该让手台整体不可用。

### 4.3 数据解析

- `AUTO_SCAN` 载荷前 32 字节 = 每格压力, **顺序与 32 个触摸通道一致**。
- `payload.len() > 32` 时, 第 33 字节是**天键位图**(低 6 位 = 6 个天键)。
- ⚠ **力度不参与游戏逻辑**: UMIGURI / 街机只认「按下 / 松开」。宿主侧只做 `压力 > 0`(或 `!= 0`、`< 阈值`)的二值化, 写进游戏的 38 个档位是 0/1 开关量。
  (实测「手离开」时压力读到 `0xFE` 而不是 `0x00` —— 别拿 `== 0` 当「没按」, 用「非零即按下」或按固件的阈值来判。参考实现 `test.c` 里用的是 `THRESHOLD 128`。)
- 天键也可能走单独的 `0x05 AUTO_AIR` 帧上报, **两条路都要支持**。

### 4.4 灯光

- `SET_LED` 载荷 = 1 字节 `0x28` + 96 字节 RGB, **32 格顺序与触摸通道一致**。
- ⚠ **`size` 到底是 96 还是 97 需要固件确认**(§11): 参考实现发送 96, 但 `slider_packet_t` 的结构体里是 `led_unk + leds[96]`。我们发 `size = 97`(含 `0x28`)实机可用。
- ⚠ **灯色字节序**: 参考实现 `chuni_io_led_set_colors()` 取的是 `rgb_raw[152] / [150] / [151]` —— 即 `B, R, G`。如果颜色明显不对(红蓝互换), 先把这三个换一换。
- AIR 灯只有单色(`0x07` 三字节), **做不了分段 / 流水灯**。
- 参考实现里 `chuni_io_slider_set_leds()` 的 `sizeof(rgb)` 取的是指针大小而不是 96, 导致 `LED_status` 只看前几个字节 —— 这个逻辑不要照抄, 第三方宿主都没抄。

### 4.5 探测与共存

- 探测流程: **打开端口(带 DTR)→ 发灯光帧唤醒 → 发两条开扫描 → 等 `0x01`/`0x05` 帧**(顺序不能换, 见上一条)。
  ⚠ 设备可能**上电后好几秒才开口**: 探测窗口给足 8 秒(旧版 1.2 秒会让慢启动的设备每轮都被提前放弃, 表现就是「必须先手工跑一遍 mac-hw-probe.py 才连得上」)。
  窗口里要区分三种情况并打日志: 一个字节都没收到(线/驱动/供电)、收到字节但拆不出帧(波特率/噪声)、拆出帧但没有 `0x01`/`0x05`(协议或固件版本不对)。
- 与 chu2board 固件共用同一个串口时, 两种协议**互不干扰**: 官方滑块板(以及 Affine)会丢弃一切非 `0xFF` 开头的字节, 而 chu2board 的单字节命令(`0xB0`/`0xAF`/`0xB1`/`0xB2`)不会撞上 `0xFF` 开头的帧。先按 chu2board 握手、失败再按 Affine 探测即可。
- 端口枚举建议: USB 串口优先, `bluetooth` / `debug` 相关的排最后; macOS 上把 `tty.*` 与 `cu.*` 去重后优先用 `cu.*`。

## 5. 验证方法

**a) 链路自检(最快)**

发 `FF 06 00 FB`(AUTO_AIR_START) + `FF 03 00 FE`(AUTO_SCAN_START), 能持续收到 `FF 01 21 ...` 就是链路正常。收不到先查 DTR 与端口名。

连不上时先看宿主日志里 `[umg][hw] Affine 探测: …` 那一行, 它已经把结论分好了: 「一个字节都没收到」= 线/驱动/供电; 「收到 N 个字节, 但没拆出完整帧」= 波特率或噪声; 「拆出了帧, 但没有 AUTO_SCAN」= 协议/固件版本不对。

**b) 协议自检**

```bash
# 手台参考实现的 Windows 测试程序(需 32 位 GCC)
gcc .\test.c .\serialslider.c -o chuni_test.exe -lsetupapi
```

**c) 真机摸底(推荐)**

`open-umiguri/tools/mac-hw-probe.py`(v4, 纯标准库, 不需要 pyserial): 打印系统串口与 USB 设备树, 分段采样(手离开 / 按住一格 / 左右来回划), 按 `0xFF` 切帧统计帧长与候选校验和规则的吻合数。**新接一款手台时先跑它**, 免得把「设备没说话」和「帧被自己丢掉了」搞混。

**d) 单元测试**

把拆帧器做成纯函数并测这几条(UmiguriDX 的 `affine.rs` 有现成用例可抄):

- 转义往返: 载荷含 `0xFF` / `0xFD` 时编解码一致;
- 两种校验和规则都能收(未转义后和为 0 / 线上字节和为 0);
- **真机 38 字节帧**: 32 个 `0xFE` + `0x00` + `0xE0` + `0x00`, 校验和对不上但**必须收下**;
- 垃圾字节穿插后能重新同步;
- 压力 / 天键解析。

## 6. 已知坑速查

| 现象 | 多半是 |
|---|---|
| 设备在, 但一个字节都不回 | macOS/Linux 没拉 DTR; 或没发开扫描命令 |
| 收到数据但一帧都不认 | 拿校验和当门槛了(§2.4) |
| macOS 能打开端口但读不到 | 用了 `/dev/tty.*`, 换 `/dev/cu.*` |
| 一直显示「API 版本不符」 | 拿 chu2board 的握手去问 Affine 手台了, 换探测顺序 |
| 红蓝颜色反了 | 灯色字节序 B/R/G(§4.4) |
| 手离开时认为按着 | 把压力 `== 0` 当「没按」了, 实测空闲是 `0xFE` |
| 只有触摸没有天键 | 只处理了 `AUTO_SCAN(size=33)`, 没处理单独的 `0x05` |
| Android 上 openDevice 返回 null | 没声明 `android.hardware.usb.host`, 或用户没勾「一律允许」|
| Android 上设备在但读不到 | 忘了 claimInterface / 忘了补发 DTR / 枚举到的是 HUB 而非手台 |

## 7. 需要固件作者确认的点

1. ⚠ 设备发出的 `AUTO_SCAN` 帧里那两字节(`x`, `y`)到底是什么? `x` 像「漏算 cmd 且没取负」, `y` 恒为 `0x00`。
2. ⚠ `SET_LED` 的 `size` 是 96 还是 97(含 `0x28`)? 参考实现发 96, `slider_packet_t` 结构里却有 `led_unk`。
3. ⚠ 发送侧转义恒假(§2.2), 建议修掉。
4. 天键上报方式不统一(`AUTO_SCAN size=33` 带 / `AUTO_AIR` 单独报), 建议明确一种。
5. `AUTO_AIR_STOP` 被注释掉, 「停止」是否需要同时停 AIR?
6. AIR 灯只有单色, 未来要不要支持分段?
7. `Coin Key` 还没进协议(参考实现的投币仍走宿主键盘 `GetAsyncKeyState`), 要做串口投币需要新增命令。
8. 空闲时的压力值 `0xFE` 是「满量程」还是「未校准」? 阈值该定在哪?

## 附录 A: 帧样例

| 用途 | 线上字节 | 说明 |
|---|---|---|
| `AUTO_AIR_START` | `FF 06 00 FB` | `-(FF+06+00) = 0xFB` |
| `AUTO_SCAN_START` | `FF 03 00 FE` | `-(FF+03+00) = 0xFE` |
| `AUTO_SCAN_STOP` | `FF 04 00 FC` | `-(FF+04+00) = 0xFC` |
| `SET_AIR_LED`(绿) | `FF 07 03 00 FD FE 40 B8` | 注意 `0xFF` 被转义成 `FD FE` |
| `SET_LED` | `FF 02 61 28 <96 RGB> <校验和>` | UmiguriDX 形式: `size = 0x61 = 97`, 首字节 `0x28` |
| 实机 `AUTO_SCAN` | `FF 01 21 <32 压力> <天键> E0 00` | 38 字节; 压力全 `0xFE`、天键 `0x00` 时末尾是 `E0 00` |

## 附录 B: 一句话版本

> Affine_IO = 官方滑块板帧协议 + AIR 命令; 开扫描(先 AIR 后 SCAN)就自己推帧;
> **收侧只按结构收帧, 千万别校验校验和**; macOS 记得拉 DTR。
