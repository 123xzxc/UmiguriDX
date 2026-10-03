// 模块: settingsStore
// 由 tools/modularize-game.mjs 生成: 原游戏 IIFE 内的模块 IIFE。
// 依赖通过 scope 注入(见 runtime/scope.js)。

export function createSettingsStore(scope) {
  function v_s_29154() {
    this.Gi = !1, this.zS = 0, this.ZS = !0, this.qS = null, this.$S = [0, 0, 0];
  }
  let v___29155 = void 0,
    v_a_29156 = [],
    v_o_29157 = [],
    v_umgSelfBubble,
    v_h_29158 = new v_s_29154(),
    v_n_29159;
  function v_l_29160() {
    v_g_29168(scope.v_z1_27915);
  }
  function v_c_29161() {
    scope.sceneManager.VS() ? scope.v_oe_27649.QS(65535) : scope.v_oe_27649.QS(scope.sceneManager.OS());
  }
  async function v_i_29162(v_t_29169) {
    var v_i_29170 = scope.handshake.On.iI[v_t_29169 + scope.v_bi_27819],
      v_e_29171 = scope.v_Wr_27968.oI(v_i_29170);
    v_e_29171 && (await scope.v_oe_27649.cI(v_i_29170, "")) === scope.v_Ms_28009 && (v_n_29159 && (v_n_29159.UA = 0), v_i_29170 = (v_n_29159 = v___29155.NA(107, 1, 320 + 2 * v_t_29169 * 80 + 80, 0)).GA.We[0], scope.v_sl_28151(v_t_29169 = v_o_29157[v_e_29171.lI].Ve(!0), v_e_29171), v_i_29170.tn(), v_i_29170.Ze(v_t_29169), v_i_29170.Be = !0, v___29155.e8(2 + v_e_29171.lI, v_i_29170), scope.v_Ae_27892.dn("chat" + v_e_29171.lI));
  }
  function v_u_29163() {
    scope.menuSystem.wt("next", scope.v_oe_27649.tx && 0 < scope.v_oe_27649.ix.size), scope.menuSystem.wt("cancel", 0 === scope.v_oe_27649.ix.size || !scope.v_oe_27649.tx), scope.menuSystem.wt("changeDisplay", !0), scope.menuSystem.wt("chat0", !0), scope.menuSystem.wt("chat1", !0), scope.menuSystem.wt("chat2", !0), scope.menuSystem.wt("chat3", !0), scope.menuSystem.Cv(!0);
  }
  async function v_f_29164(v_t_29172) {
    switch (v_t_29172) {
      case "next":
        return void (scope.v_oe_27649.tx && (await new Promise(v_t_29173 => scope.v_Te_27911.Ai(scope.v_Ue_28209("copCloseInviteDialog"), scope.v_G0_27772, 0, v_t_29173))) === scope.v_H0_27781 && v_g_29168(scope.v_z1_27915));
      case "cancel":
        return void ((await new Promise(v_t_29174 => scope.v_Te_27911.Ai(scope.v_oe_27649.tx ? scope.v_Ue_28209("copCancelInvite") : scope.v_Ue_28209("copCancelJoin"), scope.v_G0_27772, 0, v_t_29174))) === scope.v_H0_27781 && v_g_29168(scope.v_K1_27916));
      case "changeDisplay":
        v_h_29158.ZS = !v_h_29158.ZS, v_d_29165();
        break;
      case "chat0":
        v_i_29162(0);
        break;
      case "chat1":
        v_i_29162(1);
        break;
      case "chat2":
        v_i_29162(2);
        break;
      case "chat3":
        v_i_29162(3);
    }
    v_u_29163();
  }
  function v_d_29165() {
    v___29155.lt.yk(15).Wt = v_h_29158.ZS ? scope.v_Xa_28081(v_h_29158.zS.toString(), 6, "0") : "AAAAAA";
  }
  function v_v_29166(v_t_29175) {
    let v_u_29176 = [34, 57, 80],
      v_f_29177 = [!1, !1, !1];
    for (let v_t_29179 = 0; v_t_29179 < 3; ++v_t_29179) v___29155.lt.yk(v_u_29176[v_t_29179]).Be = !1;
    if (!v_t_29175) {
      let v_c_29180 = 0;
      for (scope.v_oe_27649.ix.forEach((v_t_29181, v_i_29182) => {
        var v_e_29183, v_n_29184, v_r_29185, v_s_29186, v_a_29187, v_o_29188, v_l_29189;
        v_t_29181.nx === scope.v_oe_27649.sx() || 3 <= v_c_29180 || (v_a_29187 = v___29155.lt.yk(v_u_29176[v_c_29180]), v_e_29183 = v_a_29187.ot("playerInfo"), v_a_29187.Be = !0, v_f_29177[v_c_29180] = v_h_29158.$S[v_c_29180] !== v_t_29181.nx, v_h_29158.$S[v_c_29180] = v_t_29181.nx, v_a_29187 = v_t_29181, (v_l_29189 = v_e_29183).ot("guestTitleText").Wt = v_a_29187.ox, v_l_29189.ot("guestTitlePlate").Je = "title" + scope.v_ot_27785[v_a_29187.lx], v_l_29189.ot("guestPlayerName").Wt = v_a_29187.om, v_l_29189.ot("guestChara").zt = !0, v_l_29189.ot("guestChara").Xt = v_a_29187.ux, v_a_29187 = v_a_29187.lm, v_n_29184 = "" + scope.mathFloor(v_a_29187 / 100), v_r_29185 = scope.v_Xa_28081("" + v_a_29187 % 100, 2, "0"), v_s_29186 = scope.ratingColorName(v_a_29187), v_a_29187 = scope.ratingColorRgba(v_a_29187), v_o_29188 = v_l_29189.ot("guestRatingText"), v_l_29189 = v_l_29189.ot("guestRatingLabel"), v_o_29188.Wt = v_n_29184 + "P" + v_r_29185, v_o_29188.Ak = "rating" + v_s_29186, v_o_29188.Qe(v_a_29187[0], v_a_29187[1], v_a_29187[2], v_a_29187[3]), v_l_29189.Je = "numRating" + v_s_29186 + "Rating", v_l_29189.Qe(v_a_29187[0], v_a_29187[1], v_a_29187[2], v_a_29187[3]), v_e_29183.ot("guestConnecting").Be = !scope.v_oe_27649.uI(v_t_29181.nx), ++v_c_29180);
      }); v_c_29180 < 3; ++v_c_29180) v_h_29158.$S[v_c_29180] = 0;
      for (let v_t_29190 = 0; v_t_29190 < 3; ++v_t_29190) {
        var v_i_29178;
        v_f_29177[v_t_29190] && (v_i_29178 = v___29155.lt.yk(v_u_29176[v_t_29190]), v___29155.e8(11, v_i_29178));
      }
    }
  }
  function v_w_29167(v_t_29191, v_i_29192) {
    var v_e_29193, v_n_29194, v_r_29195, v_s_29196;
    v_t_29191 === scope.v_js_28019 ? (v_v_29166(), v_u_29163(), 4 <= scope.v_oe_27649.ix.size && v_g_29168(scope.v_z1_27915)) : v_t_29191 === scope.v_sa_28036 ? (v_v_29166(), v_u_29163()) : v_t_29191 === scope.v_aa_28037 ? v_v_29166() : v_t_29191 === scope.v_ia_28032 ? function () {
        // 144 = 对局内快捷聊天。$S 里只装了「对手」的玩家槽(填的时候刻意跳过自己, 见 v_v_29166),
        // 所以自己发的话 findIndex 永远落空 -> 自己看不到自己发的聊天(别人能看到)。
        // 服务端已经改成连同发送者一起推(见 umiguri-native-server/src/sock.js 的 broadcastChat),
        // 这里补上「发送者是自己」这一支: 借一个专用气泡回显, 不动 $S 的槽位含义
        // (那三个槽是 playerContainer0/1/2 的索引, 把自己塞进去会在 4 人房挤掉一个对手)。
        if (v_i_29192.nx === scope.v_oe_27649.sx()) {
          var v_umgSelf = scope.v_Wr_27968.oI(v_i_29192.fI);
          if (!v_umgSelf || !v_o_29157[v_umgSelf.lI] || !v_umgSelfBubble) return;
          var v_umgSelfText = v_o_29157[v_umgSelf.lI].Ve(!0);
          scope.v_sl_28151(v_umgSelfText, v_umgSelf);
          v_umgSelfBubble.tn(), v_umgSelfBubble.Ze(v_umgSelfText), v_umgSelfBubble.Be = !0;
          v___29155.e8(2 + v_umgSelf.lI, v_umgSelfBubble);
          scope.v_Ae_27892.dn("chat" + v_umgSelf.lI);
          return;
        }
        0 <= (v_e_29193 = v_h_29158.$S.findIndex(v_t_29197 => v_t_29197 === v_i_29192.nx)) && (v_n_29194 = scope.v_Wr_27968.oI(v_i_29192.fI)) && v_o_29157[v_n_29194.lI] && (v_r_29195 = v_a_29156[v_e_29193], scope.v_sl_28151(v_s_29196 = v_o_29157[v_n_29194.lI].Ve(!0), v_n_29194), v_r_29195.tn(), v_r_29195.Ze(v_s_29196), v_r_29195.Be = !0, v___29155.e8(2 + v_n_29194.lI, v_a_29156[v_e_29193]), scope.v_Ae_27892.dn("chat" + v_n_29194.lI));
      }() : v_t_29191 !== scope.v_$s_28029 || scope.v_oe_27649.tx || (65535 === scope.v_oe_27649._x ? v_g_29168(scope.v_z1_27915) : scope.sceneManager.JS(scope.v_oe_27649._x));
  }
  async function v_g_29168(v_t_29198) {
    let v_i_29199 = v_t_29198;
    // 大堂收尾入口。日志记下「谁在收尾(%s: 0=加入路径 1=取消路径), 是不是房主, 房里几人」
    // —— 进不了选歌时先看这一行, 能立刻区分「没走到这」还是「走进了别的分支」。
    console.log("[umg][coop] g29168 收尾 kind=" + v_t_29198 + " 房主tx=" + scope.v_oe_27649.tx + " ix.size=" + scope.v_oe_27649.ix.size + " 自己=" + scope.v_oe_27649.sx() + " Gi=" + scope.v_oe_27649.Gi());
    if (scope.v_oe_27649.hx(v_w_29167), scope.sceneManager.ni(), scope.sceneManager.ii(), scope.menuSystem.It(!1), scope.v_Te_27911.Li(), scope.audioFontHub.XS(), v_i_29199 === scope.v_z1_27915) if (scope.v_oe_27649.ix.size) {
      for (scope.v_oe_27649.Gi() && (await scope.v_oe_27649.QS(65535), scope.v_oe_27649.ix.size >= (scope.v_oe_27649.tx ? 3 : 4) ? (console.log("[umg][coop] g29168 走「人数已满」弹窗: ix.size=" + scope.v_oe_27649.ix.size + " tx=" + scope.v_oe_27649.tx), await new Promise(v_t_29200 => scope.v_Te_27911.Ai(scope.v_Ue_28209("copClosedInviteByMemberLimit"), scope.v_ei_27773, 2e3, v_t_29200))) : scope.v_oe_27649.tx || (console.log("[umg][coop] g29168 走「房主已关闭邀请」弹窗: 本地不是房主 tx=false"), await new Promise(v_t_29201 => scope.v_Te_27911.Ai(scope.v_Ue_28209("copClosedInviteByHost"), scope.v_ei_27773, 2e3, v_t_29201)))), scope.v_V1_27912.T0(500);;) {
        let v_e_29202 = !1;
        if (scope.v_oe_27649.ix.forEach((v_t_29203, v_i_29204) => {
          // 这一圈在等「房内所有非自己的成员都已连上(uI)」。等不到就 30ms 一次空转,
          // 外面看就是「点了开始/跳过之后一直不选歌」。把每个人卡在哪一条打出来:
          // 自己 / 已连上 / 还差连接, 一眼看出是哪个成员拖住。
          if (v_t_29203.nx !== scope.v_oe_27649.sx() && !scope.v_oe_27649.uI(v_t_29203.nx)) {
            v_e_29202 = !0;
            console.log("[umg][coop] g29168 等待成员 nx=" + v_t_29203.nx + " 连接就绪 (自己=" + scope.v_oe_27649.sx() + ", ix.size=" + scope.v_oe_27649.ix.size + ")");
          }
        }), !v_e_29202) break;
        await scope.renderer.C7(scope.v_Ge_28204(30));
      }
      scope.v_V1_27912.XS(), await scope.renderer.C7(scope.v_Ge_28204(30)), scope.v_V1_27912.T0(500), await scope.v_oe_27649.tP(scope.v_pa_28050), await scope.v_oe_27649.iP(scope.v_pa_28050), scope.v_V1_27912.XS();
    } else v_i_29199 = scope.v_K1_27916, console.log("[umg][coop] g29168 走「房里没人」分支: ix.size=0 -> 退回菜单"), await new Promise(v_t_29205 => scope.v_Te_27911.Ai(scope.v_Ue_28209("copClosedModeByNoGuests"), scope.v_ei_27773 | scope.v_ri_27776, 2e3, v_t_29205));
    scope.v_Ae_27892.DI("coop_lobby_bgm", 50), v___29155.e8(10), v_n_29159 && (v_n_29159.UA = 0), scope.renderer.W6(() => {
      scope.menuSystem._t();
      for (const v_t_29206 of v_a_29156) v_t_29206.Be = !1;
      v___29155.i8(10), scope.renderer._i("coopLobby"), v_h_29158.Gi = !1, console.log("[umg][coop] g29168 收尾完成, 回调 qS(" + v_i_29199 + ")"), v_h_29158.qS && v_h_29158.qS(v_i_29199), v_h_29158.qS = void 0;
    }, 250);
  }
  return {
    ue: function (v_e_29207) {
      scope.v_Le_28076([v_i_29208 => {
        scope.languagePackages.it("ui/coopLobby.rsb", function (v_t_29209) {
          v_t_29209 ? (v_t_29209 = new scope.v_Dl_28181(v_t_29209), scope.renderer.nt(v_t_29209.rt(scope.renderer.p5()), v_t_29210 => {
            v___29155 = v_t_29210, v_a_29156 = [v___29155.lt.yk(103), v___29155.lt.yk(104), v___29155.lt.yk(105)], v_o_29157 = [v___29155.lt.yk(109), v___29155.lt.yk(113), v___29155.lt.yk(117), v___29155.lt.yk(121), v___29155.lt.yk(126), v___29155.lt.yk(130), v___29155.lt.yk(134), v___29155.lt.yk(138)], v_umgSelfBubble = v___29155.lt.yk(142), scope.v_Me_28078(v_i_29208);
          })) : v_e_29207();
        });
      }, v_t_29211 => {
        scope.v_Fe_28101(v_e_29207);
      }]);
    },
    T0: async function (v_t_29212, v_i_29213) {
      var v_e_29214 = await scope.v_oe_27649.QS(100);
      if (65535 === v_e_29214) scope.v_V1_27912.T0(500), await scope.v_oe_27649.tP(scope.v_pa_28050), await scope.v_oe_27649.iP(scope.v_pa_28050), scope.v_V1_27912.XS(), v_i_29213 && v_i_29213(scope.v_z1_27915);else {
        scope.sceneManager.ni(), scope.sceneManager.ii(), scope.sceneManager.ei(), (v_h_29158 = new v_s_29154()).Gi = !0, v_h_29158.zS = v_t_29212, v_h_29158.qS = v_i_29213, v_h_29158.ZS = !1;
        for (const v_n_29215 of v_a_29156) v_n_29215.Be = !1;
        v___29155.Jt = !1, await new Promise(v_t_29216 => scope.renderer.ut("coopLobby", v___29155, 60, v_t_29216)), scope.v_oe_27649.vx(v_w_29167), v_d_29165(), v_v_29166(!0), scope.menuSystem.ft();
        for (const v_r_29217 of [["changeDisplay", "ChangeDisplay", 12, 2, scope.v_X0_27795, !1, ""], ["next", "Skip", 14, 2, scope.v_W0_27791, !1, ""], ["cancel", "Cancel", 14, 2, scope.v_si_27792, !1, ""]]) scope.menuSystem.vt(v_r_29217[0], v_r_29217[1], v_r_29217[2], v_r_29217[3], v_r_29217[4], v_r_29217[5], !1, !1, v_r_29217[6], function (v_t_29218, v_i_29219) {
          "down" === v_t_29218 && v_f_29164(this.Ae);
        });
        for (let v_t_29220 = 0; v_t_29220 < 4; ++v_t_29220) scope.menuSystem.aI("chat" + v_t_29220, scope.handshake.On.iI[v_t_29220 + scope.v_bi_27819], 2 * v_t_29220, !1, !1, function (v_t_29221, v_i_29222) {
          "down" === v_t_29221 && v_f_29164(this.Ae);
        });
        scope.menuSystem.yv(), scope.menuSystem.Ct(!0), v___29155.Jt = !0, v___29155.e8(0), scope.sceneManager.ft(new scope.v_M1_27898(v_l_29160, v_c_29161)), scope.sceneManager.ri(null === v_e_29214 ? 100 : v_e_29214), scope.sceneManager.ti(), await scope.renderer.C7(scope.v_Ge_28204(30)), scope.menuSystem.Ct(!1), scope.v_Ae_27892.EI("coop_lobby_bgm", 50, .75), scope.audioFontHub.T0(), v_v_29166(), v_u_29163();
        // ⚠ 非房主(拿着房号加入的人)进大堂后**必须**挂一个「房主已点 Skip」的等待, 否则永远出不去:
        //   非房主那两条既有的收尾入口在大堂场景下都够不着 ——
        //     * 140 分支要求 `65535 === _x`(房间已关闭), 正常 2 人房永远不成立;
        //     * 130 分支要求 `4 <= ix.size`(满员匹配), 2 人房也够不着。
        //   房主点 Skip 时发出的唯一信号是 op=22(见 g29168 的 tP(1)), 服务端收到后
        //   会回 141 并给非房主补一帧 **137 状态 1**(见 umiguri-native-server/src/sock.js
        //   的 OP_READY)。客户端 Tx(n) 等的正是 137(sP), 所以这里挂 Tx(1): 一被唤醒
        //   就跟着房主收尾进选歌。
        //   (Tx 只等待、不上报, 不会出现「一进大堂就自己把自己放行」。)
        if (!scope.v_oe_27649.tx) scope.v_oe_27649.Tx(scope.v_ha_28044).then(function (v_umgSkip) {
          if (v_umgSkip && v_h_29158.Gi) {
            console.log("[umg][coop] 非房主收到房主收尾信号(137 状态 1) -> 跟着进选歌");
            v_g_29168(scope.v_z1_27915);
          }
        });
      }
    },
    Gi: () => v_h_29158.Gi
  };
}
