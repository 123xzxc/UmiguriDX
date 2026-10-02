// 曲目目录: musicId(@SONGID) -> { title, levels[] }。
//
// 为什么需要: 客户端上报的成绩里只有 musicId(@SONGID, 形如 MGT54bf...) 和
// musicDiff(难度槽位 0-5), 曲名与难度等级(如 14+)都只存在于谱面文件里 ——
// 服务端不参与游戏, 拿不到那份数据, 于是网页面板只能显示一串哈希。
//
// 这里直接扫游戏的 data/music/<分类>/<曲目>/*.ugc(或 .sus)表头:
//   @SONGID  -> 客户端上报的 musicId
//   @TITLE   -> 曲名
//   @DIFF    -> 难度槽位(与客户端 v_Q0_27805 的 BAS/ADV/EXP/MAS/WE/ULT 对应)
//   @LEVEL   -> 难度等级文本(完全保留原文, 含 14+ 这类写法)
// 目录不存在就什么都不做, 面板会退回显示原始 musicId/槽位号。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 难度槽位 -> 名字。与客户端 scope.v_Q0_27805 完全一致(顺序不能改)。
// index 4 = WE(World's End), index 5 = ULT(Ultima), 这两个不按数字等级显示。
export const DIFF_NAMES = ['BAS', 'ADV', 'EXP', 'MAS', 'WE', 'ULT'];

export function diffNameOf(slot) {
  const i = Number(slot);
  return Number.isInteger(i) && i >= 0 && i < DIFF_NAMES.length ? DIFF_NAMES[i] : '';
}

const here = path.dirname(fileURLToPath(import.meta.url));

// 候选根目录: 环境变量优先, 其次仓库里几个常见位置。
// here = src/lib, 所以仓库根是 ../../../。
function candidateRoots() {
  const out = [];
  const env = process.env.UMIGURI_MUSIC_DIR;
  if (env) out.push(env);
  const repo = path.resolve(here, '..', '..', '..');
  out.push(path.join(repo, 'open-umiguri', 'dist', 'game_data', 'data', 'music'));
  out.push(path.join(repo, 'open-umiguri', 'assets', 'data', 'music'));
  out.push(path.join(repo, 'open-umiguri', 'dist', 'game_data', 'music'));
  out.push(path.resolve(here, '..', '..', 'data', 'music'));
  return out;
}

let cache = null;

function parseChartMeta(text) {
  const meta = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line[0] !== '@') continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const key = line.slice(1, tab);
    const val = line.slice(tab + 1);
    if (key === 'SONGID') meta.songId = val.trim();
    else if (key === 'TITLE') meta.title = val.trim();
    else if (key === 'DIFF') meta.diff = Number.parseInt(val, 10);
    else if (key === 'LEVEL') meta.level = val.trim();
  }
  return meta;
}

function scanDir(root) {
  const bySong = new Map();
  let files = 0;
  // 分类 -> 曲目 -> 谱面文件, 只需两层就够; 用显式栈避免深目录递归爆栈。
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      const lower = e.name.toLowerCase();
      if (!lower.endsWith('.ugc') && !lower.endsWith('.sus')) continue;
      let text;
      try {
        // 谱面表头是纯 ASCII, 读前 8KB 足够(整首谱面可能几百 KB)。
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        text = buf.subarray(0, n).toString('utf8');
      } catch {
        continue;
      }
      const meta = parseChartMeta(text);
      if (!meta.songId || !meta.title) continue;
      files++;
      let rec = bySong.get(meta.songId);
      if (!rec) {
        rec = { title: meta.title, levels: [] };
        bySong.set(meta.songId, rec);
      }
      if (Number.isInteger(meta.diff) && meta.diff >= 0 && meta.diff < DIFF_NAMES.length) {
        rec.levels[meta.diff] = {
          diff: meta.diff,
          name: DIFF_NAMES[meta.diff],
          level: meta.level || '',
          // 客户端上报的就是这个槽位号, 面板按它去查。
          slot: meta.diff
        };
      }
    }
  }
  return { bySong, files };
}

// 惰性扫描一次并常驻。曲库变了重启服务端即可(扫描几十毫秒, 不值得做热更新)。
export function loadMusicCatalog() {
  if (cache) return cache;
  let best = { bySong: new Map(), files: 0, root: '' };
  for (const root of candidateRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    const res = scanDir(root);
    if (res.files > best.files) best = { ...res, root };
  }
  cache = best;
  return cache;
}

// 曲名; 查不到就返回空串(调用方自己决定退回显示什么)。
export function titleOf(musicId) {
  const rec = loadMusicCatalog().bySong.get(String(musicId));
  return rec ? rec.title : '';
}

// 难度等级文本(如 '14+'); 查不到返回空串。
export function levelOf(musicId, slot) {
  const rec = loadMusicCatalog().bySong.get(String(musicId));
  if (!rec) return '';
  const entry = rec.levels[Number(slot)];
  return entry ? entry.level : '';
}

// 面板专用的展示信息: 曲名 + 难度名 + 等级, 缺什么就退回什么。
export function describeRecord(musicId, slot) {
  const id = String(musicId);
  const rec = loadMusicCatalog().bySong.get(id);
  const name = diffNameOf(slot);
  const level = rec && rec.levels[Number(slot)] ? rec.levels[Number(slot)].level : '';
  return {
    musicId: id,
    musicTitle: rec ? rec.title : '',
    diffSlot: Number(slot),
    diffName: name,
    diffLevel: level,
    // 面板上直接显示这个: MAS 14+ / ULT / BAS 3 ...; 都缺就退回 '难度<槽位>'。
    diffLabel: name && level ? name + ' ' + level : name || (level || (Number.isFinite(Number(slot)) ? '难度' + slot : ''))
  };
}
