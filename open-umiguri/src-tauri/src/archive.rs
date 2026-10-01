// 归档合成: 把「解包目录」按需还原成 .una/.arc 归档字节(仅内存, 不落盘)。
//
// 用途: dev 直接读 assets/(解密解包态), 角色/语音/谱面这类「游戏按归档读」的资源
// 由本模块在读取时合成归档字节; 打包(release/Android)仍走 build/pack-assets.mjs 预打包。
//
// 与 tools/umg.cjs / src/game-esm/formats/archive.js 的 buildArchive 逐字节一致:
//   头部: byte[4] 位0=M2(文件体 gzip), 位1=R2(有表头, 必须=1)
//         u32le@5 = MAGIC ^ (4 - tableOffset)
//   表项: u32le(off)^t, u32le(off+4)^e, u8(off+8)^(255&n), name[i]^(255&r)
//   文件体: 数据 -> [P2=2 补 0 字节] -> [M2 gzip(前补 0 字节)] -> Na 逆 -> XOR 表
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const MAGIC: u32 = 281266680; // 0x10C3C9F8
const SEED_T: u32 = 3125038119;
const SEED_E: u32 = 452525368;
const SEED_N: u32 = 3518972124;
const SEED_R: u32 = 1813668011;
const HEADER: usize = 5; // 表项 fileOffset 与真实数据起点相差 5

// P2=0 用 Va 表, P2=1/2 用 Wa 表(索引 = (absPos & 31) << 1)
#[rustfmt::skip]
const VA_TABLE: [u8; 64] = [
    168, 220, 89, 53, 219, 151, 160, 26, 53, 145, 237, 161, 148, 35, 123, 1, 157, 54, 121, 110,
    229, 160, 93, 18, 129, 35, 179, 28, 127, 161, 220, 148, 112, 95, 35, 237, 192, 127, 26, 71,
    50, 224, 1, 60, 41, 28, 247, 220, 71, 208, 54, 75, 75, 179, 151, 193, 236, 1, 95, 121, 18,
    121, 245, 95,
];
#[rustfmt::skip]
const WA_TABLE: [u8; 64] = [
    252, 113, 113, 161, 156, 129, 155, 251, 255, 156, 249, 43, 162, 156, 245, 100, 242, 193, 193,
    117, 75, 117, 10, 129, 214, 113, 144, 179, 43, 100, 144, 100, 203, 88, 251, 161, 210, 245, 71,
    144, 100, 249, 247, 255, 124, 245, 53, 10, 14, 155, 113, 113, 152, 255, 245, 179, 148, 225,
    178, 251, 179, 71, 154, 242,
];

fn rotr(state: u32, shift: u32) -> u32 {
    (state >> shift) | (state << (32 - shift))
}

// 位置相关 XOR 表(加密方向; base = 归档内绝对位置 - HEADER)
fn xor_table(buf: &mut [u8], base: u64, p2: u8) {
    let table = if p2 == 0 { &VA_TABLE } else { &WA_TABLE };
    for (i, b) in buf.iter_mut().enumerate() {
        let abs = base + i as u64;
        *b ^= table[((abs & 31) << 1) as usize];
    }
}

fn k1_at(t: usize, v: u8) -> u8 {
    if t % 5 == 0 {
        105
    } else if t % 19 == 0 {
        209
    } else if t % 83 == 0 {
        72
    } else if t % 97 == 0 {
        2
    } else {
        v
    }
}

// Na 逆向(加密): plain[t] = cipher[t] ^ K1(t, v[t]) ^ ((117 & plain[t-1]) | (72 & cipher[t-1]))
// v 序列: v[0]=250; v[t+1] = v[t] - (t % 3), 小于 0 时回绕为 255。
fn na_inv(buf: &mut [u8]) {
    let mut p_prev: u8 = 0;
    let mut c_prev: u8 = 0;
    let mut v: i32 = 250;
    for (t, b) in buf.iter_mut().enumerate() {
        if t > 0 {
            v -= ((t - 1) % 3) as i32;
            if v < 0 {
                v = 255;
            }
        }
        let c = *b;
        let p = c ^ k1_at(t, v as u8) ^ ((117 & p_prev) | (72 & c_prev));
        *b = p;
        p_prev = p;
        c_prev = c;
    }
}

