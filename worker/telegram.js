// Telegram 机器人：在手机上开关 InstaBox 沙箱机器。
//
// 走 webhook，跟保活共用同一个 Worker（不需要额外机器、不需要常驻进程）：
//   POST /tg/<TELEGRAM_WEBHOOK_SECRET>      Telegram 把更新推到这里
//   GET  /api/telegram?action=set&token=…   一次性注册 webhook（用面板密码或 TOKEN 认证）
//   GET  /api/telegram?action=info&token=…  看 webhook 现状（调试用）
//
// 变量：
//   TELEGRAM_BOT_TOKEN        Secret，@BotFather 拿的 token
//   TELEGRAM_CHAT_ID          Text，允许操作的 chat id，逗号分隔多个；不填则只回显 id 不做操作
//   TELEGRAM_WEBHOOK_SECRET   Secret，webhook 路径里的随机串，同时用作 Telegram 的
//                             secret_token 头校验（setWebhook 时自动带上）
//
// 为什么「关闭」要顺带改保活：本仓库的 cron 每 5 分钟续一次租约，撞上
// 409 machine_not_running 就会自动 resume/start。光把机器 suspend 掉，几分钟后
// 又被保活叫醒了。所以关机的动作是「写进 CONFIG 的 skip 名单 → 再 suspend/stop」，
// 唤醒时再把 skip 摘掉。skip 是白名单之外的一层，不影响 mode=all 的账号，
// 也不会让以后新建的机器失去保活。
//
// 命令（括号里是别名）：
//   /ls (/list /status)   机器列表，点按钮进单机面板
//   /wake <机器>          唤醒（resume，失败退 start）+ 续租 + 打开保活
//   /sleep <机器>         休眠（suspend，保留内存）+ 释放租约 + 关掉保活
//   /stop <机器>          关机（stop，冷启动才回来）+ 释放租约 + 关掉保活
//   /renew <机器>         手动续一次租约
//   /release <机器>       放掉租约
//   /keep <机器> on|off   只切保活开关，不动机器
//   /pause on|off         全局暂停/恢复 cron 保活
//   /id                   看这个聊天的 id（配置 TELEGRAM_CHAT_ID 用）
//   /help                 帮助
//
// 机器参数可以写名字（qqq）或 id（m_xxx）；同名多台会一起操作。

const TG_API = "https://api.telegram.org";
const PAGE_SIZE = 6;
// Telegram 对 callback_data 限 64 字节，我们的格式是 a:act:acct:id，够用
const CB_LIMIT = 64;
// 机器人里唤醒只等这么久（次数 × 秒）。Telegram 的 webhook 要 60 秒内回包，
// 等太久会被它重投；剩下的交给 cron 补（唤醒时已经先把 skip 摘掉了）
const WAKE_TRIES_BOT = 4;
const WAKE_GAP_BOT = 3;

// 生效的配置：KV（面板里填的）优先，环境变量兜底。
// conf 是 worker.js 的 normalizeConfig 结果；不传就纯看环境变量（老行为）。
export function tgConfig(env, conf) {
  const t = (conf && conf.telegram) || {};
  const envToken = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const envSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const envChats = String(env.TELEGRAM_CHAT_ID || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const kvChats = Array.isArray(t.chats) ? t.chats : [];
  return {
    token: String(t.token || envToken).trim(),
    secret: String(t.secret || envSecret).trim(),
    chats: kvChats.length ? kvChats : envChats,
    // 每个字段各自的来源，面板要照着这个提示「现在用的是变量还是网页里填的」
    src: {
      token: t.token ? "kv" : envToken ? "env" : "",
      secret: t.secret ? "kv" : envSecret ? "env" : "",
      chats: kvChats.length ? "kv" : envChats.length ? "env" : "",
    },
  };
}

// 面板要看的配置快照：一律打码，明文 token 绝不出 Worker
const maskTg = (s) => (!s ? "" : s.length <= 10 ? "****" : `${s.slice(0, 4)}…${s.slice(-4)}`);

export function tgView(conf, canSave) {
  return {
    configured: !!conf.token,
    tokenMasked: maskTg(conf.token),
    secretMasked: maskTg(conf.secret),
    chats: conf.chats,
    src: conf.src,
    canSave: !!canSave,
  };
}

async function tgApi(token, method, payload = {}) {
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { ok: res.ok && json?.ok === true, status: res.status, json };
  } catch (e) {
    return { ok: false, status: 0, json: { description: String(e.message || e) } };
  }
}

// ---- 文本小工具 ---------------------------------------------------------------

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// 官方状态值（docs/api/machines）：creating / starting / running / stopping / stopped /
// suspending / suspended / resuming / deleting / error
const STATE_ICON = {
  running: "🟢",
  starting: "🔵",
  resuming: "🔵",
  creating: "🔵",
  suspended: "🟡",
  suspending: "🟡",
  stopped: "⚫",
  stopping: "⚫",
  deleting: "⚫",
  error: "🔴",
};

const STATE_TEXT = {
  running: "运行中",
  starting: "启动中",
  resuming: "唤醒中",
  creating: "创建中",
  suspended: "已休眠",
  suspending: "休眠中",
  stopped: "已关机",
  stopping: "关机中",
  deleting: "删除中",
  error: "异常",
};

const icon = (state) => STATE_ICON[String(state || "").toLowerCase()] || "⚪";
const stateText = (state) => STATE_TEXT[String(state || "").toLowerCase()] || (state ? String(state) : "未知");

// 租约剩余时间：给个「还有多久到期」的人话版本，过期/没有都返回空串
function left(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "已过期";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m${s % 60}s`;
}

// 秒数说人话：冷却 5-20 分钟，免费版连着 max-run 能到 2 小时
function secs(n) {
  const s = Math.max(0, Math.round(Number(n) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}`;
}

