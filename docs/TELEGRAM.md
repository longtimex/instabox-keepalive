# Telegram 机器人：在手机上开关沙箱机器

不想开电脑时，用手机把机器叫醒或关掉。机器人跑在**同一个 Cloudflare Worker** 里（webhook 模式），不用额外机器、不用常驻进程、不用装任何东西。

```
/wake qqq     唤醒 + 续租 + 恢复保活
/sleep qqq    休眠（保留内存，几秒回来）
/stop qqq     关机（下次冷启动）
/window       保活区间：只在要用的时段烧机
```

## 一、建机器人

1. Telegram 里搜 **@BotFather** → 发 `/newbot` → 起名字 → 起一个以 `bot` 结尾的用户名
2. 拿到一串 token，形如 `8123456789:AAH...`（**这就是密码，别贴到公开地方**）
3. 想改头像/描述就 `/setdescription`；改不了也不影响用

> 机器人默认是「谁能搜到都能发消息」的。控制权靠下面的 `TELEGRAM_CHAT_ID` 白名单，不靠机器人本身。

## 二、填配置（两种方式，任选）

### 方式 A：网页面板（推荐，不用进 Cloudflare 后台）

打开 `https://<worker>/ui` 登录，找到「**Telegram 机器人**」卡片：

1. `Bot token` 填第 1 步拿到的 token
2. `Webhook secret` 点右边的「随机生成」（16 字节 hex，直接进 URL 路径，别手打特殊字符）
3. `允许的 chat id` 先空着
4. 点「**保存并注册**」—— 一步做完「存配置 + setWebhook + setMyCommands」

然后给机器人随便发条消息，它会回你一个数字（你的 chat id），填进 `允许的 chat id` 再点一次「保存并注册」。

> 面板填的值存在 `CONFIG` KV 的 `telegram` 键里，**优先于环境变量**。token/secret 输入框留空表示「不改」，点「清空」就回退到环境变量。接口永远只返回打码值（`8675…K9dw`），明文只在 KV 和 Worker 内存里。
>
> **secret 没填会自动生成。** 有 token 却没有 secret 时，`/tg` 就是一个谁都能 POST 的公开接口 —— chat id 是请求体里写的，挡不住伪造。所以面板保存时会自动补一个 32 位 hex，并提示「secret 自动生成」。
>
> 这个设计是因为 Worker 改不了自己的环境变量 —— 面板能配的东西只能落 KV。要更严格的话就用方式 B，完全不碰 KV。

**保存后等十几秒再发消息。** Cloudflare KV 是最终一致的（跨数据中心最多 60 秒同步），刚保存完的那几十秒里，打到别的机房的 update 可能还看到旧配置 —— 表现是「发消息没反应」或 503。等一会儿或再发一次就好，不是坏了。

### 方式 B：环境变量

Cloudflare 面板 → 你的 Worker → `Settings` → `Variables and Secrets`：

| 变量 | 类型 | 值 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **Secret** | BotFather 给的 token |
| `TELEGRAM_CHAT_ID` | Text | 允许操作的人的 chat id，多个用逗号分隔 |
| `TELEGRAM_WEBHOOK_SECRET` | **Secret** | 自己起一串随机值，例如 `openssl rand -hex 16` |

`TELEGRAM_CHAT_ID` 先留空也行 —— 配好前两个变量、给机器人随便发条消息，它会把你自己的 chat id 回给你，复制过来填上再发一次就好了。

> **必须配 `TELEGRAM_CHAT_ID`**：不配的话机器人只回显 id，不执行任何操作。这是防止陌生人拿到你的机器人就直接关机。

## 三、注册 webhook

方式 A 已经包含这一步了。方式 B 需要手动注册一次 —— 浏览器里已经登录过面板，直接打开下面这个地址就行（靠会话 cookie 认证）：

```
https://<你的worker>.workers.dev/api/telegram?action=set
```

用 curl / 脚本跑，就带上 `TOKEN` 变量的值：

```sh
curl "https://<你的worker>.workers.dev/api/telegram?action=set&token=<你的TOKEN>"
```

> `?token=` 只认 `TOKEN` 这个变量，**不是**面板登录密码。没设 `TOKEN` 的话，要么在浏览器里登录后打开，要么先补一个 `TOKEN`（`npx wrangler secret put TOKEN`）。

返回 `"ok": true` 就成了。它做的事是两件：`setWebhook`（把 `https://<worker>/tg/<secret>` 注册给 Telegram，并带上 `secret_token`，Telegram 每次推送都会在 `X-Telegram-Bot-Api-Secret-Token` 头里回传，对不上的一律 403）+ `setMyCommands`（注册输入框旁边那个命令菜单）。

