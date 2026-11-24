# CHANGELOG

## 2026-11-24 · M2 手绘引擎接入（desktop 0.2.5）

- **代码化手绘引擎（`desktop/src/render/sketch.ts`）**：风格 = 绘制原语 + 构图规则 + 种子。随机只来自 mulberry32(seed)，布局/抖动/颗粒各用独立派生流；手绘感来自几何抖动（jitter/blob）而非滤镜。页面 = `<canvas>` 插画层（内联脚本同步绘制）+ 纸色文字面板；出图走与 V2 相同的 Electron 隐藏窗口截图与版式体检（errors 拦截 / warnings 告警），文字块类名 `sk-*` 进探针白名单。
- **首批 5 种手绘风格**（并入免费模板「手绘插画」组，均带封面样张）：平涂向量（科技感）、铅笔淡彩（生活感）、马克漫画（活泼海报感）、水墨国风（sumi-e 留白与竹枝印章）、剪纸节日（层叠色纸与灯笼圆窗）。
- **种子可复现 + 「换一张」**：同（草稿, variant）逐像素一致（冒烟验证同 seed 渲染两遍 PNG 逐字节相等、换 seed 画面不同）；创作页手绘风格下显示「换一张构图」按钮，点击 variant+1 换种子重渲；design-cards 请求新增 `variant` 透传（`renderOptions` 白名单同步补 `variant`/`limit`）。
- **多画幅**：3:4 竖版（封面 / 内容 / 结尾页）+ 公众号 2.35:1 宽幅（插画居左、文字面板居右）。
- 版本 0.2.4 → **0.2.5**（desktop/package.json）。

## 2026-11-24 · M1 体验修复（按截图反馈，desktop 0.2.4）

- **动图真正可用（Next 版）**：`/api/drafts/:id/motion` 从「静态首帧占位」改为真动图——逐帧渲染（6s × 25fps，`__seek` 确定性动效契约，Electron 隐藏窗口同帧截图）→ ffmpeg 合成 `loop.gif`（15fps / 540 宽 / 两阶段调色板）+ `motion.mp4`（810×1080 H.264）；逐帧渲染或合成失败自动回退静态首帧并在 `note` 说明原因。
- **多候选预览改版**：候选不再单独占一个区块，直接**占用媒体预览区（#media-grid）的位置**并排展示三版，点「选用」后恢复正式配图；候选卡片放大、信息精简为一行。
- **版式 / 调色板选择器重排**：改为标签在上、选项在下的布局，胶囊按钮横排自动换行，不再挤成竖条。
- **修复长图分页（strip）被体检误拦**：section 标题此前是流内块，从 (0,0) 铺满整页触发「越过安全边距」拦截；现移入绝对定位标题区（Python 与 Next 版同步修复），长图分页可正常出图。

## 2026-11-24 · 0.2.0 出图体系 2.0（M1）

- **风格 × 版式正交模板引擎（V2）**：新增 6 套「实用信息流」风格（知识卡片 / 步骤清单 / 数据信息图 / 对比测评 / 大字公告 / 图注解读）× 4 种版式（单图大标题 / 上下图文 / 左右分栏 / 长图分页）共 24 种组合，全部本地 HTML/CSS 渲染；每风格 3 套调色板（默认/暖调/冷调），颜色走 CSS 变量注入。
- **样张预览（1.3）**：每个风格 × 版式渲染一张 405×540 缩略样张（懒加载、落盘缓存），免费模板面板的风格卡片直接看样张选型；新接口 `GET /api/design/samples`、`GET /api/design/layouts`。
- **多候选生成（1.4）**：`POST /api/drafts/{id}/design-cards` 支持 `mode=candidates`，一次出 3 套风格互异、版式互异的候选并排预览；点选 `POST /api/drafts/{id}/design-candidate/select` 后设为正式配图。
- **外观账本（1.6）**：新增 `design_ledger` 表记录每账号每次选用的风格/版式/调色板；候选推荐时近期用过的风格降权、连续两次同风格强制回避，同账号连续出图不撞脸。
- **设计体检升级（1.5）**：体检分「错误（拦截出图）/ 警告（提示不强拦）」两级；越界与重叠维持拦截，新增的正文可读字号下限（<24px）、留白占比、头重脚轻、单页文字块过密检查先走**告警观察模式**（对齐 UPGRADE-PLAN 风险对策，观察一周后再评估切强制）；渲染探针采集每个文字块真实字号。
- **公众号排版补齐（1.7）**：发布与一键排版前自动把正文外部链接转成「文字[n]」+ 文末「参考链接」尾注（公众号正文不允许外链），公众号域名内链接保持原样。
- **Next 桌面版同步（desktop/ TypeScript 主进程）**：M1 出图 2.0 移植到 Node 版——新增 `src/render/v2templates.ts`（6 风格 × 4 版式 × 3 调色板模板引擎，与 Python 版同构）、`renderer.ts` 版式探针与 `checkBlocks` 体检（errors 拦截 / warnings 告警，Electron 隐藏窗口同帧采集，无 Playwright 依赖）、`cards.ts` 多候选 / 点选 / 样张 / 外观账本；`server/routes.ts` 新增 `GET /api/design/samples`、`GET /api/design/ledger`、`POST /api/drafts/:id/design-candidate/select`，design-cards 支持 `mode=candidates`；`core/db.ts` 迁移建 `design_ledger` 表（与 Python 版同库同构）。前端与 Python 版共享同一份 `ops/web/static`，样张风格卡 / 版式调色板选择 / 多候选预览两端通用。
- 版本 0.1.0 → **0.2.0**（`ops/__init__.py`、`electron/package.json`、`desktop/package.json` 同步）。

