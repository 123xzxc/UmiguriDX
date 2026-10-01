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
    if (v_g_35080b++ < 24) umgLog("读不到: " + JSON.stringify(v_t_35092) + " archive=" + (v_l_35081 ? 1 : 0));
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
      for (const v_s_35098 of v_c_35084) if (v_s_35098.E4(v_n_35096)) return (v_e_35095 = await v_s_35098.pi(v_n_35096)) ? void v_t_35094(v_e_35095.buffer) : void v_t_35094(null);
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
        var v_i_35105;
        if ("ja-JP" !== v_a_35086(scope.currentLang) && (v_i_35105 = v_a_35086(scope.currentLang), v_u_35085.unshift(new v_n_35079(v_i_35105, "reverie_" + v_i_35105, v_s_35083[v_i_35105]))), v_l_35081 = await new Promise(v_t_35106 => {
          scope.hostBridge.qu("/reverie/_VERSION", () => v_t_35106(!1), () => v_t_35106(!0));
        })) for (const v_e_35107 of v_u_35085) {
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
