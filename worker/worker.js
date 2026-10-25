// InstaBox keepalive on Cloudflare Workers — renews activity leases from a cron
// trigger, so no machine of your own has to stay up doing it.
//
// 现在带一个网页管理面板：
//   浏览器打开 https://<worker>/ui?token=<TOKEN>     （直接打开 / 也会进面板）
//   面板里能看每台机器的状态、逐台开关保活、手动续租/唤醒/释放、暂停全部保活。
//   开关状态存在 KV（绑定名 CONFIG）；没绑也能用，只是改动不保存（面板会提示只读）。
//
// 单账号：只设 INSTABOX_API_KEY，可选 INSTABOX_MACHINE 指定机器。
// 多账号：第 N 个账号的变量名 = 单账号变量名 + _N，加一个账号就多加一个 Secret：
//
//   INSTABOX_API_KEY      1 号账号的 key（也可以写成 INSTABOX_API_KEY_1）
//   INSTABOX_API_KEY_2    2 号账号的 key
//   INSTABOX_API_KEY_3    3 号账号的 key ……
//
// 每个账号还可以单独覆盖 INSTABOX_MACHINE_2 / INSTABOX_LEASE_2 /
// INSTABOX_LEASE_TTL_2 / INSTABOX_AUTO_RESUME_2；不写就继承不带后缀的全局值。
// 同一把 key 配多次只续一次；编号可以不连续（只配 _2 也行）。
//
//   GET  /                    浏览器（Accept: text/html）进面板；其它客户端续租一次
//   GET  /ui                  面板（不需要 token，页面自己会要）
//   GET  /status              所有账号的机器状态
//   GET  /accounts            当前认到了哪些账号（key 打码）
//   GET  /log                 最近 48 条保活日志（需要 KV 绑定 LOG）
//   GET  /release             放掉租约
//   GET  /api/state           面板用的全量快照（账号 + 机器 + 配置 + 最近续租）
//   POST /api/config          改配置：{ paused?, accounts: { "2": { enabled, mode, machines } } }
//   POST /api/renew           手动续租（不吃「暂停」，忽略 paused）
//   POST /api/release         放掉租约
//   POST /api/machine         { account, id, action: renew|resume|start|release }
//
// 都要带 ?token=...（设了 TOKEN 变量时），也可以改用 X-Token 请求头或
// Authorization: Bearer ...（面板走请求头，token 不会进 URL/日志）。
// 老路由还能加 &format=text 看纯文本；加 &account=2 只操作 2 号账号。
//
// 变量 INSTABOX_LOG_MODE 控制写 KV 的频次（免费额度 1000 次写/天）：
//   hourly（默认）同一小时的连续成功只写 1 条 ≈24 次/天，失败立刻记
//   every  每次续租都写（*/9 = 160 次/天，仍在额度内）
//   off    完全不写 KV，/log 会是空的
//
// 机器被平台挂起（suspended）或停掉时，续租会 409 machine_not_running —— 此时光续租没用，
// 得先唤醒：自动 POST /resume（stopped 的用 /start 兜底）→ 等 running → 再续租。
// INSTABOX_AUTO_RESUME=0 可以关掉这个自愈。
//
// 注意：本文件 import 了 ./ui.js（面板 HTML）。网页面板部署请粘贴构建产物
// worker/dist/worker.js（已内联面板），CLI 部署直接用 wrangler（会自动打包）。
import { UI_HTML, LOGIN_HTML } from "./ui.js";

const API_DEFAULT = "https://api.instabox.sh";
const LEASE_DEFAULT = "keepalive";
const TTL_DEFAULT = 300;
const VERSION = "2.2";

const LOG_KEY = "log";
const CONFIG_KEY = "config";
const LIVE_KEY = "live";
const ALERT_KEY = "alert";
const LOG_KEEP = 48;

// 会改变状态的接口。两条规矩：一律 POST（旧 /release 的 GET 只留给 token 认证），
// 以及没配密码时默认拒绝（除非 ALLOW_PUBLIC=1）。
const WRITE_ROUTES = new Set(["/", "/release", "/api/renew", "/api/release", "/api/config", "/api/machine", "/api/account", "/api/log/clear"]);