## 2026-11-17 · 发布中断可回收、登录自证、失败留现场、冷却渐进恢复

- **提交标记与中断回收（P0-1）**：`jobs` 新增 `submitted_at`，真正调用平台前先落库。服务启动时回收遗留 `running`：已提交 → `pending_confirm`（24 小时核对期，不自动重发）；未提交 → 回到 `pending` 并标记「服务重启，等待重试」。任务卡展示「已提交到平台，等待回执」。
- **抖音登录只认服务端自证（P0-2）**：`check_session` 移除 Cookie 兜底，改为三分态：明确登录墙 → expired；打不开/跳转异常/账号信息接口无返回 → transient（保留原状态）；进入 `creator-micro` 且读到昵称或 uid → healthy。发布前同样校验页面已进入 `creator-micro`，避免在登录页继续操作。
- **发布失败留现场（P1-3）**：抖音发布异常时保存截图与 DOM 快照到 `datas/ops/evidence/`，写入 `result.evidence`；账号诊断抽屉提供「查看现场截图 / 下载 DOM 快照」，新增 `GET /evidence/{filename}`（文件名与后缀白名单）。证据只保留最近 200 个文件。
- **冷却后渐进恢复（P1-4）**：`accounts` 新增 `probe_success_count`。冷却结束进入 `probing`，每次成功探测计数，连续 2 次（间隔约 5 分钟）才恢复发布；探测中发布继续被阻断并说明进度。人工解除冷却直接恢复 `healthy`。
- **公众号精选留言只读探测（P2-5）**：新增 `comments_mode`（read/probe/none），公众号为 `probe`。首次同步调用 `/mp/appmsgcomment?action=list_comment` 探测权限并缓存精选留言，无权限时返回明确原因；自动评论同步只跑 `read` 平台，公众号仅手动探测。前端按钮显示「探测并同步」，并说明只含精选留言。
- 自检 55 → **59 项**：新增中断任务回收、冷却后连续探测、抖音登录三分态、公众号精选留言归一化与 probe 模式。

## 2026-11-16 · 修复索引墨内容页重叠与目录重复计节

- **索引墨内容页（`ink/03-content`）页码压标题**：原实现把页码 `.pageno`（右上绝对定位）和标题 `.h`（左右铺满绝对定位）各自摆放，长标题伸到右侧就与页码重叠。改为同一行网格：标题占 `1fr`、页码占 `auto` 列，标题只在剩余宽度内换行；标题宽度预算同步扣除页码列，结构上不再可能重叠。
- **目录把翻页当成分节**：`_design_pages` 的目录此前收集所有内容页，第 5、6 页属于同一节的「（续）」也被算成一节，封面出现「其余 2 节」并多出一条「…（续）」目录。现在续页标记 `continued`，目录只列真实分节（面试篇 4 节、赣州篇 3 节），「个分节 / 其余 N 节」计数同步修正。
- **失败提示更明确**：版式自检失败信息改为「…（第 3/7 页）：原因。本次整组未保存，草稿仍保留上一次的配图。」——不会让人误以为只生成了 1 张。
- **默认参数核对**：`POST /api/drafts/{id}/design-cards` 不传 `platform` 时取草稿平台（小红书 → 竖版），不传 `limit` 时生成全部页面（草稿 72 = 7 张），不存在默认 `limit=1` 或 `canvas=wide`。此前「只出 1 张」是整组失败后草稿仍保留旧的单张封面（图片路径来自其它草稿，页眉因此显示 MEMO）。
- **布局自检覆盖序号列**：检查选择器新增 `.ink .no`、`.ink .item b`。
- 实测：草稿 72 用索引墨生成 7 张 1080×1440；赣州（6）与面试（72）便签纸/索引墨封面重跑对照。自检仍 46/46 通过。

