// 模块: account
// 联机账号与云端存档。走 window.umgr_elc.online 桥(宿主 Rust 侧发起请求,
// 不受打包页面 origin 限制)。
//
// 职责:
//   - 注册 / 登录 / 登出, token 持久化
//   - 拉取与更新资料(显示名 / 称号牌 / 称号), 并回写到 handshake
//   - 对局结果上报
//   - 房间联机(6 位数字房间号)与实时对手分数轮询
//
// 设计约束(非常重要):
//   游戏前端会经 --obfuscate 混淆打包, 因此本模块起名时**刻意避免**形参与
//   局部变量同名 —— 混淆后二者会被视为同一绑定, 守卫会读到被覆盖的值。
//   此前 A3 的形参 v_t_34451 被同名的 flags 局部量遮蔽, 直接造成 macOS 版
//   界面无文字(见 open-umiguri/REGRESSION.md)。

export function createAccount(scope) {
  const LOGIN_KEY = 'umg_online_token';
  const BASE_KEY = 'umg_online_base';

  const account = {
    token: null,
    profile: null,
    online: false,
    room: null,
    roomVersion: 0,
    onRoomUpdate: null,
    _pollTimer: null,
    _progressTimer: null
  };

  function bridge() {
    return (typeof window !== 'undefined' && window.umgr_elc && window.umgr_elc.online) || null;
  }

  function log(msg) {
    try {
      console.log('[umg][online] ' + msg);
    } catch (e) {}
  }

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (e) {}
  }

  function getBase() {
    return readStore(BASE_KEY) || '';
  }

  function setBase(url) {
    const next = String(url || '').replace(/\/+$/, '');
    writeStore(BASE_KEY, next || null);
    const b = bridge();
    if (b) b.setBase(next);
    return next;
  }

  async function request(method, path, body, useAuth) {
    const b = bridge();
    if (!b) return { ok: false, status: 0, data: null, error: '宿主联机桥不可用' };
    if (!b.base && getBase()) b.setBase(getBase());
    if (!b.base) return { ok: false, status: 0, data: null, error: '未配置服务端地址' };
    const useToken = useAuth === false ? null : account.token;
    return b.request(method, path, body, useToken);
  }

  function setToken(token) {
    account.token = token || null;
    writeStore(LOGIN_KEY, token || null);
  }

  function restoreToken() {
    account.token = readStore(LOGIN_KEY);
    return account.token;
  }

  async function register(username, password) {
    const r = await request('POST', '/auth/register', { username, password }, false);
    if (!r.ok) return r;
    setToken(r.data.token);
    account.profile = r.data.user;
    account.online = true;
    applyProfileToHandshake();
    log('注册成功: ' + r.data.user.username);
    return r;
  }

  async function login(username, password) {
    const r = await request('POST', '/auth/login', { username, password }, false);
    if (!r.ok) return r;
    setToken(r.data.token);
    account.profile = r.data.user;
    account.online = true;
    applyProfileToHandshake();
    log('登录成功: ' + r.data.user.username);
    return r;
  }

  function logout() {
    setToken(null);
    account.profile = null;
    account.online = false;
    stopRoomPolling();
    stopProgressReport();
    log('已登出');
  }

  // 启动时若本地有 token, 静默拉一次资料校验有效性
  async function restoreSession() {
    restoreToken();
    if (!account.token) return false;
    const r = await request('GET', '/profile');
    if (!r.ok) {
      log('本地登录态已失效: ' + r.error);
      setToken(null);
      return false;
    }
    account.profile = r.data.user;
    account.online = true;
    applyProfileToHandshake();
    log('已恢复登录: ' + r.data.user.username);
    return true;
  }

  // ---- 资料: 显示名 / 称号牌 / 称号 ----
  async function updateProfile(fields) {
    const r = await request('PATCH', '/profile', fields);
    if (!r.ok) return r;
    account.profile = r.data.user;
    applyProfileToHandshake();
    return r;
  }

  // 把云端资料写进握手数据。
  // 游戏用 handshake.rm.om 作为玩家显示名(coopLobby 的 nameEntry 也写这里),
  // 因此这里是「云端名字」与「游戏内名字」的唯一交汇点。
  function applyProfileToHandshake() {
    const p = account.profile;
    const hs = scope.handshake;
    if (!p || !hs) return;
    try {
      if (!hs.rm) hs.rm = {};
      hs.rm.om = p.displayName;
      if (!hs.rm.gb) hs.rm.gb = {};
      hs.rm.gb.name = p.displayName;
      hs.rm.gb.nameplate = p.nameplate;
      hs.rm.gb.title = p.title;
      log('已应用云端资料: ' + p.displayName);
    } catch (e) {
      log('写入手握数据失败: ' + ((e && e.message) || e));
    }
  }

  async function reportPlay(result) {
    if (!account.online) return { ok: false, status: 0, data: null, error: '未登录' };
    const r = await request('POST', '/plays', result);
    if (r.ok) log('成绩已上报: ' + result.musicId + ' ' + result.score + (r.data.isBest ? ' (个人最佳)' : ''));
    else log('成绩上报失败: ' + r.error);
    return r;
  }

  async function fetchLeaderboard(musicId, difficulty) {
    const qs = musicId === undefined || musicId === null
      ? ''
      : '?musicId=' + encodeURIComponent(musicId) + '&difficulty=' + encodeURIComponent(difficulty || 0);
    return request('GET', '/leaderboard' + qs);
  }

  // ---- 房间联机 ----
  function setRoom(room) {
    account.room = room || null;
    account.roomVersion = room ? room.version : 0;
  }

  function roomCode() {
    return account.room && account.room.code;
  }

  async function createRoom(musicId, difficulty) {
    const r = await request('POST', '/rooms', { musicId, difficulty });
    if (r.ok) {
      setRoom(r.data.room);
      startRoomPolling();
    }
    return r;
  }

  async function joinRoom(code) {
    // 房间号: 6 位纯数字, 与游戏 openCoop 的 inputDigit0~5 对应
    if (!/^[0-9]{6}$/.test(String(code))) {
      return { ok: false, status: 0, data: null, error: '房间号必须是 6 位数字' };
    }
    const r = await request('POST', '/rooms/' + code + '/join', {});
    if (r.ok) {
      setRoom(r.data.room);
      startRoomPolling();
    }
    return r;
  }

  async function leaveRoom() {
    stopRoomPolling();
    stopProgressReport();
    const code = roomCode();
    account.room = null;
    if (!code) return { ok: true, status: 200, data: null, error: null };
    const r = await request('POST', '/rooms/' + code + '/leave', {});
    log('已离开房间 ' + code);
    return r;
  }

  async function setReady(ready) {
    const code = roomCode();
    if (!code) return { ok: false, status: 0, data: null, error: '不在房间中' };
    const r = await request('POST', '/rooms/' + code + '/ready', { ready: !!ready });
    if (r.ok) setRoom(r.data.room);
    return r;
  }

  async function selectMusic(musicId, difficulty) {
    const code = roomCode();
    if (!code) return { ok: false, status: 0, data: null, error: '不在房间中' };
    const r = await request('POST', '/rooms/' + code + '/music', { musicId, difficulty });
    if (r.ok) setRoom(r.data.room);
    return r;
  }

  async function startMatch() {
    const code = roomCode();
    if (!code) return { ok: false, status: 0, data: null, error: '不在房间中' };
    const r = await request('POST', '/rooms/' + code + '/start', {});
    if (r.ok) setRoom(r.data.room);
    return r;
  }

  // 实时上报自己的分数与进度。对局中高频调用, 只发两个数字。
  async function reportProgress(score, progress) {
    const code = roomCode();
    if (!code) return { ok: false, status: 0, data: null, error: '不在房间中' };
    const r = await request('POST', '/rooms/' + code + '/progress', {
      score: score | 0,
      progress: progress | 0
    });
    if (r.ok) setRoom(r.data.room);
    return r;
  }

  // 拉房间快照。带 since 命中时服务端只回 {unchanged:true}, 可直接跳过重绘。
  async function fetchRoomState() {
    const code = roomCode();
    if (!code) return null;
    const r = await request('GET', '/rooms/' + code + '/state?since=' + account.roomVersion);
    if (!r.ok) return null;
    const room = r.data.room;
    if (room && room.unchanged) return room;
    if (room) setRoom(room);
    return room;
  }

  // ---- 轮询 ----
  // 按需求采用 HTTP 轮询而非 WebSocket。
  // intervalMs 是「看到对手分数」的延迟上限, 默认 1000ms。
  function startRoomPolling(intervalMs) {
    const period = Number(intervalMs) > 0 ? Number(intervalMs) : 1000;
    stopRoomPolling();
    account._pollTimer = setInterval(async () => {
      if (!account.room) return;
      const room = await fetchRoomState();
      if (room && !room.unchanged && typeof account.onRoomUpdate === 'function') {
        try {
          account.onRoomUpdate(room);
        } catch (e) {
          log('房间回调异常: ' + ((e && e.message) || e));
        }
      }
    }, period);
  }

  function stopRoomPolling() {
    if (account._pollTimer) {
      clearInterval(account._pollTimer);
      account._pollTimer = null;
    }
  }

  // 对局中按固定间隔上报自己的分数(与读取轮询同频)。
  // getScore 由游戏侧提供, 返回 { score, progress }。
  function startProgressReport(getScore, intervalMs) {
    const period = Number(intervalMs) > 0 ? Number(intervalMs) : 1000;
    stopProgressReport();
    account._progressTimer = setInterval(() => {
      if (!account.room) return;
      let snapshot = null;
      try {
        snapshot = typeof getScore === 'function' ? getScore() : null;
      } catch (e) {
        return;
      }
      if (!snapshot) return;
      reportProgress(snapshot.score, snapshot.progress);
    }, period);
  }

  function stopProgressReport() {
    if (account._progressTimer) {
      clearInterval(account._progressTimer);
      account._progressTimer = null;
    }
  }

  // 房间里除自己以外的对手(供对手分数条使用)
  function opponents() {
    const room = account.room;
    if (!room || !room.players) return [];
    const me = account.profile && account.profile.id;
    return room.players.filter((p) => p.userId !== me);
  }

  Object.assign(account, {
    getBase,
    setBase,
    request,
    register,
    login,
    logout,
    restoreSession,
    updateProfile,
    applyProfileToHandshake,
    reportPlay,
    fetchLeaderboard,
    createRoom,
    joinRoom,
    leaveRoom,
    setReady,
    selectMusic,
    startMatch,
    reportProgress,
    fetchRoomState,
    startRoomPolling,
    stopRoomPolling,
    startProgressReport,
    stopProgressReport,
    roomCode,
    opponents
  });

  return account;
}
