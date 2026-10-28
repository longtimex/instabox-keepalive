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
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const machineState = { m_1: "running", m_2: "suspended", m_3: "running" };

// 每个 key 名下的机器。/api/state 会按账号逐个列机器，假 API 也要照做。
const machinesByKey = () => ({
  ibk_test_key: [
    { id: "m_1", name: "qqq", state: machineState.m_1 },
    { id: "m_2", name: "box2", state: machineState.m_2 },
  ],
  ibk_second: [{ id: "m_3", name: "box3", state: machineState.m_3 }],
});
let calls = [];
let hooks = [];
let leaseFailures = 0;
let leaseConflicts = 0;
let leaseRateLimits = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = (init.method || "GET").toUpperCase();

  // 告警 webhook：只记录，不发出去
  if (url.host === "hook.test") {
    hooks.push({ format: url.pathname, body: JSON.parse(init.body || "{}") });
    return new Response("ok", { status: 200 });
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
    const found = own.find((x) => x.id === m[1]);
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

  m = /^\/v1\/machines\/([^/]+)\/(resume|start|stop)$/.exec(path);
  if (m && method === "POST") {
    machineState[m[1]] = "running";
    return new Response(null, { status: 202 });
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
  // 预算 10：列机器 1 + m_1 续租 1 + m_2 续租 409 1 → 只剩 7，不够一次唤醒（10）
  const tight = { ...env, INSTABOX_MACHINE: "", SUBREQUEST_LIMIT: "10", CONFIG: fakeKV(), LOG: fakeKV() };
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

console.log("\n" + passed + " 项通过");
