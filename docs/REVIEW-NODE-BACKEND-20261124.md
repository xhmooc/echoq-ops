# EchoQ-Ops Node 后端代码审查报告

- 审查日期：2026-11-24
- 审查范围：`desktop/src/`（Electron 主进程内 Node/TS 后端，端口 8711），并与原 Python 版（`ops/`，端口 8710）做问题迁移对照。
- 审查方式：静态通读 + 关键路径人工核实（行号以当前工作区代码为准）。
- 状态：仅审查，未修改任何代码。

---

## 1. 总体结论

Node 版整体质量高于 Python 版：分层清晰（core / services / platforms / render / server），发布队列状态机健全，浏览器生命周期管理到位，付费接口不再经过桌面端。上一轮 Python 审查发现的高危问题中，**队列重复入队、付费重复扣费、浏览器泄漏、SSRF** 均已消除。

但仍有 **5 个高危问题**，其中 2 个是 Python 老问题的换形态复现（失败分类误判、公众号同标题发旧稿），1 个是功能性缺失（定时任务永不自动执行），2 个是本地 HTTP 服务的安全边界问题（CSRF、畸形 URL 悬挂）。

---

## 2. Python → Node 问题迁移对照

| Python 版问题 | Node 版现状 |
| --- | --- |
| jobs 表 `UNIQUE(draft_id, account_id)` 对 NULL 不去重，无账号入队并发重复发布 | ✅ 已修复：任务认领用条件 UPDATE 原子防重；异常一律进 `pending_confirm` 不自动重发；重启回收区分已提交/未提交 |
| 付费出图失败不幂等、重复扣费；全局锁饿死本地渲染 | ✅ 无对应面：desktop 侧配图全部本地模板渲染，不调付费生成接口 |
| 每张图新起 Chromium、句柄泄漏 | ✅ 渲染窗口串行复用、失败销毁（render/renderer.ts）；扫码会话独立 partition、过期即销毁（platforms/wechat/qr.ts） |
| 远程 `image_url` 下载无协议校验（SSRF） | ✅ 已消除：只接受本地图片路径 |
| Fernet 兼容实现风险 | ✅ core/fernet.ts：HMAC 先验证后解析、`timingSafeEqual` 防时序攻击，符合规范 |
| 模板注入 | ✅ templates.ts 用户文本统一经 `esc()` 转义 |
| 失败分类误判（auth/content 宽泛词优先） | ❌ **换形态复现**，见高危 #2 |
| 公众号按标题 10 分钟复用旧 draft_id，发旧稿 | ❌ **完整复现**，见高危 #3 |
| 优雅退出缺失 | ⚠️ 部分改善：有 `before-quit` 清理与单实例锁，但 `uncaughtException`/`unhandledRejection` 只记日志不退出 |

---

## 3. 高危问题（已逐一人工核实）

### H-1 定时任务永远不会自动执行

- 位置：`desktop/src/main/main.ts:94-100`、`desktop/src/server/routes.ts:1200`、`desktop/src/services/schedulerEngine.ts:772`
- 现象：主进程只启动发布队列循环 `startLoop()`；`tickSchedules()` 唯一入口是 `POST /api/worker/tick` 且 `action === "schedule"`，但前端 `app.js:9276` 调用 tick 时不带 action，全仓库无任何定时器驱动调度。
- 影响：**所有启用的定时任务都不会到点执行**；补跑逻辑（schedulerEngine.ts:748-754）为死代码。
- 修复建议：在主进程 `whenReady` 后增加调度 interval（如 30s）调用 `tickSchedules()`，并加防重入锁；保留 HTTP 手动触发入口。

### H-2 失败分类误判（Python 问题换形态复现）

- 位置：`desktop/src/services/worker.ts:75-95`（hint 表）、`worker.ts:145-152`（`classifyError`）
- 问题：
  1. `AUTH_HINTS` 含 `"401"`、`"session"` 子串，且匹配文本混入**原始响应 JSON**（`safeJson(result, 800)`）——错误码 14012、响应字段 `sessionid` 等都会判成 auth，账号被误置 expired（worker.ts:443-449）；
  2. AUTH 先于 RATE 判断，含“标题”等词的限流/临时错误被判 content，直接终态失败不重试（worker.ts:433）；
  3. 小红书 `friendlyError`（adapter.ts:242）同样 auth 先于 rate。
