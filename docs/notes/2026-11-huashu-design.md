# 学习笔记：huashu-design（卡片 A）

> 仓库：https://github.com/alchaincyf/huashu-design （v3.3.0，MIT）
> 本地：`D:\Projects\reference\huashu-design`
> 精读范围：SKILL.md、references/modules/{xiaohongshu,motion,infographic,deck}.md、references/{directions,workflow,video-export,design-styles}.md、scripts/{design_lint,xhs_render,polish,verify,render-video,render-video-seek}.py/.js、convert-formats.sh
> 日期：2026-11-24

## 1. 体系总览

huashu-design 是「用 HTML 做视觉产出」的完整方法论，核心主张：**产出要让人认不出是 AI 做的**；每次从题材重新长出设计，而不是回到模型默认审美。架构分四层：

| 层 | 内容 | 对应文件 |
| --- | --- | --- |
| 工作流层 | 工作室六角色（艺术总监/品牌研究员/视觉设计师/动效设计师/前端/文案）、窄桥 8 条、Gate 文件 | SKILL.md |
| 方法层 | 三方向门、form 五问、打磨环、色彩推导协议、风格库 | directions.md、workflow.md、design-styles.md |
| 模块层 | 网页/deck/信息图/小红书/动效各自的手册与规格 | references/modules/* |
| 引擎层 | 体检、切图、逐帧渲染、合成、截图打磨等脚本 | scripts/* |

**窄桥（所有模块共用）**：① 事实验证先于假设；② 从已有资产出发；③ 品牌资产协议（出现几个产品取几个官方 logo）；④ **三方向门**（100% 触发）；⑤ 素材先行；⑥ 模板装饰与诚实内容（可读性底线：网页正文≥14px/标签≥12px，deck 24/16，1080 宽手机长图 36/28，对比度≥4.5:1）；⑦ 打磨环（写完看截图再改）；⑧ Gate 文件物化（brand-spec.md / direction-approved.md / 导演稿.md / polish-log.md，文件不在=环节没做）。

## 2. 关键机制精读

### 2.1 风格（style）与版式（layout）的字段描述

风格库共 92 种（网页 20 + PPT 20 + 信息图 20 + App 12 + 中文与东亚 12 + 小红书 8），每个风格条目的字段：

- **名称（中英）**＋ `温度·还原度` 标签：温度 ∈ {大胆/中性/安静}（故意让大胆款占多数，对抗模型的确定性偏差）；还原度 = 纯 HTML/CSS 无生图下能做到的还原程度（≥90% 闭眼做；70-90% 个别细节降级；<70% 必须标注降级，不假装能做原版质感）。
- **参考**：风格的来源语法描述。
- **适配**：什么内容适合用。
- **视觉 DNA**：版式结构、主角元素、装饰细节的具体描述（一条而已，不是参数表）。
- **HTML 实现**：布局技术要点（绝对定位/CSS Grid/counter 等）＋降级说明。
- **字体**：display+body 配对（只给开源替代）。
- **样张**：每个风格有样张 jpg ＋ 同名 .html 源码模板。

重要设计原则：**条目里的色值/字体是「示例锚点」不是配方**。真做时走**色彩推导协议**：采样（品牌资产/内容真图/文化语境）→ 收敛（oklch 压到 2-3 个有彩色+1 组中性色，有彩色之间 H≥60° 或 ΔL≥0.3）→ 论证（一句话写「为什么是这个色」，写不出=在抄配方）。低饱和=印刷质感：大面积底色 chroma 0.01-0.04，品牌主色 0.08-0.15，点睛 0.15-0.22。

**版式（layout）没有独立参数表**，它隐含在「视觉 DNA + 骨架」里；机器可比的版式指纹由 design_lint.py 从渲染结果反向提取（见 2.3）。

### 2.2 三方向门：6 缩略图 → 3 候选 → 正稿的输入输出

流程（directions.md Phase 4-7）：

| 步骤 | 输入 | 输出 |
| --- | --- | --- |
| Phase 1 澄清 | 用户需求；一次最多 3 问＋索要参考材料 | 需求假设清单 |
| Phase 2 重述 | 需求 | 顾问式重述（以「我直接做 3 个方向给你看」结尾） |
| Phase 3 固化 spec | 需求 | 设计 spec：只写「要说什么」，不写「长什么样」；**输出格式与尺寸必填且三版统一** |
| Phase 3.5 素材前置 | spec | 真图、logo 齐备，三方向共用 |
| Phase 4a 六候选 | spec＋风格库样张＋learn.py 偏好＋ledger 最近记录 | 三套逻辑×2：最佳设计师×2 / 现实参照×2（ref_board.py 截图拆解）/ 秒数轮盘×2（`S % 风格数 + 1` 随机抽，撞账本顺延） |
| Phase 4b 方向卡 | 六候选 | 每张卡 6 栏：逻辑与来源 / 借的是什么（具体规则）/ 主角素材 / 骨架一句话 / 胆量花在哪 / form 来自内容的哪里 |
| Phase 4c 六缩略图 | 方向卡 | `design-demos/thumbs.html` 六格（每格≈480×300，真字体真配色真标题，主角素材可见）；polish.py thumbs 检查占位格 |
| Phase 4d 挑三张 | 六缩略图 | 标准：①单看就够好 ②彼此不一样（骨架/气质，不挤同一家族）③不撞最近项目 ④最多一张用力过头（判断法：去掉该手法信息更清楚=过头） |
| Phase 5 并行构建 | spec＋各自方向卡 | 三个完整版 dir-1/2/3.html，每版过 1 轮打磨环＋design_lint check/compare/ledger check |
| Phase 6 展示即停 | 三完整版＋缩略图 | 用户选（无人值守也停） |
| Phase 7 落档 | 用户选择 | direction-approved.md 记原话；品味表态用 learn.py 逐字记；混合选择记「混了哪两栏」 |

### 2.3 设计体检（design_lint.py）

Playwright 打开页面（默认 viewport 1440x900），注入字号底线 `__MIN_BODY=14`、`__MIN_LABEL=12`（可按画布换算，如小红书 1242 宽 → 正文 42/标签 32）。

**红灯（必修）**：
- 图片裂图；console error / pageerror；
- 正文 <14px（针对 ≥28 字的非图注段落）；
- <12px 小字 ≥3 处；
- 对比度 <4.5:1（大字 24px 或 18.66px 粗体按 3:1；半透明文字先混底色再算）。

**黄灯（模板装饰，删）**：全大写+字距≥0.06em+≤15px 小标签≥3 处；「A·B·C」中点连接≥2；「X — y」标签；尾巴「→」≥2；等宽小字≥4；标题只换色/斜体且字数≤40%；内容非序列却用 01/02 编号≥3；标题字体是 Inter/Roboto/Arial/system-ui。

**外观指纹（用于 compare 与 ledger）**：
- bg_class：背景按 OKLCH 分 6 类（L>0.9 浅色；H40-110 暖纸；L<0.28 深色等）；
- 色板：整页截图后 PIL mediancut 提 6 色；
- 骨架：整页截图缩 32×20，FIND_EDGES 后 z 归一化。

**compare 判定「两版撞了」**：色板 OKLab 对称最近邻距离 <0.06、骨架相关 >0.55、同 bg_class＋同标题字体——任一命中即撞。`--brand` 只比骨架；`--ignore-layout` 跳过骨架。

**ledger（外观账本）**：`~/.huashu-design/ledger.jsonl`（可用 HUASHU_DESIGN_HOME 改），字段：date/project/file/note/desc/bg/bg_class/display/body/serif/palette/layout。`ledger check` 与最近 8 条比对，新方向与最近交付撞了就要求换。

### 2.4 小红书 3:4 多图：切图与连贯性

- 画布 **1242×1660**（近似 3:4；精确 3:4 用 1080×1440，字号按比例换算）；一篇最多 18 张。
- 字号底线（1242 宽）：正文 ≥42px、标签 ≥32px；封面标题在信息流里只显示约 1/3 屏宽，要 ≥100px、两行内。
- **一页一 `<section class="xhs-page">`**；连续长卷用 `<section class="xhs-strip" style="--n:3">`（总宽 1242×N）。
- **切张**：xhs_render.py 按 `round(宽/1242)` 切——先对整条 strip 元素截图，再用 PIL 每 1242×1660 裁片，输出 01.png…，并拼 6 列 sheet.jpg 总览。
- **连贯性机制**：`_kit/xhs.js` 提供 `XHS.wire()`（用同一条余弦曲线画贯穿线，周期跨两张，最低点不落在缝上）、`XHS.perch()`（把对象站到线上）、`XHS.straddle()`（把对象跨在第几道缝上）；主角跨缝「左图露 2/3、右图露 1/3」；每张单看也要有标题、讲得通。
- **切图体检**（✗ 退出码 1）：字号低于底线；≥2 行且 ≥16 字段落字号低于正文底线；字框出界（±2px）；**跨缝**=文字行框越过 j×1242 的缝（±4px）；字压字=两文字框上下各收 20%、左右收 2px 后相交（`data-overlap-ok` 豁免）。警示（!）：文字被图片/色块盖住（elementFromPoint 三点采样）；文字与无字纯色小色块（最长边<120px）相碰。
- 内容排布法：封面=钩子（数字/结论/反差）+主视觉，8-14 字标题，不放目录；第 2 张交代「这是什么」；中间一张讲一件事；最后一张落下一步。整组同一套页眉/页码/颜色/字体，相邻两张换构图。
- 8 个范式：01 标本志 / 02 贴纸本 / 03 索引 / 04 长卷 / 05 日报 / 06 集换卡 / 07 留白 / 08 信息图。每个样张同时是可复制模板（`assets/style-specimens/xhs/<编号>.html` + `_kit/xhs.css/js`）。

### 2.5 时间轴动画：HTML → MP4/GIF 管线

**两条渲染路径**：

| 路径 | 机制 | 适用 |
| --- | --- | --- |
| render-video.js | Playwright recordVideo 录 WebM（Chromium compositor 锁 25fps）→ ffmpeg 转 H.264；`--trim` 裁掉加载期，`--fontwait` 等字体 | 零风险、覆盖所有动画类型；帧率上限 25 |
| **render-video-seek.js**（推荐高质量） | **逐帧 seek**：注入 `window.__seekRender` 冻结自驱时钟＋`__recording=true`（动画侧检测到后 loop=false），等 `window.__ready===true && __seek` 可用；每帧调 `__seek(t)` → 等 `--settle`（默认 2）个 rAF → clip 截图 frame-%06d.png；`--concurrency`（默认 4）个 page 并行分帧 | 真 60fps、无黑帧、**确定性**（同输入同输出）；只支持走 Stage 时钟的动画（暴露 `__seek(t)`） |

ffmpeg 编码：`-framerate fps -i frame-%06d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -r fps -movflags +faststart`。默认 1920×1080、60fps、30s。

**格式派生（convert-formats.sh）**：
- 60fps MP4：默认 `fps=60` 帧复制（兼容稳）；`--minterpolate` 才用运动补偿插帧（`mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`，对 transform 动画好、fade 易 ghosting、macOS QuickTime 有兼容 bug）；
- GIF：**15fps、960 宽（lanczos 缩放）、两阶段调色板**——先 `palettegen=stats_mode=diff` 生成全片最优 palette，再 `paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle` 编码（rectangle diff 只更新变化区域，30s/1080p ≈ <4MB）。

**动画页面约定**（确定性三件套）：`window.__ready`（首帧就绪置位）、`window.__recording`（录制时禁 loop）、`window.__seek(t)`（冻结时钟，任意 t 直接呈现该时刻状态）。导出前 checklist：第 0 帧是完整初始状态、末帧稳定收尾、结尾 fadeOut=0、duration 参数与实际时长一致。

**声音**：默认 BGM+SFX 双轨（BGM 按 mood 选 6 首场景曲，SFX 37 个预制音效按 cue 清单打点；`ffprobe -select_streams a` 验证有音轨）。

### 2.6 打磨环与验证

- polish.py shot：按视口高把整页切成原尺寸截图（--mobile 加 390x844），逐屏统计图形数/字数/最大字号/blank_ratio（≥0.93 且无图形=接近空屏），存 polish/<页>/round-N/，追加 polish-log.md（每轮写「最伤的三处」）。
- verify.py：多视口截图＋console/pageerror 收集，JS 异常退出码 1。
- 交付前固定动作：`polish.py shot` → `design_lint.py check` → `design_lint.py ledger add` → `learn.py harvest`。

## 3. 三栏结论

### 直接移植（机制/参数可直接用于我们）

1. **逐帧 seek 渲染契约**：`__ready` / `__recording` / `__seek(t)` 三件套＋「seek 后等 2 个 rAF 再截图」——直接作为我们 M3 动效管线的页面协议（PoC-A 按此实现）。
2. **FFmpeg 合成参数**：libx264 crf18 preset medium +faststart；GIF 两阶段 palette（palettegen stats_mode=diff → paletteuse bayer bayer_scale=5 diff_mode=rectangle）+ 15fps + 降宽——直接用于 PoC-A 与 M3。
3. **小红书规格与切图体检**：1242×1660、字号底线（42/32、封面 100px）、跨缝检测、字压字检测、`data-overlap-ok` 豁免机制——直接作为我们 M1 图文体检规则。
4. **可读性底线表**：网页 14/12、deck 24/16、1080 宽长图 36/28、对比度 4.5:1——直接进我们的设计规范。
5. **体检红灯清单**：裂图、console error、字号、对比度——直接进 M1 出图服务的校验器。

### 改造移植（学思想，按我们场景改）

1. **三方向门**：我们改为「6 缩略图 → 3 候选 → 用户选」可简化为 M1 的「一次出 3 版候选」交互；方向卡 6 栏改造成我们模板 JSON 的 `design_intent` 字段。
2. **风格条目字段**（温度/还原度/视觉 DNA/HTML 实现/字体/样张）：改造成我们「模板 JSON Schema」的核心字段；温度体系（大胆/中性/安静）用于保证候选多样性。
3. **色彩推导协议**（采样→收敛→论证＋oklch 约束）：改造成我们模板生成时的调色板约束（从用户品牌色/内容主图采样，禁止写死网红色）。
4. **外观指纹 compare/ledger**（OKLCH bg_class + mediancut 色板 + 32×20 边缘骨架）：改造为「同一次任务 3 版候选相似度过高时自动重试」与「账号外观账本」（避免连续发布视觉雷同）。
5. **打磨环**（截图→找最伤三处→改→再截）：改造为出图后的自动自检轮次＋人工确认入口。
6. **Stage/Sprite + useTime 的时钟抽象**：我们不必引入 React，但 M3 动效页应采用「单一时间源 t 驱动一切插值」的写法，天然支持 seek。

### 不适用（记录原因，避免照搬）

1. **多 agent 工作室隐喻、Gate 文件流程**：为「无人值守的 coding agent」设计，重流程；我们是产品化工具，流程应固化为任务状态机而非要求用户维护 gate 文件。
2. **秒数轮盘/最佳设计师/现实参照三套逻辑**：依赖 agent 的设计知识与 WebSearch；我们的候选生成走「模板库×参数空间」，保留「多样性约束」思想即可。
3. **react-setup / Tweaks 实时调参**：面向交互原型；我们的产出是静态图/视频，不需要运行时 Tweaks 面板。
4. **BGM/SFX 库与配音管线**：M3 后期再评估，M0 不引入音频依赖。
5. **水印（Created by Huashu-Design）**：不适用；我们的署名策略按产品定义。
6. **AI 生图风格分区**：我们 M1 先做 HTML 原生出图（还原度可控、可模板化），生图风格不做。

## 4. 对 M1/M3 的直接输入

- **模板 JSON Schema 草案字段来源**：风格条目 8 字段（名称/温度/还原度/参考/适配/视觉DNA/实现要点/字体）＋ spec 的「输出格式与尺寸必填」＋ 方向卡 6 栏 → 详见 M1-DESIGN-INPUT.md。
- **体检规则清单来源**：design_lint 红黄灯 ＋ xhs_render ✗/! 全套阈值（见 2.3/2.4），按我们画布换算字号底线。
- **M3 管线参数来源**：render-video-seek.js 的 seek 契约与 ffmpeg 参数（见 2.5）——PoC-A 直接验证。
