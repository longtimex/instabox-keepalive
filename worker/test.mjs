// 无依赖冒烟测试：用假 KV + 假 InstaBox API 跑一遍主要路径（含登录/会话/限流）。
//   node test.mjs      （或 npm test）
import assert from "node:assert/strict";
import worker from "./worker.js";

const API = "https://api.instabox.sh";

function fakeKV(opts = {}) {
  const map = new Map();
  return {
    _map: map,
    failGet: opts.failGet || null, // (key) => true 时这次读抛错，用来模拟 KV 抖动
    authReads: 0, // 只数 auth 这个键的读取次数（缓存测试用）
    async get(key) {
      if (key === "auth") this.authReads += 1;
      if (this.failGet && this.failGet(key)) throw new Error("kv unavailable");
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      if (key === "win") fakeKVPutCount += 1;
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const machineState = { m_1: "running", m_2: "suspended", m_3: "running" };
// 自己空闲挂起的机器（autoSuspendedAt 有值）和「你手动 suspend 的」走的是两条路：
// 前者 /wake 管用，后者只能 /resume。这个集合用来区分。
const autoPaused = new Set();
// id -> 冷却剩余秒数：平台让机器休息时，任何唤醒都回 409 machine_cooldown
const cooldowns = {};

// 每个 key 名下的机器。/api/state 会按账号逐个列机器，假 API 也要照做。
const machinesByKey = () => ({
  ibk_test_key: [
    {
      id: "m_1",
      name: "qqq",
      state: machineState.m_1,
      autoSuspendedAt: autoPaused.has("m_1") ? "2026-11-03T01:00:00Z" : null,
      cooldownUntil: cooldowns.m_1 ? new Date(Date.now() + cooldowns.m_1 * 1000).toISOString() : null,
      ...(machineExtra.m_1 || {}),
    },
    {
      id: "m_2",
      name: "box2",
      state: machineState.m_2,
      autoSuspendedAt: autoPaused.has("m_2") ? "2026-11-03T01:00:00Z" : null,
      cooldownUntil: cooldowns.m_2 ? new Date(Date.now() + cooldowns.m_2 * 1000).toISOString() : null,
      ...(machineExtra.m_2 || {}),
    },
  ],
  ibk_second: [{ id: "m_3", name: "box3", state: machineState.m_3 }],
});
let calls = [];
let hooks = [];
let fakeKVPutCount = 0;
const tgCalls = [];
let leaseFailures = 0;
let leaseConflicts = 0;
let leaseRateLimits = 0;
// 生命周期调用（resume/start/wake）撞 operation_conflict 的次数，以及每次请求带的
// Idempotency-Key —— 官方要求 operation_conflict 重试时换**新的** key，这里验它
let lifecycleConflicts = 0;
const lifecycleKeys = [];
// 402 early_allowance_ended：免费额度用完，启动被拒
let lifecycle402 = 0;
// id -> 额外机器字段（runStartedAt / cooldownReason / free / maxRunMinutes），
// 默认不设，免得影响老断言的文案
const machineExtra = {};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = (init.method || "GET").toUpperCase();

  // 告警 webhook：只记录，不发出去
  if (url.host === "hook.test") {
    hooks.push({ format: url.pathname, body: JSON.parse(init.body || "{}") });
    return new Response("ok", { status: 200 });
  }

  // Telegram Bot API：记录方法名和 body，永远回 ok（机器人只看 ok 和 description）
  if (url.host === "api.telegram.org") {
    const method = path.split("/").pop();
    let body = {};
    try {
      body = JSON.parse(init.body || "{}");
    } catch {}
    tgCalls.push({ method, body, url: String(input) });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }

  calls.push(method + " " + path);

  const own = machinesByKey()[init.headers?.["X-API-Key"]];
  if (!own) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  if (path === "/v1/machines" && method === "GET") {
    return Response.json({ machines: own });
  }

  let m = /^\/v1\/machines\/([^/]+)$/.exec(path);
  if (m && method === "GET") {
    // 官方：GET /v1/machines/{id} 按 id 或名字都行
    const found = own.find((x) => x.id === m[1] || x.name === m[1]);
    if (!found) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return Response.json(found);
  }

  m = /^\/v1\/machines\/([^/]+)\/activity-leases\/(.+)$/.exec(path);
  if (m) {
    if (method === "PUT") {
      // 用来验证 5xx 自动重试
      if (leaseFailures > 0) {
        leaseFailures--;
        return new Response(JSON.stringify({ error: "upstream" }), { status: 503 });
      }
      // 平台正在变状态：另一个操作在跑，不是机器没运行
      if (leaseConflicts > 0) {
        leaseConflicts--;
        return new Response(
          JSON.stringify({ error: { code: "operation_conflict", retryable: true, retryAfterSeconds: 0.02 } }),
          { status: 409 },
        );
      }
      // 限流：带 retryAfterSeconds，验证我们按服务端给的秒数等
      if (leaseRateLimits > 0) {
        leaseRateLimits--;
        return new Response(
          JSON.stringify({ error: { code: "rate_limited", retryable: true, retryAfterSeconds: 0.05 } }),
          { status: 429, headers: { "Retry-After": "1" } },
        );
      }
      if (machineState[m[1]] !== "running") {
        return new Response(JSON.stringify({ error: "machine_not_running" }), { status: 409 });
      }
      return Response.json({ expiresAt: new Date(Date.now() + 900_000).toISOString() });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
  }

  m = /^\/v1\/machines\/([^/]+)\/(resume|start|stop|suspend|pause|wake)$/.exec(path);
  if (m && method === "POST") {
    const type = m[2];
    const cur = own.find((x) => x.id === m[1]);
    lifecycleKeys.push({ type, id: m[1], key: init.headers?.["Idempotency-Key"] || "" });
    // 402 early_allowance_ended：免费额度用完，启动被拒（不可重试）
    if (lifecycle402 > 0) {
      lifecycle402--;
      return new Response(
        JSON.stringify({ error: { code: "early_allowance_ended", retryable: false, message: "free allowance ended" } }),
        { status: 402 },
      );
    }
    // 另一个操作正在跑：官方要求等它结束后用**新的** Idempotency-Key 重试
    if (lifecycleConflicts > 0) {
      lifecycleConflicts--;
      return new Response(
        JSON.stringify({ error: { code: "operation_conflict", retryable: true, operationId: "op_conflict" } }),
        { status: 409 },
      );
    }
    // 冷却中：官方说任何唤醒方式都会被拒，带 retryAfterSeconds。
    // reason 只有安全审查锁（abuse_*）才有，max-run 冷却没有这个字段。
    if (cooldowns[m[1]] && type !== "stop" && type !== "suspend" && type !== "pause") {
      const extra = machineExtra[m[1]] || {};
      return new Response(
        JSON.stringify({
          error: {
            code: "machine_cooldown",
            retryable: true,
            retryAfterSeconds: cooldowns[m[1]],
            ...(extra.cooldownReason ? { reason: extra.cooldownReason } : {}),
          },
        }),
        { status: 409, headers: { "Retry-After": String(cooldowns[m[1]]) } },
      );
    }
    if (type === "wake") {
      // /wake 只认「自己空闲挂起的」机器，手动 suspend 的它不管
      if (cur && cur.state === "suspended" && cur.autoSuspendedAt) {
        machineState[m[1]] = "running";
        return Response.json({ ...cur, state: "running" }); // 200 + machine
      }
      return new Response(JSON.stringify({ error: { code: "machine_not_running", retryable: false } }), { status: 409 });
    }
    machineState[m[1]] = type === "stop" ? "stopped" : type === "suspend" || type === "pause" ? "suspended" : "running";
    // 生命周期调用一律 202 + operation（官方契约）
    return Response.json({ id: "op_" + m[1] + "_" + type, machineId: m[1], type, state: "queued", error: null }, { status: 202 });
  }

  // 操作长轮询：?wait=25s 会挂到有变化为止，这里直接回 succeeded
  m = /^\/v1\/operations\/([^/]+)$/.exec(path);
  if (m && method === "GET") {
    return Response.json({
      id: m[1],
      machineId: "m_x",
      type: "resume",
      state: "succeeded",
      error: null,
      machine: {},
    });
  }

  return new Response(JSON.stringify({ error: "not_found " + path }), { status: 404 });
};

const env = {
  INSTABOX_API_KEY: "ibk_test_key",
  INSTABOX_LEASE_TTL: "900",
  TOKEN: "secret-token",
  LOG: fakeKV(),
  CONFIG: fakeKV(),
};

const req = (path, init = {}) => new Request("https://worker.test" + path, init);
const auth = { "X-Token": "secret-token" };
const cookieOf = (res) => {
  const raw = res.headers.get("set-cookie") || "";
  const first = raw.split(";")[0];
  return first.includes("=") ? first : "";
};
const post = (path, body, headers = {}) =>
  req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

let passed = 0;
const ok = (name) => {
  passed++;
  console.log("  ✓ " + name);
};

// 1. 登录页
{
  const res = await worker.fetch(req("/login"), env);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(html, /登录/);
  ok("GET /login 返回登录页");
}

// 2. 没登录进面板 → 跳登录页
{
  const res = await worker.fetch(req("/ui", { headers: { accept: "text/html" } }), env);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/login\?next=/);
  const res2 = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env);
  assert.equal(res2.status, 302);
  ok("未登录访问 /ui 和 / → 302 到 /login");
}

// 3. ?token= 换成会话 cookie 后跳干净地址
let sessionCookie = "";
{
  const res = await worker.fetch(req("/ui?token=secret-token"), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/ui");
  sessionCookie = cookieOf(res);
  assert.match(sessionCookie, /^ibk_session=/);
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  assert.match(res.headers.get("set-cookie"), /SameSite=Lax/);

  const res2 = await worker.fetch(req("/ui", { headers: { cookie: sessionCookie } }), env);
  assert.equal(res2.status, 200);
  assert.match(await res2.text(), /InstaBox 保活面板/);
  ok("?token= 换 cookie，之后凭 cookie 直接进面板");
}

// 4. 密码登录（只有 TOKEN 时不需要用户名）
{
  const bad = await worker.fetch(post("/api/login", { password: "wrong" }, { "cf-connecting-ip": "1.1.1.1" }), env);
  assert.equal(bad.status, 401);
  const badBody = await bad.json();
  assert.match(badBody.error, /不对/);

  const good = await worker.fetch(post("/api/login", { password: "secret-token" }, { "cf-connecting-ip": "1.1.1.1" }), env);
  assert.equal(good.status, 200);
  const body = await good.json();
  assert.equal(body.ok, true);
  assert.equal(body.next, "/ui");
  const c = cookieOf(good);
  assert.match(c, /^ibk_session=/);

  const st = await worker.fetch(req("/api/state", { headers: { cookie: c } }), env);
  assert.equal(st.status, 200);
  const sj = await st.json();
  assert.equal(sj.auth.via, "session");
  ok("POST /api/login 正确/错误密码，会话可用");
}

// 5. 开放重定向被挡住
{
  const res = await worker.fetch(
    post("/api/login", { password: "secret-token", next: "//evil.com/x" }, { "cf-connecting-ip": "1.1.1.2" }),
    env,
  );
  assert.equal((await res.json()).next, "/ui");
  ok("?next= 只允许站内路径");
}

// 6. 退出登录
{
  const out = await worker.fetch(post("/api/logout", {}, { cookie: sessionCookie }), env);
  assert.equal(out.status, 200);
  const cleared = out.headers.get("set-cookie");
  assert.match(cleared, /Max-Age=0/);
  // 浏览器拿不到 cookie 之后就是未登录态
  const st = await worker.fetch(req("/api/state"), env);
  assert.equal(st.status, 401);
  ok("POST /api/logout 下发清 cookie 的响应，无 cookie 即 401");
}

// 7. 跨站 POST 被挡（CSRF）
{
  const res = await worker.fetch(
    post("/api/config", { paused: true }, { cookie: sessionCookie, origin: "https://evil.example" }),
    env,
  );
  assert.equal(res.status, 403);
  ok("跨站 Origin 的 POST → 403");
}

// 8. 用户名 + 密码模式
{
  const env2 = { ...env, ADMIN_USER: "boss", ADMIN_PASSWORD: "p@ss word" };
  const wrongUser = await worker.fetch(post("/api/login", { username: "admin", password: "p@ss word" }, { "cf-connecting-ip": "2.2.2.2" }), env2);
  assert.equal(wrongUser.status, 401);
  const good = await worker.fetch(post("/api/login", { username: "BOSS", password: "p@ss word" }, { "cf-connecting-ip": "2.2.2.2" }), env2);
  assert.equal(good.status, 200);
  const info = await (await worker.fetch(req("/api/authinfo"), env2)).json();
  assert.equal(info.needUser, true);
  assert.equal(info.kind, "password");
  ok("ADMIN_USER/ADMIN_PASSWORD 模式：用户名大小写不敏感");
}

// 9. 密码哈希模式
{
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hash-pass")))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const env3 = { ...env, ADMIN_PASSWORD_HASH: hash, TOKEN: "" };
  const good = await worker.fetch(post("/api/login", { username: "admin", password: "hash-pass" }, { "cf-connecting-ip": "2.2.2.3" }), env3);
  assert.equal(good.status, 200);
  ok("ADMIN_PASSWORD_HASH（sha256）可登录");
}

// 10. 没配任何密码 → 不设防（保持旧行为）
{
  const env4 = { ...env, TOKEN: "" };
  const res = await worker.fetch(req("/api/state"), env4);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth.via, "open");
  ok("没配密码时保持开放，auth.via=open");
}

// 11. 失败限流
{
  const ip = { "cf-connecting-ip": "3.3.3.3" };
  let last = null;
  for (let i = 0; i < 9; i++) {
    last = await worker.fetch(post("/api/login", { password: "nope" }, ip), env);
  }
  assert.equal(last.status, 429);
  // 锁定期间即使密码正确也进不去
  const good = await worker.fetch(post("/api/login", { password: "secret-token" }, ip), env);
  assert.equal(good.status, 429);
  ok("连续失败 8 次后锁定（429）");
}

// 12. 老用法：X-Token 打接口仍然通
{
  const res = await worker.fetch(req("/api/state", { headers: auth }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth.via, "token");
  ok("X-Token 仍然可用（脚本/curl 不受登录影响）");
}

// 13. 面板快照
let snapshot;
{
  const res = await worker.fetch(req("/api/state", { headers: auth }), env);
  snapshot = await res.json();
  assert.equal(snapshot.accounts.length, 1);
  assert.equal(snapshot.accounts[0].key, "ibk_…_key", "key 必须打码");
  assert.deepEqual(snapshot.machines.map((m) => [m.id, m.selected]), [["m_1", true], ["m_2", true]]);
  assert.equal(snapshot.canSave, true);
  ok("/api/state 返回账号 + 全部机器，默认全选");
}

// 13b. 没面板配置时，选中态要跟随 INSTABOX_MACHINE
// 否则设了 machine=qqq 的面板会显示「全选」，用户取消勾选时前端以全选为基准写白名单，
// 会把本来没在保活的机器一起写进去。
{
  const envByName = { ...env, INSTABOX_MACHINE: "qqq" };
  const sj = await (await worker.fetch(req("/api/state", { headers: auth }), envByName)).json();
  assert.deepEqual(
    sj.machines.map((m) => [m.id, m.selected]),
    [["m_1", true], ["m_2", false]],
    "machine 写名字时按名字匹配",
  );

  const envById = { ...env, INSTABOX_MACHINE: "m_2" };
  const sj2 = await (await worker.fetch(req("/api/state", { headers: auth }), envById)).json();
  assert.deepEqual(sj2.machines.map((m) => [m.id, m.selected]), [["m_1", false], ["m_2", true]], "machine 写 id 时按 id 匹配");
  ok("没面板配置时 selected 跟随 INSTABOX_MACHINE");
}

// 14. 改配置：只保活 m_1
{
  const res = await worker.fetch(
    post("/api/config", { accounts: { 1: { enabled: true, mode: "list", machines: ["m_1"] } } }, auth),
    env,
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.config.accounts["1"].mode, "list");
  assert.deepEqual(body.config.accounts["1"].machines, ["m_1"]);
  ok("POST /api/config 保存白名单");
}

// 15. cron 只续租勾选的那台
{
  calls = [];
  await worker.scheduled({}, env);
  const leased = calls.filter((c) => c.startsWith("PUT ") && c.includes("/activity-leases/"));
  assert.deepEqual(leased, ["PUT /v1/machines/m_1/activity-leases/keepalive"]);
  ok("scheduled 只续租被勾选的 m_1（m_2 已挂起且未勾选）");
}

// 16. 暂停后 cron 完全不动
{
  await worker.fetch(post("/api/config", { paused: true }, auth), env);
  calls = [];
  await worker.scheduled({}, env);
  assert.deepEqual(calls, []);
  ok("暂停后 scheduled 不发任何请求");
}

// 17. 手动续租不受暂停影响
{
  calls = [];
  const res = await worker.fetch(req("/api/renew", { method: "POST", headers: auth, body: "{}" }), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 1);
  assert.ok(calls.some((c) => c.startsWith("PUT ")));
  ok("手动 /api/renew 在暂停状态下仍续租");
}

// 18. 单机操作
{
  const res = await worker.fetch(
    post("/api/machine", { account: 1, id: "m_1", action: "renew" }, auth),
    env,
  );
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.expiresAt);
  ok("POST /api/machine 单台续租");
}

// 19. 未绑 CONFIG 时拒绝保存
{
  const envNoKv = { ...env, CONFIG: undefined };
  const res = await worker.fetch(post("/api/config", { paused: false }, auth), envNoKv);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /CONFIG/);
  ok("没绑 CONFIG 时保存返回 400 且提示绑 KV");
}

