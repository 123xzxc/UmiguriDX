// 模块: languagePackages
// 由 tools/modularize-game.mjs 生成: 原游戏 IIFE 内的模块 IIFE。
// 依赖通过 scope 注入(见 runtime/scope.js)。

export function createLanguagePackages(scope) {
  function v_n_35079(v_t_35089, v_i_35090, v_e_35091) {
    this.ct = v_t_35089, this.uk = v_i_35090, this.fk = v_e_35091;
  }
  let v_o_35080 = !1,
    v_l_35081 = !1,
    v_r_35082 = scope.v_B_27650,
    v_s_35083 = {
      "en-US": "/una/sakuragi.una",
      "zh-CN": "/una/zh-CN.una"
    },
    v_c_35084 = [],
    v_u_35085 = [new v_n_35079("ja-JP", "reverie", "/una/hiiragi.una"), new v_n_35079("exField", "reverie_exField", "/una/natsukawa.una")];
  function v_a_35086(v_t_35092) {
    return v_s_35083[v_t_35092] ? v_t_35092 : "ja-JP";
  }
  // 埋点: 「读不到资源」在旧代码里只表现为一条没有任何上下文的 Out of bounds access,
  // 无法判断是哪个文件、走的是归档分支还是松散文件分支。限量打印(启动期会大量探测缺失
  // 资源, 不限量会刷屏)。
  let v_g_35080b = 0;
  function umgLog(v_t_35092) {
    try {
      console.log("[umg][lp] " + v_t_35092);
    } catch (v_i_35093) {}
  }
  function umgMiss(v_t_35092) {
    // 限量打印: 启动期会大量探测确实缺失的可选资源(如三个包都没有的 txDummyChara_*.dds),
    // 不限量会刷屏。24 条在「同时缺字体/字符串表」时会早早用光, 反而看不到真正关键的
    // 那几条 —— 提到 200 并单独放行字体/字符串表/启动 UI 这几类。
    var v_imp_35092 = /^(fonts|tables)\/|^ui\//.test(String(v_t_35092));
    if (v_imp_35092 || v_g_35080b++ < 200) {
      umgLog("读不到: " + JSON.stringify(v_t_35092) + " archive=" + (v_l_35081 ? 1 : 0) + (v_imp_35092 ? " [关键]" : ""));
    }
  }
  // RSB / 归档表里的资源名分隔符是反斜杠(textures\txLogoMono.dds): 两条读取分支都必须
  // 归一化成 '/' —— 否则宿主预取缓存(bundle/目录预取都用 '/')全部判为未命中, 而在
  // macOS(WKWebView)上这种 URL 还会直接 fetch 失败 -> 读不到 -> 启动黑屏。
  function umgSlash(v_t_35092) {
    return v_t_35092.split("\\").join("/");
  }
  async function v_e_35087(v_i_35093, v_t_35094) {
    if (v_o_35080) if (v_l_35081) {
      var v_e_35095,
        v_n_35096 = umgSlash(v_i_35093);
      for (const v_s_35098 of v_c_35084) if (v_s_35098.E4(v_n_35096)) {
        v_e_35095 = await v_s_35098.pi(v_n_35096);
        // 归档里有这个条目, 但取出来是空的: 说明问题在归档条目本身(解密/gzip/长度),
        // 而不是「资源不存在」。这种情况不会走 umgMiss, 以前完全看不出来。
        if (!v_e_35095 || !v_e_35095.byteLength) {
          if (v_g_35080b++ < 24) umgLog("归档条目为空: " + JSON.stringify(v_i_35093));
          return void v_t_35094(null);
        }
        return void v_t_35094(v_e_35095.buffer);
      }
    } else {
      var v_n_35096 = umgSlash(v_i_35093);
      for (const v_a_35099 of v_u_35085) {
        var v_r_35097 = await new Promise(v_t_35100 => scope.v_$r_27975.it("/" + v_a_35099.uk + "/" + v_n_35096, v_t_35100));
        if (null !== v_r_35097) return void v_t_35094(v_r_35097);
      }
    }
    umgMiss(v_i_35093);
    v_t_35094(null);
  }
  function v_f_35088(v_t_35101, v_i_35102) {
    v_e_35087(v_t_35101, function (v_t_35103) {
      v_i_35102(null === v_t_35103 ? null : v_r_35082.decode(v_t_35103));
    });
  }
  return {
    ue: async function (v_t_35104) {
      if (!v_o_35080) {
        // 语言包回退链: 先把当前语言包放进队首(unshift), 再统一尝试打开归档。
        if ("ja-JP" !== v_a_35086(scope.currentLang)) {
          var v_i_35105 = v_a_35086(scope.currentLang);
          v_u_35085.unshift(new v_n_35079(v_i_35105, "reverie_" + v_i_35105, v_s_35083[v_i_35105]));
        }
        // 归档可用性判定: 旧代码靠 /reverie/_VERSION 的 HTTP 结果区分「松散文件」与
        // 「.una 归档」—— 可读=松散, 404=归档。这对官方 Web 版成立: 那里的资源就是散
        // 文件, /reverie/_VERSION 天然可读; 打包版把它封进 .una, 该路径 404。
        //
        // 我们的宿主把归档内部条目也映射成了 umg:// 路径, 打包态 /reverie/_VERSION 会
        // 正常返回 200 -> 被误判成「松散模式」-> 资源按 /reverie/<文件> 去读, 而真实内容
        // 在 hiiragi.una 里 -> 字体(Debug.rgf / NtkwGothic*.rgf)与字符串表
        // (stringTable.rvs) 全部读不到 -> 界面能渲染但一个字都没有(无文字)。
        //
        // 因此不再依赖那次探测: 直接尝试打开基础包, 能打开就按归档模式读。
        v_l_35081 = await new Promise(v_t_35106 => {
          let v_i_35108b = new scope.v_ds_27991("/una/hiiragi.una", 0, 2);
          v_i_35108b.xl(v_s_35107b => v_t_35106(!!v_s_35107b));
        });
        if (v_l_35081) for (const v_e_35107 of v_u_35085) {
          let v_i_35108 = new scope.v_ds_27991(v_e_35107.fk, 0, 2);
          if (!(await new Promise(v_t_35109 => v_i_35108.xl(v_t_35109)))) {
            // 归档打不开时旧代码直接 return, 但没置 v_o_35080 —— 之后每次读资源都会
            // 跳过「已初始化」判断直接返回 null(连 404 日志都没有) -> 启动黑屏。
            // 这里退回松散文件读取(语言包目录 / 解包态仍然可读)并保证标志置位。
            umgLog("归档打开失败, 退回松散文件读取: " + JSON.stringify(v_e_35107.fk));
            v_l_35081 = !1, v_c_35084 = [];
            break;
          }
          v_c_35084.push(v_i_35108);
        }
        v_o_35080 = !0;
        umgLog("languagePackages 就绪: archive=" + (v_l_35081 ? 1 : 0) + " packs=" + v_c_35084.length + " lang=" + JSON.stringify(scope.currentLang));
      }
      v_t_35104();
    },
    it: v_e_35087,
    ck: function (v_i_35110) {
      return new Promise(v_t_35111 => v_e_35087(v_i_35110, v_t_35111));
    },
    Ic: v_f_35088,
    f7: function (v_i_35112) {
      return new Promise(v_t_35113 => v_f_35088(v_i_35112, v_t_35113));
    },
    Sb: async function (v_t_35114) {
      if (v_l_35081) {
        if (null === scope.handshake.rm.gb) v_t_35114(!1);else if (v_o_35080) {
          for (let v_i_35117 = 0; v_i_35117 < v_c_35084.length; ++v_i_35117) {
            var v_e_35115 = scope.handshake.rm.gb.find(v_t_35118 => v_t_35118.name === v_u_35085[v_i_35117].ct);
            if (!v_e_35115) return void v_t_35114(!1);
            if (!v_c_35084[v_i_35117].E4("_VERSION")) return void v_t_35114(!1);
            var v_n_35116 = await v_c_35084[v_i_35117].pi("_VERSION");
            if (!v_n_35116) return void v_t_35114(!1);
            v_n_35116 = scope.v_Pe_28064(v_r_35082.decode(v_n_35116.buffer));
            if (null === v_n_35116 || Number.isNaN(v_n_35116)) return void v_t_35114(!1);
            if (v_n_35116 < v_e_35115.version) return void v_t_35114(!1);
          }
          v_t_35114(!0);
        } else v_t_35114(!1);
      } else v_t_35114(!0);
    }
  };
}
