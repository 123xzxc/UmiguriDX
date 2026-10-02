#!/usr/bin/env node
// game-patches.mjs - 对游戏逻辑做可复现的小补丁(在 modularize 生成前作用于 AST)。
//
// 目前:
//   测试菜单 OutputTest 页的「Back」行只认 左(8)/右(16)/BTN_SERVICE, 不认
//   「確定」(BTN_ENTER)。补一条守卫: 当 au===7(Back) 且按下 BTN_ENTER 时也返回。
import { traverse, t, parser } from './lib/symbols.mjs';

const isThisProp = (node, prop) =>
  node && t.isMemberExpression(node) && !node.computed && t.isThisExpression(node.object) && t.isIdentifier(node.property, { name: prop });

export function applyGamePatches(ast) {
  const applied = [];

  traverse(ast, {
    IfStatement(path) {
      const test = path.node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '===') return;
      // 匹配 this.au === 7  (测试菜单 OutputTest 的 Back 行)
      if (!isThisProp(test.left, 'au') || !t.isNumericLiteral(test.right, { value: 7 })) return;
      const fn = path.getFunctionParent();
      if (!fn || !fn.node.params.length) return;
      const body = fn.node.body;
      if (!t.isBlockStatement(body)) return;
      // 幂等: 函数体开头若已有同类守卫则跳过
      const first = body.body[0];
      if (first && t.isIfStatement(first) && JSON.stringify(first).includes('BTN_ENTER')) return;
      const maskName = fn.node.params[0].name;
      // 注意: 必须放在函数最开头 —— 后面的 dirSign 链在非 左/右/Service 时会提前 return
      const guard = t.ifStatement(
        t.logicalExpression('&&', t.cloneNode(test, true), t.binaryExpression('&', t.identifier(maskName), t.identifier('BTN_ENTER'))),
        t.blockStatement([
          t.expressionStatement(t.callExpression(t.identifier('switchPage'), [t.stringLiteral('Root')])),
          t.returnStatement(),
        ])
      );
      body.body.unshift(guard);
      applied.push('OutputTest: Back 行接受 BTN_ENTER');
    },
  });

  // 去掉游戏里遗留的调试 console.log。
  // 这些日志本身无害, 但代价很大: 宿主会把每次 log 交给转发钩子(逐调用 JSON.stringify),
  // 而 chartParser.rt() 结尾就打印整份解析结果 —— 每解析一首曲子都要序列化一个巨大的
  // 乐谱对象, 曲库一大就明显拖慢加载。
  let removedLogs = 0;
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      if (!t.isIdentifier(callee.object, { name: 'console' })) return;
      if (!t.isIdentifier(callee.property, { name: 'log' })) return;
      // 表达式位置用 void 0 占位, 保持逗号表达式/条件判断的语义
      if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
      else path.replaceWith(t.unaryExpression('void', t.numericLiteral(0)));
      removedLogs++;
    },
  });
  if (removedLogs) applied.push(`去掉遗留调试 console.log ×${removedLogs}`);

  // 乐曲列表缓存命中后补载封面。
  // 游戏自带 /caches/music.json 列表缓存(rm.Im)会跳过逐曲扫描, 但缓存里只有数据、
  // 没有 GL 纹理 —— 不补的话选曲列表所有封面都会退化成 dummy。这里在缓存解析之后、
  // 收尾回调之前插入一段「按缓存条目补载封面」的循环(逻辑与建表循环里的封面加载一致)。
  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property, { name: 'Ic' })) return;
      const arg0 = path.node.arguments[0];
      if (!t.isStringLiteral(arg0) || arg0.value !== '/caches/music.json') return;
      const cb = path.node.arguments[1];
      if (!cb || !t.isBlockStatement(cb.body)) return;
      if (JSON.stringify(cb.body).includes('__umgJkt')) return; // 幂等
      const snippet = parser.parse(JACKET_PRELOAD, { sourceType: 'script' }).program.body;
      cb.body.body.splice(cb.body.body.length - 1, 0, ...snippet);
      applied.push('列表缓存命中后补载封面');
    },
  });

  traverse(ast, {
    // 列表就绪标记: 乐曲列表交付回调(v_i_32551, 冷/暖两条路都会经过)之后打点,
    // 便于比较「扫描建表」与「读缓存」两条路的启动耗时。
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee, { name: 'v_i_32551' })) return;
      if (path.node.arguments.length !== 3) return;
      const stmt = path.getStatementParent();
      if (!stmt || stmt.node.__umgTimed) return;
      stmt.node.__umgTimed = true;
      const log = parser.parse(
        'console.log("[DIAG] [umg][jkt] 列表就绪 n=" + v_l_32557.length + " " + (v_o_32561 ? "缓存" : "扫描"));'
      ).program.body[0];
      stmt.insertAfter(log);
      applied.push('列表就绪标记');
    },
  });

  // 应用名: 游戏里 v_G_27652 = "UMIGURI" 会用于 document.title 与错误/修复页标题。
  // 允许宿主用 window.__umgAppName 覆盖(默认取 Tauri 的 productName), 便于改名(如 OpenUmiguri)。
  let appNamePatched = 0;
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id, { name: 'v_G_27652' })) return;
      if (!t.isStringLiteral(path.node.init)) return;
      path.node.init = t.logicalExpression(
        '||',
        t.memberExpression(t.identifier('window'), t.identifier('__umgAppName')),
        t.stringLiteral('OpenUmiguri')
      );
      appNamePatched++;
    },
  });
  if (appNamePatched) applied.push(`应用名可由宿主覆盖 ×${appNamePatched}`);

  // 版本号: 登陆页显示 "Version " + v_U_27653。允许宿主用 window.__umgAppVersion 覆盖
  // (取 Tauri 的 app_version = tauri.conf.json 的 version), 避免与 package/安装包版本脱节。
  let appVersionPatched = 0;
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id, { name: 'v_U_27653' })) return;
      if (!t.isStringLiteral(path.node.init)) return;
      path.node.init = t.logicalExpression(
        '||',
        t.memberExpression(t.identifier('window'), t.identifier('__umgAppVersion')),
        path.node.init
      );
      appVersionPatched++;
    },
  });
  if (appVersionPatched) applied.push(`版本号可由宿主覆盖 ×${appVersionPatched}`);

  // 配置文件优先: 游戏读档时会把存档里的玩家信息写回握手
  // (scope.handshake.rm.om/um/lm = 存档的 name/level/rating)。
  // 宿主可用 window.__umgForceProfile 下发"强制值"(只含配置里确实写了的字段),
  // 这里把三处赋值改为「强制值优先, 否则沿用存档值」——于是配置文件始终优先,
  // 同时不会把用户没在配置里指定的字段顶掉。
  let forceProfile = 0;
  const FORCE_PROFILE_KEYS = { om: 'name', um: 'level', lm: 'rating' };
  traverse(ast, {
    AssignmentExpression(path) {
      const left = path.node.left;
      if (!t.isMemberExpression(left) || !t.isIdentifier(left.property)) return;
      const key = FORCE_PROFILE_KEYS[left.property.name];
      if (!key) return;
      // 形状必须是 <握手对象>.rm.<om|um|lm>(补丁阶段握手对象还是短名, 如 v_ye_27858)
      const rm = left.object;
      if (!t.isMemberExpression(rm) || !t.isIdentifier(rm.property, { name: 'rm' })) return;
      const rhs = path.node.right;
      if (JSON.stringify(rhs).includes('__umgForceProfile')) return; // 幂等
      path.node.right = t.logicalExpression(
        '||',
        t.memberExpression(
          t.memberExpression(t.identifier('window'), t.identifier('__umgForceProfile')),
          t.stringLiteral(key),
          true
        ),
        rhs
      );
      forceProfile++;
    },
  });
  if (forceProfile) applied.push(`配置优先: 玩家信息(姓名/等级/rating) ×${forceProfile}`);

  // 设计空间(实验): 让 v_yn_27656/v_Sn_27657 可由宿主提供(默认仍是 1920x1080),
  // 用于验证「游戏 UI 布局是否随设计空间等比缩放」(rsb 坐标是相对还是绝对像素)。
  let designPatched = 0;
  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!t.isIdentifier(id) || !t.isNumericLiteral(path.node.init)) return;
      if (id.name === 'v_yn_27656') {
        path.node.init = t.logicalExpression(
          '||',
          t.memberExpression(t.identifier('window'), t.identifier('__umgDesignW')),
          t.numericLiteral(1920)
        );
        designPatched++;
      } else if (id.name === 'v_Sn_27657') {
        path.node.init = t.logicalExpression(
          '||',
          t.memberExpression(t.identifier('window'), t.identifier('__umgDesignH')),
          t.numericLiteral(1080)
        );
        designPatched++;
      }
    },
  });
  if (designPatched) applied.push(`设计空间可由宿主覆盖 ×${designPatched}`);

  // 游玩状态/控制桥: 游玩会话(v_U_30262)是 gameCore 模块内的局部变量, 宿主读不到。
  // 在 gameCore 工厂 `return { ue, T0, lg, ri }` 之前挂一个 globalThis.__umgPlay:
  //   state  只读状态(主界面/加载/游玩/结算, 是否暂停, 进度/分数等)
  //   pause/resume/retry/settle/exit 对应游戏自身的暂停、继续、(seek 0)重来、立即结算
  // 供宿主暂停菜单(host/keypanel/pausemenu.js)使用。
  traverse(ast, {
    ReturnStatement(path) {
      const arg = path.node.argument;
      if (!t.isObjectExpression(arg)) return;
      const isGameCoreReturn = arg.properties.some(
        (p) =>
          t.isObjectProperty(p) &&
          t.isIdentifier(p.key, { name: 'ri' }) &&
          t.isIdentifier(p.value, { name: 'v_ji_30334' })
      );
      if (!isGameCoreReturn) return;
      if (JSON.stringify(arg).includes('__umgPlay')) return; // 幂等
      path.insertBefore(parser.parse(UMG_PLAY_BRIDGE, { sourceType: 'script' }).program.body);
      applied.push('游玩状态/控制桥 __umgPlay');
    },
  });

  // 原生联机: 宿主(启动器)在加载游戏前下发 window.__umgServer 时, 把游戏自带的
  // 联机客户端指到自建服务端 umiguri-native-server。它实现的正是游戏本来就在说的
  // 那套协议(/1/* JSON + /sock 加密二进制), 所以这里只需要换地址 + 接上「刷卡」。
  //
  // 没有 window.__umgServer 时三个表达式都取原值, 行为与改动前逐字节一致。
  //
  // ⚠ 锚点必须在 applySymbols 的视角下成立: 这些补丁跑在**重命名之前**,
  //   此时局部的 `v_*` 名字虽然已经是语义名(来自 game_main.deobf.js 的 renaming),
  //   但**没有 `scope.` 前缀** —— 它们是 IIFE 内的裸标识符,
  //   例如 `v_Xt_27648 = null`(VariableDeclarator) 而不是 `scope.v_Xt_27648 = null`。
  //   以前的锚点写成 scope.v_* 形式, 于是这几条补丁**从来没有生效过**:
  //   window.__umgServer 从未下发, 游戏里所有联机分支仍是死代码, 玩家只能游客,
  //   成绩也不上传。
  //
  // 锚点(重命名前形态):
  //   1) `v_Bs_28013.IA = …`(静态链末尾)—— 联机账号客户端(云存档/资料/房间令牌)
  //      ⚠ 不能挂在 `v_Xt_27648 = null` 那行上: 原型是整体替换的, 早 new 的实例
  //        没有 .Fy/.Dy(见下面 AssignmentExpression 的注释)。
  //   2) `v_Ls_28008.prototype = {...}`   —— 无 AM 读卡器时的读卡桩(含 R9)
  //   3) `v_oe_27649 = new v_Hs_28017`    —— 房间/心跳客户端(/sock), 端口写死 8101
  let nativePatched = 0;

  // 1) 联机账号客户端: 原本恒为 null(所以游戏里所有联机分支都是死代码)。
  //    宿主直登后门(__umgHostLogin)也挂在同一处, 用 VariableDeclaration 级 visitor:
  //    后门要插在**整条声明语句之后**而不是 VariableDeclarator 之后, 否则片段会变成
  //    裸语句序列。游戏语句 2 是 `var …, v_Xt_27648 = null, …,` 的大声明。
  let hostLoginInserted = 0;
  traverse(ast, {
    // 账号客户端**必须等 v_Bs_28013.prototype 装好之后再 new**: 原型是整体替换的
    // (v_Bs_28013.prototype = { ...Qy/Fy/Dy... }), 早于它创建的实例会挂在旧原型上,
    // 于是 .Fy / .Dy 全是 undefined —— 实测日志:
    //   [umg][native] 宿主直登失败: _0x5a3ae['Fy'] is not a function
    //   REJECTION v_Xt_27648['Dy'] is not a function  (登录画面卡住)
    // 所以锚点选在静态方法链的最后一条 v_Bs_28013.IA = ... 之后插入赋值语句。
    AssignmentExpression(path) {
      const left = path.node.left;
      if (!t.isMemberExpression(left) || left.computed) return;
      if (!t.isIdentifier(left.object, { name: 'v_Bs_28013' })) return;
      if (!t.isIdentifier(left.property, { name: 'IA' })) return;
      // IA 是 `prototype = {...}, By = .., .., IA = ..` 这条逗号序列的最后一项,
      // 所以父节点是 SequenceExpression, 要往上找到整条语句再插到它后面。
      let stmt = path.parentPath;
      while (stmt && !stmt.isStatement()) stmt = stmt.parentPath;
      if (!stmt || !stmt.isExpressionStatement()) return;
      if (JSON.stringify(stmt.node).includes('__umgServer')) return; // 幂等
      stmt.insertAfter(parser.parse(NATIVE_ACCOUNT_ASSIGN, { sourceType: 'script' }).program.body);
      nativePatched++;
    },
    VariableDeclaration(path) {
      if (hostLoginInserted) return; // 只插一次
      const hasTarget = path.node.declarations.some((d) => t.isIdentifier(d.id, { name: 'v_Xt_27648' }));
      if (!hasTarget) return;
      if (JSON.stringify(path.node).includes('__umgHostLogin')) return; // 幂等
      path.insertAfter(parser.parse(HOST_LOGIN_BRIDGE, { sourceType: 'script' }).program.body);
      hostLoginInserted = 1;
      applied.push('宿主直登后门 __umgHostLogin');
    },
    NewExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee, { name: 'v_Hs_28017' })) return;
      if (path.node.arguments.length !== 3) return;
      if (t.isConditionalExpression(path.node.arguments[0]) && JSON.stringify(path.node.arguments[0].test).includes('__umgServer')) return; // 幂等
      // 3) 房间客户端地址(host, port)
      path.node.arguments[0] = parser.parseExpression(NATIVE_SOCK_HOST);
      path.node.arguments[1] = parser.parseExpression(NATIVE_SOCK_PORT);
      nativePatched++;
    },
  });

  // 2) 刷卡桩(没接 AM 读卡器时游戏会退到 v_Ls_28008): 宿主把卡号转成 10 字节放在
  //    __umgServer.cardBytes, 这里把整个 R9 换掉, 优先返回它一次。
  //    必须「一次用完就清」: 否则服务端连不上时是
  //    「登录失败 -> 回标题(自动读卡) -> 又失败」的死循环, 玩家进不去游客模式。
  //
  //    另外把「等刷卡」时的 resolver 挂到 globalThis.__umgSwipe: 桌面没有 AM 读卡器
  //    也没有键盘假卡的提示, 宿主据此在右下角显示一个「刷卡」虚拟按钮 —— 玩家点一下
  //    就等于刷了一次卡(登录失败/换号后能重试, 不会永远卡在「请刷卡」)。
  traverse(ast, {
    AssignmentExpression(path) {
      const left = path.node.left;
      if (!t.isMemberExpression(left) || left.computed) return;
      // left = v_Ls_28008.prototype (重命名前: 裸标识符, 不带 scope.)
      if (!t.isIdentifier(left.object, { name: 'v_Ls_28008' })) return;
      if (!t.isIdentifier(left.property, { name: 'prototype' })) return;
      if (!t.isObjectExpression(path.node.right)) return;
      const r9 = path.node.right.properties.find(
        (pr) => t.isObjectProperty(pr) && t.isIdentifier(pr.key, { name: 'R9' }) && t.isBlockStatement(pr.value.body)
      );
      if (!r9) return;
      const first = r9.value.body.body[0];
      if (t.isIfStatement(first) && JSON.stringify(first.test).includes('__umgServer')) return; // 幂等
      r9.value.body.body = parser.parse(NATIVE_SWIPE_BODY, { sourceType: 'script', allowReturnOutsideFunction: true }).program.body;
      nativePatched++;
    },
  });
  // 4) 联机 HTTP 客户端 Qy: 宿主桥优先(见 src/host/bridge/umgr-elc.js online.requestUrl)。
  //    客户端原来是 WebView 直连 fetch http://内网IP:端口 —— macOS(WKWebView) 会按
  //    ATS/混合内容拦掉, 表现是「宿主登录正常, 游戏端却登录不上、成绩不上传」;
  //    Windows(WebView2)不拦, 所以只有 macOS 出问题。宿主桥由 Rust 发起, 不受限制。
  //    锚点: v_Bs_28013.prototype.Qy 的函数体(里面有 "UmgrNetworkClient" 埋点)。
  traverse(ast, {
    ObjectProperty(path) {
      if (path.node.computed || !t.isIdentifier(path.node.key, { name: 'Qy' })) return;
      const fn = path.node.value;
      if (!t.isFunctionExpression(fn) || fn.params.length !== 3) return;
      const bodyText = JSON.stringify(fn.body);
      if (!bodyText.includes('UmgrNetworkClient')) return;
      if (bodyText.includes('[umg][native]')) return; // 幂等
      const names = fn.params.map((x) => x.name);
      // 原函数体整体内联进 async IIFE: 补丁段与原来的 await fetch 都在异步上下文里,
      // 桥拿到数据就 return(短路), 拿不到就自然落到原逻辑(fetch 直连)。
      // 注意 parser 默认不认顶层 await(会解析成标识符 await(...)), 所以模板里
      // async 箭头函数本身不带 await, 由外层 t.awaitExpression 包住。
      const origBody = fn.body.body;
      const stmt = parser.parse(
        NATIVE_HTTP_BODY(names[0], names[1], names[2]),
        { sourceType: 'script', allowReturnOutsideFunction: true }
      ).program.body[0];
      // 解析结果 = (async () => { ... })();  —— 展开成:
      //   var v_umgBridge = await (async () => { ...桥优先, 拿不到则原逻辑... })();
      //   if (v_umgBridge) return v_umgBridge;
      const call = stmt.expression;
      const iife = call.callee;
      if (!iife || !iife.body) throw new Error('NATIVE_HTTP_BODY 结构异常');
      iife.body.body.push(...origBody);
      fn.body = t.blockStatement([
        t.variableDeclaration('var', [t.variableDeclarator(t.identifier('v_umgBridge'), t.awaitExpression(stmt.expression))]),
        t.ifStatement(
          t.identifier('v_umgBridge'),
          t.blockStatement([t.returnStatement(t.identifier('v_umgBridge'))])
        ),
      ]);
      nativePatched++;
    },
  });

  if (nativePatched) applied.push(`原生联机指向 __umgServer ×${nativePatched}`);

  return applied;
}