返回体里 `commands` 是 `10` 就说明菜单也注册好了，`url` 是实际注册的地址。

改过 `BOT_COMMANDS`（`worker/telegram.js` 里那个数组）只想刷新菜单、不想动 webhook：

```
https://<你的worker>.workers.dev/api/telegram?action=menu&token=<你的TOKEN>
```

看当前状态（调试用）：

```
https://<你的worker>.workers.dev/api/telegram?action=info&token=<你的TOKEN>
```

`last_error_message` 是空的就说明 Telegram 推得进来。换域名、换 secret 之后要重新 `action=set` 一次。

## 四、命令

菜单里注册了 10 条，输入框左侧的 ☰ 或直接打 `/` 就能看到，顺序即下表顺序：

| 命令 | 作用 |
| --- | --- |
| `/ls`（`/list` `/status`） | 机器列表，点任意一台进操作面板 |
| `/wake <机器>`（`/on` `/resume`） | 唤醒（按官方文档分流，见下）+ 续租 + **恢复保活** |
| `/sleep <机器>`（`/suspend`） | 休眠：保留内存和进程，唤醒几秒回来 + 释放租约 + **关掉保活** |
| `/stop <机器>`（`/off`） | 关机：彻底停掉，下次冷启动 + 释放租约 + **关掉保活** |
| `/window [机器]` | 默认或单机保活区间（时间段 + 单次上限），见下节 |
| `/keep <机器> on\|off` | 只切保活开关，不动机器 |
| `/renew <机器>` | 手动续一次租约 |
| `/release <机器>` | 放掉租约；若全局保活仍开着，下一轮 cron 会重新续租。不占菜单位，手打即可 |
| `/pause on\|off` | 全局暂停/恢复 cron 保活。暂停记录来源和时间；手动 `/wake` `/renew` 仍可用，但 cron 不会接手 |
| `/id` | 看当前聊天的 chat id |
| `/help` | 帮助 |

机器参数可以写名字（`qqq`）或 id（`m_xxx`）；多账号下同名机器会一起操作，回执里逐台列结果。

面板里的按钮是同一套动作，点一下就行：唤醒 / 休眠 / 关机 / 续租 / 放租约 / 保活开关。

### 保活区间：让机器只在要用的时段烧

`/window` 管理所有机器的默认区间；`/window 机器名` 打开这台机器的独立区间面板。

| 写法 | 作用 |
| --- | --- |
| `/window` | 看当前设置 + 按钮面板 |
| `/window 08:00-23:00` | 设时间段**并打开**（`-`、`–`、`~`、`至`、`到` 都认，也能写 `8:00-23:00`） |
| `/window 09:00-12:00,14:00-18:00` | **设多段**（逗号、顿号、空格分隔都行，最多 8 段） |
| `/window 09:00-12:00,14:00-18:00 90` | 多段 + 单次上限 90 分钟；最后的分钟数可省略 |
| `/window on` / `/window off` | 只开 / 关时间段，不改已存的值 |
| `/window 09:15-17:45 90` | 任意起止时间 + 单次上限 90 分钟 |
| `/window max 180` | 单次最长连续保活 180 分钟，`0` = 不限 |
| `/window 机器名` | 看这台机器的区间（显示是否跟随默认） |
| `/window 机器名 09:00-12:00,14:00-18:00 90` | 只给这台机器设多段和上限，不改默认值 |
| `/window 机器名 09:00-18:00` | 只给这台机器设时段并打开 |
| `/window 机器名 max 120` | 只改这台机器的单次上限 |
| `/window 机器名 on` / `off` | 开关这台机器的时段 |
| `/window 机器名 reset` | 删掉这台机器的覆盖，恢复跟随默认 |

语义和网页面板完全一致（同一份 `CONFIG`）；机器详情里也有「这台机器的区间」按钮。**时间段固定按北京时间（UTC+8）**，两个维度取交集，`start === end` 算全天，`22:00-06:00` 这种跨午夜也认。**手动操作不受区间限制** —— 你按 `/wake`，它就唤醒，不会因为「现在不在区间」被拒。

**多段之间各自计时**：每进入一段，单次上限从 0 重新算。所以 `09:00-12:00,14:00-18:00` + `120` 的效果是「上午跑两小时、下午再跑两小时」，上午用掉的时间不会拖累下午。

面板里每段一个「🗑 删 N」按钮（编号和正文列表对应），下面四个 `＋` 按钮是**追加**一段（不覆盖已有的）；想整体替换成别的组合，直接发 `/window` 命令。`✍️ 任意时段` 会提示你直接输入，例如 `/window 06:35-22:47 95`。回执第一段就写着当前阶段：

