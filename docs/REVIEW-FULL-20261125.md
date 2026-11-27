# 全功能 Review（0.2.9 · M3 动效开工前）

> 日期：2026-11-25 · 范围：desktop/ 桌面版（Next 主线）0.2.9 全模块
> 方法：静态走查（渲染管线 / 模板系统 / 平台适配 / 服务层 / 前端入口）+ 本日 API 冒烟（10/10）与浏览器 E2E（11/11，含自定义模板真实出图 8 张）结果引用
> 性质：开工前体检。P1 项不阻塞 M3 设计评审，但建议随 M3-a 或对应里程碑处置。

---

## 1. 总体结论

0.2.9 主线功能完整可用：选题 → 写稿 → 配图（V2 / 手绘 / 自定义模板 / 动图）→ 预览 → 发布 → 回收链路已验证；发布队列的状态机（幂等、中断回收、渐进恢复、证据留痕）是体系里最扎实的部分。主要短板集中在：**外部依赖未内置（ffmpeg）、后台自动化任务缺位（6 小时同步）、模板数据双轨漂移风险、少量前端联动缺口**。无 P0 阻断项。

---

## 2. 分模块发现

### 2.1 架构与数据层

✅ 良好：Electron 单进程 + 本机 HTTP(127.0.0.1:8711) + better-sqlite3，结构清晰；渲染串行队列复用隐藏窗口，避免窗口风暴；密钥独立存放 + icacls 收权（0.2.x review 已修）。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P1 | **模板 Schema 双轨**：`ops/db.py` SCHEMA 仍是全量表权威（accounts/drafts/jobs/published_notes…），`desktop/src/core/db.ts` 只做轻量迁移（补列 + design_ledger + custom_templates）。两版并存期间，任一侧改表另一侧不知情，存在漂移风险 | 立规矩：Python 版冻结（只修不加）；新表/新列一律走 Node db.ts migrate 并在本文件登记；M4 新表（画像等）只进 Node |
| P1 | **6 小时已发布同步缺位**：Python 版有 PublishedSyncThread 周期同步，Node 版只有手动 `POST /api/published/sync`（SYNC_INTERVAL_HOURS=6 仅为元数据）。回收/归因数据链路目前不自动更新 | 随 M4.3 归因写入补后台调度（schedulerEngine.tick 已有基础），或先挂到现有 worker tick |
| P2 | `/api/jobs` 无日期过滤、无日历聚合接口 | M4.2 内容日历时一并设计 |

### 2.2 出图管线（V2 / 手绘 / 自定义模板 / 动图）

✅ 良好：风格×版式正交 + 样张 + 多候选 + 外观账本按设计交付；手绘种子可复现（同 seed 逐像素一致有冒烟）；平台安全区体检（抖音 220/520）与标题/标签压缩策略生效；自定义模板渲染对占位符（标题/摘要/日期/金句）与三端画布适配（含 2.35:1 顶对齐裁切）符合设计。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P1 | **ffmpeg 未内置**：encodeMotion 从系统 PATH 取 ffmpeg（cards.ts:540）。用户机器没有 ffmpeg 时动图静默退化为静态首帧（仅 note 字段可查），产品能力实际不可用且用户难感知 | M3-d：安装包内置 ffmpeg（extraResources），并给「未检测到 ffmpeg」的明确前端提示 |
| P2 | 动图画幅/时长/帧率硬编码（1080×1440、25fps、6s） | M3-a/c 参数化（已列入设计） |
| P2 | 自定义模板出图体检全 warnings 放行（checkBlocks 对 custom 不拦截）——刻意的宽策略 | 保持，观察误版式反馈再评估 |

### 2.3 模板编辑器（0.2.9 新增）

✅ 良好：独立「模板」页 + 三页画布 + 10 种元素 + 拖拽/缩放/旋转 + 官方模板按页型引用 + 元素级复制粘贴；custom_templates CRUD API 齐全；`custom:<id>` 进 design/styles 与出图 dispatch 链；E2E 11 项含真实出图全过。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P1 | **保存新模板后创作台不自动刷新**：`state.designStyles` 是快照，`refreshCardStyles()` 仅在云登录/退出/初始化时调用（app.js:8059/8202/8217/9691），模板保存/删除/复制后未刷新。用户在编辑器存完模板切回创作台，看不到「我的模板」新条目，需手动刷新页面 | 随 M3-a 顺手修：模板保存/删除/复制成功后与 switchView("studio") 时调用 `refreshCardStyles()`（一行级修复） |
| P2 | 模板并发编辑无冲突处理（后写覆盖先写） | 单机单用户场景，接受；文档记录即可 |
| P2 | template-editor.js ~930 行单文件 | 可维护性观察项，暂不拆 |