// 1) 联机账号客户端(HTTP: /1/user/login, /1/umiguri/*)
// 1) 联机账号客户端(HTTP: /1/user/login, /1/umiguri/*)。
// 只在这里赋值(v_Xt_27648 原来是 null, 游戏自己从不赋值); 位置必须晚于
// v_Bs_28013.prototype 的整体替换, 见上面 AssignmentExpression 锚点的注释。
const NATIVE_ACCOUNT_ASSIGN = 'v_Xt_27648 = window.__umgServer && window.__umgServer.host ? new v_Bs_28013(window.__umgServer.host, window.__umgServer.port || 8101, window.__umgServer.nwToken || "") : null;';

// 宿主直登: 把「刷卡登录」这件事从游戏的读卡窗口里搬出来。
//
// 为什么必须搬: 游戏进「GuestLogin」按钮后走 v_k_28809, 那里是个只认读卡器的循环
// (await v_D_27646.R9()), 桌面没有 AM 读卡器时通道极窄 —— 实测日志里 R9 从头到尾
// 没被调用过, 玩家点宿主悬浮球上的「刷卡」也没用, 最后只能游客进去(游客态会跳过
// 成绩上报, 服务端一条成绩都收不到)。
//
// 这里给游戏账号客户端装一个 omgLogin(cardId): 宿主在 loadMain() 之前调它, 直接完成
// /1/user/login -> 拉档案 -> 灌进 handshake, 游戏启动握手时就已经是「已登录」状态,
// 走的是 v_Ns_28014.cA() 里 v_Xt_27648 为真的那条分支(不碰游客标志 v_r_33807)。
// 失败不影响启动: 返回 null, 游戏照旧游客。
const HOST_LOGIN_BRIDGE = `
globalThis.__umgHostLogin = async function (v_umgCard) {
  var v_umgAccount = scope.v_Xt_27648;
  if (!v_umgAccount) return { ok: false, error: '未接原生联机' };
  try {
    // 后门挂在 bootstrap 开头, 但 v_Ns_28014 / handshake 是后面几步才建好的。
    // 宿主拿到后门就会立刻调用, 所以这里先等依赖就绪(最多 20s)。
    for (var v_umgT = 0; v_umgT < 200 && (!v_Ns_28014 || !handshake || !handshake.rm); v_umgT++) {
      await new Promise(function (v_umgR) { setTimeout(v_umgR, 100); });
    }
    if (!v_Ns_28014 || !handshake || !handshake.rm) return { ok: false, error: '游戏初始化未完成' };
    // 游客兜底(关键): 宿主已经绑卡时, 不让游戏再进游客态。
    // v_Ns_28014.vA() 是**唯一**把游客标志(v_r_33807)置真的地方, 只在
    // v_p_28808() 无卡登录(登录画面的「GuestLogin」按钮)时调用。桌面没有 AM
    // 读卡器时玩家常常只剩这个按钮可点 —— 一点就是游客, 成绩不上报。
    // 这里换掉 vA: 有绑卡时直接返回成功但不置标志, 于是 dA() 落到
    // v_Xt_27648.Dy() 取真实档案 —— 点 GuestLogin 也进自己的账号。
    if (v_Ns_28014.vA && !v_Ns_28014.__umgGuestGuard) {
      var v_umgOrigVA = v_Ns_28014.vA.bind(v_Ns_28014);
      v_Ns_28014.vA = function () {
        return window.__umgServer && window.__umgServer.card ? v_Ms_28009 : v_umgOrigVA();
      };
      v_Ns_28014.__umgGuestGuard = !0;
    }
    var v_umgRet = await v_umgAccount.Fy(String(v_umgCard || ''));
    // v_Ms_28009 = 0 成功; -10 重复登录; -1 网络/服务端错误
    if (v_umgRet !== v_Ms_28009) return { ok: false, error: 'login ' + v_umgRet };
    await v_umgAccount.Ly();   // getProfile -> 写进 handshake(名字/等级/称号/存档)
    await v_umgAccount.My();   // getRecords -> handshake.Mm
    await v_umgAccount.CA();   // getOptions -> handshake.On.ae
    await v_umgAccount.EA();   // getCourseRecords -> handshake.Em
    await v_umgAccount.MA();   // getCharaStates -> handshake.On.nm
    // 只在**已经处于游客态**时才清标志。注意 fA() 不是「清游客标志」:
    // 非游客时会走 v_Xt_27648.Ry() 把刚登好的账号登出。
    if (v_Ns_28014.wA && v_Ns_28014.wA()) await v_Ns_28014.fA();
    console.log('[umg][native] 宿主直登成功: ' + handshake.rm.om);
    return { ok: true, name: handshake.rm.om };
  } catch (v_umgErr) {
    return { ok: false, error: (v_umgErr && v_umgErr.message) || String(v_umgErr) };
  }
};
`;