## 2026-11-15 · 修复免费模板生成 500（便签纸竖版目录重叠）

- **真实原因**：便签纸封面把全部分节目录都排上去，6 节时第 6 行（top≈1258）与下方提示语「往后翻，都是自己踩过的坑」（top=1230）重叠，出图前的版式自检抛 `RuntimeError`。宽幅改动只是让 `RENDERER` 版本号变化、缓存签名失效，重新触发了一直被旧缓存跳过的检查，并非竖版路径本身被改坏。
- **修复**：封面目录最多 4 行，超出的节收成一行「其余 N 节」，目录底边回到 1186px，与提示语留出间距；内容页/结尾页不受影响。
- **500 带人话原因**：接口中间件对 `RuntimeError` 返回具体原因（如「版式自检失败（memo/01-cover）：…（错误编号 xxxx）」），错误编号作为附加信息保留；含绝对路径或过长的原文仍只进日志，避免泄露内部路径。
- 回归验证：8 套模板 × 竖版（1080×1440）与宽幅（1080×460）全部出图；便签纸 6 节目录全量 8 页正常；草稿 6 原始失败场景（`style=memo`，不传 platform）返回 6 张 1080×1440。
- 自检 45 → **46 项**：新增「配图默认参数」，不传 `canvas/platform` 直接走 `render_design_cards` 出竖版封面并校验 1080×1440。
- 本次仍不改 `ops/web/static/`。

## 2026-11-15 · 公众号原生宽幅封面

- **新增 2.35:1 宽幅画布**：`ops/designs.py` 增加 `WIDE_WIDTH=1080` / `WIDE_HEIGHT=460`，`design_canvas(platform)` 按平台返回 `wide` 或 `portrait`；公众号不再把 3:4 竖图居中裁切成封面。
- **8 套免费模板各做一套横版封面**：便签纸、信息卡、杂志奶油、极简黑白、索引墨、标本志、日报、收藏卡均有独立宽幅版式——标题按横向重排、右侧改为摘要/编号/导读、装饰位置重定位；长标题自动收敛到 3 行内（极端长标题允许第 4 行，字号不低于 30px），不再压字或溢出。
- **版式自检覆盖宽幅**：`_layout_blocks` / `_check_blocks` 接收画布模式，按 1080×460 的安全边距与重叠规则检查；`check_design_layout(..., platform)` 对公众号只检查封面页。出图前不通过直接 `RuntimeError`，不落半成品。
- **接口按平台出图**：`POST /api/drafts/{id}/design-cards` 接受 `platform`（缺省取草稿平台），响应新增 `template{key,name}`、`canvas{key,width,height,aspect,label}`、`platform`；`GET /api/design/styles` 每项带 `wide` 与宽幅 `canvas`。小红书 / 抖音图文仍为 1080×1440。
- 建图缓存签名加入画布模式，宽/竖版不会互相复用旧图；`meta.json` 记录 `canvas` 与 `style_name`。
- 自检 44 → **45 项**：新增「宽幅封面」，验证画布选择、8 套模板横版 HTML、宽/竖不同边界判定与真实浏览器版式检查。
- 更新 `docs/API.md`（配图章节）、README、ARCHITECTURE。本次不改 `ops/web/static/`。

## 2026-11-15 · 三平台差异化文案生成

- **按平台分叉的写作策略**：`ops/content.py` 新增 `PLATFORM_WRITING` 与三套 system prompt。
  - 小红书：emoji 分节、短句换行、口语开场、结尾引导互动，标题 ≤20 字。
  - 公众号：导语 + 「一、二、三」小标题 + 段落推进 + 收束，书面克制、最多 2 个 emoji，标题 16-32 字（上限 64）。
  - 抖音：`【前3秒】`钩子 + `【画面】` + `【口播】` + `【结尾】`，120-240 字，明显短于公众号，标题上限 55。
