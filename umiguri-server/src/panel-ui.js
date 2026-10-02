// 网页面板界面。单文件 HTML, 内联 CSS/JS, 零依赖 —— 服务端不引构建链,
// 打开 /panel 就是一个能用的页面。
//
// 登录后能做的事: 看自己的卡号(发卡/吊销)、改游戏内显示名与称号、看游玩记录。
// 页面本身不做鉴权, 所有权限判断都在服务端(见 routes/index.js 的 /panel/* )。
//
// HTML 以字符串字面量形式内联(见下方 const HTML), 由构建外的脚本生成,
// 避免模板字符串与页面里的 ${} / 反引号互相干扰。

export function renderPanel() {
  return HTML;
}
const HTML =
  "<!doctype html>" +
    "<html lang=\"zh-CN\">" +
    "<head>" +
    "<meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>UMIGURI 玩家面板</title>" +
    "<style>" +
    "  :root { color-scheme: dark; }" +
    "  * { box-sizing: border-box; }" +
    "  body {" +
    "    margin: 0; min-height: 100vh; padding: 24px 16px;" +
    "    background: #0f1115; color: #e8eaed;" +
    "    font: 15px/1.6 system-ui, -apple-system, \"Segoe UI\", \"Noto Sans SC\", sans-serif;" +
    "  }" +
    "  .wrap { max-width: 760px; margin: 0 auto; }" +
    "  h1 { font-size: 22px; margin: 0 0 4px; }" +
    "  .sub { color: #9aa0a6; font-size: 13px; margin-bottom: 22px; }" +
    "  .card {" +
    "    background: #171a21; border: 1px solid #262a33; border-radius: 12px;" +
    "    padding: 18px 20px; margin-bottom: 16px;" +
    "  }" +
    "  .card h2 { font-size: 15px; margin: 0 0 12px; color: #9aa0a6; font-weight: 600; }" +
    "  label { display: block; font-size: 13px; color: #9aa0a6; margin: 10px 0 4px; }" +
    "  input {" +
    "    width: 100%; padding: 9px 11px; border-radius: 8px;" +
    "    background: #0f1115; color: #e8eaed; border: 1px solid #2d323c; font-size: 15px;" +
    "  }" +
    "  input:focus { outline: none; border-color: #5b8def; }" +
    "  button {" +
    "    margin-top: 14px; padding: 9px 18px; border-radius: 8px; cursor: pointer;" +
    "    background: #2b6cf6; color: #fff; border: 0; font-size: 15px; font-weight: 600;" +
    "  }" +
    "  button:hover { background: #3f7cf7; }" +
    "  button.ghost { background: #232833; color: #c9cdd4; }" +
    "  button.ghost:hover { background: #2c323f; }" +
    "  button:disabled { opacity: .5; cursor: default; }" +
    "  .row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }" +
    "  .row > div { flex: 1 1 180px; }" +
    "  .msg { min-height: 22px; font-size: 13px; margin-top: 10px; }" +
    "  .err { color: #ff8a80; }" +
    "  .ok { color: #7ee787; }" +
    "  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 10px; }" +
    "  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #232833; }" +
    "  th { color: #9aa0a6; font-weight: 600; font-size: 13px; }" +
    "  code { background: #0f1115; padding: 2px 6px; border-radius: 4px; font-size: 13px; }" +
    "  .hidden { display: none; }" +
    "</style>" +
    "</head>" +
    "<body>" +
    "<div class=\"wrap\">" +
    "  <h1>UMIGURI 玩家面板</h1>" +
    "  <div class=\"sub\">用账号 + Google 验证器登录。游戏端使用卡号登录。</div>" +
    "" +
    "  <div class=\"card\" id=\"loginCard\">" +
    "    <h2>登录</h2>" +
    "    <label for=\"u\">用户名</label>" +
    "    <input id=\"u\" autocomplete=\"username\" placeholder=\"你的用户名\">" +
    "    <label for=\"c\">验证器 6 位验证码</label>" +
    "    <input id=\"c\" inputmode=\"numeric\" autocomplete=\"one-time-code\" maxlength=\"6\" placeholder=\"000000\">" +
    "    <button id=\"loginBtn\">登录</button>" +
    "    <div class=\"msg\" id=\"loginMsg\"></div>" +
    "  </div>" +
    "" +
    "  <div id=\"app\" class=\"hidden\">" +
    "    <div class=\"card\">" +
    "      <h2>账号</h2>" +
    "      <div id=\"who\"></div>" +
    "      <button class=\"ghost\" id=\"logoutBtn\">退出登录</button>" +
    "    </div>" +
    "" +
    "    <div class=\"card\">" +
    "      <h2>游戏内资料</h2>" +
    "      <label for=\"dn\">显示名(最多 8 字符)</label>" +
    "      <input id=\"dn\" maxlength=\"8\">" +
    "      <div class=\"row\">" +
    "        <div>" +
    "          <label for=\"np\">称号牌编号</label>" +
    "          <input id=\"np\" inputmode=\"numeric\" placeholder=\"0\">" +
    "        </div>" +
    "        <div>" +
    "          <label for=\"tt\">称号编号</label>" +
    "          <input id=\"tt\" inputmode=\"numeric\" placeholder=\"0\">" +
    "        </div>" +
    "      </div>" +
    "      <button id=\"saveProfileBtn\">保存资料</button>" +
    "      <div class=\"msg\" id=\"profileMsg\"></div>" +
    "    </div>" +
    "" +
    "    <div class=\"card\">" +
    "      <h2>卡号</h2>" +
    "      <div class=\"sub\">游戏端输入卡号即可登录, 不需要密码。请妥善保管。</div>" +
    "      <button id=\"issueBtn\">生成新卡号</button>" +
    "      <div class=\"msg\" id=\"cardMsg\"></div>" +
    "      <table id=\"cardTable\">" +
    "        <thead><tr><th>卡号</th><th>备注</th><th>状态</th><th></th></tr></thead>" +
    "        <tbody></tbody>" +
    "      </table>" +
    "    </div>" +
    "" +
    "    <div class=\"card\">" +
    "      <h2>最近游玩</h2>" +
    "      <table id=\"playTable\">" +
    "        <thead><tr><th>曲目</th><th>难度</th><th>分数</th><th>等级</th></tr></thead>" +
    "        <tbody></tbody>" +
    "      </table>" +
    "    </div>" +
    "  </div>" +
    "</div>" +
    "<script>" +
    "(function () {" +
    "  function $(id) { return document.getElementById(id); }" +
    "" +
    "  function api(method, path, body) {" +
    "    return fetch(path, {" +
    "      method: method," +
    "      credentials: \"same-origin\"," +
    "      headers: body ? { \"content-type\": \"application/json\" } : undefined," +
    "      body: body ? JSON.stringify(body) : undefined" +
    "    }).then(function (r) {" +
    "      return r.json().catch(function () { return {}; }).then(function (data) {" +
    "        if (!r.ok || data.ok === false) throw new Error(data.error || (\"HTTP \" + r.status));" +
    "        return data;" +
    "      });" +
    "    });" +
    "  }" +
    "" +
    "  function setMsg(el, text, isErr) {" +
    "    el.textContent = text || \"\";" +
    "    el.className = \"msg \" + (isErr ? \"err\" : \"ok\");" +
    "  }" +
    "" +
    "  function esc(s) {" +
    "    return String(s == null ? \"\" : s).replace(/[&<>\"]/g, function (ch) {" +
    "      if (ch === \"&\") return \"&amp;\";" +
    "      if (ch === \"<\") return \"&lt;\";" +
    "      if (ch === \">\") return \"&gt;\";" +
    "      return \"&quot;\";" +
    "    });" +
    "  }" +
    "" +
    "  function renderCards(cards) {" +
    "    var tb = $(\"cardTable\").querySelector(\"tbody\");" +
    "    tb.innerHTML = \"\";" +
    "    if (!cards.length) {" +
    "      var empty = document.createElement(\"tr\");" +
    "      empty.innerHTML = \"<td colspan=\"4\" style=\"color:#9aa0a6\">还没有卡号</td>\";" +
    "      tb.appendChild(empty);" +
    "      return;" +
    "    }" +
    "    cards.forEach(function (card) {" +
    "      var tr = document.createElement(\"tr\");" +
    "      var tdId = document.createElement(\"td\");" +
    "      var code = document.createElement(\"code\");" +
    "      code.textContent = card.cardId;" +
    "      tdId.appendChild(code);" +
    "      tr.appendChild(tdId);" +
    "      var tdLabel = document.createElement(\"td\");" +
    "      tdLabel.textContent = card.label || \"\";" +
    "      tr.appendChild(tdLabel);" +
    "      var tdState = document.createElement(\"td\");" +
    "      tdState.textContent = card.revokedAt ? \"已吊销\" : \"有效\";" +
    "      tr.appendChild(tdState);" +
    "      var tdAct = document.createElement(\"td\");" +
    "      if (!card.revokedAt) {" +
    "        var b = document.createElement(\"button\");" +
    "        b.className = \"ghost\";" +
    "        b.textContent = \"吊销\";" +
    "        b.style.marginTop = \"0\";" +
    "        b.onclick = function () {" +
    "          api(\"DELETE\", \"/panel/cards/\" + encodeURIComponent(card.cardId)).then(function () {" +
    "            setMsg($(\"cardMsg\"), \"已吊销 \" + card.cardId, false);" +
    "            refresh();" +
    "          }).catch(function (e) { setMsg($(\"cardMsg\"), e.message, true); });" +
    "        };" +
    "        tdAct.appendChild(b);" +
    "      }" +
    "      tr.appendChild(tdAct);" +
    "      tb.appendChild(tr);" +
    "    });" +
    "  }" +
    "" +
    "  function loadPlays() {" +
    "    api(\"GET\", \"/panel/plays?limit=20\").then(function (r) {" +
    "      var tb = $(\"playTable\").querySelector(\"tbody\");" +
    "      tb.innerHTML = \"\";" +
    "      if (!r.plays.length) {" +
    "        var empty = document.createElement(\"tr\");" +
    "        empty.innerHTML = \"<td colspan=\"4\" style=\"color:#9aa0a6\">暂无记录</td>\";" +
    "        tb.appendChild(empty);" +
    "        return;" +
    "      }" +
    "      r.plays.forEach(function (p) {" +
    "        var tr = document.createElement(\"tr\");" +
    "        var cells = [p.musicId, String(p.difficulty), String(p.score), String(p.rank || \"\")];" +
    "        cells.forEach(function (v) {" +
    "          var td = document.createElement(\"td\");" +
    "          td.textContent = v;" +
    "          tr.appendChild(td);" +
    "        });" +
    "        tb.appendChild(tr);" +
    "      });" +
    "    }).catch(function () {});" +
    "  }" +
    "" +
    "  function showApp(session) {" +
    "    $(\"loginCard\").classList.add(\"hidden\");" +
    "    $(\"app\").classList.remove(\"hidden\");" +
    "    var u = session.user;" +
    "    $(\"who\").innerHTML =" +
    "      \"<div>用户名: <b>\" + esc(u.username) + \"</b></div>\" +" +
    "      \"<div>显示名: \" + esc(u.displayName) + \"</div>\" +" +
    "      \"<div>偏差值: \" + esc(u.rating) + \"</div>\";" +
    "    $(\"dn\").value = u.displayName || \"\";" +
    "    $(\"np\").value = String(u.nameplate || 0);" +
    "    $(\"tt\").value = String(u.title || 0);" +
    "    renderCards(session.cards || []);" +
    "    loadPlays();" +
    "  }" +
    "" +
    "  function refresh() {" +
    "    return api(\"GET\", \"/panel/me\").then(function (s) {" +
    "      if (!s.user) {" +
    "        $(\"loginCard\").classList.remove(\"hidden\");" +
    "        $(\"app\").classList.add(\"hidden\");" +
    "        return null;" +
    "      }" +
    "      showApp(s);" +
    "      return s;" +
    "    });" +
    "  }" +
    "" +
    "  $(\"loginBtn\").onclick = function () {" +
    "    var btn = $(\"loginBtn\");" +
    "    btn.disabled = true;" +
    "    setMsg($(\"loginMsg\"), \"登录中…\", false);" +
    "    api(\"POST\", \"/panel/login\", { username: $(\"u\").value.trim(), code: $(\"c\").value.trim() })" +
    "      .then(function () {" +
    "        setMsg($(\"loginMsg\"), \"\", false);" +
    "        $(\"c\").value = \"\";" +
    "        return refresh();" +
    "      })" +
    "      .catch(function (e) { setMsg($(\"loginMsg\"), e.message, true); })" +
    "      .then(function () { btn.disabled = false; });" +
    "  };" +
    "" +
    "  $(\"c\").addEventListener(\"keydown\", function (e) {" +
    "    if (e.key === \"Enter\") $(\"loginBtn\").click();" +
    "  });" +
    "" +
    "  $(\"logoutBtn\").onclick = function () {" +
    "    api(\"POST\", \"/panel/logout\").then(refresh);" +
    "  };" +
    "" +
    "  $(\"saveProfileBtn\").onclick = function () {" +
    "    var btn = $(\"saveProfileBtn\");" +
    "    btn.disabled = true;" +
    "    api(\"PATCH\", \"/panel/profile\", {" +
    "      displayName: $(\"dn\").value.trim()," +
    "      nameplate: Number($(\"np\").value) || 0," +
    "      title: Number($(\"tt\").value) || 0" +
    "    }).then(function () {" +
    "      setMsg($(\"profileMsg\"), \"已保存\", false);" +
    "      refresh();" +
    "    }).catch(function (e) {" +
    "      setMsg($(\"profileMsg\"), e.message, true);" +
    "    }).then(function () { btn.disabled = false; });" +
    "  };" +
    "" +
    "  $(\"issueBtn\").onclick = function () {" +
    "    var btn = $(\"issueBtn\");" +
    "    btn.disabled = true;" +
    "    api(\"POST\", \"/panel/cards\", {}).then(function (r) {" +
    "      setMsg($(\"cardMsg\"), \"新卡号: \" + r.card.cardId, false);" +
    "      refresh();" +
    "    }).catch(function (e) {" +
    "      setMsg($(\"cardMsg\"), e.message, true);" +
    "    }).then(function () { btn.disabled = false; });" +
    "  };" +
    "" +
    "  refresh();" +
    "})();" +
    "</script>" +
    "</body>" +
    "</html>";