// 3) 房间客户端(/sock): 官方地址 d.umgr-serv.inonote.jp:8101
const NATIVE_SOCK_HOST = 'window.__umgServer && window.__umgServer.host ? window.__umgServer.host : "d.umgr-serv.inonote.jp"';
const NATIVE_SOCK_PORT = 'window.__umgServer && window.__umgServer.host ? window.__umgServer.port || 8101 : 8101';

// 2) 刷卡桩的整个函数体: 宿主给了卡号就用掉一次(并清掉); 否则进入「等刷卡」并把
//    resolver 挂到 __umgSwipe(宿主右下角的虚拟刷卡按钮点它), 键盘假卡 Ctrl+F9~F12
//    的路径也不变(Z9 即这个 resolver)
const NATIVE_SWIPE_BODY = `
if (window.__umgServer && window.__umgServer.cardBytes) {
  var v_umgHostCard = window.__umgServer.cardBytes;
  return window.__umgServer.cardBytes = null, this.US = v_Ps_28006, v_umgHostCard;
}
return this.US = v_Ps_28006, new Promise(v_t_33747 => {
  var v_umgSelf = this;
  var v_umgDone = false;
  var v_umgSwipe = function (v_umgBytes) {
    if (v_umgDone) return false;
    v_umgDone = true;
    globalThis.__umgSwipe = null;
    v_umgSelf.Z9 = void 0;
    v_t_33747(v_umgBytes);
    return true;
  };
  this.Z9 = v_umgSwipe;
  globalThis.__umgSwipe = v_umgSwipe;
});
`;


