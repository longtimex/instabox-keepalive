# 在面板里添加 InstaBox API Key —— 设计方案（v1）

> 状态：仅设计，未改任何代码。
> 目标：登录网页面板就能加/删/测 key，不再需要本地 `wrangler secret put` + 重新粘贴 `dist/worker.js`。

## 1. 硬约束（决定了方案只能怎么走）

1. **Worker 运行时不能创建或修改自己的 Secret / 环境变量。** Cloudflare 没有这个运行时 API。
   要走 REST API 改 Secret 需要账号级 API Token（`Workers Scripts:Edit`），权限远超本项目定位，而且改完还要重新部署才生效。
2. 所以新增 key **只能落在 KV**（`CONFIG` 命名空间），由代码在运行时合并进账号列表。
3. KV 的值对控制台和 API 都是**明文可读**的。key 等价于机器控制权（`machines:write` 能 exec），
   因此**必须加密后再写 KV**，不能图省事直接存。

## 2. 三种方案对比

| | A. KV 加密保险库（推荐） | B. Cloudflare API Token 直接改 Secret | C. 只存内存 |
|---|---|---|---|
| 额外权限 | 无 | 账号级 `Workers Scripts:Edit` | 无 |
| 生效方式 | 下一轮 cron / 刷新即生效 | 改完要 redeploy 才生效 | 立即 |
| 重启后 | 保留 | 保留 | **丢失**（cron 每轮新 isolate，等于没用） |
| 与「粘一个文件部署」的定位 | 契合 | 冲突（要存账号 token） | 契合 |
| 结论 | **采用** | 不采用 | 否决 |

## 3. 数据模型

KV `CONFIG` 下新增一个键 `vault`（与现有 `config` / `live` / `auth` 平级）：

```json
{
  "v": 1,
  "keys": [
    {
      "id": "k_3f9a2c7d",
      "name": "小号",
      "hint": "ibk_…4f2a",
      "iv": "base64(12B)",
      "ct": "base64(AES-GCM 密文)",
      "at": "2026-10-24T05:00:00.000Z",
      "lastOkAt": "2026-10-24T05:09:00.000Z",
      "lastError": ""
    }
  ]
}
```

- 上限 20 把（一个条目约 200 字节，远低于 KV 单值 25MB 限制，主要是防误操作）。
- `hint` 只存前 4 + 后 4 位，用于面板展示，**不解密也能显示**。
- 明文 key 只在内存里出现一次，用来拼 `X-API-Key` 请求头（现有 `call()` 已经是这么用的）。

## 4. 加密

- `KEK = HKDF-SHA256(secret, salt="instabox-keepalive/vault", info="v1")` → AES-GCM 256。
- `secret` 取值顺序：**`KEY_SECRET`（新增变量，推荐）→ `SESSION_SECRET` → 都没有就拒绝保存**。
  故意不降级到 `ADMIN_PASSWORD`：否则「在面板里改密码」会把已存的 key 全部弄丢，这个坑必须从设计上避免。
- 每条独立随机 IV（12B）；AAD 用条目 `id`，防止有人把密文在两把 key 之间搬运。
- **必须写进 UI 的代价**：换 `KEY_SECRET` / `SESSION_SECRET` 会让已存的 key 全部解不开。
  解不开时保留 `hint` 并在面板标红「密钥已失效，请重新录入」，而不是静默消失。

## 5. 账号合并与编号 —— 本方案最关键的一处

现状：`account` 是数字编号，`config.accounts` 用数字字符串当键（`worker.js:240-257`、`283`）。
如果 KV 里的 key 也参与编号，**删掉中间一把会让后面的编号整体前移**，面板里所有「逐台保活白名单」
就会串到别的账号上 —— 静默的数据错乱，比直接报错更糟。

解法：引入**稳定 id**，编号只用于展示。

- env 账号 id：`env:<n>`（n 仍由现有规则决定，行为零变化）
- KV 账号 id：`kv:<id>`（创建时生成，永不变）
- `config.accounts` 的键从数字改成 id；`normalizeConfig` 同时认旧数字键
- 首次读到旧数字键 → 按当前顺序映射成 id 并回写 `v:2`（幂等，只写一次）
- 展示编号（`#1 #2`、`?account=2`）仍是动态顺序号：先 env（保持原编号），再 KV（按 `at` 升序）

合并规则（顺序即编号）：

1. 先 env 账号，编号完全沿用现在的逻辑
2. 再 KV 账号，从 env 最大编号 +1 顺延
3. 解密后与任一 env key 相同 → 忽略该条 + warning（与 `accountsOf` 现有去重一致）
4. 每个账号带 `source: "env" | "kv"`，面板据此显示来源标签

## 6. 接口

全部 `POST`，都要 `sameOrigin` + 已登录（`whoIs` 非空）+ **二次校验当前密码**。
理由：加 key 等于把机器控制权交给这把 key，比改开关敏感得多；只靠会话 cookie，cookie 被偷就能植入自己的 key。

| 接口 | 请求 | 成功响应 |
|---|---|---|
| `POST /api/keys` | `{ name?, key, currentPassword }` | `{ ok:true, id, hint }` |
| `POST /api/keys/remove` | `{ id, currentPassword, release?:true }` | `{ ok:true }` |
| `POST /api/keys/test` | `{ id }` | `{ ok:true, count, lastOkAt }` |
| `GET /api/state`（扩展） | — | `accounts[]` 增加 `id` / `source` / `hint` / `lastOkAt` |

细节：

