// 文件系统 Tauri command(替代 Electron 的 ipcMain)。
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::paths::{
    data_root, dir_entries, read_all, read_range, size_of, vpath_to_rel, write_path,
};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    full_path: String,
    is_directory: bool,
    is_file: bool,
    name: String,
    size: u64,
}

#[derive(Serialize)]
pub struct FsListResult {
    status: i32,
    data: Vec<FileEntry>,
}

#[derive(Serialize)]
pub struct FsSizeResult {
    status: i32,
    data: Option<u64>,
}

// 列目录(合并: 磁盘可写层 + 只读资源 + APK 内置资产; 游戏只使用 name/isDirectory)
#[tauri::command]
pub fn fs_list(path: String) -> FsListResult {
    let t0 = std::time::Instant::now();
    // 目录列举: 补尾斜杠才能命中 PATH_MAP 的目录前缀(/reverie -> core/una/hiiragi.una/),
    // 取回后再归一化, 免得 fullPath 出现双斜杠(游戏会拿 fullPath 再拼接)。
    let dir_rel = vpath_to_rel(&format!("{}/", path.trim_end_matches('/')));
    let dir_rel = dir_rel.trim_end_matches('/').to_string();
    let (entries, exists) = dir_entries(&format!("{dir_rel}/"));
    let data: Vec<FileEntry> = entries
        .into_iter()
        .map(|(name, is_file, size)| FileEntry {
            full_path: if dir_rel.is_empty() {
                format!("/{name}")
            } else {
                format!("/{dir_rel}/{name}")
            },
            is_directory: !is_file,
            is_file,
            name,
            size,
        })
        .collect();
    let ms = t0.elapsed().as_millis();
    if ms >= 20 || data.len() >= 16 {
        eprintln!("[umg][list] {} n={} {}ms", path, data.len(), ms);
    }
    FsListResult {
        status: if exists { 0 } else { -1 },
        data,
    }
}

// 读整个文件(base64 编码,避免 Vec<u8> JSON 数组序列化开销)
#[tauri::command]
pub fn fs_file(path: String) -> Result<String, String> {
    let data = read_all(&path).ok_or_else(|| format!("not found: {path}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

// 文件大小
#[tauri::command]
pub fn fs_size(path: String) -> FsSizeResult {
    match size_of(&path) {
        Some(n) => FsSizeResult {
            status: 0,
            data: Some(n),
        },
        None => FsSizeResult {
            status: -1,
            data: None,
        },
    }
}

// 读文件 offset/size(归档解密用, base64 编码)
#[tauri::command]
pub fn fs_read(path: String, offset: u64, size: usize) -> Result<String, String> {
    let buf = read_range(&path, offset, size).ok_or_else(|| format!("not found: {path}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

// 写整个文件(data 为 base64 编码,存档/config 持久化用; 始终写磁盘)
#[tauri::command]
pub fn fs_write(path: String, data: String) -> Result<(), String> {
    let real = write_path(&path);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| e.to_string())?;
    if let Some(parent) = real.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&real, bytes).map_err(|e| e.to_string())
}

// 临时诊断: 探测虚拟路径在磁盘侧的真实状态(read_dir 的 errno 等)
#[tauri::command]
pub fn debug_probe(path: String) -> String {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    let rel = vpath_to_rel(&path);
    let root = data_root();
    let disk = root.join(&rel);
    let mut out = format!(
        "root={} | rel={} | disk={}",
        root.display(),
        rel,
        disk.display()
    );
    match std::fs::metadata(&disk) {
        Ok(m) => {
            // mode/uid/gid 仅 Unix 有; Windows 上退化为基本信息
            #[cfg(unix)]
            out.push_str(&format!(
                " | meta: dir={} file={} mode={:o} uid={} gid={}",
                m.is_dir(),
                m.is_file(),
                m.mode() & 0o7777,
                m.uid(),
                m.gid()
            ));
            #[cfg(not(unix))]
            out.push_str(&format!(
                " | meta: dir={} file={} len={}",
                m.is_dir(),
                m.is_file(),
                m.len()
            ));
        }
        Err(e) => out.push_str(&format!(" | meta ERR: {e}")),
    }
    match std::fs::read_dir(&disk) {
        Ok(it) => {
            let v: Vec<String> = it
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            out.push_str(&format!(
                " | read_dir ok n={} sample={:?}",
                v.len(),
                v.iter().take(6).collect::<Vec<_>>()
            ));
            if let Some(name) = v.first() {
                match std::fs::read(disk.join(name)) {
                    Ok(b) => out.push_str(&format!(" | first read ok {}B", b.len())),
                    Err(e) => out.push_str(&format!(" | first read ERR: {e}")),
                }
            }
        }
        Err(e) => out.push_str(&format!(" | read_dir ERR: {e}")),
    }
    out
}
