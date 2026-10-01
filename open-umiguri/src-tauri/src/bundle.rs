// 批量读取子树: 一次 IPC 把整棵子树的文件带回 JS, 由宿主灌入 fileCache。
//
// 动机: 单次 fetch(umg://) 往返在桌面/真机都有约 10~30ms 的固定开销, 而游戏的加载链
// 是串行的(一个文件一个请求, 按帧让出)。乐曲列表 43 首就要 139 次请求 ≈ 3.8s, 全是
// 延迟而非带宽(仅 5.5MB)。批量成 1 次往返后, 游戏后续的 sn/qu/Ic 直接命中宿主缓存。
//
// 返回格式(小端, 原始二进制, 不走 base64):
//   u32 count
//   repeat: u16 pathLen, path(utf8, 以 '/' 开头), u32 dataLen, data
use crate::paths::{dir_entries, read_all, resolve_src, size_of, vpath_to_rel, Src};

// 默认跳过: 归档/加密包(走 rangeFile 流式读, 且体积大)与音频(播放时按需读)
const SKIP_EXT: &[&str] = &[
    "una", "arc", "enc", "mp3", "ogg", "wav", "m4a", "flac", "aac",
];

fn ext_of(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn skipped(name: &str) -> bool {
    name.starts_with('.') || SKIP_EXT.contains(&ext_of(name).as_str())
}

// 列出 vpath 目录下的条目: (name, is_file)。
// 合并磁盘可写层、APK 资产与打包态归档内部(见 paths::dir_entries; 打包版 /reverie*
// 落在 core/una/*.una 里, 没有这一层语言包子树会是被列成空的)。
// 注意: PATH_MAP 的前缀带尾斜杠("music/" -> "data/music/"), 目录路径必须补 "/" 才能命中。
fn list_dir(vpath: &str) -> Vec<(String, bool)> {
    let with_slash = format!("{}/", vpath.trim_end_matches('/'));
    let dir_rel = vpath_to_rel(&with_slash);
    dir_entries(&dir_rel)
        .0
        .into_iter()
        .map(|(name, is_file, _)| (name, is_file))
        // 空名字会让 walk 拼出与父目录同名(带尾斜杠)的子路径 -> 自引用无限递归。
        .filter(|(name, _)| !name.is_empty())
        .collect()
}

// 目录树遍历的最大深度。安全网: 虚拟目录(归档/APK)一旦出现自引用或环,
// 递归会在几十帧内吃光线程栈(macOS 主线程栈 8MB 也扛不住)直接 abort。
const MAX_WALK_DEPTH: usize = 32;

struct Collector {
    files: Vec<(String, Vec<u8>)>,
    total: u64,
    max_file: u64,
    max_total: u64,
    // 与 fs_tree_sig 同一算法(路径+大小+mtime), 顺带算出, 避免真机上再遍历一遍
    hash: u64,
}


impl Collector {
    fn walk(&mut self, vpath: &str) {
        self.walk_at(vpath, 0);
    }

    fn walk_at(&mut self, vpath: &str, depth: usize) {
        if self.total >= self.max_total || depth > MAX_WALK_DEPTH {
            return;
        }
        for (name, is_file) in list_dir(vpath) {
            if skipped(&name) {
                continue;
            }
            let child = format!("{}/{}", vpath.trim_end_matches('/'), name);
            if is_file {
                let size = size_of(&child).unwrap_or(0);
                // 签名覆盖整棵子树(含因大小/总量上限被跳过的文件), 才能反映曲库变化
                fnv_str(&mut self.hash, &child);
                let mt = file_mtime(&child);
                for b in size.to_le_bytes().iter().chain(mt.to_le_bytes().iter()) {
                    fnv_byte(&mut self.hash, *b);
                }
                if size == 0 || size > self.max_file || self.total + size > self.max_total {
                    continue;
                }
                if let Some(data) = read_all(&child) {
                    self.total += data.len() as u64;
                    self.files.push((child, data));
                }
            } else {
                self.walk_at(&child, depth + 1);
            }
        }
    }
}

// 子树签名(路径+大小+mtime 的 FNV-1a): 用于判断游戏自带的 /caches/music.json 列表
// 缓存是否还有效。只遍历与 stat, 不读文件内容, 一次 IPC 完成。
fn fnv_byte(h: &mut u64, b: u8) {
    *h ^= b as u64;
    *h = h.wrapping_mul(0x0000_0100_0000_01b3);
}

fn fnv_str(h: &mut u64, s: &str) {
    for b in s.as_bytes() {
        fnv_byte(h, *b);
    }
    fnv_byte(h, 0);
}

fn file_mtime(vpath: &str) -> u64 {
    resolve_src(vpath)
        .and_then(|src| match src {
            Src::Disk(p) => std::fs::metadata(p).ok(),
            _ => None,
        })
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sig_walk(vpath: &str, h: &mut u64, files: &mut u64) {
    sig_walk_at(vpath, h, files, 0);
}

fn sig_walk_at(vpath: &str, h: &mut u64, files: &mut u64, depth: usize) {
    if depth > MAX_WALK_DEPTH {
        return;
    }
    for (name, is_file) in list_dir(vpath) {
        if name.starts_with('.') {
            continue;
        }
        let child = format!("{}/{}", vpath.trim_end_matches('/'), name);
        if is_file {
            let size = size_of(&child).unwrap_or(0);
            let mt = file_mtime(&child);
            fnv_str(h, &child);
            for b in size.to_le_bytes().iter().chain(mt.to_le_bytes().iter()) {
                fnv_byte(h, *b);
            }
            *files += 1;
        } else {
            sig_walk_at(&child, h, files, depth + 1);
        }
    }
}

#[tauri::command]
pub fn fs_tree_sig(root: String) -> String {
    let root = if root.starts_with('/') {
        root
    } else {
        format!("/{root}")
    };
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut files: u64 = 0;
    sig_walk(root.trim_end_matches('/'), &mut h, &mut files);
    format!("{h:016x}-{files}")
}

#[tauri::command]
pub fn fs_bundle_tree(root: String, max_file: u64, max_total: u64) -> tauri::ipc::Response {
    let t0 = std::time::Instant::now();
    let root = if root.starts_with('/') {
        root
    } else {
        format!("/{root}")
    };
    let mut c = Collector {
        files: Vec::new(),
        total: 0,
        max_file,
        max_total,
        hash: 0xcbf2_9ce4_8422_2325,
    };
    c.walk(root.trim_end_matches('/'));
    let mut out: Vec<u8> = Vec::with_capacity(c.total as usize + 8 * c.files.len() + 16);
    // [u64 签名][u32 文件数]: 签名与 fs_tree_sig 同口径, 供乐曲列表缓存失效判断,
    // 复用同一次遍历(真机上遍历很贵: apk_list 走 JNI, 歌曲在 FUSE 上)。
    out.extend_from_slice(&c.hash.to_le_bytes());
    out.extend_from_slice(&(c.files.len() as u32).to_le_bytes());
    for (path, data) in &c.files {
        out.extend_from_slice(&(path.len() as u16).to_le_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    }
    eprintln!(
        "[umg][bundle] {} files={} {:.2}MB {}ms",
        root,
        c.files.len(),
        c.total as f64 / 1048576.0,
        t0.elapsed().as_millis()
    );
    tauri::ipc::Response::new(out)
}