// "08:00" / "8:00" / "0800" → 当天第几分钟；不合法返回 -1
function parseClock(s) {
  const m = /^(\d{1,2})[:：]?(\d{2})$/.exec(String(s || "").trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h > 23 || mi > 59 ? -1 : h * 60 + mi;
}

// "/window" 后面的时间段 + 可选上限：
//   "09:00-12:00"                        → 一段
//   "09:00-12:00,14:00-18:00"            → 两段（逗号/顿号/空格都认）
//   "09:00-12:00 14:00-18:00 120"        → 两段 + 上限 120
// 末尾纯数字当上限，不会被当成时间；解析不了返回 null（调用方报用法）。
function parseWindowSpec(s) {
  let rest = String(s || "").trim();
  if (!rest) return null;
  let maxMin;
  const tail = /(?:\s+|^)(?:max|上限)?\s*(\d{1,4})$/.exec(rest);
  if (tail) {
    maxMin = Number(tail[1]);
    rest = rest.slice(0, tail.index).trim();
  }
  if (!rest) return null;
  const chunks = rest.split(/[,，、;；\s]+/).filter(Boolean);
  const ranges = [];
  for (const c of chunks) {
    const m = /^(\d{1,2}[:：]?\d{2})\s*[-–—~至到]\s*(\d{1,2}[:：]?\d{2})$/.exec(c);
    if (!m) return null;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    if (start < 0 || end < 0) return null;
    ranges.push({ start, end });
  }
  if (!ranges.length || ranges.length > 8) return null;
  return { ranges, maxMin };
}

// 按钮文字有长度上限，机器名太长就截断（id 留在详情页）
const short = (s, n = 16) => {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const cb = (data) => String(data).slice(0, CB_LIMIT);

// ---- 视图 ---------------------------------------------------------------------

function headerLines(snap) {
  const total = snap.machines.length;
  const kept = snap.machines.filter((m) => m.selected).length;
  const lines = [`<b>InstaBox</b> · ${snap.accounts.length} 个账号 · ${total} 台机器`];
  lines.push(snap.paused ? "保活：⏸ 已全局暂停" : `保活：✅ 开着（${kept} 台在保）`);

  // 保活区间：开着就显示时段 + 当前在不在里面，一眼看出「为什么没在续租」
  const w = snap.window;
  if (w) {
    const wl = windowShort(w);
    if (!w.on) lines.push(`区间：全天${w.maxMin ? `（单次上限 ${w.maxMin} 分钟）` : ""}`);
    else if (w.phase === "idle") lines.push(`区间：${wl} · ⏸ 现在区间外（${w.nowAt}）`);
    else if (w.phase === "capped") lines.push(`区间：${wl} · ⏸ 本轮已到 ${w.maxMin} 分钟上限`);
    else lines.push(`区间：${wl} · ▶ 区间内${w.maxMin ? `（已 ${w.keptMin}/${w.maxMin} 分钟）` : ""}`);
  }
  if (!snap.canSave) lines.push("⚠️ 没绑 CONFIG KV：保活开关存不下来");
  for (const w of (snap.warnings || []).filter((x) => x && x.error).slice(0, 3)) {
    lines.push(`⚠️${w.account ? ` #${w.account}` : ""} ${esc(w.error)}`);
  }
  return lines;
}

function overview(snap, page) {
  const rows = snap.machines;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const slice = rows.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const lines = headerLines(snap);
  lines.push("");
  if (!rows.length) {
    lines.push("（名下还没有机器：先用 instabox create 建一台）");
  }
  for (const r of slice) {
    const bits = [`${icon(r.state)} <b>${esc(r.name || r.id)}</b> — ${stateText(r.state)}`];
    const rest = left(r.expiresAt);
    if (rest) bits.push(`租约 ${rest}`);
    if (!r.selected) bits.push("保活关");
    if (r.window && !r.window.inherited) {
      bits.push(`区间 ${windowShort(r.window)}${r.window.maxMin ? ` · ≤${r.window.maxMin}分` : ""}`);
    }
    // 冷却中：这时候点唤醒是叫不醒的，先在列表里标出来
    if (r.cooldownUntil && new Date(r.cooldownUntil).getTime() > Date.now()) bits.push(`⏳ 冷却 ${left(r.cooldownUntil)}`);
    lines.push(bits.join(" · "));
  }
  if (pages > 1) lines.push(`\n第 ${p + 1}/${pages} 页`);

  // 每行两台：以前一台一行，机器一多就占满屏幕，翻页还慢
  const kb = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [{ text: `${icon(slice[i].state)} ${short(slice[i].name || slice[i].id)}`, callback_data: cb(`d:${slice[i].account}:${slice[i].id}`) }];
    if (slice[i + 1]) {
      row.push({ text: `${icon(slice[i + 1].state)} ${short(slice[i + 1].name || slice[i + 1].id)}`, callback_data: cb(`d:${slice[i + 1].account}:${slice[i + 1].id}`) });
    }
    kb.push(row);
  }
  const nav = [];
  if (pages > 1) {
    if (p > 0) nav.push({ text: "◀", callback_data: cb(`l:${p - 1}`) });
    nav.push({ text: "🔄 刷新", callback_data: cb(`l:${p}`) });
    if (p < pages - 1) nav.push({ text: "▶", callback_data: cb(`l:${p + 1}`) });
  } else {
    nav.push({ text: "🔄 刷新", callback_data: cb("l:0") });
  }
  kb.push(nav);
  // 底部两个常驻入口：区间设置 + 全局暂停。以前「暂停」独占一行，白占高度
  const wl = windowShort(snap.window);
  kb.push([
    { text: `⏰ 区间 ${wl}`, callback_data: "w:menu" },
    { text: snap.paused ? "▶ 恢复保活" : "⏸ 暂停保活", callback_data: snap.paused ? "p:off" : "p:on" },
  ]);

  return { text: lines.join("\n"), keyboard: { inline_keyboard: kb } };
}

// ---- 保活区间面板 -------------------------------------------------------------

// 列表里用的短标签：多段写「3 段」，单段写时间，避免一行被撑爆
function windowShort(w) {
  if (!w || !w.on) return "全天";
  const segs = Array.isArray(w.ranges) ? w.ranges : [];
  if (segs.length > 1) return `${segs.length} 段`;
  return segs[0] ? `${segs[0].startAt}–${segs[0].endAt}` : "全天";
}

function windowText(w) {
  if (w.error) return `⚠️ ${esc(w.error)}`;
  const isMachine = w.scope === "machine";
  const lines = [isMachine ? `<b>⏰ ${esc(w.name || w.id)} 的保活区间</b>` : "<b>⏰ 默认保活区间</b>"];
  if (isMachine) {
    lines.push(w.inherited ? "当前：跟随默认区间" : "当前：这台机器单独设置");
  }
  const segs = Array.isArray(w.ranges) ? w.ranges : [];
  if (!w.on) {
    lines.push("时间段：关（全天保活）");
  } else if (segs.length <= 1) {
    lines.push(`时间段：${segs[0] ? `${segs[0].startAt} – ${segs[0].endAt}` : "全天"}`);
  } else {
    lines.push(`时间段（${segs.length} 段）：`);
    segs.forEach((r, i) => lines.push(`  ${i + 1}. ${r.startAt} – ${r.endAt}`));
  }
  lines.push(`单次上限：${w.maxMin ? `${w.maxMin} 分钟` : "不限"}`);
  lines.push("");
  if (w.phase === "idle") {
    lines.push(`⏸ 现在不在区间内（北京时间 ${w.nowAt}）`);
    lines.push("cron 不会续租，机器会按平台规则自然休眠。");
  } else if (w.phase === "capped") {
    lines.push(`⏸ 本轮已保活 ${w.keptMin} 分钟，到 ${w.maxMin} 分钟上限了`);
    lines.push("等下一段开始会自动重新计时。");
  } else {
    lines.push(`▶ 正在保活（北京时间 ${w.nowAt}${w.startedAt ? `，本轮已 ${w.keptMin} 分钟` : ""}）`);
  }
  lines.push("");
  lines.push("时间段按<b>北京时间（UTC+8）</b>算，跨午夜可以写 22:00-06:00。");
  lines.push("多段用逗号隔开；区间外会主动放掉租约，机器随即休眠。手动 /wake 不受区间限制。");
  const example = isMachine
    ? `/window ${w.name || w.id} 09:00-12:00,14:00-18:00 90`
    : "/window 09:00-12:00,14:00-18:00 90";
  lines.push("");
  lines.push("✍️ 任意时段 + 上限：");
  lines.push(`<code>${esc(example)}</code>`);
  lines.push("直接发这条命令即可；下方按钮可以按段增删。");
  return lines.join("\n");
}

function windowKeyboard(w, target = null) {
  // 机器级回调要带 account:id；默认区间保持旧协议 w:*，兼容已发出的旧消息。
  const tag = target
    ? `m:${target.account}:${encodeURIComponent(String(target.id))}`
    : "d";
  const cbk = (action, ...args) => cb(["w", tag, action, ...args].join(":"));
  const kb = [];
  kb.push([
    w.on
      ? { text: "🔕 关掉时间段（改成全天）", callback_data: cbk("off") }
      : { text: "🔔 打开时间段", callback_data: cbk("on") },
  ]);

  const segs = Array.isArray(w.ranges) ? w.ranges : [];
  // 每段一个删除按钮，两个一行；编号和正文里的列表一一对应
  if (w.on && segs.length) {
    for (let i = 0; i < segs.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, segs.length); j++) {
        row.push({ text: `🗑 删 ${j + 1}`, callback_data: cbk("del", j) });
      }
      kb.push(row);
    }
  }
  // 常用段直接追加，不覆盖已有的（想整体替换用 /window 命令）
  if (segs.length < 8) {
    kb.push([
      { text: "＋ 09:00–12:00", callback_data: cbk("add", 540, 720) },
      { text: "＋ 14:00–18:00", callback_data: cbk("add", 840, 1080) },
    ]);
    kb.push([
      { text: "＋ 22:00–06:00", callback_data: cbk("add", 1320, 360) },
      { text: "＋ 全天", callback_data: cbk("add", 0, 0) },
    ]);
  }
  kb.push([
    { text: "上限 2h", callback_data: cbk("max", 120) },
    { text: "上限 4h", callback_data: cbk("max", 240) },
    { text: "不限", callback_data: cbk("max", 0) },
  ]);
  kb.push([{ text: "✍️ 任意时段", callback_data: cbk("custom") }]);
  if (target) {
    kb.push([{ text: "↩ 恢复跟随默认区间", callback_data: cbk("reset") }]);
    kb.push([
      { text: "↩ 机器详情", callback_data: cb(`d:${target.account}:${target.id}`) },
      { text: "📋 机器列表", callback_data: "l:0" },
    ]);
  } else {
    kb.push([{ text: "↩ 返回机器列表", callback_data: "l:0" }]);
  }
  return { inline_keyboard: kb };
}

