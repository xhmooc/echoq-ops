# 接口文档

服务默认监听 `http://127.0.0.1:8710`，只对本机开放。所有接口返回 JSON，文件类路由（`/`、`/assets/`、`/designs/`、`/uploads/`、`/static/`）除外。

## 1. 通用约定

### 响应格式

成功：

```json
{ "ok": true, "data": ... }
```

列表额外带分页：

```json
{ "ok": true, "data": [...], "total": 42, "limit": 20, "offset": 0 }
```

失败：

```json
{ "ok": false, "error": "给用户看的中文原因", "error_id": "a1b2c3d4" }
```

`error_id` 只在 500 时出现；拿它去数据目录的 `logs\ops.log`（默认 `%LOCALAPPDATA%\EchoQ-Ops\data\logs\ops.log`）搜索即可定位堆栈。业务类 500（如配图版式自检失败）会在 `error` 里直接给出可读原因，编号作为附加信息；含绝对路径或过长的内部原文只进日志，不透出到接口。

### 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 202 | 已受理，返回后台任务 id（`/api/drafts`、`/api/published/sync`） |
| 400 | 参数错误、平台未接入、账号与草稿平台不一致等 `ValueError` |
| 404 | 资源不存在（`KeyError`） |
| 500 | 未预期异常；业务异常带可读原因，统一附 `error_id` 供回查 |

### 通用字段

- 时间：除特别说明外均为 **epoch 秒**（整数）。
- 平台：`xiaohongshu` / `wechat_mp` / `douyin`。未接入平台返回 `platform_ready=false`。
- 分页：`limit` 默认因接口而异，`offset` 从 0 开始。
- 鉴权：**当前没有接口鉴权 / CSRF 防护**，安全边界完全依赖「只监听 127.0.0.1」。详见 `docs/REVIEW.md`。

---