// gzip(stored 块, 不压缩)。合成归档默认 m2=false, 此函数仅用于需要 gzip 的调用方。
#[allow(dead_code)]
fn gzip_stored(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 32);
    out.extend_from_slice(&[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    } else {
        let chunks: Vec<&[u8]> = data.chunks(65535).collect();
        let n = chunks.len();
        for (i, c) in chunks.iter().enumerate() {
            out.push(if i + 1 == n { 1 } else { 0 });
            let len = c.len() as u16;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(c);
        }
    }
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

#[allow(dead_code)]
fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

// 名称按 latin1 落盘(与 JS `charCodeAt(i) & 0xff` 一致)
fn latin1(s: &str) -> Vec<u8> {
    s.chars().map(|c| (c as u32 & 0xff) as u8).collect()
}

// 解包时给每个文件追加过一次 guessExt, 打包时去掉最后一层扩展名。
fn strip_guessed_ext(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rfind('.') {
        None | Some(0) => name.to_string(),
        Some(_) => match name.rfind('.') {
            Some(i) => name[..i].to_string(),
            None => name.to_string(),
        },
    }
}

// 按游戏原始布局打包: 9 字节头 + 数据区 + 尾部表
pub fn build_archive(files: &[(String, Vec<u8>)], p2: u8, m2: bool) -> Vec<u8> {
    let headsize = HEADER + 4;
    let mut cursor = headsize;
    let mut entries: Vec<(String, u64, Vec<u8>)> = Vec::with_capacity(files.len());
    for (name, data) in files {
        let mut body = Vec::with_capacity(data.len() + 2);
        if p2 == 2 {
            body.push(0);
        }
        body.extend_from_slice(data);
        if m2 {
            let mut wrapped = vec![0u8];
            wrapped.extend_from_slice(&gzip_stored(&body));
            body = wrapped;
        }
        na_inv(&mut body);
        let file_offset = (cursor - HEADER) as u64;
        cursor += body.len();
        entries.push((name.clone(), file_offset, body));
    }
    let table_offset = cursor;
    let mut table_len = 0usize;
    let names: Vec<Vec<u8>> = entries.iter().map(|e| latin1(&e.0)).collect();
    for n in &names {
        table_len += 9 + n.len();
    }
    let mut out = vec![0u8; table_offset + table_len];
    out[4] = (m2 as u8) | 2;
    out[5..9].copy_from_slice(&(MAGIC ^ (4u32.wrapping_sub(table_offset as u32))).to_le_bytes());

    for (_, file_offset, body) in entries.iter() {
        let mut enc = body.clone();
        xor_table(&mut enc, *file_offset, p2);
        let at = *file_offset as usize + HEADER;
        out[at..at + enc.len()].copy_from_slice(&enc);
    }

    let mut off = table_offset;
    let mut t = SEED_T;
    let mut e2 = SEED_E;
    let mut n = SEED_N;
    let mut r = SEED_R;
    for (i, (_, file_offset, body)) in entries.iter().enumerate() {
        t = rotr(t, 2);
        e2 = rotr(e2, 3);
        n = rotr(n, 5);
        out[off..off + 4].copy_from_slice(&((*file_offset as u32) ^ t).to_le_bytes());
        out[off + 4..off + 8].copy_from_slice(&((body.len() as u32) ^ e2).to_le_bytes());
        let name = &names[i];
        out[off + 8] = (name.len() as u8) ^ (255 & n as u8);
        off += 9;
        for &nb in name {
            r = rotr(r, 3);
            out[off] = nb ^ (255 & r as u8);
            off += 1;
        }
    }
    out
}

// ---- 目录扫描与缓存 ----

#[derive(Clone, Copy, PartialEq, Eq)]
struct Sig {
    files: u64,
    max_mtime_ms: u64,
    total: u64,
}

// 收集非隐藏文件(相对路径, `/` 分隔), 返回签名(用于缓存失效判定)
fn scan(root: &Path, dir: &Path, acc: &mut Vec<(String, PathBuf)>) -> Sig {
    let mut sig = Sig {
        files: 0,
        max_mtime_ms: 0,
        total: 0,
    };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return sig;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // 跳过 .DS_Store / ._* 等
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            let sub = scan(root, &p, acc);
            sig.files += sub.files;
            sig.total += sub.total;
            sig.max_mtime_ms = sig.max_mtime_ms.max(sub.max_mtime_ms);
        } else if ft.is_file() {
            let md = e.metadata().ok();
            let len = md.as_ref().map(|m| m.len()).unwrap_or(0);
            let mt = md
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            sig.files += 1;
            sig.total += len;
            sig.max_mtime_ms = sig.max_mtime_ms.max(mt);
            acc.push((rel_name(root, &p), p));
        }
    }
    sig
}

