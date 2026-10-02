// window.umgr_elc: 游戏 -> 宿主(Tauri)桥。
import { invoke, tryInvoke } from '../core/invoke.js';
import { cachedFile, rangeFile, schedulePrefetch } from '../core/protocol.js';
import { toB64 } from '../core/encoding.js';
import { handshake } from './handshake.js';

const notImplementedStatus = async () => ({ status: -1 });

export const umgrElc = {
  enable: true,
  _: handshake,
  st: {
    zu: (p) =>
      invoke('fs_list', { path: p }).then((r) => {
        // 目录列出后, 后台并行预取小文件(游戏随后会逐个 sn)
        try { schedulePrefetch(p, r && r.data); } catch (e) {}
        return r;
      }),
    sn: (p) => cachedFile(p).then((data) => ({ status: 0, data })).catch(() => ({ status: -1 })),
    _2: (p) =>
      invoke('fs_size', { path: p })
        .then((r) => ({ status: r.status, data: { val: r.data } }))
        .catch(() => ({ status: -1 })),
    xl: (p, offset, size) =>
      rangeFile(p, offset, size)
        .then(({ data }) => ({
          status: 0,
          data: { buf: data, br: data.length },
        }))
        .catch(() => ({ status: -1 })),
    Qf: async () => ({ status: 0, data: { used: 0, free: 1000000000, cap: 1000000000 } }),
    e2: notImplementedStatus,
    yl: notImplementedStatus,
    i2: notImplementedStatus,
    n2: notImplementedStatus,
    o2: notImplementedStatus,
    l2: notImplementedStatus,
    Xu: (p, data) =>
      invoke('fs_write', { path: p, data: toB64(data) })
        .then(() => ({ status: 0, data: { entry: null, writer: null } }))
        .catch(() => ({ status: -1, data: { entry: null, writer: null } })),
  },
  // 联机服务端桥。游戏侧通过 window.umgr_elc.online 调用。
  // 走宿主 Rust 侧的 fetch_json(绕过 WebView 跨源限制), 因此聊天/房间接口
  // 可以部署在任意域名, 不受打包页面的 origin 限制。
  online: {
    // 当前服务端地址。游戏侧可用 online.setBase() 覆盖(便于切换自建服)。
    base: '',
    setBase(url) {
      this.base = String(url || '');
    },
    // 统一请求入口(相对路径, 拼 this.base)。
    request(method, path, body, token) {
      return this.requestUrl(method, (this.base || '') + path, body, token);
    },
    // 绝对地址请求入口。返回 { ok, status, data, error }:
    //   ok=true + status=2xx  -> data 为解析后的 JSON
    //   ok=true + status>=400 -> data 为服务端错误体, error 为其中的 error 字段
    //   ok=false              -> 网络层失败(连不上/超时), error 为原因
    // 不抛异常: 联机界面需要区分「服务端拒绝」与「连不上」并给出不同提示。
    //
    // 为什么要单独开一个「绝对地址」入口: 游戏自带的联机客户端(v_Bs_28013)有自己
    // 的 host:port(1/... 原生协议), 与账号模块的 base 不是一个地址; 共用 base 会
    // 互相覆盖。更要紧的是它原来在 WebView 里直连 fetch http://内网IP:端口 ——
    // macOS(WKWebView)会按 ATS/混合内容拦掉, 表现就是「宿主登录一切正常, 游戏端
    // 却死活登录不上、成绩不上传」。走这里(Rust fetch_json)与宿主登录同一条路,
    // 不受 WebView 的跨源/ATS 限制。
    async requestUrl(method, url, body, token) {
      let r;
      try {
        r = await invoke('fetch_json', {
          method: String(method || 'GET').toUpperCase(),
          url,
          body: body === undefined || body === null ? null : JSON.stringify(body),
          token: token ? String(token) : null,
        });
      } catch (e) {
        return { ok: false, status: 0, data: null, error: (e && e.message) || String(e) };
      }
      if (!r || r.ok !== true) {
        return { ok: false, status: 0, data: null, error: (r && r.error) || '请求失败' };
      }
      let data = null;
      try {
        data = r.body ? JSON.parse(r.body) : null;
      } catch (e) {
        return { ok: false, status: r.status, data: null, error: '服务端返回非 JSON' };
      }
      const status = r.status || 0;
      const okHttp = status >= 200 && status < 300;
      return {
        ok: okHttp,
        status,
        data,
        error: okHttp ? null : (data && data.error) || ('HTTP ' + status),
      };
    },
    get(path, token) { return this.request('GET', path, null, token); },
    post(path, body, token) { return this.request('POST', path, body, token); },
    patch(path, body, token) { return this.request('PATCH', path, body, token); },
    delete(path, token) { return this.request('DELETE', path, null, token); },
  },
  si: {
    Vu: async () => ({}),
    w2: async () => ({}),
    se: async () => ({}),
    sr: async () => ({}),
    S2: async () => ({}),
    fc: async () => ({}),
    sc: async () => false,
    jc: async () => ({}),
    ss: async () => ({}),
    so: async () => ({}),
    xo: async () => {},
    sp: async () => ({}),
    op: async () => ({}),
    t4: async () => ({}),
    r4: async () => {},
    f4: async () => {},
    s4: async () => ({}),
    d4: async () => {},
    a4: async () => {},
    t2: async () => false,
    sa: async () => null,
  },
  g4: {
    x4: async (cb) => {
      console.log('[BRIDGE] g4.x4');
    },
    jc: async (lang, force) => {
      console.log('[BRIDGE] g4.jc', lang, force);
      return [];
    },
    ss: async () => {
      console.log('[BRIDGE] g4.ss');
    },
    so: async () => {
      console.log('[BRIDGE] g4.so');
    },
    xo: async () => {
      console.log('[BRIDGE] g4.xo');
    },
    sp: async (lang) => {
      try {
        localStorage.setItem('umg_lang', lang);
      } catch (e) {}
    },
  },
};

export function installUmgrElc() {
  window.umgr_elc = umgrElc;
}

export { tryInvoke };
