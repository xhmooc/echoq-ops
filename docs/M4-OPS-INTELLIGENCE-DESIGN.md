# M4 运营智能 v1 · 设计与测试验证方案

> 版本：v1.0 · 2026-11-25
> 状态：设计完成，**按决策暂不动工**（待 M3 交付后评审排期）；目标版本 0.4.0
> 上位规划：docs/UPGRADE-PLAN.md 第 3 章 M4（借鉴 Easel：画像-归因闭环）
> 前置 review：docs/REVIEW-FULL-20261125.md（P1#2 同步缺位在本期解决）

---

## 1. 目标与范围

把「回收数据」变成「创作策略」，补上画像-归因闭环：

| # | 能力 | 一句话 |
| --- | --- | --- |
| 4.1 | 账号画像 | 每账号六维：定位 / 风格关键词 / 受众 / 平台偏好 / 偏好红线 / 统计摘要；创作时带出画像上下文 |
| 4.2 | 内容日历 | 选题 / 草稿 / 待发 / 已发 / 定时按日呈现的月视图 |
| 4.3 | 归因写入 | 发布数据回收后按内容聚合，沉淀「什么选题/风格/时段表现好」 |
| 4.4 | 创作建议 | 创作页轻量建议（只读提示，不强制） |
| 4.5 | 人工发布模式 | 排版 → 预览确认 → 导出素材包 → 官方页面手动提交；与自动发布队列区分（小红书首发） |

**非目标**：不做跨会话 Agent 记忆、不做自动策略调整（建议只读）、不做 LLM 画像推断（第一期画像由用户填写 + 统计聚合）。

---

## 2. 现状基线（已核实，2026-11-25）

| 事实 | 位置/说明 |
| --- | --- |
| accounts 已有 group_name、tags(JSON ≤8 项)、nickname、profile_key 等字段，但无画像表 | core/db.ts、core/accounts.ts:300 |
| published_notes 有 views/likes/comments/collects（可空，NULL=平台未返回）+ metrics_available；Python 侧另有 published_metrics_daily 日趋势与 note_comments | ops/db.py:133,220,234；desktop services/published.ts:69 |
| **Node 版无 6 小时自动同步线程**（Python 有 PublishedSyncThread），同步全靠手动 POST /api/published/sync | review P1#2 |
| overview 服务已聚合账号/草稿/任务/待办 | services/overview.ts:19 |
| jobs 状态机完整（pending/retry/running/success/failed/pending_confirm + scheduled_at/submitted_at） | services/worker.ts |
| topics 来源含 trending（热榜），四维评分（engagement/fresh/fit/novelty） | services/topics.ts:7,16 |
| 文案生成为本地离线模板（generateFromBrief），无画像注入位 | services/copy.ts:124 |
| 前端无日历视图；发布计划页为列表 | app.js |
| design_ledger 记录每账号出图风格选用 | 0.2.0 起 |

---

## 3. 数据模型（全部只进 Node db.ts migrate，遵循 review #1 登记制度）

### 3.1 新表 account_profiles

```sql
CREATE TABLE IF NOT EXISTS account_profiles (
  account_id     INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  positioning    TEXT NOT NULL DEFAULT '',      -- 定位一句话
  style_keywords TEXT NOT NULL DEFAULT '[]',    -- JSON：风格关键词 ≤10
  audience       TEXT NOT NULL DEFAULT '',      -- 受众描述
  platform_prefs TEXT NOT NULL DEFAULT '{}',    -- JSON：平台偏好
  red_lines      TEXT NOT NULL DEFAULT '',      -- 偏好红线（不写什么）
  stats_summary  TEXT NOT NULL DEFAULT '{}',    -- 归因聚合快照（4.3 写入）
  updated_at     INTEGER NOT NULL
);
```

### 3.2 新表 suggestions（建议缓存）

```sql
CREATE TABLE IF NOT EXISTS suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,                           -- NULL = 全局建议
  kind       TEXT NOT NULL,                     -- 'topic' | 'style' | 'timing'
  text       TEXT NOT NULL,                     -- 展示文案
  basis      TEXT NOT NULL DEFAULT '{}',        -- JSON：统计依据（可解释）
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                    -- 过期后由下次聚合覆盖
);
```

### 3.3 accounts 补列（人工发布开关）

```sql
ALTER TABLE accounts ADD COLUMN manual_publish INTEGER NOT NULL DEFAULT 0;  -- 1=该账号走人工发布
```

### 3.4 归因聚合不建新表

第一期按需查询聚合（published_notes ⨝ drafts ⨝ design_ledger），结果写 `account_profiles.stats_summary` 快照 + suggestions；数据量（单账号百级笔记）无需预聚合表。Python 侧 published_metrics_daily 暂不迁移。

