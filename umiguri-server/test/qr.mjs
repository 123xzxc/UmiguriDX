// 二维码自检: 不只看「画出来了」, 而是把画好的矩阵**按规范反向读回来**,
// 再逐条核对规范公布的常数。零依赖, 直接 node test/qr.mjs 跑。
//
// 为什么值得写这么重: 二维码错一个模块就是扫不出来, 而「扫不出来」在服务端是静默的
// —— 面板照样显示一张图, 玩家扫半天没反应。所以这里做四件事:
//   1. 版本/分块表 -> 与规范附表里公布的「总码字数」「byte 模式容量」逐步对照;
//   2. 格式信息 / 版本信息 -> 与规范公布的 BCH 常数对照(0x5412 / 0x77C4 / 0x07C94);
//   3. 结构 -> 定位图形、定时图形、校正图形、固定黑模块;
//   4. 数据 -> 去掩码、按蛇形顺序读回、反交错、校验每块 Reed-Solomon 的综合式全零,
//      最后把码字流解析回原文, 必须与输入一字不差。

const {
  qrMatrix, qrSvg, qrDataUri, byteCapacity, rawDataModules, totalCodewords,
  alignPositions, formatBits, versionBits, maskBit,
} = await import("../src/lib/qr.js");

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  OK   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

// ---------- 独立的 GF(256): 用来验证纠错码字, 不复用被测模块的内部实现 ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ ((x & 0x80) ? 0x11d : 0); }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
// c(x) 在 a^i 处的取值; 纠错码字有效 <=> 每个 i 都是 0
function syndromesZero(block, ecLen) {
  for (let i = 0; i < ecLen; i++) {
    let acc = 0;
    for (const b of block) acc = mul(acc, EXP[i]) ^ b;
    if (acc !== 0) return false;
  }
  return true;
}

// ---------- 规范公布的常数(独立来源) ----------
const PUB_TOTAL_CODEWORDS = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };
const PUB_BYTE_CAPACITY_M = { 1: 14, 2: 26, 3: 42, 4: 62, 5: 84, 6: 106, 7: 122, 8: 152, 9: 180, 10: 213 };
const EC_PER_BLOCK = { 1: 10, 2: 16, 3: 26, 4: 18, 5: 24, 6: 16, 7: 18, 8: 22, 9: 22, 10: 26 };
const NUM_BLOCKS = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 4, 7: 4, 8: 4, 9: 5, 10: 5 };

console.log("== 版本 / 分块表 ==");
for (let v = 1; v <= 10; v++) {
  check("v" + v + " 总码字数 = " + PUB_TOTAL_CODEWORDS[v], totalCodewords(v) === PUB_TOTAL_CODEWORDS[v], String(totalCodewords(v)));
  check("v" + v + " byte 容量(M) = " + PUB_BYTE_CAPACITY_M[v], byteCapacity(v) === PUB_BYTE_CAPACITY_M[v], String(byteCapacity(v)));
}

console.log("== 格式 / 版本信息(BCH) ==");
check("格式信息 M+掩码0 = 0x5412", formatBits(0, 0) === 0x5412, "0x" + formatBits(0, 0).toString(16));
check("格式信息 L+掩码0 = 0x77C4", formatBits(1, 0) === 0x77c4, "0x" + formatBits(1, 0).toString(16));
check("格式信息 Q+掩码0 = 0x355F", formatBits(3, 0) === 0x355f, "0x" + formatBits(3, 0).toString(16));
check("格式信息 H+掩码0 = 0x1689", formatBits(2, 0) === 0x1689, "0x" + formatBits(2, 0).toString(16));
check("版本信息 v7 = 0x07C94", versionBits(7) === 0x07c94, "0x" + versionBits(7).toString(16));
check("版本信息 v10 = 0x0A4D3", versionBits(10) === 0x0a4d3, "0x" + versionBits(10).toString(16));
check("校正图形位置 v2 = [6,18]", alignPositions(2).join(",") === "6,18", alignPositions(2).join(","));
check("校正图形位置 v7 = [6,22,38]", alignPositions(7).join(",") === "6,22,38", alignPositions(7).join(","));
check("校正图形位置 v10 = [6,28,50]", alignPositions(10).join(",") === "6,28,50", alignPositions(10).join(","));
check("校正图形位置 v1 为空", alignPositions(1).length === 0);