- 修复建议：优先信任适配器显式返回的 `kind`；文本兜底不要拼接原始 JSON，只拼人类可读 message；调整 hint 顺序（rate/auth 特征词先行、收窄子串）；`401` 改为全词/错误码匹配。

### H-3 公众号“同标题发旧稿”（Python 问题完整复现）

- 位置：`desktop/src/platforms/wechat/publish.ts:242-273`（`findRecentDraft`）、`publish.ts:366-368`
- 问题：按标题复用 10 分钟内的旧 draft_id，复用后**不更新正文与封面**。改稿重发会把旧内容发出去。
- 修复建议：复用 draft 时调用草稿更新接口覆盖标题/正文/封面；或直接去掉按标题去重，每次新建草稿。

### H-4 本地 API 可被任意网页跨站调用（CSRF）

- 位置：`desktop/src/server/http.ts:112-133`（`readBody` 不校验 Content-Type）、`http.ts:180-188`（无 Origin/Host 校验）
- 问题：服务虽只绑 127.0.0.1，但浏览器中任意网页可用 `text/plain` 简单请求直接 POST JSON 到 `http://127.0.0.1:8711/api/...`（不触发 CORS 预检），可调用删账号、恢复备份、重置云端 Key 等破坏性接口。
- 修复建议：校验 `Origin`/`Referer`/`Host`（仅允许本机来源与本地主机名），或要求自定义请求头（如 `X-EchoQ-Client: 1`）；对写接口强制 JSON Content-Type。

### H-5 畸形 URL 导致请求悬挂

- 位置：`desktop/src/server/http.ts:74`（`match()` 内 `decodeURIComponent`）、`http.ts:180`（`match` 在 try 块之外调用）
- 问题：`GET /api/x/%zz` 抛 URIError，发生在 try 之外，该请求得不到任何响应，socket 挂起。
- 修复建议：把 `router.match(...)` 挪进 try，或在 `match()` 内 try/catch 解码、解码失败按 400 处理。

---

## 4. 中危问题

| 编号 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| M-1 | `desktop/src/services/worker.ts:841` | worker tick 无重入保护：setInterval 20s，单次发布可达分钟级，tick 重叠形成无上限并行浏览器发布；HTTP 手动 tick 可再叠加 | 加 `isTicking` 防重入标志；重叠时跳过本轮 |
| M-2 | `desktop/src/platforms/wechat/publish.ts:79-95`、`desktop/src/platforms/xiaohongshu/publish.ts:87-101` | 素材路径对任意存在的绝对路径直接读取并上传，未限制在应用/数据目录内，构成任意文件读取外发 | 校验路径必须位于 `DATA_DIR`（uploads/assets/designs）内，resolve 后做前缀检查 |
| M-3 | `desktop/src/platforms/xiaohongshu/sign.ts:104-108, 263, 340-350` | 含完整 Cookie 的签名 payload 以命令行参数传给子进程（<8KB 时），本机其他进程可从进程列表读取 | 改为 stdin 传递；临时文件方案保留用后即删 |
| M-4 | `desktop/src/platforms/xiaohongshu/publish.ts:405-417` | `post_note` 对 `code=-1` 盲目重发同一 payload 最多 3 次且无幂等键，首次实际已受理时会重复发笔记 | 仅对明确网络类错误重试；携带客户端幂等标识 |
| M-5 | `desktop/src/core/accounts.ts:76-128` | `listAccounts → serialize → publishedToday` 每账号一条带 LIKE 的同步 COUNT（N+1），better-sqlite3 同步执行在 Electron 主进程，账号多时阻塞界面 | 改为一条 GROUP BY 聚合（listAccountsFiltered 已有示范） |
| M-6 | `desktop/src/services/uploads.ts:85-111` | 上传整包缓冲上限 256MB 且 `writeFileSync` 同步写盘，运行在主进程，大文件上传期间全部请求与 worker 停摆；`parseParts` 丢弃文件名含 `=` 的字段 | 限制更合理的上限、流式/异步写盘；修复 multipart 字段解析 |
| M-7 | `desktop/src/platforms/wechat/client.ts:179-193` | fetch 未设超时/AbortSignal，依赖默认 300s，平台挂起长期占住发布 worker | 统一封装带 AbortSignal.timeout 的请求 |
| M-8 | `desktop/src/main/main.ts:51-54` | `setWindowOpenHandler` 对任意 URL 直接 `shell.openExternal`，无协议白名单 | 仅放行 https/http，其余拒绝 |
| M-9 | `desktop/src/platforms/wechat/publish.ts:148-190` | `uploadCover` 多接口候选循环：上一接口上传成功但响应解析失败时换接口重传同一文件，产生重复素材 | 解析失败不要换接口重传 |