// 4) 联机 HTTP 客户端的宿主桥前置: 交给宿主 Rust 侧发请求(与宿主自己的登录同一条路),
//    不受 WebView 的跨源/ATS 限制。桥不可用时(没有 umgr_elc)保持原样, 走直连 fetch。
// ⚠ 必须包在 async 箭头函数里: 这段代码会被 parser.parse 成「语句序列」再插进 Qy 的
//   函数体, 裸着写 await 会直接 SyntaxError('await' is only allowed within async
//   functions) —— 补丁在生成阶段就炸, 产物里什么都没有。
function NATIVE_HTTP_BODY(method, path, payload) {
  return `
(async () => {
  var v_umgOnline = window.umgr_elc && window.umgr_elc.online;
  if (v_umgOnline && v_umgOnline.requestUrl) {
    try {
      var v_umgResp = await v_umgOnline.requestUrl(${method}, "http://" + this.Yy + ":" + this.P7 + ${path}, ${payload}, null);
      console.log("[umg][native] " + ${method} + " " + ${path} + " -> " + (v_umgResp && v_umgResp.ok ? String(v_umgResp.data && v_umgResp.data.result || "ok") : "失败(" + ((v_umgResp && v_umgResp.error) || "未知") + ")"));
      return v_umgResp && v_umgResp.data ? v_umgResp.data : { result: "bad" };
    } catch (v_umgBridgeErr) {
      console.log("[umg][native] 宿主桥异常, 回退直连: " + ((v_umgBridgeErr && v_umgBridgeErr.message) || v_umgBridgeErr));
    }
  }
})();
`;
}


