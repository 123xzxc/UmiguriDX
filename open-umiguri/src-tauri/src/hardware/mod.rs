//! 手台(控制器)与灯光硬件接入。
//!
//! 结构移植自 chu2board(串口手台协议 + UMIGURI LED WebSocket 服务端), 但接入方式不同:
//!   - chu2board 把输入转成键盘事件; 本项目直接把 38 个档位写进游戏读的
//!     `window.__umgLanes`(JS 侧收到 `umg-lanes` 事件后写入), 绕开键位映射;
//!   - 灯光: 游戏自带 `ledOutput` 会连 `ws://localhost:<led_controller.port>`,
//!     本模块起服务端接收 SetLED, 再转成手台的灯光帧写串口。
//!
//! 支持两种手台固件, 连上时自动识别(见 `serial::probe`):
//!   - **chu2board**: 单字节命令(0xB0/0xAF/0xB1/0xB2), 主机轮询读输入;
//!   - **Affine_IO**(<https://github.com/QHPaeek/Affine_IO>): 官方滑块板帧协议,
//!     主机发一次 AUTO_SCAN_START 后设备主动推「32 压力 + 1 天键位图」。
//! 也可用配置 `hardware.protocol = "chu2board" | "affine"` 强制指定。
//!
//! Android 无串口 API, 相关命令返回“不支持”(但 LED 服务端仍可启动)。
pub mod affine;
pub mod led_server;
pub mod mapping;
pub mod protocol;
pub mod serial;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use mapping::LedOrder;
use serial::SharedConn;

pub const LANES: usize = protocol::TOUCH_CHANNELS + protocol::AIR_SENSORS; // 38

/// 手台串口协议
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Kind {
    /// chu2board 固件
    #[default]
    Chu2Board,
    /// Affine_IO 手台
    Affine,
}

impl Kind {
    /// 解析配置里的协议名; 未知返回 None(保持自动探测)
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "chu2board" | "chu2" => Some(Kind::Chu2Board),
            "affine" | "affine_io" | "affineio" => Some(Kind::Affine),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Chu2Board => "chu2board",
            Kind::Affine => "affine",
        }
    }
}

pub struct HardwareState {
    conn: SharedConn,
    kind: Arc<Mutex<Kind>>,
    port: Mutex<Option<String>>,
    running: Arc<AtomicBool>,
    led_order: Arc<Mutex<LedOrder>>,
    led_client: Arc<AtomicBool>,
    /// 配置强制指定的协议(空 = 自动探测)
    force_kind: Mutex<Option<Kind>>,
    input_thread: Mutex<Option<thread::JoinHandle<()>>>,
    led_thread: Mutex<Option<thread::JoinHandle<()>>>,
    led_addr: Mutex<Option<String>>,
}

