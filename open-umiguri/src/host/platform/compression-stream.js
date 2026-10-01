// CompressionStream / DecompressionStream 兜底(仅在该 API 缺失时安装)。
//
// 为什么需要: 游戏本体(反混淆 bundle)读归档时, 对 M2=true 的文件体调用
//     new DecompressionStream("gzip")
// 而 Compression Streams 是 Safari 16.4(macOS 13.3 / iOS 16.4)才加入的 API。
// Windows 的 WebView2 是 Chromium, 一直具备, 所以在 macOS 旧版 WKWebView 上才暴露。
// 更麻烦的是失败被静默吞掉: 游戏侧是
//     if (M2) try { x = await new mc(x.subarray(1)).gR() } catch { return null }
// 于是归档全部读不到、且没有任何报错 -> 启动黑屏无反应。
//
// 打包产物里 core/una/*.una 与 data/**/data.arc 全部是 M2=true(见 build/pack-assets.mjs
// 的 m2: true), 所以这里不是可选优化, 而是启动必需。
//
// 覆盖范围: macOS 11.3(Safari 14.1, 有 Blob.stream/ReadableStream)~ 13.2(Safari 16.3)。
// 更早的 WebKit 连 Blob.stream() 都没有, 游戏本体自身就跑不起来, 不在此文件职责内。

// ---------- 校验和 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(u8) {
  let c = -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(u8) {
  let a = 1, b = 0;
  for (let i = 0; i < u8.length; i++) {
    a = (a + u8[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- DEFLATE(RFC1951)解码 ----------
// 按 puff 的结构实现: 位序 LSB-first, Huffman 码按规范表解码。
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// 动态块里「码长码」的传输顺序(RFC1951 §3.2.7)
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  // 完备性检查: 按规范码长累计不能过订阅
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw new Error('[umg][inflate] Huffman 码过订阅');
  }
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

let fixedLit = null;
let fixedDist = null;
function getFixed() {
  if (!fixedLit) {
    const len = new Uint8Array(288);
    let i = 0;
    for (; i < 144; i++) len[i] = 8;
    for (; i < 256; i++) len[i] = 9;
    for (; i < 280; i++) len[i] = 7;
    for (; i < 288; i++) len[i] = 8;
    fixedLit = buildHuffman(len, 288);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

// 从 src[from..] 解出一个完整的 DEFLATE 流(不含 gzip/zlib 头)。
export function inflateRaw(src, from) {
  let pos = from | 0;
  let bitBuf = 0;
  let bitCnt = 0;

  let out = new Uint8Array(Math.max(256, src.length * 3));
  let len = 0;

  function ensure(extra) {
    if (len + extra <= out.length) return;
    let cap = out.length;
    while (cap < len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, len));
    out = next;
  }

  function bits(need) {
    if (need === 0) return 0;
    while (bitCnt < need) {
      if (pos >= src.length) throw new Error('[umg][inflate] 输入提前结束');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << need) - 1);
    bitBuf >>>= need;
    bitCnt -= need;
    return v;
  }

  function decodeSym(t) {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l <= 15; l++) {
      code |= bits(1);
      const count = t.counts[l];
      if (code - count < first) return t.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('[umg][inflate] 非法 Huffman 码');
  }

  function copyBack(dist, count) {
    if (dist > len) throw new Error('[umg][inflate] 距离越界');
    ensure(count);
    let from2 = len - dist;
    for (let i = 0; i < count; i++) out[len + i] = out[from2 + i];
    len += count;
  }

  function block(lencode, distcode) {
    for (;;) {
      const sym = decodeSym(lencode);
      if (sym < 256) {
        ensure(1);
        out[len++] = sym;
        continue;
      }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= LEN_BASE.length) throw new Error('[umg][inflate] 非法长度码 ' + sym);
      const count = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const dsym = decodeSym(distcode);
      if (dsym >= DIST_BASE.length) throw new Error('[umg][inflate] 非法距离码 ' + dsym);
      copyBack(DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]), count);
    }
  }

  function storedBlock() {
    // 对齐到字节边界: 丢掉当前字节里剩余位, 并把位缓冲里整字节的输入退回
    const drop = bitCnt & 7;
    if (drop) {
      bitBuf >>>= drop;
      bitCnt -= drop;
    }
    pos -= bitCnt >> 3;
    bitBuf = 0;
    bitCnt = 0;
    if (pos + 4 > src.length) throw new Error('[umg][inflate] stored 块头缺失');
    const n = src[pos] | (src[pos + 1] << 8);
    const nn = src[pos + 2] | (src[pos + 3] << 8);
    pos += 4;
    if ((n ^ 0xffff) !== nn) throw new Error('[umg][inflate] stored LEN/NLEN 不匹配');
    if (pos + n > src.length) throw new Error('[umg][inflate] stored 数据越界');
    ensure(n);
    out.set(src.subarray(pos, pos + n), len);
    len += n;
    pos += n;
  }

  function dynamicBlock() {
    const hlit = bits(5) + 257;
    const hdist = bits(5) + 1;
    const hclen = bits(4) + 4;
    const clLens = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) clLens[CL_ORDER[i]] = bits(3);
    const clTree = buildHuffman(clLens, 19);

    const total = hlit + hdist;
    const lens = new Uint8Array(total);
    let i = 0;
    while (i < total) {
      const sym = decodeSym(clTree);
      if (sym < 16) {
        lens[i++] = sym;
        continue;
      }
      let prev = 0, count;
      if (sym === 16) {
        if (i === 0) throw new Error('[umg][inflate] 码长重复但无前值');
        prev = lens[i - 1];
        count = 3 + bits(2);
      } else if (sym === 17) {
        count = 3 + bits(3);
      } else {
        count = 11 + bits(7);
      }
      if (i + count > total) throw new Error('[umg][inflate] 码长重复越界');
      while (count--) lens[i++] = prev;
    }
    block(buildHuffman(lens.subarray(0, hlit), hlit), buildHuffman(lens.subarray(hlit), hdist));
  }

  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) storedBlock();
    else if (type === 1) {
      const [lit, dist] = getFixed();
      block(lit, dist);
    } else if (type === 2) dynamicBlock();
    else throw new Error('[umg][inflate] 非法块类型 ' + type);
    if (last) break;
  }
  return out.subarray(0, len);
}