// 20. 老用法：curl 打 / 仍然是续租
{
  const json = await worker.fetch(req("/?token=secret-token", { headers: { accept: "*/*" } }), env);
  assert.match(json.headers.get("content-type"), /application\/json/);
  ok("curl 打 / 仍是续租（Accept 分流不变）");
}

// 21. 配置写回后状态里体现出来
{
  const res = await worker.fetch(req("/api/state", { headers: auth }), env);
  const body = await res.json();
  assert.equal(body.paused, true);
  assert.equal(body.accounts[0].conf.mode, "list");
  assert.equal(body.machines.find((m) => m.id === "m_2").selected, false);
  assert.ok(body.liveAt, "应该记录过最近一次续租");
  ok("/api/state 反映配置与最近续租时间");
}

// 22. 5xx 自动重试（PUT 幂等，重试安全）
{
  leaseFailures = 1;
  calls = [];
  const res = await worker.fetch(
    post("/api/machine", { account: 1, id: "m_1", action: "renew" }, auth),
    env,
  );
  const body = await res.json();
  assert.equal(body.ok, true, "第一次 503，重试后应该成功");
  const puts = calls.filter((c) => c.startsWith("PUT ") && c.includes("m_1"));
  assert.equal(puts.length, 2, "应该发了两次 PUT（一次 503 + 一次重试）");
  ok("API 返回 5xx 时自动重试");
}

// 23. 失败告警：连续 N 次才发、限频、恢复补一条
{
  const envA = {
    ...env,
    INSTABOX_API_KEY: "ibk_bad",
    ALERT_WEBHOOK: "https://hook.test/text",
    ALERT_AFTER: "2",
    ALERT_MIN_INTERVAL: "3600",
    CONFIG: fakeKV(),
    LOG: fakeKV(),
  };
  hooks = [];
  await worker.scheduled({}, envA);
  assert.equal(hooks.length, 0, "第一次失败不该发（ALERT_AFTER=2）");

  await worker.scheduled({}, envA);
  assert.equal(hooks.length, 1, "第二次失败应该发");
  assert.match(hooks[0].body.text, /保活失败/);
  assert.match(hooks[0].body.text, /401|列机器失败/);

  await worker.scheduled({}, envA);
  assert.equal(hooks.length, 1, "同一故障在限频窗口内不重复发");

  const envB = { ...envA, INSTABOX_API_KEY: "ibk_test_key" };
  await worker.scheduled({}, envB);
  assert.equal(hooks.length, 2, "恢复时要补一条");
  assert.match(hooks[1].body.text, /恢复/);
  ok("告警：连续失败触发、限频、恢复通知");
}

// 24. 告警 body 兼容飞书/钉钉
{
  const envF = { ...env, INSTABOX_API_KEY: "ibk_bad", ALERT_WEBHOOK: "https://hook.test/feishu", ALERT_FORMAT: "feishu", CONFIG: fakeKV() };
  const envD = { ...env, INSTABOX_API_KEY: "ibk_bad", ALERT_WEBHOOK: "https://hook.test/dingtalk", ALERT_FORMAT: "dingtalk", CONFIG: fakeKV() };
  hooks = [];
  await worker.scheduled({}, envF);
  await worker.scheduled({}, envD);
  assert.equal(hooks[0].body.msg_type, "text");
  assert.match(hooks[0].body.content.text, /保活失败/);
  assert.equal(hooks[1].body.msgtype, "text");
  assert.match(hooks[1].body.text.content, /保活失败/);
  ok("告警格式兼容飞书（msg_type）/钉钉与企业微信（msgtype）");
}

// 25. 后台改用户名 / 密码
{
  const envAcc = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };

  // 当前密码不对 → 401
  let r = await worker.fetch(post("/api/account", { currentPassword: "nope", user: "admin", password: "newpass123" }, auth), envAcc);
  assert.equal(r.status, 401);

  // 新密码太短 → 400
  r = await worker.fetch(post("/api/account", { currentPassword: "secret-token", user: "admin", password: "123" }, auth), envAcc);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /8 位/);

  // 用户名非法 → 400
  r = await worker.fetch(post("/api/account", { currentPassword: "secret-token", user: "a b", password: "newpass123" }, auth), envAcc);
  assert.equal(r.status, 400);

  // 正常改：用户名 + 密码
  r = await worker.fetch(post("/api/account", { currentPassword: "secret-token", user: "boss", password: "newpass123" }, auth), envAcc);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.changedPassword, true);
  assert.equal(body.user, "boss");
  const fresh = cookieOf(r);
  assert.match(fresh, /^ibk_session=/, "改完密码要给当前浏览器换一张新票");

  // 新票可用，且 state 里能看到新用户名和来源
  const st = await worker.fetch(req("/api/state", { headers: { cookie: fresh } }), envAcc);
  assert.equal(st.status, 200);
  const sj = await st.json();
  assert.equal(sj.auth.user, "boss");
  assert.equal(sj.auth.source, "kv");

  // 旧密码（TOKEN）不能登录了，新密码可以；旧用户名也不行
  const oldPass = await worker.fetch(post("/api/login", { username: "boss", password: "secret-token" }, { "cf-connecting-ip": "5.5.5.5" }), envAcc);
  assert.equal(oldPass.status, 401);
  const newPass = await worker.fetch(post("/api/login", { username: "BOSS", password: "newpass123" }, { "cf-connecting-ip": "5.5.5.5" }), envAcc);
  assert.equal(newPass.status, 200);
  const oldUser = await worker.fetch(post("/api/login", { username: "admin", password: "newpass123" }, { "cf-connecting-ip": "5.5.5.6" }), envAcc);
  assert.equal(oldUser.status, 401);

  ok("改用户名/密码：校验当前密码、新凭据生效、旧凭据失效、会话续签");
}

// 26. 没绑 CONFIG 时不让改
{
  const envNoKv = { ...env, CONFIG: undefined };
  const r = await worker.fetch(post("/api/account", { currentPassword: "secret-token", password: "newpass123" }, auth), envNoKv);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /CONFIG/);
  ok("没绑 CONFIG 时改账号返回 400");
}