## 2. 基础与平台

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/` | — | 单页界面 HTML |
| GET | `/api/health` | — | `{status:"ok", data_dir, key:{path, exists, outside_data_dir, restricted, warning}}` |
| GET | `/assets/{draft_dir}/{filename}` | 路径参数 | 图片文件；`..`、反斜杠、越界路径返回 404 |
| POST | `/api/uploads` | `multipart/form-data`，字段 `files`（可多个） | `{paths:[绝对路径...]}`；仅 png/jpg/jpeg/webp/gif，单张 ≤12MB |
| GET | `/api/overview` | — | 首页统计：账号、草稿、队列、今日发布、最近记录；另返回 `needs_action`（`pending_confirm` / `unread_notifications` / `abnormal_notes` / `expired_accounts`）与 `queue`（受阻原因聚合），供首页提醒条使用 |
| GET | `/api/platforms` | — | `PlatformAdapter.describe()` 列表：规格、可见范围、限额、能力、数据来源 |
| GET | `/api/published` | 见第 3 节 | 已发布内容，带 `total/limit/offset/meta` |
| POST | `/api/published/sync` | `{account_id?, account_ids?, pages?}` | 202 + 后台任务；`pages` 默认 2，上限 `OPS_SYNC_MAX_PAGES`（默认 20） |
| GET | `/api/published/accounts` | `platform?` | 每账号同步状态：`synced_at/sync_error/cached_count/ready` |

---

## 3. 已发布内容（重点契约）

### `GET /api/published`

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `account_id` | int | 0 | 0 表示全部账号 |
| `platform` | str | 空 | 空表示全部平台 |
| `since` | int | 0 | 起始时间（含） |
| `until` | int | 0 | 结束时间（含） |
| `since_days` | int | 0 | 便捷参数，>0 时覆盖 `since` 为「最近 N 天」 |
| `keyword` | str | 空 | 在标题 / 正文中做不区分大小写的包含匹配 |
| `health` | str | 空 | `attention`（零浏览/异常/下架）、`normal`、`unknown`、`zero_views`、`risky`、`removed` |
| `limit` | int | 20 | 1-100 |
| `offset` | int | 0 | 分页偏移 |
| `include_local` | 0/1 | 1 | 是否合并「真实发布成功但平台还没同步到」的本地记录 |

条目字段：

| 字段 | 类型 | 来源 | 说明 |
| --- | --- | --- | --- |
| `id` | int/null | 本地 | `published_notes` 主键；本地占位条目为 `null` |
| `platform` / `platform_name` | str | 本地 | 平台 key / 中文名 |
| `account_id` / `account_name` | int/str | 本地 | 发布账号 |
| `remote_note_id` | str | 平台 | 远端笔记 ID，去重键 |
| `title` | str | 平台（本地占位取草稿） | 标题 |
| `desc` | str | 平台（部分平台列表不返回正文） | 正文 |
| `cover` | str | 平台 / 本地 | 封面 URL；`cover_kind=local` 时是本地文件路径 |
| `cover_kind` | str | 本地 | `remote` / `local` |
| `note_type` | str | 平台 | `image` / `video` |
| `visibility` | str | 平台，缺失显示「平台未返回」 | 可见范围 |
| `views` | int/null | 平台 | 小红书为「小眼睛」阅读数；本地占位为 `null` |
| `likes` / `comments` / `collects` | int/null | 平台 | 互动数据；本地占位为 `null` |
| `published_at` | int | 平台 / 本地记录时间 | 发布时间 |
| `url` | str | 平台 | 原帖链接；小红书带 `xsec_token` |
| `source` | str | 本地 | `platform`（平台同步）/ `local_record`（本地占位） |
| `needs_sync` | bool | 本地 | `local_record` 为 `true`，同步后自动被平台条目替换 |
| `synced_at` | int | 本地 | 最近同步时间；本地占位为 0 |
| `metrics_synced_at` | int | 本地 | 最近写入指标快照时间 |
| `comment_synced_at` | int | 本地 | 最近同步评论时间 |
| `health_state` | str | 本地 | `unknown` / `normal` / `zero_views` / `risky` / `removed` |
| `health_note` | str | 本地 | 健康判断原因 |
| `comments_supported` | bool/null | 平台能力 | `true` 可直接同步；`false` 不支持；`null` 表示需要先探测权限（公众号精选留言） |
| `comments_mode` | str | 平台能力 | `read` / `probe` / `none` |
| `local_draft_id` / `local_draft_title` | int/str | 本地 | 关联草稿；无关联为 `null` / 空 |

`meta`：

```json
{
  "accounts": [
    {
      "account_id": 1,
      "account_name": "主号",
      "platform": "xiaohongshu",
      "platform_name": "小红书",
      "enabled": true,
      "ready": true,
      "synced_at": 1794660000,
      "sync_error": "",
      "cached_count": 4
    }
  ],
  "sources": {
    "from_platform": ["封面、标题、发布时间、笔记类型", "..."],
    "local_only": ["草稿关联（local_draft_id / local_draft_title）", "..."],
    "merge_rule": "同一账号的同一 remote_note_id 只出现一次；平台同步优先。",
    "sync": {
      "interval_hours": 6,
      "manual": "POST /api/published/sync",
      "failure": "同步失败写入账号的 sync_error，页面展示最近一次错误；已缓存内容不受影响。"
    },
    "platforms": {
      "xiaohongshu": {"name": "小红书", "ready": true, "data_sources": ["..."]}
    }
  },
  "sync_interval_hours": 6
}
```

新增字段（本轮修复后）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items[].metrics_available` | bool | 平台是否返回了至少一个互动指标；为 `false` 时 `views/likes/comments/collects` 均为 `null` |
| `meta.truncated` | bool | 结果是否被查询上限截断；为 `true` 时 `total` 不是全量精确值 |
| `meta.total_exact` | bool | `total` 是否精确（= `!meta.truncated`） |
| `meta.query_limit` | int | 平台缓存查询上限，默认 2000（`OPS_PUBLISHED_QUERY_LIMIT`） |
| `meta.truncated_sources` | list | 被截断的数据源：`platform` / `local_record` |
| `meta.notice` | str | 面向用户的截断提示；未截断时为空串 |

**指标空值语义**：平台没返回阅读/点赞/评论/收藏时，接口返回 `null`，不再返回 `0`。
页面应显示「--」或「平台未返回」，不要渲染成「0 阅读」。`source=local_record` 的占位条目
同样返回 `null`。

合并规则：

