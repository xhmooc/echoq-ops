# 多平台接入说明

产品定位是「全平台运营」：账号、草稿、发布队列、计划任务、发布记录都按平台区分。小红书、微信公众号、抖音三个适配器均已接入扫码登录与发布；公众号只写草稿箱。

## 1. 结构

```
desktop/src/
├── core/platform.ts          # 平台注册表：规格、可见范围、限额、能力、数据来源
├── core/accounts.ts          # 账号 CRUD、登录态、限额、冷却
├── platforms/xiaohongshu/    # 扫码、签名、发布、已发布回读
├── platforms/wechat/         # 扫码、token、素材上传、草稿、已发表列表
├── platforms/douyin/         # 扫码、隐藏窗口发布、作品回读
├── services/worker.ts        # 发布队列与失败分类
├── services/schedulerEngine.ts # 定时任务（找选题 / 写稿 / 发布）
└── services/published.ts     # 已发布内容缓存与查询
```

业务骨架只依赖注册表与统一接口，不直接 import 具体平台实现：

| 能力 | 共用骨架 | 平台差异来源 |
| --- | --- | --- |
| 账号 | `core/accounts.ts` | `checkSession`、`login_hint`、默认限额 |
| 草稿 | `services/drafts.ts` + `core/platform.ts` | `ContentSpec`（标题/正文字数、素材数量） |
| 队列与重试 | `services/worker.ts` | `publish()` 返回值、错误分类 |
| 计划任务 | `services/schedulerEngine.ts` | `platform` 字段与能力声明 |
| 已发布回读 | `services/published.ts` | 各平台 `fetchPublished` |

## 2. 当前状态

| 平台 | key | 内容类型 | 登录 | 发布 | 数据回收 | 评论 |
| --- | --- | --- | --- | --- | --- | --- |
| 小红书 | `xiaohongshu` | 图文（1-18 图，标题 20，正文 1000）、视频 | Cookie / 扫码 | 已实现（HTTP 签名） | 创作平台作品列表 | 只读 |
| 微信公众号 | `wechat_mp` | 长文（标题 64，正文 20000，封面 1 张）、贴图（1-9 图） | 扫码 | 只写草稿箱 | 已发表列表 | 精选留言（需探测） |
| 抖音 | `douyin` | 短视频、图文（2-35 图） | 扫码 | 隐藏窗口自动化 | 创作者中心作品列表 | 不支持 |

页面行为：

- 账号页按 `features.login_qr` 显示扫码入口；公众号与抖音的扫码固定无头启动，二维码只显示在运营台内。
- 需要人工验证时接口返回 `requires_window`，用户点「打开验证窗口」（`POST /api/accounts/qr/{sid}/window`）才会启动可见窗口。
- 创作台切换平台后，标题/正文字数、可见范围、素材数量提示随平台规格变化。
- 已有草稿切换平台走 `switch-platform`，在原草稿上完成，不复制新草稿。
- 公众号只写草稿，不占用发布额度；群发/发表需在公众号后台人工完成。

## 3. 数据模型

多平台依赖的字段（表结构由旧版数据库带入，Node 端只做增量迁移）：

| 表 | 字段 | 默认值 |
| --- | --- | --- |
| `accounts` | `platform` | `xiaohongshu` |
| `drafts` | `platform` / `content_type` | `xiaohongshu` / `image_text` |
| `jobs` | `platform` | `xiaohongshu` |
| `records` | `platform` | `xiaohongshu` |
| `published_notes` | `platform` | `xiaohongshu`（按账号 + 远端笔记 ID 唯一） |
| `schedules` | `platform` | `xiaohongshu` |

Node 端新增的表：`design_ledger`（外观账本）、`custom_templates`（自定义出图模板）。Schema 变更统一登记在 [REVIEW-FULL-20261125.md](REVIEW-FULL-20261125.md) 第 5 节。

## 4. 接新平台清单

1. **注册元数据**：在 `core/platform.ts` 增加 `PlatformMeta`（内容规格、可见范围、默认限额、能力、数据来源），并加入 `ORDER`。
2. **建设配器**：在 `platforms/<key>/` 实现登录（扫码/凭证）、`checkSession`、`publish`、`fetchPublished`。
3. **扫码接入**：仿照 `platforms/douyin/qr.ts` / `platforms/xiaohongshu/qr.ts` 的注册表模式，在 `server/routes.ts` 的 `/api/accounts/qr` 分发。
4. **发布接入**：在 `services/worker.ts#executeJob` 增加平台分支，返回统一 `{ok, message, result, kind}`。
5. **回读接入**：在 `server/routes.ts` 的 `/api/published/sync` 增加平台分支，落库统一字段。
6. **文档**：更新本文件第 2 节状态与已知缺口。

不需要改：数据库表结构（`platform` 字段已通用）、队列状态机与限速、计划任务引擎、发布记录页骨架。

## 5. 已知缺口

- 抖音发布依赖创作者中心页面结构，平台改版会提示「找不到上传入口/发布按钮」，需要更新选择器。
- 公众号正文的图片会重传替换为 CDN 地址；复杂排版仍以主题内联样式为主。
- 已发布回读目前只手动触发，没有 6 小时自动同步。
- 已发布健康巡检是简化版：只统计缓存数量，平台侧下架/违规检测尚未迁移到 Node。
- 抖音评论不支持读取；公众号只能读精选留言。
- 文案生成当前只有离线模板，云端模型尚未接入 Node 主线。

以上缺口在页面上不会表现成「假装成功」：平台变更返回 `platform` 分类，内容超规格在入队前给出中文原因，登录失效会把账号标记为 `expired` 并要求重新扫码。