impl Default for HardwareState {
    fn default() -> Self {
        Self {
            conn: Arc::new(Mutex::new(None)),
            kind: Arc::new(Mutex::new(Kind::default())),
            port: Mutex::new(None),
            running: Arc::new(AtomicBool::new(false)),
            led_order: Arc::new(Mutex::new(LedOrder::default())),
            led_client: Arc::new(AtomicBool::new(false)),
            force_kind: Mutex::new(None),
            input_thread: Mutex::new(None),
            led_thread: Mutex::new(None),
            led_addr: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStatus {
    connected: bool,
    protocol: String,
    port: Option<String>,
    led_client: bool,
    led_addr: Option<String>,
    ports: Vec<String>,
}

fn status(st: &HardwareState) -> HardwareStatus {
    HardwareStatus {
        connected: st.conn.lock().unwrap().is_some(),
        protocol: st.kind.lock().unwrap().as_str().to_string(),
        port: st.port.lock().unwrap().clone(),
        led_client: st.led_client.load(Ordering::Relaxed),
        led_addr: st.led_addr.lock().unwrap().clone(),
        ports: serial::list_ports(),
    }
}

/// 启动 LED 服务端(幂等)。ledPort 来自握手的 led_controller.port。
#[tauri::command]
pub fn hw_init(
    app: AppHandle,
    led_port: Option<u16>,
    led_order: Option<String>,
    protocol: Option<String>,
    auto_connect: Option<bool>,
) -> bool {
    let st = app.state::<HardwareState>();
    if let Some(o) = led_order.as_deref() {
        *st.led_order.lock().unwrap() = LedOrder::parse(o);
    }
    if let Some(p) = protocol.as_deref().filter(|p| !p.is_empty()) {
        match Kind::parse(p) {
            Some(k) => {
                *st.force_kind.lock().unwrap() = Some(k);
                *st.kind.lock().unwrap() = k;
                eprintln!("[umg][hw] 手台协议指定为 {}", k.as_str());
            }
            None => eprintln!("[umg][hw] 未知的 hardware.protocol={p:?}, 将自动探测"),
        }
    }
    if auto_connect.unwrap_or(false) && st.conn.lock().unwrap().is_none() {
        autoconnect(app.clone());
    }
    if st.led_thread.lock().unwrap().is_some() {
        return true; // 已启动
    }
    let port = led_port.unwrap_or(8090);
    let addr = format!("127.0.0.1:{port}");
    let running = Arc::new(AtomicBool::new(true));
    match led_server::start(
        &addr,
        Arc::clone(&running),
        Arc::clone(&st.conn),
        Arc::clone(&st.led_order),
        Arc::clone(&st.kind),
        Arc::clone(&st.led_client),
    ) {
        Ok(Some(h)) => {
            *st.led_thread.lock().unwrap() = Some(h);
            *st.led_addr.lock().unwrap() = Some(addr);
            true
        }
        Ok(None) => false, // Android: 不支持
        Err(e) => {
            eprintln!("[umg][hw] LED 服务端启动失败: {e:#}");
            false
        }
    }
}

/// 连接手台串口; port 为空时自动探测(按 USB 优先顺序 + 协议识别)。
/// protocol 传 "chu2board"/"affine" 可强制协议, 为空则自动。
#[tauri::command]
pub fn hw_connect(
    app: AppHandle,
    port: Option<String>,
    protocol: Option<String>,
) -> Result<HardwareStatus, String> {
    let st = app.state::<HardwareState>();
    if let Some(p) = protocol.as_deref().filter(|p| !p.is_empty()) {
        if let Some(k) = Kind::parse(p) {
            *st.force_kind.lock().unwrap() = Some(k);
            *st.kind.lock().unwrap() = k;
        }
    }
    hw_disconnect(app.clone());
    let force = *st.force_kind.lock().unwrap();
    let (name, conn, kind) =
        serial::connect(port.as_deref(), force).map_err(|e| format!("{e:#}"))?;
    install(&app, &st, name.clone(), conn, kind)?;
    eprintln!("[umg][hw] 手台已连接: {name} ({})", kind.as_str());
    let _ = app.emit("umg-hw-status", status(&st));
    Ok(status(&st))
}

#[tauri::command]
pub fn hw_disconnect(app: AppHandle) -> bool {
    let st = app.state::<HardwareState>();
    st.running.store(false, Ordering::Relaxed);
    if let Some(h) = st.input_thread.lock().unwrap().take() {
        let _ = h.join();
    }
    // 断开前先停扫描/熄灯, 避免手台一直亮着或卡在按下的状态
    let kind = *st.kind.lock().unwrap();
    if let Some(c) = st.conn.lock().unwrap().as_ref() {
        match kind {
            Kind::Affine => {
                let _ = c.affine_stop_scan();
                let _ = c.write_led_affine(&[0u8; 96]);
            }
            Kind::Chu2Board => {
                let _ = c.write_led(&[0u8; 96]);
            }
        }
    }
    *st.conn.lock().unwrap() = None;
    *st.port.lock().unwrap() = None;
    // 掉线时清空档位, 避免卡住一直按着
    let _ = app.emit("umg-lanes", vec![0u8; LANES]);
    let _ = app.emit("umg-hw-status", status(&st));
    true
}

#[tauri::command]
pub fn hw_status(app: AppHandle) -> HardwareStatus {
    let st = app.state::<HardwareState>();
    status(&st)
}

#[tauri::command]
pub fn hw_list_ports() -> Vec<String> {
    serial::list_ports()
}

/// 记录已连接的手台并起输入线程。
fn install(
    app: &AppHandle,
    st: &HardwareState,
    name: String,
    conn: serial::Connection,
    kind: Kind,
) -> Result<(), String> {
    *st.conn.lock().unwrap() = Some(conn);
    *st.kind.lock().unwrap() = kind;
    *st.port.lock().unwrap() = Some(name);
    st.running.store(true, Ordering::Relaxed);
    let running = Arc::clone(&st.running);
    let conn2 = Arc::clone(&st.conn);
    let app2 = app.clone();
    let handle = thread::Builder::new()
        .name("umg-hw-input".into())
        .spawn(move || input_loop(app2, conn2, running, kind))
        .map_err(|e| e.to_string())?;
    *st.input_thread.lock().unwrap() = Some(handle);
    Ok(())
}

/// 输入轮询: 按协议读输入 → 映射成 38 个档位 → 有变化才通知 JS。
fn input_loop(app: AppHandle, conn: SharedConn, running: Arc<AtomicBool>, kind: Kind) {
    match kind {
        Kind::Chu2Board => input_loop_poll(app, conn, running),
        Kind::Affine => input_loop_stream(app, conn, running),
    }
}

/// 输入状态 → 38 个档位(2*i = 第 i 档上排, 2*i+1 = 下排, 32..37 = 6 个 air)
fn lanes_of(state: &protocol::InputState) -> Vec<u8> {
    let mut lanes = vec![0u8; LANES];
    for ch in 1..=protocol::TOUCH_CHANNELS {
        if !state.touch_pressed(ch - 1) {
            continue;
        }
        if let Some(idx) = mapping::umiguri_index_of_channel(ch) {
            lanes[idx] = 1;
        }
    }
    for bit in 0..protocol::AIR_SENSORS {
        if state.air_pressed(bit) {
            lanes[mapping::umiguri_air_index(bit)] = 1;
        }
    }
    lanes
}

/// chu2board: 主机发 0xB1 轮询一帧
fn input_loop_poll(app: AppHandle, conn: SharedConn, running: Arc<AtomicBool>) {
    let mut prev = vec![0u8; LANES];
    let mut fail = 0u32;
    while running.load(Ordering::Relaxed) {
        let state = {
            let guard = conn.lock().unwrap();
            match guard.as_ref() {
                Some(c) => c.read_input(),
                None => break,
            }
        };
        match state {
            Ok(s) => {
                fail = 0;
                let lanes = lanes_of(&s);
                if lanes != prev {
                    prev = lanes.clone();
                    let _ = app.emit("umg-lanes", lanes);
                }
                thread::sleep(Duration::from_millis(1));
            }
            Err(_) => {
                fail += 1;
                if fail > 30 {
                    eprintln!("[umg][hw] 输入读取连续失败, 断开手台");
                    let _ = app.emit("umg-lanes", vec![0u8; LANES]);
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

/// Affine: 设备在收到 AUTO_SCAN_START 后主动推帧, 这里只负责拆帧。
fn input_loop_stream(app: AppHandle, conn: SharedConn, running: Arc<AtomicBool>) {
    let mut prev = vec![0u8; LANES];
    let mut decoder = affine::Decoder::new();
    let mut fail = 0u32;
    let mut last_frame = Instant::now();
    let mut last_nudge = Instant::now();
    while running.load(Ordering::Relaxed) {
        let read = {
            let guard = conn.lock().unwrap();
            match guard.as_ref() {
                Some(c) => Some(c.read_byte(Duration::from_millis(20))),
                None => None,
            }
        };
        let Some(read) = read else { break };
        match read {
            Ok(Some(byte)) => {
                fail = 0;
                if let Some(frame) = decoder.push(byte) {
                    last_frame = Instant::now();
                    if frame.cmd == affine::CMD_AUTO_SCAN {
                        if let Some(state) = affine::parse_scan(&frame.payload) {
                            let lanes = lanes_of(&state);
                            if lanes != prev {
                                prev = lanes.clone();
                                let _ = app.emit("umg-lanes", lanes);
                            }
                        }
                    }
                }
            }
            // 空闲: 超过 1s 收不到帧说明扫描没开起来(例如设备刚复位), 补发一次
            Ok(None) => {
                if last_frame.elapsed() > Duration::from_secs(1)
                    && last_nudge.elapsed() > Duration::from_secs(1)
                {
                    last_nudge = Instant::now();
                    if let Some(c) = conn.lock().unwrap().as_ref() {
                        let _ = c.affine_start_scan();
                    }
                }
            }
            Err(_) => {
                fail += 1;
                if fail > 30 {
                    eprintln!("[umg][hw] 输入读取连续失败, 断开手台");
                    let _ = app.emit("umg-lanes", vec![0u8; LANES]);
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

/// 启动时按需自动连接(在后台线程里探测, 不阻塞启动)。
pub fn autoconnect(app: AppHandle) {
    thread::spawn(move || {
        let st = app.state::<HardwareState>();
        let force = *st.force_kind.lock().unwrap();
        match serial::connect_auto(force) {
            Ok((name, conn, kind)) => {
                if let Err(e) = install(&app, &st, name.clone(), conn, kind) {
                    eprintln!("[umg][hw] 手台输入线程启动失败: {e}");
                    return;
                }
                eprintln!(
                    "[umg][hw] 手台自动连接成功: {name} ({})",
                    kind.as_str()
                );
                let _ = app.emit("umg-hw-status", status(&st));
            }
            Err(e) => eprintln!("[umg][hw] 未连接手台: {e:#}"),
        }
    });
}