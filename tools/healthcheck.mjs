#!/usr/bin/env node
// 外部监控用：调用受保护的 deep health，验证 Worker 心跳和真实 Instabox 机器列表合约。
// 用法：WORKER_URL=https://... HEALTH_TOKEN=... node tools/healthcheck.mjs
const base = String(process.env.WORKER_URL || "").trim();
const token = String(process.env.HEALTH_TOKEN || "").trim();

if (!base) {
  console.error("缺少 WORKER_URL");
  process.exit(2);
}
if (!token) {
  console.error("缺少 HEALTH_TOKEN");
  process.exit(2);
}

let url;
try {
  url = new URL("/api/health", base);
  url.searchParams.set("deep", "1");
} catch {
  console.error("WORKER_URL 不是合法 URL");
  process.exit(2);
}

try {
  const res = await fetch(url, {
    headers: { "X-Health-Token": token },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  console.log(JSON.stringify({
    httpStatus: res.status,
    ok: body.ok === true,
    status: body.status || "unknown",
    reason: body.reason || "",
    version: body.version || "",
    contract: body.contract
      ? {
          ok: body.contract.ok === true,
          accounts: (body.contract.accounts || []).map((a) => ({
            account: a.account,
            ok: a.ok === true,
            status: a.status,
            count: a.count,
            error: a.error || "",
          })),
        }
      : null,
  }, null, 2));
  process.exit(res.ok && body.ok === true ? 0 : 1);
} catch (e) {
  console.error(`健康检查请求失败：${e.message}`);
  process.exit(1);
}
