# 学习笔记：baoyu-skills（卡片 C）

> 仓库：https://github.com/JimLiu/baoyu-skills （MIT）
> 本地：`D:\Projects\reference\baoyu-skills`
> 精读范围：skills/baoyu-xhs-images（SKILL.md、references/style-layout-matrix.md、elements/canvas.md、presets/notion.md）、skills/baoyu-markdown-to-html/SKILL.md、skills/baoyu-post-to-wechat/SKILL.md
> 日期：2026-11-24

## 1. 体系总览

baoyu-skills 是「内容 → 小红书图文 / 公众号文章」的技能集，与 huashu-design 最大差异：**小红书图卡走 AI 生图（prompt 组装），不走 HTML 渲染**；公众号侧则是成熟稳定的工程链路（Bun/TS 脚本 + 内联 CSS + Chrome CDP）。对我们最有价值的是它的**内容组织数据结构**：风格×版式矩阵、预设 YAML、拆卡逻辑、自动选型表。

## 2. 关键机制精读

### 2.1 风格×版式×色板矩阵

- 维度：**12 styles × 8 layouts × 3 palettes**；另有 **26 个 preset**（风格+版式的速记组合，如 notion-list、bold-announcement、fresh-tips、chalkboard-steps…）。
- **8 种版式**：sparse（封面/金句，60-70% 留白，1-2 个信息点）/ balanced（常规讲解，40-50%，3-4 点）/ dense（知识卡、cheat sheet，20-30%，5-8 点）/ list（4-7 项竖排清单）/ comparison（左右对比 2 区）/ flow（3-6 步流程，节点+箭头）/ mindmap（中心辐射 4-8 支）/ quadrant（2×2 四象限）。
- **12 种风格**分 4 组：minimal（notion 极简手绘线稿）、hand-drawn（sketch-notes/study-notes/cute）、bold（pop/retro/screen-print）、warm&fresh（warm/fresh/chalkboard）。
- **preset 的 YAML 结构**（每个 preset 一份 md，frontmatter 含 name/category）：

```yaml
canvas:        { ratio: portrait-3-4, grid: single|dual }
image_effects: { cutout: clean, stroke: none|white-solid, filter: none|muted-tones }
typography:    { decorated: none|handwritten, tags: black-white|pill, direction: horizontal }
decorations:   { emphasis: circle-mark|underline, background: solid-white|paper-texture,
                 doodles: hand-drawn-lines|arrows-curvy, frames: none|rounded-rect }
```

外加：色板表（Role/Hex：Primary/Background/Accents）、视觉元素要点、**Best Layout Pairings**（每种版式 ✓✓/✓/✗ + 适用场景）、Best For（内容类型）。

- **自动选型表**：内容特征信号 → 推荐组合。如「步骤/教程 → list × sketch-notes/study-notes」；「对比/评测 → comparison × bold-announcement」；「观点/金句 → sparse × chalkboard-quote」；「概念解释 → balanced × notion/minimal」。

### 2.2 内容拆卡逻辑（1~10 张）

- **五幕结构**：封面 cover（sparse：10-30 字标题+1-2 个关键视觉，**不放副标题**）→ 铺垫 setup（balanced，交代背景）→ 核心 core（balanced/dense/list/comparison/flow/mindmap/quadrant 按内容形态选）→ 收获 payoff（要点清单）→ 结尾 ending（sparse，一句 CTA）。
- 张数建议：简洁分享 2-3 张；标准知识卡 4-6 张；深度内容 7-10 张。每张承载 1 个完整想法，不超过 dense 的 5-8 点。
- 全组统一：同一 preset、同一色板、同一字体体系；相邻张换构图避免单调。

### 2.3 画布与安全区

- 3:4 = **1242×1660**（流量最好，推荐默认）；1:1 = 1242×1242；2:3 = 1242×1863。
- **安全区**：底部 10%（App 标题栏遮挡）、右上角（点赞/分享按钮）、右下角（水印位）不放关键内容。
- 多元素网格：single/dual/triptych/quad/six-grid/nine-grid。
- 视觉平衡规则：sparse=单一焦点居中对称；balanced=标题居上、内容均布、层级清晰；dense=网格化、分区边界清晰、紧凑但可读；list=左对齐+编号层级一致；comparison=左右对称+中缝分隔；flow=方向性连接；mindmap=中心节点+有机曲线；quadrant=轴标签清晰。

