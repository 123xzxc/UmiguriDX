// 二维码(ISO/IEC 18004)生成器 —— 专给「绑定验证器」用: 把 otpauth:// 链接画成二维码,
// 玩家用 Google 验证器扫一下就绑好了, 不必手抄 32 位 Base32 密钥。
//
// 为什么自己写: 服务端承诺零第三方依赖(见 README), 面板也不外链任何 CDN
// (见 admin-ui.js 顶部) —— 而 Node 内置模块里没有任何二维码实现, 只能自己编。
//
// 只做面板真正需要的那一档, 复杂度花在「画对」上:
//   - byte 模式: 内容全是 ASCII 的 URL, 8 位字节最省事;
//   - 纠错等级 M: 二维码是给人拿手机扫的, 需要一定容错(约 15%);
//   - 版本 1-10 自适应: otpauth 链接最长约 150 字节, 8-10 版足够。再长就返回 null,
//     调用方退回「手抄密钥」的老路 —— 不为了几乎不会发生的情况把 40 个版本的
//     分块表全塞进来。
//
// 输出 SVG: 与分辨率无关, 手机上放大也不会糊, 且前端零依赖(直接 <img src="data:...">)。

export const QR_MAX_VERSION = 10;

// ---------- 有限域 GF(256) 与 Reed-Solomon ----------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// 生成多项式 (x-a^0)(x-a^1)...(x-a^(degree-1))。系数按降幂排列, 首项恒为 1。
export function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// 系统码: 数据码字原样在前, 后面补 degree 个纠错码字(综合除法取余)。
export function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---------- 版本 / 分块 ----------

// 纠错等级 M: 每块纠错码字数 / 块数。下标 = 版本号(1-10), 0 位空着。
// 这两张表是规范里的常数, 不能算出来 —— 而 dataCodewords / byteCapacity 由它们推得,
// 与规范附表里公布的容量一致(测试里逐个核对)。
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ECC_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

// 数据区总位数(不含功能图形)。规范的算法, 不是查表。
// 版本 1 没有任何校正图形, 也就不扣那部分位置; 版本 2 起每多一圈校正图形, 扣的位数不同。
export function rawDataModules(version) {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    bits -= (25 * align - 10) * align - 55;
    if (version >= 7) bits -= 36;
  }
  return bits;
}

// 码字总数。版本 2-6 的数据区不是 8 的整数倍 —— 多出来的那几位「余数位」不属于任何
// 码字, 补 0 之后照常参与掩码(规范 Annex 的做法), 所以这里必须向下取整。
export function totalCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

// 数据码字总数(不含纠错码字)
export function dataCodewords(version) {
  return totalCodewords(version) - ECC_PER_BLOCK[version] * ECC_BLOCKS[version];
}

// byte 模式能装多少字节: 4 位模式标示 + 字符计数(1-9 版 8 位, 10 版起 16 位) + 数据
export function byteCapacity(version) {
  const countBits = version <= 9 ? 8 : 16;
  return dataCodewords(version) - Math.ceil((4 + countBits) / 8);
}

// 校正图形的中心坐标(行列同一张表)。版本 1 没有校正图形。
export function alignPositions(version) {
  if (version <= 1) return [];
  const num = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (num * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < num; pos -= step) out.splice(1, 0, pos);
  return out;
}

function pickVersion(byteLength) {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (byteLength <= byteCapacity(v)) return v;
  return 0;
}

// ---------- 位流 ----------

function pushBits(bits, value, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

// 数据位流 -> 数据码字: 模式 + 计数 + 内容 + 终止符 + 字节对齐 + 补满(0xEC/0x11 交替)
function toCodewords(bytes, version) {
  const total = dataCodewords(version);
  const bits = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
  const cap = total * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(total);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out[i / 8] = v;
  }
  for (let i = bits.length / 8, k = 0; i < total; i++, k++) out[i] = k % 2 === 0 ? 0xec : 0x11;
  return out;
}

// 分块 + 交错: 数据码字按块切开各自算纠错, 再「先列后行」串成一条码字流。
// 块长不整除时, 多出来的那 1 个码字归**后面**的块(规范的分组方式)。
export function addEccBlocks(data, version) {
  const ecLen = ECC_PER_BLOCK[version];
  const numBlocks = ECC_BLOCKS[version];
  const totalCw = totalCodewords(version);
  const shortBlocks = numBlocks - (totalCw % numBlocks);
  const shortLen = Math.floor(totalCw / numBlocks) - ecLen;
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const part = data.subarray(pos, pos + len);
    pos += len;
    blocks.push({ data: part, ecc: rsEncode(part, ecLen) });
  }
  const out = [];
  for (let i = 0; i <= shortLen; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of blocks) out.push(b.ecc[i]);
  }
  return out;
}

// ---------- 格式 / 版本信息 ----------

// 格式信息: 2 位纠错等级 + 3 位掩码, BCH(15,5) 校验后与 0x5412 异或。
// 纠错等级的两位编码: L=01 M=00 Q=11 H=10 —— M 是 0。
export function formatBits(ecl, mask) {
  const data = ((ecl & 3) << 3) | (mask & 7);
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

// 版本信息(版本 7 起): 6 位版本号 + BCH(18,6) 校验。
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

// ---------- 掩码 ----------

export function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function matchRun(at, x, y, dx, dy, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (at(x + dx * i, y + dy * i) !== pattern[i]) return false;
  }
  return true;
}