// ---------- 反向读取 ----------

function readFormat(modules, size) {
  const pos = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const pos2 = [];
  for (let i = 0; i < 8; i++) pos2.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) pos2.push([8, size - 15 + i]);
  const bits = (list) => {
    let v = 0;
    for (let i = 0; i < 15; i++) if (modules[list[i][1]][list[i][0]]) v |= 1 << i;
    return v;
  };
  return { bits: bits(pos), bits2: bits(pos2) };
}

function readCodewords(m) {
  const { modules, isFunc, size, mask } = m;
  const out = [];
  let acc = 0, n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunc[y][x]) continue;
        let bit = modules[y][x];
        if (maskBit(mask, x, y)) bit = !bit;
        acc = (acc << 1) | (bit ? 1 : 0);
        n++;
        if (n === 8) { out.push(acc); acc = 0; n = 0; }
      }
    }
  }
  return out;
}

// 反交错: 把码字流拆回各块的(数据 + 纠错)
function splitBlocks(codewords, version) {
  const ecLen = EC_PER_BLOCK[version];
  const numBlocks = NUM_BLOCKS[version];
  const totalCw = totalCodewords(version);
  const shortBlocks = numBlocks - (totalCw % numBlocks);
  const shortLen = Math.floor(totalCw / numBlocks) - ecLen;
  const data = [], ecc = [];
  for (let i = 0; i < numBlocks; i++) {
    data.push(new Array(shortLen + (i < shortBlocks ? 0 : 1)).fill(0));
    ecc.push(new Array(ecLen).fill(0));
  }
  let p = 0;
  for (let i = 0; i <= shortLen; i++) for (let b = 0; b < numBlocks; b++) if (i < data[b].length) data[b][i] = codewords[p++];
  for (let i = 0; i < ecLen; i++) for (let b = 0; b < numBlocks; b++) ecc[b][i] = codewords[p++];
  return { data, ecc, ecLen, numBlocks };
}

