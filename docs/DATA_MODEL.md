# 数据模型

数据库：SQLite（WAL），默认位置 `%LOCALAPPDATA%\EchoQ-Ops\data\ops.db`。每个线程一个连接，`busy_timeout=10s`，外键开启。建表与迁移在 `ops/db.py::init_db` 的单个事务内完成，失败整体回滚。

## 1. 关系

```
accounts 1 ──< drafts (account_id 可空)
accounts 1 ──< jobs (account_id 可空)
accounts 1 ──< records
accounts 1 ──< published_notes
accounts 1 ──< rate_events
accounts 1 ──< risk_events
accounts 1 ──< note_comments
published_notes 1 ──< published_metrics_daily (应用层级联删除)
published_notes 1 ──< note_comments (按 platform + remote_note_id 关联)
topics   1 ──< drafts (topic_id, ON DELETE SET NULL)
drafts   1 ──< jobs (ON DELETE CASCADE)
drafts   1 ──< records
jobs     1 ──< records
schedules 1 ──< schedule_runs (应用层级联删除)
notification_events（站内消息）与 notifications（推送渠道）彼此独立
proxies  1 ──< accounts（按 URL 绑定，不做外键）
```

平台不是独立表，而是 `platform` 枚举字段；可用平台以 `ops/platforms/` 注册表为准。

## 2. 表结构

### accounts

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | int PK | 账号 ID |
| platform | text | `xiaohongshu` / `wechat_mp` / `douyin`，默认 `xiaohongshu` |
| name / nickname / red_id / user_id | text | 名称与平台身份 |
| cookie_enc | text | Fernet 加密后的完整 Cookie，接口不回传 |
| proxy | text | 账号级代理 |
| proxy_group | text | 代理分组备注（简化代理池） |
| profile_key | text | 独立 Profile 目录名，默认 `profile-<id>` |
| exit_ip / exit_country / exit_timezone | text | 最近一次代理测试拿到的出口 |
| exit_checked_at | int | 出口测试时间 |
| health_state | text | `unknown` / `healthy` / `expired` / `risk` / `probing` |
| cooldown_until | int | 风控冷却截止时间戳，0 表示未冷却 |
| probe_success_count | int | 冷却结束后连续探测成功次数；达到 `PROBE_SUCCESS_TARGET`（2）才恢复发布 |
| group_name | text | 账号分组 |
| tags | text | 标签数组（JSON） |
| enabled | int | 1 启用 |
| status | text | `healthy` / `expired` / `unknown` / `disabled` |
| last_error | text | 最近一次巡检错误 |
| health_checked_at | int | 最近巡检时间 |
| published_synced_at | int | 已发布内容最近同步时间 |
| published_sync_error | text | 最近一次同步失败原因 |
| last_publish_at | int | 最近发布成功时间 |
| daily_limit / min_interval_sec | int | 账号级覆盖；0 表示用平台/全局默认 |
| created_at / updated_at | int | 时间戳 |

### topics

| 字段 | 说明 |
| --- | --- |
| id, source, source_ref | 来源与来源引用 |
| keyword, category, title, angle, tone | 选题内容 |
| product | 是否产品向 |
| score, score_detail | 综合分与分项（JSON） |
| status | `pool` / `used` / `dropped` 等 |
| raw | 原始数据（JSON） |
| created_at, updated_at | 时间戳 |

索引：`idx_topics_score(score DESC)`。

### topic_dedupes

去重记录：`title`、`source`、`kept_topic_id`、`kept_title`、`similarity`、`created_at`。

### drafts

| 字段 | 说明 |
| --- | --- |
| id, topic_id, account_id | 关联选题 / 默认账号 |
| platform | 草稿所属平台 |
| content_type | `image_text` / `video` / `long_article` |
| title, desc, topics, images | 内容与素材（`topics/images` 为 JSON 数组） |
| media_type | `image` / `video` |
| visibility | 0 公开 / 1 仅自己可见（具体选项由平台声明） |
| status | `draft` / `queued` / `published` / `failed` |
| compliance | 合规问题（JSON） |
| source_note | 洗稿来源 |
| created_at, updated_at | 时间戳 |

外键：`topic_id → topics.id ON DELETE SET NULL`。

### jobs

| 字段 | 说明 |
| --- | --- |
| id, draft_id, account_id | 草稿 + 账号 |
| platform | 入队时快照 |
| status | `pending` / `running` / `retry` / `pending_confirm` / `success` / `failed` / `cancelled` |
| attempts / max_attempts | 重试计数 |
| next_run_at / scheduled_at | 下次执行 / 用户定时 |
| blocked_reason / blocked_at | 当前等待原因快照与时间，用于队列解释 |
| result_state | `normal` / `pending_confirm` |
| confirm_deadline | 待确认的核对截止时间（提示用，不自动失败） |
| submitted_at | 已提交到平台的时间；0 表示尚未提交。启动回收据此区分「结果未知」与「可安全重试」 |
| last_error | 最近错误 |
| created_at, updated_at | 时间戳 |

