//! 串口封装(移植自 chu2board/src/serial.rs): 枚举端口、打开、命令式读写。
//!
//! 支持两种手台:
//!   - chu2board 固件: 单字节命令(0xB0 握手 / 0xAF 问 API / 0xB1 读输入 / 0xB2 灯光),
//!     主机主动轮询, 严格的「命令 → 响应」, 每帧前 `drain` 清残留保证帧对齐;
//!   - Affine_IO 手台(见 `hardware::affine`): 官方滑块板帧协议(0xFF 同步 + 转义 + 校验和),
//!     主机发一次 AUTO_SCAN_START 后设备持续推帧。
//! 连接时按「先 chu2board 握手, 再 Affine 探测」的顺序自动识别, 也可由配置强制指定。
//!
//! Android/iOS 无串口 API(serialport 在移动端不可用), 因此本模块在移动端为桩实现。
use anyhow::Result;
use std::sync::{Arc, Mutex};


use crate::hardware::Kind;

/// 探测时串口上收到的原始字节(最多留前 32 个, 另外记总数)。
///
/// 连不上手台时,「设备一句话没说」和「设备说了、但不像手台」要查的地方完全不同:
/// 前者是线/USB 驱动/固件在 macOS 上的兼容性, 后者是协议。所以失败日志里把这段
/// 原始字节一起打出来, 一眼就能分清。
#[derive(Clone, Default)]
pub struct RxTrace {
    total: usize,
    head: Vec<u8>,
}

#[allow(dead_code)] // 移动端没有串口, push/clear 只在桌面端用到
impl RxTrace {
    /// 记一个收到的字节(超过 32 个只加计数)
    pub fn push(&mut self, byte: u8) {
        self.total += 1;
        if self.head.len() < 32 {
            self.head.push(byte);
        }
    }

    /// 清空, 用于开始探测下一种协议
    pub fn clear(&mut self) {
        self.total = 0;
        self.head.clear();
    }

    /// 收到过的字节总数
    #[allow(dead_code)] // 移动端 read_byte 用它判断这一轮有没有新数据
    pub fn total(&self) -> usize {
        self.total
    }

    /// 最多前 32 个字节
    #[allow(dead_code)]
    pub fn head(&self) -> &[u8] {
        &self.head
    }
}