1. 平台同步数据优先；
2. 真实发布成功、但平台列表还没同步到的记录，以 `source=local_record` 占位；
3. 模拟发布（`OPS_DRY_RUN=1` 或 `result.simulated=true`）**不会**出现在已发布内容里；
4. 模拟记录仍保留在 `/api/records`，两者职责不同：
   - `/api/records` = 发布执行日志（成功/失败/重试/远端 ID）；
   - `/api/published` = 账号下「平台上真实存在的内容」。
5. 同一 `account_id + remote_note_id` 只出现一次。

错误码：`400` 平台非法 / 参数非数字；`404` 指定账号不存在；`500` 平台接口未预期异常（同步接口不会 500，失败写在返回结果与账号字段上）。

### `POST /api/published/sync`

```json
{ "account_ids": [1, 2], "pages": 2 }
```

- 不传账号：同步所有启用账号；
- 不传 `pages`：默认 2 页；单次最多 `OPS_SYNC_MAX_PAGES` 页（默认 20），每页 30 条；
- 返回 202 + 任务对象 `{id, kind:"published", status:"running", ...}`，用 `GET /api/tasks/{id}` 轮询；
- 任务 `result` 是每个账号的同步结果数组：
  `{ok, account_id, fetched, saved, pages, truncated, next_cursor, message}`；
  某个账号失败不会让整个任务变成 failed，前端需按 `ok` 展示；
- **截断提示**：`truncated=true` 表示本次已到页数上限、平台还有更多内容，`message` 会明确写出；
  调大请求里的 `pages` 或环境变量 `OPS_SYNC_MAX_PAGES` 后再次同步即可继续；
- 同一账号已有同步在跑时，该账号返回 `{ok:false, message:"该账号正在同步，请稍后再试"}`，不会重复请求平台；
- 账号正在真实发布时跳过本次同步，返回 `{ok:false, skipped:true, message:"账号正在发布，稍后自动重试同步"}`，
  不会占用发布锁，也不会并发打平台接口；
- 未接入平台返回 `{ok:false, message:"...内容回收接入位尚未实现"}`。

### `POST /api/published/health-check`

```json
{ "account_id": 0 }
```

按规则检查已同步作品：发布超 24 小时仍 0 浏览 → `zero_views`；平台返回违规/审核不通过 → `risky`；平台返回删除/下架 → `removed`；累计浏览明显回落 → `risky`。异常会写一条站内通知（30 分钟内去重）。返回 `{checked, counts:{state: n}, message}`。

### `GET /api/published/{id}/metrics`

参数 `days`（默认 30，1-90）。返回按日序列，平台缺数据的日期为 `null`（断点，不补 0）：

```json
{
  "note": {"id": 12, "title": "…", "platform": "xiaohongshu"},
  "days": 7,
  "series": [{"day": "2026-11-11", "views": 100, "likes": 3, "comments": 0, "collects": 1}],
  "missing_days": 1,
  "current": {"views": 120, "likes": 4, "comments": 0, "collects": 2, "captured_at": 1794660000},
  "hint": "平台未返回的日期显示为断点，不按 0 处理。"
}
```

### `GET /api/published/{id}/comments`

参数 `limit`（默认 20）、`offset`。返回 `{items, total, supported, comments_mode, only_featured, notice, empty_text, synced_at}`。评论为**严格只读缓存**；公众号只包含精选留言，`supported=null` 表示尚未探测留言权限。

### `POST /api/published/{id}/comments/sync`

请求 `{ "pages": 3 }`（1-10）。平台不支持时返回 400 并说明；小红书按页读取一级评论与二级回复；公众号首次同步即做权限探测，只能读取精选留言，无权限时返回明确的 400 原因，不伪装成「没有评论」。

### 同步频率与失败提示

- 自动：`PublishedSyncThread` 启动后立即检查一次，之后每 30 分钟检查；账号距上次同步超过 6 小时才拉取，每次只同步一个到期账号。
- 手动：`POST /api/published/sync` 随时可触发。
- 失败：写入 `accounts.published_sync_error`，`GET /api/published/accounts` 与列表 `meta.accounts[].sync_error` 都能看到；已缓存内容不删除。

---

