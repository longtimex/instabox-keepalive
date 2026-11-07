// 管理面板的 HTML（单页，原生 JS/CSS，无框架、无外链、无 CDN）
// 由 worker.js import 后直接吐出；构建脚本会把它内联进 dist/worker.js。
// 注意：这里是一个 String.raw 模板串，正文里不要出现反引号和 ${。
export const UI_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>InstaBox 保活面板</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232563eb'/><rect x='9' y='9' width='14' height='14' rx='4' fill='white'/></svg>">
<style>
:root{
  --bg:#f4f5f7;--panel:#ffffff;--text:#15181d;--muted:#6b7280;--line:#e6e8ec;
  --accent:#2563eb;--accent-weak:#eef3ff;--code:#f3f4f6;
  --ok:#0f7b6c;--ok-bg:#e7f4f1;--warn:#9a5b00;--warn-bg:#fdf2e0;--bad:#b42318;--bad-bg:#fdecea;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014;--panel:#161a20;--text:#e7eaef;--muted:#98a0ac;--line:#252b34;
    --accent:#6b9bff;--accent-weak:#1a2334;--code:#1d232b;
    --ok:#4ecdb2;--ok-bg:#102a25;--warn:#e0a75e;--warn-bg:#2a2114;--bad:#f18a82;--bad-bg:#2c1717;
  }
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--bg);color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:12.5px}
.wrap{max-width:1060px;margin:0 auto;padding:22px 18px 60px}
.hide{display:none !important}
.muted{color:var(--muted)}

.top{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.logo{width:26px;height:26px;border-radius:7px;background:var(--accent);position:relative;flex:none}
.logo:after{content:"";position:absolute;left:7px;top:7px;width:12px;height:12px;border-radius:3px;background:var(--panel)}
.brand h1{font-size:15px;font-weight:500;margin:0;letter-spacing:.2px}
.tools{display:flex;gap:8px;flex-wrap:wrap}

.btn{
  font:inherit;font-size:13px;color:var(--text);background:var(--panel);
  border:1px solid var(--line);border-radius:8px;padding:7px 13px;cursor:pointer;
  transition:border-color .12s,background .12s;
}
.btn:hover{border-color:var(--muted)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{filter:brightness(1.06)}
.btn.tiny{padding:4px 9px;font-size:12px;border-radius:7px}
.btn.tiny.danger{color:var(--bad)}
.btn.tiny.danger:hover{border-color:var(--bad)}

.badge{display:inline-block;font-size:11.5px;line-height:1.6;padding:1px 8px;border-radius:99px;background:var(--code);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}

.notice{margin:0 0 16px;padding:11px 13px;border-radius:10px;font-size:13px;border:1px solid var(--line);background:var(--panel)}
.notice.warn{background:var(--warn-bg);border-color:transparent;color:var(--warn)}


.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 14px;display:flex;flex-direction:column;gap:2px}
.stat span{font-size:12px;color:var(--muted)}
.stat b{font-size:22px;font-weight:500;line-height:1.2}
.stat i{font-style:normal;font-size:11.5px;color:var(--muted)}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:16px;overflow:hidden}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
.panel-head h2{font-size:13.5px;font-weight:500;margin:0;white-space:nowrap}
.head-actions{display:flex;gap:6px;align-items:center}
.hint{font-size:12px;color:var(--muted)}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-weight:500;font-size:12px;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--panel)}
td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--accent-weak)}
.c{text-align:center}
.r{text-align:right;white-space:nowrap}
td .btn+.btn{margin-left:6px}
.mname{font-weight:500}
.mid{font-size:11.5px;color:var(--muted);margin-top:1px}
.left{font-size:12.5px;white-space:nowrap}
.left.ok{color:var(--ok)}
.left.warn{color:var(--warn)}
.left.bad{color:var(--bad)}
.left.muted{color:var(--muted)}
.c-bad{color:var(--bad)}
.c-warn{color:var(--warn)}

/* 保活区间 */
.wbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:14px 16px 2px}
/* 时间/上限各包一组，窄屏换行时整组走，不会把「08:00 至 23:00」拆成两半 */
.wgrp{display:flex;align-items:center;gap:6px;white-space:nowrap}
.wbar input[type=time],.wbar input[type=number],.wbar input[type=text],.wbar input[type=password]{font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.wbar input[type=time]{width:104px}
.wbar input[type=number]{width:76px}
.wbar input[type=text]{width:210px}
.wbar input[type=password]{width:250px}
.wbar .wtag{font-size:13px}
/* 多段时间：一行一段，窄屏整段换行，不把「09:00 至 12:00」拆开 */
.wranges{display:flex;flex-direction:column;gap:8px;padding:10px 16px 0}
.wrange{display:flex;align-items:center;gap:6px;flex-wrap:wrap;white-space:nowrap}
/* flex:0 0 auto 必须加：不然窄屏会把时间框压到放不下时钟图标 */
.wrange input[type=time]{flex:0 0 auto;font:inherit;font-size:13px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);width:104px}
.wfoot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px 0;font-size:12px}
.wstate{padding:8px 16px 14px;font-size:12.5px;color:var(--muted)}
.wstate.warn{color:var(--warn)}