impl std::fmt::Display for RxTrace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.total == 0 {
            return write!(f, "一个字节都没收到");
        }
        for (i, b) in self.head.iter().enumerate() {
            if i > 0 {
                write!(f, " ")?;
            }
            write!(f, "{b:02X}")?;
        }
        if self.total > self.head.len() {
            write!(f, " …共 {} 字节", self.total)?;
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
    pub const BAUD_RATE: u32 = 115_200;

/// Affine 探测窗口: 开扫描之后等多久才认输。
///
/// 为什么给足 8 秒, 而不是「够用就好」的 1.2 秒: 2026-10 有玩家反馈「必须先在终端跑一遍
/// mac-hw-probe.py, 游戏里的宿主才连得上手台」。那个脚本第 [0] 步会什么都不发、最多听 20 秒,
/// 而宿主的窗口只有 1.2 秒 —— 也就是说设备要好几秒才开口, 宿主每一轮都提前放弃了。
/// 自动重连虽然会一直重试(前 12 次每 5s), 但每轮都只有 1.2 秒, 于是永远连不上。
/// 窗口给足之后, 慢启动的设备第一轮就能连上, 玩家也不必再去跑脚本。
const AFFINE_PROBE_WINDOW: Duration = Duration::from_secs(8);

/// 探测「快速窗口」: 开扫描后先只等这么久。
///
/// 真正的需求是「没接手台时别干等」: 设备若在界里, 基本是开扫描后百毫秒级就开始推帧;
/// 2 秒还一个字节都没有的端口, 再等 6 秒也是白等 —— 直接跳过, 把整轮时间从 8s 压到 2s。
/// 设备只要**开过口**(哪怕拆帧失败), 就说明它确实在说话, 于是延长到 AFFINE_PROBE_WINDOW。
const AFFINE_PROBE_QUICK: Duration = Duration::from_secs(2);

/// 探测期间补发开扫描的间隔。设备刚上电/DTR 刚拉高时可能还在初始化, 或者会丢掉第一次
/// AUTO_SCAN_START, 所以要反复喊醒它 —— 但别太密, 免得设备忙着回命令顾不上推帧。
const AFFINE_PROBE_NUDGE: Duration = Duration::from_secs(1);

/// 开扫描之后, 多少没收到帧就往诊断日志里记一笔(一次探测最多记一条)。
///
/// 只有一个探测窗口看不出「设备根本不说话」和「设备说了、只是慢」: 前者要查线/驱动/固件,
/// 后者等着就好。给个中间点, 日志里就能分清。
const AFFINE_QUIET_LOG_AFTER: Duration = Duration::from_secs(2);
    use super::RxTrace;
    use std::time::Duration;
    use anyhow::{Context, Result};
    use serialport::{available_ports, SerialPort};
    use crate::hardware::affine;
    use std::io::{ErrorKind, Read, Write};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    /// 列出所有可用串口名称。
    pub fn list_ports() -> Vec<String> {
        match available_ports() {
            Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// macOS 上同一台设备会同时出现 `/dev/tty.X` 与 `/dev/cu.X`(同一个口的两个名字):
    /// 只留一个, 且优先 `cu` —— `tty.*` 在载波(DCD)为低时会挡住打开/读取, 是 macOS 上
    /// 「Windows 能连、macOS 连不上」的常见坑。Windows 的 COM 名不含这些前缀, 不受影响。
    pub fn dedupe_callout(ports: Vec<String>) -> Vec<String> {
        let cu: std::collections::HashSet<String> = ports
            .iter()
            .filter_map(|p| p.strip_prefix("/dev/cu.").map(str::to_string))
            .collect();
        ports
            .into_iter()
            .filter(|p| match p.strip_prefix("/dev/tty.") {
                Some(tail) => !cu.contains(tail),
                None => true,
            })
            .collect()
    }

    /// 连接前的端口整理: 去掉 tty/cu 重复项, 再按「USB 优先」排序。
    pub fn prepare_for_connect() -> Vec<String> {
        let mut ports = dedupe_callout(list_ports());
        sort_for_connect(&mut ports);
        ports
    }

    /// 连接前排序: USB 串口(手台常见)优先, 蓝牙/调试口最后, 避免逐个握手浪费时间。
    pub fn sort_for_connect(ports: &mut [String]) {
        ports.sort_by_key(|p| {
            let lower = p.to_lowercase();
            if lower.contains("bluetooth") || lower.contains("debug") {
                4
            } else if lower.contains("usbmodem")
                || lower.contains("usbserial")
                || lower.contains("wchusb")
            {
                0
            } else if lower.contains("usb") {
                1
            } else if lower.contains("tty") || lower.contains("cu") {
                2
            } else {
                3
            }
        });
    }

    #[derive(Clone)]
    pub struct Connection {
        port: Arc<Mutex<Box<dyn SerialPort>>>,
        /// 串口上收到的原始字节(失败日志用, 见 RxTrace)
        rx: Arc<Mutex<RxTrace>>,
    }

    impl Connection {
        pub fn open(name: &str) -> Result<Self> {
            #[allow(unused_mut)]
            let mut port = serialport::new(name, BAUD_RATE)
                .timeout(Duration::from_millis(5))
                .open()
                .with_context(|| format!("打开串口失败: {name}"))?;
            // 手台固件要 DTR 拉高才会说话: Affine 的参考实现(serialslider.c 的 open_port)里
            // 就有一句 EscapeCommFunction(SETDTR)。Windows 的 USB 串口驱动默认就把 DTR 拉高
            // (所以那边一直能连), macOS/Linux 不会 —— 少这一下, 手台一声不吭, 表现就是
            // 「API 版本不符, 且未收到 Affine 扫描帧」。Windows 路径保持原样, 不动。
            #[cfg(not(target_os = "windows"))]
            if let Err(e) = port.write_data_terminal_ready(true) {
                // 有些驱动不支持 DTR, 那也只是少一层保障, 不该因此连不上。
                eprintln!("[umg][hw] 拉高 DTR 失败({name}): {e}");
            }
            Ok(Self {
                port: Arc::new(Mutex::new(port)),
                rx: Arc::new(Mutex::new(RxTrace::default())),
            })
        }

        pub fn write_cmd(&self, cmd: &[u8]) -> Result<()> {
            let mut port = self.port.lock().unwrap();
            port.write_all(cmd).context("发送命令失败")?;
            port.flush().ok();
            Ok(())
        }

        /// 当前记录到的原始字节快照(探测失败时写进日志)
        pub fn rx(&self) -> RxTrace {
            self.rx.lock().unwrap().clone()
        }

        /// 清空已记录的原始字节(开始探测下一种协议前调用)
        pub fn rx_reset(&self) {
            self.rx.lock().unwrap().clear();
        }

        fn note_rx(&self, bytes: &[u8]) {
            let mut rx = self.rx.lock().unwrap();
            for &b in bytes {
                rx.push(b);
            }
        }

        /// 发送灯光: 0xB2 + 96 字节(32 格 RGB)
        pub fn write_led(&self, rgb: &[u8; 96]) -> Result<()> {
            let mut buf = [0u8; 97];
            buf[0] = crate::hardware::protocol::CMD_SET_LEDS;
            buf[1..].copy_from_slice(rgb);
            self.write_cmd(&buf)
        }

        /// 读 `buf.len()` 字节, 超时返回已读数量
        pub fn read_exact(&self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
            let mut port = self.port.lock().unwrap();
            let start = Instant::now();
            let mut n = 0;
            while n < buf.len() {
                if start.elapsed() > timeout {
                    break;
                }
                match port.read(&mut buf[n..]) {
                    Ok(0) => {}
                    Ok(k) => {
                        self.note_rx(&buf[n..n + k]);
                        n += k;
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut => continue,
                    Err(e) => return Err(e.into()),
                }
            }
            Ok(n)
        }

        /// 清空接收缓冲残留
        pub fn drain(&self) {
            let mut port = self.port.lock().unwrap();
            let mut tmp = [0u8; 256];
            loop {
                match port.read(&mut tmp) {
                    Ok(n) if n > 0 => continue,
                    _ => break,
                }
            }
        }

        /// 握手: 发 0xB0, 期待回 0xB0
        pub fn handshake(&self) -> Result<bool> {
            self.drain();
            self.write_cmd(&[crate::hardware::protocol::CMD_HANDSHAKE])?;
            let mut b = [0u8; 1];
            let n = self.read_exact(&mut b, Duration::from_millis(200))?;
            Ok(n > 0 && b[0] == crate::hardware::protocol::CMD_HANDSHAKE)
        }

        /// 查询 API 版本是否匹配
        pub fn check_api_level(&self) -> Result<bool> {
            self.write_cmd(&[crate::hardware::protocol::CMD_API_LEVEL])?;
            let mut b = [0u8; 1];
            let n = self.read_exact(&mut b, Duration::from_millis(200))?;
            // 收到字节才算设备真的开口了: 记进去, 连不上时日志里就能看到它到底回了什么。
            if n > 0 {
                self.note_rx(&b[..n]);
            }
            Ok(n > 0 && b[0] == crate::hardware::protocol::API_LEVEL)
        }

        /// 读一帧输入(0xB1)
        pub fn read_input(&self) -> Result<crate::hardware::protocol::InputState> {
            self.write_cmd(&[crate::hardware::protocol::CMD_READ_INPUT])?;
            let mut buf = [0u8; crate::hardware::protocol::INPUT_RESPONSE_LEN];
            let n = self.read_exact(&mut buf, Duration::from_millis(30))?;
            crate::hardware::protocol::InputState::parse(&buf[..n])
                .ok_or_else(|| anyhow::anyhow!("输入帧不完整: {n}/33"))
        }

        /// 读 1 字节, 超时返回 None(供 Affine 的流式推帧使用)
        pub fn read_byte(&self, timeout: Duration) -> Result<Option<u8>> {
            let mut port = self.port.lock().unwrap();
            let start = Instant::now();
            let mut b = [0u8; 1];
            loop {
                match port.read(&mut b) {
                    Ok(0) => {}
                    Ok(_) => {
                        self.note_rx(&b);
                        return Ok(Some(b[0]));
                    }
                    Err(ref e) if e.kind() == ErrorKind::TimedOut => {}
                    Err(e) => return Err(e.into()),
                }
                if start.elapsed() >= timeout {
                    return Ok(None);
                }
            }
        }

        /// Affine: 让设备开始轮流主动上报(先天键, 再触摸档位)
        pub fn affine_start_scan(&self) -> Result<()> {
            for frame in affine::start_scan_frames() {
                self.write_cmd(&frame)?;
            }
            Ok(())
        }

        /// Affine: 唤醒设备 —— 先发一帧 AIR 灯, 再发一帧 32 格白灯。
        ///
        /// 为什么探测阶段就要点灯: 实测(Linnea 固件的 Affine 手台, macOS)打开端口之后
        /// 固件一句不说 —— 什么都不发听 20 秒没有字节, 发开扫描没有字节, 手指按在触摸条上
        /// 也没有字节; 直到**发出灯光帧的那一刻**才开始持续推帧。也就是固件要收到一帧灯光
        /// 才算真正启动, 这正是玩家说的「灯亮了才可以连接手台」。
        ///
        /// 所以顺序是「点灯 → 再开扫描」: 只发开扫描的话设备根本不看, 探测永远等不到
        /// AUTO_SCAN 帧, 表现就是连不上(玩家以前要先手工跑一遍 mac-hw-probe.py, 那个脚本
        /// 恰好会发灯光帧, 于是"跑过就能连上")。
        ///
        /// 忽略失败: 不是所有固件都认灯光帧, 不认的那批靠开扫描照样能连。
        pub fn affine_wake(&self) -> Result<()> {
            let _ = self.write_air_led_affine([0xFF, 0xFF, 0xFF]);
            self.write_led_affine(&[0xFFu8; 96])
        }

        /// Affine: 停止主动上报
        pub fn affine_stop_scan(&self) -> Result<()> {
            self.write_cmd(&affine::stop_scan_frame())
        }

        /// Affine 灯光: 96 字节 = 32 格 RGB(格子顺序与触摸通道一致)
        pub fn write_led_affine(&self, rgb: &[u8; 96]) -> Result<()> {
            self.write_cmd(&affine::set_led(rgb))
        }

        /// Affine AIR 灯: 3 字节 RGB(整条灯一个颜色)
        pub fn write_air_led_affine(&self, rgb: [u8; 3]) -> Result<()> {
            self.write_cmd(&affine::set_air_led(rgb))
        }

        /// Affine 探测: 开扫描后收到 AUTO_SCAN(0x01) 或 AUTO_AIR(0x05) 帧即认定是 Affine 手台。
        /// 官方/chu2board 固件会把非 0xFF 开头的字节直接丢掉, 所以探测是安全的。
        ///
        /// 窗口长度与补发节奏见 `AFFINE_PROBE_WINDOW` / `AFFINE_PROBE_NUDGE` 的说明。
        pub fn affine_probe(&self) -> Result<bool> {
            self.drain();
            let mut dec = affine::Decoder::new();
            // 两段式窗口: 先 AFFINE_PROBE_QUICK 快速判定; 设备真开过口才延长到
            // AFFINE_PROBE_WINDOW。没接手台时整轮从 8s 压到 2s(见常量注释)。
            let mut deadline = Instant::now() + AFFINE_PROBE_QUICK;
            let mut next_nudge = Instant::now();
            // 顺序很关键: 先点灯把固件叫醒, 再开扫描。
            let _ = self.affine_wake();
            self.affine_start_scan()?;
            let started = Instant::now();
            // 诊断用: 设备到底有没有开口。连不上时这是唯一能分清「没插好/驱动不对」
            // 和「说了但协议不对」的证据, 玩家贴日志时也就能一眼看懂。
            let mut saw_any = false;
            let mut saw_frame = false;
            let mut quiet_logged = false;
            while Instant::now() < deadline {
                if Instant::now() >= next_nudge {
                    // 每轮都补一次灯: 设备可能在这一轮才枚举完成/上电完成,
                    // 错过了开头那一帧灯光就继续装死。整帧约 200 字节(≈17ms@115200),
                    // 一秒一次可以忽略。
                    let _ = self.affine_wake();
                    let _ = self.affine_start_scan();
                    next_nudge = Instant::now() + AFFINE_PROBE_NUDGE;
                }
                // 补发命令也要时间, 所以补发后再查一次超时, 免得把窗口拖长。
                if Instant::now() >= deadline {
                    break;
                }
                let Some(b) = self.read_byte(Duration::from_millis(20))? else {
                    // 快速窗口内一个字节都没有 -> 这个端口不像有手台, 直接放弃。
                    // (设备若在, 开扫描后基本百毫秒级就开始推帧。)
                    if !saw_any && started.elapsed() >= AFFINE_PROBE_QUICK {
                        break;
                    }
                    if saw_any && !quiet_logged && started.elapsed() >= AFFINE_QUIET_LOG_AFTER {
                        quiet_logged = true;
                        let rx = self.rx();
                        eprintln!("[umg][hw] Affine 探测: 收到过字节, 但一直没拆出 AUTO_SCAN 帧(原始字节: {rx})");
                    }
                    continue;
                };
                // 设备开口了: 延长到完整窗口, 给慢启动/慢推帧的固件留足时间。
                if !saw_any {
                    deadline = Instant::now() + AFFINE_PROBE_WINDOW;
                }
                saw_any = true;
                if let Some(frame) = dec.push(b) {
                    saw_frame = true;
                    // 0x01 = 触摸(可能带天键), 0x05 = 单独上报的天键: 都是官方滑块帧协议。
                    if frame.cmd == affine::CMD_AUTO_SCAN || frame.cmd == affine::CMD_AUTO_AIR {
                        return Ok(true);
                    }
                }
            }
            // 窗口走完还是没认出: 区分「设备一个字节都没说」(线/驱动/固件) 与
            // 「说了、但拆不出 AUTO_SCAN 帧」(协议/固件版本不对) —— 要查的地方完全不同。
            if saw_frame {
                let rx = self.rx();
                eprintln!("[umg][hw] Affine 探测: 拆出了帧, 但没有 AUTO_SCAN(0x01/0x05)(原始字节: {rx})");
            } else if saw_any {
                let rx = self.rx();
                let n = rx.total;
                eprintln!("[umg][hw] Affine 探测: 收到 {n} 个字节, 但没拆出完整帧(原始字节: {rx})");
            } else {
                let secs = AFFINE_PROBE_WINDOW.as_secs();
                eprintln!("[umg][hw] Affine 探测: {secs}s 内一个字节都没收到 —— 查线材/驱动/供电(见 README「手台」)");
            }
            Ok(false)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn dedupe_callout_prefers_cu() {
            let out = dedupe_callout(vec![
                "/dev/tty.usbmodem1101".to_string(),
                "/dev/cu.usbmodem1101".to_string(),
                "/dev/tty.Bluetooth-Incoming-Port".to_string(),
                "/dev/cu.Bluetooth-Incoming-Port".to_string(),
                "COM3".to_string(),
            ]);
            // 成对出现时只留 cu(macOS 上 tty 侧会卡在 DCD 上)
            assert!(out.contains(&"/dev/cu.usbmodem1101".to_string()));
            assert!(!out.contains(&"/dev/tty.usbmodem1101".to_string()));
            assert!(!out.contains(&"/dev/tty.Bluetooth-Incoming-Port".to_string()));
            assert!(out.contains(&"COM3".to_string()));
            // 没有 cu 对照的端口(只插出一个 tty, 或 Windows 的 COM)原样保留
            assert_eq!(
                dedupe_callout(vec!["/dev/tty.usbserial-1430".to_string(), "COM7".to_string()]),
                vec!["/dev/tty.usbserial-1430".to_string(), "COM7".to_string()]
            );
        }

        #[test]
        fn rx_trace_summarizes_bytes() {
            let mut rx = RxTrace::default();
            assert_eq!(rx.to_string(), "一个字节都没收到");
            rx.push(0xFF);
            rx.push(0x01);
            assert_eq!(rx.to_string(), "FF 01");
            // 超过 32 个只留头 32 个, 但总数要准(排查时看的就是「到底有没有说话」)
            for i in 0..40u8 {
                rx.push(i);
            }
            let s = rx.to_string();
            assert!(s.starts_with("FF 01"), "{s}");
            assert!(s.ends_with("…共 42 字节"), "{s}");
            rx.clear();
            assert_eq!(rx.to_string(), "一个字节都没收到");
        }

        #[test]
        fn usb_ports_sort_before_bluetooth() {
            let mut ports = vec![
                "/dev/cu.Bluetooth-Incoming-Port".to_string(),
                "/dev/cu.usbserial-1430".to_string(),
                "COM3".to_string(),
                "COM4".to_string(),
            ];
            sort_for_connect(&mut ports);
            assert!(ports[0].contains("usbserial"), "USB 串口要排第一: {ports:?}");
            assert!(
                ports.last().unwrap().contains("Bluetooth"),
                "蓝牙口要排最后: {ports:?}"
            );
        }
    }
}

#[cfg(target_os = "ios")]
mod imp {
    use super::Result;
    use std::time::Duration;

    pub fn list_ports() -> Vec<String> {
        Vec::new()
    }

    /// iOS 无串口 API, 空列表即可。
    pub fn prepare_for_connect() -> Vec<String> {
        Vec::new()
    }

    #[derive(Clone)]
    pub struct Connection;

    impl Connection {
        pub fn open(_name: &str) -> Result<Self> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn check_api_level(&self) -> Result<bool> {
            Ok(false)
        }
        pub fn handshake(&self) -> Result<bool> {
            Ok(false)
        }
        pub fn read_input(&self) -> Result<crate::hardware::protocol::InputState> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn read_byte(&self, _timeout: Duration) -> Result<Option<u8>> {
            Ok(None)
        }
        pub fn rx(&self) -> super::RxTrace {
            super::RxTrace::default()
        }
        pub fn rx_reset(&self) {}
        pub fn write_led(&self, _rgb: &[u8; 96]) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn affine_start_scan(&self) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn affine_wake(&self) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn affine_stop_scan(&self) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn write_led_affine(&self, _rgb: &[u8; 96]) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn write_air_led_affine(&self, _rgb: [u8; 3]) -> Result<()> {
            anyhow::bail!("iOS 不支持串口手台")
        }
        pub fn affine_probe(&self) -> Result<bool> {
            Ok(false)
        }
    }
}

// ---------------------------------------------------------------------------
// Android: 用 USB Host API 直接驱动手台(CDC-ACM / 裸 USB 串口)。
//
// 不能像桌面那样用 serialport crate: 它依赖系统 termios/Win32 串口栈, Android 上没有。
// Android 走的是另一条路 —— UsbManager 拿到 UsbDevice, 声明接口后用 bulkTransfer 收发。
//
// 关于 115200 8N1: CDC-ACM 的波特率由设备固件决定, 主机端没有(也不需要)设置接口。
// 关于 DTR: 手台固件要 DTR 才说话, 打开后补发一次 SET_CONTROL_LINE_STATE, 与桌面端对齐。
//
// 首次连接会主动弹系统「允许访问 USB 设备」授权框(openDevice 无权限时只返回 null, 不会弹),
// 勾「一律允许」后就不再弹。
// ---------------------------------------------------------------------------
#[cfg(target_os = "android")]
mod imp {
    use super::Result;
    use super::RxTrace;
    use crate::hardware::affine;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Affine 探测窗口/补发节奏: 与桌面端一致, 覆盖「上电几秒后才开口」的慢启动设备。
    const AFFINE_PROBE_WINDOW: Duration = Duration::from_secs(8);
    /// 快速窗口: 开扫描后先只等这么久, 没反应就换下一个端口(见桌面段同名常量注释)。
    /// 没接手台时整轮从 8s 压到 2s。
    const AFFINE_PROBE_QUICK: Duration = Duration::from_secs(2);
    const AFFINE_PROBE_NUDGE: Duration = Duration::from_secs(1);

    /// CDC-ACM 数据接口(手台/Arduino 常见)。
    const USB_CLASS_CDC_DATA: i32 = 0x0A;
    /// 肯定不是手台的设备类: 集线器 / 大容量存储 / 视频 / 音频。
    const USB_CLASS_HUB: i32 = 0x09;
    const USB_CLASS_MASS_STORAGE: i32 = 0x08;
    /// 端点类型: 2 = BULK;方向: 0 = OUT, 128 = IN。
    const XFER_BULK: i32 = 2;
    const DIR_OUT: i32 = 0;
    const DIR_IN: i32 = 128;

    /// 主 Activity 的 Context(申请 USB 权限要用它发 PendingIntent)。
    fn android_context() -> jni::objects::JObject<'static> {
        use jni::objects::JObject;
        if let Some(ctx) = tauri::tao::platform::android::prelude::main_android_context() {
            return unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
        }
        JObject::null()
    }

    fn android_vm() -> Result<jni::JavaVM> {
        let ctx = tauri::tao::platform::android::prelude::main_android_context()
            .ok_or_else(|| anyhow::anyhow!("没有 Android context"))?;
        Ok(unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) }?)
    }

    /// context.getPackageName()。PendingIntent 的 action 必须带包名, 所以要先拿到它。
    fn package_name(env: &mut jni::JNIEnv, context: &jni::objects::JObject) -> Result<String> {
        let s = env
            .call_method(context, "getPackageName", "()Ljava/lang/String;", &[])?
            .l()?;
        let js = jni::objects::JString::from(s);
        Ok(env.get_string(&js)?.into())
    }

    /// context.getSystemService(Context.USB_SERVICE) -> UsbManager
    fn usb_manager(env: &mut jni::JNIEnv) -> Result<jni::objects::JObject<'static>> {
        use jni::objects::{JObject, JValue};
        let context = android_context();
        let name = env.new_string("usb")?;
        let mgr = env
            .call_method(
                &context,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[JValue::Object(&name)],
            )?
            .l()?;
        if mgr.is_null() {
            anyhow::bail!("取不到 UsbManager(设备不支持 USB Host?)");
        }
        Ok(unsafe { JObject::from_raw(mgr.as_raw()) })
    }

    /// 只有拿到了 USB 访问权, openDevice() 才会真的打开设备;
    /// 没有权限时 openDevice() 只会返回 null —— **不会**弹任何框。
    fn has_usb_permission(
        env: &mut jni::JNIEnv,
        usb: &jni::objects::JObject,
        dev: &jni::objects::JObject,
    ) -> bool {
        env.call_method(
            usb,
            "hasPermission",
            "(Landroid/hardware/usb/UsbDevice;)Z",
            &[jni::objects::JValue::Object(dev)],
        )
        .and_then(|v| v.z())
        .unwrap_or(false)
    }

    /// 主动弹系统授权框。
    ///
    /// 必须自己发 requestPermission —— 只调 openDevice 在无权限时是静默返回 null,
    /// 玩家看到的就是「没弹 OTG 授权框、手台用不了」。
    ///
    /// PendingIntent 的 action 必须是 '<包名>.USB_PERMISSION' 这类**带包名**的字符串:
    /// 早期 Android 用裸的 "USB_PERMISSION" 也能弹, 但新版本会直接静默拒绝
    /// (不弹框、也不抛异常), 这正是 Android 14 上「没提示授权」的原因。
    fn request_usb_permission(
        env: &mut jni::JNIEnv,
        usb: &jni::objects::JObject,
        dev: &jni::objects::JObject,
    ) -> Result<bool> {
        use jni::objects::{JString, JValue};
        let context = android_context();
        let pkg = package_name(env, &context)?;
        let action = env.new_string(format!("{pkg}.USB_PERMISSION"))?;

        // Intent(action)
        let intent = env.new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )?;
        let pkg_s = env.new_string(&pkg)?;
        let _ = env.call_method(
            &intent,
            "setPackage",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&JString::from(pkg_s).into())],
        );
        // FLAG_ACTIVITY_NEW_TASK(0x10000000), 从非 Activity 上下文发广播必须带。
        let _ = env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(0x10000000)],
        );

        // PendingIntent.getBroadcast(context, 0, intent, FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT)
        // 目标 SDK 31+ 时若 PendingIntent 可变会直接抛异常, 所以必须给 FLAG_IMMUTABLE。
        let pi_cls = env.find_class("android/app/PendingIntent")?;
        let flags = (1 << 26) | (1 << 27);
        let pi = env
            .call_static_method(
                &pi_cls,
                "getBroadcast",
                "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;",
                &[
                    JValue::Object(&context),
                    JValue::Int(0),
                    JValue::Object(&intent),
                    JValue::Int(flags),
                ],
            )?
            .l()?;

        // requestPermission 是异步的: 这里只负责把框弹出去, 是否授权由用户决定。
        env.call_method(
            usb,
            "requestPermission",
            "(Landroid/hardware/usb/UsbDevice;Landroid/app/PendingIntent;)V",
            &[JValue::Object(dev), JValue::Object(&pi)],
        )?;
        Ok(false)
    }

    /// 用迭代器把 getDeviceList() 里的 UsbDevice 逐个取出来。
    fn each_device(env: &mut jni::JNIEnv) -> Result<Vec<jni::objects::GlobalRef>> {
        let usb = usb_manager(env)?;
        let map = env
            .call_method(&usb, "getDeviceList", "()Ljava/util/HashMap;", &[])?
            .l()?;
        let values = env
            .call_method(&map, "values", "()Ljava/util/Collection;", &[])?
            .l()?;
        let iter = env
            .call_method(&values, "iterator", "()Ljava/util/Iterator;", &[])?
            .l()?;
        let mut out = Vec::new();
        loop {
            if !env.call_method(&iter, "hasNext", "()Z", &[])?.z()? {
                break;
            }
            let dev = env.call_method(&iter, "next", "()Ljava/lang/Object;", &[])?.l()?;
            out.push(env.new_global_ref(&dev)?);
        }
        Ok(out)
    }

    fn int_of(env: &mut jni::JNIEnv, obj: &jni::objects::JObject, name: &str) -> i32 {
        env.call_method(obj, name, "()I", &[])
            .and_then(|v| v.i())
            .unwrap_or(-1)
    }

    /// 设备是否像手台: 有 CDC 数据接口就直接算;否则排掉明确不是手台的设备类。
    fn looks_like_handset(env: &mut jni::JNIEnv, dev: &jni::objects::JObject) -> bool {
        let cls = int_of(env, dev, "getDeviceClass");
        let n = int_of(env, dev, "getInterfaceCount");
        for i in 0..n {
            if let Ok(iface) = env
                .call_method(
                    dev,
                    "getInterface",
                    "(I)Landroid/hardware/usb/UsbInterface;",
                    &[jni::objects::JValue::Int(i)],
                )
                .and_then(|v| v.l())
            {
                if int_of(env, &iface, "getInterfaceClass") == USB_CLASS_CDC_DATA {
                    return true;
                }
            }
        }
        !matches!(cls, USB_CLASS_HUB | USB_CLASS_MASS_STORAGE | 0x01 | 0x0E)
    }

    fn entries() -> Vec<String> {
        let Ok(vm) = android_vm() else { return Vec::new() };
        let Ok(mut env) = vm.attach_current_thread() else {
            return Vec::new()
        };
        let Ok(devs) = each_device(&mut env) else {
            return Vec::new()
        };
        let mut out = Vec::new();
        for g in devs {
            let dev = g.as_obj();
            if !looks_like_handset(&mut env, dev) {
                continue;
            }
            let vid = int_of(&mut env, dev, "getVendorId");
            let pid = int_of(&mut env, dev, "getProductId");
            let id = int_of(&mut env, dev, "getDeviceId");
            out.push(format!("usb:{vid:04x}:{pid:04x}#{id}"));
        }
        out
    }

    pub fn list_ports() -> Vec<String> {
        entries()
    }

    /// Android 没有「串口路径」, 候选就是 USB 设备列表。
    pub fn prepare_for_connect() -> Vec<String> {
        list_ports()
    }

    /// 打开设备 + claim 接口 + 找 bulk 端点。
    fn open_device(name: &str) -> Result<Connection> {
        use jni::objects::{GlobalRef, JObject, JValue};
        let want_id: i32 = name
            .rsplit('#')
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| anyhow::anyhow!("端口名无法解析(应为 usb:vid:pid#id): {name}"))?;

        let vm = android_vm()?;
        let mut env = vm.attach_current_thread()?;
        let usb = usb_manager(&mut env)?;
        let devs = each_device(&mut env)?;
        let mut target: Option<GlobalRef> = None;
        for g in devs {
            if int_of(&mut env, g.as_obj(), "getDeviceId") == want_id {
                target = Some(g);
                break;
            }
        }
        let target = target.ok_or_else(|| anyhow::anyhow!("USB 设备不存在或已拔出: {name}"))?;

        // ⚠ openDevice() 在无权限时**静默返回 null, 不会弹任何框**。必须自己先看
        // hasPermission, 没有就主动 requestPermission 把系统框弹出来。
        if !has_usb_permission(&mut env, &usb, target.as_obj()) {
            let _ = request_usb_permission(&mut env, &usb, target.as_obj());
            anyhow::bail!(
                "已弹出 USB 授权框, 请在手机上点「允许」(勾选「一律允许」以后就不用再点): {name}"
            );
        }

        let conn = env
            .call_method(
                &usb,
                "openDevice",
                "(Landroid/hardware/usb/UsbDevice;)Landroid/hardware/usb/UsbDeviceConnection;",
                &[JValue::Object(target.as_obj())],
            )?
            .l()?;
        if conn.is_null() {
            anyhow::bail!(
                "没有 USB 访问权限(或设备被系统占用): {name}\n请在系统弹出的授权框里勾选「一律允许」后重试; 若没弹框, 请拔插一次手台"
            );
        }

        // 优先 CDC 数据接口;没有就退回第 0 个。
        let n = int_of(&mut env, target.as_obj(), "getInterfaceCount");
        let mut chosen: Option<GlobalRef> = None;
        for i in 0..n {
            let iface = env
                .call_method(
                    target.as_obj(),
                    "getInterface",
                    "(I)Landroid/hardware/usb/UsbInterface;",
                    &[JValue::Int(i)],
                )?
                .l()?;
            let is_cdc = int_of(&mut env, &iface, "getInterfaceClass") == USB_CLASS_CDC_DATA;
            if is_cdc || chosen.is_none() {
                chosen = Some(env.new_global_ref(&iface)?);
            }
            if is_cdc {
                break;
            }
        }
        let iface = chosen.ok_or_else(|| anyhow::anyhow!("设备没有可用接口: {name}"))?;

        // 找 bulk 收发端点
        let n_ep = int_of(&mut env, iface.as_obj(), "getEndpointCount");
        let (mut ep_in, mut ep_out) = (None, None);
        for i in 0..n_ep {
            let ep = env
                .call_method(
                    iface.as_obj(),
                    "getEndpoint",
                    "(I)Landroid/hardware/usb/UsbEndpoint;",
                    &[JValue::Int(i)],
                )?
                .l()?;
            if int_of(&mut env, &ep, "getType") != XFER_BULK {
                continue;
            }
            match int_of(&mut env, &ep, "getDirection") {
                DIR_OUT if ep_out.is_none() => ep_out = Some(env.new_global_ref(&ep)?),
                DIR_IN if ep_in.is_none() => ep_in = Some(env.new_global_ref(&ep)?),
                _ => {}
            }
        }
        let (ep_in, ep_out) = match (ep_in, ep_out) {
            (Some(a), Some(b)) => (a, b),
            _ => anyhow::bail!("设备没有可用的 bulk 收发端点 —— 手台应该是 CDC 串口设备: {name}"),
        };

        let iface_id = int_of(&mut env, iface.as_obj(), "getId");
        let claimed = env
            .call_method(
                &conn,
                "claimInterface",
                "(Landroid/hardware/usb/UsbInterface;Z)Z",
                &[JValue::Object(iface.as_obj()), JValue::Bool(1)],
            )?
            .z()?;
        if !claimed {
            anyhow::bail!(
                "无法声明 USB 接口(通常是被内核 USB 串口驱动占用了): {name}\n请换一根 OTG 线/换个 USB 口重试"
            );
        }

        // DTR 拉高(CDC SET_CONTROL_LINE_STATE)。失败不改判: 有些设备不实现这个请求。
        let _ = env.call_method(
            &conn,
            "controlTransfer",
            "(IIII[BII)I",
            &[
                JValue::Int(0x21),
                JValue::Int(0x22),
                JValue::Int(1),
                JValue::Int(iface_id),
                JValue::Object(&JObject::null()),
                JValue::Int(0),
                JValue::Int(200),
            ],
        );

        Ok(Connection {
            inner: Arc::new(Mutex::new(UsbConn {
                conn: env.new_global_ref(&conn)?,
                ep_in,
                ep_out,
                rx: RxTrace::default(),
            })),
        })
    }

    struct UsbConn {
        conn: jni::objects::GlobalRef,
        ep_in: jni::objects::GlobalRef,
        ep_out: jni::objects::GlobalRef,
        rx: RxTrace,
    }

    #[derive(Clone)]
    pub struct Connection {
        inner: Arc<Mutex<UsbConn>>,
    }

    impl Connection {
        pub fn open(name: &str) -> Result<Self> {
            open_device(name)
        }

        fn note_rx(&self, bytes: &[u8]) {
            if let Ok(mut g) = self.inner.lock() {
                for &b in bytes {
                    g.rx.push(b);
                }
            }
        }

        /// bulkTransfer 收发。jni 的 JNIEnv 不能跨线程保存, 每次重新 attach。
        /// 返回实际传输的字节数(<=0 表示错误/超时, 与 Android API 一致)。
        fn bulk(&self, data: &[u8], ep_is_in: bool, timeout_ms: i32) -> Result<i32> {
            let vm = android_vm()?;
            let mut env = vm.attach_current_thread()?;
            let (ep, arr) = {
                let guard = self.inner.lock().unwrap();
                let ep = if ep_is_in { guard.ep_in.clone() } else { guard.ep_out.clone() };
                let arr = env.byte_array_from_slice(data)?;
                (ep, arr)
            };
            let conn = self.inner.lock().unwrap().conn.clone();
            let n = env
                .call_method(
                    &conn,
                    "bulkTransfer",
                    "(Landroid/hardware/usb/UsbEndpoint;[BII)I",
                    &[
                        jni::objects::JValue::Object(ep.as_obj()),
                        jni::objects::JValue::Object(&arr),
                        jni::objects::JValue::Int(data.len() as i32),
                        jni::objects::JValue::Int(timeout_ms),
                    ],
                )?
                .i()?;
            // 读的时候要把缓冲带回来(Android 会原地改写传入的数组)。
            if ep_is_in && n > 0 {
                let got = env.convert_byte_array(&arr)?;
                let head: Vec<u8> = got.into_iter().take(n as usize).collect();
                self.note_rx(&head);
            }
            Ok(n)
        }

        /// 发命令: 直接写 OUT 端点, 不关心回包。
        pub fn write_cmd(&self, cmd: &[u8]) -> Result<()> {
            self.bulk(cmd, false, 200)?;
            Ok(())
        }

        pub fn rx(&self) -> RxTrace {
            self.inner.lock().map(|g| g.rx.clone()).unwrap_or_default()
        }

        pub fn rx_reset(&self) {
            if let Ok(mut g) = self.inner.lock() {
                g.rx.clear();
            }
        }

        /// 读 1 字节;超时返回 None(与串口版语义一致)。
        pub fn read_byte(&self, timeout: Duration) -> Result<Option<u8>> {
            let vm = android_vm()?;
            let mut env = vm.attach_current_thread()?;
            let (ep_in, arr) = {
                let guard = self.inner.lock().unwrap();
                (guard.ep_in.clone(), env.byte_array_from_slice(&[0u8; 64])?)
            };
            let conn = self.inner.lock().unwrap().conn.clone();
            let n = env
                .call_method(
                    &conn,
                    "bulkTransfer",
                    "(Landroid/hardware/usb/UsbEndpoint;[BII)I",
                    &[
                        jni::objects::JValue::Object(ep_in.as_obj()),
                        jni::objects::JValue::Object(&arr),
                        jni::objects::JValue::Int(64),
                        jni::objects::JValue::Int(timeout.as_millis().max(1) as i32),
                    ],
                )?
                .i()?;
            if n <= 0 {
                return Ok(None);
            }
            let got = env.convert_byte_array(&arr)?;
            let bytes: Vec<u8> = got.into_iter().take(n as usize).collect();
            if bytes.is_empty() {
                return Ok(None);
            }
            self.note_rx(&bytes);
            Ok(Some(bytes[0]))
        }

        /// 读满 buf.len() 或超时, 返回已读字节数。
        pub fn read_exact(&self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
            let start = Instant::now();
            let mut n = 0;
            while n < buf.len() {
                if start.elapsed() > timeout {
                    break;
                }
                let vm = android_vm()?;
                let mut env = vm.attach_current_thread()?;
                let want = ((buf.len() - n) as i32).min(64);
                let (ep_in, arr) = {
                    let guard = self.inner.lock().unwrap();
                    (guard.ep_in.clone(), env.byte_array_from_slice(&[0u8; 64])?)
                };
                let conn = self.inner.lock().unwrap().conn.clone();
                let got = env
                    .call_method(
                        &conn,
                        "bulkTransfer",
                        "(Landroid/hardware/usb/UsbEndpoint;[BII)I",
                        &[
                            jni::objects::JValue::Object(ep_in.as_obj()),
                            jni::objects::JValue::Object(&arr),
                            jni::objects::JValue::Int(want),
                            jni::objects::JValue::Int(20),
                        ],
                    )?
                    .i()?;
                if got > 0 {
                    let bytes = env.convert_byte_array(&arr)?;
                    let take = (got as usize).min(buf.len() - n);
                    buf[n..n + take].copy_from_slice(&bytes[..take]);
                    self.note_rx(&buf[n..n + take]);
                    n += take;
                }
            }
            Ok(n)
        }

        /// 清空接收缓冲残留(把当前积压的字节全部读掉)。
        pub fn drain(&self) {
            let mut tmp = [0u8; 256];
            while let Ok(k) = self.read_exact(&mut tmp, Duration::from_millis(20)) {
                if k == 0 {
                    break;
                }
            }
        }

        /// 发送灯光: 0xB2 + 96 字节(32 格 RGB)
        pub fn write_led(&self, rgb: &[u8; 96]) -> Result<()> {
            let mut buf = [0u8; 97];
            buf[0] = crate::hardware::protocol::CMD_SET_LEDS;
            buf[1..].copy_from_slice(rgb);
            self.write_cmd(&buf)
        }

        /// 握手: 发 0xB0, 期待回 0xB0
        pub fn handshake(&self) -> Result<bool> {
            self.drain();
            self.write_cmd(&[crate::hardware::protocol::CMD_HANDSHAKE])?;
            let mut b = [0u8; 1];
            let n = self.read_exact(&mut b, Duration::from_millis(200))?;
            Ok(n > 0 && b[0] == crate::hardware::protocol::CMD_HANDSHAKE)
        }

        /// 查询 API 版本是否匹配
        pub fn check_api_level(&self) -> Result<bool> {
            self.write_cmd(&[crate::hardware::protocol::CMD_API_LEVEL])?;
            let mut b = [0u8; 1];
            let n = self.read_exact(&mut b, Duration::from_millis(200))?;
            Ok(n > 0 && b[0] == crate::hardware::protocol::API_LEVEL)
        }

        /// 读一帧输入(0xB1)
        pub fn read_input(&self) -> Result<crate::hardware::protocol::InputState> {
            self.write_cmd(&[crate::hardware::protocol::CMD_READ_INPUT])?;
            let mut buf = [0u8; crate::hardware::protocol::INPUT_RESPONSE_LEN];
            let n = self.read_exact(&mut buf, Duration::from_millis(30))?;
            crate::hardware::protocol::InputState::parse(&buf[..n])
                .ok_or_else(|| anyhow::anyhow!("输入帧不完整: {n}/33"))
        }

        /// Affine: 让设备开始轮流主动上报(先天键, 再触摸档位)
        pub fn affine_start_scan(&self) -> Result<()> {
            for frame in affine::start_scan_frames() {
                self.write_cmd(&frame)?;
            }
            Ok(())
        }

        /// Affine: 唤醒设备 —— 先发一帧 AIR 灯, 再发一帧 32 格白灯。
        /// 固件要收到一帧灯光才算真正启动(玩家说的「灯亮了才可以连接手台」)。
        pub fn affine_wake(&self) -> Result<()> {
            let _ = self.write_air_led_affine([0x00, 0xFF, 0x00]);
            self.write_led_affine(&[0xFFu8; 96])
        }

        pub fn write_led_affine(&self, rgb: &[u8; 96]) -> Result<()> {
            self.write_cmd(&affine::set_led(rgb))
        }

        pub fn write_air_led_affine(&self, rgb: [u8; 3]) -> Result<()> {
            self.write_cmd(&affine::set_air_led(rgb))
        }

        pub fn affine_stop_scan(&self) -> Result<()> {
            self.write_cmd(&affine::stop_scan_frame())
        }

        /// Affine 探测: 先点灯唤醒, 再开扫描, 收到 AUTO_SCAN(0x01)/AUTO_AIR(0x05) 即认定。
        /// 两段式窗口: 先 QUICK(2s) 快速判定, 设备开口才延长到完整 8s。
        pub fn affine_probe(&self) -> Result<bool> {
            self.drain();
            let mut dec = affine::Decoder::new();
            let mut deadline = Instant::now() + AFFINE_PROBE_QUICK;
            let mut next_nudge = Instant::now();
            let _ = self.affine_wake();
            self.affine_start_scan()?;
            let started = Instant::now();
            let mut saw_any = false;
            let mut saw_frame = false;
            while Instant::now() < deadline {
                if Instant::now() >= next_nudge {
                    let _ = self.affine_wake();
                    let _ = self.affine_start_scan();
                    next_nudge = Instant::now() + AFFINE_PROBE_NUDGE;
                }
                if Instant::now() >= deadline {
                    break;
                }
                let Some(b) = self.read_byte(Duration::from_millis(20))? else {
                    // 快速窗口内一个字节都没有 -> 这个设备不像有手台, 直接放弃。
                    if !saw_any && started.elapsed() >= AFFINE_PROBE_QUICK {
                        break;
                    }
                    continue;
                };
                // 设备开口了: 延长到完整窗口, 给慢启动/慢推帧的固件留足时间。
                if !saw_any {
                    deadline = Instant::now() + AFFINE_PROBE_WINDOW;
                }
                saw_any = true;
                if let Some(frame) = dec.push(b) {
                    saw_frame = true;
                    if frame.cmd == affine::CMD_AUTO_SCAN || frame.cmd == affine::CMD_AUTO_AIR {
                        return Ok(true);
                    }
                }
            }
            if saw_frame {
                eprintln!(
                    "[umg][hw] Affine 探测: 拆出了帧, 但没有 AUTO_SCAN(0x01/0x05)(原始字节: {})",
                    self.rx()
                );
            } else if saw_any {
                eprintln!(
                    "[umg][hw] Affine 探测: 收到字节, 但没拆出完整帧(原始字节: {})",
                    self.rx()
                );
            } else {
                eprintln!("[umg][hw] Affine 探测: 2s 内一个字节都没收到 —— 查 OTG 线/授权/供电");
            }
            Ok(false)
        }
    }
}
pub use imp::{list_ports, prepare_for_connect, Connection};