function detail(row) {
  const lines = [
    `<b>${esc(row.name || row.id)}</b>`,
    `账号 #${row.account} · <code>${esc(row.id)}</code>`,
    `状态：${icon(row.state)} ${stateText(row.state)}`,
    row.expiresAt ? `租约：${left(row.expiresAt)} 后到期` : "租约：无",
    `保活：${row.selected ? "✅ 开" : "🔕 关"}`,
    `区间：${row.window ? row.window.label : "跟随默认"}${row.window && row.window.inherited ? "（默认）" : ""}`,
  ];
  // 冷却中：平台在让机器休息（max-run 到点或安全审查锁住），这时候叫也叫不醒，
  // 提前写出来，省得用户反复点「唤醒」以为坏了。cooldownReason 是 abuse_* 时
  // 是安全审查锁（最长 24 小时），和 max-run 冷却不是一回事，文案要分开。
  const cool = row.cooldownUntil ? left(row.cooldownUntil) : "";
  if (cool && cool !== "已过期") {
    const abuse = /^abuse_/.test(row.cooldownReason || "");
    lines.push(
      abuse
        ? `🔒 安全审查锁：还要 ${cool} 才能唤醒（最长 24 小时，平台限制）`
        : `⏳ 冷却：还要 ${cool} 才能唤醒（max-run 到点，平台限制）`,
    );
  }
  if (Number.isFinite(row.maxRunMinutes) && row.maxRunMinutes > 0) {
    const started = Date.parse(row.runStartedAt || "");
    const endMs = started ? started + row.maxRunMinutes * 60000 : 0;
    const rest = endMs > Date.now() ? left(new Date(endMs).toISOString()) : "";
    lines.push(`最长运行：${row.maxRunMinutes} 分钟${rest ? `（本轮还剩 ${rest}）` : ""}`);
  }
  const kb = {
    inline_keyboard: [
      [
        { text: "▶ 唤醒", callback_data: cb(`a:wake:${row.account}:${row.id}`) },
        { text: "⏸ 休眠", callback_data: cb(`a:sleep:${row.account}:${row.id}`) },
      ],
      [
        { text: "⏹ 关机", callback_data: cb(`a:stop:${row.account}:${row.id}`) },
        { text: "🔄 续租", callback_data: cb(`a:renew:${row.account}:${row.id}`) },
      ],
      [
        {
          text: row.selected ? "🔕 关掉保活" : "🔔 打开保活",
          callback_data: cb(`a:keep${row.selected ? "off" : "on"}:${row.account}:${row.id}`),
        },
        { text: "🗑 放租约", callback_data: cb(`a:release:${row.account}:${row.id}`) },
      ],
      [{ text: "⏰ 这台机器的区间", callback_data: cb(`w:m:${row.account}:${encodeURIComponent(String(row.id))}`) }],
      [{ text: "↩ 返回列表", callback_data: cb("l:0") }],
    ],
  };
  return { text: lines.join("\n"), keyboard: kb };
}