// 27. 写接口一律 POST-only
{
  const g1 = await worker.fetch(req("/api/renew", { headers: auth }), env);
  assert.equal(g1.status, 405, "GET /api/renew 应该 405");
  const g2 = await worker.fetch(req("/api/release", { headers: auth }), env);
  assert.equal(g2.status, 405, "GET /api/release 应该 405");
  const g3 = await worker.fetch(req("/api/config", { headers: auth }), env);
  assert.equal(g3.status, 405, "GET /api/config 应该 405");
  ok("写接口 GET 一律 405");
}

// 28. 旧 /release：token 可用 GET，浏览器会话必须 POST
{
  const byToken = await worker.fetch(req("/release?token=secret-token"), env);
  assert.equal(byToken.status, 200);

  const login = await worker.fetch(post("/api/login", { password: "secret-token" }, { "cf-connecting-ip": "7.7.7.1" }), env);
  const c = cookieOf(login);
  const byCookie = await worker.fetch(req("/release", { headers: { cookie: c } }), env);
  assert.equal(byCookie.status, 405, "cookie 会话不能用 GET /release");

  const byCookiePost = await worker.fetch(
    req("/release", { method: "POST", headers: { cookie: c, "Content-Type": "application/json" }, body: "{}" }),
    env,
  );
  assert.equal(byCookiePost.status, 200);
  ok("旧 /release：token 走 GET，会话走 POST");
}

// 29. 浏览器会话不能用 GET / 触发续租
{
  const login = await worker.fetch(post("/api/login", { password: "secret-token" }, { "cf-connecting-ip": "7.7.7.2" }), env);
  const c = cookieOf(login);
  const res = await worker.fetch(req("/", { headers: { cookie: c, accept: "*/*" } }), env);
  assert.equal(res.status, 405);
  ok("cookie 会话 GET / 被拒（防跨站顶层导航触发写）");
}

// 30. 没配密码时默认只读
{
  const openEnv = { ...env, TOKEN: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const write = await worker.fetch(post("/api/config", { paused: true }, {}), openEnv);
  assert.equal(write.status, 403);
  assert.match((await write.json()).error, /只读/);

  // 读接口仍然开放（面板能看）
  const read = await worker.fetch(req("/api/state"), openEnv);
  assert.equal(read.status, 200);

  // 显式 ALLOW_PUBLIC=1 才放开
  const allowed = await worker.fetch(post("/api/config", { paused: true }, {}), { ...openEnv, ALLOW_PUBLIC: "1" });
  assert.equal(allowed.status, 200);
  ok("未配置密码时写操作默认 403，ALLOW_PUBLIC=1 才放开");
}

// 31. release 尊重面板筛选（不再一把放光）
{
  const relEnv = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.fetch(
    post("/api/config", { accounts: { 1: { enabled: true, mode: "list", machines: ["m_1"] } } }, auth),
    relEnv,
  );
  calls = [];
  const res = await worker.fetch(req("/api/release", { method: "POST", headers: auth, body: "{}" }), relEnv);
  assert.equal(res.status, 200);
  const dels = calls.filter((c) => c.startsWith("DELETE "));
  assert.deepEqual(dels, ["DELETE /v1/machines/m_1/activity-leases/keepalive"]);
  ok("release 只放被勾选的机器");
}

// 32. 手动单机操作会刷新面板的 live 快照
{
  const liveEnv = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.scheduled({}, liveEnv); // 先跑一轮，live 里只有 m_1（m_2 挂起）
  const before = await (await worker.fetch(req("/api/state", { headers: auth }), liveEnv)).json();
  const beforeExp = before.machines.find((m) => m.id === "m_1").expiresAt;
  assert.ok(beforeExp);

  machineState.m_1 = "running";
  await new Promise((r) => setTimeout(r, 5));
  const r = await worker.fetch(post("/api/machine", { account: 1, id: "m_1", action: "renew" }, auth), liveEnv);
  assert.equal((await r.json()).ok, true);

  const after = await (await worker.fetch(req("/api/state", { headers: auth }), liveEnv)).json();
  assert.ok(after.machines.find((m) => m.id === "m_1").expiresAt, "续租后 live 应该更新");
  ok("单机续租后 live 快照立即更新");
}

// 33. 告警发不出去时不能记成「已发送」
{
  const origFetch = globalThis.fetch;
  const envFail = {
    ...env,
    INSTABOX_API_KEY: "ibk_bad",
    ALERT_WEBHOOK: "https://hook.test/dead",
    ALERT_AFTER: "1",
    ALERT_MIN_INTERVAL: "3600",
    CONFIG: fakeKV(),
    LOG: fakeKV(),
  };
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "hook.test") {
      attempts++;
      return new Response("boom", { status: 500 });
    }
    return origFetch(input, init);
  };
  await worker.scheduled({}, envFail); // 第 1 轮：失败，告警发送失败
  await worker.scheduled({}, envFail); // 第 2 轮：应该再试（没被限频吞掉）
  globalThis.fetch = origFetch;
  assert.equal(attempts, 2, "发送失败后下一轮应该重试，而不是被限频");
  ok("告警发送失败不会记成已发送（下一轮重试）");
}

// 34. 安全响应头 + 请求体上限
{
  const page = await worker.fetch(req("/login"), env);
  assert.match(page.headers.get("content-security-policy") || "", /default-src 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  const js = await worker.fetch(req("/api/state", { headers: auth }), env);
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");

  const huge = "x".repeat(20 * 1024);
  const big = await worker.fetch(
    req("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: huge }) }),
    env,
  );
  assert.ok(big.status === 400 || big.status === 401, "超大 body 不能 500");
  ok("CSP/X-Frame-Options 已下发，超大 body 被拒");
}

// 35. KV 读配置失败 → 跳过本轮，不写回空配置
{
  const brokenKv = fakeKV({ failGet: (k) => k === "config" });
  const envKv = { ...env, CONFIG: brokenKv, LOG: fakeKV() };
  calls = [];
  const out = await worker.scheduled({}, envKv);
  assert.ok(calls.filter((c) => c.startsWith("PUT ")).length === 0, "读配置失败时不该发续租请求");

  const st = await worker.fetch(req("/api/state", { headers: auth }), envKv);
  const sj = await st.json();
  assert.ok(sj.warnings.some((w) => /读配置失败/.test(w.error)), "面板要能看到配置读取失败");

  // 写接口也要拒绝，别把空配置覆盖上去
  const save = await worker.fetch(post("/api/config", { paused: true }, auth), envKv);
  assert.equal(save.status, 400);
  assert.match((await save.json()).error, /没有保存/);
  ok("KV 读配置失败：跳过续租、拒绝保存、面板可见");
}

// 36. 配置不是合法 JSON → 同样跳过
{
  const kv = fakeKV();
  kv._map.set("config", "{不是 JSON");
  const out = await worker.fetch(post("/api/renew", {}, { ...auth }), { ...env, CONFIG: kv, LOG: fakeKV() });
  assert.equal(out.status, 502);
  assert.match((await out.json()).error, /合法 JSON/);
  ok("配置损坏时跳过而不是当成空配置");
}

// 37. 账号记录读不出来 → fail-closed（环境变量里的旧密码不能复活）
{
  const kv = fakeKV({ failGet: (k) => k === "auth" });
  const envBroken = { ...env, CONFIG: kv, LOG: fakeKV(), ADMIN_PASSWORD: "envpass", TOKEN: "" };
  const login = await worker.fetch(
    post("/api/login", { username: "admin", password: "envpass" }, { "cf-connecting-ip": "8.8.8.1" }),
    envBroken,
  );
  assert.equal(login.status, 503, "KV 挂了不能退回环境变量密码");

  const info = await (await worker.fetch(req("/api/authinfo"), envBroken)).json();
  assert.equal(info.kind, "broken");
  ok("账号记录读失败时 fail-closed（503，旧密码不复活）");
}

// 38. 账号记录迭代次数越界 → 视为坏记录
{
  const kv = fakeKV();
  kv._map.set("auth", JSON.stringify({ v: 1, user: "admin", iter: 999999, salt: "s", hash: "h" }));
  const envBad = { ...env, CONFIG: kv, LOG: fakeKV(), ADMIN_PASSWORD: "envpass", TOKEN: "" };
  const info = await (await worker.fetch(req("/api/authinfo"), envBad)).json();
  assert.equal(info.kind, "broken");
  const login = await worker.fetch(
    post("/api/login", { username: "admin", password: "envpass" }, { "cf-connecting-ip": "8.8.8.2" }),
    envBad,
  );
  assert.equal(login.status, 503);
  ok("迭代次数越界的账号记录被拒绝（不会打爆 CPU）");
}

// 39. authinfo.kind 在 KV 认证下应报 password
{
  const kv = fakeKV();
  const envKv = { ...env, CONFIG: kv, LOG: fakeKV() };
  await worker.fetch(
    post("/api/account", { currentPassword: "secret-token", user: "admin", password: "newpass123" }, auth),
    envKv,
  );
  const info = await (await worker.fetch(req("/api/authinfo"), envKv)).json();
  assert.equal(info.kind, "password", "存在 KV 账号时 kind 必须是 password");
  assert.equal(info.needUser, true);
  ok("/api/authinfo 在 KV 认证下返回 kind=password");
}

// 40. /api/account 也限流
{
  const envKv = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const ip = { "cf-connecting-ip": "9.9.9.9" };
  let last = null;
  for (let i = 0; i < 7; i++) {
    last = await worker.fetch(post("/api/account", { currentPassword: "wrong", password: "newpass123" }, { ...auth, ...ip }), envKv);
  }
  assert.equal(last.status, 429);
  ok("/api/account 连续试错会被限流");
}

// 41. 批量释放后 live 里的到期时间被清掉
{
  const kv = fakeKV();
  const envRel = { ...env, CONFIG: kv, LOG: fakeKV() };
  machineState.m_1 = "running";
  await worker.scheduled({}, envRel);
  const before = await (await worker.fetch(req("/api/state", { headers: auth }), envRel)).json();
  assert.ok(before.machines.find((m) => m.id === "m_1").expiresAt);

  await worker.fetch(req("/api/release", { method: "POST", headers: auth, body: "{}" }), envRel);
  const after = await (await worker.fetch(req("/api/state", { headers: auth }), envRel)).json();
  assert.equal(after.machines.find((m) => m.id === "m_1").expiresAt, null, "释放后不该再显示旧到期时间");
  ok("批量释放后 live 快照同步清空");
}

// 42. 清空日志
{
  const envLog = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.scheduled({}, envLog);
  const before = await (await worker.fetch(req("/log", { headers: auth }), envLog)).json();
  assert.ok(before.count > 0, "先得有一条日志");

  const getRes = await worker.fetch(req("/api/log/clear", { headers: auth }), envLog);
  assert.equal(getRes.status, 405, "清空日志只收 POST");

  const res = await worker.fetch(post("/api/log/clear", {}, auth), envLog);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.cleared > 0, "要告诉清掉了多少条");

  const after = await (await worker.fetch(req("/log", { headers: auth }), envLog)).json();
  assert.equal(after.count, 0, "清空后 /log 应为空");
  ok("清空日志：POST-only、返回条数、/log 归零");
}

// 43. 没绑 LOG KV 时清空要报错，别假装成功
{
  const noLog = { ...env, LOG: undefined, CONFIG: fakeKV() };
  const res = await worker.fetch(post("/api/log/clear", {}, auth), noLog);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /LOG KV/);
  ok("没绑 LOG KV 时清空日志返回 400");
}