唯一性：`UNIQUE(draft_id, account_id)` + `idx_jobs_draft_account(draft_id, IFNULL(account_id,-1))`，解决 SQLite 对 NULL 不生效的问题；一稿多号时每账号一条。

### records

发布执行日志，只追加不修改：

| 字段 | 说明 |
| --- | --- |
| id, job_id, draft_id, account_id | 关联 |
| platform | 平台快照 |
| success | 0/1 |
| message | 结果或错误（≤500 字） |
| remote_note_id | 成功时的远端 ID；模拟发布为随机 24 位 |
| result | 平台原始结果（JSON，≤4000 字）；失败时可能含 `evidence{screenshot,dom,captured_at}` |
| created_at | 时间戳 |

模拟发布可用 `message LIKE '模拟发布%'` 或 `result.simulated=true` 识别，已发布内容接口会排除。

### published_notes

平台作品列表的本地缓存（新）：

| 字段 | 说明 |
| --- | --- |
| id | 本地 PK |
| platform, account_id | 归属 |
| remote_note_id | 远端 ID |
| title, desc, cover | 内容与封面（封面可能是 URL） |
| note_type | `image` / `video` |
| visibility | 平台可见范围文本，可能为空 |
| views / likes / comments / collects | 阅读（小眼睛）/ 点赞 / 评论 / 收藏，缺失为 0 且接口以 `null` 暴露给本地占位 |
| published_at | 平台发布时间 |
| url | 原帖链接 |
| raw | 平台原始对象（≤8000 字） |
| synced_at | 最近同步时间 |
| metrics_synced_at | 最近一次指标写入时间 |
| comment_synced_at | 最近一次评论同步时间 |
| health_state | `unknown` / `normal` / `zero_views` / `risky` / `removed` |
| health_note | 健康判断原因（≤300 字） |
| health_checked_at | 最近健康检查时间 |
| created_at / updated_at | 时间戳 |

唯一性：`UNIQUE(account_id, remote_note_id)`；索引：`(account_id, published_at DESC)`、`(platform, published_at DESC)`。

### published_metrics_daily

按日指标快照，用于趋势图。平台当天缺数据时**不写 0**，查询时返回 `null` 断点。

| 字段 | 说明 |
| --- | --- |
| id | PK |
| note_id | `published_notes.id` |
| day | `YYYY-MM-DD` 本地日期 |
| views / likes / comments / collects | 当日快照；单列可空 |
| captured_at | 写入时间 |

唯一性：`UNIQUE(note_id, day)`；索引：`(note_id, day)`。

### note_comments

评论只读缓存。只读指：不回复、不点赞、不删除，仅落库供查看。

| 字段 | 说明 |
| --- | --- |
| id | PK |
| platform | 平台枚举 |
| account_id | 所属账号 |
| remote_note_id / remote_comment_id | 远端作品与评论 ID |
| author / author_id | 评论者展示名与平台 ID |
| content | 评论正文（≤2000 字） |
| likes | 点赞数，可空 |
| is_reply / parent_comment_id | 是否二级回复与父评论 |
| commented_at | 评论时间（平台缺失为 0） |
| synced_at | 本地同步时间 |

唯一性：`UNIQUE(platform, remote_note_id, remote_comment_id)`；索引：`(platform, remote_note_id, commented_at DESC)`。

### notifications / notification_events

- `notifications`：站外推送渠道，字段 `channel`（`webhook` / `dingtalk` / `bark`）、`name`、`target`、`events`（JSON 数组，`all` 表示全部）、`enabled`、`last_sent_at`、`last_status`。
- `notification_events`：站内消息，字段 `level`、`event`、`title`、`message`、`link_view` / `link_id`（点击跳转）、`read`、`created_at`。同一事件 + 对象 30 分钟内去重。

### risk_events

账号风控与出口变化时间线：`account_id`、`type`（`rate_limited` / `exit_changed` / `manual_release`）、`reason`、`source`、`started_at`、`ended_at`（0 表示进行中）。登录探测通过或人工解除时回填 `ended_at`。

### proxies

简化代理池：`name`、`url`、`enabled`、`country`、`timezone`、`exit_ip`、`last_check_at`、`last_status`、`last_latency_ms`、`created_at`、`updated_at`。账号通过 `accounts.proxy` 保存同一条 URL，删除代理会同步解绑账号。

### rate_events