function clampTtl(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 30 && n <= 3600 ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseAutoResume(value, fallback) {
  if (!value) return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function cfg(env) {
  const base = {
    api: (env.INSTABOX_API_URL || API_DEFAULT).replace(/\/+$/, ""),
    lease: (env.INSTABOX_LEASE || LEASE_DEFAULT).trim() || LEASE_DEFAULT,
    ttl: clampTtl(env.INSTABOX_LEASE_TTL, TTL_DEFAULT),
    kv: env.LOG || null,
    // 管理面板的配置/最近续租快照都放这个 KV；不绑就退化成「只读面板」
    cfgKv: env.CONFIG || null,
    // 被平台挂起后光续租没用，默认自愈：409 machine_not_running → resume/start → 再续租
    autoResume: parseAutoResume(env.INSTABOX_AUTO_RESUME ?? "1", true),
    // hourly（默认）：同一小时的“成功”不重复写 KV，省额度；every：每次都写；off：不写
    logMode: (env.INSTABOX_LOG_MODE || "hourly").trim(),
    // 唤醒后等机器变 running 的窗口：次数 × 间隔（默认 6×5s = 30s，比之前的 15s 更宽）
    wakeTries: clampInt(env.WAKE_TRIES, 6, 1, 20),
    wakeGap: clampInt(env.WAKE_GAP, 5, 1, 60),
    // 失败告警：POST 到 webhook；不配就完全静默
    alertUrl: (env.ALERT_WEBHOOK || "").trim(),
    alertFormat: (env.ALERT_FORMAT || "text").trim().toLowerCase(),
    alertAfter: clampInt(env.ALERT_AFTER, 1, 1, 100),
    alertEvery: clampInt(env.ALERT_MIN_INTERVAL, 1800, 60, 86400),
    // 免费版每次调用 50 个外部子请求；留 5 个余量，超了就提前收手而不是被平台掐断
    subrequestLimit: clampInt(env.SUBREQUEST_LIMIT, 45, 10, 900),
    // 没配密码/token 时默认只读：写接口一律拒绝，除非显式 ALLOW_PUBLIC=1
    allowPublic: String(env.ALLOW_PUBLIC || "") === "1",
    // 预算对象所有账号共享，call/act 每发一个请求扣一格
    budget: { left: clampInt(env.SUBREQUEST_LIMIT, 45, 10, 900) },
  };
  return { ...base, accounts: accountsOf(env, base) };
}

// "qqq" / "m_xxx,qqq" → ["m_xxx", "qqq"]；留空 = 该账号全部机器
function splitMachines(value) {
  if (value == null || value === "") return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

// 账号 N 的设置：带 _N 后缀的优先，其次是不带后缀的全局值，都没有就返回空（用内置默认）
function setting(env, name, n) {
  for (const key of [`INSTABOX_${name}_${n}`, `INSTABOX_${name}`]) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// 从 env 里找出所有 INSTABOX_API_KEY / INSTABOX_API_KEY_2 / _3 ……，按编号排序。
// 单个变量里也能塞多把 key：INSTABOX_API_KEY="ibk_aaa,ibk_bbb"（逗号分隔）→
// 按顺序拆成 1 号、2 号账号。多余的 key 往后找空位；显式 _N 变量永远优先占自己的编号。
const KEY_RE = /^INSTABOX_API_KEY(?:_(\d+))?$/;

// 单值里的多把 key："ibk_aaa, ibk_bbb, ibk_ccc" → [ibk_aaa, ibk_bbb, ibk_ccc]
function splitKeys(value) {
  return String(value ?? "")
    .split(/,+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function accountKeys(env) {
  const byNumber = new Map();
  const explicit = new Set();
  // 第一遍：每个编号变量认领自己的编号（同一编号两把不同 key，不带后缀的优先）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const key = String(value ?? "").trim();
    if (!key) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    explicit.add(n);
    const keys = splitKeys(value);
    const prev = byNumber.get(n);
    const entry = { key: keys[0], name, suffixed: !!m[1], origin: name };
    if (!prev) {
      byNumber.set(n, entry);
    } else {
      const winner = prev.suffixed && !entry.suffixed ? entry : prev;
      if (prev.key !== keys[0]) {
        console.warn(
          `instabox-keepalive: ${prev.origin} 和 ${name} 都是 ${n} 号账号但 key 不同，用 ${winner.origin}`,
        );
      }
      byNumber.set(n, winner);
    }
  }
  // 第二遍：把每个变量里逗号分隔的“第二把以后”的 key 外推到空编号；
  // 显式 _N 的编号永不被外推挤占（explicit 里有记录）
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m) continue;
    const s = String(value ?? "").trim();
    if (!s) continue;
    const n = m[1] ? Number.parseInt(m[1], 10) : 1;
    if (!Number.isSafeInteger(n) || n < 1) continue;
    for (const k of splitKeys(s).slice(1)) {
      let e = n;
      while (byNumber.has(e) || explicit.has(e)) e += 1;
      byNumber.set(e, { key: k, name: `${name}#${e}`, suffixed: true, origin: `${name} 里第 ${e - n + 1} 把` });
    }
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]);
}

// 账号列表：每个账号就是一套「单账号变量 + _N 后缀」
function accountsOf(env, base) {
  const accounts = [];
  for (const [n, { key }] of accountKeys(env)) {
    if (accounts.some((a) => a.key === key)) {
      console.warn(`instabox-keepalive: ${n} 号账号的 key 和前面的重复，已跳过`);
      continue;
    }
    accounts.push({
      account: n,
      key,
      machine: splitMachines(setting(env, "MACHINE", n)),
      lease: setting(env, "LEASE", n) || base.lease,
      ttl: clampTtl(setting(env, "LEASE_TTL", n), base.ttl),
      autoResume: parseAutoResume(setting(env, "AUTO_RESUME", n), base.autoResume),
      // 唤醒等待窗口是全局参数，但 wakeThenLease 拿到的是账号对象，所以带一份过去
      wakeTries: base.wakeTries,
      wakeGap: base.wakeGap,
      // 子请求预算也挂在账号对象上（所有账号共享同一个 budget）
      budget: base.budget,
      api: base.api,
    });
  }
  return accounts;
}

function pickAccounts(c, name) {
  if (!name) return c.accounts;
  const m = /^#?(\d+)$/.exec(name);
  if (!m) return [];
  const n = Number.parseInt(m[1], 10);
  return c.accounts.filter((a) => a.account === n);
}

function resolve(c, name) {
  if (!c.accounts.length) {
    return { error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  }
  const picked = pickAccounts(c, name);
  if (!picked.length) {
    const have = c.accounts.map((a) => `#${a.account}`).join("、");
    return {
      error: /^#?\d+$/.test(name) ? `没有 ${name} 号账号；现在有 ${have}` : `?account= 要填账号编号，比如 2；现在有 ${have}`,
    };
  }
  return { picked };
}

// ---- 面板配置（KV: CONFIG） --------------------------------------------------
// accounts["2"] = { enabled: true, mode: "all" | "list", machines: ["m_x", ...] }
//   mode=all  该账号下所有机器都保活
//   mode=list 只保活 machines 里列出的（空数组 = 一台都不保活）
// 没有该账号的条目 = 沿用环境变量（INSTABOX_MACHINE / 全部），行为与旧版完全一致
function blankConfig() {
  return { v: 1, paused: false, accounts: {} };
}

function normalizeConfig(raw) {
  const out = blankConfig();
  if (!raw || typeof raw !== "object") return out;
  out.paused = raw.paused === true;
  const src = raw.accounts && typeof raw.accounts === "object" ? raw.accounts : {};
  for (const [k, v] of Object.entries(src)) {
    const n = Number.parseInt(k, 10);
    if (!Number.isSafeInteger(n) || n < 1 || !v || typeof v !== "object") continue;
    const machines = Array.isArray(v.machines) ? v.machines.map(String).filter(Boolean) : [];
    // 兼容早期只写 machines 的形态：有列表就算白名单
    const mode = v.mode === "list" || (v.mode === undefined && machines.length) ? "list" : "all";
    out.accounts[String(n)] = { enabled: v.enabled !== false, mode, machines: mode === "list" ? machines : [] };
  }
  return out;
}

// 读配置。返回 { conf, error }：
// - error 为空：正常（没有这个键就是空配置）
// - error 非空：KV 读/解析失败 —— 调用方必须「跳过本轮」，绝不能拿空配置去写回或批量释放
async function loadConfig(c) {
  if (!c.cfgKv) return { conf: blankConfig(), error: "" };
  let raw;
  try {
    raw = await c.cfgKv.get(CONFIG_KEY);
  } catch (e) {
    console.log("instabox-keepalive: 读配置失败", e.message);
    return { conf: blankConfig(), error: `读配置失败：${e.message}` };
  }
  if (!raw) return { conf: blankConfig(), error: "" };
  try {
    return { conf: normalizeConfig(JSON.parse(raw)), error: "" };
  } catch (e) {
    console.log("instabox-keepalive: 配置不是合法 JSON", e.message);
    return { conf: blankConfig(), error: "配置不是合法 JSON，已跳过本轮（请检查 KV 里的 config 键）" };
  }
}

async function saveConfig(c, conf) {
  if (!c.cfgKv) return false;
  await c.cfgKv.put(CONFIG_KEY, JSON.stringify(normalizeConfig(conf)));
  return true;
}

const accountConf = (conf, n) => conf.accounts[String(n)] || null;

// 这台机器该不该保活：没配条目 = 全保（沿用环境变量行为）
function selected(ac, id) {
  if (!ac) return true;
  if (ac.enabled === false) return false;
  if (ac.mode === "list") return ac.machines.includes(id);
  return true;
}

// 面板展示用的“选中态”。没有面板配置时必须反映环境变量里的 INSTABOX_MACHINE，
// 否则设了 machine=qqq 的用户会看到所有机器都是开着；在面板里取消勾选时，前端会
// 以“当前选中集合”为基准写白名单，进而把原本没在保活的机器一起写进去。
function selectedFor(ac, acc, m) {
  if (ac) return selected(ac, m.id);
  if (!acc.machine.length) return true;
  return acc.machine.includes(m.id) || acc.machine.includes(m.name);
}

// 子请求预算：免费版一次调用最多 50 个外部请求，超了整轮会被平台掐断。
// 每发一个请求扣一格，扣光就让调用方提前收手（返回一个明确错误，而不是抛异常）。
function spend(acc) {
  if (!acc.budget) return true;
  if (acc.budget.left <= 0) return false;
  acc.budget.left -= 1;
  return true;
}

// 给 fetch 加超时，别让单个请求把整轮 cron 拖死
function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

// 调 API。429 / 5xx / 网络抖动自动重试两次（PUT 租约和带 Idempotency-Key 的写操作都幂等，
// 重试是安全的）；重试完还不行就把最后一次的结果返回，交给上层判失败。
async function call(c, method, path, body, opts = {}) {
  const tries = opts.retries ?? 2;
  let last = { ok: false, status: 0, json: null, text: "" };

  for (let i = 0; i <= tries; i++) {
    if (!spend(c)) {
      return { ok: false, status: 0, json: null, text: "子请求预算用完（SUBREQUEST_LIMIT），本轮跳过" };
    }
    try {
      const res = await fetch(c.api + path, {
        method,
        headers: {
          "X-API-Key": c.key,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(15000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}

      // 409 是业务状态（机器没运行），重试也没用，别浪费子请求
      const transient = res.status === 429 || res.status >= 500;
      last = { ok: res.ok, status: res.status, json, text };
      if (transient && i < tries) {
        await sleep(400 * (i + 1));
        continue;
      }
      return last;
    } catch (e) {
      last = { ok: false, status: 0, json: null, text: String(e.message || e) };
      if (i < tries) {
        await sleep(400 * (i + 1));
        continue;
      }
    }
  }
  return last;
}

// 机器列表：填了名字/id 就那几台，留空=这把 key 名下全部（isolate 内按账号缓存 10 分钟）
const listCache = new Map();

async function machines(acc, opts = {}) {
  const sel = opts.ignoreFilter ? [] : acc.machine;
  const cacheKey = `${acc.api}\n${acc.key}\n${sel.join(",")}\n${opts.ignoreFilter ? "all" : "sel"}`;
  const hit = listCache.get(cacheKey);
  if (!opts.fresh && hit && Date.now() - hit.at < 600_000) return hit.value;

  const list = [];
  const missing = [];
  let error = "";
  if (sel.length) {
    for (const one of sel) {
      if (one.startsWith("m_")) {
        list.push({ id: one, name: one, state: "" });
        continue;
      }
      const r = await call(acc, "GET", `/v1/machines/${encodeURIComponent(one)}`);
      if (r.ok && r.json?.id) list.push({ id: r.json.id, name: r.json.name || one, state: r.json.state || "" });
      else missing.push(one);
    }
  } else {
    const r = await call(acc, "GET", "/v1/machines");
    if (r.ok) {
      for (const m of r.json?.machines || []) list.push({ id: m.id, name: m.name, state: m.state || "" });
    } else {
      error = `列机器失败：HTTP ${r.status} ${(r.text || "").slice(0, 160)}`;
    }
  }

  const value = { list, missing, error };
  if (!error && !missing.length) listCache.set(cacheKey, { value, at: Date.now() });
  return value;
}

// 保活日志：绑了 KV（变量名 LOG）就留最近 48 条，没绑也能用，只是 /log 空
// hourly 模式下同一小时的连续成功只写 1 次（KV 免费额度每天 1000 次写），失败照样立刻记
async function logEvent(c, entry, force) {
  if (!c.kv || c.logMode === "off") return;
  try {
    const arr = JSON.parse((await c.kv.get(LOG_KEY)) || "[]");
    const last = arr[0];
    if (!force && c.logMode === "hourly" && entry.ok && last && String(last.at).slice(0, 13) === entry.at.slice(0, 13)) {
      return;
    }
    arr.unshift(entry);
    await c.kv.put(LOG_KEY, JSON.stringify(arr.slice(0, LOG_KEEP)), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 写日志失败", e.message);
  }
}

// 最近一次续租结果（面板的「租约剩余」靠它，API 本身不返回租约列表）
// 只在绑了 CONFIG 时写，避免给纯保活用户增加 KV 写次数
// 注意是「合并」而不是整表替换：/api/renew?account=2 只跑了 2 号账号，
// 整表替换会把 1 号账号刚续上的倒计时一起抹掉，面板要等下一轮全量 cron 才恢复。
// 只移除本轮确实处理过的账号的旧条目（这些账号下的机器列表以本轮结果为准），
// 其它账号的条目原样保留，和 clearLive/patchLive 的合并语义保持一致。
async function recordLive(c, out) {
  if (!c.cfgKv) return;
  try {
    // live 只是面板缓存：内容坏了就当空的覆盖掉，别让它卡住后续所有更新
    let prevList = [];
    try {
      const prev = JSON.parse((await c.cfgKv.get(LIVE_KEY)) || "null");
      if (prev && Array.isArray(prev.machines)) prevList = prev.machines;
    } catch {
      prevList = [];
    }    // 本轮跑过的账号；跑全量时就是全部账号，仍然会顺手清掉已删除/已取消勾选的机器
    const touched = new Set((out.accounts || []).map((a) => a.account));
    const merged = prevList.filter((m) => {
      const ok = m && typeof m === "object" && typeof m.id === "string";
      return ok && !touched.has(m.account);
    });
    const seen = new Set(merged.map((m) => `${m.account}:${m.id}`));
    for (const m of out.machines || []) {
      if (!m || typeof m.id !== "string") continue;
      const key = `${m.account}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        account: m.account,
        id: m.id,
        name: m.machine,
        ok: m.ok !== false,
        expiresAt: m.expiresAt || null,
      });
    }
    const payload = { at: out.at, paused: !!out.paused, machines: merged };
    await c.cfgKv.put(LIVE_KEY, JSON.stringify(payload), { expirationTtl: 604800 });
  } catch (e) {
    console.log("instabox-keepalive: 写 live 失败", e.message);
  }
}

// 面板上手动对单台机器操作后，就地更新 live 快照。
// 不更新的话，下一次 /api/state 还会从旧快照里读到期时间，刚续完的机器仍显示旧倒计时。
async function patchLive(c, account, id, name, expiresAt) {
  if (!c.cfgKv) return;
  try {
    const live = JSON.parse((await c.cfgKv.get(LIVE_KEY)) || "null") || { at: null, machines: [] };
    const list = Array.isArray(live.machines) ? live.machines : [];
    const entry = { account, id, name, ok: true, expiresAt: expiresAt || null };
    const idx = list.findIndex((m) => m && m.id === id);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    await c.cfgKv.put(LIVE_KEY, JSON.stringify({ at: new Date().toISOString(), machines: list }), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 更新 live 失败", e.message);
  }
}

// 批量释放后一次性清掉 live 里这些机器的到期时间（省 KV 写：一次读 + 一次写）
async function clearLive(c, items) {
  if (!c.cfgKv || !items.length) return;
  try {
    const live = JSON.parse((await c.cfgKv.get(LIVE_KEY)) || "null") || { machines: [] };
    const list = Array.isArray(live.machines) ? live.machines : [];
    for (const it of items) {
      const idx = list.findIndex((m) => m && m.id === it.id);
      if (idx >= 0) list[idx] = { ...list[idx], expiresAt: null, ok: true };
      else list.push({ account: it.account, id: it.id, name: it.name, ok: true, expiresAt: null });
    }
    await c.cfgKv.put(LIVE_KEY, JSON.stringify({ at: new Date().toISOString(), machines: list }), {
      expirationTtl: 604800,
    });
  } catch (e) {
    console.log("instabox-keepalive: 清理 live 失败", e.message);
  }
}

// 清空日志：面板「清空」和 POST /api/log/clear 都走这里。
// 只删 KV 里的历史记录，不影响机器、配置和保活。
async function clearLog(c) {
  if (!c.kv) return { ok: false, error: "没绑 LOG KV，日志本来就没存" };
  let n = 0;
  try {
    const arr = JSON.parse((await c.kv.get(LOG_KEY)) || "[]");
    n = Array.isArray(arr) ? arr.length : 0;
  } catch {}
  try {
    await c.kv.delete(LOG_KEY);
  } catch (e) {
    return { ok: false, error: `删除失败：${e.message}` };
  }
  return { ok: true, cleared: n };
}

// ---- 失败告警 ----------------------------------------------------------------
// 只在 cron 跑的时候发（面板上手动点「全部续租」不发，人就看着屏幕呢）。
// 连续失败 ALERT_AFTER 次发第一条，之后同一故障最多每 ALERT_MIN_INTERVAL 秒一条；
// 恢复时补一条「已恢复」。状态存 KV（没绑就放 isolate 内存，够单实例用）。
const alertMemo = new Map();

const alertStamp = () => new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function loadAlert(c) {
  const store = c.cfgKv || c.kv;
  if (!store) return alertMemo.get("state") || { state: "ok", fails: 0, sentAt: 0 };
  try {
    return JSON.parse((await store.get(ALERT_KEY)) || "null") || { state: "ok", fails: 0, sentAt: 0 };
  } catch {
    return { state: "ok", fails: 0, sentAt: 0 };
  }
}

async function saveAlert(c, v) {
  const store = c.cfgKv || c.kv;
  if (!store) {
    alertMemo.set("state", v);
    return;
  }
  try {
    await store.put(ALERT_KEY, JSON.stringify(v), { expirationTtl: 2592000 });
  } catch {}
}

// 各家机器人的 body 形状不一样，一个开关全兼容
function alertBody(format, text) {
  switch (format) {
    case "feishu":
      return { msg_type: "text", content: { text } };
    case "dingtalk":
    case "wecom":
    case "wechat":
      return { msgtype: "text", text: { content: text } };
    case "discord":
      return { content: text };
    default:
      return { text };
  }
}

async function sendAlert(c, text) {
  if (!c.alertUrl) return false;
  try {
    const res = await fetch(c.alertUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alertBody(c.alertFormat, text)),
      signal: timeoutSignal(10000),
    });
    if (!res.ok) console.log("instabox-keepalive: 告警发送失败 HTTP", res.status);
    return res.ok;
  } catch (e) {
    console.log("instabox-keepalive: 告警发送异常", e.message);
    return false;
  }
}

function failText(out, fails) {
  const lines = [`[InstaBox 保活失败] ${alertStamp()}`];
  if (out.error) lines.push(`错误：${out.error}`);
  const bad = (out.machines || []).filter((m) => m.ok === false || m.error);
  if (bad.length) {
    lines.push(`${bad.length} 台续租失败：`);
    for (const m of bad.slice(0, 8)) {
      lines.push(`· #${m.account} ${m.machine || m.id}${m.error ? "：" + String(m.error).slice(0, 140) : ""}`);
    }
    if (bad.length > 8) lines.push(`…还有 ${bad.length - 8} 台`);
  }
  for (const a of out.accounts || []) if (a.error) lines.push(`· #${a.account}：${a.error}`);
  if (fails > 1) lines.push(`已连续失败 ${fails} 次`);
  return lines.join("\n");
}

async function notify(c, out) {
  if (!c.alertUrl) return;
  if (out.paused) return; // 主动暂停不算故障

  const prev = await loadAlert(c);
  const now = Date.now();

  if (out.ok) {
    if (prev.state === "fail") {
      // 恢复通知发不出去就保持 fail，下一轮继续补，别把「已通知」记早了
      const sent = await sendAlert(c, `[InstaBox 保活恢复] ${alertStamp()}\n续租恢复正常，${out.count} 台已续上`);
      if (sent) await saveAlert(c, { state: "ok", fails: 0, sentAt: now });
    } else if (prev.fails) {
      await saveAlert(c, { state: "ok", fails: 0, sentAt: prev.sentAt || 0 });
    }
    return;
  }

  const fails = (prev.fails || 0) + 1;
  const due = prev.state !== "fail" || now - (prev.sentAt || 0) >= c.alertEvery * 1000;
  const send = fails >= c.alertAfter && due;

  // 先发再记账：只有真的发出去了才更新 sentAt，否则 webhook 短暂故障会把下一次重试限频掉
  const sent = send ? await sendAlert(c, failText(out, fails)) : false;
  await saveAlert(c, { state: "fail", fails, sentAt: sent ? now : prev.sentAt || 0 });
}

const lease = (c, id) =>
  call(c, "PUT", `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(c.lease)}`, {
    ttlSeconds: c.ttl,
  });

// 409 machine_not_running：机器被平台挂起（suspended）或停掉了，续租对它是无效的
const isNotRunning = (r) =>
  r.status === 409 && /not_running|suspended|stopped/i.test(r.text || "");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const rnd = () => Math.random().toString(36).slice(2, 8);

// 换状态的写操作要 Idempotency-Key（缺了 400）。key 带毫秒时间戳 + 随机串：
// 同一秒内重试也不会撞到上一次的 key（撞了会拿到缓存的旧响应，看起来像成功了）。
// 重试时复用同一个 key，让服务端能正确去重。重试次数和 call() 对齐（首次 + 2 次）。
async function act(c, id, type) {
  const key = `ka-${type}-${id}-${Date.now()}-${rnd()}`;
  let last = { ok: false, status: 0, text: "" };
  for (let i = 0; i <= 2; i++) {
    if (!spend(c)) return { ok: false, status: 0, text: "子请求预算用完，跳过唤醒" };
    try {
      const res = await fetch(`${c.api}/v1/machines/${encodeURIComponent(id)}/${encodeURIComponent(type)}`, {
        method: "POST",
        headers: { "X-API-Key": c.key, "Idempotency-Key": key },
        signal: timeoutSignal(15000),
      });
      const text = await res.text();
      last = { ok: res.ok, status: res.status, text };
      if (!(res.status === 429 || res.status >= 500)) return last;
    } catch (e) {
      last = { ok: false, status: 0, text: String(e.message || e) };
    }
    if (i < 2) await sleep(400 * (i + 1));
  }
  return last;
}

async function stateOf(c, id) {
  const r = await call(c, "GET", `/v1/machines/${encodeURIComponent(id)}`);
  return r.ok ? r.json?.state || "" : "";
}

// 挂了就先唤醒再续租：resume 优先，stopped 的用 start 兜底；running 后立刻续租一次。
// 等待窗口可配（WAKE_TRIES × WAKE_GAP），默认 6×5s=30s —— 机器启动慢的时候别急着判失败。
async function wakeThenLease(c, m) {
  const wake = [];
  for (const type of ["resume", "start"]) {
    const a = await act(c, m.id, type);
    wake.push(`${type}:${a.status}`);
    if (a.ok) break;
  }
  for (let i = 0; i < c.wakeTries; i++) {
    await sleep(c.wakeGap * 1000);
    if ((await stateOf(c, m.id)) === "running") {
      const r = await lease(c, m.id);
      return r.ok
        ? { ok: true, resumed: true, expiresAt: r.json?.expiresAt, wake }
        : { ok: false, resumed: true, status: r.status, error: r.text.slice(0, 200), wake };
    }
  }
  return { ok: false, resumed: true, status: 409, error: "已发唤醒，机器还没 running（下一轮再续）", wake };
}

const noMachine = (acc) =>
  acc.machine.length ? `找不到机器 ${acc.machine.join("、")}（或 key 没权限）` : "这把 key 名下没有机器";

// 一个账号：把它的机器按配置续一遍；单台失败不影响同账号其它机器
async function keepaliveAccount(acc, conf) {
  const ac = accountConf(conf, acc.account);
  const base = { account: acc.account, lease: acc.lease, ttl: acc.ttl };

  if (ac && ac.enabled === false) {
    return { ...base, ok: true, skipped: "已在面板停用这个账号", machines: [] };
  }

  // 面板给这个账号配过东西 → 以面板为准，列出全部机器再按勾选过滤；没配过 → 沿用环境变量
  const { list, missing, error } = await machines(acc, { ignoreFilter: !!ac });
  if (error) return { ...base, ok: false, error, machines: [] };
  if (!list.length) return { ...base, ok: false, error: noMachine(acc), machines: [] };

  const targets = list.filter((m) => selected(ac, m.id));
  if (!targets.length) {
    return { ...base, ok: true, skipped: "面板里没有勾选要保活的机器", machines: [] };
  }

  const results = [];
  for (const m of targets) {
    const item = { machine: m.name, id: m.id };
    // 唤醒一台最多要 10 个请求（2 次 resume/start + 6 次轮询 + 2 次续租），预算不够就收手
    if (acc.budget && acc.budget.left < 4) {
      results.push({ ...item, ok: false, error: "子请求预算不够，本轮先跳过（下一轮继续）" });
      continue;
    }
    try {
      const r = await lease(acc, m.id);
      if (r.ok) {
        results.push({ ...item, ok: true, expiresAt: r.json?.expiresAt });
      } else if (acc.autoResume && isNotRunning(r)) {
        // 被挂起了：续租是空转，先把它弄醒再续
        results.push({ ...item, ...(await wakeThenLease(acc, m)) });
      } else {
        results.push({ ...item, ok: false, status: r.status, error: r.text.slice(0, 200) });
      }
    } catch (e) {
      results.push({ ...item, ok: false, error: e.message });
    }
  }

  const out = { ...base, ok: results.every((r) => r.ok) && !missing.length, machines: results };
  if (missing.length) out.error = `找不到机器 ${missing.join("、")}`;
  return out;
}

const flatten = (accounts) => accounts.flatMap((a) => a.machines.map((m) => ({ account: a.account, ...m })));

async function keepalive(c, opts = {}) {
  const { conf, error: confError } = await loadConfig(c);
  if (confError) {
    // KV 挂了就整轮跳过：拿空配置继续跑会把「暂停/白名单」全忽略掉，比不跑更危险
    return { ok: false, at: new Date().toISOString(), error: confError, count: 0, accounts: [], machines: [] };
  }
  if (conf.paused && !opts.force) {
    // 暂停期间 cron 直接跳过：不写 KV、不打 API，省额度也省日志
    return { ok: true, paused: true, at: new Date().toISOString(), count: 0, accounts: [], machines: [] };
  }

  const { picked, error } = resolve(c, opts.account);
  if (error) {
    return { ok: false, at: new Date().toISOString(), error, count: 0, accounts: [], machines: [] };
  }

  const accounts = [];
  for (const acc of picked) {
    try {
      accounts.push(await keepaliveAccount(acc, conf));
    } catch (e) {
      // 一个账号的异常不能拖垮其它账号
      accounts.push({ account: acc.account, lease: acc.lease, ttl: acc.ttl, ok: false, error: `续租异常：${e.message}`, machines: [] });
    }
  }

  const flat = flatten(accounts);
  const out = {
    ok: accounts.length > 0 && accounts.every((a) => a.ok),
    at: new Date().toISOString(),
    count: flat.length,
    accounts: accounts.map((a) => ({
      account: a.account,
      ok: a.ok,
      count: a.machines.length,
      lease: a.lease,
      ttl: a.ttl,
      skipped: a.skipped,
      error: a.error,
    })),
    machines: flat,
  };
  await logEvent(c, out, opts.forceLog);
  await recordLive(c, out);
  return out;
}

async function status(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  const accounts = [];
  for (const acc of picked) {
    try {
      const { list, missing, error: err } = await machines(acc, { fresh: true });
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const ms = [];
      for (const m of list) {
        const r = await call(acc, "GET", `/v1/machines/${encodeURIComponent(m.id)}`);
        ms.push(
          r.ok
            ? {
                machine: m.name,
                id: m.id,
                state: r.json?.state,
                autoSuspendAfterSeconds: r.json?.autoSuspendAfterSeconds,
                autoSuspendedAt: r.json?.autoSuspendedAt ?? null,
              }
            : { machine: m.name, id: m.id, error: `HTTP ${r.status}` },
        );
      }
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => !x.error),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `查询异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

async function release(c, account) {
  const { picked, error } = resolve(c, account);
  if (error) return { ok: false, error, count: 0, accounts: [], machines: [] };

  // 和续租用同一套筛选：面板勾选了什么就放什么，没配过配置就沿用 INSTABOX_MACHINE。
  // 别再把「账号下所有机器」一股脑放掉 —— 那和 shell 的 --release 行为不一致，容易误放。
  const { conf, error: confError } = await loadConfig(c);
  if (confError) {
    // 读不到配置就不知道该放哪些机器，宁可不动
    return { ok: false, error: confError, count: 0, accounts: [], machines: [] };
  }
  const accounts = [];
  for (const acc of picked) {
    try {
      const ac = accountConf(conf, acc.account);
      const { list, missing, error: err } = await machines(acc, { ignoreFilter: !!ac, fresh: true });
      if (err) {
        accounts.push({ account: acc.account, ok: false, error: err, count: 0, machines: [] });
        continue;
      }
      const targets = list.filter((m) => selected(ac, m.id));
      const ms = [];
      for (const m of targets) {
        const r = await call(acc, "DELETE", `/v1/machines/${encodeURIComponent(m.id)}/activity-leases/${encodeURIComponent(acc.lease)}`);
        ms.push({ machine: m.name, id: m.id, ok: r.ok || r.status === 404, status: r.status });
      }
      // 放完的机器在 live 快照里清掉到期时间，面板不会继续显示旧倒计时
      await clearLive(c, ms.filter((x) => x.ok).map((x) => ({ account: acc.account, id: x.id, name: x.machine })));
      accounts.push({
        account: acc.account,
        ok: ms.length > 0 && !missing.length && ms.every((x) => x.ok),
        count: ms.length,
        error: missing.length ? `找不到机器 ${missing.join("、")}` : undefined,
        machines: ms,
      });
    } catch (e) {
      accounts.push({ account: acc.account, ok: false, error: `释放异常：${e.message}`, count: 0, machines: [] });
    }
  }

  const flat = flatten(accounts);
  return { ok: accounts.length > 0 && accounts.every((a) => a.ok), count: flat.length, accounts, machines: flat };
}

// ---- 面板 API ----------------------------------------------------------------

function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// 面板一屏要的东西：账号（打码）+ 全部机器 + 配置 + 最近一次续租结果
async function state(c) {
  const { conf, error: confError } = await loadConfig(c);
  let live = null;
  if (c.cfgKv) {
    try {
      live = JSON.parse((await c.cfgKv.get(LIVE_KEY)) || "null");
    } catch {}
  }
  // KV 里的东西可能是旧版本写的、也可能被人手动改坏，用之前先验结构
  const liveList = Array.isArray(live?.machines) ? live.machines : [];
  const liveMap = new Map(
    liveList
      .filter((m) => m && typeof m === "object" && typeof m.id === "string")
      .map((m) => [m.id, m]),
  );

  const accounts = [];
  const rows = [];
  const warnings = [];
  if (confError) warnings.push({ account: 0, error: confError });

  for (const acc of c.accounts) {
    const ac = accountConf(conf, acc.account);
    // 单个账号出问题不能拖垮整个 /api/state，按账号兜住异常
    let list = [];
    let missing = [];
    let err = "";
    try {
      const out = await machines(acc, { ignoreFilter: true, fresh: true });
      list = out.list || [];
      missing = out.missing || [];
      err = out.error || (missing.length ? `找不到机器 ${missing.join("、")}` : "");
    } catch (e) {
      err = `读取机器列表异常：${e.message}`;
    }
    // 单个账号挂了也要让面板看得见，别只显示一张空表
    if (err) warnings.push({ account: acc.account, error: err });
    accounts.push({
      account: acc.account,
      key: maskKey(acc.key),
      lease: acc.lease,
      ttl: acc.ttl,
      autoResume: acc.autoResume,
      envMachine: acc.machine,
      conf: ac ? { enabled: ac.enabled, mode: ac.mode, machines: ac.machines } : null,
      count: list.length,
      error: err,
    });
    for (const m of list) {
      const l = liveMap.get(m.id);
      rows.push({
        account: acc.account,
        id: m.id,
        name: m.name,
        state: m.state || "",
        selected: selectedFor(ac, acc, m),
        expiresAt: l?.expiresAt || null,
        lastRenewAt: live?.at || null,
      });
    }
  }

  return {
    ok: true,
    version: VERSION,
    at: new Date().toISOString(),
    paused: conf.paused,
    canSave: !!c.cfgKv,
    alertOn: !!c.alertUrl,
    logMode: c.logMode,
    liveAt: live?.at || null,
    warnings,
    accounts,
    machines: rows,
  };
}

async function updateConfig(c, body) {
  if (!c.cfgKv) {
    return {
      ok: false,
      error: "没绑 CONFIG KV，改动不会保存。在 Worker 的 Settings → Bindings 里加一个变量名 CONFIG 的 KV 命名空间后重试。",
    };
  }
  const { conf, error: confError } = await loadConfig(c);
  if (confError) {
    // 读不出来就绝不能写：否则一次 KV 抖动会把面板配置覆盖成空
    return { ok: false, error: `${confError}（为免覆盖，本次改动没有保存）` };
  }
  if (typeof body.paused === "boolean") conf.paused = body.paused;

  if (body.accounts && typeof body.accounts === "object") {
    for (const [k, v] of Object.entries(body.accounts)) {
      const n = Number.parseInt(k, 10);
      if (!Number.isSafeInteger(n) || n < 1) continue;
      const key = String(n);
      // null = 删掉这个账号的配置，回到「跟随环境变量」
      if (v === null || v === "reset") {
        delete conf.accounts[key];
        continue;
      }
      if (!v || typeof v !== "object") continue;
      const prev = conf.accounts[key] || { enabled: true, mode: "all", machines: [] };
      const next = { enabled: typeof v.enabled === "boolean" ? v.enabled : prev.enabled, mode: prev.mode, machines: prev.machines };
      if (v.mode === "all") {
        next.mode = "all";
        next.machines = [];
      } else if (Array.isArray(v.machines)) {
        next.mode = "list";
        next.machines = v.machines.map(String).filter(Boolean);
      } else if (v.mode === "list") {
        next.mode = "list";
      }
      conf.accounts[key] = next;
    }
  }

  await saveConfig(c, conf);
  return { ok: true, config: normalizeConfig(conf), canSave: true };
}

async function machineAction(c, body) {
  const n = Number.parseInt(body.account, 10);
  const acc = c.accounts.find((a) => a.account === n);
  if (!acc) return { ok: false, error: `没有 ${body.account} 号账号` };
  const id = String(body.id || "").trim();
  if (!id) return { ok: false, error: "缺机器 id" };
  const action = String(body.action || "").trim();
  const name = String(body.name || id);

  if (action === "renew") {
    const r = await lease(acc, id);
    if (!r.ok) return { ok: false, status: r.status, error: r.text.slice(0, 200) };
    await patchLive(c, acc.account, id, name, r.json?.expiresAt);
    return { ok: true, expiresAt: r.json?.expiresAt };
  }
  if (action === "release") {
    const r = await call(acc, "DELETE", `/v1/machines/${encodeURIComponent(id)}/activity-leases/${encodeURIComponent(acc.lease)}`);
    if (!r.ok && r.status !== 404) return { ok: false, status: r.status, error: r.text.slice(0, 200) };
    await patchLive(c, acc.account, id, name, null);
    return { ok: true };
  }
  if (action === "resume" || action === "start") {
    // 唤醒后顺手续一次租，否则刚醒的机器没租约、到点又睡
    const out = await wakeThenLease(acc, { id, name });
    if (out.ok) await patchLive(c, acc.account, id, name, out.expiresAt);
    return out;
  }
  return { ok: false, error: `未知操作：${action}` };
}

// ---- 登录：登录页 + 签名会话 cookie -------------------------------------------
// 单用户，不做账号体系。密码来自 ADMIN_PASSWORD（或 ADMIN_PASSWORD_HASH）；
// 只配了 TOKEN 的老用户直接把 TOKEN 当密码用，行为不变。
// 会话是无状态签名 cookie（HMAC-SHA256），不写 KV；改密码/改 SESSION_SECRET 即全体下线。
const SESSION_COOKIE = "ibk_session";
const SESSION_TTL_DEFAULT = 12 * 3600;
const SESSION_REMEMBER_TTL = 7 * 24 * 3600;
const LOGIN_MAX_FAIL = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const textEnc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", textEnc.encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", textEnc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, textEnc.encode(data));
  return b64url(new Uint8Array(sig));
}

// 面板里的账号存 KV（auth 键）：密码用 PBKDF2-SHA256 + 随机盐，不存明文。
// 迭代次数按 Workers 免费版 10ms CPU 预算取 5 万（本地实测约 5ms）；付费版可以调 AUTH_ITER。
// 没有这个键就退回环境变量（ADMIN_USER / ADMIN_PASSWORD / ADMIN_PASSWORD_HASH / TOKEN）。
const AUTH_KEY = "auth";
const PBKDF2_ITER_DEFAULT = 50000;

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", textEnc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: textEnc.encode(String(salt)), iterations: iter, hash: "SHA-256" },
    key,
    256,
  );
  return b64url(new Uint8Array(bits));
}

const randomB64 = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// 读 KV 里的账号记录。返回 { record, error }：
// - 没有这个键 → { record: null, error: "" }（正常退回环境变量）
// - 读失败 / 结构不对 / 迭代次数越界 → { record: null, error: "..." }（调用方 fail-closed）
const ITER_MIN = 10000;
const ITER_MAX = 200000;

async function loadAccount(kv) {
  if (!kv) return { record: null, error: "" };
  let raw;
  try {
    raw = await kv.get(AUTH_KEY);
  } catch (e) {
    return { record: null, error: `读取账号记录失败：${e.message}` };
  }
  if (!raw) return { record: null, error: "" };
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { record: null, error: "账号记录不是合法 JSON" };
  }
  if (!rec || typeof rec !== "object" || typeof rec.hash !== "string" || typeof rec.salt !== "string") {
    return { record: null, error: "账号记录结构不对（缺 hash/salt）" };
  }
  // 迭代次数限个范围：手改的或旧版本写的超大值会把一次登录的 CPU 打爆
  const iter = Number(rec.iter);
  if (!Number.isInteger(iter) || iter < ITER_MIN || iter > ITER_MAX) {
    return { record: null, error: `账号记录的迭代次数不合法（${rec.iter}），应在 ${ITER_MIN}-${ITER_MAX}` };
  }
  return { record: { ...rec, iter }, error: "" };
}

async function authConfig(env, kv) {
  const { record, error: kvError } = await loadAccount(kv);
  const hash = (env.ADMIN_PASSWORD_HASH || "").trim().toLowerCase();
  const pass = env.ADMIN_PASSWORD || "";
  const token = env.TOKEN || "";
  const ttl = Number.parseInt(env.SESSION_TTL, 10);

  // 账号存在 KV 里但读不出来：fail-closed。既不放行会话，也不让环境变量里的旧密码重新生效。
  // （TOKEN 不依赖 KV，仍然可用，脚本不会因为 KV 抖动全停。）
  if (kvError) {
    return {
      record: null,
      broken: kvError,
      user: (env.ADMIN_USER || "admin").trim() || "admin",
      needUser: true,
      hash: "",
      pass: "",
      token,
      secret: "",
      ttl: Number.isFinite(ttl) && ttl >= 60 && ttl <= 30 * 86400 ? ttl : SESSION_TTL_DEFAULT,
      enabled: true,
      source: "kv-error",
    };
  }

  // 只配了 TOKEN 的老用户不该被要求填用户名
  const needUser = !!(record || hash || pass);
  const enabled = !!(record || hash || pass || token);
  // 会话签名密钥里混进当前凭据的指纹：改完密码，所有已发出的会话立刻失效
  const fingerprint = record ? record.hash : hash || pass || token;

  return {
    record,
    broken: "",
    user: (record?.user || env.ADMIN_USER || "admin").trim() || "admin",
    needUser,
    hash,
    pass,
    token,
    secret: enabled ? (env.SESSION_SECRET || "") + "|" + fingerprint : "",
    ttl: Number.isFinite(ttl) && ttl >= 60 && ttl <= 30 * 86400 ? ttl : SESSION_TTL_DEFAULT,
    enabled,
    source: record ? "kv" : enabled ? "env" : "open",
  };
}

// 只校验密码。改账号时用户名可能同时被改，不能拿新用户名去跟旧的比。
async function verifyPasswordOnly(auth, password) {
  if (auth.broken) return false; // KV 读不出来就别验，避免旧环境密码趁机复活
  const pw = String(password ?? "");
  if (auth.record) {
    const iter = Number.isFinite(auth.record.iter) ? auth.record.iter : PBKDF2_ITER_DEFAULT;
    return safeEqual(await pbkdf2(pw, auth.record.salt, iter), auth.record.hash);
  }
  if (auth.hash) return safeEqual(await sha256Hex(pw), auth.hash);
  if (auth.pass) return safeEqual(pw, auth.pass);
  if (auth.token) return safeEqual(pw, auth.token);
  return false;
}

async function checkPassword(auth, user, password) {
  if (auth.needUser) {
    if (String(user || "").trim().toLowerCase() !== auth.user.toLowerCase()) return false;
  }
  return verifyPasswordOnly(auth, password);
}

const USER_RE = /^[^\s:]{1,32}$/;

// 改用户名 / 改密码：必须给当前密码（光有会话不够，防会话被偷走后直接改凭据）
async function updateAccount(c, env, auth, body, request) {
  if (!c.cfgKv) {
    return { ok: false, error: "没绑 CONFIG KV，账号存不下来。绑一个变量名 CONFIG 的 KV 命名空间再试。" };
  }
  if (auth.broken) {
    return { ok: false, error: "账号数据暂时读不出来，稍后再试", code: 503 };
  }
  if (!auth.enabled) {
    return { ok: false, error: "现在没配任何密码（面板是公开的），先设 ADMIN_PASSWORD 或 TOKEN 再来改" };
  }

  // 这个接口能验密码，等于第二个爆破入口，单独限流
  const ip = clientIp(request);
  const guard = await loginGuard(env, ip, "acct", ACCT_MAX_FAIL);
  if (guard.blocked) {
    return { ok: false, error: `尝试次数太多，${Math.ceil(LOGIN_WINDOW_MS / 60000)} 分钟后再试`, code: 429 };
  }

  const current = String(body.currentPassword || "");
  if (!current) return { ok: false, error: "请输入当前密码" };
  if (!(await verifyPasswordOnly(auth, current))) {
    await noteFail(env, ip, guard.fails, "acct");
    return { ok: false, error: "当前密码不对", code: 401 };
  }
  await clearFail(env, ip, "acct");

  const nextUser = String(body.user ?? "").trim() || auth.user;
  if (!USER_RE.test(nextUser)) return { ok: false, error: "用户名 1-32 个字符，不能带空格和冒号" };

  const nextPass = String(body.password ?? "");
  if (nextPass && nextPass.length < 8) return { ok: false, error: "新密码至少 8 位" };
  if (nextPass.length > 200) return { ok: false, error: "新密码太长了" };

  const iter = clampInt(env.AUTH_ITER, PBKDF2_ITER_DEFAULT, ITER_MIN, ITER_MAX);
  const salt = randomB64(16);
  // 没填新密码 = 沿用当前密码；当前密码刚校验过，直接用它重新算一份带盐哈希
  const hash = await pbkdf2(nextPass || current, salt, iter);
  const record = { v: 1, user: nextUser, algo: "pbkdf2-sha256", iter, salt, hash, at: new Date().toISOString() };
  await c.cfgKv.put(AUTH_KEY, JSON.stringify(record));

  // 凭据指纹变了 → 签名密钥跟着变 → 其它设备全部掉线；当前这台换一张新票继续用
  const fresh = await authConfig(env, c.cfgKv);
  const ttl = auth.ttl;
  const cookie = sessionCookie(request, await issueSession(fresh, ttl), ttl);
  return { ok: true, user: nextUser, source: "kv", changedPassword: !!nextPass, cookie };
}

async function issueSession(auth, ttl) {
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const body = `v1.${exp}.${nonce}`;
  return `${body}.${await hmac(auth.secret, body)}`;
}

async function verifySession(auth, value) {
  if (!auth.secret || !value) return false;
  const parts = String(value).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const exp = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(parts[3], await hmac(auth.secret, parts.slice(0, 3).join(".")));
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sessionCookie(request, value, maxAge) {
  // 本地 wrangler dev 是 http，加 Secure 会让 cookie 失效，所以按实际协议给
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const base = `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  return maxAge > 0 ? `${base}; Max-Age=${maxAge}` : `${base}; Max-Age=0`;
}

const clientIp = (request) =>
  request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";

// 失败计数：优先写 KV（跨 isolate 生效），没绑 KV 就退回单 isolate 内存。
// scope 区分用途（登录 / 改账号），避免一个接口的失败把另一个也锁了。
const failMemo = new Map();
const ACCT_MAX_FAIL = 6;

async function loginGuard(env, ip, scope = "login", max = LOGIN_MAX_FAIL) {
  const store = env.CONFIG || env.LOG;
  const now = Date.now();
  if (!store) {
    const hit = failMemo.get(`${scope}:${ip}`);
    if (!hit || now - hit.at > LOGIN_WINDOW_MS) return { blocked: false, fails: 0 };
    return { blocked: hit.n >= max, fails: hit.n };
  }
  try {
    const hit = JSON.parse((await store.get(`${scope}:${ip}`)) || "null");
    if (!hit || now - hit.at > LOGIN_WINDOW_MS) return { blocked: false, fails: 0 };
    return { blocked: hit.n >= max, fails: hit.n };
  } catch {
    return { blocked: false, fails: 0 };
  }
}

async function noteFail(env, ip, fails, scope = "login") {
  const store = env.CONFIG || env.LOG;
  const n = fails + 1;
  if (!store) {
    failMemo.set(`${scope}:${ip}`, { n, at: Date.now() });
    return;
  }
  try {
    await store.put(`${scope}:${ip}`, JSON.stringify({ n, at: Date.now() }), { expirationTtl: 900 });
  } catch {}
}

async function clearFail(env, ip, scope = "login") {
  const store = env.CONFIG || env.LOG;
  if (!store) {
    failMemo.delete(`${scope}:${ip}`);
    return;
  }
  try {
    await store.delete(`${scope}:${ip}`);
  } catch {}
}

// 登录后只允许跳站内路径，挡掉 ?next=//evil.com 这类开放重定向
function safeNext(value) {
  const s = String(value || "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return "/ui";
  return s;
}

// 走 cookie 的写操作要防 CSRF：浏览器带 Origin，必须同源；curl 不带 Origin，放行
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

// 谁能进来：?token= / X-Token（curl、老链接）→ 会话 cookie → 没配密码就全放行
async function whoIs(request, env, url, auth) {
  if (!auth.enabled) return "open";
  const t = tokenOf(request, url);
  if (auth.token && t && safeEqual(t, auth.token)) return "token";
  const sess = getCookie(request, SESSION_COOKIE);
  if (sess && (await verifySession(auth, sess))) return "session";
  return "";
}

const redirect = (location, cookie) =>
  new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });

async function handleLogin(request, env, auth) {
  if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
  if (!sameOrigin(request)) return jsonReply({ ok: false, error: "来源不对" }, 403);
  if (auth.broken) {
    // KV 读不到账号记录：明确报错，别悄悄退回环境变量里的旧密码
    return jsonReply({ ok: false, error: "账号数据暂时读不出来，稍后再试（或先用 TOKEN 登录）" }, 503);
  }
  if (!auth.enabled) return jsonReply({ ok: true, enabled: false, next: "/ui" });

  const ip = clientIp(request);
  const guard = await loginGuard(env, ip);
  if (guard.blocked) {
    return jsonReply({ ok: false, error: `失败次数太多，${Math.ceil(LOGIN_WINDOW_MS / 60000)} 分钟后再试` }, 429);
  }

  const body = await readJson(request);
  const password = String(body.password || "");
  if (!password) return jsonReply({ ok: false, error: "请输入密码" }, 400);

  if (!(await checkPassword(auth, body.username, password))) {
    await noteFail(env, ip, guard.fails);
    const left = Math.max(LOGIN_MAX_FAIL - guard.fails - 1, 0);
    return jsonReply(
      { ok: false, error: left ? `用户名或密码不对（还能试 ${left} 次）` : "失败次数太多，稍后再试" },
      401,
    );
  }

  await clearFail(env, ip);
  const ttl = body.remember ? Math.max(auth.ttl, SESSION_REMEMBER_TTL) : auth.ttl;
  const value = await issueSession(auth, ttl);
  return jsonReply({ ok: true, next: safeNext(body.next) }, 200, sessionCookie(request, value, ttl));
}

// 第三个参数可以直接给 Set-Cookie 字符串，也可以给额外的 headers 对象
function jsonReply(body, status = 200, extra) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (typeof extra === "string") headers["Set-Cookie"] = extra;
  else if (extra && typeof extra === "object") Object.assign(headers, extra);
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

// 面板页的安全响应头。页面全是内联样式/脚本，所以 script/style 只能放开 'unsafe-inline'，
// 但 default-src 'none' + connect-src 'self' 仍然挡住了任何外链加载和跨站请求。
const PAGE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "Content-Security-Policy":
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const htmlReply = (html) =>
  new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...PAGE_HEADERS,
    },
  });

// 请求体上限：登录接口是公开的，别让人塞个几 MB 的 JSON 进来
const MAX_BODY = 16 * 1024;

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY) return {};
  try {
    const text = await request.text();
    if (!text || text.length > MAX_BODY) return {};
    const body = JSON.parse(text);
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function tokenOf(request, url) {
  const q = url.searchParams.get("token");
  if (q) return q;
  const h = request.headers.get("x-token") || request.headers.get("authorization") || "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

// 定长比较，避免按字符提前返回泄露 token 长度信息
function safeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  // 不提前返回：长度差也走完整轮循环，才算真的定长
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// 写接口统一过一遍同源检查（cookie 认证下挡 CSRF；curl 不带 Origin，不受影响）
const guardWrite = (request) =>
  request.method === "POST" && !sameOrigin(request) ? jsonReply({ ok: false, error: "来源不对" }, 403) : null;

export default {
  async scheduled(_event, env) {
    const c = cfg(env);
    const out = await keepalive(c);
    await notify(c, out);
    if (out.ok) console.log("instabox-keepalive:", JSON.stringify(out));
    else console.error("instabox-keepalive:", JSON.stringify(out));
  },

  async fetch(request, env) {
    const c = cfg(env);
    const auth = await authConfig(env, c.cfgKv);
    const url = new URL(request.url);
    const asText = url.searchParams.get("format") === "text";
    const accept = request.headers.get("accept") || "";
    const route = url.pathname.replace(/\/+$/, "") || "/";
    const account = (url.searchParams.get("account") || "").trim();

    // ---- 不用登录就能碰的三样：登录页本身、登录接口、面板用来问“要不要填用户名”的接口
    if (route === "/login") {
      if (auth.enabled && (await verifySession(auth, getCookie(request, SESSION_COOKIE)))) return redirect("/ui");
      return htmlReply(LOGIN_HTML);
    }
    if (route === "/api/login") return handleLogin(request, env, auth);
    if (route === "/api/authinfo") {
      // kind 要反映「真正在用的凭据来源」：账号存在 KV 里时，环境变量的 hash/pass 都是空的
      const kind = auth.broken ? "broken" : auth.record ? "password" : auth.hash || auth.pass ? "password" : auth.token ? "token" : "none";
      return jsonReply({
        ok: true,
        enabled: auth.enabled,
        needUser: auth.needUser,
        user: auth.needUser ? auth.user : "",
        kind,
        broken: !!auth.broken,
      });
    }
    if (route === "/api/logout") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      if (!sameOrigin(request)) return jsonReply({ ok: false, error: "来源不对" }, 403);
      return jsonReply({ ok: true }, 200, sessionCookie(request, "", 0));
    }

    // ---- 其余全部要身份：面板路由没登录就跳登录页，接口没登录给 401
    const via = await whoIs(request, env, url, auth);
    const isPanel = route === "/ui" || route === "/panel" || route === "/admin" || (route === "/" && accept.includes("text/html"));
    if (!via) {
      if (isPanel) {
        const next = safeNext(url.pathname + (url.search ? url.search : ""));
        return redirect("/login?next=" + encodeURIComponent(next));
      }
      return reply({ ok: false, error: "未登录：先去 /login，或带上 ?token=" }, 401, asText);
    }

    // 浏览器用 ?token= 打开面板：换成 cookie 再跳到干净地址，token 不留在地址栏和历史里
    if (isPanel) {
      const q = url.searchParams.get("token");
      if (auth.enabled && q) {
        const ttl = auth.ttl;
        return redirect("/ui", sessionCookie(request, await issueSession(auth, ttl), ttl));
      }
      return htmlReply(UI_HTML);
    }

    // 没配密码/token（auth.enabled=false）时默认只读：写操作一律拒绝，
    // 除非显式 ALLOW_PUBLIC=1。避免一个忘配密码的部署被人直接改配置/放租约。
    if (!auth.enabled && !c.allowPublic && WRITE_ROUTES.has(route)) {
      return reply(
        {
          ok: false,
          error: "面板没设密码，写操作已禁用（只读）。设 ADMIN_PASSWORD 或 TOKEN，或显式设 ALLOW_PUBLIC=1 再放开。",
        },
        403,
        asText,
      );
    }

    if (route === "/") {
      // 浏览器会话不能用 GET 触发续租：跨站顶层导航会带上 cookie。改用 POST /api/renew
      if (via === "session") {
        return reply({ ok: false, error: "浏览器会话请用 POST /api/renew" }, 405, asText);
      }
      const out = await keepalive(c, { account, forceLog: true }); // 手动触发不给去重，一定出现在 /log
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/accounts") {
      const out = accountsView(c);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/status") {
      const out = await status(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    if (route === "/log") {
      let entries = [];
      try {
        entries = c.kv ? JSON.parse((await c.kv.get(LOG_KEY)) || "[]") : [];
      } catch {
        entries = [];
      }
      return reply(
        {
          ok: true,
          storage: c.kv ? "KV 已绑定，保留最近 48 次（7 天）" : "未绑定 KV（变量 LOG），/log 为空",
          count: entries.length,
          entries,
        },
        200,
        asText,
      );
    }

    if (route === "/release") {
      // 迁移期保留 GET（只给 ?token= / X-Token 用）；浏览器会话必须走 POST /api/release
      if (request.method === "GET" && via === "session") {
        return reply({ ok: false, error: "浏览器会话请用 POST /api/release" }, 405, asText);
      }
      if (request.method !== "GET" && request.method !== "POST") {
        return reply({ ok: false, error: "只支持 GET（token）或 POST" }, 405, asText);
      }
      if (request.method === "POST") {
        const bad = guardWrite(request);
        if (bad) return bad;
      }
      const out = await release(c, account);
      return reply(out, out.ok ? 200 : 502, asText);
    }

    // ---- 面板接口（JSON） ----
    if (route === "/api/state") {
      const out = await state(c);
      out.auth = {
        via,
        enabled: auth.enabled,
        user: auth.user,
        needUser: auth.needUser,
        source: auth.source,
        canEdit: !!c.cfgKv,
        // 没配密码时写操作被拒，面板据此切成只读
        canWrite: auth.enabled || c.allowPublic,
      };
      return jsonReply(out);
    }

    if (route === "/api/account") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const out = await updateAccount(c, env, auth, await readJson(request), request);
      return jsonReply(
        { ok: out.ok, user: out.user, changedPassword: out.changedPassword, error: out.error },
        out.ok ? 200 : out.code || 400,
        out.cookie,
      );
    }

    if (route === "/api/config") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const out = await updateConfig(c, await readJson(request));
      return jsonReply(out, out.ok ? 200 : 400);
    }

    if (route === "/api/log/clear") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const out = await clearLog(c);
      return jsonReply(out, out.ok ? 200 : 400);
    }

    if (route === "/api/renew") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const body = await readJson(request);
      const out = await keepalive(c, {
        account: String(body.account || account || ""),
        forceLog: true,
        force: true, // 手动续租不受「暂停」影响
      });
      return jsonReply(out, out.ok ? 200 : 502);
    }

    if (route === "/api/release") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const body = await readJson(request);
      const out = await release(c, String(body.account || account || ""));
      return jsonReply(out, out.ok ? 200 : 502);
    }

    if (route === "/api/machine") {
      if (request.method !== "POST") return jsonReply({ ok: false, error: "请用 POST" }, 405);
      const bad = guardWrite(request);
      if (bad) return bad;
      const out = await machineAction(c, await readJson(request));
      return jsonReply(out, out.ok ? 200 : 502);
    }

    if (route.startsWith("/api/")) return jsonReply({ ok: false, error: `没有这个接口：${route}` }, 404);

    return reply(
      { ok: false, error: "用 / 续租、/ui 面板、/status 状态、/accounts 账号、/log 日志、/release 放租约" },
      404,
      asText,
    );
  },
};

function accountsView(c) {
  if (!c.accounts.length) return { ok: false, error: "没配账号：加一个 INSTABOX_API_KEY（多账号再加 INSTABOX_API_KEY_2）" };
  return {
    ok: true,
    count: c.accounts.length,
    accounts: c.accounts.map((a) => ({
      account: a.account,
      key: maskKey(a.key),
      machine: a.machine,
      lease: a.lease,
      ttl: a.ttl,
      autoResume: a.autoResume,
    })),
  };
}

function reply(body, status, asText) {
  if (asText) {
    const lines = [`ok=${body.ok}`];
    if (body.error) lines.push(`error=${body.error}`);
    for (const a of body.accounts || []) {
      if (a.key) {
        // /accounts
        lines.push(`[#${a.account}] ${a.key} ${(a.machine || []).join(",") || "全部机器"} lease=${a.lease} ttl=${a.ttl}`);
      } else if (a.error) {
        lines.push(`[#${a.account}] FAIL ${a.error}`);
      }
    }
    for (const m of body.machines || []) {
      const bad = m.ok === false || !!m.error;
      lines.push(
        [
          m.account !== undefined ? `[#${m.account}]` : "",
          m.machine || m.name,
          bad ? "FAIL" : "ok",
          m.expiresAt || m.state || m.status || "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    for (const e of body.entries || []) {
      lines.push(`${e.at} ok=${e.ok} 续租 ${e.count} 台`);
    }
    return new Response(lines.join("\n") + "\n", {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