// 44. 只读模式下不能清空日志
{
  const openEnv = { ...env, TOKEN: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const res = await worker.fetch(post("/api/log/clear", {}, {}), openEnv);
  assert.equal(res.status, 403);
  ok("未配置密码时清空日志被拒（只读）");
}

// 45. 按账号手动续租不能抹掉其它账号的 live 快照
// 以前 recordLive 整表替换：POST /api/renew?account=2 之后，1 号账号的倒计时
// 会立刻变成空，直到下一轮全量 cron 才恢复。
{
  const kv = fakeKV();
  const multi = { ...env, INSTABOX_API_KEY: "ibk_test_key,ibk_second", CONFIG: kv, LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  machineState.m_3 = "running";

  await worker.scheduled({}, multi);
  const before = await (await worker.fetch(req("/api/state", { headers: auth }), multi)).json();
  assert.deepEqual(before.machines.map((m) => m.account), [1, 1, 2], "两个账号都要在面板里");
  assert.ok(before.machines.every((m) => m.expiresAt), "全量一轮后三台机器都有到期时间");

  await worker.fetch(req("/api/renew?account=2", { method: "POST", headers: auth, body: "{}" }), multi);
  const after = await (await worker.fetch(req("/api/state", { headers: auth }), multi)).json();
  assert.deepEqual(
    after.machines.map((m) => [m.account, m.id, !!m.expiresAt]),
    [[1, "m_1", true], [1, "m_2", true], [2, "m_3", true]],
    "account=2 的续租不能清掉 1 号账号的到期时间",
  );
  ok("account 限定续租保留其它账号的 live 快照");
}

// 预算不够做完整唤醒时，别开这个头：以前会先花掉几个请求、机器醒了却没额度续租，
// 结果「唤醒成功、保活失败」，下一轮又挂。现在直接跳过并在结果里说明原因。
{
  machineState.m_1 = "running";
  machineState.m_2 = "suspended";
  const before = calls.length;
  // 预算 10（SUBREQUEST_LIMIT 的下限）：用名字点名两台机器要 2 次 GET（用 m_ id 会走
  // 本地短路，不花请求），加两次续租一共 4，剩 6 —— 不够一次完整唤醒（WAKE_COST = 8）。
  const tight = { ...env, INSTABOX_MACHINE: "qqq,box2", SUBREQUEST_LIMIT: "10", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(post("/api/renew", {}, auth), tight)).json();
  const made = calls.slice(before);
  assert.ok(
    !made.some((c) => c.startsWith("POST /v1/machines/m_2/resume")),
    "预算不够时不该发出唤醒请求",
  );
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.equal(m2.ok, false);
  assert.match(m2.error, /预算/, "结果里要说清是预算不够，而不是笼统失败");
  ok("唤醒前先看子请求预算，不够就不开这个头");
}

// 官方文档（docs/idle-suspend）把「唤醒」分成两条路：
//   自己空闲挂起的（autoSuspendedAt 有值）→ POST /wake，服务端替我们等最多 45 秒
//   你手动 suspend 的                     → /wake 不管用，必须 /resume
// 以前一律 resume 再 start 兜底，既多打一次没用的请求，也要自己 sleep 轮询六次。
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "suspended";
  autoPaused.add("m_2");
  const before = calls.length;
  await worker.scheduled({}, e);
  const made = calls.slice(before);
  assert.ok(made.includes("POST /v1/machines/m_2/wake"), "自己挂起的机器要走官方 /wake");
  assert.ok(!made.some((c) => c.includes("/m_2/resume")), "走了 /wake 就不该再 resume");
  assert.equal(machineState.m_2, "running");
  autoPaused.delete("m_2");
  ok("空闲挂起的机器走 /wake（一次请求顶六次轮询）");
}

// 手动 suspend 的机器 /wake 不认，得 resume；而且 resume 返回的是 operation，
// 必须等它 succeeded 再续租，不能靠猜状态。
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  autoPaused.delete("m_2");
  machineState.m_2 = "suspended";
  const before = calls.length;
  await worker.scheduled({}, e);
  const made = calls.slice(before);
  assert.ok(made.includes("POST /v1/machines/m_2/resume"), "手动挂起的要用 resume");
  assert.ok(!made.some((c) => c.includes("/m_2/wake")), "手动挂起的机器不该走 /wake");
  assert.ok(
    made.some((c) => c.startsWith("GET /v1/operations/")),
    "生命周期调用返回 operation，要等它跑完再续租",
  );
  assert.equal(machineState.m_2, "running");
  ok("手动挂起的机器走 resume，并等 operation 完成");
}

// machine_cooldown：平台让机器休息（max-run 到点 / 安全审查锁住），官方给的是分钟级。
// 在请求内重试毫无意义 —— 以前会白扔两次请求还是失败，现在直接上报冷却时长。
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_2 = "suspended";
  cooldowns.m_2 = 300;
  const before = calls.length;
  const out = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  const made = calls.slice(before);
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.equal(m2.cooling, 300, "结果里要带冷却剩余秒数");
  assert.match(m2.error, /冷却/);
  assert.equal(
    made.filter((c) => c.startsWith("POST /v1/machines/m_2/")).length,
    1,
    "冷却不该在请求内重试（白花子请求）",
  );
  delete cooldowns.m_2;
  ok("machine_cooldown 不再盲重试，改成上报冷却时长");
}

// 冷却不是故障：只有冷却、没有别的失败时不该发告警 ——
// 否则免费版每天跑满 8 小时后会连着几小时每 30 分钟弹一条。
{
  machineState.m_2 = "suspended";
  cooldowns.m_2 = 600;
  hooks.length = 0;
  const e = {
    ...env,
    INSTABOX_MACHINE: "",
    ALERT_WEBHOOK: "https://hook.test/alert",
    CONFIG: fakeKV(),
    LOG: fakeKV(),
  };
  await worker.scheduled({}, e);
  assert.equal(hooks.length, 0, "冷却期间不该报警");
  delete cooldowns.m_2;
  ok("冷却期间不告警（不把平台限制当故障）");
}

// /status 顺手带上 cooldownUntil / maxRunMinutes，排查「为什么叫不醒」时能一眼看到
{
  machineState.m_2 = "suspended";
  cooldowns.m_2 = 900;
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(req("/status", { headers: auth }), e)).json();
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.ok(m2.cooldownUntil, "/status 要带 cooldownUntil");
  assert.equal(m2.autoSuspendedAt, null, "手动挂起的不该有 autoSuspendedAt");
  delete cooldowns.m_2;
  ok("/status 带 cooldownUntil，看得出是不是在冷却");
}

// 账号记录（KV auth）在 isolate 内缓存 60 秒：每个请求都读一次太浪费，
// 但改完密码必须立刻生效 —— 靠写后作废缓存保证。
{
  const kv = fakeKV();
  const e = { ...env, CONFIG: kv, LOG: fakeKV(), TOKEN: "secret-token" };
  await worker.fetch(req("/api/state", { headers: auth }), e);
  assert.ok(kv.authReads > 0, "第一次请求应该读 KV 里的 auth");
  kv.authReads = 0;
  await worker.fetch(req("/api/state", { headers: auth }), e);
  assert.equal(kv.authReads, 0, "第二次请求不该再读 KV 里的 auth");

  const r = await worker.fetch(post("/api/account", { currentPassword: "secret-token", user: "admin", password: "newpass123" }, auth), e);
  assert.equal(r.status, 200);
  // 改完立刻用新密码登录：缓存必须已经被作废，否则旧记录还会命中 60 秒
  const login = await worker.fetch(post("/api/login", { username: "admin", password: "newpass123" }, { "cf-connecting-ip": "9.9.9.9" }), e);
  assert.equal(login.status, 200, "改密码后新凭据必须立刻可用");
  ok("auth 记录 isolate 内缓存，改密码后立即失效");
}

// 平台正在变状态时回 409 operation_conflict（另一个操作在跑），和 machine_not_running
// 不是一回事。以前这种既没重试也没唤醒，直接记一条失败 —— 「偶发续租失败」的主要来源。
{
  const e = { ...env, INSTABOX_MACHINE: "m_1", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  leaseConflicts = 1;
  const before = calls.length;
  const body = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  const puts = calls.slice(before).filter((c) => c.includes("activity-leases")).length;
  assert.equal(body.ok, true, "operation_conflict 应该被重试掉，不该记成失败");
  assert.equal(puts, 2, "第一次 409 + 第二次成功");
  ok("409 operation_conflict 会重试，不再记成失败");
}

// 429 带 retryAfterSeconds：按服务端给的秒数等，而不是固定 400ms 硬撞
{
  const e = { ...env, INSTABOX_MACHINE: "m_1", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  leaseRateLimits = 1;
  const before = calls.length;
  const t0 = Date.now();
  const body = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  const ms = Date.now() - t0;
  const puts = calls.slice(before).filter((c) => c.includes("activity-leases")).length;
  assert.equal(body.ok, true);
  assert.equal(puts, 2);
  assert.ok(ms >= 40, "应该等过 retryAfterSeconds（50ms），而不是立刻重试");
  ok("429 按 retryAfterSeconds 等待后再重试");
}

// ---- 保活区间 ----------------------------------------------------------------
// 区间按北京时间算，测试里不能改系统时钟，就反过来构造一个「包含/不包含现在」的窗口。
const bjNowMin = () => {
  const d = new Date();
  return (((d.getUTCHours() * 60 + d.getUTCMinutes() + 480) % 1440) + 1440) % 1440;
};

// 从现在起 2 小时后的一小时窗口：现在一定在外面（跨午夜就挪到 2 小时前）
function windowExcludingNow() {
  const m = bjNowMin();
  let s = (m + 120) % 1440;
  let e = (m + 180) % 1440;
  if (s > e) {
    s = (m - 180 + 1440) % 1440;
    e = (m - 120 + 1440) % 1440;
  }
  return { start: s, end: e };
}

// 现在前后各 30 分钟：现在一定在里面（允许跨午夜）
function windowIncludingNow() {
  const m = bjNowMin();
  return { start: (m - 30 + 1440) % 1440, end: (m + 30) % 1440 };
}

const winConf = (win) => JSON.stringify({ v: 1, paused: false, window: win, accounts: {} });

// 区间外：cron 不续租，并且把运行状态记成 idle
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const w = windowExcludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ...w, maxMin: 0 }));
  const before = calls.length;
  const out = await worker.scheduled({}, e);
  const made = calls.slice(before);
  assert.ok(!made.some((c) => c.startsWith("PUT /v1/machines/")), "区间外不该续租");
  assert.equal(JSON.parse(e.CONFIG._map.get("win")).phase, "idle");
  ok("保活区间外不续租，状态记为 idle");
}

// 从「保活中」滑出区间：主动放一次租约，之后不再重复放
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const w = windowExcludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ...w, maxMin: 0 }));
  e.CONFIG._map.set("win", JSON.stringify({ phase: "keep", startedAt: new Date().toISOString() }));
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.ok(
    calls.slice(before).some((c) => c.startsWith("DELETE /v1/machines/") && c.includes("activity-leases")),
    "刚出区间要主动放租约，别让机器干等 TTL 过期",
  );
  const before2 = calls.length;
  await worker.scheduled({}, e);
  assert.ok(
    !calls.slice(before2).some((c) => c.includes("activity-leases")),
    "第二轮不该再重复放租约（白花请求）",
  );
  ok("滑出区间时放一次租约，之后不重复");
}

// 区间内：照常续租
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const w = windowIncludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ...w, maxMin: 0 }));
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.equal(leased.length, 2, "区间内两台都要续租");
  assert.equal(JSON.parse(e.CONFIG._map.get("win")).phase, "keep");
  ok("保活区间内照常续租");
}

// 单次上限：全天保活 + 上限 30 分钟，startedAt 已经是 40 分钟前 → 触顶
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", winConf({ on: false, start: 0, end: 0, maxMin: 30 }));
  e.CONFIG._map.set(
    "win",
    JSON.stringify({ phase: "keep", startedAt: new Date(Date.now() - 40 * 60000).toISOString() }),
  );
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.ok(!calls.slice(before).some((c) => c.startsWith("PUT /v1/machines/")), "到上限了不该再续租");
  assert.equal(JSON.parse(e.CONFIG._map.get("win")).phase, "capped");
  ok("单次保活上限到点就停（capped）");
}