/// 自动连接: 按 USB 优先顺序枚举端口, 逐个探测协议, 找到第一个手台。
/// 返回 (端口名, 连接, 协议)。`force` 为 Some 时只认该协议。
pub fn connect_auto(force: Option<Kind>) -> Result<(String, Connection, Kind)> {
    let ports = prepare_for_connect();
    if ports.is_empty() {
        anyhow::bail!(
            "系统里一个串口都没有 —— 手台没插好、线是纯充电线, 或者缺 USB 串口驱动(见 README「手台」)"
        );
    }
    // 每个端口的结论都要留下来: 只报最后一个的话, 排在最后的蓝牙口会把真正有用的
    // 信息顶掉(macOS 上那条 /dev/…Bluetooth-Incoming-Port 就是这么冒出来的)。
    let mut tried: Vec<String> = Vec::with_capacity(ports.len());
    for name in &ports {
        match Connection::open(name) {
            Ok(conn) => match probe(&conn, force) {
                Ok(kind) => return Ok((name.clone(), conn, kind)),
                Err(e) => tried.push(format!("{name}: {e:#}")),
            },
            Err(e) => tried.push(format!("{name}: {e:#}")),
        }
    }
    anyhow::bail!(
        "试过 {} 个串口, 都不像手台 —— {} (可用 hardware.port 指定端口, 见 README「手台」)",
        tried.len(),
        tried.join(" | ")
    )
}