限速事件：`account_id`、`action`（`publish` / `sync` / `health_check`）、`created_at`。三者共享账号级写间隔（`write_gap_sec`）。账号删除时清理。

### schedules

| 字段 | 说明 |
| --- | --- |
| id, name | 任务名 |
| platform | 目标平台 |
| kind | `publish` / `mine` / `draft` / `chain` |
| enabled, auto | 启用 / 自动创建 |
| trigger_type | `time_point` / `interval` / `weekly` 等 |
| time_of_day, weekdays, interval_minutes | 触发配置 |
| config | 任务参数（JSON） |
| next_run_at, last_run_at, last_status, last_message | 运行状态 |
| running, failures, paused_reason | 并发与熔断 |
| created_at, updated_at | 时间戳 |

### schedule_runs

每次执行一条：`schedule_id`、`schedule_name`、`kind`、`trigger`、`status`、`started_at`、`finished_at`、`message`、`error`、`output`（各环节产物 JSON）。

### settings

`key TEXT PRIMARY KEY, value TEXT`。默认值在 `ops/config.py::DEFAULT_SETTINGS`，表里的值优先。

## 3. 平台字段迁移

`init_db` 的顺序：

1. 按 `SCHEMA` 建表（新表直接带全部列）；
2. `_migrate_jobs_multi_account`：把旧版 jobs 的单列唯一约束升级为「草稿 + 账号」；
3. `_migrate_published_metrics`：把旧版 `published_notes` 的指标列改成可空（重建表）；
4. `_migrate_columns`：给旧库补平台字段、发布三态（含 `submitted_at`）、账号环境与 `probe_success_count`、作品健康与评论时间等新列；并给旧账号回填 `profile_key`；
5. 按 `media_type='video'` 回填旧草稿的 `content_type='video'`；
6. 清理旧 jobs 重复行，建唯一索引；
7. 建各表 `platform` 索引。

注意第 3 步必须早于第 4 步：重建 `published_notes` 会丢掉刚补的新列。

现有数据全部默认归到 `xiaohongshu`，不需要人工迁移。迁移在单事务内，失败整体回滚。

## 4. 一致性与清理规则

| 操作 | 清理范围 |
| --- | --- |
| 删除草稿 | `designs/` 与 `assets/` 图片、`records`、`jobs`（级联） |
| 删除账号 | `published_notes`、`published_metrics_daily`、`note_comments`、`risk_events`、`rate_events`；草稿与任务 `account_id` 置空；`records` 保留审计 |
| 删除代理 | 绑定该 URL 的账号解绑为直连（`proxy`、`proxy_group` 置空） |
| 恢复备份 | 先自动生成 `prerestore-*.eqbak`；数据库在线覆盖，图片按备份内容覆盖；不清理本地多余文件 |
| 删除定时任务 | 对应 `schedule_runs` |
| 删除选题 | 草稿 `topic_id` 置空（外键） |
| 已发布同步 | 以 `(account_id, remote_note_id)` upsert，不产生重复 |

## 5. 已知边界

- `published_notes` 单次查询上限默认 2000 条（`OPS_PUBLISHED_QUERY_LIMIT`）、本地占位记录上限 500 条；超过后接口返回 `meta.truncated=true` 与提示，`total` 不是全库精确值。
- `published_notes.views/likes/comments/collects` 可空：平台未返回时存 `NULL`，接口原样返回 `null`。旧库升级时只改列可空性，旧记录需重新同步一次才会获得空值语义。
- 单次同步默认翻 2 页，最多 `OPS_SYNC_MAX_PAGES`（默认 20）页；平台还有更多内容时同步结果 `truncated=true`。
- `records` 只保留执行日志，不随账号删除而删除；如需清理请手动归档。
- `raw` 字段为排查保留，体积较大；当前未做定期压缩。
- `published_metrics_daily` 每天最多一条；同一天多次同步会覆盖为最新值。缺失日期不补 0，趋势图显示断点。
- 评论缓存只包含平台已公开返回的评论；公众号只有文章页精选留言（`comments_mode=probe`，首次同步探测权限），自动同步只跑 `read` 模式的平台。
- 发布失败现场保存到 `datas/ops/evidence/`（截图 + DOM），只保留最近 200 个文件。
- 备份文件为 Fernet 加密的 zip，默认不含图片与密钥；图片备份只收 png/jpg/jpeg/webp/gif，总量上限约 1.5GB，视频不进备份。恢复后建议重启服务以清理旧数据库连接。
- 风控冷却为阶梯式（15 分钟 / 1 小时 / 3 小时，24 小时内按次数升级），上限 3 小时；冷却结束后需连续探测成功 2 次（间隔约 5 分钟）才恢复发布。人工解除冷却直接恢复 `healthy`，并记一条 `manual_release` 审计。