fn rel_name(dir: &Path, p: &Path) -> String {
    p.strip_prefix(dir)
        .map(|r| {
            r.components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

// 归档目录名决定 P2: .una=2, 其余(.arc)=1
pub fn archive_p2(rel: &str) -> Option<u8> {
    if rel.ends_with(".una") {
        Some(2)
    } else if rel.ends_with(".arc") {
        Some(1)
    } else {
        None
    }
}

// 目录(归档)里是否至少有一个文件(递归)。
// 用途: 可写层的目录骨架会复刻出「空的归档镜像目录」, 不能让它遮蔽只读资源里的真归档。
pub fn dir_has_files(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    for e in rd.flatten() {
        if let Ok(ft) = e.file_type() {
            if ft.is_file() {
                return true;
            }
            if ft.is_dir() && dir_has_files(&e.path()) {
                return true;
            }
        }
    }
    false
}

type Cache = Mutex<HashMap<PathBuf, (Sig, Arc<Vec<u8>>)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

// 目录 -> 归档字节(m2=false; 游戏按头部标志决定是否解压, 无需压缩即可读)。
// 结果按签名缓存; 超过上限时整体清空(dev 场景, 避免长期驻留大量归档)。
pub fn dir_archive(dir: &Path, p2: u8) -> Option<Arc<Vec<u8>>> {
    let mut raw: Vec<(String, PathBuf)> = Vec::new();
    let sig = scan(dir, dir, &mut raw);
    if sig.files == 0 {
        return None;
    }
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some((s, data)) = map.get(dir) {
            if *s == sig {
                return Some(data.clone());
            }
        }
    }
    // 与 JS packDir 一致: 先按相对路径排序, 再去掉解包时追加的 guessExt
    raw.sort_by(|a, b| a.0.cmp(&b.0));
    let mut files: Vec<(String, Vec<u8>)> = Vec::with_capacity(raw.len());
    for (rel, p) in &raw {
        let data = std::fs::read(p).ok()?;
        files.push((strip_guessed_ext(rel), data));
    }
    let bytes = Arc::new(build_archive(&files, p2, false));
    if let Ok(mut map) = cache.lock() {
        if map.len() >= 32 {
            map.clear();
        }
        map.insert(dir.to_path_buf(), (sig, bytes.clone()));
    }
    Some(bytes)
}

// ---- 打包态归档读取(.una/.arc 是真实文件) ----
//
// dev 走上面的 dir_archive(解包目录 -> 现场合成归档字节); 打包产物里 core/una/*.una 与
// data/**/data.arc 是真实归档文件, 必须能按 vpath 取出内部条目 —— 否则 /reverie* 全部 404
// (语言包与 UI 资源读不到) -> 打包版启动黑屏无反应。
// 解密顺序与 tools/umg.cjs 的 readFileData 一致:
//   XOR 表 -> Na -> [M2: gzip(去首字节)] -> [P2=2: 去首字节]

// Na 正向(解密): plain[t] = cipher[t] ^ K1(t, v[t]) ^ ((117 & plain[t-1]) | (72 & cipher[t-1]))
fn na(buf: &mut [u8]) {
    let mut v: i32 = 250;
    let mut e: u8 = 0;
    let mut n: u8 = 0;
    for t in 0..buf.len() {
        let r = n;
        n = buf[t];
        buf[t] ^= k1_at(t, v as u8) ^ ((117 & r) | (72 & e));
        v -= (t % 3) as i32;
        if v < 0 {
            v = 255;
        }
        e = buf[t];
    }
}

// ---- DEFLATE(RFC1951)解码 ----
// 发布归档全部 M2=true(pack-assets 用 zlib.gzipSync 真压缩), 因此必须自带 inflate:
// 不引入新依赖, 与 src/host/platform/compression-stream.js 同一套实现(LSB-first, puff 结构)。
#[rustfmt::skip]
const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
#[rustfmt::skip]
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
#[rustfmt::skip]
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
#[rustfmt::skip]
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
// 动态块里「码长码」的传输顺序(RFC1951 §3.2.7)
const CL_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
// 单条目明文缓存上限: 超过它的条目每次重解, 避免大资源常驻内存。
const PLAIN_CACHE_MAX: usize = 4 << 20;

struct Huff {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

// 规范 Huffman 表(与 JS buildHuffman 一致); 码长过订阅时返回 None
fn build_huffman(lengths: &[u8]) -> Option<Huff> {
    let mut counts = [0u16; 16];
    for &l in lengths {
        counts[(l as usize) & 15] += 1;
    }
    let mut left: i32 = 1;
    for len in 1..16 {
        left = (left << 1) - counts[len] as i32;
        if left < 0 {
            return None;
        }
    }
    counts[0] = 0;
    let mut offs = [0u16; 16];
    for i in 1..16 {
        offs[i] = offs[i - 1] + counts[i - 1];
    }
    let mut symbols = vec![0u16; lengths.len()];
    for (i, &l) in lengths.iter().enumerate() {
        if l != 0 && (l as usize) < 16 {
            symbols[offs[l as usize] as usize] = i as u16;
            offs[l as usize] += 1;
        }
    }
    Some(Huff { counts, symbols })
}

// 固定 Huffman 表(块类型 1)
fn fixed_trees() -> (Huff, Huff) {
    let mut lit = [0u8; 288];
    for (i, l) in lit.iter_mut().enumerate() {
        *l = match i {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    (
        build_huffman(&lit).expect("fixed lit"),
        build_huffman(&[5u8; 30]).expect("fixed dist"),
    )
}

struct BitReader<'a> {
    src: &'a [u8],
    pos: usize,
    buf: u32,
    cnt: u32,
}

impl<'a> BitReader<'a> {
    fn new(src: &'a [u8], from: usize) -> Self {
        BitReader {
            src,
            pos: from,
            buf: 0,
            cnt: 0,
        }
    }

    // 取 need 位(LSB-first)
    fn bits(&mut self, need: u32) -> Option<u32> {
        if need == 0 {
            return Some(0);
        }
        while self.cnt < need {
            let b = *self.src.get(self.pos)? as u32;
            self.pos += 1;
            self.buf |= b << self.cnt;
            self.cnt += 8;
        }
        let v = self.buf & ((1u32 << need) - 1);
        self.buf >>= need;
        self.cnt -= need;
        Some(v)
    }
}

fn decode_sym(br: &mut BitReader, t: &Huff) -> Option<u16> {
    let mut code: i32 = 0;
    let mut first: i32 = 0;
    let mut index: i32 = 0;
    for len in 1..16 {
        code |= br.bits(1)? as i32;
        let count = t.counts[len] as i32;
        if code - count < first {
            return t.symbols.get((index + (code - first)) as usize).copied();
        }
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    None
}

// 回溯复制(dist/count); 逐字节以支持自重叠
fn copy_back(out: &mut Vec<u8>, dist: usize, count: usize) -> Option<()> {
    if dist == 0 || dist > out.len() {
        return None;
    }
    let start = out.len() - dist;
    for i in 0..count {
        let b = out[start + i];
        out.push(b);
    }
    Some(())
}

fn inflate_block(br: &mut BitReader, lit: &Huff, dist: &Huff, out: &mut Vec<u8>) -> Option<()> {
    loop {
        let sym = decode_sym(br, lit)?;
        if sym < 256 {
            out.push(sym as u8);
            continue;
        }
        if sym == 256 {
            return Some(());
        }
        let li = (sym - 257) as usize;
        if li >= LEN_BASE.len() {
            return None;
        }
        let count = LEN_BASE[li] as usize + br.bits(LEN_EXTRA[li] as u32)? as usize;
        let dsym = decode_sym(br, dist)? as usize;
        if dsym >= DIST_BASE.len() {
            return None;
        }
        let d = DIST_BASE[dsym] as usize + br.bits(DIST_EXTRA[dsym] as u32)? as usize;
        copy_back(out, d, count)?;
    }
}

// stored(未压缩)块: 先对齐到字节边界(位缓冲里整字节的输入退回)
fn stored_block(br: &mut BitReader, out: &mut Vec<u8>) -> Option<()> {
    let drop = br.cnt & 7;
    if drop != 0 {
        br.buf >>= drop;
        br.cnt -= drop;
    }
    br.pos = br.pos.checked_sub((br.cnt >> 3) as usize)?;
    br.buf = 0;
    br.cnt = 0;
    let n = *br.src.get(br.pos)? as usize | ((*br.src.get(br.pos + 1)? as usize) << 8);
    let nn = *br.src.get(br.pos + 2)? as usize | ((*br.src.get(br.pos + 3)? as usize) << 8);
    br.pos += 4;
    if (n ^ 0xffff) != nn {
        return None;
    }
    let end = br.pos.checked_add(n)?;
    if end > br.src.len() {
        return None;
    }
    out.extend_from_slice(&br.src[br.pos..end]);
    br.pos = end;
    Some(())
}

fn dynamic_block(br: &mut BitReader, out: &mut Vec<u8>) -> Option<()> {
    let hlit = br.bits(5)? as usize + 257;
    let hdist = br.bits(5)? as usize + 1;
    let hclen = br.bits(4)? as usize + 4;
    let mut cl = [0u8; 19];
    for i in 0..hclen {
        cl[CL_ORDER[i]] = br.bits(3)? as u8;
    }
    let cltree = build_huffman(&cl)?;
    let total = hlit + hdist;
    let mut lens = vec![0u8; total];
    let mut i = 0usize;
    while i < total {
        let sym = decode_sym(br, &cltree)?;
        if sym < 16 {
            lens[i] = sym as u8;
            i += 1;
            continue;
        }
        let (prev, count) = match sym {
            16 => {
                if i == 0 {
                    return None;
                }
                (lens[i - 1], 3 + br.bits(2)? as usize)
            }
            17 => (0u8, 3 + br.bits(3)? as usize),
            _ => (0u8, 11 + br.bits(7)? as usize),
        };
        if i + count > total {
            return None;
        }
        for _ in 0..count {
            lens[i] = prev;
            i += 1;
        }
    }
    let lit = build_huffman(&lens[..hlit])?;
    let dist = build_huffman(&lens[hlit..])?;
    inflate_block(br, &lit, &dist, out)
}

// 裸 DEFLATE 流
fn inflate_raw(src: &[u8], from: usize) -> Option<Vec<u8>> {
    let mut br = BitReader::new(src, from);
    let mut out: Vec<u8> = Vec::with_capacity(src.len().saturating_mul(3).max(256));
    loop {
        let last = br.bits(1)?;
        match br.bits(2)? {
            0 => stored_block(&mut br, &mut out)?,
            1 => {
                let (lit, dist) = fixed_trees();
                inflate_block(&mut br, &lit, &dist, &mut out)?;
            }
            2 => dynamic_block(&mut br, &mut out)?,
            _ => return None,
        }
        if last == 1 {
            return Some(out);
        }
    }
}

// gzip 容器(RFC1952): 跳过可选字段后即为裸流
fn gunzip(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 10 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 8 {
        return None;
    }
    let flg = data[3];
    let mut p = 10usize;
    if flg & 4 != 0 {
        let n = *data.get(p)? as usize | ((*data.get(p + 1)? as usize) << 8);
        p += 2 + n;
    }
    if flg & 8 != 0 {
        while *data.get(p)? != 0 {
            p += 1;
        }
        p += 1;
    }
    if flg & 16 != 0 {
        while *data.get(p)? != 0 {
            p += 1;
        }
        p += 1;
    }
    if flg & 2 != 0 {
        p += 2;
    }
    if p > data.len() {
        return None;
    }
    inflate_raw(data, p)
}

// ---- 归档对象 ----

// 一个打包态归档(.una / .arc 文件)。只解尾部表, 条目按需解密/解压。
pub struct Archive {
    bytes: Vec<u8>,
    p2: u8,
    m2: bool,
    // (名字, 数据区偏移 fileOffset, 加密体长度)
    entries: Vec<(String, u64, u32)>,
    index: HashMap<String, usize>,
    plain: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    sizes: Mutex<HashMap<String, u64>>,
}

// 尾部表 -> 条目(字段按 rotr 2/3/5/3 解出, 名字逐字节解)
fn decrypt_header(arc: &[u8]) -> Vec<(String, u64, u32)> {
    let len = arc.len();
    if len < 9 {
        return Vec::new();
    }
    let magic = u32::from_le_bytes([arc[5], arc[6], arc[7], arc[8]]);
    let table_offset = 4i64 - (MAGIC ^ magic) as i32 as i64;
    if table_offset < 9 || table_offset as usize >= len {
        return Vec::new();
    }
    let mut offset = table_offset as usize;
    let mut t = SEED_T;
    let mut e = SEED_E;
    let mut n = SEED_N;
    let mut r = SEED_R;
    // (名字, fileOffset, fileSize, 表项起点)
    let mut raw: Vec<(String, u64, u32, usize)> = Vec::new();
    let mut limit = usize::MAX;
    while offset + 9 <= len {
        if offset >= limit {
            break;
        }
        let pos = offset;
        t = rotr(t, 2);
        e = rotr(e, 3);
        n = rotr(n, 5);
        let file_offset = (u32::from_le_bytes([
            arc[offset],
            arc[offset + 1],
            arc[offset + 2],
            arc[offset + 3],
        ]) ^ t) as u64;
        let file_size = u32::from_le_bytes([
            arc[offset + 4],
            arc[offset + 5],
            arc[offset + 6],
            arc[offset + 7],
        ]) ^ e;
        let name_len = (arc[offset + 8] ^ (255 & n as u8)) as usize;
        offset += 9;
        let mut name = String::with_capacity(name_len);
        for i in 0..name_len {
            if offset + i >= len {
                break;
            }
            r = rotr(r, 3);
            name.push((arc[offset + i] ^ (255 & r as u8)) as char);
        }
        offset += name_len;
        raw.push((name, file_offset, file_size, pos));
        if limit == usize::MAX {
            let data_start = file_offset as usize + HEADER;
            if data_start > offset {
                limit = data_start;
            }
        }
    }
    if raw.is_empty() {
        return Vec::new();
    }
    // 数据区在表之前时, 越过数据区起点的表项是脏数据(与 JS decryptHeader 同一过滤)
    let first = raw[0].3;
    let data_first = raw[0].1 as usize + HEADER < first;
    raw.into_iter()
        .filter(|(_, off, size, _)| {
            let s = *off as usize + HEADER;
            if *size == 0 || s + *size as usize > len {
                return false;
            }
            !data_first || s + *size as usize <= first
        })
        .map(|(name, off, size, _)| (name, off, size))
        .collect()
}

impl Archive {
    // 解析归档(只解表, 不碰文件体)
    pub fn parse(bytes: Vec<u8>, p2: u8) -> Option<Archive> {
        if bytes.len() < 9 || bytes[4] & 2 == 0 {
            return None; // R2=0: 没有尾部表, 无法按条目读
        }
        let entries = decrypt_header(&bytes);
        if entries.is_empty() {
            return None;
        }
        let mut index = HashMap::with_capacity(entries.len());
        for (i, (name, _, _)) in entries.iter().enumerate() {
            index.entry(name.clone()).or_insert(i);
        }
        Some(Archive {
            m2: bytes[4] & 1 != 0,
            bytes,
            p2,
            entries,
            index,
            plain: Mutex::new(HashMap::new()),
            sizes: Mutex::new(HashMap::new()),
        })
    }

    pub fn contains(&self, name: &str) -> bool {
        self.index.contains_key(name)
    }

    // 明文长度。M2 时读 gzip 尾部的 ISIZE —— 只解密(body)不 inflate, 比 read() 便宜。
    pub fn size(&self, name: &str) -> Option<u64> {
        if let Ok(map) = self.sizes.lock() {
            if let Some(n) = map.get(name) {
                return Some(*n);
            }
        }
        let body = self.body(name)?;
        let raw = if self.m2 {
            if body.len() < 4 {
                return None;
            }
            u32::from_le_bytes(body[body.len() - 4..].try_into().ok()?) as u64
        } else {
            body.len() as u64
        };
        let len = raw.saturating_sub(u64::from(self.p2 == 2));
        if let Ok(mut map) = self.sizes.lock() {
            if map.len() >= 4096 {
                map.clear();
            }
            map.insert(name.to_string(), len);
        }
        Some(len)
    }

    // 读条目明文(解密 + 解压); 小条目结果缓存
    pub fn read(&self, name: &str) -> Option<Arc<Vec<u8>>> {
        if let Ok(map) = self.plain.lock() {
            if let Some(d) = map.get(name) {
                return Some(d.clone());
            }
        }
        let data = Arc::new(self.decode(name)?);
        if data.len() <= PLAIN_CACHE_MAX {
            if let Ok(mut map) = self.plain.lock() {
                if map.len() >= 256 {
                    map.clear();
                }
                map.insert(name.to_string(), data.clone());
            }
        }
        Some(data)
    }

    // 解密: XOR 表 -> Na(不含 gzip / P2 去首字节)
    fn body(&self, name: &str) -> Option<Vec<u8>> {
        let (_, off, size) = self.entries.get(*self.index.get(name)?)?;
        let start = *off as usize + HEADER;
        let end = start.checked_add(*size as usize)?;
        if end > self.bytes.len() {
            return None;
        }
        let mut buf = self.bytes[start..end].to_vec();
        xor_table(&mut buf, *off, self.p2);
        na(&mut buf);
        Some(buf)
    }

    fn decode(&self, name: &str) -> Option<Vec<u8>> {
        let mut buf = self.body(name)?;
        if self.m2 {
            buf = gunzip(buf.get(1..)?)?;
        }
        if self.p2 == 2 {
            if buf.is_empty() {
                return None;
            }
            buf.drain(..1);
        }
        Some(buf)
    }

    // prefix(以 '/' 结尾, 可为空)下的直接子项: (名字, 是否文件)
    pub fn children(&self, prefix: &str) -> Vec<(String, bool)> {
        let mut out: Vec<(String, bool)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for (name, _, _) in &self.entries {
            let Some(rest) = name.strip_prefix(prefix) else {
                continue;
            };
            if rest.is_empty() {
                continue;
            }
            match rest.find('/') {
                Some(i) => {
                    let dir = &rest[..i];
                    if seen.insert(dir.to_string()) {
                        out.push((dir.to_string(), false));
                    }
                }
                None => {
                    if seen.insert(rest.to_string()) {
                        out.push((rest.to_string(), true));
                    }
                }
            }
        }
        out
    }
}

// 归档文件在磁盘/APK 上的签名(只 stat, 不读内容)
fn archive_stamp(rel: &str) -> Option<u64> {
    for root in crate::paths::disk_roots() {
        let p = root.join(rel);
        if let Ok(md) = std::fs::metadata(&p) {
            if md.is_file() {
                let mt = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                return Some(md.len() ^ mt.rotate_left(21));
            }
        }
    }
    crate::paths::apk_size(rel)
}

// 归档文件原始字节(磁盘优先, 其次 APK assets)
fn archive_blob(rel: &str) -> Option<Vec<u8>> {
    for root in crate::paths::disk_roots() {
        let p = root.join(rel);
        if p.is_file() {
            if let Ok(b) = std::fs::read(&p) {
                return Some(b);
            }
        }
    }
    let len = crate::paths::apk_size(rel)? as usize;
    crate::paths::apk_read_range(rel, 0, len)
}

type ArchiveCache = Mutex<HashMap<String, (u64, Arc<Archive>)>>;
static ARCHIVE_CACHE: OnceLock<ArchiveCache> = OnceLock::new();

// 打开打包态归档(磁盘 .una/.arc 文件或 APK 条目), 按 rel 缓存, 签名变化时重建。
pub fn open_archive(rel: &str, p2: u8) -> Option<Arc<Archive>> {
    let stamp = archive_stamp(rel)?;
    let cache = ARCHIVE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some((s, a)) = map.get(rel) {
            if *s == stamp {
                return Some(a.clone());
            }
        }
    }
    let arc = Arc::new(Archive::parse(archive_blob(rel)?, p2)?);
    if let Ok(mut map) = cache.lock() {
        if map.len() >= 16 {
            map.clear();
        }
        map.insert(rel.to_string(), (stamp, arc.clone()));
    }
    Some(arc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn na_is_inverse_of_na_inv() {
        let mut buf: Vec<u8> = (0..4096u32)
            .map(|i| i.wrapping_mul(37).wrapping_add(11) as u8)
            .collect();
        let orig = buf.clone();
        na_inv(&mut buf);
        assert_ne!(buf, orig);
        na(&mut buf);
        assert_eq!(buf, orig);
    }

    // 合成归档(m2=false) -> 解析 -> 条目可解、size 与明文长度一致
    #[test]
    fn synth_archive_roundtrip() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let dir = root.join("assets/core/una/zh-CN.una");
        if !dir.is_dir() {
            return;
        }
        let bytes = dir_archive(&dir, 2).expect("synth");
        let arc = Archive::parse(bytes.as_ref().clone(), 2).expect("parse");
        assert!(arc.contains("_VERSION"));
        let names: Vec<String> = arc.entries.iter().map(|e| e.0.clone()).collect();
        assert!(!names.is_empty());
        for n in &names {
            let data = arc.read(n).unwrap_or_else(|| panic!("读取失败: {n}"));
            assert_eq!(arc.size(n), Some(data.len() as u64), "size 不一致: {n}");
        }
    }

    // 打包态归档(M2=true, zlib 真压缩)逐条目与解包态 assets 对比, 覆盖
    // 尾部表解析 / XOR 表 / Na / gzip(RFC1952 + DEFLATE 动态与固定 Huffman) 全链路。
    // 扫描 dist/game_data 下全部 .una/.arc, 新增归档自动纳入。
    #[test]
    fn packed_archive_matches_assets() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let packed = root.join("dist/game_data");
        let assets = root.join("assets");
        if !packed.is_dir() {
            eprintln!(
                "[archive] 跳过打包态对比: 没有 dist/game_data 产物(先 npm run build:assets)"
            );
            return;
        }
        let mut rels: Vec<String> = Vec::new();
        let mut dirs = vec![packed.clone()];
        while let Some(d) = dirs.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    dirs.push(p);
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                if archive_p2(&name).is_some() {
                    rels.push(rel_name(&packed, &p));
                }
            }
        }
        rels.sort();
        let mut checked = 0usize;
        for rel in &rels {
            // 解包态目录: 文件名 = 条目名 + guessExt(多出最后一层扩展名)
            let dir = assets.join(rel);
            if !dir.is_dir() {
                continue;
            }
            let bytes = std::fs::read(packed.join(rel)).unwrap();
            let p2 = archive_p2(rel).unwrap();
            let arc = Archive::parse(bytes, p2).unwrap_or_else(|| panic!("{rel}: 归档解析失败"));
            let mut dirs = vec![dir.clone()];
            while let Some(d) = dirs.pop() {
                let Ok(rd) = std::fs::read_dir(&d) else {
                    continue;
                };
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        dirs.push(p);
                        continue;
                    }
                    let rel_in = p
                        .strip_prefix(&dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    if rel_in.split('/').any(|s| s.starts_with('.')) {
                        continue; // .DS_Store 之类
                    }
                    let name = strip_guessed_ext(&rel_in);
                    let want = std::fs::read(&p).unwrap();
                    let got = arc
                        .read(&name)
                        .unwrap_or_else(|| panic!("{rel}: 条目缺失 {name}(来自 {rel_in})"));
                    assert_eq!(got.as_slice(), want.as_slice(), "{rel}: 内容不一致 {name}");
                    assert_eq!(
                        arc.size(&name),
                        Some(want.len() as u64),
                        "{rel}: size 不一致 {name}"
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 0, "没有可对比的条目: {rels:?}");
        eprintln!(
            "[archive] 打包态对比通过: {} 个归档 / {checked} 个条目",
            rels.len()
        );
    }

    // 合成 assets/core/una/zh-CN.una 供与 JS packDir 逐字节对比(见 tools/verify-synth.sh)
    #[test]
    fn dump_synth_fixture() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("assets");
        for name in ["core/una/zh-CN.una", "data/characters/UMIGURI/uni"] {
            let dir = root.join(name);
            if !dir.is_dir() {
                continue;
            }
            let p2 = archive_p2(name).unwrap_or(1);
            let Some(bytes) = dir_archive(&dir, p2) else {
                continue;
            };
            let out = std::env::temp_dir().join(format!(
                "umg_synth_{}.arc",
                name.replace('/', "_")
            ));
            std::fs::write(&out, bytes.as_slice()).unwrap();
            eprintln!("[synth] {} p2={} -> {} ({}B)", name, p2, out.display(), bytes.len());
        }
    }
}
