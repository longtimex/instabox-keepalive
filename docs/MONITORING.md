# 监控与告警

## 1. 独立健康 Token

在 Cloudflare Worker 中设置 Secret：

```text
HEALTH_TOKEN=<随机长字符串>
```

之后外部监控可以只读访问：

```text
GET /api/health?deep=1
X-Health-Token: <HEALTH_TOKEN>
```

`deep=1` 会额外对每个账号执行一次：

```text
GET /v1/machines?limit=200
```

并检查 `machines` 和 `nextCursor` 的响应结构。它不会修改机器，也不会续租；建议每 5–15 分钟执行一次，不要用于秒级轮询。

## 2. 本机 cron 示例

Linux：

```cron
*/10 * * * * cd /opt/instabox-keepalive && WORKER_URL=https://<worker> HEALTH_TOKEN=<token> /usr/bin/node tools/healthcheck.mjs >>/var/log/instabox-health.log 2>&1
```

Windows PowerShell：

```powershell
$env:WORKER_URL = "https://<worker>"
$env:HEALTH_TOKEN = "<token>"
node .\tools\healthcheck.mjs
```

脚本成功返回 `0`，`paused`、`contract_failed`、`no_recent_lease` 等异常返回非零，可以交给 systemd、cron、Uptime Kuma、Better Stack 等监控系统。

## 3. 续租失败告警

已有 `ALERT_WEBHOOK` 可以接收 cron 的连续失败告警。它是 Secret，不要写进仓库：

```text
ALERT_WEBHOOK=https://...
ALERT_FORMAT=text
ALERT_MIN_INTERVAL=1800
```

建议同时配置：

- `/api/health?deep=1` 外部监控：发现 Worker 停摆或 Instabox API 合约变化
- `ALERT_WEBHOOK`：发现具体机器续租失败
- Telegram：机器人本身用于人工检查，不替代独立告警

## 4. 注意事项

- `deep=1` 会产生真实上游请求，账号很多时注意 Instabox 和 Worker 的子请求额度。
- `paused=true` 是主动暂停，健康检查会返回 `503 paused`，这是预期状态。
- 外部监控不要使用面板密码；使用独立的 `HEALTH_TOKEN`。