// gzip 容器(RFC1952): 跳过可选字段后即为裸 DEFLATE
function gunzip(u8) {
  if (u8.length < 18) throw new Error('[umg][gunzip] 数据过短');
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) throw new Error('[umg][gunzip] 魔数不匹配');
  if (u8[2] !== 8) throw new Error('[umg][gunzip] 压缩方法不是 deflate: ' + u8[2]);
  const flg = u8[3];
  let p = 10;
  if (flg & 4) {
    if (p + 2 > u8.length) throw new Error('[umg][gunzip] FEXTRA 越界');
    p += 2 + (u8[p] | (u8[p + 1] << 8));
  }
  if (flg & 8) { while (p < u8.length && u8[p]) p++; p++; }
  if (flg & 16) { while (p < u8.length && u8[p]) p++; p++; }
  if (flg & 2) p += 2;
  if (p > u8.length) throw new Error('[umg][gunzip] 头部越界');
  return inflateRaw(u8, p);
}

// zlib 容器(RFC1950)
function inflateZlib(u8) {
  if (u8.length < 6) throw new Error('[umg][inflate] zlib 数据过短');
  const cmf = u8[0], flg = u8[1];
  if ((cmf & 0x0f) !== 8) throw new Error('[umg][inflate] zlib 压缩方法不是 deflate');
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error('[umg][inflate] zlib 头校验失败');
  const p = flg & 0x20 ? 6 : 2; // FDICT: 跳过 4 字节字典 id
  return inflateRaw(u8, p);
}

// ---------- DEFLATE 编码 ----------
// 只用 stored(未压缩)块: 完全合法、实现简单、不会出错。压缩率不是这里的目标
// (该路径用于存档/上传, 体积远小于归档), 正确性优先。
function deflateStored(u8) {
  const n = u8.length;
  const blocks = Math.max(1, Math.ceil(n / 65535));
  const out = new Uint8Array(blocks * 5 + n);
  let o = 0, p = 0;
  for (let i = 0; i < blocks; i++) {
    const take = Math.min(65535, n - p);
    out[o++] = i === blocks - 1 ? 1 : 0; // BFINAL + BTYPE=00
    out[o++] = take & 0xff;
    out[o++] = (take >> 8) & 0xff;
    out[o++] = ~take & 0xff;
    out[o++] = (~take >> 8) & 0xff;
    out.set(u8.subarray(p, p + take), o);
    o += take;
    p += take;
  }
  return out;
}