// ---- 保活开关（CONFIG 的 skip 名单）-------------------------------------------
// 只由机器人写 skip 时，账号条目仍要跟随环境变量的机器筛选。
const tgBlankAccountConfig = () => ({
  enabled: true,
  mode: "all",
  machines: [],
  skip: [],
  inheritSelection: true,
  windows: {},
});

// 设置某台机器的“实际保活选中态”。
// - 打开：从 skip 移除；若账号是 list 模式且机器不在白名单，则加入白名单
// - 关闭：加入 skip；list 模式下同时从白名单移除
// 这样 /keep、详情页按钮、Web API 回读的不是两套互相矛盾的状态。
async function setKeepEnabled(tg, c, account, id, enabled, machineName = "") {
  if (!c.cfgKv) {
    return { ok: false, error: "没绑 CONFIG KV，保活开关存不下来（cron 下一轮可能把机器叫醒）" };
  }
  const { conf, error } = await tg.loadConfig(c);
  if (error) return { ok: false, error };
  const key = String(account);
  const isNew = !conf.accounts[key];
  const prev = conf.accounts[key] || tgBlankAccountConfig();
  const skip = new Set(Array.isArray(prev.skip) ? prev.skip : []);
  let mode = prev.mode === "list" ? "list" : "all";
  let machines = Array.isArray(prev.machines) ? [...prev.machines] : [];
  let inheritSelection = prev.inheritSelection === true;

  if (enabled) {
    skip.delete(id);
    // 账号级停用优先于单机开关；打开机器必须同时恢复账号，否则回执成功但 cron 仍跳过。
    if (prev.enabled === false) prev.enabled = true;
    const acc = c.accounts.find((x) => x.account === Number(account));
    const envPicked = Array.isArray(acc?.machine) ? acc.machine : [];
    const coveredByEnv =
      !envPicked.length || envPicked.includes(id) || (machineName && envPicked.includes(machineName));
    if (inheritSelection && !coveredByEnv) {
      // 环境变量已排除这台机器：把当前 env 白名单和本机物化成 list，避免“打开”是空操作。
      mode = "list";
      machines = [...new Set([...envPicked.filter((x) => x && x !== "all" && x !== "*"), id])];
      inheritSelection = false;
    } else if (mode === "list" && !machines.includes(id)) {
      machines.push(id);
    }
  } else {
    skip.add(id);
    if (mode === "list") machines = machines.filter((x) => x !== id);
  }

  const next = { ...prev, mode, machines, skip: [...skip], inheritSelection };
  if (isNew) next.inheritSelection = inheritSelection;
  conf.accounts[key] = next;
  await tg.saveConfig(c, conf);
  return { ok: true };
}

// 保留旧名字，避免漏掉已有调用点；语义与 setKeepEnabled 完全一致。
async function setSkip(tg, c, account, id, skip, machineName = "") {
  return setKeepEnabled(tg, c, account, id, !skip, machineName);
}

async function setPaused(tg, c, paused) {
  if (!c.cfgKv) return { ok: false, error: "没绑 CONFIG KV，暂停状态存不下来" };
  const { conf, error } = await tg.loadConfig(c);
  if (error) return { ok: false, error };
  conf.paused = paused;
  await tg.saveConfig(c, conf);
  return { ok: true };
}

// ---- 动作 ---------------------------------------------------------------------

const accOf = (c, n) => c.accounts.find((a) => a.account === Number(n)) || null;

async function wakeMachine(tg, c, acc, id, name) {
  // 先把保活摘回来：否则 cron 那头还当我们不要它，醒来又被挂起
  const sk = await setSkip(tg, c, acc.account, id, false, name);
  const fast = { ...acc, wakeTries: WAKE_TRIES_BOT, wakeGap: WAKE_GAP_BOT };
  const out = await tg.wakeThenLease(fast, { id, name });
  const note = sk.ok ? "" : `\n⚠️ 保活没打开：${esc(sk.error)}`;

  // 冷却中：平台在让机器休息（max-run 到点，或安全审查锁住），叫也叫不醒
  if (out.cooling) {
    return `⏳ <b>${esc(name)}</b> 正在冷却，约 ${secs(out.cooling)}后才能唤醒。\n这是平台限制（连续运行到上限或安全审查），不是故障，等它自己结束就好。${note}`;
  }
  if (out.ok) {
    const cold = (out.wake || []).some((w) => String(w).startsWith("start:"));
    return `✅ <b>${esc(name)}</b> 已${cold ? "冷启动" : "唤醒"}，租约 ${left(out.expiresAt) || "已续"}${note}`;
  }
  return `⚠️ 已发出唤醒，机器还没到 running：${esc(out.error || "未知原因")}\n等一会儿点刷新看看。${note}`;
}

