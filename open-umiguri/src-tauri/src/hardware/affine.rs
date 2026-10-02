//! Affine_IO 手台协议(<https://github.com/QHPaeek/Affine_IO>, chuniio/serialslider.c)。
//!
//! 帧结构与官方 Sega 滑块板完全一致(参考 segatools `board/slider-frame.c`):
//!
//! ```text
//! [0xFF][cmd][nbytes][payload ...][checksum]
//! ```
//!
//!   - checksum = 本帧之前所有字节(含 sync)之和取负, 即整帧各字节相加 == 0;
//!
//! **实机补充**(macOS 上抓包得到): 手台的 `AUTO_SCAN` 帧实际是 **38 字节**:
//! `FF 01 21 <32 压力> <天键> <x> <y>`。末尾那两字节既不是「整帧和为 0」, 也不是
//! 我们试过的任何变体(`x` 恰好等于 `sync + size + 载荷`, 就像漏算了 cmd 那一个字节;
//! `y` 恒为 `0x00`)。Affine 的参考宿主收侧**从不校验**校验和, 所以这里收侧也只按
//! 结构收帧(`0xFF` 同步 + cmd + size + 载荷收满), 校验和只记进 `Frame::checksum_ok`
//! 当参考 —— 拿它当硬门槛会把「每 100ms 都在推的帧」全丢掉。
//!   - 0xFD 是转义前缀: 0xFF 发 `FD FE`, 0xFD 发 `FD FC`, 收侧把 `FD x` 还原成 `x+1`。
//!
//! Affine 在官方协议上追加了自定义命令(同一个串口顺带做 JVS 板的天键/AIR 灯):
//!   0x05 AUTO_AIR / 0x06 AUTO_AIR_START / 0x07 SET_AIR_LED。
//!
//! 与 chu2board 协议(0xB0/0xAF/0xB1/0xB2 单字节命令)完全不同, 二者靠
//! 「发 AUTO_SCAN_START 后设备是否持续推 AUTO_SCAN 帧」来区分。
#![allow(dead_code)]

use super::protocol::InputState;

/// 帧同步字节
pub const SYNC: u8 = 0xFF;
/// 转义前缀(其后的字节 +1 才是原值)
pub const ESC: u8 = 0xFD;

// 命令(见 Affine_IO/chuniio/serialslider.h)
pub const CMD_AUTO_SCAN: u8 = 0x01; // 设备 → 主机: 32 压力 + (自定义)1 天键位图
pub const CMD_SET_LED: u8 = 0x02; // 主机 → 设备: 1 未知字节 + 96 字节 RGB
pub const CMD_AUTO_SCAN_START: u8 = 0x03;
pub const CMD_AUTO_SCAN_STOP: u8 = 0x04;
pub const CMD_AUTO_AIR: u8 = 0x05;
pub const CMD_AUTO_AIR_START: u8 = 0x06;
pub const CMD_SET_AIR_LED: u8 = 0x07; // 主机 → 设备: 3 字节 RGB(整条 AIR 灯一个颜色)
pub const CMD_RESET: u8 = 0x10;

pub const TOUCH_CHANNELS: usize = 32;
pub const AIR_SENSORS: usize = 6;

/// SET_LED 载荷长度: 1 字节未知(官方固定 0x28) + 96 字节 RGB(32 格)
pub const LED_PAYLOAD: usize = 97;
/// SET_LED 载荷首字节, 官方协议固定 0x28(含义未知)
const SET_LED_TAG: u8 = 0x28;
/// 载荷长度上限(nbytes 只有一个字节, 留足余量即可)
const MAX_PAYLOAD: usize = 255;

/// 按 Affine/官方协议组帧(自动转义 + 校验和)。
pub fn encode(cmd: u8, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() <= MAX_PAYLOAD);
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(SYNC);

    let mut sum = SYNC;
    for &b in [cmd, payload.len() as u8].iter().chain(payload.iter()) {
        sum = sum.wrapping_add(b);
        push_escaped(&mut out, b);
    }
    push_escaped(&mut out, 0u8.wrapping_sub(sum));
    out
}

/// 灯光帧: 96 字节 = 32 格 RGB(格子顺序与 32 个触摸通道一致)
pub fn set_led(rgb: &[u8; 96]) -> Vec<u8> {
    let mut payload = [0u8; LED_PAYLOAD];
    payload[0] = SET_LED_TAG;
    payload[1..].copy_from_slice(rgb);
    encode(CMD_SET_LED, &payload)
}

/// AIR 灯帧: 3 字节 RGB
pub fn set_air_led(rgb: [u8; 3]) -> Vec<u8> {
    encode(CMD_SET_AIR_LED, &rgb)
}