## 4. 账号

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/accounts` | `platform?, group?` | 账号列表，响应额外带全局 `total`；条目含 `platform/platform_name/published_today/health_state/cooldown_until/probe_success_count/probe_target/group_name/tags/profile_key/exit_ip` |
| POST | `/api/accounts` | `{name, cookie, proxy?, platform?}` | 校验 Cookie 后加密入库；未接入平台返回 400 |
| POST | `/api/accounts/import-env` | — | 从 `.env` 的 `COOKIES` 导入 |
| POST | `/api/accounts/qr` | `{platform?, proxy?}` | 扫码登录会话，返回 `session_id/qr/platform`；`platform` 支持 `xiaohongshu`（默认）、`wechat_mp`、`douyin` |
| GET | `/api/accounts/qr/{sid}` | — | 轮询扫码状态；不回传 Cookie/token。公众号/抖音额外返回 `requires_window/window_open/notice/mode/headless/browser`（浏览器进程命令行与可见窗口数，用于核对是否真的无头） |
| POST | `/api/accounts/qr/{sid}/save` | `{name?}` | 扫码确认后落库；公众号/抖音保存加密会话 JSON |
| POST | `/api/accounts/qr/{sid}/window` | — | 用户明确点击「打开验证窗口」后调用；仅 `needs_action` 状态可用，用当前登录态启动可见浏览器 |
| PATCH | `/api/accounts/{id}` | `{name?, enabled?, daily_limit?, min_interval_sec?, proxy?, proxy_group?, group_name?, tags?, status?}` | 更新账号 |
| DELETE | `/api/accounts/{id}` | — | 删除账号，同时清 `published_notes` / `published_metrics_daily` / `note_comments` / `risk_events` / `rate_events`，草稿与任务解绑 |
| POST | `/api/accounts/{id}/check` | — | 登录态巡检，结果写回账号；冷却结束后需连续探测成功 `probe_target` 次才恢复发布（每次间隔约 5 分钟） |
| GET | `/api/accounts/groups` | — | 已有分组名列表 |
| GET | `/api/accounts/{id}/diagnose` | — | 一屏诊断：`account`、`publish`（可否发布/原因/额度/下次可用）、`environment`（Profile/代理/出口/读写通道）、`sync`、`checklist`、`jobs`、`recent_records`（含 `evidence`）、`risk_events` |
| POST | `/api/accounts/{id}/proxy-test` | — | 测试该账号代理出口；出口变化会写 `risk_events(exit_changed)` 并通知 |
| POST | `/api/accounts/{id}/cooldown/clear` | — | 人工解除风控冷却：直接恢复 `healthy`，写 `manual_release` 审计 |
| POST | `/api/accounts/batch` | `{action, ids, group_name?, tags?}` | `action`：`enable` / `disable` / `check` / `group` / `tag` / `clear_cooldown` |

错误：`400` Cookie 为空 / 平台未接入 / 批量参数不合法；`404` 账号不存在。

---

## 5. 选题

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/topics` | `status? q? source? category? min_score? sort? limit? offset?` | 列表 + 总数；`sort` 只接受白名单 |
| GET | `/api/topics/dedupes` | `limit?` | 去重记录 |
| POST | `/api/topics/mine` | `{mode, keywords?, user_urls?, account_id?, per_kw?, limit?, sort_type_choice?, detail_limit?, product?}` | 关键词 / 竞品 / 热榜挖掘 |
| POST | `/api/topics` | `{title, angle?, keyword?, category?, tone?, product?}` | 手动加题 |
| POST | `/api/topics/import` | `{text}` | 文本批量导入 |
| POST | `/api/topics/import-library` | `{path?}` | 导入历史题库 JSON |
| PATCH | `/api/topics/{id}` | 任意可更新字段 | 更新选题 |
| DELETE | `/api/topics/{id}` | — | 删除 |
| POST | `/api/topics/batch-delete` | `{topic_ids:[...]}` | 批量删除 |

---