---

## 4. 归因写入流程（4.3）

```
触发：a) 手动 POST /api/published/sync 完成后
     b) M4 新增后台同步线程（复用 worker tick：每 30 分钟检查
        published_synced_at 超 6h 的账号 → 自动同步，补齐 review P1#2）
  ↓
聚合（services/attribution.ts，纯函数可单测）：
  近 30 天 published_notes（metrics 非空）⨝ drafts 取题材（topics.category/keyword）
  ⨝ design_ledger 取风格 → 三个维度聚合：
  ① 题材 × 平均互动率（(likes+comments+collects)/max(views,1)）
  ② 出图风格 × 平均互动率（design_ledger.style）
  ③ 发布时段（published_at 小时桶）× 平均互动率
  ↓
写入：account_profiles.stats_summary = 快照
     suggestions 覆盖式更新（保留可解释 basis：
     「近30天『教程类×知识卡片』平均互动率 4.1%，为基线 2.3 倍」）
```

基线 = 该账号全部笔记整体平均互动率；样本 <5 条时不产出该维度建议（防小样本误导）。

---

## 5. 创作建议引擎（4.4）

- 纯规则版，读 suggestions 表，不依赖 LLM；
- 创作页（studio）侧栏新增「建议」卡片：按当前账号显示 ≤3 条（topic/style/timing 各一），无账号时显示全局建议；
- 文案示例：「这个账号近 30 天『对比测评 + 步骤清单』互动最好，本篇可以沿用」「20-22 点发布的笔记互动率高出 38%，可定时到 20:30」；
- 点击建议仅做填空式辅助（如自动把定时时间填入），不做强制改动。

## 6. 画像注入文案生成（4.1 联动）

- `generateFromBrief` 增加 `accountProfile` 入参（routes 层从 account_profiles 取）；
- 第一期离线模板用法：画像字段参与选题角度挑选与语气词表选择（如 red_lines 命中词直接剔除、audience 决定称呼语）；
- **预留 LLM prompt 位**：构造 `profilePrompt(profile)` 纯函数，输出可拼接的画像约束文本——未来接模型时直接进 system prompt，本期单测覆盖其输出格式。

---

## 7. 内容日历（4.2）

**API**：`GET /api/calendar?month=2026-11` →

```json
{ "month": "2026-11",
  "days": { "2026-11-05": [
    { "type": "published", "title": "...", "platform": "xiaohongshu", "account": "...", "url": "..." },
    { "type": "job", "status": "pending", "title": "...", "at": 1730000000 },
    { "type": "schedule", "name": "每天 20:30 发布", "at": 1730000000 },
    { "type": "topic", "title": "...", "status": "pool" },
    { "type": "draft", "title": "...", "status": "writing" }
  ] } }
```

- 数据源（全部现有表，不另起炉灶）：published_notes.published_at、jobs.scheduled_at（缺省用 created_at）、schedules.next_run_at、topics.created_at、drafts.updated_at；
- 后端按月边界查询 + 按日分组（纯函数 groupByDay 可单测）；
- **前端**：发布计划页顶部加月历网格（每格日期 + 彩点分类 + 悬停详情），点击日期滚动到该日任务列表；沿用现有标签式交互，无原生弹窗。

---

## 8. 人工发布模式（4.5，小红书首发）

- 开关：账号编辑页新增「人工发布」勾选（accounts.manual_publish）——**按账号**而非按平台（同一平台可混布自动/人工账号）；
- 入队分流：发布任务入队时，若目标账号 manual_publish=1 → 任务类型标记 `manual_export`，不进平台发布 worker；
- 导出包（POST /api/drafts/:id/export-package）：
  - 内容：配图原图（按平台分组）+ 文案包（标题/正文/话题，txt）+ 公众号另附排版 HTML + 小红书附「发布步骤清单」；
  - 落盘 `assets/export/draft-{id}-{accountId}/`，接口返回 zip 路径供下载；
- 状态呈现：任务列表显示「已导出 · 待人工发布」；用户在任务详情点「标记已发布」→ 写 records（success=true, message=人工发布）并回填 remote_note_id（可选）；
- 中断回收机制不变（submitted_at 语义：导出即提交标记）。

---

## 9. API 清单（新增/扩展）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/accounts/:id/profile` | 画像读写 |
| PATCH | `/api/accounts/:id` | 扩展 manual_publish 字段 |
| GET | `/api/calendar?month=YYYY-MM` | 月历数据 |
| GET | `/api/suggestions?account_id=` | 建议列表（创作页） |
| POST | `/api/suggestions/refresh` | 手动触发聚合（后台线程之外兜底） |
| POST | `/api/drafts/:id/export-package` | 人工发布导出包 |
| POST | `/api/records/:id/mark-published` | 人工发布回填 |