/// 开始轮流扫描: 先开天键(IR), 再开触摸档位 —— 与 Affine 的
/// `chuni_io_slider_start()` 顺序一致。
pub fn start_scan_frames() -> [Vec<u8>; 2] {
    [
        encode(CMD_AUTO_AIR_START, &[]),
        encode(CMD_AUTO_SCAN_START, &[]),
    ]
}

/// 停止扫描(断开手台前调用)
pub fn stop_scan_frame() -> Vec<u8> {
    encode(CMD_AUTO_SCAN_STOP, &[])
}

fn push_escaped(out: &mut Vec<u8>, byte: u8) {
    if byte == SYNC || byte == ESC {
        out.push(ESC);
        out.push(byte - 1);
    } else {
        out.push(byte);
    }
}

/// 一帧数据
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub cmd: u8,
    pub payload: Vec<u8>,
    /// 校验和对不对得上(「整帧和为 0」或「线上字节和为 0」任一成立)。
    ///
    /// 只作参考信息, **不参与收不收这一帧的判断**: 实测手台(Linnea 固件)的帧两条
    /// 都不成立(它那两字节的算法还没对上), 而 Affine 的参考宿主收侧从不校验校验和。
    pub checksum_ok: bool,
}

/// 流式拆帧: 逐字节喂入, 结构收满一帧就返回。
///
/// 判定只看结构: `0xFF` 同步 + `cmd` + `size`(≤ MAX_PAYLOAD) + 载荷收满。校验和只
/// 顺带算一下放进 `Frame::checksum_ok`, 不参与判定 —— 理由见 `Frame::checksum_ok`。
///
/// (踩过的坑: 一度要求「未转义后整帧字节和 == 0」才收, 结果手台每 100ms 推一帧、
/// 宿主却一帧都不认, 报成「未收到 Affine 扫描帧」。参考实现收侧从不校验校验和,
/// 我们也不该拿它当硬门槛。)
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    wire: Vec<u8>,
    escape: bool,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开始/重开一帧: 逻辑缓冲与线上缓冲都只留这个 sync 字节
    fn restart(&mut self, byte: u8) {
        self.buf.clear();
        self.wire.clear();
        self.buf.push(byte);
        self.wire.push(byte);
        self.escape = false;
    }

    pub fn push(&mut self, byte: u8) -> Option<Frame> {
        if self.buf.is_empty() {
            // 未同步: 丢弃直到出现 sync(官方 slider_frame_sync 同义)
            if byte != SYNC {
                return None;
            }
            self.restart(byte);
            return None;
        }
        if byte == SYNC {
            // 帧内再遇 sync: 视为(上一帧丢失后)新帧起点
            self.restart(byte);
            return None;
        }
        self.wire.push(byte);
        let value = if byte == ESC {
            if self.escape {
                // 连续两个转义前缀: 帧损坏, 重新同步
                self.buf.clear();
                self.wire.clear();
                self.escape = false;
                return None;
            }
            self.escape = true;
            return None;
        } else if self.escape {
            self.escape = false;
            byte.wrapping_add(1)
        } else {
            byte
        };

        self.buf.push(value);
        if self.buf.len() < 3 {
            return None;
        }
        let nbytes = self.buf[2] as usize;
        if nbytes > MAX_PAYLOAD {
            self.buf.clear();
            self.wire.clear();
            return None;
        }
        if self.buf.len() < nbytes + 4 {
            return None;
        }

        let logical_sum = self.buf.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let wire_sum = self.wire.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let cmd = self.buf[1];
        let payload = self.buf[3..3 + nbytes].to_vec();
        self.buf.clear();
        self.wire.clear();
        Some(Frame {
            cmd,
            payload,
            checksum_ok: logical_sum == 0 || wire_sum == 0,
        })
    }
}

/// AUTO_SCAN 载荷 → 输入状态。
/// 官方板只有 32 字节压力; Affine 会多一个字节(低 6 位 = 6 个天键)。
pub fn parse_scan(payload: &[u8]) -> Option<InputState> {
    if payload.len() < TOUCH_CHANNELS {
        return None;
    }
    let mut state = InputState::default();
    state.touch.copy_from_slice(&payload[..TOUCH_CHANNELS]);
    if payload.len() > TOUCH_CHANNELS {
        state.air = payload[TOUCH_CHANNELS];
    }
    Some(state)
}

