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
            let port = serialport::new(name, BAUD_RATE)
                .timeout(Duration::from_millis(5))
                .open()
                .with_context(|| format!("打开串口失败: {name}"))?;
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

        /// Affine 探测: 开扫描后 400ms 内收到 AUTO_SCAN 帧即认定是 Affine 手台。
        /// 官方/chu2board 固件会把非 0xFF 开头的字节直接丢掉, 所以探测是安全的。
        pub fn affine_probe(&self) -> Result<bool> {
            self.drain();
            self.affine_start_scan()?;
            let mut dec = affine::Decoder::new();
            let deadline = Instant::now() + Duration::from_millis(400);
            while Instant::now() < deadline {
                if let Some(b) = self.read_byte(Duration::from_millis(20))? {
                    if let Some(frame) = dec.push(b) {
                        if frame.cmd == affine::CMD_AUTO_SCAN {
                            return Ok(true);
                        }
                    }
                }
            }
            Ok(false)
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

pub use imp::{list_ports, sort_for_connect, Connection};

/// 自动连接: 按 USB 优先顺序枚举端口, 逐个探测协议, 找到第一个手台。
/// 返回 (端口名, 连接, 协议)。`force` 为 Some 时只认该协议。
pub fn connect_auto(force: Option<Kind>) -> Result<(String, Connection, Kind)> {
    let mut ports = list_ports();
    if ports.is_empty() {
        anyhow::bail!("没有可用串口");
    }
    sort_for_connect(&mut ports);
    let mut last_err = String::from("未找到手台");
    for name in &ports {
        match Connection::open(name) {
            Ok(conn) => match probe(&conn, force) {
                Ok(kind) => return Ok((name.clone(), conn, kind)),
                Err(e) => last_err = format!("{name}: {e}"),
            },
            Err(e) => last_err = format!("{name}: {e}"),
        }
    }
    anyhow::bail!("{last_err}")
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