- **限制按平台真实规格**：标题、正文、话题数量分别取适配器 `spec.title_max/desc_max` 与平台档位；超长时按句子 → 分句 → 空格顺序压缩，再不行才硬切，不再截断半个词。
- **接口支持平台参数**：`/api/copy/generate`、`/api/copy/rewrite`、`/api/copy/check`、`/api/drafts/{id}/rewrite` 新增 `platform`，缺省 `xiaohongshu`（向后兼容），未知平台返回 `400`；响应带 `platform/platform_name/title_max/body_target`。草稿洗稿缺省沿用原草稿平台。
- **离线兜底三套模板**：`_offline_xhs` / `_offline_wechat` / `_offline_douyin`，洗稿兜底同样按平台分叉，不再三平台共用一套。
- 自检 43 → **44 项**：新增「三平台文案差异」，同一份输入校验三平台 `platform` 字段、结构标记、篇幅比例、话题写法与标题上限。
- 更新 `docs/API.md`（平台参数、平台规格表、响应字段）。本次不改 `ops/web/static/`。

## 2026-11-15 · 修复「生成文案」卡死

### 根因

- `requests` 的 `timeout=180` 只限制单次连接/读取，覆盖不到 DNS 解析，也无法限制慢速滴流的总耗时；一次生成还可能串行调用两次模型，最坏要等 6 分钟。
- 生成接口在请求线程里同步等待模型，没有接口级超时；前端 `fetch` 也没有超时，所以表现为一直转圈。
- 后台任务（一键成稿/批量生成/配图/洗稿）没有任务级看门狗，线程卡住时 `status` 永远 `running`，轮询永远不会结束。
- 配图使用全局渲染锁 `with _LOCK`，前一个渲染卡住时后来的请求无限排队；浏览器子进程每次最多 120 秒、多页叠加。

### 修复

- **模型请求硬超时**：请求放入守护线程并 `join`，默认单次 45 秒必返回；`requests` 连接超时收紧到 5 秒。一次生成总预算 60 秒，压缩重写只在剩余预算足够时执行。
- **接口兜底**：生成/洗稿接口默认 75 秒，配图 240 秒；超时统一返回 `504` 和「处理超时，请稍后重试；已保留当前输入」，不再无限转圈。
- **离线兜底真正接管**：模型超时/连接失败时返回离线文案，并带 `llm_error`、`retryable=true`；前端提示具体失败原因，按钮恢复可重试。
- **任务看门狗**：`TaskCenter` 增加 `deadline_at`，超时任务标记 `failed`「处理超时，请重试」，迟到的结果不会覆盖失败状态；批量生成按选题数/配图估算预算。
- **配图锁与渲染预算**：渲染锁改为带超时获取，拿不到明确报「队列繁忙」；整组渲染有总预算，每页子进程超时取剩余预算，不再无限排队/叠加。
- **同类路径**：文案生成、洗稿、草稿洗稿、一键成稿、批量生成、配图、付费配图、设计配图全部接入超时兜底。

### 自检与文档

- 自检 38 → **43 项**：新增「模型请求硬超时」「离线兜底接管」「后台任务看门狗」「接口超时兜底」；平台接入窗口同期新增「新平台规格与分类」。
- 更新 `docs/API.md`（`llm_error/retryable`、任务 `deadline_at`、504 约定）、`docs/RUNBOOK.md`（超时配置与排查）、`.env.example`、`README.md`、`DEPLOY.md`、`docs/ARCHITECTURE.md`、`docs/REVIEW.md`。

## 2026-11-15 · 前端接口缺口收尾

- `GET /api/schedules` 支持 `offset`，响应补 `total`，计划页可真分页。
- `GET /api/records` 响应补全局 `success_total` / `failed_total`，前端不再只能统计当前页。
- `GET /api/accounts` 响应补 `total`，账号多时可分页。
- 自检新增「列表分页字段」，覆盖三个接口的字段与分页参数，37 → **38 项**。

## 2026-11-15 · Review 修复（P1/P2 全量）

### 安全