// 掩码评分: 规范的四条规则(N1 同色连续 / N2 同色块 / N3 类定位图形 / N4 明暗失衡)。
// 八种掩码都算一遍, 取分最低的 —— 分数只影响可扫性, 不影响正确性。
function penaltyScore(modules, size) {
  const at = (x, y) => modules[y][x];
  let score = 0;

  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (at(x, y) === at(x - 1, y)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else run = 1;
    }
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (at(x, y) === at(x, y - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else run = 1;
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
    }
  }

  // 1:1:3:1:1 特征串, 四个方向一致的浅色带只认「前四」或「后四」两种摆法。
  const P1 = [true, false, true, true, true, false, true];
  const P2 = [false, false, false, false];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 11 <= size; x++) {
      if (matchRun(at, x, y, 1, 0, P1) && matchRun(at, x + 7, y, 1, 0, P2)) score += 40;
      if (matchRun(at, x, y, 1, 0, P2) && matchRun(at, x + 4, y, 1, 0, P1)) score += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y + 11 <= size; y++) {
      if (matchRun(at, x, y, 0, 1, P1) && matchRun(at, x, y + 7, 0, 1, P2)) score += 40;
      if (matchRun(at, x, y, 0, 1, P2) && matchRun(at, x, y + 4, 0, 1, P1)) score += 40;
    }
  }

  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at(x, y)) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

// ---------- 矩阵 ----------

// 把码字流铺成完整的符号。返回 { modules, isFunc, size, version, mask }。
export function buildMatrix(version, codewords) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunc = [];
  for (let i = 0; i < size; i++) {
    modules.push(new Array(size).fill(false));
    isFunc.push(new Array(size).fill(false));
  }
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    isFunc[y][x] = true;
  };
  const bitOf = (bits, i) => ((bits >>> i) & 1) !== 0;

  // 定位图形(7x7)与分隔符(d=4, 浅色)
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // 定时图形: 第 6 行与第 6 列, 深浅交替
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  // 校正图形(5x5)。三个角上的会压到定位图形, 不画; 其余(包括压在定时线上的)照画。
  const align = alignPositions(version);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const cx = align[j];
      const cy = align[i];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 版本信息(版本 7 起, 右上与左下各一份)
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = bitOf(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // 格式信息: 先按掩码 0 写一遍, 把 15 个位置占成功能模块; 掩码定下来后再写真值。
  const writeFormat = (mask) => {
    const bits = formatBits(0, mask); // 纠错等级 M -> 两位编码 00
    for (let i = 0; i <= 5; i++) set(8, i, bitOf(bits, i));
    set(8, 7, bitOf(bits, 6));
    set(8, 8, bitOf(bits, 7));
    set(7, 8, bitOf(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bitOf(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bitOf(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bitOf(bits, i));
    set(8, size - 8, true); // 规范要求的固定黑模块
  };
  writeFormat(0);

  // 数据: 自右下角起, 两列一组蛇形填充, 跳过功能图形。第 6 列是定时线, 整列跳过。
  // 码字流填不满数据区时剩下的就是余数位(只出现在版本 2-6), 保持浅色, 掩码照常参与。
  const dataBits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) dataBits.push(((cw >>> i) & 1) !== 0);
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && idx < dataBits.length) modules[y][x] = dataBits[idx++];
      }
    }
  }

  // 选掩码: 八种都试一遍取最低分, 再把选中的那种真正应用上。
  let best = 0;
  let bestScore = Infinity;
  const flip = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunc[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };
  for (let mask = 0; mask < 8; mask++) {
    flip(mask);
    const score = penaltyScore(modules, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    flip(mask);
  }
  flip(best);
  writeFormat(best);

  return { modules, isFunc, size, version, mask: best };
}

// ---------- 对外 ----------

// 完整矩阵 + 元信息; 装不下时返回 null。
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  if (!version) return null;
  const codewords = addEccBlocks(toCodewords(bytes, version), version);
  const m = buildMatrix(version, codewords);
  return { ...m, byteLength: bytes.length, codewords };
}

// 画成 SVG。quiet 是四周的留白(规范要求至少 4 个模块)。
export function qrSvg(text, opts) {
  const o = opts || {};
  const m = qrMatrix(text);
  if (!m) return null;
  const dark = o.dark || "#000000";
  const light = o.light || "#ffffff";
  const quiet = o.quiet === undefined ? 4 : o.quiet;
  const dim = m.size + quiet * 2;
  // 同一行里连续的深色模块合并成一条横线: 路径短一大截(整个 data URI 能小 4 倍左右),
  // 画出来的东西一模一样。
  let path = "";
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < m.size && m.modules[y][x + run]) run++;
      path += "M" + (x + quiet) + " " + (y + quiet) + "h" + run + "v1h-" + run + "z";
      x += run;
    }
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" ' +
    'shape-rendering="crispEdges" role="img" aria-label="TOTP 二维码">' +
    '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
    '<path d="' + path + '" fill="' + dark + '"/></svg>';
  return { svg, version: m.version, size: m.size, mask: m.mask, byteLength: m.byteLength };
}

// data: URI —— 面板直接 <img src="...">。放不下时返回 null。
export function qrDataUri(text, opts) {
  const r = qrSvg(text, opts);
  if (!r) return null;
  return "data:image/svg+xml;base64," + Buffer.from(r.svg, "utf8").toString("base64");
}