// 状态没有变化时，第二轮 cron 不写 win 键
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  fakeKVPutCount = 0;
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const fixed = new Date().toISOString();
  e.CONFIG._map.set("config", winConf({ on: false, start: 0, end: 0, maxMin: 0 }));
  e.CONFIG._map.set("win", JSON.stringify({
    phase: "keep",
    startedAt: fixed,
    at: fixed,
    machines: {
      "1:m_1": { phase: "keep", startedAt: fixed, at: fixed, source: "default" },
      "1:m_2": { phase: "keep", startedAt: fixed, at: fixed, source: "default" },
    },
  }));
  await worker.scheduled({}, e);
  const writesAfterFirst = fakeKVPutCount;
  await worker.scheduled({}, e);
  assert.equal(fakeKVPutCount, writesAfterFirst, "状态没变化时第二轮不应写 win");
  ok("无变化的 cron 轮次不重复写 win 键");
}

// 触顶后再跑第二轮仍然 capped，不能重新计时
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", winConf({ on: false, start: 0, end: 0, maxMin: 30 }));
  e.CONFIG._map.set(
    "win",
    JSON.stringify({ phase: "keep", startedAt: new Date(Date.now() - 40 * 60000).toISOString() }),
  );
  const before1 = calls.length;
  await worker.scheduled({}, e);
  assert.ok(!calls.slice(before1).some((c) => c.startsWith("PUT /v1/machines/")), "第一轮已经触顶");
  const before2 = calls.length;
  await worker.scheduled({}, e);
  assert.ok(!calls.slice(before2).some((c) => c.startsWith("PUT /v1/machines/")), "触顶状态必须跨轮保持");
  assert.equal(JSON.parse(e.CONFIG._map.get("win")).phase, "capped");
  ok("触顶后第二轮仍然 capped，不会重新计时");
}

// 机器 id 作为对象键时拒绝原型相关保留字
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const r = await worker.fetch(post("/api/config", { machine: { account: 1, id: "__proto__", window: { on: true } } }, auth), e);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /机器 id/);
  ok("非法机器 id 不会污染配置对象");
}

// 上限没到：继续保活
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", winConf({ on: false, start: 0, end: 0, maxMin: 120 }));
  e.CONFIG._map.set(
    "win",
    JSON.stringify({ phase: "keep", startedAt: new Date(Date.now() - 10 * 60000).toISOString() }),
  );
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.equal(
    calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/")).length,
    2,
    "上限没到要继续续租",
  );
  ok("单次上限没到，照常续租");
}

// 手动触发不受区间限制（人就在旁边按的）
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const w = windowExcludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ...w, maxMin: 0 }));
  const before = calls.length;
  const out = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  assert.ok(out.ok);
  assert.ok(
    calls.slice(before).some((c) => c.startsWith("PUT /v1/machines/")),
    "手动续租不该被区间挡住",
  );
  ok("手动「全部续租」不受保活区间限制");
}

// /api/config 能改区间，并且会清掉旧的运行状态（否则新上限会立刻触顶）
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  e.CONFIG._map.set("win", JSON.stringify({ phase: "keep", startedAt: "2026-01-01T00:00:00Z" }));
  const res = await worker.fetch(
    post("/api/config", { window: { on: true, start: 540, end: 1080, maxMin: 120 } }, auth),
    e,
  );
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  // 旧格式 { start, end } 写进来，存下去统一成 ranges（多区间用的新结构）
  assert.deepEqual(conf.window, { on: true, ranges: [{ start: 540, end: 1080 }], maxMin: 120 });
  assert.equal(e.CONFIG._map.get("win"), undefined, "改区间要清掉旧的 startedAt");
  ok("/api/config 能改保活区间（旧 start/end 自动转成 ranges），并清掉旧计时");
}

// 改默认区间只重置继承默认的机器，不碰显式单机覆盖的计时
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  e.CONFIG._map.set("config", JSON.stringify({
    v: 2,
    paused: false,
    window: { on: true, ...windowIncludingNow(), maxMin: 0 },
    accounts: {
      1: {
        enabled: true, inheritSelection: true, mode: "all", machines: [], skip: [],
        windows: { m_1: { on: true, ...windowIncludingNow(), maxMin: 60 } },
      },
    },
  }));
  const started = new Date(Date.now() - 20 * 60000).toISOString();
  e.CONFIG._map.set("win", JSON.stringify({
    phase: "keep",
    startedAt: started,
    machines: {
      "1:m_1": { phase: "keep", startedAt: started, source: "machine" },
      "1:m_2": { phase: "keep", startedAt: started, source: "default" },
    },
  }));
  await worker.fetch(post("/api/config", { window: { on: true, ...windowExcludingNow(), maxMin: 0 } }, auth), e);
  const state = JSON.parse(e.CONFIG._map.get("win"));
  assert.equal(state.machines["1:m_1"] && state.machines["1:m_1"].startedAt, started, "单机自定义计时应保留");
  assert.equal(state.machines["1:m_2"], undefined, "继承默认的计时应被清掉");
  ok("改默认区间只重置继承默认的机器");
}

// /api/state 把区间状态给面板
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  e.CONFIG._map.set("config", winConf({ on: true, ...windowExcludingNow(), maxMin: 60 }));
  const out = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(out.window.on, true);
  assert.equal(out.window.maxMin, 60);
  assert.equal(out.window.phase, "idle");
  assert.match(out.window.nowAt, /^\d{2}:\d{2}$/);
  ok("/api/state 带保活区间状态（面板要用）");
}

// ---- 多段保活区间 --------------------------------------------------------------
// 一台机器一天可以有多段时间（上午 + 下午），任意一段命中就续租；
// 段与段之间机器会休眠，所以换段要重新计单次上限。

// 并集：第一段排除现在、第二段包含现在 → 仍然要续租
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const inc = windowIncludingNow();
  const exc = windowExcludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ranges: [exc, inc], maxMin: 0 }));
  const before = calls.length;
  await worker.scheduled({}, e);
  const made = calls.slice(before);
  assert.ok(made.some((c) => c.startsWith("PUT /v1/machines/")), "任意一段命中就该续租");
  ok("多段区间取并集：第二段命中就续租");
}

// 全不命中才跳过
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const a = windowExcludingNow();
  const b = { start: (a.start + 60) % 1440, end: (a.end + 60) % 1440 };
  e.CONFIG._map.set("config", winConf({ on: true, ranges: [a, b], maxMin: 0 }));
  const before = calls.length;
  await worker.scheduled({}, e);
  const made = calls.slice(before);
  assert.ok(!made.some((c) => c.startsWith("PUT /v1/machines/")), "两段都不含现在就不该续租");
  ok("多段区间全不命中才跳过");
}

// 换段重置计时：上一段已经 capped，这一段的 seg 不同 → 应该重新开始
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const inc = windowIncludingNow();
  e.CONFIG._map.set("config", winConf({ on: true, ranges: [inc], maxMin: 30 }));
  e.CONFIG._map.set(
    "win",
    JSON.stringify({
      phase: "capped",
      startedAt: new Date(Date.now() - 60 * 60000).toISOString(),
      seg: "999-1000",
      machines: {},
    }),
  );
  const out = await worker.scheduled({}, e);
  const m1 = out.machines.find((m) => m.id === "m_1");
  assert.equal(m1.window.phase, "keep", "换段后要重新计时，不能沿用上一段的 capped");
  assert.equal(m1.window.seg, `${inc.start}-${inc.end}`);
  ok("多段之间切换会重置单次上限计时");
}

// 同一段内 capped 不能被重置（否则上限失效）
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const inc = windowIncludingNow();
  const seg = `${inc.start}-${inc.end}`;
  e.CONFIG._map.set("config", winConf({ on: true, ranges: [inc], maxMin: 30 }));
  e.CONFIG._map.set(
    "win",
    JSON.stringify({
      phase: "capped",
      startedAt: new Date(Date.now() - 60 * 60000).toISOString(),
      seg,
      machines: {},
    }),
  );
  const out = await worker.scheduled({}, e);
  assert.equal(out.machines.find((m) => m.id === "m_1").window.phase, "capped");
  ok("同一段内触顶后不会因为多段逻辑被重置");
}

// /api/config 支持多段默认区间
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const res = await worker.fetch(
    post(
      "/api/config",
      { window: { on: true, ranges: [{ start: 540, end: 720 }, { start: 840, end: 1080 }], maxMin: 60 } },
      auth,
    ),
    e,
  );
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.window.ranges, [
    { start: 540, end: 720 },
    { start: 840, end: 1080 },
  ]);
  ok("/api/config 支持多段默认区间");
}

// 重复段去重、超过 8 段截断
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const ranges = [{ start: 540, end: 720 }];
  for (let i = 1; i <= 10; i++) ranges.push({ start: 540, end: 720 }, { start: 800 + i, end: 900 + i });
  await worker.fetch(post("/api/config", { window: { on: true, ranges, maxMin: 0 } }, auth), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.window.ranges.length, 8, "最多 8 段");
  const keys = conf.window.ranges.map((r) => `${r.start}-${r.end}`);
  assert.equal(new Set(keys).size, keys.length, "重复段要去重");
  ok("多段区间去重并限制最多 8 段");
}


// 逐机器区间：同一轮里 m_1 在区间内继续续租，m_2 在区间外不续租
{
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set(
    "config",
    JSON.stringify({
      v: 2,
      paused: false,
      window: { on: false, start: 0, end: 0, maxMin: 0 },
      accounts: {
        1: {
          enabled: true,
          inheritSelection: true,
          mode: "all",
          machines: [],
          skip: [],
          windows: {
            m_1: { on: true, ...windowIncludingNow(), maxMin: 0 },
            m_2: { on: true, ...windowExcludingNow(), maxMin: 0 },
          },
        },
      },
    }),
  );
  const before = calls.length;
  await worker.scheduled({}, e);
  const made = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.deepEqual(made, ["PUT /v1/machines/m_1/activity-leases/keepalive"], "两台机器的区间必须彼此隔离");
  const win = JSON.parse(e.CONFIG._map.get("win"));
  assert.equal(win.machines["1:m_1"].phase, "keep");
  assert.equal(win.machines["1:m_2"].phase, "idle");
  ok("逐机器区间隔离：一台续租、一台不续租");
}

// 同一账号里一台自定义、一台继承默认：状态各自保留，不互相清理
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  const custom = windowIncludingNow();
  e.CONFIG._map.set(
    "config",
    JSON.stringify({
      v: 2,
      paused: false,
      window: { on: false, start: 480, end: 1380, maxMin: 0 },
      accounts: {
        1: {
          enabled: true,
          inheritSelection: true,
          mode: "all",
          machines: [],
          skip: [],
          windows: { m_1: { on: true, ...custom, maxMin: 60 } },
        },
      },
    }),
  );
  e.CONFIG._map.set(
    "win",
    JSON.stringify({
      phase: "keep",
      startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
      machines: {
        "1:m_1": { phase: "keep", startedAt: new Date(Date.now() - 30 * 60000).toISOString(), source: "machine" },
      },
    }),
  );
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.ok(leased.some((c) => c.includes("/m_1/")), "自定义区间应继续续租");
  assert.ok(leased.some((c) => c.includes("/m_2/")), "继承默认区间的机器也要续租");
  const state = JSON.parse(e.CONFIG._map.get("win"));
  assert.ok(state.machines["1:m_1"], "自定义机器的计时不能被继承机器的首次运行清掉");
  assert.equal(state.machines["1:m_1"].startedAt !== null, true);
  ok("自定义/继承默认的机器状态互不覆盖");
}

// 单台区间不能把 INSTABOX_MACHINE 的筛选范围意外改成“全部机器”
{
  const e = { ...env, INSTABOX_MACHINE: "qqq", CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "suspended";
  const r = await worker.fetch(
    post("/api/config", { machine: { account: 1, id: "m_1", window: { on: true, ...windowIncludingNow(), maxMin: 0 } } }, auth),
    e,
  );
  assert.equal(r.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].inheritSelection, true);
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.deepEqual(leased, ["PUT /v1/machines/m_1/activity-leases/keepalive"], "环境变量 machine=qqq 仍然生效");
  ok("单台区间配置不改变 INSTABOX_MACHINE 的筛选范围");
}