## 6. 文案与草稿

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/copy/generate` | `{brief, topic?, tone?, tags?, product?, use_llm?, platform?}` | 生成文案，不落库；模型失败会返回离线模板，并带 `llm_error/retryable` |
| POST | `/api/copy/check` | `{title, desc, topics?, platform?}` | 合规检查；按平台返回 `title_max/desc_max` |
| POST | `/api/copy/rewrite` | `{text, title?, angle?, tone?, with_cards?, use_llm?, platform?}` | 洗稿 |
| GET | `/api/drafts` | `status? platform? limit? offset?` | 草稿列表 + 总数 |
| POST | `/api/drafts/manual` | 见下 | 保存创作页内容 |
| POST | `/api/drafts` | `{topic_ids, tone?, variants?, with_cards?, platform?, content_type?, account_id?, use_llm?, product?}` | 202 + 任务；批量由选题生成 |
| GET | `/api/tasks/{task_id}` | — | 任务状态：`running/success/failed`、`deadline_at` 与结果；超过截止时间会变 `failed` |
| POST | `/api/drafts/{id}/rewrite` | `{angle?, tone?, with_cards?, use_llm?, platform?}` | 草稿洗稿；`platform` 缺省沿用原草稿平台 |
| POST | `/api/drafts/{id}/convert` | `{target_platform, tone?, use_llm?}` | 平台互转：公众号长文 ↔ 小红书笔记，新建草稿，原草稿不变 |
| POST | `/api/drafts/{id}/switch-platform` | `{platform}` | 在原草稿上切换平台，不新建草稿，图片全部保留 |
| POST | `/api/drafts/{id}/motion` | `{...}` | 生成 6 秒循环动图；产物不混进发布图列表 |
| POST | `/api/drafts/{id}/artwork-inline` | `{...}` | 给公众号正文生成一张横向插画，不改封面，直接返回可插入的图片路径 |
| POST | `/api/design/plan` | 同渲染参数 | 预排：返回这套内容会排成几页、平台允许多少张，供前端显示「共 N 页」 |
| POST | `/api/richtext/render` | `{text, format: "markdown"\|"html", images?: [...]}` | Markdown/HTML 转可插入预览的富文本，返回 `{html, text}` |
| GET | `/api/richtext/themes` | — | 公众号排版主题清单，前端按 `group` 分组展示 |
| POST | `/api/richtext/style` | `{html, theme}` | 一键排版：把公众号正文内联样式整体换成指定主题 |
| GET | `/api/drafts/{id}` | — | 草稿详情（含 `spec/spec_problems/can_publish/jobs`） |
| PATCH | `/api/drafts/{id}` | `{title?, desc?, topics?, images?, visibility?, account_id?, status?, body_md?, body_html?}` | 更新；平台与内容类型不可改 |
| DELETE | `/api/drafts/{id}` | — | 删除草稿并级联清理图片、发布记录、队列任务 |
| POST | `/api/drafts/batch-delete` | `{draft_ids:[...]}` | 批量删除 |

`platform` 取值与账号表一致：`xiaohongshu` / `wechat_mp` / `douyin`，缺省为 `xiaohongshu`（向后兼容）。
未知平台返回 `400`。同一份输入在不同平台会产出明显不同的结构与篇幅：

| 平台 | 标题上限 | 正文目标 | 结构 | 话题写法 |
| --- | --- | --- | --- | --- |
| `xiaohongshu` | 20 | 250-450 字 | emoji 分节、短句换行、口语开场、结尾互动 | `#话题`，最多 6 个 |
| `wechat_mp` | 64 | 900-1500 字 | 导语 + `## 一、二、三` 小标题 + 段落推进 + 收束；正文存 Markdown 与 HTML，可在预览里直接编辑并插入图片/视频占位 | `#话题#`，最多 3 个 |
| `douyin` | 55 | 120-240 字 | `【前3秒】`钩子 + `【画面】` + `【口播】` + `【结尾】` | `#话题`，最多 4 个 |

超长内容按句子 → 分句 → 空格的顺序压缩，不会硬切半个词；离线兜底模板三平台各自一套。

`POST /api/copy/generate` 与洗稿接口的响应额外字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `engine` | `llm` / `offline` | 实际使用的生成引擎 |
| `llm_error` | str | 模型失败时的明确提示；成功或未配置时为空串 |
| `retryable` | bool | 是否建议保留输入后重试（模型超时/连接失败时为 `true`） |
| `platform` | str | 本次生成使用的平台标识，便于前端核对 |
| `platform_name` | str | 平台中文名 |
| `title_max` | int | 该平台标题上限 |
| `body_target` | `[int, int]` | 该平台正文目标字数区间 |