/// 天键(AIR)状态: 0x05 AUTO_AIR 的载荷只有 1 字节位图(对应 slider_packet_t 的 _air_status)。
/// 部分固件把天键单独用这个命令上报, 触摸走 AUTO_SCAN(见 Affine_IO/chuniio/chuniio.c)。
pub fn parse_air(payload: &[u8]) -> Option<u8> {
    payload.first().copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 线上字节 → 逻辑字节(还原 0xFD 转义)
    fn unstuff(frame: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < frame.len() {
            if i > 0 && frame[i] == ESC {
                out.push(frame[i + 1].wrapping_add(1));
                i += 2;
                continue;
            }
            out.push(frame[i]);
            i += 1;
        }
        out
    }

    /// 整帧逻辑字节之和应为 0
    fn checksum_ok(frame: &[u8]) -> bool {
        unstuff(frame).iter().fold(0u8, |a, &b| a.wrapping_add(b)) == 0
    }

    #[test]
    fn encode_matches_reference_frames() {
        // Affine_IO 里 slider_start_scan(): syn=0xff cmd=0x03 size=0 → 校验 0xFE
        assert_eq!(encode(CMD_AUTO_SCAN_START, &[]), vec![0xFF, 0x03, 0x00, 0xFE]);
        // slider_start_air_scan(): cmd=0x06 → 校验 0xFB
        assert_eq!(encode(CMD_AUTO_AIR_START, &[]), vec![0xFF, 0x06, 0x00, 0xFB]);
        // 校验和 0xFD 本身也要转义 → FD FC
        assert_eq!(
            encode(CMD_AUTO_SCAN_STOP, &[]),
            vec![0xFF, 0x04, 0x00, 0xFD, 0xFC]
        );
        for f in [encode(CMD_AUTO_SCAN_START, &[]), encode(CMD_RESET, &[])] {
            assert!(checksum_ok(&f), "整帧字节和应为 0: {f:02X?}");
        }
    }

    #[test]
    fn escape_never_leaves_raw_sync_or_esc_in_frame() {
        let rgb = [0xFFu8; 96];
        let frame = set_led(&rgb);
        // 帧首是 sync, 之后不得出现裸 0xFF(0xFD 只能成对出现)
        assert_eq!(frame[0], SYNC);
        let mut i = 1;
        while i < frame.len() {
            assert_ne!(frame[i], SYNC, "帧内出现未转义的 sync");
            i += if frame[i] == ESC { 2 } else { 1 };
        }
        assert!(checksum_ok(&frame));
        // 转义只改变线上字节, 逻辑帧仍是 cmd + size + 载荷 + 校验
        let logical = unstuff(&frame);
        assert_eq!(logical.len(), LED_PAYLOAD + 4);
        assert_eq!(logical[3], SET_LED_TAG);
        assert_eq!(&logical[4..4 + rgb.len()], &rgb[..]);

        // 含 0xFF/0xFD 的 AIR 灯帧同样能还原
        let air = set_air_led([0xFD, 0xFF, 0x00]);
        let logical = unstuff(&air);
        assert_eq!(&logical[..6], &[0xFF, CMD_SET_AIR_LED, 3, 0xFD, 0xFF, 0x00]);
        assert!(checksum_ok(&air));
    }

    #[test]
    fn set_led_frame_layout() {
        let mut rgb = [0u8; 96];
        rgb[0] = 0x11;
        rgb[95] = 0x22;
        let frame = set_led(&rgb);
        // 全 0 灯光不会被转义, 可直接按明文核对
        assert_eq!(&frame[..4], &[0xFF, 0x02, 97, 0x28]);
        assert_eq!(frame[4], 0x11);
        assert_eq!(frame[99], 0x22);
        assert_eq!(frame.len(), 101); // sync+cmd+size+97+校验
    }

    #[test]
    fn decoder_round_trips_all_commands() {
        let mut rgb = [0u8; 96];
        for (i, b) in rgb.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7);
        }
        let frames = vec![
            encode(CMD_AUTO_SCAN_START, &[]),
            set_led(&rgb),
            set_air_led([0x01, 0xFD, 0xFF]),
            encode(CMD_RESET, &[]),
        ];
        let mut dec = Decoder::new();
        let mut got = Vec::new();
        for f in &frames {
            for &b in f {
                if let Some(frame) = dec.push(b) {
                    got.push(frame);
                }
            }
        }
        assert_eq!(got.len(), frames.len());
        assert_eq!(got[0].cmd, CMD_AUTO_SCAN_START);
        assert_eq!(got[1].cmd, CMD_SET_LED);
        assert_eq!(got[1].payload.len(), LED_PAYLOAD);
        assert_eq!(got[1].payload[0], SET_LED_TAG);
        assert_eq!(&got[1].payload[1..], &rgb[..]);
        assert_eq!(got[2].payload, vec![0x01, 0xFD, 0xFF]);
        assert_eq!(got[3].cmd, CMD_RESET);
    }

    #[test]
    fn decoder_skips_garbage_and_accepts_next_frame() {
        let good = encode(CMD_AUTO_SCAN_START, &[]);
        let mut dec = Decoder::new();
        let mut got = None;
        for b in [0x00u8, 0x12, 0xAB] {
            assert!(dec.push(b).is_none());
        }
        for b in good {
            if let Some(f) = dec.push(b) {
                got = Some(f);
            }
        }
        assert_eq!(got.map(|f| f.cmd), Some(CMD_AUTO_SCAN_START));
    }

    /// 线上和规则(连 0xFD 转义字节一起算)的帧也要认 —— 手台固件就是这么算的
    #[test]
    fn decoder_accepts_wire_rule_checksum() {
        let payload = [0xFFu8, 0xFD, 0x00];
        let mut wire = vec![SYNC];
        for &b in [CMD_AUTO_SCAN, payload.len() as u8].iter().chain(payload.iter()) {
            if b == SYNC || b == ESC {
                wire.push(ESC);
                wire.push(b - 1);
            } else {
                wire.push(b);
            }
        }
        // 校验和按「线上字节」算(this payload 凑出来是 0x09, 不用再转义)
        let sum = wire.iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let chk = 0u8.wrapping_sub(sum);
        assert_ne!(chk, SYNC);
        assert_ne!(chk, ESC);
        wire.push(chk);
        // 逻辑和不为 0 —— 只认旧规则的实现会把这帧判成坏帧
        assert_ne!(unstuff(&wire).iter().fold(0u8, |a, &b| a.wrapping_add(b)), 0);

        let mut dec = Decoder::new();
        let mut got = None;
        for b in wire {
            if let Some(f) = dec.push(b) {
                got = Some(f);
            }
        }
        let f = got.expect("线上和规则的帧应该被接受");
        assert_eq!(f.cmd, CMD_AUTO_SCAN);
        assert_eq!(f.payload, payload.to_vec());
        assert!(f.checksum_ok, "线上和规则算出来的帧应被标成校验通过");
    }

    /// 校验和对不上也照样收下(只是 checksum_ok = false)—— 实测手台固件就是这样,
    /// 参考宿主收侧也从不校验。
    #[test]
    fn decoder_keeps_frame_with_unknown_checksum() {
        let mut frame = encode(CMD_AUTO_SCAN_START, &[]);
        frame[3] ^= 0x02; // 篡改校验和(别改成 0xFF, 那是同步字节, 会让这一帧重新起头)
        let mut dec = Decoder::new();
        let mut got = None;
        for b in frame {
            if let Some(f) = dec.push(b) {
                got = Some(f);
            }
        }
        let f = got.expect("结构完整就该收下");
        assert_eq!(f.cmd, CMD_AUTO_SCAN_START);
        assert!(!f.checksum_ok, "篡改过的校验和应该被标出来");
    }

    /// 真机帧(macOS 上抓到的原样 38 字节): 32 个压力 0xFE + air + 0xE0 + 0x00。
    /// 它的两字节校验和两条已知规则都不成立, 但结构完整, 必须收下。
    #[test]
    fn decoder_accepts_real_device_frame() {
        let mut wire = vec![SYNC, CMD_AUTO_SCAN, 33];
        wire.extend(std::iter::repeat(0xFEu8).take(32));
        wire.extend([0x00, 0xE0, 0x00]);
        assert_eq!(wire.len(), 38);
        let mut dec = Decoder::new();
        let mut got = None;
        for b in wire {
            if let Some(f) = dec.push(b) {
                got = Some(f);
            }
        }
        let f = got.expect("真机帧必须收下");
        assert_eq!(f.cmd, CMD_AUTO_SCAN);
        assert_eq!(f.payload.len(), 33);
        assert_eq!(&f.payload[..32], &[0xFEu8; 32][..]);
        assert_eq!(f.payload[32], 0x00);
        assert!(!f.checksum_ok, "真机那两字节还没对上, 先记着");
        let st = parse_scan(&f.payload).expect("32 压力 + 天键要能解出来");
        assert_eq!(st.touch, [0xFEu8; 32]);
    }

    #[test]
    fn parse_scan_reads_pressure_and_air() {
        let single: Vec<u8> = (0..32).map(|i| (i * 3) as u8).collect();
        let st = parse_scan(&single).unwrap();
        assert_eq!(st.touch[0], 0);
        assert_eq!(st.touch[32 - 1], (31 * 3) as u8);
        assert!(!st.air_pressed(0));

        let mut with_air = single.clone();
        with_air.push(0b0010_0101);
        let st = parse_scan(&with_air).unwrap();
        assert!(st.air_pressed(0));
        assert!(!st.air_pressed(1));
        assert!(st.air_pressed(2));
        assert!(st.air_pressed(5));

        assert!(parse_scan(&single[..31]).is_none());
    }

    #[test]
    fn parse_air_reads_bitmap() {
        assert_eq!(parse_air(&[0b0010_0101]), Some(0b0010_0101));
        assert_eq!(parse_air(&[0]), Some(0));
        assert_eq!(parse_air(&[]), None, "空载荷不算一帧天键状态");
    }
}