// gameCore 私有的游玩状态/控制桥(注入在模块 return 之前; 名字在该模块作用域内可见)。
const UMG_PLAY_BRIDGE = `
globalThis.__umgPlay = {
  get state() {
    var s = v_U_30262;
    var tm = !!(scope.testMenu && scope.testMenu.Gi && scope.testMenu.Gi());
    if (!s) return { scene: "menu", playing: false, paused: false, testMenu: tm };
    var inPlay = s.n1 === v_S_30187;
    return {
      scene: inPlay ? "play" : s.n1 >= v_B_30188 ? "result" : "loading",
      playing: inPlay && s.o1 === true,
      paused: inPlay && s.o1 === false,
      testMenu: tm,
      failed: !!s.J1,
      practice: !!(s.Y1 && s.Y1.k0),
      progress: s.rr,
      length: s.q1 ? s.q1.Zu._w : 0,
      speed: s.b1,
      difficulty: s.Y1 ? s.Y1.te : null,
      musicId: s.Y1 ? s.Y1.En : null,
      score: s.Ta ? s.Ta.Sr : 0
    };
  },
  pause: function () {
    if (v_U_30262 && v_U_30262.i1 && v_U_30262.n1 === v_S_30187 && v_U_30262.o1) v_Wi_30337();
  },
  resume: function () {
    if (v_U_30262 && v_U_30262.i1 && v_U_30262.n1 === v_S_30187 && !v_U_30262.o1) v_Vi_30336();
  },
  retry: function () {
    if (!v_U_30262 || v_U_30262.n1 !== v_S_30187) return;
    v_Yi_30341(0);
  },
  settle: function () {
    if (!v_U_30262 || v_U_30262.n1 !== v_S_30187) return;
    v_Hi_30330();
  },
  exit: function () {
    if (v_U_30262) v_Oi_30335();
  }
};
`;