/// 连接指定端口(或自动)。
pub fn connect(port: Option<&str>, force: Option<Kind>) -> Result<(String, Connection, Kind)> {
    match port {
        Some(p) if !p.is_empty() => {
            let conn = Connection::open(p)?;
            let kind = probe(&conn, force)?;
            Ok((p.to_string(), conn, kind))
        }
        _ => connect_auto(force),
    }
}

/// 识别端口上挂的是哪种手台(或校验配置里强制的协议)
fn probe(conn: &Connection, force: Option<Kind>) -> Result<Kind> {
    match force {
        Some(Kind::Affine) => {
            conn.rx_reset();
            if conn.affine_probe()? {
                Ok(Kind::Affine)
            } else {
                anyhow::bail!("Affine 手台无响应(未收到 AUTO_SCAN 帧; 开扫描轮: {})", conn.rx())
            }
        }
        Some(Kind::Chu2Board) => {
            conn.rx_reset();
            let hit = conn.check_api_level().unwrap_or(false) && conn.handshake().unwrap_or(false);
            if hit {
                Ok(Kind::Chu2Board)
            } else {
                anyhow::bail!(
                    "chu2board 手台无响应(API 版本不符或握手失败; 轮询轮: {})",
                    conn.rx()
                )
            }
        }
        None => detect(conn),
    }
}