### 2.4 创作台与前端

✅ 良好：预览平台跟随（previewPlatform 与编辑平台解耦）、发布平台真多选、媒体区按平台分组带角标、图片加载失败重试兜底。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P2 | app.js 近万行单文件 + ui-refresh.js 混合渲染，回归面大 | 不强制拆分；新功能优先独立模块（template-editor 先例），重大重构另立计划 |
| P2 | 文案生成目前为本地离线模板路径（generateFromBrief），云端/模型链路依赖 EchoQ-Cloud 可用性 | M4.4 创作建议走纯规则版，不新增模型依赖；画像注入位在设计里预留 |

### 2.5 发布与队列

✅ 良好：jobs 状态机（pending/retry→running→success/failed/pending_confirm）+ 提交标记 + 中断回收 + 冷却渐进恢复 + 证据留痕，健壮性设计到位。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P2 | 微信 access_token 仅内存缓存（ensureTokenAsync 解析 /cgi-bin/home HTML），进程重启后首次发布需重新解析；Python 版有发布后回写 Cookie/token 入库（_persist），Node 未移植 | 随 9.3「直接发送」一并处理（token 生命周期管理） |
| P2 | 公众号仅同步作品列表与互动数，未接 datacube 趋势统计 | 列入 9.4 储备 |

### 2.6 平台适配与账号

✅ 良好：抖音登录三分态 + 服务端自证；公众号上传三端点依次回退（upload_material → scene=8 → uploadmaterial）；正文图 uploadInlineImages 已实现本地图重传替换 cdn_url（「插图」功能的关键地基已存在）。

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P2 | 本机接口无鉴权（guardLocalRequest 只校验 Host/Origin/Referer），README 已声明边界 | 维持现状 + 文档警示；若未来提供局域网模式需重评 |
| P2 | 微信「直接发送」（freepublish/submit）无实现，任务结果恒 stage=draft | 9.3 设计后再动（涉及「不做群发」历史决策重评） |

### 2.7 文档与版本

| 级别 | 发现 | 处置建议 |
| --- | --- | --- |
| P2 | CHANGELOG 缺 0.2.8（创作台三项修复独立打包）与 0.2.9（模板编辑器）条目 | M3 开工前补录 |
| P2 | README 界面截图仍为 0.2.7 时期 | 0.3.0 发布时随 docs/ui/ 一并更新 |

---

## 3. 问题清单汇总

| # | 级别 | 摘要 | 处置时机 |
| --- | --- | --- | --- |
| 1 | P1 | 模板 Schema 双轨漂移风险 | 立即立规矩（Python 冻结，Node 权威） |
| 2 | P1 | 6 小时已发布同步缺位 | M4.3 |
| 3 | P1 | ffmpeg 未内置，动图能力不可用不显性 | M3-d |
| 4 | P1 | 保存模板后创作台选择器不刷新 | 随 M3-a 顺手修 |
| 5 | P2 | CHANGELOG 缺 0.2.8/0.2.9 条目 | M3 开工前 |
| 6 | P2 | wechat token 不落库 | 9.3 |
| 7 | P2 | /api/jobs 无日期过滤 | M4.2 |
| 8 | P2 | app.js 巨型文件 | 观察项 |
| 9 | P2 | 公众号 datacube 缺失 | 9.4 储备 |
| 10 | P2 | 本机接口无鉴权 | 已知边界，维持 |

## 4. 开工前行动

1. 补 CHANGELOG 0.2.8 / 0.2.9 条目（#5）；
2. 在本文档登记「Schema 变更登记表」起始页（#1 的落地动作）；
3. M3 设计文档（docs/M3-MOTION-VIDEO-DESIGN.md）评审通过后按 M3-a → d → b/c → e → f → g → h 顺序实施；
4. M4 按 docs/M4-OPS-INTELLIGENCE-DESIGN.md 评审后排期，暂不动工。

## 5. Schema 变更登记表（自本 review 起）

| 表/列 | 引入版本 | 侧 | 说明 |
| --- | --- | --- | --- |
| design_ledger | 0.2.0 | Node db.ts | 外观账本 |
| custom_templates | 0.2.9 | Node db.ts | 自定义模板 |
| （M4 将新增：account_profiles、suggestions 等） | 0.4.0 | Node db.ts | 见 M4 设计文档 |