function readBits(bytes, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const p = pos + i;
    v = (v << 1) | ((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  }
  return v;
}

// 完整解码: 码字流 -> 原文(失败返回 null)
function decode(m) {
  const flat = [];
  const blocks = splitBlocks(readCodewords(m), m.version);
  for (let i = 0; i < blocks.numBlocks; i++) {
    if (!syndromesZero(blocks.data[i].concat(blocks.ecc[i]), blocks.ecLen)) return null;
  }
  for (const d of blocks.data) flat.push(...d);
  if (readBits(flat, 0, 4) !== 0b0100) return null;
  const countBits = m.version <= 9 ? 8 : 16;
  const count = readBits(flat, 4, countBits);
  let text = "";
  for (let i = 0; i < count; i++) text += String.fromCharCode(readBits(flat, 4 + countBits + i * 8, 8));
  return text;
}

const SAMPLE = "otpauth://totp/UMIGURI:player1?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=UMIGURI&algorithm=SHA1&digits=6&period=30";

console.log("== 编解码往返 ==");
const m = qrMatrix(SAMPLE);
check("能编码", !!m);
check("取最小够用的版本", byteCapacity(m.version) >= SAMPLE.length && byteCapacity(m.version - (m.version > 1 ? 1 : 0)) !== undefined && byteCapacity(m.version - 1) < SAMPLE.length, "v" + m.version);
check("尺寸 = 4*版本+17", m.size === 4 * m.version + 17, String(m.size));

const fmt = readFormat(m.modules, m.size);
check("两份格式信息一致", fmt.bits === fmt.bits2, fmt.bits + " vs " + fmt.bits2);
check("格式信息含选中的掩码", fmt.bits === formatBits(0, m.mask), "0x" + fmt.bits.toString(16));
check("纠错等级是 M", ((fmt.bits ^ 0x5412) >>> 13) === 0, String((fmt.bits ^ 0x5412) >>> 13));

const at = (x, y) => m.modules[y][x];
check("定位图形中心是黑", at(3, 3) === true);
check("定位图形内圈是黑", at(2, 2) === true);
check("定位图形中圈是白", at(1, 1) === false);
check("定位图形外圈是黑", at(0, 0) === true && at(6, 0) === true && at(0, 6) === true);
check("右上/左下定位图形到位", at(m.size - 1, 0) === true && at(0, m.size - 1) === true);
check("分隔符是白", at(7, 7) === false && at(m.size - 8, 7) === false);
check("固定黑模块在 (8, size-8)", at(8, m.size - 8) === true);

// 定时图形: 校正图形压在定时线上的那几格不算(规范就是这么画的)
const centers = alignPositions(m.version);
const onTiming = (i) => centers.every((c) => c === 6 || Math.abs(i - c) > 2);
let timingOk = true;
for (let i = 8; i < m.size - 8; i++) if (onTiming(i) && at(i, 6) !== (i % 2 === 0)) timingOk = false;
check("定时图形深浅交替", timingOk);
if (m.version >= 7) check("校正图形确实压在定时线上(规范如此)", at(23, 6) === false, "v" + m.version);

const cw = readCodewords(m);
check("读回的码字数与规范一致", cw.length === totalCodewords(m.version), String(cw.length));
check("编码器产出的码字数与规范一致", m.codewords.length === totalCodewords(m.version), String(m.codewords.length));
check("所有字节都是 0-255", cw.every((c) => c >= 0 && c <= 255));

const blocks0 = splitBlocks(cw, m.version);
let allSyndromes = true;
for (let i = 0; i < blocks0.numBlocks; i++) {
  if (!syndromesZero(blocks0.data[i].concat(blocks0.ecc[i]), blocks0.ecLen)) allSyndromes = false;
}
check("每块的纠错码字都自洽(综合式全零)", allSyndromes);
check("解回来的原文一字不差", decode(m) === SAMPLE, String(decode(m)).slice(0, 50));

console.log("== 边界长度(每个版本两个端点) ==");
for (const len of [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106, 107, 122, 123, 152, 153, 180, 181, 213]) {
  const s = "A".repeat(len);
  const mm = qrMatrix(s);
  if (!mm) { check("长度 " + len + " 能编码", false); continue; }
  const same = decode(mm) === s;
  check("长度 " + len + " -> v" + mm.version + " 往返一致", same && byteCapacity(mm.version) >= len);
}
check("超出 10 版返回 null", qrMatrix("A".repeat(214)) === null);

console.log("== 输出 ==");
const svg = qrSvg("hello");
check("SVG 留白 4 模块(viewBox = 尺寸+8)", svg.svg.indexOf('viewBox="0 0 ' + (svg.size + 8) + " " + (svg.size + 8) + '"') !== -1, svg.svg.slice(0, 90));
check("SVG 含底色与前景色", svg.svg.indexOf('fill="#ffffff"') !== -1 && svg.svg.indexOf('fill="#000000"') !== -1);
check("SVG 是合法 XML 开头", svg.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));

// SVG 里的路径必须与矩阵严格一致: 把 d 属性解析回矩阵再逐格比对。
// (路径是「同行连续深色模块合并成一条横线」的压缩写法, 解析器只认这一种文法,
//  所以哪天改了路径格式而忘了改回来, 这里会当场红。)
function pathToMatrix(d, quiet, size) {
  const grid = [];
  for (let i = 0; i < size; i++) grid.push(new Array(size).fill(false));
  const re = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let m2, n = 0;
  while ((m2 = re.exec(d)) !== null) {
    const x = Number(m2[1]) - quiet, y = Number(m2[2]) - quiet, run = Number(m2[3]);
    if (Number(m2[4]) !== run) throw new Error("路径不对称");
    for (let i = 0; i < run; i++) grid[y][x + i] = true;
    n += run;
  }
  return { grid, drawn: n };
}
const pm = pathToMatrix(svg.svg, 4, svg.size);
const src = qrMatrix("hello");
let same = true, darkCount = 0;
for (let y = 0; y < svg.size; y++) {
  for (let x = 0; x < svg.size; x++) {
    if (pm.grid[y][x] !== src.modules[y][x]) same = false;
    if (src.modules[y][x]) darkCount++;
  }
}
check("SVG 路径与矩阵逐格一致", same && pm.drawn === darkCount, "drawn=" + pm.drawn + " dark=" + darkCount);
const uri = qrDataUri("hello");
check("data URI 前缀正确", String(uri).startsWith("data:image/svg+xml;base64,"), String(uri).slice(0, 40));
check("能放下的链接给得出二维码", typeof qrDataUri(SAMPLE) === "string");
check("超长内容返回 null", qrDataUri("A".repeat(400)) === null);

console.log("");
console.log("结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