### 2.4 生图一致性与批量策略（AI 生图特有）

- **image-1 锚点链**：先生成封面（image-1），确认满意后，**把它作为后续每张的参考图**喂给生图模型，保证全组风格/人物/元素一致。
- prompt 文件 = 可复现记录：每次生成保存 prompt+参数，重生成时引用原 prompt。
- 批量策略：10 张以上分批（每批 2-3 张），批间看反馈再继续；删除/重编辑前先备份原图。

### 2.5 markdown → HTML（公众号链路）

- Bun/TS 实现，输出**内联 CSS 的 HTML**（公众号编辑器不吃外部样式/类名）。
- 特性：GFM + 代码高亮 + Mermaid（headless Chrome CDP 渲成 PNG，按 code+theme+scale+宽度 hash 缓存到 `imgs/.mermaid-cache/`）+ PlantUML + 脚注 + alerts + 注音 `{base|annotation}`。
- 主题 4 种（default/grace/simple/modern）× 13 个色板 preset（blue #0F4C81、green #009874、vermilion #FA5151…）＋ `--font-family/--font-size`；frontmatter 提供 title/author/summary。
- 细节亮点：**CJK 预检**（含中文时先问是否跑 baoyu-format-markdown 修正标点旁的 `**` 失效与中西文间距）；`--cite` 把普通外链转成文末「引用链接」（mp.weixin.qq.com 链接保留原位）；已有 HTML 先备份 `.bak-YYYYMMDDHHMMSS`；stdout 返回 JSON（htmlPath/backupPath/contentImages 占位符映射）。
- post-to-wechat：浏览器 CDP 与 API 双通道、多账号 EXTEND.md（account-level → global 的值优先级：CLI → frontmatter → EXTEND.md → 默认值）、图文最多 9 图、评论开关等草稿参数。

## 3. 三栏结论

### 直接移植

1. **画布与安全区规格**：3:4=1242×1660 默认；底部 10%/右上/右下安全区——直接进我们 M1 图文模板约束。
2. **8 种版式的密度定义**（sparse 60-70%/1-2 点、balanced 40-50%/3-4、dense 20-30%/5-8）与**按位置选版式**（封面 sparse、正文按内容形态、结尾 sparse）——直接进 M1 拆卡引擎规则。
3. **内容五幕结构**（cover/setup/core/payoff/ending）与张数建议——直接作为我们「内容拆卡」的默认骨架。
4. **色板 preset 表结构**（Role/Hex 分主色/背景/点缀）——直接进模板 JSON 的 palette 字段。

### 改造移植

1. **preset YAML schema**（canvas/image_effects/typography/decorations + best-layout-pairings + best-for）：这是最贴近我们「模板 JSON Schema」的现成参考，改造为我们 M1 模板卡的结构（见 M1-DESIGN-INPUT.md）；style×layout×palette 三维矩阵思想直接沿用。
2. **自动选型表**（内容信号→风格/版式）：改造为我们的「根据内容特征推荐模板」逻辑，从 LLM 判断改为规则+LLM 混合。
3. **image-1 锚点链思想**：生图改 HTML 渲染后，等价物是「先出封面定版（字体/色板/装饰母题），其余卡片复用同一套 token」——进 M1 的一致性策略。
4. **markdown→HTML 内联样式链路**：M2 公众号渲染直接参考其内联 CSS 方案、CJK 预检、外链转底部引用、mermaid 缓存；post-to-wechat 的多账号/值优先级设计供 M2 发布模块参考。
5. **prompt 文件可复现记录 + 批量分批策略**：改造为我们的「出图任务快照」（模板+参数+种子+版本），保证可重跑；批量发布同样分批带反馈。

### 不适用

1. **AI 生图渲染路径本身**：我们 M1 走 HTML→截图渲染（可控、可模板化、文字必然清晰、无版权风险），不采用 prompt 生图；仅吸收其内容组织与一致性思想。
2. **image_effects 的 cutout/stroke/filter**：依赖生图模型的图像理解；HTML 渲染下用 CSS 实现等价效果（描边、滤镜）。
3. **微信公众号 CDP/API 发布细节**：M2 才需要，M0 不展开。
4. **baoyu-format-markdown 等周边技能**：按需在 M2 引入。
