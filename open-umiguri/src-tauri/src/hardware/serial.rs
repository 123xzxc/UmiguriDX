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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
    pub const BAUD_RATE: u32 = 115_200;
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
            })
        }

        pub fn write_cmd(&self, cmd: &[u8]) -> Result<()> {
            let mut port = self.port.lock().unwrap();
            port.write_all(cmd).context("发送命令失败")?;
            port.flush().ok();
            Ok(())
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
                    Ok(k) => n += k,
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
                    Ok(_) => return Ok(Some(b[0])),
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
        /// 窗口给到 ~1.2s 并且中途补发扫描命令, 是因为: 刚上电/DTR 刚拉高时固件可能还在
        /// 初始化, 头几百毫秒不作声; 个别固件还会丢掉第一次 AUTO_SCAN_START。
        pub fn affine_probe(&self) -> Result<bool> {
            self.drain();
            let mut dec = affine::Decoder::new();
            let deadline = Instant::now() + Duration::from_millis(1200);
            let mut next_nudge = Instant::now();
            self.affine_start_scan()?;
            while Instant::now() < deadline {
                if Instant::now() >= next_nudge {
                    let _ = self.affine_start_scan();
                    next_nudge = Instant::now() + Duration::from_millis(400);
                }
                let Some(b) = self.read_byte(Duration::from_millis(20))? else {
                    continue;
                };
                if let Some(frame) = dec.push(b) {
                    // 0x01 = 触摸(可能带天键), 0x05 = 单独上报的天键: 都是官方滑块帧协议。
                    if frame.cmd == affine::CMD_AUTO_SCAN || frame.cmd == affine::CMD_AUTO_AIR {
                        return Ok(true);
                    }
                }
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

#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
    use super::Result;
    use std::time::Duration;

    pub fn list_ports() -> Vec<String> {
        Vec::new()
    }

    pub fn sort_for_connect(_ports: &mut [String]) {}

    #[derive(Clone)]
    pub struct Connection;

    impl Connection {
        pub fn open(_name: &str) -> Result<Self> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn check_api_level(&self) -> Result<bool> {
            Ok(false)
        }
        pub fn handshake(&self) -> Result<bool> {
            Ok(false)
        }
        pub fn read_input(&self) -> Result<crate::hardware::protocol::InputState> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn read_byte(&self, _timeout: Duration) -> Result<Option<u8>> {
            Ok(None)
        }
        pub fn write_led(&self, _rgb: &[u8; 96]) -> Result<()> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn affine_start_scan(&self) -> Result<()> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn affine_stop_scan(&self) -> Result<()> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn write_led_affine(&self, _rgb: &[u8; 96]) -> Result<()> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn write_air_led_affine(&self, _rgb: [u8; 3]) -> Result<()> {
            anyhow::bail!("Android 不支持串口手台")
        }
        pub fn affine_probe(&self) -> Result<bool> {
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
            if conn.affine_probe()? {
                Ok(Kind::Affine)
            } else {
                anyhow::bail!("Affine 手台无响应(未收到 AUTO_SCAN 帧)")
            }
        }
        Some(Kind::Chu2Board) => {
            if conn.check_api_level().unwrap_or(false) && conn.handshake().unwrap_or(false) {
                Ok(Kind::Chu2Board)
            } else {
                anyhow::bail!("chu2board 手台无响应(API 版本不符或握手失败)")
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
    let api_ok = conn.check_api_level().unwrap_or(false);
    if api_ok && conn.handshake().unwrap_or(false) {
        return Ok(Kind::Chu2Board);
    }
    if conn.affine_probe().unwrap_or(false) {
        return Ok(Kind::Affine);
    }
    if api_ok {
        anyhow::bail!("chu2board 握手失败, 且未收到 Affine 扫描帧");
    }
    anyhow::bail!("API 版本不符, 且未收到 Affine 扫描帧")
}

/// 供 mod.rs 复用
pub type SharedConn = Arc<Mutex<Option<Connection>>>;