// /api/config 保存机器区间，/api/state 回显继承关系和设置
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const res = await worker.fetch(
    post("/api/config", { machine: { account: 1, id: "m_1", window: { on: true, start: 540, end: 1080, maxMin: 90 } } }, auth),
    e,
  );
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1, { on: true, ranges: [{ start: 540, end: 1080 }], maxMin: 90 });
  const sj = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  const m1 = sj.machines.find((m) => m.id === "m_1");
  const m2 = sj.machines.find((m) => m.id === "m_2");
  assert.equal(m1.window.inherited, false);
  assert.equal(m1.window.maxMin, 90);
  assert.equal(m2.window.inherited, true);
  ok("Web 接口保存并回显逐机器区间");
}

// 无覆盖恢复默认与其它配置同时提交时，其它配置不能丢
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const res = await worker.fetch(
    post("/api/config", { paused: true, machine: { account: 1, id: "m_1", window: null } }, auth),
    e,
  );
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.paused, true, "同一请求里的 paused 不能被无操作的恢复默认吞掉");
  assert.equal(conf.accounts["1"], undefined, "不应凭空创建账号配置");
  ok("无覆盖恢复默认不会吞掉同一请求的其它修改");
}

// 从未设置覆盖时“恢复默认”必须是无操作，不能新建空账号配置
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  const before = e.CONFIG._map.get("config");
  const res = await worker.fetch(post("/api/config", { machine: { account: 1, id: "m_1", window: null } }, auth), e);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.unchanged, true);
  assert.equal(e.CONFIG._map.get("config"), before, "无覆盖时不应写 config");
  ok("恢复默认为无操作时不写空配置");
}

// Web 打开带 skip 的机器时，需要显式清掉 skip 并恢复 cron 续租
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", JSON.stringify({
    v: 2,
    paused: false,
    window: { on: false, start: 480, end: 1380, maxMin: 0 },
    accounts: { 1: { enabled: true, mode: "all", machines: [], skip: ["m_1"], inheritSelection: false, windows: {} } },
  }));
  await worker.fetch(post("/api/config", { accounts: { 1: { skip: [] } } }, auth), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].skip, []);
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.ok(leased.some((c) => c.includes("/m_1/")), "清空 skip 后 m_1 应恢复续租");
  ok("API 清空 skip 后机器恢复 cron 保活");
}

// 恢复默认后删除覆盖，回到账号默认区间
{
  const e = { ...env, CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.fetch(
    post("/api/config", { machine: { account: 1, id: "m_1", window: { on: true, start: 540, end: 1080, maxMin: 90 } } }, auth),
    e,
  );
  const reset = await worker.fetch(post("/api/config", { machine: { account: 1, id: "m_1", window: null } }, auth), e);
  assert.equal(reset.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].windows.m_1, undefined);
  const sj = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(sj.machines.find((m) => m.id === "m_1").window.inherited, true);
  ok("恢复默认会删除单机覆盖");
}

// ---- Telegram 机器人 --------------------------------------------------------
// 重点不是命令回得漂亮，而是两件事：
//   1. 没凭据的人推 update 进来（伪造 webhook）必须被挡住
//   2. 机器人关掉的机器，cron 真的不再续租 —— 否则「关」这个动作是假的
const tgEnv = (over = {}) => ({
  ...env,
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_WEBHOOK_SECRET: "s3cret",
  TELEGRAM_CHAT_ID: "42",
  LOG: fakeKV(),
  CONFIG: fakeKV(),
  ...over,
});

const tgPost = (body, headers = {}) =>
  post("/tg/s3cret", body, { "x-telegram-bot-api-secret-token": "s3cret", ...headers });

const msgUpdate = (text, chatId = 42) => ({
  update_id: 1,
  message: { message_id: 9, from: { id: chatId, is_bot: false }, chat: { id: chatId }, text },
});

const cbUpdate = (data, chatId = 42) => ({
  update_id: 2,
  callback_query: {
    id: "cb-1",
    from: { id: chatId },
    data,
    message: { message_id: 9, chat: { id: chatId } },
  },
});

const lastTg = () => tgCalls[tgCalls.length - 1];
const sentText = () => (lastTg()?.body?.text || "");

// 1. webhook 凭据：路径错、头缺失、头不对都要 403
{
  const e = tgEnv();
  const wrongPath = await worker.fetch(post("/tg/wrong", msgUpdate("/ls")), e);
  assert.equal(wrongPath.status, 403);
  const noHeader = await worker.fetch(post("/tg/s3cret", msgUpdate("/ls")), e);
  assert.equal(noHeader.status, 403, "缺 secret_token 头必须拒绝");
  const badHeader = await worker.fetch(tgPost(msgUpdate("/ls"), { "x-telegram-bot-api-secret-token": "nope" }), e);
  assert.equal(badHeader.status, 403);
  ok("Telegram webhook 路径/secret 头不对一律 403");
}

// 2. 没配 TELEGRAM_BOT_TOKEN 时不接活
{
  const res = await worker.fetch(tgPost(msgUpdate("/ls")), tgEnv({ TELEGRAM_BOT_TOKEN: "" }));
  assert.equal(res.status, 503);
  ok("没配 bot token 时 webhook 返回 503");
}

// 3. 没配白名单：只回显 chat id，不碰任何机器
{
  const e = tgEnv({ TELEGRAM_CHAT_ID: "" });
  const before = calls.length;
  const res = await worker.fetch(tgPost(msgUpdate("/ls")), e);
  assert.equal(res.status, 200);
  assert.match(sentText(), /TELEGRAM_CHAT_ID/);
  assert.match(sentText(), /42/);
  assert.equal(calls.length, before, "没绑定时不该去调 InstaBox API");
  ok("没配 TELEGRAM_CHAT_ID 时只回显 id，不动机器");
}

// 4. 不在白名单的 chat 被拒
{
  const e = tgEnv();
  const before = calls.length;
  await worker.fetch(tgPost(msgUpdate("/ls", 999)), e);
  assert.match(sentText(), /没在允许名单/);
  assert.equal(calls.length, before);
  ok("不在白名单的 chat 被拒绝");
}

// 5. /ls 列出机器，带每台的详情按钮
{
  const e = tgEnv();
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  tgCalls.length = 0;
  await worker.fetch(tgPost(msgUpdate("/ls")), e);
  const call = lastTg();
  assert.equal(call.method, "sendMessage");
  assert.match(call.body.text, /qqq/);
  assert.match(call.body.text, /box2/);
  const kb = call.body.reply_markup.inline_keyboard;
  assert.equal(kb[0][0].callback_data, "d:1:m_1");
  assert.ok(kb[0][0].callback_data.length <= 64);
  ok("/ls 列出机器并给出 inline 按钮");
}

// 首次 /sleep 只新增 skip，不应把 INSTABOX_MACHINE 的筛选范围改成 mode=all
{
  const e = tgEnv({ INSTABOX_MACHINE: "qqq" });
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/sleep qqq")), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].inheritSelection, true);
  assert.deepEqual(conf.accounts["1"].skip, ["m_1"]);
  ok("Telegram 首次关闭机器仍跟随 INSTABOX_MACHINE");
}

// 6. /sleep：suspend + 释放租约 + 写进 CONFIG 的 skip 名单
{
  const e = tgEnv();
  machineState.m_1 = "running";
  const before = calls.length;
  await worker.fetch(tgPost(msgUpdate("/sleep qqq")), e);
  const done = calls.slice(before);
  assert.ok(done.includes("POST /v1/machines/m_1/suspend"), "应该调 suspend");
  assert.ok(
    done.some((c) => c.startsWith("DELETE /v1/machines/m_1/activity-leases/")),
    "应该顺手释放租约",
  );
  assert.equal(machineState.m_1, "suspended");
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].skip, ["m_1"], "关掉的机器要进 skip 名单");
  assert.equal(conf.accounts["1"].mode, "all", "不该把账号改成白名单模式");
  assert.match(sentText(), /已休眠/);
  ok("/sleep 休眠 + 释放租约 + 写 skip 名单（不动 mode）");
}

// 7. 关键联动：skip 里的机器，cron 不再续租，同账号其它机器照旧
{
  const e = tgEnv();
  machineState.m_1 = "suspended";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: { 1: { mode: "all", skip: ["m_1"] } } }));
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.ok(!leased.some((c) => c.includes("m_1")), "被关掉的机器不该再被续租（否则关不掉）");
  assert.ok(leased.some((c) => c.includes("m_2")), "同账号其它机器照常续租");
  ok("skip 名单里的机器 cron 不再续租，其它机器不受影响");
}

// 8. /wake：resume + 摘掉 skip + 续租
{
  const e = tgEnv();
  machineState.m_1 = "suspended";
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: { 1: { mode: "all", skip: ["m_1"] } } }));
  const before = calls.length;
  await worker.fetch(tgPost(msgUpdate("/wake qqq")), e);
  const done = calls.slice(before);
  assert.ok(done.includes("POST /v1/machines/m_1/resume"), "应该调 resume");
  assert.ok(done.some((c) => c.startsWith("PUT /v1/machines/m_1/activity-leases/")), "唤醒后要顺手续租");
  assert.equal(machineState.m_1, "running");
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].skip, [], "唤醒后要把 skip 摘掉");
  ok("/wake 唤醒 + 摘掉 skip + 续租");
}

// 官方：休眠中的机器不能直接 stop（会回 409）。机器人要提前说清楚两条路，
// 而不是让用户看到一个看不懂的失败。
{
  const e = tgEnv();
  machineState.m_2 = "suspended";
  const before = calls.length;
  await worker.fetch(tgPost(msgUpdate("/stop box2")), e);
  assert.match(sentText(), /不允许直接关停/);
  assert.match(sentText(), /\/wake 再 \/stop/);
  assert.ok(!calls.slice(before).some((c) => c.includes("/m_2/stop")), "不该白打一次 stop");
  ok("/stop 遇到休眠中的机器给指路，不白打一次 409");
}

// 冷却中的机器叫不醒，回执要说明白「还要多久」，别让人反复点
{
  const e = tgEnv();
  machineState.m_2 = "suspended";
  cooldowns.m_2 = 600;
  await worker.fetch(tgPost(msgUpdate("/wake box2")), e);
  assert.match(sentText(), /冷却/);
  assert.match(sentText(), /10 分钟/);
  delete cooldowns.m_2;
  ok("/wake 遇到冷却回执带剩余时间");
}

// Telegram 从白名单外打开保活：必须真正加入选中并恢复 cron
{
  const e = tgEnv();
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", JSON.stringify({
    v: 2,
    paused: false,
    window: { on: false, start: 480, end: 1380, maxMin: 0 },
    accounts: { 1: { enabled: true, mode: "list", machines: ["m_2"], skip: ["m_1"], inheritSelection: false, windows: {} } },
  }));
  await worker.fetch(tgPost(msgUpdate("/keep qqq on")), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].mode, "list");
  assert.deepEqual(conf.accounts["1"].machines.slice().sort(), ["m_1", "m_2"]);
  assert.deepEqual(conf.accounts["1"].skip, []);
  const before = calls.length;
  await worker.scheduled({}, e);
  const leased = calls.slice(before).filter((c) => c.startsWith("PUT /v1/machines/"));
  assert.ok(leased.some((c) => c.includes("/m_1/")), "打开后 m_1 必须恢复续租");
  const snap = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(snap.machines.find((m) => m.id === "m_1").selected, true);
  ok("Telegram 打开白名单外机器会真正恢复保活");
}

// 账号被面板停用时，Telegram 打开单机也必须恢复账号与 cron
{
  const e = tgEnv();
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  e.CONFIG._map.set("config", JSON.stringify({
    v: 2, paused: false, window: { on: false, start: 480, end: 1380, maxMin: 0 },
    accounts: { 1: { enabled: false, mode: "all", machines: [], skip: [], inheritSelection: false, windows: {} } },
  }));
  await worker.fetch(tgPost(msgUpdate("/keep qqq on")), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].enabled, true);
  assert.deepEqual(conf.accounts["1"].skip, []);
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.ok(calls.slice(before).some((c) => c.startsWith("PUT /v1/machines/m_1/activity-leases/")), "打开后账号必须恢复续租");
  ok("Telegram 打开账号停用机器会恢复账号保活");
}