---

## 5. 低危问题（择要）

| 位置 | 问题 |
| --- | --- |
| `desktop/src/services/queue.ts:36`（parseWhen） | `2026-11-24` 这类 date-only 按 UTC 解析（北京时间偏 8 小时）；`2026/11/24 10:00` 解析失败静默返回 0，变成立即执行 |
| `desktop/src/services/worker.ts:523-535` | 退避封顶 300s 与风控冷却最长 3h 不匹配，冷却期内任务每 5 分钟空转一次 |
| `desktop/src/services/queue.ts:236` | 已存在无账号活跃任务时，指定账号的入队被静默吞掉返回 existed，多账号投放会少发 |
| `desktop/src/services/schedulerEngine.ts:973,1001` | `confirmRun` 检查与写入之间有 await，并发确认可同时通过检查（目前靠入队活跃预检兜底） |
| `desktop/src/services/schedules.ts:79-91`、`schedulerEngine.ts:749` | 时区硬编码 UTC+8，跨时区机器整体偏移；interval 错过只顺延不补跑 |
| `desktop/src/core/log.ts:10-11` | 每条日志同步 mkdir+appendFile，无轮转与大小上限，长期运行无限增长并阻塞主进程 |
| `desktop/src/core/db.ts:35-46` | queryAll/queryOne/execute 每次重新 `prepare`，热路径无预编译语句缓存 |
| `desktop/src/core/zip.ts:47,114` | 同步 deflate/inflate 处理大备份会阻塞主进程；解包对中央目录无边界与 CRC 校验 |
| `desktop/src/main/main.ts:24-29` | uncaughtException/unhandledRejection 仅记日志不退出，写库中途崩溃后可能带伤运行 |
| `desktop/src/platforms/xiaohongshu/api.ts:488` 附近 | `creatorUploadBinary` 用服务端返回的 uploadHost/fileId 拼 URL，仅校验 https 前缀 |
| `desktop/src/services/richtext.ts:116-117` | DROP_WITH_CONTENT 正则对未闭合标签只删标签本身，内容以纯文本残留（白名单已挡标签，不构成 XSS，仅脏内容） |

---

## 6. 建议修复顺序

1. **H-1 调度器驱动** —— 定时发布目前完全不可用，属功能缺失；
2. **H-4 + H-5 http.ts 两处** —— 改动小、安全收益大；
3. **H-2 classifyError 收敛** —— 防止误杀账号、误终止重试；
4. **H-3 公众号草稿复用** —— 防止发旧稿；
5. **M-1 tick 防重入 + M-2 素材路径白名单 + M-3 Cookie 改 stdin**；
6. 中低危按迭代节奏消化。

---

## 7. 附：本次审查未发现问题的模块

- `core/fernet.ts`（Fernet 兼容解密实现正确）
- `main/preload.ts`（仅暴露 `pickImage`，暴露面最小）
- `core/config.ts`、`core/settings.ts`、`core/platform.ts`、`core/contentText.ts`
- `render/renderer.ts`、`render/templates.ts`、`render/cards.ts`（转义与资源管理到位）
- `services/cloud.ts`（票据加密、401 清理、原子写正确）
- `services/drafts.ts`、`topics.ts`、`overview.ts`、`misc.ts`、`copy.ts`、`tasks.ts`、`published.ts`、`backup.ts`（初审未发现并发/时间/资源类确定问题）
- 发布队列状态机（claim 条件更新、pending_confirm、重启回收）设计健全
