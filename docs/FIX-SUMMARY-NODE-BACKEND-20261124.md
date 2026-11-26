# EchoQ-Ops Node 后端修复变更摘要

- 修复日期：2026-11-24
- 依据：`docs/REVIEW-NODE-BACKEND-20261124.md`（5 高危 + 9 中危 + 11 低危，共 25 条）
- 范围：仅 `desktop/src/**`；未改动 `ops/**` 与 `ops/web/static`；未新增依赖
- 验证：`npx tsc -p tsconfig.json --noEmit` 通过；`npm run build` 通过；临时库冒烟通过

---

## 1. 高危问题（5）

| 编号 | 问题 | 修复方式 |
| --- | --- | --- |
| H-1 | 定时任务永不自动执行 | 主进程在端口监听后每 30 秒调用 `tickSchedules(2)`，退出时清理定时器；保留 `POST /api/worker/tick` 手动入口（`main/main.ts`） |
| H-2 | 失败分类误判（AUTH 优先、混入原始 JSON） | 重写 `classifyError`：原顺序改为 限流 → 登录 → 内容 → 平台 → 网络；只使用人类可读 message，不再拼接响应 JSON；`401` 改为独立词匹配；小红书 `friendlyError` 同样限流前置（`services/worker.ts`、`platforms/xiaohongshu/adapter.ts`） |
| H-3 | 公众号同标题复用旧草稿导致发旧稿 | 删除 `findRecentDraft` 复用逻辑，每次发布都新建草稿（`platforms/wechat/publish.ts`） |
| H-4 | 本地 API 可被任意网页跨站调用（CSRF） | 新增 Host / Origin / Referer 本机校验（127.0.0.1、localhost、::1）；写接口带请求体时强制 `application/json`，multipart 上传例外（`server/http.ts`） |
| H-5 | 畸形 URL 导致请求悬挂 | `decodeURIComponent` 失败抛 400；路由匹配移入统一 try；请求入口兜底 catch，任何异常都返回响应（`server/http.ts`） |

---

## 2. 中危问题（9）

| 编号 | 问题 | 修复方式 |
| --- | --- | --- |
| M-1 | 发布/调度 tick 可重入 | `tick()` 与 `tickSchedules()` 增加防重入标志，重叠时跳过本轮（`services/worker.ts`、`services/schedulerEngine.ts`） |
| M-2 | 素材路径可读取任意本地文件并上传 | 新增 `withinDataDir()` 校验，素材必须位于 `DATA_DIR` 内；公众号封面选择改为先复制到 `uploads` 再使用（`platforms/wechat/publish.ts`、`platforms/xiaohongshu/publish.ts`、`main/main.ts`） |
| M-3 | 含 Cookie 的签名 payload 作为命令行参数 | 始终写临时文件并以 `@路径` 传给子进程，`finally` 中删除（`platforms/xiaohongshu/sign.ts`） |
| M-4 | `code=-1` 盲目重发产生重复笔记 | 去掉重试循环，只提交一次；失败按文案区分 rate/auth/platform（`platforms/xiaohongshu/publish.ts`） |
| M-5 | 账号列表 N+1 查询阻塞主进程 | 新增 `publishedTodayMap()` 单条 GROUP BY 聚合，`listAccounts` / `listAccountsFiltered` 复用（`core/accounts.ts`） |
| M-6 | 上传缓冲 256MB、同步写盘、字段名含 `=` 被丢弃 | 上限降至 128MB；改用 `fs.promises.writeFile` 异步写盘；multipart 按首个 `=` 切分（`services/uploads.ts`） |
| M-7 | 公众号请求无超时 | 统一加 `AbortSignal.timeout(120s)`（`platforms/wechat/client.ts`） |
| M-8 | 任意 URL 直接 `shell.openExternal` | 仅放行 `http:` / `https:`，其余忽略（`main/main.ts`） |
| M-9 | 上传成功但响应解析失败时换接口重传 | 已收到响应后解析失败直接抛错，不再换接口重复上传（`platforms/wechat/publish.ts`） |

---

## 3. 低危问题（11）

1. `parseWhen`：按本机时区解析；兼容 `2026/11/24 10:00`；非法时间返回 400 错误，不再静默立即发布（`services/queue.ts`）。
2. 退避上限由 300 秒改为 3 小时，与风控冷却对齐，避免每 5 分钟空转（`services/worker.ts`）。
3. 指定账号入队不再被「无账号活跃任务」吞掉，冲突时明确报错（`services/queue.ts`）。
4. `confirmRun` 用条件 UPDATE 原子认领 `confirmed_at`，防并发重复确认（`services/schedulerEngine.ts`）。
5. 定时计算与补跑提示改用本机时区，移除硬编码 UTC+8（`services/schedules.ts`、`services/schedulerEngine.ts`）。
6. 日志文件超过 5MB 轮转一次为 `desktop.1.log`（`core/log.ts`）。
7. `queryAll` / `queryOne` / `execute` 使用预编译语句缓存，`closeDb` 时清空（`core/db.ts`）。
8. ZIP 压缩/解压改为异步（不再阻塞主进程）；解包增加中央目录边界、加密条目、ZIP64、大小与 CRC 校验；`backup.ts` 改为 await（`core/zip.ts`、`services/backup.ts`）。
9. `uncaughtException` / `unhandledRejection` 记录日志后退出，不再带伤运行；相关 fire-and-forget 调用补 `.catch`（`main/main.ts`、`platforms/xiaohongshu/api.ts` 等）。
10. 小红书上传域名限制为 `xiaohongshu.com` / `xhscdn.com` / `xhs.cn` / `rednotecdn.com` 及其子域（`platforms/xiaohongshu/api.ts`）。
11. 未闭合的危险标签（如 `<script>`）从开标签整段丢弃，避免内容以纯文本残留（`services/richtext.ts`）。

---

## 4. 行为变化说明

- 公众号封面从对话框选择后会被复制到数据目录（`uploads/cover-*.png|jpg`）；引用数据目录之外绝对路径的旧草稿会被拒绝，需要重新上传。
- 无法识别的时间字符串现在返回 400 并提示格式，而不是当作立即发布。
- 指定账号入队时若已存在同一草稿的「任意账号」活跃任务，会提示先在队列中取消，而不是静默返回 existed。
- 主进程遇到未捕获异常会直接退出，由用户重启（日志保留）。

---

## 5. 验证记录

- 类型检查：`npx tsc -p tsconfig.json --noEmit` 通过。
- 构建：`npm run build` 通过。
- 临时库冒烟（`ELECTRON_RUN_AS_NODE=1`）：
  - `parseWhen` 本地时区 / 斜杠格式 / 非法时间报错 —— PASS
  - ZIP 往返一致，篡改字节能被 CRC 检出 —— PASS
  - 未闭合 `<script>` 内容被丢弃 —— PASS
  - 账号列表聚合查询可执行 —— PASS
  - HTTP：跨站 Origin 返回 403；`text/plain` 写 JSON 返回 415；正常 JSON 返回 200；`/api/items/%zz` 返回 400 —— PASS