.sw{position:relative;display:inline-block;width:38px;height:22px;vertical-align:middle}
.sw input{position:absolute;left:0;top:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}
.sw i{position:absolute;left:0;top:0;right:0;bottom:0;background:var(--line);border-radius:99px;transition:background .15s}
.sw i:after{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.sw input:checked+i{background:var(--accent)}
.sw input:checked+i:after{transform:translateX(16px)}
.sw input:focus-visible+i{outline:2px solid var(--accent);outline-offset:2px}

.empty{padding:26px 16px;text-align:center;color:var(--muted);font-size:13px}

.accts{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;padding:14px 16px}
.acct{border:1px solid var(--line);border-radius:11px;padding:12px 13px}
.acct.off{opacity:.6}
.acct-top{display:flex;align-items:center;gap:8px}
.aid{font-size:12.5px;color:var(--muted)}
.acct-top code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acct-meta{font-size:12px;color:var(--muted);margin:8px 0 10px;line-height:1.7}
.acct-actions{display:flex;gap:6px;flex-wrap:wrap}

.logs{padding:6px 16px 14px;font-size:12.5px}
.logs p{margin:10px 0}
.log-item{display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.log-item:last-child{border-bottom:0}

.foot{text-align:center;font-size:11.5px;color:var(--muted);margin-top:22px}

.toast{
  position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:50;
  background:#1f242c;color:#fff;font-size:13px;padding:9px 16px;border-radius:9px;
  max-width:86vw;text-align:center;transition:opacity .18s;
}
.toast.bad{background:var(--bad)}
.toast.hide{opacity:0;pointer-events:none}

dialog.modal{
  border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--text);
  padding:22px 22px 18px;width:min(420px,92vw);
}
dialog.modal::backdrop{background:rgba(15,17,21,.42)}
dialog.modal h2{font-size:14px;font-weight:500;margin:0 0 6px}
dialog.modal .sub{color:var(--muted);font-size:12.5px;line-height:1.7;margin:0 0 16px}
dialog.modal .field{display:block;margin-bottom:12px}
dialog.modal .field span{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
dialog.modal .field input{
  width:100%;font:inherit;font-size:13.5px;padding:9px 11px;border-radius:9px;
  border:1px solid var(--line);background:var(--bg);color:var(--text);
}
dialog.modal .field input:focus{outline:2px solid var(--accent-weak);border-color:var(--accent)}
dialog.modal .field input[type=checkbox]{width:auto;margin:0 8px 0 0;vertical-align:middle}
dialog.modal .field .wgrp{display:flex;align-items:center;gap:6px}
dialog.modal .field .wgrp input[type=time]{width:auto;min-width:0;flex:1}
dialog.modal .err{color:var(--bad);font-size:12.5px;margin:0 0 12px}
dialog.modal .row{display:flex;gap:8px;justify-content:flex-end}

@media (max-width:720px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .wrap{padding:16px 12px 50px}
  .stat b{font-size:19px}
  /* 手机屏别把列挤成一行两三个字，撑开让 .table-wrap 横向滚动 */
  table{min-width:600px}
  /* 输入框 + 右侧按钮是一组不换行的，得让输入框先让位，否则按钮被挤出视口 */
  .wbar input[type=password]{width:150px}
  .wbar input[type=text]{width:140px}
  .wbar{gap:8px}
  /* 标题别被 hint 挤成两行 */
  .panel-head{flex-wrap:wrap;gap:4px 12px}
}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <span class="logo"></span>
      <h1>InstaBox 保活面板</h1>
      <span id="pill" class="badge">加载中</span>
    </div>
    <div class="tools">
      <button class="btn" id="b-refresh" type="button">刷新</button>
      <button class="btn primary" id="b-renew" type="button">全部续租</button>
      <button class="btn" id="b-pause" type="button">暂停保活</button>
      <button class="btn hide" id="b-account" type="button">账号</button>
      <button class="btn hide" id="b-logout" type="button">退出</button>
    </div>
  </header>

  <div id="notice" class="notice hide"></div>

  <main id="app" class="hide">
    <section class="stats" id="stats"></section>

    <section class="panel">
      <div class="panel-head">
        <h2>保活区间</h2>
        <span class="hint" id="whint">按北京时间</span>
      </div>
      <div class="wbar">
        <span class="wgrp">
          <label class="sw" title="只在这些时间段里续租">
            <input type="checkbox" id="w-on"><i></i>
          </label>
          <span class="wtag">只在时间段内保活</span>
        </span>
        <span class="wgrp">
          <span class="muted">单次上限</span>
          <input type="number" id="w-max" min="0" max="1440" step="15" value="0">
          <span class="muted">分钟（0 = 不限）</span>
        </span>
        <button class="btn tiny primary" id="b-wsave" type="button">保存</button>
      </div>
      <div class="wranges" id="w-ranges"></div>
      <div class="wfoot">
        <button class="btn tiny" id="b-wadd" type="button">＋ 添加时间段</button>
        <span class="muted">可加多段，每段之间机器会自然休眠；跨午夜写 22:00 至 06:00</span>
      </div>
      <div class="wstate" id="wstate"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>机器</h2>
        <span class="hint" id="mhint"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>账号</th><th>机器</th><th>状态</th><th>租约</th>
              <th>区间</th><th class="c">保活</th><th class="r">操作</th>
            </tr>
          </thead>
          <tbody id="mrows"></tbody>
        </table>
      </div>
      <div id="mempty" class="empty hide">还没有机器。确认 key 有 <code>machines:write</code> 权限。</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>账号</h2>
        <span class="hint">开关只影响续租，不改机器本身</span>
      </div>
      <div id="accts" class="accts"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Telegram 机器人</h2>
        <span class="hint">手机上开关机器；token / secret 留空表示不改</span>
      </div>
      <div class="wbar">
        <span class="wgrp">
          <span class="muted">Bot token</span>
          <input type="password" id="tg-token" autocomplete="off" spellcheck="false">
        </span>
        <span class="wgrp">
          <span class="muted">Webhook secret</span>
          <input type="password" id="tg-secret" autocomplete="off" spellcheck="false">
          <button class="btn tiny" id="b-tggen" type="button">随机生成</button>
        </span>
      </div>
      <div class="wbar">
        <span class="wgrp">
          <span class="muted">允许的 chat id</span>
          <input type="text" id="tg-chats" placeholder="逗号分隔；留空 = 只回显 id 不执行" autocomplete="off">
        </span>
        <button class="btn tiny primary" id="b-tgsave" type="button">保存并注册</button>
        <button class="btn tiny" id="b-tginfo" type="button">查看状态</button>
        <button class="btn tiny danger" id="b-tgclear" type="button">清空</button>
      </div>
      <div class="wstate" id="tg-state"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>最近日志</h2>
        <div class="head-actions">
          <button class="btn tiny" id="b-log" type="button">加载</button>
          <button class="btn tiny danger" id="b-logclear" type="button">清空</button>
        </div>
      </div>
      <div id="logs" class="logs"><p class="muted">点「加载」看最近续租记录。</p></div>
    </section>
  </main>

  <footer class="foot"><span id="foot-at"></span></footer>
</div>

<dialog id="acct" class="modal">
  <form id="acct-form" autocomplete="on">
    <h2>账号设置</h2>
    <p class="sub" id="acct-sub">改完密码后，其它设备会被登出；当前这台会自动续上。</p>
    <label class="field">
      <span>用户名</span>
      <input id="acct-user" type="text" autocomplete="username" spellcheck="false">
    </label>
    <label class="field">
      <span>当前密码</span>
      <input id="acct-cur" type="password" autocomplete="current-password">
    </label>
    <label class="field">
      <span>新密码（留空表示不改）</span>
      <input id="acct-new" type="password" autocomplete="new-password">
    </label>
    <label class="field">
      <span>确认新密码</span>
      <input id="acct-new2" type="password" autocomplete="new-password">
    </label>
    <p class="err hide" id="acct-err"></p>
    <div class="row">
      <button class="btn" type="button" id="acct-cancel">取消</button>
      <button class="btn primary" type="submit" id="acct-save">保存</button>
    </div>
  </form>
</dialog>

<dialog id="mwin" class="modal">
  <form id="mwin-form" autocomplete="off">
    <h2 id="mwin-title">机器保活区间</h2>
    <p class="sub" id="mwin-sub">不自定义时跟随上方的默认区间。</p>
    <label class="field">
      <span><input type="checkbox" id="mwin-on"> 只在时间段内保活（不勾选 = 全天）</span>
    </label>
    <div class="field">
      <span>时间段（北京时间，可加多段）</span>
      <div class="wranges" id="mwin-ranges"></div>
      <button class="btn tiny" id="mwin-add" type="button">＋ 添加时间段</button>
    </div>
    <label class="field">
      <span>单次保活上限（分钟，0 = 不限）</span>
      <input type="number" id="mwin-max" min="0" max="1440" step="15" value="0">
    </label>
    <p class="err hide" id="mwin-err"></p>
    <div class="row">
      <button class="btn" type="button" id="mwin-cancel">取消</button>
      <button class="btn" type="button" id="mwin-reset">跟随默认</button>
      <button class="btn primary" type="submit" id="mwin-save">保存</button>
    </div>
  </form>
</dialog>

<div id="toast" class="toast hide"></div>

<script>
(function () {
  "use strict";
  var data = null;
  var loading = false;
  var readOnly = false;

  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  var toastTimer = null;
  function toast(msg, bad) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = "toast hide"; }, 2800);
  }

  function api(path, opt) {
    opt = opt || {};
    var headers = {};
    var init = { method: opt.method || "GET", headers: headers, cache: "no-store", credentials: "same-origin" };
    if (opt.body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opt.body);
    }
    return fetch(path, init).then(function (r) {
      return r.text().then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (e) { j = { ok: false, error: "HTTP " + r.status }; }
        j._status = r.status;
        return j;
      });
    });
  }

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function leftInfo(iso) {    if (!iso) return { text: "—", cls: "muted" };
    var t = Date.parse(iso);
    if (!t) return { text: "—", cls: "muted" };
    var diff = t - Date.now();
    if (diff <= 0) return { text: "已过期", cls: "bad" };
    var s = Math.floor(diff / 1000);
    var m = Math.floor(s / 60);
    var text;
    if (m >= 60) text = Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
    else if (m > 0) text = m + " 分 " + (s % 60) + " 秒";
    else text = s + " 秒";
    return { text: text + "后到期", cls: diff < 120000 ? "warn" : "ok" };
  }

  // 距上次成功续租多久 —— 这个数字比「到期时间」更早暴露调度本身挂了
  function ago(iso) {
    var d = Date.now() - Date.parse(iso);
    if (!(d >= 0)) return "刚刚";
    var s = Math.floor(d / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60);
    return h + " 小时 " + (m % 60) + " 分";
  }

  function tickLeft() {
    var nodes = document.querySelectorAll("[data-exp]");
    for (var i = 0; i < nodes.length; i++) {
      var r = leftInfo(nodes[i].getAttribute("data-exp"));
      nodes[i].textContent = r.text;
      nodes[i].className = "left " + r.cls;
    }
  }

  function findAccount(a) {
    if (!data) return null;
    for (var i = 0; i < data.accounts.length; i++) {
      if (String(data.accounts[i].account) === String(a)) return data.accounts[i];
    }
    return null;
  }

  function machinesOf(a) {
    return (data.machines || []).filter(function (m) { return String(m.account) === String(a); });
  }

  function statCard(label, value, hint) {
    return '<div class="stat"><span>' + esc(label) + '</span><b>' + esc(value) + '</b><i>' + esc(hint) + '</i></div>';
  }

  function renderStats() {
    var ms = data.machines || [];
    var running = 0, on = 0, pending = 0;
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].state === "running") running++;
      if (ms[i].selected) {
        on++;
        if (ms[i].state !== "running") pending++;
      }
    }
    var lastLease = data.lastLeaseAt ? when(data.lastLeaseAt) : "还没有成功续租";
    var expiring = 0;
    for (var j = 0; j < ms.length; j++) {
      var end = Date.parse(ms[j].expiresAt || "");
      if (ms[j].selected && Number.isFinite(end) && end - Date.now() < 120000) expiring++;
    }
    $("stats").innerHTML =
      statCard("机器", ms.length, "受这个 Worker 管理") +
      statCard("运行中", running, "state = running") +
      statCard("保活中", on, expiring ? expiring + " 台租约即将过期" : (pending ? pending + " 台待唤醒" : "没有待唤醒机器")) +
      statCard("最近续租", data.paused ? "暂停" : lastLease, data.paused ? "cron 当前不会续租" : "仅成功 PUT 后更新");
  }

  function renderMachines() {
    var ms = data.machines || [];
    $("mempty").classList.toggle("hide", ms.length > 0);
    // 必须显示“最近一次成功 lease”，不能用 liveAt（最近一次执行）冒充：
    // 持续失败时 liveAt 每轮都会变新，会掩盖真正失效的保活。
    if (data.lastLeaseAt) {
      var ttlMs = 900 * 1000;
      for (var ai = 0; ai < data.accounts.length; ai++) {
        if (data.accounts[ai].ttl && data.accounts[ai].ttl * 1000 < ttlMs) ttlMs = data.accounts[ai].ttl * 1000;
      }
      var age = Date.now() - Date.parse(data.lastLeaseAt);
      var ageCls = age > ttlMs ? "c-bad" : (age > ttlMs * 0.6 ? "c-warn" : "");
      var lim = 0;
      for (var li = 0; li < ms.length; li++) if (ms[li].selected && ms[li].liveLimit) lim++;
      $("mhint").innerHTML =
        '最近成功续租 <span class="' + ageCls + '">' + esc(ago(data.lastLeaseAt)) + "</span>前" +
        (lim ? ' · <span class="c-warn">' + lim + " 台受平台限制</span>" : "") +
        (data.alertOn ? "" : " · 未开告警");
    } else {
      $("mhint").textContent = data.canSave ? "还没有成功续租" : "未绑定 CONFIG，租约时间不可见";
    }

    var html = "";
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      var st = m.state || "unknown";
      var stCls = st === "running" ? "ok" : (st === "suspended" || st === "stopped" ? "warn" : "");
      var r = leftInfo(m.expiresAt);
      // 冷却中：这时候点「唤醒」一定会被平台拒（409 machine_cooldown），先标出来。
      // cooldownReason 是 abuse_* 说明是安全审查锁（最长 24 小时），
      // 空则是 max-run 到点（5-20 分钟，免费版连坐能到 2 小时）—— 两者提示要分开。
      var cooling = m.cooldownUntil && new Date(m.cooldownUntil).getTime() > Date.now();
      var cool = "";
      if (cooling) {
        var abuse = /^abuse_/.test(m.cooldownReason || "");
        cool = '<div class="mid muted">' + (abuse ? "安全审查锁，还剩 " : "冷却中，还剩 ") +
          esc(leftInfo(m.cooldownUntil).text.replace("后到期", "")) + "</div>";
      } else if (m.earlyAllowanceEnded) {
        cool = '<div class="mid muted">免费额度已结束：先暂停/删除一台运行中的机器，或升级套餐</div>';
      } else if (m.maxRunMinutes === 0) {
        cool = '<div class="mid muted">max-run 已禁用：先在 InstaBox 改回可运行设置</div>';
      } else if (m.maxRunMinutes > 0 && m.runStartedAt) {
        // 免费版 480 分钟到点就会被平台强制暂停，提前把剩余时间摆出来
        var endMs = new Date(m.runStartedAt).getTime() + m.maxRunMinutes * 60000;
        if (endMs > Date.now()) {
          cool = '<div class="mid muted">距 max-run 上限还有 ' +
            esc(leftInfo(new Date(endMs).toISOString()).text.replace("后到期", "")) + "</div>";
        }
      }
      var dis = readOnly ? " disabled" : "";
      // 区间编辑依赖 CONFIG KV；没有 KV 时只禁用区间按钮，不能连无需 KV 的
      // 续租/唤醒/释放一起禁用。
      var winDis = readOnly || !data.canSave ? " disabled" : "";
      var w = m.window || {};
      var segs = Array.isArray(w.ranges) ? w.ranges : [];
      var winText;
      if (!w.on) winText = "全天";
      else if (segs.length > 1) winText = segs.length + " 段";
      else if (segs.length) winText = segs[0].startAt + "–" + segs[0].endAt;
      else winText = w.startAt + "–" + w.endAt;
      if (w.maxMin) winText += " · ≤" + w.maxMin + "分";
      if (w.inherited) winText = "默认 · " + winText;
      var winCls = w.phase === "idle" || w.phase === "capped" ? "warn" : (w.inherited ? "muted" : "ok");
      var winCell = '<button class="btn tiny" data-act="mwin" data-a="' + m.account + '" data-id="' + esc(m.id) + '"' + winDis + ">" +
        esc(winText) + '</button><div class="mid ' + winCls + '">' + esc(w.inherited ? "跟随默认" : "单独设置") + "</div>";
      var ops = '<button class="btn tiny" data-act="renew" data-a="' + m.account + '" data-id="' + esc(m.id) + '"' + dis + ">续租</button>";
      if (st !== "running") {
        ops += '<button class="btn tiny" data-act="resume" data-a="' + m.account + '" data-id="' + esc(m.id) + '"' + dis + ">唤醒</button>";
      }
      ops += '<button class="btn tiny danger" data-act="release" data-a="' + m.account + '" data-id="' + esc(m.id) + '"' + dis + ">释放</button>";

      html += "<tr>" +
        '<td class="mono muted">#' + esc(m.account) + "</td>" +
        '<td><div class="mname">' + esc(m.name) + '</div><div class="mid mono">' + esc(m.id) + "</div></td>" +
        '<td><span class="badge ' + stCls + '">' + esc(st) + "</span>" + cool + "</td>" +
        '<td><span class="left ' + r.cls + '" data-exp="' + esc(m.expiresAt || "") + '">' + esc(r.text) + "</span></td>" +
        "<td>" + winCell + "</td>" +
        '<td class="c"><label class="sw"><input type="checkbox" data-act="toggle" data-a="' + m.account +
          '" data-id="' + esc(m.id) + '"' + (m.selected ? " checked" : "") + dis + "><i></i></label></td>" +
        '<td class="r">' + ops + "</td>" +
        "</tr>";
    }
    $("mrows").innerHTML = html;
  }

  // 用户动过区间表单但还没保存时，别让 20 秒一次的自动刷新把输入覆盖掉
  var wDirty = false;

  // 多段时间的一行：起点 / 至 / 终点 / 删除。窄屏整行换行，不拆开时间
  function rangeRow(startAt, endAt) {
    return '<span class="wrange">' +
      '<input type="time" class="r-start" value="' + esc(startAt || "08:00") + '" step="60">' +
      '<span class="muted">至</span>' +
      '<input type="time" class="r-end" value="' + esc(endAt || "23:00") + '" step="60">' +
      '<button class="btn tiny danger" type="button" data-del="1">删除</button>' +
      "</span>";
  }

  function setRangesDisabled(id, dis) {
    var box = $(id);
    if (!box) return;
    var nodes = box.querySelectorAll("input,button");
    for (var i = 0; i < nodes.length; i++) nodes[i].disabled = dis;
  }

  function fillRanges(id, ranges) {
    var box = $(id);
    if (!box) return;
    var list = Array.isArray(ranges) && ranges.length ? ranges : [{ startAt: "08:00", endAt: "23:00" }];
    box.innerHTML = list.map(function (r) { return rangeRow(r.startAt, r.endAt); }).join("");
    setRangesDisabled(id, readOnly || !data.canSave);
  }

  function addRange(id, startAt, endAt) {
    var box = $(id);
    if (!box) return;
    box.insertAdjacentHTML("beforeend", rangeRow(startAt, endAt));
    setRangesDisabled(id, readOnly || !data.canSave);
  }

  // 读回所有段；时间非法就退回当前值，避免把 00:00 静默写进去
  function collectRanges(id, fallback) {
    var box = $(id);
    var out = [];
    if (!box) return out;
    var rows = box.querySelectorAll(".wrange");
    var fb = fallback || { start: 480, end: 1380 };
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i].querySelector(".r-start");
      var e = rows[i].querySelector(".r-end");
      out.push({ start: toMin(s && s.value, fb.start), end: toMin(e && e.value, fb.end) });
    }
    return out;
  }

  function bindRangeBox(id, onDirty) {
    var box = $(id);
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("[data-del]") : null;
      if (!btn) return;
      var row = btn.closest(".wrange");
      if (row) row.remove();
      // 删光了补回一行：空数组会让后端退回默认，用户会以为「删掉 = 全天」
      if (!box.querySelectorAll(".wrange").length) addRange(id);
      if (onDirty) onDirty();
    });
    box.addEventListener("input", function () { if (onDirty) onDirty(); });
  }

  function renderWindow() {
    var w = data.window;
    var el = $("wstate");
    if (!w) { el.textContent = ""; return; }

    var dis = readOnly || !data.canSave;
    if (!wDirty) {
      $("w-on").checked = !!w.on;
      $("w-max").value = w.maxMin || 0;
      fillRanges("w-ranges", w.ranges);
    } else {
      setRangesDisabled("w-ranges", dis);
    }

    $("w-on").disabled = dis;
    $("w-max").disabled = dis;
    $("b-wsave").disabled = dis;
    $("b-wadd").disabled = dis;

    var t = "现在北京时间 " + w.nowAt + " · ";
    var cls = "wstate";
    var segCount = (w.ranges || []).length;
    if (!w.on) {
      t += w.maxMin ? "全天保活，单次最多 " + w.maxMin + " 分钟" : "全天保活";
    } else if (w.phase === "idle") {
      t += "不在区间内（共 " + segCount + " 段），cron 不续租，机器会自然休眠";
      cls += " warn";
    } else if (w.phase === "capped") {
      t += "本轮已保活 " + w.keptMin + " 分钟，到 " + w.maxMin + " 分钟上限了";
      cls += " warn";
    } else {
      t += "正在保活" + (w.maxMin ? "，本轮已 " + w.keptMin + "/" + w.maxMin + " 分钟" : "");
    }
    if (!data.canSave) t += " · 没绑 CONFIG KV，改了不会保存";
    el.className = cls;
    el.textContent = t;
  }

  // 机器人配置：token / secret 永远不回显，输入框留空 = 保持原值
  var tgDirty = false;

  function tgSource(s) {
    return s === "kv" ? "网页" : s === "env" ? "环境变量" : "没配";
  }

  function renderTg() {
    var t = data.telegram || {};
    var el = $("tg-state");
    var dis = readOnly || !data.canSave;

    ["tg-token", "tg-secret", "tg-chats"].forEach(function (id) { $(id).disabled = dis; });
    $("b-tggen").disabled = dis;
    $("b-tgsave").disabled = dis;
    $("b-tgclear").disabled = dis;

    $("tg-token").placeholder = t.tokenMasked
      ? "已配置 " + t.tokenMasked
      : "填 BotFather 给的 token";
    $("tg-secret").placeholder = t.secretMasked
      ? "已配置 " + t.secretMasked
      : "点右边「随机生成」";
    if (!tgDirty) $("tg-chats").value = (t.chats || []).join(",");

    var cls = "wstate";
    var txt;
    if (!t.configured) {
      txt = "还没配 token，机器人不可用。";
      cls += " warn";
    } else if (!t.secretMasked) {
      txt = "⚠️ 没配 webhook secret：/tg 谁都能打，别人知道 chat id 就能关机。点「随机生成」再保存。";
      cls += " warn";
    } else {
      txt = "token 来自" + tgSource(t.src && t.src.token) +
        " · secret 来自" + tgSource(t.src && t.src.secret) +
        " · " + (t.chats && t.chats.length
          ? "允许 " + t.chats.length + " 个聊天"
          : "没限聊天，任何人发消息都只回显 id");
    }
    if (!data.canSave) {
      txt += " · 没绑 CONFIG KV，网页里填的存不下来";
      cls += " warn";
    }
    el.className = cls;
    el.textContent = txt;
  }

  function renderAccounts() {
    var html = "";
    for (var i = 0; i < data.accounts.length; i++) {
      var a = data.accounts[i];
      var mode = !a.conf
        ? "跟随变量"
        : (a.conf.mode === "list" ? (a.conf.machines.length + " 台白名单") : "全部机器");
      var enabled = !a.conf || a.conf.enabled !== false;
      var dis = readOnly ? " disabled" : "";
      html += '<div class="acct' + (enabled ? "" : " off") + '">' +
        '<div class="acct-top"><span class="aid">#' + esc(a.account) + "</span>" +
          "<code>" + esc(a.key) + "</code>" +
          '<label class="sw"><input type="checkbox" data-act="acc" data-a="' + a.account + '"' +
            (enabled ? " checked" : "") + dis + "><i></i></label></div>" +
        '<div class="acct-meta">租约 <code>' + esc(a.lease) + "</code> · TTL " + esc(a.ttl) + "s · " +
          esc(a.count) + " 台 · " + esc(mode) +
          (a.error ? ' · <span class="bad">' + esc(a.error) + "</span>" : "") + "</div>" +
        '<div class="acct-actions">' +
          '<button class="btn tiny" data-act="accall" data-a="' + a.account + '"' + dis + ">全部保活</button>" +
          '<button class="btn tiny" data-act="accreset" data-a="' + a.account + '"' + dis + ">恢复默认</button>" +
        "</div></div>";
    }
    $("accts").innerHTML = html || '<p class="muted">没有账号。</p>';
  }

  function render() {
    $("app").classList.remove("hide");
    // 没启用登录（没配密码/TOKEN）就不显示退出/账号按钮
    var canAuth = !!(data.auth && data.auth.via !== "open");
    // renderMachines 依赖这个值决定区间按钮是否可编辑；在 render() 里统一
    // 由服务端 auth.canWrite 计算，避免读到一个旧的只读状态。
    readOnly = !!(data.auth && data.auth.canWrite === false);
    $("b-logout").classList.toggle("hide", !canAuth);
    $("b-account").classList.toggle("hide", !canAuth);
    $("pill").textContent = data.paused ? "已暂停" : "运行中";
    $("pill").className = "badge " + (data.paused ? "warn" : "ok");
    $("b-pause").textContent = data.paused ? "恢复保活" : "暂停保活";
    $("b-pause").className = "btn" + (data.paused ? " primary" : "");

    var n = $("notice");
    var msgs = [];
    if (data.paused) {
      msgs.push("保活已暂停：cron 不会调用 InstaBox，现有租约到期后机器会按平台规则休眠。需要续租请点右侧“恢复保活”。");
    }
    var limitedRows = (data.machines || []).filter(function (m) { return m.selected && m.liveLimit; });
    if (limitedRows.length && !data.paused) {
      msgs.push("有 " + limitedRows.length + " 台机器受平台限制（冷却/配额/max-run）：查看机器行说明；不能靠重复续租解决。");
    }
    if (data.ok === false) {
      msgs.push("当前快照不完整：至少一个账号的机器列表读取失败，下面的状态不代表全部机器。");
    }
    if (data.auth && data.auth.canWrite === false) {
      msgs.push("面板没设密码，现在是<b>只读</b>：能看，但不能续租或改配置。设 <code>ADMIN_PASSWORD</code> 或 <code>TOKEN</code> 后恢复。");
    }
    if (!data.canSave) {
      msgs.push("没绑定 <code>CONFIG</code> KV：面板能看、能手动续租，但开关改动不会保存。去 Worker 的 Settings → Bindings 加一个变量名 <code>CONFIG</code> 的 KV 命名空间。");
    }
    for (var wi = 0; wi < (data.warnings || []).length; wi++) {
      msgs.push("#" + esc(data.warnings[wi].account) + "：" + esc(data.warnings[wi].error));
    }
    if (msgs.length) {
      n.className = "notice warn";
      n.innerHTML = msgs.join("<br>");
    } else {
      n.className = "notice hide";
    }

    $("b-renew").disabled = readOnly;
    $("b-pause").disabled = readOnly;
    $("b-logclear").disabled = readOnly;

    renderStats();
    renderWindow();
    renderTg();
    renderMachines();
    renderAccounts();
    $("foot-at").textContent = "更新于 " + when(data.at) + " · v" + data.version;
  }

  // 会话过期 / 没登录：直接去登录页，回来还落在这个地址
  function toLogin() {
    var next = location.pathname + location.search;
    location.replace("/login?next=" + encodeURIComponent(next));
  }

  function load() {
    if (loading) return;
    // 弹窗编辑期间不做后台回填；保存后主动 load，用户输入不会被覆盖。
    if ($("mwin") && $("mwin").open) return;
    loading = true;
    return api("/api/state").then(function (j) {
      loading = false;
      if (j._status === 401) { toLogin(); return; }
      // /api/state 可能返回 ok:false 但仍带完整 accounts/machines（例如单个账号
      // 列机器失败）。这种降级快照必须继续渲染并展示 warning，不能整页空白。
      var usable = j && Array.isArray(j.accounts) && Array.isArray(j.machines);
      if (!j.ok && !usable) { toast(j.error || "加载失败", true); return; }
      data = j;
      render();
      if (!j.ok) toast(j.error || "部分账号读取失败，已显示可用状态", true);
    }).catch(function (e) {
      loading = false;
      toast("请求失败：" + e.message, true);
    });
  }

  function saveConfig(patch) {
    return api("/api/config", { method: "POST", body: patch }).then(function (j) {
      if (!j.ok) { toast(j.error || "保存失败", true); return false; }
      toast("已保存");
      load();
      return true;
    });
  }

  var winTarget = null;

  function findMachine(a, id) {
    var ms = (data && data.machines) || [];
    for (var i = 0; i < ms.length; i++) {
      if (String(ms[i].account) === String(a) && String(ms[i].id) === String(id)) return ms[i];
    }
    return null;
  }

  function openMachineWindow(a, id) {
    var m = findMachine(a, id);
    if (!m) { toast("机器已不在列表里，刷新后重试", true); return; }
    // 弹窗里的区间字段回填“实际生效值”：继承默认时直接展示默认配置，
    // 用户改前能看见自己将从什么值开始，而不是空白/08:00 的假值。
    winTarget = { account: Number(a), id: m.id, name: m.name || m.id };
    var w = m.window || {};
    $("mwin-title").textContent = (m.name || m.id) + " 的保活区间";
    $("mwin-sub").textContent = w.inherited
      ? "当前跟随默认区间；保存后只覆盖这台机器。"
      : "这台机器使用单独设置；可随时恢复跟随默认。";
    $("mwin-on").checked = !!w.on;
    $("mwin-max").value = w.maxMin || 0;
    fillRanges("mwin-ranges", w.ranges);
    $("mwin-err").classList.add("hide");
    $("mwin").showModal();
  }

  function closeMachineWindow() {
    winTarget = null;
    $("mwin").close();
  }

  function saveAccount(a, patch) {
    var body = { accounts: {} };
    body.accounts[String(a)] = patch;
    return saveConfig(body);
  }

  function setMachine(a, id, on) {
    var acc = findAccount(a);
    var list = machinesOf(a);
    var all = list.map(function (m) { return m.id; });
    // 基准集合必须是「当前真正在保活的机器」：
    // - 有面板配置：list 模式取白名单，all 模式取全部
    // - 没面板配置：选中态来自环境变量 INSTABOX_MACHINE，用服务端返回的 selected
    //   若按 all 当基准，取消勾选一台就会把其它本来没保活的机器一起写进白名单。
    // 只配了单机区间时，筛选范围仍由环境变量决定，不能把 all 当成基准。
    var cur = (acc && acc.conf && !acc.conf.inheritSelection)
      ? (acc.conf.mode === "list" ? acc.conf.machines.slice() : all.slice())
      : list.filter(function (m) { return m.selected; }).map(function (m) { return m.id; });
    // 白名单里可能残留已删除机器的 id，保存前过滤掉
    cur = cur.filter(function (x) { return all.indexOf(x) >= 0; });
    var next;
    if (on) {
      next = cur.slice();
      if (next.indexOf(id) < 0) next.push(id);
    } else {
      next = cur.filter(function (x) { return x !== id; });
    }
    // skip 是 Telegram 维护的「点名关闭」名单，打开机器时必须一起摘掉，
    // 否则 mode=all 下即使勾选开关，cron 仍会跳过它。
    var skip = (acc && acc.conf && Array.isArray(acc.conf.skip) ? acc.conf.skip : []).filter(function (x) { return x !== id; });
    // 所有分支都显式带 skip：mode:all 若不传 skip，后端会按“未提供”保留旧名单。
    saveAccount(a, { enabled: true, mode: all.length && next.length >= all.length ? "all" : "list", machines: next, skip: skip });
  }

  function machineAction(a, id, action, btn) {
    var old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    api("/api/machine", { method: "POST", body: { account: Number(a), id: id, action: action } })
      .then(function (j) {
        if (btn) { btn.disabled = false; btn.textContent = old; }
        if (!j.ok) {
          var limitMsg = j.limit === "max_run_disabled" ? "（max-run=0，先在 InstaBox 改回可运行设置）"
            : j.limit === "quota_exceeded" ? "（平台配额/并发已满）"
            : j.limit === "blocked" ? "（免费额度已结束）"
            : j.limit === "throttled" ? "（平台限制启动频率）"
            : j.limit === "cooling" ? "（平台冷却中）"
            : "";
          toast((j.error || (action + " 失败")) + limitMsg, true);
          return;
        }
        toast(action === "renew" ? "已续租" : (action === "release" ? "已释放租约" : "已唤醒并续租"));
        load();
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = old; }
        toast("请求失败：" + e.message, true);
      });
  }

  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!el || el.tagName === "INPUT") return;
    var act = el.getAttribute("data-act");
    var a = el.getAttribute("data-a");
    var id = el.getAttribute("data-id");

    if (act === "mwin") {
      openMachineWindow(a, id);
    } else if (act === "renew" || act === "resume" || act === "release") {
      machineAction(a, id, act, el);
    } else if (act === "accall") {
      saveAccount(a, { enabled: true, mode: "all" });
    } else if (act === "accreset") {
      saveAccount(a, null);
    }
  });

  document.addEventListener("change", function (e) {
    var t = e.target;
    var act = t.getAttribute && t.getAttribute("data-act");
    // 面板只读或没绑 CONFIG 时别发注定失败的写请求，直接把开关恢复。
    if ((act === "toggle" || act === "acc") && (readOnly || !data.canSave)) {
      toast("当前是只读模式，开关不会保存", true);
      load();
      return;
    }
    if (act === "toggle") setMachine(t.getAttribute("data-a"), t.getAttribute("data-id"), t.checked);
    else if (act === "acc") saveAccount(t.getAttribute("data-a"), { enabled: t.checked });
  });

  $("b-refresh").addEventListener("click", function () { load(); });

  $("b-renew").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    b.textContent = "续租中…";
    api("/api/renew", { method: "POST", body: {} }).then(function (j) {
      b.disabled = false;
      b.textContent = "全部续租";
      if (j.paused) toast("已暂停，本次没有续租", true);
      else if (j.ok) toast("已续租 " + j.count + " 台");
      else toast("有失败：" + (j.error || "看日志"), true);
      load();
    }).catch(function (e) {
      b.disabled = false;
      b.textContent = "全部续租";
      toast("请求失败：" + e.message, true);
    });
  });

  $("b-pause").addEventListener("click", function () {
    var next = !(data && data.paused);
    if (next && !window.confirm("暂停后 cron 不再调用 InstaBox，租约到期后机器会休眠。确定暂停？")) return;
    saveConfig({ paused: next, pausedBy: "panel" }).then(function (ok) {
      if (ok) toast(next ? "已暂停，cron 不再续租" : "已恢复保活");
    });
  });

  // 保活区间：时间输入是 "HH:MM"，换算成当天第几分钟再发
  function toMin(v, fallback) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    if (!m) return fallback;
    var h = Number(m[1]);
    var mi = Number(m[2]);
    return h > 23 || mi > 59 ? fallback : h * 60 + mi;
  }

  // 默认区间的表单脏标记：时间段是动态行，用事件委托统一监听
  ["w-on", "w-max"].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener("input", function () { wDirty = true; });
    el.addEventListener("change", function () { wDirty = true; });
  });
  bindRangeBox("w-ranges", function () { wDirty = true; });
  $("b-wadd").addEventListener("click", function () {
    addRange("w-ranges", "18:00", "23:00");
    wDirty = true;
  });
  $("mwin-add").addEventListener("click", function () {
    addRange("mwin-ranges", "18:00", "23:00");
  });

  function machineWindowPatch() {
    var w = (winTarget && findMachine(winTarget.account, winTarget.id)?.window) || {};
    var first = (Array.isArray(w.ranges) && w.ranges[0]) || { start: 480, end: 1380 };
    var maxMin = Math.max(0, Math.min(1440, Number($("mwin-max").value) || 0));
    return {
      account: winTarget.account,
      id: winTarget.id,
      window: {
        on: $("mwin-on").checked,
        ranges: collectRanges("mwin-ranges", { start: first.start, end: first.end }),
        maxMin: maxMin,
      },
    };
  }

  function submitMachineWindow(body, reset) {
    var err = $("mwin-err");
    err.classList.add("hide");
    var b = $("mwin-save");
    b.disabled = true;
    var target = winTarget;
    api("/api/config", { method: "POST", body: { machine: body } }).then(function (j) {
      b.disabled = false;
      if (!j.ok) {
        err.textContent = j.error || "保存失败";
        err.classList.remove("hide");
        return;
      }
      closeMachineWindow();
      toast(reset ? "已恢复跟随默认区间" : "已保存这台机器的区间");
      load();
    }).catch(function (e) {
      b.disabled = false;
      err.textContent = "请求失败：" + e.message;
      err.classList.remove("hide");
    });
  }

  $("mwin-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!winTarget) return;
    submitMachineWindow({ account: winTarget.account, id: winTarget.id, window: machineWindowPatch().window }, false);
  });
  $("mwin-cancel").addEventListener("click", closeMachineWindow);
  $("mwin-reset").addEventListener("click", function () {
    if (!winTarget) return;
    submitMachineWindow({ account: winTarget.account, id: winTarget.id, window: null }, true);
  });

  $("b-wsave").addEventListener("click", function () {
    var w = (data && data.window) || {};
    var first = (Array.isArray(w.ranges) && w.ranges[0]) || { start: 480, end: 1380 };
    var maxMin = Math.max(0, Math.min(1440, Number($("w-max").value) || 0));
    var patch = {
      window: {
        on: $("w-on").checked,
        ranges: collectRanges("w-ranges", { start: first.start, end: first.end }),
        maxMin: maxMin,
      },
    };
    var b = this;
    b.disabled = true;
    saveConfig(patch).then(function (ok) {
      b.disabled = false;
      if (ok) wDirty = false; // 存成功才允许后续刷新回填
    });
  });

  // ---- Telegram 机器人 ------------------------------------------------------
  ["tg-token", "tg-secret", "tg-chats"].forEach(function (id) {
    var el = $(id);
    if (!el) return;
    el.addEventListener("input", function () { tgDirty = true; });
    el.addEventListener("change", function () { tgDirty = true; });
  });

  $("b-tggen").addEventListener("click", function () {
    var buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    var hex = "";
    for (var i = 0; i < buf.length; i++) hex += ("0" + buf[i].toString(16)).slice(-2);
    $("tg-secret").value = hex;
    tgDirty = true;
  });

  // 只提交真的改过的字段：token/secret 留空 = 保持原值，chats 没变就不写
  $("b-tgsave").addEventListener("click", function () {
    var t = (data && data.telegram) || {};
    var patch = {};
    var tok = $("tg-token").value.trim();
    var sec = $("tg-secret").value.trim();
    if (tok) patch.token = tok;
    if (sec) patch.secret = sec;
    var chatsNow = $("tg-chats").value.split(/[,\s]+/).filter(Boolean).join(",");
    if (chatsNow !== (t.chats || []).join(",")) patch.chats = chatsNow;
    if (!Object.keys(patch).length) {
      toast("没有改动：token/secret 留空表示不改，chat id 也没变");
      return;
    }

    var b = this;
    b.disabled = true;
    b.textContent = "保存中…";
    api("/api/telegram", { method: "POST", body: { telegram: patch, register: true } }).then(function (j) {
      b.disabled = false;
      b.textContent = "保存并注册";
      if (!j.ok) { toast(j.error || "保存失败", true); return; }
      tgDirty = false;
      $("tg-token").value = "";
      $("tg-secret").value = "";
      var tail = typeof j.commands === "number" ? "，命令菜单 " + j.commands + " 条" : "";
      toast((j.secretGenerated ? "已保存并注册（secret 自动生成）" : "已保存并注册") + tail);
      load();
    }).catch(function (e) {
      b.disabled = false;
      b.textContent = "保存并注册";
      toast("请求失败：" + e.message, true);
    });
  });

  $("b-tginfo").addEventListener("click", function () {
    var el = $("tg-state");
    el.className = "wstate";
    el.textContent = "查询中…";
    api("/api/telegram?action=info").then(function (j) {
      if (!j.ok) {
        el.className = "wstate warn";
        el.textContent = j.error || "查询失败";
        return;
      }
      var r = (j.telegram && j.telegram.result) || {};
      var bits = [];
      if (r.url) bits.push("webhook 已注册：" + r.url);
      else bits.push("webhook 还没注册（点「保存并注册」）");
      if (typeof r.pending_update_count === "number") bits.push("待处理 " + r.pending_update_count + " 条");
      if (r.last_error_message) bits.push("最近错误：" + r.last_error_message + "（" + (r.last_error_date ? when(new Date(r.last_error_date * 1000).toISOString()) : "") + "）");
      el.className = "wstate" + (r.last_error_message ? " warn" : "");
      el.textContent = bits.join(" · ");
    }).catch(function (e) {
      el.className = "wstate warn";
      el.textContent = "请求失败：" + e.message;
    });
  });

  $("b-tgclear").addEventListener("click", function () {
    if (!confirm("清掉网页里填的机器人配置，回退到环境变量（TELEGRAM_*）？")) return;
    var b = this;
    b.disabled = true;
    api("/api/telegram", { method: "POST", body: { telegram: null } }).then(function (j) {
      b.disabled = false;
      if (!j.ok) { toast(j.error || "清空失败", true); return; }
      tgDirty = false;
      $("tg-token").value = "";
      $("tg-secret").value = "";
      toast("已清空，现在跟随环境变量");
      load();
    }).catch(function (e) {
      b.disabled = false;
      toast("请求失败：" + e.message, true);
    });
  });

  $("b-log").addEventListener("click", function () {
    api("/log").then(function (j) {
      if (!j.ok) { toast("日志加载失败", true); return; }
      var list = j.entries || [];
      if (!list.length) {
        $("logs").innerHTML = '<p class="muted">还没有日志（没绑 LOG KV、INSTABOX_LOG_MODE=off，或者刚清空过）。</p>';
        return;
      }
      var html = "";
      for (var i = 0; i < list.length && i < 12; i++) {
        var it = list[i];
        html += '<div class="log-item">' +
          '<span class="badge ' + (it.ok ? "ok" : "bad") + '">' + (it.ok ? "成功" : "失败") + "</span>" +
          '<span class="mono muted">' + esc(when(it.at)) + "</span>" +
          "<span>" + esc(it.count) + " 台</span>" +
          (it.paused ? '<span class="muted">已暂停</span>' : "") +
          (it.error ? '<span class="bad">' + esc(it.error) + "</span>" : "") +
          "</div>";
      }
      $("logs").innerHTML = html;
    });
  });

  $("b-logclear").addEventListener("click", function () {
    if (readOnly) {
      toast("只读模式不能清空日志", true);
      return;
    }
    if (!confirm("清空最近日志？只删 KV 里的历史记录，不影响机器和保活。")) return;
    var b = this;
    b.disabled = true;
    api("/api/log/clear", { method: "POST", body: {} })
      .then(function (j) {
        b.disabled = false;
        if (!j.ok) {
          toast(j.error || "清空失败", true);
          return;
        }
        toast("已清空 " + (j.cleared || 0) + " 条日志");
        $("logs").innerHTML = '<p class="muted">日志已清空。</p>';
      })
      .catch(function (e) {
        b.disabled = false;
        toast("清空失败：" + e.message, true);
      });
  });

  $("b-logout").addEventListener("click", function () {
    var b = this;
    b.disabled = true;
    api("/api/logout", { method: "POST", body: {} }).then(function () {
      location.replace("/login");
    }).catch(function () {
      b.disabled = false;
      location.replace("/login");
    });
  });

  function acctErr(msg) {
    var e = $("acct-err");
    if (!msg) { e.className = "err hide"; e.textContent = ""; return; }
    e.textContent = msg;
    e.className = "err";
  }

  $("b-account").addEventListener("click", function () {
    if (!data || !data.auth) return;
    $("acct-cur").value = "";
    $("acct-new").value = "";
    $("acct-new2").value = "";
    $("acct-user").value = data.auth.user || "admin";
    acctErr("");
    if (data.auth.canEdit && data.auth.canWrite !== false) {
      $("acct-sub").textContent = "改完密码后，其它设备会被登出；当前这台会自动续上。";
      $("acct-save").disabled = false;
    } else if (data.auth.canWrite === false) {
      $("acct-sub").innerHTML = "面板没设密码，现在只读。先设 <code>ADMIN_PASSWORD</code> 或 <code>TOKEN</code> 再来改。";
      $("acct-save").disabled = true;
    } else {
      $("acct-sub").innerHTML = "没绑 <code>CONFIG</code> KV，改动存不下来。绑一个变量名 <code>CONFIG</code> 的 KV 命名空间再试。";
      $("acct-save").disabled = true;
    }
    var d = $("acct");
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
    setTimeout(function () { $("acct-cur").focus(); }, 30);
  });

  $("acct-cancel").addEventListener("click", function () {
    $("acct").close();
  });

  $("acct-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var cur = $("acct-cur").value;
    var user = $("acct-user").value.trim();
    var np = $("acct-new").value;
    var np2 = $("acct-new2").value;

    if (!cur) { acctErr("请输入当前密码"); $("acct-cur").focus(); return; }
    if (!user) { acctErr("用户名不能为空"); $("acct-user").focus(); return; }
    if (np !== np2) { acctErr("两次输入的新密码不一致"); $("acct-new2").select(); return; }
    if (np && np.length < 8) { acctErr("新密码至少 8 位"); $("acct-new").focus(); return; }

    var b = $("acct-save");
    b.disabled = true;
    b.textContent = "保存中…";
    acctErr("");
    api("/api/account", { method: "POST", body: { currentPassword: cur, user: user, password: np } })
      .then(function (j) {
        b.disabled = false;
        b.textContent = "保存";
        if (!j.ok) { acctErr(j.error || "保存失败"); return; }
        $("acct").close();
        toast(j.changedPassword ? "已更新，其它设备已登出" : "用户名已更新");
        load();
      })
      .catch(function (e2) {
        b.disabled = false;
        b.textContent = "保存";
        acctErr("请求失败：" + e2.message);
      });
  });

  // 轮询节奏：有人操作时 30 秒一次，闲置时逐步退避到 90 秒。
  // 租约倒计时是前端按 expiresAt 自己算的，拉取变慢不影响观感，但能把
  // 「面板开着不动」时的列机器请求砍掉约 2/3。页面隐藏时完全不拉。
  var POLL_MIN = 30000;
  var POLL_MAX = 90000;
  var pollGap = POLL_MIN;
  var pollTimer = null;

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      if (document.hidden || loading) { schedulePoll(); return; }
      var gap = pollGap;
      load();
      pollGap = Math.min(POLL_MAX, Math.round(gap * 1.5));
      schedulePoll();
    }, pollGap);
  }

  function pollNow() {
    pollGap = POLL_MIN;
    schedulePoll();
  }

  (function boot() {
    load();
    setInterval(tickLeft, 1000);
    schedulePoll();
    // 切回来立刻刷一次，并回到最快节奏
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      load();
      pollNow();
    });
    // 任何点击 / 按键都算「人在看」，重置退避
    document.addEventListener("click", pollNow, true);
    document.addEventListener("keydown", pollNow, true);
  })();
})();
</script>
</body>
</html>
`;

// 登录页（独立一页，跟面板同一套配色）
export const LOGIN_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>登录 · InstaBox 保活面板</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%232563eb'/><rect x='9' y='9' width='14' height='14' rx='4' fill='white'/></svg>">
<style>
:root{
  --bg:#f4f5f7;--panel:#ffffff;--text:#15181d;--muted:#6b7280;--line:#e6e8ec;
  --accent:#2563eb;--accent-weak:#eef3ff;--code:#f3f4f6;
  --bad:#b42318;--warn:#9a5b00;--warn-bg:#fdf2e0;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014;--panel:#161a20;--text:#e7eaef;--muted:#98a0ac;--line:#252b34;
    --accent:#6b9bff;--accent-weak:#1a2334;--code:#1d232b;
    --bad:#f18a82;--warn:#e0a75e;--warn-bg:#2a2114;
  }
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:var(--bg);color:var(--text);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.box{width:100%;max-width:384px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:26px 24px 20px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:26px;height:26px;border-radius:7px;background:var(--accent);position:relative;flex:none}
.logo:after{content:"";position:absolute;left:7px;top:7px;width:12px;height:12px;border-radius:3px;background:var(--panel)}
.brand h1{font-size:15px;font-weight:500;margin:0;letter-spacing:.2px}
.sub{color:var(--muted);font-size:13px;margin:8px 0 20px}
.warn{background:var(--warn-bg);color:var(--warn);font-size:12.5px;line-height:1.7;padding:10px 12px;border-radius:9px;margin:0 0 14px}
.field{display:block;margin-bottom:12px}
.field span{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
.field input{
  width:100%;font:inherit;font-size:14px;padding:10px 12px;border-radius:9px;
  border:1px solid var(--line);background:var(--bg);color:var(--text);
}
.field input:focus{outline:2px solid var(--accent-weak);border-color:var(--accent)}
.remember{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);margin:2px 0 16px;cursor:pointer}
.remember input{margin:0}
.btn{
  display:block;width:100%;font:inherit;font-size:14px;color:#fff;background:var(--accent);
  border:1px solid var(--accent);border-radius:9px;padding:10px 14px;cursor:pointer;text-align:center;text-decoration:none;
}
.btn:hover{filter:brightness(1.06)}
.btn:disabled{opacity:.6;cursor:default}
.err{color:var(--bad);font-size:12.5px;margin:12px 0 0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px;font-size:11.5px}
.hide{display:none !important}
</style>
</head>
<body>
<div class="box">
  <div class="brand">
    <span class="logo"></span>
    <h1>InstaBox 保活面板</h1>
  </div>
  <p class="sub" id="sub">登录后管理机器保活</p>

  <div id="warn" class="warn hide"></div>

  <form id="f" autocomplete="on">
    <label class="field hide" id="user-field">
      <span>用户名</span>
      <input id="user" name="username" type="text" autocomplete="username" spellcheck="false">
    </label>
    <label class="field">
      <span id="pass-label">密码</span>
      <input id="pass" name="password" type="password" autocomplete="current-password" required>
    </label>
    <label class="remember"><input type="checkbox" id="remember"><span>记住我（7 天）</span></label>
    <button class="btn" id="submit" type="submit">登录</button>
    <p class="err hide" id="err"></p>
  </form>
</div>

<script>
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var next = q.get("next") || "/ui";

  function $(id) { return document.getElementById(id); }

  function showErr(msg) {
    var e = $("err");
    if (!msg) { e.className = "err hide"; e.textContent = ""; return; }
    e.textContent = msg;
    e.className = "err";
  }

  fetch("/api/authinfo", { cache: "no-store" }).then(function (r) {
    return r.json();
  }).then(function (j) {
    if (!j.enabled) {
      $("sub").textContent = "面板没有设置密码，现在是只读";
      $("warn").className = "warn";
      $("warn").innerHTML = "没配 <code>ADMIN_PASSWORD</code>，也没配 <code>TOKEN</code>：面板现在只读，能看但不能续租或改配置。" +
        "想恢复写就在 Worker 里加一个 <code>ADMIN_PASSWORD</code> Secret。";
      var a = document.createElement("a");
      a.className = "btn";
      a.href = "/ui";
      a.textContent = "进入面板";
      $("f").className = "hide";
      $("f").parentNode.appendChild(a);
      return;
    }
    if (j.needUser) {
      $("user-field").classList.remove("hide");
      $("user").value = j.user || "admin";
      $("user").focus();
    } else {
      $("pass-label").textContent = "访问令牌";
      $("pass").placeholder = "粘贴 TOKEN";
      $("pass").focus();
    }
  }).catch(function () {});

  $("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("submit");
    btn.disabled = true;
    btn.textContent = "登录中…";
    showErr("");
    fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("user").value,
        password: $("pass").value,
        remember: $("remember").checked,
        next: next
      })
    }).then(function (r) {
      return r.json().then(function (j) { return j; }).catch(function () {
        return { ok: false, error: "HTTP " + r.status };
      });
    }).then(function (j) {
      btn.disabled = false;
      btn.textContent = "登录";
      if (j.ok) { location.replace(j.next || "/ui"); return; }
      showErr(j.error || "登录失败");
      $("pass").select();
    }).catch(function (e2) {
      btn.disabled = false;
      btn.textContent = "登录";
      showErr("请求失败：" + e2.message);
    });
  });
})();
</script>
</body>
</html>
`;