超时约定：模型单次请求硬超时默认 45 秒、一次生成总预算 60 秒；接口层兜底默认 75 秒，
超时返回 `504 {"ok":false,"error":"处理超时，请稍后重试；已保留当前输入"}`。
模型失败但离线模板可用时优先返回离线文案，而不是让页面一直转圈。

`POST /api/drafts/manual` 请求：

```json
{
  "title": "标题",
  "desc": "正文",
  "topics": ["话题"],
  "images": ["绝对路径或 /uploads/xxx.png"],
  "visibility": 0,
  "media_type": "image",
  "account_id": null,
  "topic_id": null,
  "platform": "xiaohongshu",
  "content_type": "image_text",
  "body_md": "## 一、小标题\n\n正文",
  "body_html": "<h2>一、小标题</h2><p>正文</p>",
  "enqueue": false,
  "account_ids": [],
  "scheduled_at": 0
}
```

`body_md` / `body_html` 仅公众号使用：服务端会清洗 HTML，发布时把正文里的本地图片上传到微信素材库并替换成 CDN 地址；其它平台会忽略这两个字段。

---

## 7. 配图

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/cards/styles` | — | 12 种 baoyu 预设风格；缺失目录时回退内置清单，不会为空 |
| GET | `/api/cards/options` | — | `styles/layouts/palettes/presets/backend/paid`；`backend.skill_ready`、`paid.available` 用于诊断 |
| POST | `/api/drafts/{id}/cards` | `{style?, layout?, palette?}` | 免费模板（baoyu 预设）生成，写回草稿 |
| POST | `/api/drafts/{id}/paid-cards` | `{style?, layout?, palette?}` | 付费出图，必须配置密钥；返回 `cost` |
| GET | `/api/design/styles` | — | 8 套独立设计风格；每项带 `wide: true` 与宽幅 `canvas` |
| POST | `/api/drafts/{id}/design-cards` | `{style?, variant?, limit?, platform?}` | 本地设计卡片，写回草稿 |

`design-cards` 的画布由平台决定：`wechat_mp` 输出 **1080×460（2.35:1）** 原生宽幅封面，只出封面 1 张；`xiaohongshu` / `douyin` 保持 1080×1440（3:4）。`platform` 缺省取草稿自身平台，未知平台返回 `400`。响应除草稿外附带：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `style` | str | 实际使用的模板 key |
| `template` | `{key, name}` | 模板 key 与中文名，便于前端核对 |
| `canvas` | `{key, width, height, aspect, label}` | `wide`/`portrait` 与实际出图像素，例如 `{key:"wide", width:1080, height:460, aspect:"2.35:1"}` |
| `platform` | str | 本次出图使用的平台标识 |

出图前会按该画布尺寸做文字块碰撞与越界检查，不通过直接报错，不产生半成品图片。

---

## 8. 发布队列与记录

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/jobs` | `limit?, offset?, status?, reason?` | 队列列表 + 总数；`status=waiting` 只看 pending/retry，`reason` 按当前等待原因精确筛选 |
| POST | `/api/jobs` | `{draft_ids:[...], account_id?, account_ids?, scheduled_at?}` | 入队；校验平台就绪、账号同平台、幂等 |
| POST | `/api/jobs/{id}/retry` | — | 手动重试；`pending_confirm` 会被拒绝，必须先人工确认 |
| POST | `/api/jobs/{id}/cancel` | — | 取消；`pending_confirm` 不允许直接取消 |
| POST | `/api/jobs/{id}/confirm` | `{published: true\|false}` | 人工确认「结果待确认」：已发布记 success 并刷新账号；未发布记 failed，可再重试 |
| GET | `/api/queue/reasons` | — | 队列受阻原因聚合：`groups[{reason,count,next_at}]`、`waiting`、`pending_confirm` |
| GET | `/api/records` | `limit?, offset?` | 发布执行记录（含失败、模拟）；响应带 `total`、全局 `success_total` / `failed_total`、`limit`、`offset` |
| GET | `/evidence/{filename}` | — | 发布失败现场：`evidence` 目录下的截图（png/jpg）与 DOM 快照（html 以附件下载）；文件名与后缀白名单校验 |