function gzipStored(u8) {
  const body = deflateStored(u8);
  const out = new Uint8Array(18 + body.length);
  out[0] = 0x1f;
  out[1] = 0x8b;
  out[2] = 8;
  out[9] = 255; // OS=unknown
  out.set(body, 10);
  const crc = crc32(u8);
  const size = u8.length >>> 0;
  const t = 10 + body.length;
  for (let i = 0; i < 4; i++) {
    out[t + i] = (crc >>> (i * 8)) & 0xff;
    out[t + 4 + i] = (size >>> (i * 8)) & 0xff;
  }
  return out;
}

function zlibStored(u8) {
  const body = deflateStored(u8);
  const out = new Uint8Array(6 + body.length);
  out[0] = 0x78;
  out[1] = 0x01; // FCHECK 满足 (0x7801 % 31 === 0)
  out.set(body, 2);
  const ad = adler32(u8);
  const t = 2 + body.length;
  for (let i = 0; i < 4; i++) out[t + i] = (ad >>> (24 - i * 8)) & 0xff;
  return out;
}

// ---------- 流封装 ----------
const DECODERS = {
  gzip: gunzip,
  deflate: inflateZlib,
  'deflate-raw': (u8) => inflateRaw(u8, 0),
};
const ENCODERS = {
  gzip: gzipStored,
  deflate: zlibStored,
  'deflate-raw': deflateStored,
};

function toU8(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof ArrayBuffer !== 'undefined' && chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError('[umg][compression] 只接受 BufferSource');
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// 攒齐输入后在 close 时一次性转换。游戏侧本来就是
// new Response(stream).arrayBuffer() / .blob(), 不做流式增量输出也不影响行为。
function makeStreams(run) {
  const chunks = [];
  let ctrl = null;
  const readable = new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  const writable = new WritableStream({
    write(chunk) {
      chunks.push(toU8(chunk));
    },
    close() {
      try {
        const out = run(concat(chunks));
        if (out.length) ctrl.enqueue(out);
        ctrl.close();
      } catch (e) {
        try {
          ctrl.error(e);
        } catch (e2) {}
      }
    },
    abort(reason) {
      try {
        ctrl.error(reason);
      } catch (e) {}
    },
  });
  return { readable, writable };
}

class DecompressionStreamPolyfill {
  constructor(format) {
    const run = DECODERS[String(format)];
    if (!run) throw new TypeError("Unsupported format: " + format);
    const s = makeStreams(run);
    this.readable = s.readable;
    this.writable = s.writable;
  }
}

class CompressionStreamPolyfill {
  constructor(format) {
    const run = ENCODERS[String(format)];
    if (!run) throw new TypeError("Unsupported format: " + format);
    const s = makeStreams(run);
    this.readable = s.readable;
    this.writable = s.writable;
  }
}

// 致命前置条件缺失时的可见提示(与 storage-access.js 的横幅同一思路):
// 游戏侧的解压失败被吞成 null, 只会留下黑屏, 不报出来无法定位。
function showFatal(message) {
  try {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#7a1010;color:#fff;' +
      'font:14px/1.7 system-ui;padding:16px 20px;white-space:pre-wrap';
    el.textContent = message;
    (document.body || document.documentElement).appendChild(el);
  } catch (e) {}
}

// 按需安装。原生存在时不动它; Web Streams 缺失时也不装(装了也跑不起来)。
export function installCompressionStreams() {
  const missing = [];
  if (typeof DecompressionStream === 'undefined') missing.push('DecompressionStream');
  if (typeof CompressionStream === 'undefined') missing.push('CompressionStream');
  if (!missing.length) return [];
  if (typeof ReadableStream === 'undefined' || typeof WritableStream === 'undefined') {
    console.error('[umg][compression] 缺少 Web Streams, 无法安装兜底: ' + missing.join(','));
    // 这一档无法自愈, 而且游戏侧会把解压失败吞成 null -> 纯黑屏且无报错。显式报出来。
    showFatal(
      '启动失败: 当前 WebView 不支持 Compression Streams, 且缺少 Web Streams 无法兜底。\n' +
        '缺少: ' + missing.join(', ') + '\n' +
        '请升级 macOS(需 11.3 及以上)/ iOS(需 14.1 及以上)。'
    );
    return [];
  }
  if (typeof DecompressionStream === 'undefined') window.DecompressionStream = DecompressionStreamPolyfill;
  if (typeof CompressionStream === 'undefined') window.CompressionStream = CompressionStreamPolyfill;
  console.log('[umg][compression] 已安装 ' + missing.join(',') + ' 兜底(WebKit < 16.4)');
  return missing;
}