async function shutMachine(tg, c, acc, id, name, mode) {
  const verb = mode === "suspend" ? "休眠" : "关机";

  // 先看一眼现状。官方明确写了「A paused machine cannot be stopped; resume or delete it」，
  // 对着休眠中的机器发 stop 只会拿到 409 —— 与其让用户以为按钮坏了，不如把两条路说清楚。
  const cur = await tg.call(acc, "GET", `/v1/machines/${encodeURIComponent(id)}`);
  const st = String(cur.json?.state || "").toLowerCase();
  if (mode === "stop" && (st === "suspended" || st === "suspending")) {
    return [
      `⚠️ <b>${esc(name)}</b> 现在是休眠状态，平台不允许直接关停休眠中的机器。`,
      `· 想省资源、保持现状 → /sleep（内存还在，唤醒是秒级的）`,
      `· 一定要彻底关机 → 先 /wake 再 /stop`,
    ].join("\n");
  }

  // 顺序很重要：先关保活，再动机器。反过来的话 cron 可能正好在两件事中间
  // 看到机器被挂起，一路 resume 回来，看起来像「关了又自己开了」。
  const sk = await setSkip(tg, c, acc.account, id, true, name);
  const note = sk.ok ? "" : `\n⚠️ 保活没关掉（cron 可能会把它叫醒）：${esc(sk.error)}`;

  const already = mode === "suspend" ? st === "suspended" || st === "stopped" : st === "stopped";
  if (!already) {
    const r = await tg.act(acc, id, mode);
    if (!r.ok) {
      // 并发场景：平台刚自己把它挂起了，或者另一个操作在跑。查一次再决定要不要报错
      const now = await tg.call(acc, "GET", `/v1/machines/${encodeURIComponent(id)}`);
      const s2 = String(now.json?.state || "").toLowerCase();
      const ok2 = mode === "suspend" ? s2 === "suspended" || s2 === "stopped" : s2 === "stopped";
      if (!ok2) return `⚠️ ${verb}失败：HTTP ${r.status} ${esc((r.text || "").slice(0, 140))}${note}`;
    } else if (typeof r.json?.id === "string" && r.json.id.startsWith("op_")) {
      // 生命周期调用返回 operation：等它跑完再说「已休眠」，别抢在平台前面下结论
      const w = await tg.waitOp(acc, r.json.id, 8000);
      if (!w.ok && !w.timedOut) return `⚠️ ${verb}失败：${esc(w.error)}${note}`;
    }
  }

  const del = await tg.call(
    acc,
    "DELETE",
    `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(acc.lease)}`,
  );
  await tg.clearLive(c, [{ account: acc.account, id, name }]);
  const done = mode === "suspend" ? "已休眠（内存还在，唤醒很快）" : "已关机（下次要冷启动）";
  const lease = del.ok || del.status === 404 ? "，租约已释放" : `（租约释放失败 HTTP ${del.status}）`;
  return `✅ <b>${esc(name)}</b> ${done}${lease}${note}`;
}

async function doAction(tg, c, action, account, id, name) {
  const acc = accOf(c, account);
  if (!acc) return `没有 ${account} 号账号`;
  // 名字拿不到（例如回调里只带了 id）就退回 id，别在消息里留空
  const label = name || id;

  switch (action) {
    case "wake":
      return wakeMachine(tg, c, acc, id, label);
    case "sleep":
      return shutMachine(tg, c, acc, id, label, "suspend");
    case "stop":
      return shutMachine(tg, c, acc, id, label, "stop");
    case "renew": {
      const r = await tg.lease(acc, id);
      if (!r.ok) return `⚠️ 续租失败：HTTP ${r.status} ${esc((r.text || "").slice(0, 140))}`;
      await tg.patchLive(c, acc.account, id, label, r.json?.expiresAt);
      return `✅ <b>${esc(label)}</b> 已续租，${left(r.json?.expiresAt) || "已续"}`;
    }
    case "release": {
      const r = await tg.call(
        acc,
        "DELETE",
        `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(acc.lease)}`,
      );
      if (!r.ok && r.status !== 404) return `⚠️ 释放失败：HTTP ${r.status} ${esc((r.text || "").slice(0, 140))}`;
      await tg.clearLive(c, [{ account: acc.account, id, name: label }]);
      return `✅ <b>${esc(label)}</b> 租约已释放（到点就会空闲休眠）`;
    }
    case "keepon": {
      const r = await setSkip(tg, c, acc.account, id, false, label);
      return r.ok ? `✅ <b>${esc(label)}</b> 保活已打开` : `⚠️ ${esc(r.error)}`;
    }
    case "keepoff": {
      const r = await setSkip(tg, c, acc.account, id, true, label);
      return r.ok ? `✅ <b>${esc(label)}</b> 保活已关掉（机器本身不动）` : `⚠️ ${esc(r.error)}`;
    }
    default:
      return `未知操作：${esc(action)}`;
  }
}

// 按名字或 id 找机器；同名多台全返回（多账号下常见）
function pickTargets(snap, wanted) {
  const w = String(wanted || "").trim();
  if (!w) return [];
  const low = w.toLowerCase();
  const byId = snap.machines.filter((m) => m.id === w);
  if (byId.length) return byId;
  return snap.machines.filter((m) => String(m.name || "").toLowerCase() === low);
}

// ---- 命令解析 -----------------------------------------------------------------