`POST /api/jobs` 的 400 场景：草稿已发布、草稿平台未接入、账号与草稿平台不一致、草稿已在队列中。

**发布结果三态**：平台明确返回成功 → `success`；明确失败 → `failed`/`retry`；执行过程中断、超时或最后一次尝试仍是网络类失败 → `pending_confirm`（请求可能已经送达平台）。系统不会自动重试待确认任务，避免重复发布；页面需要展示确认按钮与核对截止时间。

**提交标记与中断回收**：真正调用平台前会先写 `jobs.submitted_at`。服务启动时扫描遗留的 `running` 任务：`submitted_at > 0` → `pending_confirm`（24 小时核对期）；`submitted_at = 0` → 回到 `pending` 并标记「服务重启，等待重试」。抖音发布失败时会把截图与 DOM 快照写入 `result.evidence`，诊断抽屉可通过 `/evidence/{filename}` 查看现场。

平台动作差异：

- 小红书/抖音：`visibility` 就是作品可见范围（抖音 `0` 公开、`1` 仅自己、`2` 好友）。
- 微信公众号：只保存草稿（`visibility=1` 或不传 `action`）；`action=mass_send` 会被拒绝并提示到后台人工发表。草稿成功不代表已发表。

---

## 9. 定时任务

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/schedules` | `limit?, offset?` | 列表；响应带 `total`、`limit`、`offset`，用于真分页 |
| POST | `/api/schedules` | `{name, kind, platform?, trigger_type?, time_of_day?, weekdays?, interval_minutes?, config?}` | 新建 |
| POST | `/api/schedules/quick` | `{what, when, platform?, name?, tone?, card_style?}` | 引导式新建；未接入平台只能建「找选题」 |
| PATCH | `/api/schedules/{id}` | 任意可更新字段 | 编辑 / 启停 |
| DELETE | `/api/schedules/{id}` | — | 删除并清运行记录 |
| POST | `/api/schedules/{id}/run` | — | 立即执行一次 |
| GET | `/api/schedule-runs` | `schedule_id?, limit?, offset?` | 运行记录 |
| POST | `/api/schedule-runs/{id}/rerun` | `{stage}` | 重跑指定环节（mine/draft/publish） |
| POST | `/api/schedule-runs/{id}/confirm` | — | 确认待确认的发布 |

---

## 10. 设置与后台

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/settings` | — | 公开设置（不返回任何 Key） |
| PATCH | `/api/settings` | 键值对 | 更新设置 |
| GET | `/api/worker` | — | 线程状态：发布 / 调度 / 回收 |
| POST | `/api/worker/tick` | — | 立即跑一次发布队列 tick |

### 10.1 账号与额度（EchoQ-Cloud）

账号、订阅与两把中转 Key 都由云端管理；本地接口只返回状态与掩码，不回传 token 或完整 Key。

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/cloud/status` | — | 登录状态、套餐、剩余额度、两把 Key 的掩码与是否就绪 |
| POST | `/api/cloud/sms/send` | `{phone}` | 发送手机验证码；开发环境会返回 `dev_code` |
| POST | `/api/cloud/login` | `{phone,code}` 或 `{email,password}` | 登录 / 手机号自动注册；返回 `{status,is_new,issued}` |
| POST | `/api/cloud/logout` | — | 退出并清理本地票据 |
| POST | `/api/cloud/refresh` | — | 拉取云端 `/api/me` 更新套餐与额度；票据失效时返回 401 |
| POST | `/api/cloud/keys/reset` | `{kind:"llm"\|"image"}` | 按类型重置 Key；新 Key 只保存在本机后台 |
| GET | `/api/cloud/doctor` | 可选 `?model=` | 云端体检：可达性、登录态、文案 Key、模型白名单、订阅额度逐项返回 `{ok, logged_in, items:[{key,name,ok,detail}]}` |
| GET | `/api/update` | 可选 `?current=1.0.0` | 客户端版本检查；转发云端 `/api/app/version`（`product=ops`），返回 `{checked,current,update_available,mandatory,latest:{version,notes,published_at,min_supported,download}}`；连不上云端时 `checked=false`，前端静默跳过 |

- 未登录时 `POST /api/copy/generate`、洗稿、批量草稿等入口返回 401「请先登录 EchoQ 账号后再使用 AI 生成」。
- 订阅到期或额度用完返回 402，页面据提示引导续费；付费配图同理由 `paid.configured` 与 `reason` 体现。

### 10.2 通知中心

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/notifications` | `limit?, offset?, unread=0/1` | 站内消息 + `total` / `unread` |
| POST | `/api/notifications/read` | `{ids?: [int]}` | 传 `ids` 标记指定消息；不传 `ids` 全部已读 |
| GET | `/api/notifications/channels` | — | 推送渠道列表 |
| POST | `/api/notifications/channels` | `{channel, name?, target, events?}` | `channel`：`webhook` / `dingtalk` / `bark`；`events` 为数组或逗号分隔，`all` 表示全部 |
| PATCH | `/api/notifications/channels/{id}` | `{name?, target?, events?, enabled?}` | 更新渠道 |
| DELETE | `/api/notifications/channels/{id}` | — | 删除渠道 |
| POST | `/api/notifications/channels/{id}/test` | — | 发一条测试消息，返回 `{ok, message}` |