- `currentPassword` 复用 `verifyPasswordOnly()`；错误计数走 `loginGuard(env, ip, "key", 6)` 单独 scope，避免和登录锁互相牵连。
- 校验：`/^ibk_[A-Za-z0-9]{8,}$/`，长度 ≤ 200；`name` ≤ 32 字符。
- 入库前**实测一次** `GET /v1/machines`：401 → 拒绝入库并提示「key 无效或没有 `machines:write` 权限」。
  这一步让「加错了 key」当场暴露，而不是等下一轮 cron 才发现。
- 响应**永远不含明文**，只有 `hint`。
- 三个路由要加进 `WRITE_ROUTES`（`worker.js:62`），否则无密码部署下会被当成公开写接口。
- 删除时若 `config.accounts` 里有该 id 的条目，一并清掉，避免残留脏配置。

## 7. 面板 UI

- 「账号」面板标题右侧加 `+ 添加 Key`。禁用条件与提示：
  - 只读（没配密码/TOKEN）→ 「先配 ADMIN_PASSWORD 或 TOKEN」
  - 没绑 `CONFIG` KV → 「绑 CONFIG KV 后才能保存 key」
  - 没有 `KEY_SECRET`/`SESSION_SECRET` → 「先设一个 KEY_SECRET（`openssl rand -hex 32`）」
- 新 dialog `#key`：名称（可选）、API Key（`type=password`，粘贴即前端校验格式）、当前密码。
- 账号卡片新增：来源 badge（`环境变量` / `面板`）、`hint`、最近成功/失败时间；
  KV 账号多一个红色「删除」（二次确认，可选「顺手释放该账号租约」）。
- 顶部 notice 增加一条全局提示：没设 `KEY_SECRET` 时说明为什么不能加 key。
- 现有 20 秒自动刷新保持不变。

## 8. 改动清单（落点）

| 文件:位置 | 改动 |
|---|---|
| `worker.js:79` `cfg()` | 只加 `vaultSecret` 解析，保持同步（不塞 KV 读） |
| 新增 `vaultLoad / vaultSave / mergeVault` | 读 KV + 解密 + 追加到 `c.accounts` |
| `worker.js:1466` `fetch` / `1473` `scheduled` | `await mergeVault(c)`；失败降级，env 账号照常 |
| `worker.js:240` `normalizeConfig` | 键支持 id，兼容旧数字键并迁移 |
| `worker.js:880` `state()` | `accounts[]` 增加 id/source/hint/lastOkAt |
| `worker.js:62` `WRITE_ROUTES` | 加三个新路由 |
| `worker.js:1001` 附近 | 新增 `keyAdd / keyRemove / keyTest` |
| `ui.js:219` dialog 区 | 新增 `#key` dialog |
| `ui.js:415` `renderAccounts`、`ui.js:556` click 代理 | 来源标签、删除按钮 |
| `wrangler.toml` 注释、`README.md` | `KEY_SECRET` 说明 + 新章节《在面板里加 Key》 |
| `worker/dist/worker.js` | `node worker/build.mjs` 重建（CI 会校验同步） |

## 9. 测试（`worker/test.mjs` 追加，约 11 条）

1. 添加 key → `/api/state` 多一个账号，`hint` 打码，响应无明文
2. KV 里存的不是明文（断言 `!raw.includes("ibk_")`）
3. 未登录 / 只读模式 → 403
4. 缺 `currentPassword` → 400；密码错 → 401 且计入限流
5. 没绑 `CONFIG` → 400 明确提示
6. 没有 `KEY_SECRET`/`SESSION_SECRET` → 400 明确提示
7. 无效 key（API 返回 401）→ 不入库
8. **加两把 → 编号顺延在 env 之后；删中间一把 → 其余账号的 `config.accounts` 不错位**（核心回归）
9. 与 env 重复的 key → 忽略 + warning
10. 解密失败（模拟换 secret）→ 跳过该账号 + warning，env 账号仍正常续租
11. 删除 KV 账号时同步清掉它的 `config.accounts` 条目

## 10. 分阶段落地（4 个提交）

1. **存储层**：`vaultLoad/vaultSave/mergeVault` + `normalizeConfig` 迁移；`state/keepalive/status/release` 接入；补测试 1/2/9/10
2. **接口层**：三个路由 + 密码二次校验 + 限流 + 入库前实测；补测试 3-7/11
3. **UI**：按钮、dialog、来源标签、删除确认、notice
4. **文档与构建**：README 章节、`wrangler.toml` 注释、`dist` 重建、跑全套测试

## 11. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| KV 最终一致（跨地域约 60 秒） | 新加的 key 可能几十秒后才在所有边缘生效 | 面板提示「已保存，最多 1 分钟生效」；本轮立即刷新可见 |
| 换 `KEY_SECRET`/`SESSION_SECRET` | 已存 key 全部解不开 | 保留 `hint` 标红提示；文档写明；建议 `KEY_SECRET` 单独一份、长期不动 |
| 面板泄露 | 攻击者可直接加自己的 key | 二次密码校验 + 限流；KV 密文 |
| 免费版 50 子请求 | 账号多了 `state()` 每账号一次列机器会顶预算 | KV 账号建议 ≤ 5；`state()` 的 `fresh:true` 可改成 10 秒内复用缓存 |
| 账号编号动态变化 | 日志里的 `#N` 与历史对不上 | 日志条目可附带 `id`（可选，后续再做） |

## 12. 明确不做

- 不尝试在运行时写 Cloudflare Secret / 环境变量（要账号级 token，且需 redeploy）
- 不提供明文导出、不在任何响应里回显完整 key
- 不允许在面板里改 env 账号（env 仍然是「只读、优先级最高」的基线）