function parseCommand(text) {
  const t = String(text || "").trim();
  const m = /^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

const HELP = [
  "<b>InstaBox 机器管理</b>",
  "",
  "/ls — 机器列表（点机器进操作面板）",
  "/wake 名字 — 唤醒并续租",
  "/sleep 名字 — 休眠（保留内存，唤醒快）",
  "/stop 名字 — 关机（下次冷启动）",
  "/renew 名字 — 手动续一次租约",
  "/release 名字 — 放掉租约",
  "/keep 名字 on|off — 只切保活，不动机器",
  "/window — 默认保活区间（时间段 + 单次上限）",
  "/window 09:00-12:00,14:00-18:00 90 — 多段 + 上限",
  "/window 机器名 09:15-17:45 90 — 只给这台机器设",
  "/pause on|off — 全局暂停/恢复保活",
  "/id — 看本聊天 id",
  "",
  "休眠和关机会顺带关掉这台的保活，否则 cron 几分钟后又会把它叫醒。",
  "机器名也可以写 id（m_xxx）。",
].join("\n");

// 输入框旁边那个命令菜单（Telegram 的 setMyCommands）。顺序就是展示顺序。
const BOT_COMMANDS = [
  { command: "ls", description: "机器列表 / 操作面板" },
  { command: "wake", description: "唤醒机器并续租" },
  { command: "sleep", description: "休眠机器（保留内存）" },
  { command: "stop", description: "关机（下次冷启动）" },
  { command: "window", description: "自定义时段/上限（默认或指定机器）" },
  { command: "keep", description: "开关某台机器的保活" },
  { command: "renew", description: "手动续一次租约" },
  { command: "pause", description: "全局暂停 / 恢复保活" },
  { command: "id", description: "查看本聊天 id" },
  { command: "help", description: "帮助" },
];

async function send(token, chatId, text, keyboard) {
  return tgApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

function findRow(snap, account, id) {
  return snap.machines.find((m) => m.account === Number(account) && m.id === id) || null;
}

// ---- 消息 / 回调处理 ----------------------------------------------------------

async function onMessage(conf, c, tg, message) {
  const chatId = message.chat?.id;
  if (chatId == null || message.from?.is_bot) return;
  const text = message.text || "";

  if (!conf.chats.length) {
    await send(
      conf.token,
      chatId,
      `机器人还没绑定聊天。\n把下面这个 id 填进 Worker 变量 <code>TELEGRAM_CHAT_ID</code>，再发一次消息：\n\n<code>${esc(chatId)}</code>`,
    );
    return;
  }
  if (!conf.chats.includes(String(chatId))) {
    await send(conf.token, chatId, `这个聊天（<code>${esc(chatId)}</code>）没在允许名单里。`);
    return;
  }

  const p = parseCommand(text);
  if (!p) {
    await send(conf.token, chatId, HELP);
    return;
  }

  if (p.cmd === "help" || p.cmd === "start") {
    await send(conf.token, chatId, HELP);
    return;
  }
  if (p.cmd === "id") {
    await send(conf.token, chatId, `chat id：<code>${esc(chatId)}</code>`);
    return;
  }

  if (p.cmd === "window" || p.cmd === "win" || p.cmd === "区间") {
    let target = null;
    let args = p.args.trim();
    let snap = null;

    // 第一个词是机器名/id 就进入单机区间；否则保持原来的全局默认命令。
    // reset 在单机模式下删除覆盖，在默认模式下把默认恢复为全天。
    if (args && !/^(on|off|开|关|打开|关闭|max|上限|reset|默认|恢复默认)\b/i.test(args) && !/^\d{1,2}[:：]?\d{2}\s*[-–—~至到]/.test(args)) {
      snap = await tg.state(c);
      const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
      const hits = m ? pickTargets(snap, m[1]) : [];
      if (!hits.length) {
        await send(conf.token, chatId, `找不到机器 ${esc(m ? m[1] : args)}。发 /ls 看看有哪些。`);
        return;
      }
      if (hits.length > 1) {
        await send(conf.token, chatId, `${esc(m[1])} 对应 ${hits.length} 台机器，请改发机器 id：\n` + hits.map((x) => `· #${x.account} <code>${esc(x.id)}</code>`).join("\n"));
        return;
      }
      target = { account: hits[0].account, id: hits[0].id, name: hits[0].name || hits[0].id };
      args = (m[2] || "").trim();
    }

    let patch = null;
    let reset = false;
    if (!args) {
      // 无参 = 看设置
    } else if (/^(reset|默认|恢复默认)$/i.test(args)) {
      if (target) reset = true;
      else patch = { on: false, ranges: [{ start: 0, end: 0 }], maxMin: 0 };
    } else if (/^(off|关|关掉|关闭)$/i.test(args)) {
      patch = { on: false };
    } else if (/^(on|开|打开)$/i.test(args)) {
      patch = { on: true };
    } else {
      const mx = /^(?:max|上限)\s*(\d{1,4})$/i.exec(args);
      if (mx) {
        const maxMin = Number(mx[1]);
        if (!Number.isInteger(maxMin) || maxMin < 0 || maxMin > 1440) {
          await send(conf.token, chatId, "单次上限必须在 <code>0-1440</code> 分钟之间，0 = 不限。");
          return;
        }
        patch = { maxMin };
      } else {
        // 支持多段：逗号/顿号/空格分隔，末尾可带上限
        const spec = parseWindowSpec(args);
        if (!spec) {
          await send(
            conf.token,
            chatId,
            [
              "用法：",
              "<code>/window</code> 看默认区间",
              "<code>/window 08:00-23:00</code> 设默认时间段并打开",
              "<code>/window 09:00-12:00,14:00-18:00</code> 设多段（逗号/空格分隔都行）",
              "<code>/window 09:15-17:45 90</code> 任意时段 + 单次上限 90 分钟",
              "<code>/window on</code> / <code>/window off</code> 开关默认时间段",
              "<code>/window max 180</code> 默认单次上限 180 分钟（0 = 不限）",
              "<code>/window 机器名</code> 看这台机器的区间",
              "<code>/window 机器名 09:00-12:00,14:00-18:00 90</code> 只给这台机器设多段",
              "<code>/window 机器名 max 120</code> 只改这台机器的上限",
              "<code>/window 机器名 reset</code> 恢复跟随默认",
            ].join("\n"),
          );
          return;
        }
        if (spec.maxMin !== undefined && (spec.maxMin < 0 || spec.maxMin > 1440)) {
          await send(conf.token, chatId, "单次上限必须在 <code>0-1440</code> 分钟之间，0 = 不限。");
          return;
        }
        patch = { on: true, ranges: spec.ranges };
        if (spec.maxMin !== undefined) patch.maxMin = spec.maxMin;
      }
    }

    if (patch || reset) {
      const r = await tg.patchWindow(c, patch, target, { reset });
      if (!r.ok) {
        await send(conf.token, chatId, `⚠️ ${esc(r.error)}`);
        return;
      }
    }
    const w = await tg.windowInfo(c, target);
    await send(conf.token, chatId, windowText(w), windowKeyboard(w, target));
    return;
  }

  if (p.cmd === "pause") {
    const want = /^(on|1|true|开|暂停)$/i.test(p.args);
    const off = /^(off|0|false|关|恢复)$/i.test(p.args);
    if (!want && !off) {
      await send(conf.token, chatId, "用法：/pause on 或 /pause off");
      return;
    }
    const r = await setPaused(tg, c, want);
    if (!r.ok) {
      await send(conf.token, chatId, `⚠️ ${esc(r.error)}`);
      return;
    }
    await send(conf.token, chatId, want ? "⏸ 已全局暂停保活（cron 不再续租，手动操作不受影响）" : "▶ 已恢复保活");
    return;
  }

  // 剩下的都要读机器列表
  const snap = await tg.state(c);

  if (p.cmd === "ls" || p.cmd === "list" || p.cmd === "status") {
    const v = overview(snap, 0);
    await send(conf.token, chatId, v.text, v.keyboard);
    return;
  }

  const acts = {
    wake: "wake",
    on: "wake",
    up: "wake",
    resume: "wake",
    sleep: "sleep",
    suspend: "sleep",
    stop: "stop",
    off: "stop",
    shutdown: "stop",
    renew: "renew",
    release: "release",
  };

  if (p.cmd === "keep") {
    const m = /^(\S+)\s+(on|off|开|关)$/i.exec(p.args);
    if (!m) {
      await send(conf.token, chatId, "用法：/keep 机器名 on|off");
      return;
    }
    const targets = pickTargets(snap, m[1]);
    if (!targets.length) {
      await send(conf.token, chatId, `找不到机器 ${esc(m[1])}`);
      return;
    }
    const on = /^(on|开)$/i.test(m[2]);
    const lines = [];
    for (const t of targets) lines.push(await doAction(tg, c, on ? "keepon" : "keepoff", t.account, t.id, t.name));
    await send(conf.token, chatId, lines.join("\n"));
    return;
  }

  const action = acts[p.cmd];
  if (!action) {
    await send(conf.token, chatId, HELP);
    return;
  }

  if (!p.args) {
    // 没给机器名 → 直接把列表甩过去，比报错有用
    const v = overview(snap, 0);
    await send(conf.token, chatId, `要操作哪台？点下面选，或者写 /${p.cmd} 机器名\n\n${v.text}`, v.keyboard);
    return;
  }

  const targets = pickTargets(snap, p.args);
  if (!targets.length) {
    await send(conf.token, chatId, `找不到机器 ${esc(p.args)}。发 /ls 看看有哪些。`);
    return;
  }
  const lines = [];
  for (const t of targets) lines.push(await doAction(tg, c, action, t.account, t.id, t.name));
  await send(conf.token, chatId, lines.join("\n"));
}

async function onCallback(conf, c, tg, query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = String(query.data || "");

  const answer = (text) => tgApi(conf.token, "answerCallbackQuery", { callback_query_id: query.id, text });

  if (chatId == null || !conf.chats.includes(String(chatId))) {
    await answer("没权限");
    return;
  }
  // 先应答，把按钮上的转圈停掉；后面慢活儿（唤醒要等十几秒）慢慢做
  await answer();

  const edit = async (text, keyboard) => {
    if (!messageId) return;
    await tgApi(conf.token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  };

  const parts = data.split(":");
  const kind = parts[0];

  if (kind === "l") {
    const snap = await tg.state(c);
    const v = overview(snap, parts[1]);
    await edit(v.text, v.keyboard);
    return;
  }

  if (kind === "w") {
    let target = null;
    let sub = "";
    // 新协议 d:on / d:pre:... ；机器协议 m:account:encodedId:on|pre|max|reset
    if (parts[1] === "d") {
      sub = parts[2] || "";
    } else if (parts[1] === "m") {
      const account = Number(parts[2]);
      // 回调查询来自外部输入，decodeURIComponent 遇到坏转义会抛异常；
      // Telegram 会重投失败的 update，这里先变成可控的「参数不对」。
      let id = "";
      try {
        id = decodeURIComponent(parts[3] || "");
      } catch {
        await edit("机器参数不对，发 /ls 重新打开。");
        return;
      }
      if (!Number.isSafeInteger(account) || !id) {
        await edit("机器参数不对，发 /ls 重新打开。");
        return;
      }
      target = { account, id };
      sub = parts[4] || "";
    } else {
      // 兼容旧消息：w:on / w:off / w:pre:s:e / w:max:n / w:menu
      sub = parts[1] || "menu";
    }

    const base = parts[1] === "d" ? 2 : parts[1] === "m" ? 4 : 1;
    let patch = null;
    let reset = false;
    if (sub === "on") patch = { on: true };
    else if (sub === "off") patch = { on: false };
    else if (sub === "pre") {
      const sMin = Number(parts[base + 1]);
      const eMin = Number(parts[base + 2]);
      if (!Number.isFinite(sMin) || !Number.isFinite(eMin)) {
        await edit("区间参数不对，重新打开面板再试。");
        return;
      }
      // 老消息里的预设按钮：整体替换成这一段（多段的增删走 add / del）
      patch = { on: true, ranges: [{ start: Math.max(0, Math.min(1439, sMin)), end: Math.max(0, Math.min(1439, eMin)) }] };
    } else if (sub === "add" || sub === "del") {
      const cur = await tg.windowInfo(c, target);
      if (cur.error) {
        await edit(`⚠️ ${esc(cur.error)}`);
        return;
      }
      const ranges = (cur.ranges || []).map((r) => ({ start: r.start, end: r.end }));
      if (sub === "add") {
        const sMin = Number(parts[base + 1]);
        const eMin = Number(parts[base + 2]);
        if (!Number.isInteger(sMin) || !Number.isInteger(eMin) || sMin < 0 || sMin > 1439 || eMin < 0 || eMin > 1439) {
          await edit("区间参数不对，重新打开面板再试。");
          return;
        }
        ranges.push({ start: sMin, end: eMin });
        patch = { on: true, ranges };
      } else {
        const idx = Number(parts[base + 1]);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ranges.length) {
          await edit("这一段已经不在了，重新打开面板。");
          return;
        }
        ranges.splice(idx, 1);
        // 删光了就退回默认一段（后端也会兜底，这里先保持语义清楚）
        patch = { ranges: ranges.length ? ranges : [{ start: 480, end: 1380 }] };
      }
    } else if (sub === "max") {
      const maxMin = Number(parts[base + 1]);
      if (!Number.isInteger(maxMin) || maxMin < 0 || maxMin > 1440) {
        await edit("上限参数必须是 0-1440 分钟，重新打开面板再试。");
        return;
      }
      patch = { maxMin };
    } else if (sub === "reset") {
      reset = true;
    }

    if (target && !target.name) {
      const snap = await tg.state(c);
      const row = findRow(snap, target.account, target.id);
      target.name = row?.name || target.id;
    }

    if (sub === "custom") {
      const usage = target
        ? `/window ${target.name || target.id} 09:15-17:45 90`
        : "/window 09:15-17:45 90";
      const subtitle = target ? `${esc(target.name || target.id)} 的` : "默认";
      const w = await tg.windowInfo(c, target);
      await edit(
        `<b>✍️ 自定义${subtitle}保活区间</b>\n\n` +
          `发送下面格式，时间和上限都可自由填写：\n<code>${esc(usage)}</code>\n\n` +
          "时间按北京时间，支持跨午夜；最后的分钟数可省略，省略时保留当前上限。",
        windowKeyboard(w, target),
      );
      return;
    }

    if (!patch && !reset) {
      // w:menu 或 w:d:menu —— 只是打开区间面板
      const w = await tg.windowInfo(c, target);
      await edit(windowText(w), windowKeyboard(w, target));
      return;
    }

    const r = await tg.patchWindow(c, patch, target, { reset });
    // target 在默认区间分支为 null；machine 分支由回调参数构造，不能引用未定义变量。
    const w = await tg.windowInfo(c, target);
    const head = r.ok ? "" : `⚠️ ${esc(r.error)}\n\n`;
    await edit(head + windowText(w), windowKeyboard(w, target));
    return;
  }

  if (kind === "p") {
    const on = parts[1] === "on";
    const r = await setPaused(tg, c, on);
    const snap = await tg.state(c);
    const v = overview(snap, 0);
    const head = r.ok
      ? on
        ? "⏸ 已全局暂停保活\n\n"
        : "▶ 已恢复保活\n\n"
      : `⚠️ ${esc(r.error)}\n\n`;
    await edit(head + v.text, v.keyboard);
    return;
  }

  if (kind === "d") {
    const snap = await tg.state(c);
    const row = findRow(snap, parts[1], parts[2]);
    if (!row) {
      await edit("这台机器已经不在列表里了，发 /ls 刷新。");
      return;
    }
    const v = detail(row);
    await edit(v.text, v.keyboard);
    return;
  }

  if (kind === "a") {
    const [, action, account, ...rest] = parts;
    const id = rest.join(":");
    // 回调里只带了 id，先捞一次状态拿到机器名，消息里才不会显示成 m_xxx
    const pre = await tg.state(c);
    const known = findRow(pre, account, id);
    const line = await doAction(tg, c, action, account, id, known?.name);
    // 操作完重新拉一次状态，面板上的状态/租约/保活才是新的
    const snap = await tg.state(c);
    const row = findRow(snap, account, id);
    if (row) {
      const v = detail(row);
      await edit(`${line}\n\n${v.text}`, v.keyboard);
    } else {
      await edit(line);
    }
  }
}

// ---- 入口 ---------------------------------------------------------------------

export async function handleTelegram(request, env, c, tg, url) {
  // 面板里配的优先（存在 CONFIG KV），没配才看环境变量。
  // 每条 update 多读一次 KV：免费额度 10 万读/天，正常用量差着三个数量级。
  let conf = tgConfig(env);
  if (c && c.cfgKv) {
    try {
      const out = await tg.loadConfig(c);
      if (out && !out.error) conf = tgConfig(env, out.conf);
    } catch {}
  }
  if (!conf.token) return new Response("telegram bot 没配（TELEGRAM_BOT_TOKEN）", { status: 503 });

  const route = url.pathname.replace(/\/+$/, "") || "/";
  const given = route.replace(/^\/tg\/?/, "");

  // 路径里的随机串 + Telegram 的 secret_token 头，两道都过才算 Telegram 发来的。
  // 光靠 chat id 不够：别人拿到 webhook 地址就能伪造 update。
  if (conf.secret) {
    const hdr = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (given !== conf.secret || hdr !== conf.secret) return new Response("forbidden", { status: 403 });
  } else if (given) {
    return new Response("forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("ok", { status: 200 });

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 永远回 200：非 2xx 会让 Telegram 反复重投同一条更新，操作就被执行多次了
  try {
    if (update.callback_query) await onCallback(conf, c, tg, update.callback_query);
    else if (update.message) await onMessage(conf, c, tg, update.message);
  } catch (e) {
    console.log("instabox-telegram: 处理更新失败", e.message);
  }
  return new Response("ok", { status: 200 });
}

// 注册/查看 webhook。conf 是 worker.js 已经算好的生效配置（KV 优先、变量兜底）。
export async function telegramAdmin(env, url, conf = tgConfig(env)) {
  if (!conf.token) return { ok: false, error: "没配 bot token：在面板里填，或设 TELEGRAM_BOT_TOKEN（Secret）" };

  const action = (url.searchParams.get("action") || "info").toLowerCase();
  const hookPath = conf.secret ? `/tg/${conf.secret}` : "/tg";

  if (action === "set") {
    const payload = {
      url: url.origin + hookPath,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    };
    if (conf.secret) payload.secret_token = conf.secret;
    const r = await tgApi(conf.token, "setWebhook", payload);
    // 顺手把命令菜单注册上：漏了这一步，输入框旁边就没有那个命令列表
    const menu = await tgApi(conf.token, "setMyCommands", { commands: BOT_COMMANDS });
    return {
      ok: r.ok,
      action: "setWebhook",
      url: payload.url,
      allowedChats: conf.chats,
      commands: menu.ok ? BOT_COMMANDS.length : `注册失败：${menu.json?.description || menu.status}`,
      error: r.ok ? undefined : r.json?.description || `HTTP ${r.status}`,
      telegram: r.json,
    };
  }

  if (action === "menu") {
    const r = await tgApi(conf.token, "setMyCommands", { commands: BOT_COMMANDS });
    return {
      ok: r.ok,
      action: "setMyCommands",
      count: r.ok ? BOT_COMMANDS.length : 0,
      error: r.ok ? undefined : r.json?.description || `HTTP ${r.status}`,
      telegram: r.json,
    };
  }

  const r = await tgApi(conf.token, "getWebhookInfo", {});
  return { ok: r.ok, action: "getWebhookInfo", allowedChats: conf.chats, telegram: r.json };
}
