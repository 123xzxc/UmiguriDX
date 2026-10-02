// WebCrypto AES-CBC 解密 main.js.enc 并执行游戏前端。
const KEY = 'umiguri-2025-inonote-16bytes-key'; // 32 字节
const IV = 'umiguri-iv-16byt'; // 16 字节

// 解密失败历来只打一个 `{}` —— DOMException(WebCrypto 的失败)没有可枚举属性,
// console.error 的结构化打印就是空的, 于是「黑屏 + 解密失败: {}」看不出到底是
// 网络拿到空包、包被截断, 还是密钥不对。下面把它展开成人能读的一句话。
function describeError(e, extra) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || String(e);
  let hint = '';
  if (name === 'OperationError') hint = '密文被截断(长度不是 16 的倍数), 或密钥与打包时不一致';
  else if (name === 'TypeError') hint = 'main.js.enc 取回来的不是有效字节(404 或空)';
  else if (name === 'SyntaxError') hint = '解密出来的不是可执行脚本(包被换成了明文或别的文件)';
  else if (name === 'DataError') hint = '密文最后一块不完整(AES-CBC 需要整块)';
  return name + (hint ? ' (' + hint + ')' : '') + ': ' + msg + (extra ? ' | ' + extra : '');
}

export async function loadMain() {
  let enc = null;
  try {
    const res = await fetch('main.js.enc', { cache: 'no-store' });
    if (!res.ok) throw new TypeError('HTTP ' + res.status);
    enc = await res.arrayBuffer();
    // AES-CBC 要求密文长度是 16 的倍数, 且不可能为 0。
    // 截断(下载中断 / 产物写了一半)在这里就能认出来, 不必等到 decrypt 抛 OperationError。
    if (!enc.byteLength || enc.byteLength % 16 !== 0) throw new TypeError('密文长度异常 ' + enc.byteLength + ' 字节(应为 16 的倍数且 > 0)');
  } catch (e) {
    console.error('[decrypt-loader] 读取 main.js.enc 失败: ' + describeError(e));
    document.title = document.title + ' [游戏包读取失败]';
    return;
  }

  let code = null;
  try {
    const keyBytes = new TextEncoder().encode(KEY);
    const ivBytes = new TextEncoder().encode(IV);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, enc);
    code = new TextDecoder().decode(plain);
  } catch (e) {
    console.error('[decrypt-loader] 解密失败: ' + describeError(e, '密文 ' + enc.byteLength + ' 字节; 该包多半没下完整或被改过'));
    document.title = document.title + ' [游戏包解密失败]';
    return;
  }

  try {
    // 执行解密后的 main.js(游戏前端)
    (0, eval)(code);
  } catch (e) {
    console.error('[decrypt-loader] 游戏脚本执行失败: ' + describeError(e, '脚本 ' + code.length + ' 字符'));
  }
}