```
⏰ 默认保活区间
时间段：08:00 – 23:00
单次上限：120 分钟

▶ 正在保活（北京时间 10:55，本轮已 42 分钟）
```

不在时段是 `⏸ 现在不在区间内（北京时间 10:55）`，触顶是 `⏸ 本轮已保活 120 分钟，到 120 分钟上限了`。

### 全局暂停与健康心跳

Telegram 的列表摘要和暂停回执会显示：

```text
保活：⏸ 已全局暂停 · 2026-11-06 00:49（北京时间） · 来源 telegram
⚠️ cron 不会调用 InstaBox；现有租约到期后机器会休眠

保活：✅ 开着（1 台在保） · 最近成功续租 2026-11-07 11:45（北京时间）
```

`/pause on` 只停自动续租，手动 `/wake` 和 `/renew` 仍然可用。此时唤醒成功也会额外提示“全局保活仍暂停”，避免误以为 cron 会接手。`/pause off` 后下一轮 cron 自动续租，想立即恢复可发 `/renew 机器名`。

`/renew`、`/wake` 成功后推进 `live.lastLeaseAt`；摘要会提示租约已过期或 2 分钟内到期的机器；`/release`、`/sleep`、`/stop` 释放租约后会清掉已经失效的心跳。`/api/health` 因此能区分“暂停 / 调度停摆 / 持续续租失败”。

### 唤醒走哪条路，是按官方文档分情况的

| 机器状态 | 机器人实际发的请求 | 说明 |
| --- | --- | --- |
| 自己空闲挂起（`autoSuspendedAt` 有值） | `POST /v1/machines/{id}/wake` | 服务端替我们等最多 45 秒，一次请求搞定 |
| 你手动 suspend 的 | `POST /resume` | `wake` 对「你主动挂起的」机器不生效 |
| 已关机（`stopped`） | `POST /start` | 冷启动，回执里会写「冷启动」 |

所以同一个 `/wake`，对「睡着的」和「被你关掉的」机器走的不是同一条 API —— 这是官方文档明确区分的两条路，不是随便挑一个。

### 冷却：叫不醒是正常的

机器连续运行到 `maxRunMinutes` 会被平台强制暂停。免费机每个新 run 初始给 2 小时，按前 30 分钟的真实工作分钟数决定是否延长；续租和唤醒都不算工作，单个 run 最晚 8 小时暂停。之后进入冷却：默认 5–20 分钟，免费版连着触发会升到 60–75 分钟、120–135 分钟。这期间**任何唤醒方式都会被拒**（`409 machine_cooldown`）。

冷却有两种，机器人会分开说：

- **max-run 到点** → `⏳ 冷却：还要 15m 才能唤醒（max-run 到点，平台限制）`
- **自动安全审查锁住**（`cooldownReason=abuse_*`：出站黑名单 / 网络扫描 / CPU 挖矿）→ `🔒 安全审查锁：还要 23h50m 才能唤醒（最长 24 小时，平台限制）`

第二种最长 **24 小时**，别当成普通的几分钟冷却。误锁可以按官方提示申诉（`instabox feedback` 或 support@instabox.sh）。

列表和详情里也会标 `⏳ 冷却 14m59s`。保活 cron 遇到冷却**不会告警**，只会在冷却结束后自动续上 —— 否则免费版跑满 8 小时后会连着几小时每 30 分钟弹一条。

另外两种平台限制同样不告警：

- `429 rate_limited`：免费版每分钟只允许 3 次启动（create/start/resume/wake），多台机器同时挂起时会撞上，等一分钟下一轮就好
- `402 early_allowance_ended`：免费额度用完，启动被拒。这个不会自己好，得先暂停/删除一台机器，或升级套餐

### 休眠中的机器不能直接关机

官方原文：**A paused machine cannot be stopped; resume or delete it.** 对休眠中的机器发 `stop` 只会拿到 409。机器人会提前拦下来并给两条路：

```
⚠️ box2 现在是休眠状态，平台不允许直接关停休眠中的机器。
· 想省资源、保持现状 → /sleep（内存还在，唤醒是秒级的）
· 一定要彻底关机 → 先 /wake 再 /stop
```

## 五、为什么「关」要顺带关保活

这是整个功能最容易踩的坑：**本仓库的 cron 每 5 分钟续一次租约，撞上 `409 machine_not_running` 就会自动 `resume`/`start`**。也就是说，如果只把机器 suspend 掉，保活会在几分钟内把它叫醒 —— 你看到的现象是「关了又自己开了」。