事件：`publish_failed`、`publish_pending`、`account_expired`、`note_abnormal`、`sync_failed`、`risk_cooldown`、`backup_done`。同一事件 + 对象 30 分钟内只提醒一次；站外推送失败只写 `last_status`，不影响业务。

### 10.3 代理池

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/proxies` | — | 代理条目 + 最近测试结果 |
| POST | `/api/proxies` | `{name?, url}` | 新增；支持 http / https / socks5 |
| PATCH | `/api/proxies/{id}` | `{name?, url?, enabled?}` | 更新 |
| DELETE | `/api/proxies/{id}` | — | 删除，并解绑使用该 URL 的账号 |
| POST | `/api/proxies/{id}/test` | — | 通过代理查询出口，返回 `{exit_ip, country, timezone, latency_ms}` |
| POST | `/api/proxies/test` | `{url}` | 不落库的临时测试 |

测试失败返回 400 与明确原因；不会静默回退直连。

### 10.4 备份与恢复

| 方法 | 路径 | 请求 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/backups` | — | 备份列表（名称、大小、时间、是否恢复前自动备份） |
| POST | `/api/backups` | `{include_images?, include_key?}` | 创建加密备份 `.eqbak`，默认不含图片与密钥 |
| GET | `/api/backups/download?name=` | — | 下载备份 |
| POST | `/api/backups/restore` | `{name}` | 恢复；先自动生成 `prerestore-*.eqbak`，再覆盖数据库与可选图片 |
| DELETE | `/api/backups/{name}` | — | 删除备份 |

备份文件是 Fernet 加密后的 zip，内含 `ops.db`、可选 `assets/`、`uploads/`（**仅图片**，总量上限约 1.5GB，视频不进入备份）、`secret.key` 与 `manifest.json`。恢复在站内完成，但建议恢复后重启服务以清理旧数据库连接。

---

## 11. 前端接口契约（给另一个窗口）

已发布内容页只需要两个接口：

1. `GET /api/published`：列表、筛选、分页、`meta.accounts`（同步状态）与 `meta.sources`（数据来源说明）。
2. `POST /api/published/sync` → 用返回的 `data.id` 轮询 `GET /api/tasks/{id}`，完成后刷新列表；`result` 是数组，按每项 `ok` 展示成功或失败。

展示建议：

- `source=local_record` 的条目显示「待同步」标记与 `needs_sync=true`，互动数据为 `null` 时显示「—」；
- `visibility` 为空或「平台未返回」时原样展示，不要猜测；
- `cover_kind=local` 时封面用本地路径（页面走 `/assets/...` 或 `/uploads/...`），`remote` 时直接用 URL；
- `meta.sources.sync.failure` 与 `meta.accounts[].sync_error` 用于失败提示；
- 与「发布记录」页面分开：发布记录看执行结果，已发布内容看平台上的真实内容；两者用 `remote_note_id` 与 `local_draft_id` 关联。