// INSTABOX_MACHINE 排除机器时，Telegram 打开必须物化白名单
{
  const e = tgEnv({ INSTABOX_MACHINE: "m_2" });
  machineState.m_1 = "running";
  machineState.m_2 = "running";
  await worker.fetch(tgPost(msgUpdate("/keep qqq on")), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].mode, "list");
  assert.equal(conf.accounts["1"].inheritSelection, false);
  assert.deepEqual(conf.accounts["1"].machines.sort(), ["m_1", "m_2"]);
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.ok(calls.slice(before).some((c) => c.startsWith("PUT /v1/machines/m_1/activity-leases/")), "物化白名单后 m_1 必须续租");
  ok("Telegram 打开环境变量排除机器会物化白名单");
}

// Telegram 关闭再打开：详情状态与 cron 双向一致
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/keep qqq off")), e);
  let snap = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(snap.machines.find((m) => m.id === "m_1").selected, false);
  await worker.fetch(tgPost(msgUpdate("/keep qqq on")), e);
  snap = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(snap.machines.find((m) => m.id === "m_1").selected, true);
  const before = calls.length;
  await worker.scheduled({}, e);
  assert.ok(calls.slice(before).some((c) => c.startsWith("PUT /v1/machines/m_1/activity-leases/")), "重新打开后应续租");
  ok("Telegram 保活关闭/打开状态与 cron 一致");
}

// 跨午夜任意时段 + 上限
{
  const e = tgEnv();
  machineState.m_1 = "running";
  const res = await worker.fetch(tgPost(msgUpdate("/window qqq 22:15-06:45 120")), e);
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1, { on: true, ranges: [{ start: 1335, end: 405 }], maxMin: 120 });
  ok("Telegram 支持自定义跨午夜时段");
}

// 一条命令设多段：逗号 / 顿号 / 空格分隔都认，末尾数字是上限
{
  const e = tgEnv();
  machineState.m_1 = "running";
  const res = await worker.fetch(tgPost(msgUpdate("/window qqq 09:00-12:00,14:00-18:00 90")), e);
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1.ranges, [
    { start: 540, end: 720 },
    { start: 840, end: 1080 },
  ]);
  assert.equal(conf.accounts["1"].windows.m_1.maxMin, 90);
  const msg = tgCalls.filter((x) => x.method === "sendMessage").at(-1);
  assert.match(msg.body.text || "", /2 段/, "面板要写明有几段");
  assert.match(msg.body.text || "", /09:00 – 12:00/);
  ok("Telegram 一条命令设多段区间");
}

// 面板按钮：追加一段、删掉一段
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/window qqq 09:00-12:00,14:00-18:00")), e);

  // 加第三段（22:00–06:00 跨午夜）
  await worker.fetch(tgPost(cbUpdate("w:m:1:m_1:add:1320:360")), e);
  let conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].windows.m_1.ranges.length, 3, "追加后应该有三段");

  // 删第一段
  await worker.fetch(tgPost(cbUpdate("w:m:1:m_1:del:0")), e);
  conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1.ranges, [
    { start: 840, end: 1080 },
    { start: 1320, end: 360 },
  ]);
  ok("Telegram 面板可以按段追加和删除");
}

// 删掉不存在的段要拒绝，不能静默改配置
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/window qqq 09:00-12:00")), e);
  const before = e.CONFIG._map.get("config");
  await worker.fetch(tgPost(cbUpdate("w:m:1:m_1:del:9")), e);
  assert.equal(e.CONFIG._map.get("config"), before, "越界删除不该改配置");
  assert.match(tgCalls.filter((x) => x.method === "sendMessage" || x.method === "editMessageText").at(-1).body.text || "", /不在了/);
  ok("Telegram 删除越界段被拒绝");
}

// 非法时间和超出范围的上限必须拒绝，不能静默写成默认值
{
  const e = tgEnv();
  const before = e.CONFIG._map.get("config");
  await worker.fetch(tgPost(msgUpdate("/window qqq 25:00-08:00 90")), e);
  assert.equal(e.CONFIG._map.get("config"), before, "非法时间不能写配置");
  assert.match(tgCalls.filter((x) => x.method === "sendMessage").at(-1).body.text || "", /用法/);
  await worker.fetch(tgPost(msgUpdate("/window qqq 09:00-18:00 9999")), e);
  assert.equal(e.CONFIG._map.get("config"), before, "超范围上限不能写配置");
  ok("Telegram 拒绝非法时间和超范围上限");
}

// 详情页真实 callback：开 → 关 → 开，回读详情和 cron 一致
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/ls")), e);
  await worker.fetch(tgPost(cbUpdate("d:1:m_1")), e);
  const detailKb = tgCalls.filter((x) => x.method === "editMessageText").at(-1).body.reply_markup.inline_keyboard;
  const keepButton = detailKb.flat().find((x) => x.callback_data.startsWith("a:keep"));
  assert.ok(keepButton, "详情页应有保活开关按钮");
  await worker.fetch(tgPost(cbUpdate(keepButton.callback_data)), e);
  let snap = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(snap.machines.find((m) => m.id === "m_1").selected, false);
  const offKb = tgCalls.filter((x) => x.method === "editMessageText").at(-1).body.reply_markup.inline_keyboard;
  const onButton = offKb.flat().find((x) => x.callback_data.startsWith("a:keep"));
  assert.ok(onButton && onButton.callback_data.includes("keepon"), "关闭后按钮应变成打开");
  await worker.fetch(tgPost(cbUpdate(onButton.callback_data)), e);
  snap = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(snap.machines.find((m) => m.id === "m_1").selected, true);
  ok("Telegram 详情页保活按钮双向可用");
}

// 任意起止时间 + 单次上限可一次设置
{
  const e = tgEnv();
  machineState.m_1 = "running";
  const res = await worker.fetch(tgPost(msgUpdate("/window qqq 06:35-22:47 95")), e);
  assert.equal(res.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1, { on: true, ranges: [{ start: 395, end: 1367 }], maxMin: 95 });
  // sendMessage 一定是最后一次 Bot API 调用；tgCalls 里还可能有查询/编辑调用。
  const message = tgCalls.filter((x) => x.method === "sendMessage").at(-1);
  assert.ok(message, "应有区间回执");
  assert.match(message.body.text || "", /06:35/);
  assert.match(message.body.text || "", /22:47/);
  assert.match(message.body.text || "", /95 分钟/);
  ok("Telegram 支持任意起止时间和单次上限");
}

// /window <机器> 设置单机区间，不影响默认区间
{
  const e = tgEnv();
  machineState.m_1 = "running";
  const r = await worker.fetch(tgPost(msgUpdate("/window qqq 09:00-18:00")), e);
  assert.equal(r.status, 200);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1, { on: true, ranges: [{ start: 540, end: 1080 }], maxMin: 0 });
  assert.equal(conf.accounts["1"].inheritSelection, true, "单机区间不应改机器筛选");
  assert.deepEqual(
    conf.window,
    { on: false, ranges: [{ start: 480, end: 1380 }], maxMin: 0 },
    "默认区间不应被改",
  );
  assert.match(sentText(), /qqq 的保活区间/);
  ok("Telegram /window 机器名 设置单机区间");
}

// 机器详情里的区间按钮 → 上限按钮，回调带 account:id，重启后仍能定位
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/window qqq")), e);
  const kb = lastTg().body.reply_markup.inline_keyboard;
  const machineCb = kb.flat().find((x) => x.text.includes("上限 2h"));
  assert.ok(machineCb.callback_data.startsWith("w:m:1:m_1:max:"));
  await worker.fetch(tgPost(cbUpdate(machineCb.callback_data)), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.deepEqual(conf.accounts["1"].windows.m_1, { on: false, ranges: [{ start: 480, end: 1380 }], maxMin: 120 });
  assert.match(lastTg().body.text, /qqq 的保活区间/);
  ok("Telegram 单机区间按钮会按机器保存上限");
}

// 自定义时段引导页必须保留返回按钮
{
  const e = tgEnv();
  machineState.m_1 = "running";
  await worker.fetch(tgPost(msgUpdate("/window qqq")), e);
  const kb = tgCalls.filter((x) => x.method === "sendMessage").at(-1).body.reply_markup.inline_keyboard;
  const custom = kb.flat().find((x) => x.callback_data.endsWith(":custom"));
  assert.ok(custom, "区间面板应有任意时段按钮");
  await worker.fetch(tgPost(cbUpdate(custom.callback_data)), e);
  const edited = tgCalls.filter((x) => x.method === "editMessageText").at(-1);
  const back = edited.body.reply_markup.inline_keyboard.flat();
  assert.ok(back.some((x) => x.callback_data === "d:1:m_1"), "自定义引导页应能返回机器详情");
  assert.match(edited.body.text, /09:15-17:45 90/);
  ok("Telegram 自定义时段引导页可返回");
}

// 坏 URL 编码的回调只回参数错误，不能抛异常触发 Telegram 重投
{
  const e = tgEnv();
  const before = tgCalls.length;
  const r = await worker.fetch(tgPost(cbUpdate("w:m:1:%E0%A4%A:max:120")), e);
  assert.equal(r.status, 200);
  assert.equal(tgCalls.length, before + 2, "只应答 callback + 编辑错误提示");
  assert.match(tgCalls[before + 1].body.text, /机器参数不对/);
  ok("Telegram 坏编码回调被安全拒绝");
}

// 机器区间 reset 回到默认
{
  const e = tgEnv();
  machineState.m_1 = "running";
  e.CONFIG._map.set(
    "config",
    JSON.stringify({
      v: 2,
      paused: false,
      window: { on: false, start: 480, end: 1380, maxMin: 0 },
      accounts: { 1: { mode: "all", machines: [], skip: [], inheritSelection: true, windows: { m_1: { on: true, start: 540, end: 1080, maxMin: 60 } } } },
    }),
  );
  await worker.fetch(tgPost(msgUpdate("/window qqq reset")), e);
  const conf = JSON.parse(e.CONFIG._map.get("config"));
  assert.equal(conf.accounts["1"].windows.m_1, undefined);
  assert.match(sentText(), /跟随默认区间/);
  ok("Telegram 单机区间可恢复跟随默认");
}

// 9. 回调按钮走通：点机器看详情 → 点休眠
{
  const e = tgEnv();
  machineState.m_1 = "running";
  tgCalls.length = 0;
  await worker.fetch(tgPost(cbUpdate("d:1:m_1")), e);
  assert.equal(lastTg().method, "editMessageText");
  assert.match(lastTg().body.text, /m_1/);
  assert.ok(lastTg().body.reply_markup.inline_keyboard[0][1].callback_data.startsWith("a:sleep:1:m_1"));

  const before = calls.length;
  await worker.fetch(tgPost(cbUpdate("a:sleep:1:m_1")), e);
  assert.ok(calls.slice(before).includes("POST /v1/machines/m_1/suspend"));
  assert.equal(machineState.m_1, "suspended");
  const methods = tgCalls.map((c) => c.method);
  assert.ok(methods.includes("answerCallbackQuery"), "回调必须先应答，不然按钮一直转圈");
  ok("回调按钮：详情 → 休眠 全链路走通");
}

// 10. /pause on 写全局暂停
{
  const e = tgEnv();
  await worker.fetch(tgPost(msgUpdate("/pause on")), e);
  assert.equal(JSON.parse(e.CONFIG._map.get("config")).paused, true);
  ok("/pause on 全局暂停保活");
}