所以机器人的「休眠/关机」是两步：

1. 先把这台机器写进 `CONFIG` 的 **skip 名单**（`accounts["1"].skip = ["m_xxx"]`）
2. 再 `suspend`/`stop`，并释放租约

`skip` 是叠在 `mode` 之上的一层，**不会**把 `mode=all` 的账号改成白名单模式 —— 所以你以后新建的机器照样自动保活，只有你点名关掉的那几台不动。`/wake` 会把 skip 摘掉，机器回到正常保活。

顺序也是故意的：先关保活再动机器。反过来的话，cron 可能正好卡在中间看到机器被挂起，一路 resume 回来。

> 面板上「保活」那一列的勾选状态会把 skip 算进去，所以机器人和网页面板看到的是同一个事实。
> 在面板里手动把某台勾回来（`mode=list` + 把它写进 machines）也会让 skip 失效，因为白名单优先。

**前提：Worker 必须绑 `CONFIG` KV。** 没绑的话 skip 名单存不下来，`/sleep` `/stop` 会直接回
「没绑 CONFIG KV，保活开关存不下来」并**拒绝执行**——宁可不动，也不做「机器关了、保活还在叫」的半成品。

## 六、安全边界

- **白名单**：只有 `TELEGRAM_CHAT_ID` 里的聊天能操作，其它人发消息只会收到「没在允许名单里」
- **webhook 双校验**：路径里的随机串 + `X-Telegram-Bot-Api-Secret-Token` 头，两个都对才处理。光靠 chat id 不够 —— 别人知道你的 webhook 地址就能伪造 update
- **不落 key**：机器人从 `env` 里拿 `INSTABOX_API_KEY`，不经过 KV、不进消息、不进日志
- **永远回 200**：处理失败也回 200，否则 Telegram 会重投同一条更新，一次「关机」可能被执行好几次
- **`/api/telegram` 要凭据**：没配 `ADMIN_PASSWORD`/`TOKEN` 时它跟其它写接口一样被拒（403），免得被人抢先注册 webhook
- `/api/telegram` 的 `set` / `info` 响应会把 webhook URL 路径脱敏成 `/tg/***`；完整 secret 只用于向 Telegram 注册，不进入面板响应
- Telegram 对 `429`、短暂 `5xx` 和网络错误最多自动重试一次；权限或参数类 `4xx` 不重试，避免制造重复消息
- **面板里配 bot 的代价**：token 明文存在 `CONFIG` KV 里，能登录面板的人就能改它。也就是说**面板被攻破 ≈ 机器人被接管**（可以把 webhook 指到别处）。不过面板本来就能关机、改保活，危害等级是一样的 —— 真正的边界是面板密码本身。介意的话走方式 B，把 token 只放在环境变量里。

## 七、常见问题

| 现象 | 原因 / 处置 |
| --- | --- |
| 发消息没反应 | `action=info` 看 `last_error_message`；地址换了要重新 `action=set` |
| 回了 chat id 但没动作 | 没配 `TELEGRAM_CHAT_ID`，或填的不是这个 chat |
| 说「保活没关掉」 | 没绑 `CONFIG` KV：开关存不下来，cron 下一轮还会叫醒机器 |
| 关机后几分钟又起来了 | 同上，或者你在面板里把它的白名单勾回去了 |
| 唤醒后提示「还没到 running」 | 机器人只等 ~12 秒（Telegram 要求 60 秒内回包）。机器还在启动，点刷新看；skip 已经摘掉，cron 会接手续租 |
| 点按钮一直转圈 | 回调没应答。看 Worker 日志有没有异常 |
| `setWebhook` 报 400 | `TELEGRAM_WEBHOOK_SECRET` 只能用 `A-Z a-z 0-9 _ -`，1–256 位 |

## 八、本地调试

```sh
cd worker
npm test                          # 含机器人回归（webhook 鉴权 / skip 联动 / 单机区间 / 回调链路）
npm run build && npx wrangler dev dist/worker.js
```

本地 `wrangler dev` 拿不到公网地址，Telegram 推不进来。要联调就用真 Worker，或者用 `curl` 直接模拟一条 update：

```sh
curl -sS -X POST "https://<worker>/tg/<secret>" \
  -H "X-Telegram-Bot-Api-Secret-Token: <secret>" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1,"message":{"message_id":1,"from":{"id":<chatid>},"chat":{"id":<chatid>},"text":"/ls"}}'
```

回 `ok` 就说明处理完了 —— 消息会真的发到你的 Telegram 上。
