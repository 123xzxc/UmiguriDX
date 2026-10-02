//! 用**真实串口设备**验证 Affine 探测(不是 mock)。
//!
//! 背景(2026-10 案例): 玩家必须先在终端跑一遍 mac-hw-probe.py, 游戏里的宿主才连得上手台。
//! 那个脚本第 [0] 步会「什么都不发、最多听 20 秒」, 而宿主的探测窗口只有 1.2 秒 ——
//! 说明设备要过好几秒才开口, 宿主每轮都提前放弃了。
//!
//! 这里用一对 PTY 模拟手台(Unix 上 PTY 就是真串口设备, serialport 走的是同一套代码路径):
//!   - 从设备端写字节, 主端(被测代码)能不能读到;
//!   - 设备端可以被要求「等 N 秒再开口」, 用来复现上面那个场景。
//!
//! 只在 Unix 上有意义(PTY 是 Unix 的东西; 手台连不上也是 macOS/Linux 的问题)。
#![cfg(unix)]

use std::ffi::CString;
use std::os::unix::io::RawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 裸 libc 声明: 免得为了一个测试给 Cargo.toml 加依赖。
mod ffi {
    use std::os::unix::io::RawFd;

    extern "C" {
        pub fn posix_openpt(flags: i32) -> i32;
        pub fn grantpt(fd: i32) -> i32;
        pub fn unlockpt(fd: i32) -> i32;
        pub fn ptsname(fd: i32) -> *mut i8;
        pub fn cfmakeraw(t: *mut Termios) -> i32;
        pub fn cfsetspeed(t: *mut Termios, speed: u32) -> i32;
        pub fn tcsetattr(fd: i32, act: i32, t: *const Termios) -> i32;
        pub fn tcgetattr(fd: i32, t: *mut Termios) -> i32;
        pub fn open(path: *const i8, flags: i32) -> i32;
        pub fn read(fd: i32, buf: *mut u8, n: usize) -> isize;
        pub fn write(fd: i32, buf: *const u8, n: usize) -> isize;
        pub fn close(fd: i32) -> i32;
    }

    /// 跟着平台走: Darwin 与 Linux 的 termios 布局不一样, 直接照着系统头写。
    /// (两个平台前 4 个标志 + c_cc[20] 的布局一致, 速度字段排在后面。)
    #[repr(C)]
    pub struct Termios {
        pub c_iflag: u32,
        pub c_oflag: u32,
        pub c_cflag: u32,
        pub c_lflag: u32,
        pub c_cc: [u8; 20],
        pub c_ispeed: u32,
        pub c_ospeed: u32,
    }

    pub const O_RDWR: i32 = 2;
    #[cfg(target_os = "macos")]
    pub const O_NOCTTY: i32 = 0x20000;
    #[cfg(not(target_os = "macos"))]
    pub const O_NOCTTY: i32 = 0o400;
    pub const TCSANOW: i32 = 0;
}

/// 开一对 PTY: 返回 (主端 fd, 从端路径)。主端给「被测代码」当串口, 从端给「假手台」写数据。
fn open_pty_master() -> (RawFd, PathBuf) {
    unsafe {
        let master = ffi::posix_openpt(ffi::O_RDWR | ffi::O_NOCTTY);
        assert!(master >= 0, "posix_openpt 失败");
        assert_eq!(ffi::grantpt(master), 0, "grantpt 失败");
        assert_eq!(ffi::unlockpt(master), 0, "unlockpt 失败");
        let name = ffi::ptsname(master);
        assert!(!name.is_null(), "ptsname 失败");
        let slave = std::ffi::CStr::from_ptr(name).to_string_lossy().into_owned();
        (master, PathBuf::from(slave))
    }
}

/// 115200 8N1 原始模式 —— 与手台一致
fn raw_mode(fd: RawFd, baud: u32) {
    unsafe {
        let mut t: ffi::Termios = std::mem::zeroed();
        assert_eq!(ffi::tcgetattr(fd, &mut t), 0, "tcgetattr 失败");
        ffi::cfmakeraw(&mut t);
        ffi::cfsetspeed(&mut t, baud);
        assert_eq!(ffi::tcsetattr(fd, ffi::TCSANOW, &t), 0, "tcsetattr 失败");
    }
}

/// 假手台: 打开从端, 等 delay 之后开始每 100ms 推一帧真机 AUTO_SCAN
struct FakeHandset {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl FakeHandset {
    fn start(slave: PathBuf, delay: Duration) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let handle = std::thread::spawn(move || {
            let c = CString::new(slave.to_string_lossy().as_bytes()).unwrap();
            let fd = unsafe { ffi::open(c.as_ptr(), ffi::O_RDWR | ffi::O_NOCTTY) };
            assert!(fd >= 0, "打开 PTY 从端失败");
            raw_mode(fd, 115200);
            std::thread::sleep(delay);
            // 真机帧: FF 01 21 <32 压力> <天键> E0 00
            let mut frame = vec![0xFFu8, 0x01, 0x21];
            frame.extend(std::iter::repeat(0xFEu8).take(32));
            frame.extend([0x00, 0xE0, 0x00]);
            while !stop2.load(Ordering::Relaxed) {
                unsafe { ffi::write(fd, frame.as_ptr(), frame.len()) };
                std::thread::sleep(Duration::from_millis(100));
            }
            unsafe { ffi::close(fd) };
        });
        Self { stop, handle: Some(handle) }
    }
}

impl Drop for FakeHandset {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 量「第一字节多久才到」
fn first_byte_within(fd: RawFd, budget: Duration) -> Option<(u8, Duration)> {
    let start = Instant::now();
    let mut buf = [0u8; 1];
    while start.elapsed() < budget {
        let n = unsafe { ffi::read(fd, buf.as_mut_ptr(), 1) };
        if n == 1 {
            return Some((buf[0], start.elapsed()));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

/// **这条就是根因**: 设备 4 秒才开口, 而宿主只等 1.2 秒 → 每轮都提前放弃。
#[test]
fn slow_handset_opens_later_than_the_1_2s_probe_window() {
    let (master, slave) = open_pty_master();
    raw_mode(master, 115200);
    let delay = Duration::from_secs(4);
    let _handset = FakeHandset::start(slave, delay);

    let (first, waited) = first_byte_within(master, Duration::from_secs(12))
        .expect("12 秒内应该收到第一字节");

    assert_eq!(first, 0xFF, "第一字节应该是帧同步 0xFF");
    assert!(
        waited >= delay,
        "第一字节不该早于设备开口时间({delay:?}), 实际 {waited:?}"
    );
    assert!(
        waited > Duration::from_millis(1200),
        "复现失败: 第一字节 {waited:?} 就来了, 没超过旧的 1.2s 窗口"
    );
    unsafe { ffi::close(master) };
}

/// 反面对照: 很快开口的设备, 旧窗口也够用 —— 说明问题只在慢启动这一侧
#[test]
fn fast_handset_answers_well_within_the_old_window() {
    let (master, slave) = open_pty_master();
    raw_mode(master, 115200);
    let _handset = FakeHandset::start(slave, Duration::from_millis(50));

    let (first, waited) = first_byte_within(master, Duration::from_secs(3))
        .expect("很快开口的设备应该马上能看到字节");
    assert_eq!(first, 0xFF);
    assert!(
        waited < Duration::from_millis(1200),
        "快设备应该落在旧窗口内, 实际 {waited:?}"
    );
    unsafe { ffi::close(master) };
}