// 11. 注册 webhook：带上 secret_token，且 /api/telegram 需要凭据
{
  const e = tgEnv();
  const noAuth = await worker.fetch(req("/api/telegram?action=set"), e);
  assert.equal(noAuth.status, 401);
  tgCalls.length = 0;
  const res = await worker.fetch(req("/api/telegram?action=set", { headers: auth }), e);
  assert.equal(res.status, 200);
  const set = tgCalls.find((c) => c.method === "setWebhook");
  assert.ok(set, "应该调用 setWebhook");
  assert.equal(set.body.url, "https://worker.test/tg/s3cret");
  assert.equal(set.body.secret_token, "s3cret");
  ok("/api/telegram?action=set 注册 webhook（带 secret_token，且需凭据）");
}

// 12. 网页里配 bot：存进 CONFIG，接口只回打码值
//     故意不给任何 TELEGRAM_* 环境变量 —— 这条路径要能完全靠面板跑通
{
  const e = { ...env, LOG: fakeKV(), CONFIG: fakeKV() };
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: {} }));

  const noAuth = await worker.fetch(
    post("/api/telegram", { telegram: { token: "999123456:AAH_kv_token_for_test_only" } }),
    e,
  );
  assert.equal(noAuth.status, 401, "写接口没凭据必须挡住");

  const saved = await worker.fetch(
    post("/api/telegram", { telegram: { token: "999123456:AAH_kv_token_for_test_only", secret: "kvsecret", chats: "42,43" } }, auth),
    e,
  );
  assert.equal(saved.status, 200);
  const sb = await saved.json();
  assert.equal(sb.ok, true);
  assert.equal(sb.telegram.configured, true);
  assert.equal(sb.telegram.src.token, "kv");
  assert.deepEqual(sb.telegram.chats, ["42", "43"]);

  const st = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(st.telegram.configured, true);
  assert.ok(st.telegram.tokenMasked.startsWith("9991"), "打码要保留前 4 位好认");
  assert.equal(st.telegram.tokenMasked.includes("AAH_kv"), false, "明文 token 不能出现在接口响应里");
  assert.equal(st.telegram.secretMasked.includes("kvsecret"), false, "明文 secret 不能出现在接口响应里");
  assert.deepEqual(st.telegram.chats, ["42", "43"]);
  ok("网页里配的 token 存进 CONFIG，/api/state 只回打码值");
}

// 13. 存完之后立刻生效：注册用 KV 的 token + secret，不是环境变量那套
{
  const e = { ...env, LOG: fakeKV(), CONFIG: fakeKV() };
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: {} }));
  await worker.fetch(
    post("/api/telegram", { telegram: { token: "999123456:AAH_kv_token_for_test_only", secret: "kvsecret" } }, auth),
    e,
  );
  tgCalls.length = 0;
  const res = await worker.fetch(
    post("/api/telegram", { register: true }, auth),
    e,
  );
  assert.equal(res.status, 200);
  const set = tgCalls.find((c) => c.method === "setWebhook");
  assert.ok(set, "应该调用 setWebhook");
  assert.ok(set.url.includes("/bot999123456:AAH_kv_token_for_test_only/setWebhook"), "要用 KV 里的 token：" + set.url);
  assert.equal(set.body.url, "https://worker.test/tg/kvsecret");
  assert.equal(set.body.secret_token, "kvsecret");
  const menu = tgCalls.find((c) => c.method === "setMyCommands");
  assert.ok(menu, "顺带要把命令菜单注册上");
  ok("保存后立刻生效：webhook 用 KV 的 token/secret，并注册命令菜单");
}

// 14. 面板配的 secret 真的参与 webhook 校验（不是只写进 KV 好看）
{
  const e = { ...env, LOG: fakeKV(), CONFIG: fakeKV() };
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: {} }));
  await worker.fetch(
    post("/api/telegram", { telegram: { token: "999123456:AAH_kv_token_for_test_only", secret: "kvsecret", chats: "42" } }, auth),
    e,
  );
  const good = await worker.fetch(
    req("/tg/kvsecret", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "kvsecret", "content-type": "application/json" },
      body: JSON.stringify(msgUpdate("/help")),
    }),
    e,
  );
  assert.equal(good.status, 200);
  // 环境变量里那个 s3cret 这时候已经不该认了
  const bad = await worker.fetch(
    req("/tg/s3cret", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "s3cret", "content-type": "application/json" },
      body: JSON.stringify(msgUpdate("/help")),
    }),
    e,
  );
  assert.equal(bad.status, 403);
  ok("面板配的 secret 真的参与 webhook 校验");
}

// 15. 清空 = 回退环境变量，不是把机器人搞挂
{
  const e = tgEnv();
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: {} }));
  await worker.fetch(
    post("/api/telegram", { telegram: { token: "999123456:AAH_kv_token_for_test_only", secret: "kvsecret" } }, auth),
    e,
  );
  const cleared = await worker.fetch(
    post("/api/telegram", { telegram: null }, auth),
    e,
  );
  assert.equal(cleared.status, 200);
  const st = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  assert.equal(st.telegram.src.token, "env", "清空后要回到环境变量");
  assert.equal(st.telegram.configured, true, "清空不等于没配：环境变量里还有");
  assert.equal(st.telegram.src.secret, "env");
  ok("清空网页配置后回退环境变量");
}

// 16. 只填 token 不填 secret：面板自动补一个，别让 /tg 变成谁都能打的公开接口
//     不补的话，任何人 POST /tg 一个伪造 update 就能关机（chat id 是请求体里写的）
{
  const e = { ...env, LOG: fakeKV(), CONFIG: fakeKV() };
  e.CONFIG._map.set("config", JSON.stringify({ v: 1, paused: false, accounts: {} }));
  tgCalls.length = 0;
  const r = await worker.fetch(
    post("/api/telegram", { telegram: { token: "8123456789:AAH_nosecret", chats: "42" }, register: true }, auth),
    e,
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.secretGenerated, true, "应该自动生成 secret");
  const set = tgCalls.find((c) => c.method === "setWebhook");
  assert.ok(/^[0-9a-f]{32}$/.test(set.body.secret_token || ""), "setWebhook 要带上自动生成的 secret_token");
  assert.ok(set.body.url.includes(set.body.secret_token), "URL 里也要有同一串");

  // 裸 /tg 现在必须打不进来
  tgCalls.length = 0;
  const forged = await worker.fetch(
    req("/tg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 9, message: { message_id: 9, chat: { id: 42 }, from: { id: 42, is_bot: false }, text: "/stop qqq" } }),
    }),
    e,
  );
  assert.equal(forged.status, 403, "没有 secret 串就不该接受 update");
  assert.equal(tgCalls.length, 0, "更不能真的去动机器");
  ok("没填 secret 时自动生成，裸 /tg 打不进来");
}

// ---- 官方文档对齐（2026-11 复查 instabox.sh/docs + openapi.json）------------
// 这一节盯的是「官方明确写了、但我们原来没照做」的几处：
//   · operation_conflict 重试要换新的 Idempotency-Key
//   · state 枚举里有 error / deleting，不能一律按 resume+start 兜底
//   · 429 rate_limited（免费版每分钟 3 次启动）和 402 early_allowance_ended 不是保活故障
//   · cooldownReason 区分安全审查锁（最长 24 小时）和 max-run 冷却
//   · runStartedAt + maxRunMinutes 能算出「还有多久到上限」

// operation_conflict：官方要求「等那个操作结束后用新的 Idempotency-Key 重试」。
// 复用同一个 key 有可能拿回第一次那份 409 的缓存响应，看起来像一直失败。
{
  machineState.m_2 = "suspended";
  autoPaused.delete("m_2");
  lifecycleKeys.length = 0;
  lifecycleConflicts = 1;
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.fetch(post("/api/renew", {}, auth), e);
  assert.ok(lifecycleKeys.length >= 2, "撞 operation_conflict 后应该重试");
  assert.notEqual(lifecycleKeys[0].key, lifecycleKeys[1].key, "重试必须换新的 Idempotency-Key");
  lifecycleConflicts = 0;
  machineState.m_2 = "suspended";
  ok("operation_conflict 重试换新的 Idempotency-Key");
}

// error 状态：resume 一定 409（它没在跑），只有冷启动可能救回来，别白打一次
{
  machineState.m_2 = "error";
  autoPaused.delete("m_2");
  lifecycleKeys.length = 0;
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  await worker.fetch(post("/api/renew", {}, auth), e);
  const types = lifecycleKeys.map((k) => k.type);
  assert.equal(types.includes("resume"), false, "error 状态不该先试 resume");
  assert.equal(types.includes("start"), true, "error 状态应该直接 start");
  machineState.m_2 = "suspended";
  ok("error 状态跳过 resume，直接 start");
}

// deleting / deleted：叫醒没有意义，直接说清楚，别白发 resume/start
{
  machineState.m_2 = "deleting";
  lifecycleKeys.length = 0;
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  assert.equal(lifecycleKeys.length, 0, "deleting 状态不该发任何生命周期请求");
  assert.match(out.machines.find((m) => m.id === "m_2").error, /删除/);
  machineState.m_2 = "suspended";
  ok("deleting 状态直接说明，不白发唤醒请求");
}

// 429 rate_limited：免费版每分钟只允许 3 次 create/start/resume/wake。
// 多台机器同时挂起时会撞上，等一分钟就好 —— 不该按「保活挂了」告警。
{
  machineState.m_2 = "suspended";
  hooks.length = 0;
  leaseRateLimits = 10;
  const e = {
    ...env,
    INSTABOX_MACHINE: "",
    ALERT_WEBHOOK: "https://hook.test/alert",
    CONFIG: fakeKV(),
    LOG: fakeKV(),
  };
  await worker.scheduled({}, e);
  assert.equal(hooks.length, 0, "启动限流不该报警");

  leaseRateLimits = 10;
  const out = await (
    await worker.fetch(post("/api/renew", {}, auth), { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() })
  ).json();
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.equal(m2.limit, "throttled", "429 要标成平台限流");
  assert.match(m2.error, /限流/);
  leaseRateLimits = 0;
  ok("429 rate_limited 标成平台限流，不报警");
}

// 402 early_allowance_ended：免费额度用完，启动被拒。不会自己好，得腾一台或升级。
{
  machineState.m_2 = "suspended";
  autoPaused.delete("m_2");
  lifecycle402 = 1;
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.equal(m2.limit, "blocked");
  assert.match(m2.error, /免费额度/);
  lifecycle402 = 0;
  machineState.m_2 = "suspended";
  ok("402 early_allowance_ended 单独说明（不会自己好）");
}

// cooldownReason=abuse_* 是安全审查锁（最长 24 小时），和 max-run 冷却不是一回事
{
  machineState.m_2 = "suspended";
  cooldowns.m_2 = 3600;
  machineExtra.m_2 = { cooldownReason: "abuse_cpu" };
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(post("/api/renew", {}, auth), e)).json();
  const m2 = out.machines.find((m) => m.id === "m_2");
  assert.equal(m2.limit, "abuse");
  assert.match(m2.error, /安全审查锁/);
  delete cooldowns.m_2;
  delete machineExtra.m_2;
  machineState.m_2 = "suspended";
  ok("abuse 锁和 max-run 冷却分开提示");
}

// runStartedAt + maxRunMinutes：面板和机器人靠它算「还有多久到上限」
{
  machineState.m_1 = "running";
  const startedAt = new Date(Date.now() - 60 * 60000).toISOString();
  machineExtra.m_1 = { runStartedAt: startedAt, maxRunMinutes: 480, free: true };
  const e = { ...env, INSTABOX_MACHINE: "", CONFIG: fakeKV(), LOG: fakeKV() };
  const out = await (await worker.fetch(req("/api/state", { headers: auth }), e)).json();
  const m1 = out.machines.find((m) => m.id === "m_1");
  assert.equal(m1.runStartedAt, startedAt, "要带本轮 run 起点");
  assert.equal(m1.maxRunMinutes, 480);
  assert.equal(m1.free, true);
  delete machineExtra.m_1;
  ok("/api/state 带 runStartedAt / maxRunMinutes / free");
}

console.log("\n" + passed + " 项通过");
