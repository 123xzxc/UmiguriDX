#!/usr/bin/env node
// touch-file.mjs - 跨平台 touch: 更新传入文件的 mtime(文件不存在则创建)。
// tauri.conf.json 的 beforeDevCommand/beforeBuildCommand 用它强制 cargo 重建宿主 crate。
// Windows 的 cmd 没有 touch(CI 上靠 Git Bash 提供), 这里用 Node 统一替代。
import fs from 'node:fs';
import path from 'node:path';

const now = new Date();
for (const rel of process.argv.slice(2)) {
  const file = path.resolve(rel);
  if (fs.existsSync(file)) {
    fs.utimesSync(file, now, now);
  } else {
    fs.closeSync(fs.openSync(file, 'a'));
  }
}