- **密钥移出数据目录**（P1-1）：`secret.key` 默认放 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`，支持 `OPS_KEY_PATH`；旧数据目录密钥首次启动自动迁移（冲突时备份新密钥、优先保留能解开现有 Cookie 的旧密钥）；Windows 下用 `icacls` 去掉继承权限、只授当前用户；启动时检查并在 `/api/health` 暴露 `key.outside_data_dir/restricted/warning`。
- **上传内容校验**（P2-1）：按文件头（PNG/JPEG/GIF/WEBP）校验真实类型并与扩展名匹配，伪装成图片的 HTML/SVG 直接拒绝。
- **安全响应头**（P2-1）：统一 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、CSP（`frame-ancestors 'none'`）。
- **同步错误脱敏**（P2-9）：平台异常原文只进日志，接口与账号 `sync_error` 只显示中文分类；登录态检查、发布异常同样处理。

### 可用性

- **同步与发布锁分道**（P1-2）：账号锁拆成 `publish` / `sync` 两条通道；已发布同步、登录态检查、选题挖掘走 `sync`，同步取不到锁立即降级，不再阻塞真实发布 180 秒；账号正在发布时同步直接跳过并在下一轮补上。
- **截断不再静默**（P1-3）：`GET /api/published` 超出查询上限时返回 `meta.truncated/total_exact/query_limit/notice`；单次同步支持 `OPS_SYNC_MAX_PAGES`（默认 20 页），结果返回 `truncated/next_cursor` 并在 `message` 中说明还能继续同步。

### 正确性

- **指标空值语义**（P2-3）：`published_notes` 的 `views/likes/comments/collects` 改为可空，平台未返回时存 `NULL` 并原样返回 `null`；新增 `metrics_available`。旧库自动迁移列，旧记录重新同步后生效。
- **模拟发布不占限额**（P2-4）：账号日限额与 `published_today` 排除 `message LIKE '模拟发布%'` 与 `result.simulated`。
- **话题写法按平台**（P2-5）：`#话题` / `#话题#` / 不加话题三种形态按适配器 `topic_style` 处理；公众号不再套小红书 `#`。
- **事务嵌套保护**（P2-2）：`db.transaction()` 增加线程内深度计数，内层 `db.execute` 不再提前提交外层。
- **风格接口移出事件循环**（P2-6）：`/api/cards/styles`、`/api/cards/options` 的目录扫描放入线程池。
- **演练不写正式库**（P2-7）：`e2e_demo` 默认 `datas/ops-e2e`，误指向正式库时拒绝运行（可用 `OPS_E2E_ALLOW_LIVE=1` 显式放行）。
- **依赖锁版本**（P2-8）：`requirements.txt` 直接依赖全部锁定精确版本，并显式加入 `cryptography`。

### 自检与文档

- 自检 31 → **37 项**：新增「密钥独立存放」「事务嵌套保护」「上传内容校验」「安全响应头」「模拟发布不占限额」「平台话题写法」，并扩充「已发布内容回收」（空指标、截断提示）。
- 更新 `docs/REVIEW.md` 状态、`docs/API.md` 契约、`docs/RUNBOOK.md` 密钥与配置、`docs/DATA_MODEL.md` 边界、`docs/ARCHITECTURE.md` 数据目录、`.env.example`、`README.md`、`DEPLOY.md`。

## 2026-11-15

### 新增

- **多平台骨架**：新增 `ops/platforms/` 适配器层，小红书完整实现，微信公众号与抖音为接入位；账号、草稿、队列任务、发布记录、计划任务全部带 `platform` 字段；草稿增加 `content_type`。
- **平台迁移**：`ops/db.py` 在单事务内为旧库补 `platform/content_type`，现有数据自动归到小红书，视频草稿回填 `content_type=video`。
- **已发布内容管理**：
  - 新表 `published_notes`，缓存平台作品列表；
  - 新模块 `ops/published.py`：同步、筛选、分页、账号级同步状态；
  - 新接口 `GET /api/published`、`POST /api/published/sync`、`GET /api/published/accounts`；
  - 新增后台线程 `PublishedSyncThread`，每 6 小时按账号同步，与发布队列解耦；
  - 平台未同步到的真实发布记录以 `source=local_record` 占位，模拟发布自动排除。
- **配图风格兜底**：`OPS_BAOYU_XHS_SKILL` 目录缺失时回退内置 12 种风格 / 8 种版式 / 3 种配色，接口不再返回空列表；`/api/cards/options` 增加 `backend.counts`、`backend.skill_ready`、`paid.available`、`paid.source`。

### 修复

- 配图风格接口在预设目录缺失时静默返回 0：改为多路径探测 + 内置回退 + 启动日志告警。
- 删除账号时未清理 `published_notes` / `rate_events`，会留下孤儿数据：已补级联删除。
- 同一账号的自动同步与手动同步可能并发重复请求平台：增加账号级非阻塞锁。
- 已发布内容列表逐条构造平台适配器造成重复对象：改为服务内缓存。

### 文档

- 新增 `docs/ARCHITECTURE.md`、`docs/RUNBOOK.md`、`docs/API.md`、`docs/DATA_MODEL.md`、`docs/CHANGELOG.md`、`docs/REVIEW.md`。
- 更新 `PLATFORMS.md`、`README.md`、`.env.example`、`DEPLOY.md` 的自检数量与新接口。

### 自检

- 自检从 27 项增至 31 项：新增「平台注册表」「平台字段迁移」「跨平台发布拦截」「已发布内容回收」。
- 「配图风格清单」增加付费面板一致性、选项字段完整性与来源检查。
- 当前结果：**31/31 通过**。