---

## 10. 任务拆解与实施顺序

| 工单 | 内容 | 依赖 |
| --- | --- | --- |
| M4-a | account_profiles/suggestions 建表 + 画像 CRUD API + 账号编辑页画像表单 | 无 |
| M4-b | 后台 6h 同步线程（补 review P1#2）+ attribution.ts 聚合纯函数 | M4-a |
| M4-c | 建议引擎 + 创作页建议卡片 | M4-b |
| M4-d | 画像注入文案生成（profilePrompt + 离线模板用法） | M4-a |
| M4-e | /api/calendar + 发布计划页月历视图 | 无（可与 a-d 并行） |
| M4-f | 人工发布模式（manual_publish + 导出包 + 状态呈现，小红书先走通） | M4-a |
| M4-g | 文档（CHANGELOG/README）+ 冒烟 + 打包 0.4.0 | 全部 |

---

## 11. 测试与验证方案

### 11.1 分层

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| L1 纯函数 | Node 直调 attribution.ts / calendar 分组 / profilePrompt / 建议规则 | 聚合计算、小样本保护、月边界、红线剔除 |
| L2 服务 | 临时脚本直调（Electron 入口） | 同步→聚合→建议 全链路落库 |
| L3 API | 起 server + HTTP 断言 | 画像 CRUD、calendar 各 type 归日、导出包产物、manual 分流 |
| L4 E2E | Edge headless | 账号画像表单保存、创作页建议卡、日历渲染、人工发布导出下载 |
| L5 人工走查 | 真机 | 小红书人工发布全流程走通一例（对齐 UPGRADE-PLAN 验收） |

### 11.2 关键断言

1. **画像往返**：PUT profile → GET 原样返回；删除账号级联删画像；
2. **归因正确性**：构造 6 条 published_notes（不同题材/风格/时段、含 1 条 metrics=NULL）→ refresh → suggestions 的 basis 数值与手算一致；metrics=NULL 的记录不进聚合；样本 <5 的维度不出建议；
3. **建议可解释**：每条 suggestion.basis 含样本量、均值、基线倍率；
4. **日历归日**：5 类条目按各自时间字段落入正确日期格；跨月查询只返回当月；
5. **画像注入**：red_lines 含「竞品贬低」→ 生成结果不含贬损句式（离线模板路径断言）；profilePrompt 输出含全部六维字段；
6. **人工发布分流**：manual_publish=1 账号入队 → 任务类型 manual_export、不调用平台 publish；导出包含图组 + 文案 + 步骤清单；「标记已发布」写 records；
7. **自动发布不回退**：manual_publish=0 账号走原链路（回归）；
8. **6h 同步线程**：把 published_synced_at 改成 7h 前 → 下一 tick 自动同步该账号（可用缩短间隔的测试配置验证）。

### 11.3 冒烟脚本规划（临时，通过后清理）

| 脚本 | 层 | 内容 |
| --- | --- | --- |
| desktop/smoke-m4-unit.cjs | L1 | 聚合/日历分组/prompt 构造 纯函数断言 |
| desktop/smoke-m4-api.cjs | L3 | 画像 CRUD + 日历 + 建议 + 导出包 + 分流 12 断言 |
| desktop/smoke-m4-e2e.mjs | L4 | 画像表单 → 创作页建议 → 日历面板 → 人工导出 |

### 11.4 验收对照（UPGRADE-PLAN M4）

| 原验收条目 | 对应验证 |
| --- | --- |
| 画像字段可编辑并影响文案生成 | 11.2-1、11.2-5 |
| 日历能正确呈现全状态内容 | 11.2-4 + L4 |
| 归因数据随回收任务自动更新 | 11.2-2、11.2-8 |
| 人工发布流程完整走通小红书一例 | 11.2-6 + L5 |

---

## 12. 风险与边界

| 风险 | 对策 |
| --- | --- |
| 平台互动数据缺失（NULL）导致归因失真 | 只聚合 metrics 非空记录；样本 <5 不出建议 |
| 建议误导创作 | 只读提示 + basis 可解释 + 不强制；界面标注「仅供参考」 |
| 人工发布与自动发布状态混淆 | 任务类型与状态文案严格区分（已导出/已人工发布 vs 已发布） |
| 后台同步线程与手动同步并发 | 沿用账号级 sync 锁（Python 版已有先例，Node 对齐） |
| 新表迁移破坏既有数据 | 只加表/加列， migrate 事务内执行；发布前用真实 %LOCALAPPDATA% 数据目录演练 |