/// 自动探测: 先按 chu2board 问 API + 握手, 再按 Affine 开扫描等 AUTO_SCAN 帧。
///
/// 两种协议互不干扰: 官方滑块板(以及 Affine)会丢弃一切非 0xFF 开头的字节,
/// 所以先发的 0xB0/0xAF 不会影响它; 反过来 chu2board 固件只在收到命令时回包,
/// 收到 0xFF 开头的帧只会当作未知命令忽略。
fn detect(conn: &Connection) -> Result<Kind> {
    // 两轮分开记: 「轮询那轮收到什么」和「开扫描那轮收到什么」能看出是哪一侧在说话,
    // 也就能分清「设备没说话」和「说了但协议不对」。
    conn.rx_reset();
    let api_ok = conn.check_api_level().unwrap_or(false);
    if api_ok && conn.handshake().unwrap_or(false) {
        return Ok(Kind::Chu2Board);
    }
    let polled = conn.rx();
    conn.rx_reset();
    if conn.affine_probe().unwrap_or(false) {
        return Ok(Kind::Affine);
    }
    let scanning = conn.rx();
    if api_ok {
        anyhow::bail!(
            "chu2board 握手失败, 且未收到 Affine 扫描帧(轮询轮: {polled}; 开扫描轮: {scanning})"
        );
    }
    anyhow::bail!("API 版本不符, 且未收到 Affine 扫描帧(轮询轮: {polled}; 开扫描轮: {scanning})")
}

/// 供 mod.rs 复用
pub type SharedConn = Arc<Mutex<Option<Connection>>>;