// 与建表循环里的封面加载等价(dds 走 it+软件/硬件解码, 其它走 Image)
const JACKET_PRELOAD = `
let __umgJktN = 0;
if (v_o_32561) for (const __umgJkt of v_l_32557) {
  if (!__umgJkt || !__umgJkt.res_info || void 0 === __umgJkt.res_info.jacket) continue;
  ++__umgJktN;
  if (void 0 !== scope.renderer.Yt.Zt["jkt:" + __umgJkt.w0]) continue;
  const __umgJktPath = "/music/" + __umgJkt.dir + "/" + __umgJkt.res_info.jacket;
  if (scope.v_Da_28067(__umgJkt.res_info.jacket, ".dds")) {
    scope.v_$r_27975.it(__umgJktPath, function (__umgJktBuf) {
      if (null === __umgJktBuf) return;
      let __umgJktTex = null;
      scope.v_Io_28120(__umgJktBuf, !1, function (__umgJktStatus, __umgJktW, __umgJktH) {
        if (__umgJktStatus === scope.v_xo_28116) {
          __umgJktTex = new glRuntime.Texture(__umgJktW, __umgJktH, {
            wrapS: scope.glContext.CLAMP_TO_EDGE,
            wrapT: scope.glContext.CLAMP_TO_EDGE,
            format: scope.glContext.RGB
          });
          scope.glContext.pixelStorei(scope.glContext.UNPACK_FLIP_Y_WEBGL, !1);
        } else if (__umgJktStatus === scope.v_Ao_28115) {
          __umgJktTex = null;
        }
      });
      if (__umgJktTex) scope.renderer.Yt.Zt["jkt:" + __umgJkt.w0] = __umgJktTex;
    });
  } else {
    scope.v__o_28104(__umgJktPath, function (__umgJktImg) {
      if (__umgJktImg) scope.renderer.Yt.Zt["jkt:" + __umgJkt.w0] = glRuntime.Texture.fromImage(__umgJktImg, v_c_32558);
    });
  }
}
console.log("[DIAG] [umg][jkt] 列表缓存命中, 补载封面 " + __umgJktN);
`;
