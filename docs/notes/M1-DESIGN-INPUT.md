# M1 设计输入：模板 JSON Schema 草案 + 体检规则清单

> 来源：huashu-design / anidoodle / baoyu-skills 三份学习笔记（见同目录 2026-11-*.md）＋ PoC-A/B 实测。
> 用途：M1「出图 2.0」模板系统与体检器的实现依据。风格取向＝实用信息流（知识卡片/步骤清单/数据信息图/对比测评/大字公告/图注解读）。

## 1. 模板 JSON Schema 草案（v0.1）

一个「模板」= 风格配方 + 版式约束 + 色板 + 适配声明。字段来源：huashu 风格条目 8 字段、baoyu preset YAML、anidoodle 配方头（MEDIUM/MARKS/ORDER/PALETTE/LIGHT/NOT-ITS-NEIGHBOUR）。

```jsonc
{
  "$schema": "echoq/template/0.1",
  "id": "knowledge-card-v1",            // 模板唯一 ID
  "name": "知识卡片 · 实用信息流",
  "version": "0.1.0",

  // —— 风格声明（源自 huashu 风格条目） ——
  "style": {
    "temperature": "calm",               // bold | neutral | calm —— 保证 3 版候选多样性的轴
    "fidelity": "high",                  // 纯 HTML/CSS 可达还原度：high(>=90%) | medium | degraded(需标注)
    "reference": "notion 风知识卡 / 无印良品手册",
    "visual_dna": "大标题+编号要点+细横线分隔；留白 40-50%；圆角 16px；无渐变无阴影堆叠",
    "not_neighbour": "与『大字公告』的分辨点：有编号要点层级，而非单句超大字"   // 源自 anidoodle NOT-ITS-NEIGHBOUR
  },

  // —— 画布与版式（源自 baoyu canvas.md + huashu xiaohongshu.md） ——
  "canvas": {
    "ratios": {
      "xhs": [1242, 1660],              // 3:4 主力，跨平台复用（抖音/小绿书/微博/B站同吃）
      "square": [1242, 1242],
      "wx_cover": [900, 383],            // 公众号头条封面 2.35:1
      "wx_cover_sub": [500, 500],        // 公众号次条封面 1:1
      "channels_vertical": [1080, 1260]  // 视频号图片动态竖屏
    },
    "default_ratio": "xhs",
    // GIF 文件仅 3 个通道支持：公众号正文 / 微博 / B站动态；小红书、抖音图文不收 GIF 文件，但支持「实况照片」（Live Photo）动图（详见第 3 节矩阵）。
    // 动效产物分发策略：GIF → 微博/B站/公众号正文；实况照片 → 小红书/抖音图文；MP4 → 视频位。
    "safe_zones": { "bottom_pct": 10, "corners": ["top-right", "bottom-right"] },
    "grid": "single | dual | triptych | quad | six-grid"
  },
  "layout": {
    "kind": "list",                      // sparse | balanced | dense | list | comparison | flow | mindmap | quadrant
    "density": { "whitespace_pct": [40, 50], "points_per_image": [3, 4] },
    "by_position": { "cover": "sparse", "core": "list", "ending": "sparse" }  // 源自 baoyu 按位置选版式
  },

  // —— 色板（角色制，源自 baoyu preset + huashu 色彩推导协议） ——
  "palette": {
    "primary": "#1A1A1A",                // 文字主色
    "background": "#FAF6EF",             // 底色（低饱和：chroma 0.01-0.04）
    "accent": "#E8590C",                 // 点睛色（chroma 0.15-0.22）
    "accents_extra": ["#A8D4F0", "#F9E79F"],
    "provenance": "sampled",             // sampled(从品牌/内容采样) | preset；禁止无出处网红色
    "oklch_constraints": { "bg_chroma_max": 0.04, "accent_chroma": [0.08, 0.22], "min_hue_gap": 60 }
  },

  // —— 字体（display+body 配对，只给可授权/开源字体） ——
  "typography": {
    "display": { "family": "Source Han Sans CN", "weight": 800 },
    "body": { "family": "Source Han Sans CN", "weight": 400 },
    "min_sizes_px": { "cover_title": 100, "body": 42, "label": 32 }  // 1242 宽基准，源自 xhs_render 底线
  },

  // —— 内容拆卡（源自 baoyu 五幕结构） ——
  "content_model": {
    "acts": ["cover", "setup", "core", "payoff", "ending"],
    "card_count": { "min": 2, "max": 10, "recommended": [4, 6] },
    "cover_rule": "10-30 字标题 + 1-2 关键视觉，不放副标题",
    "per_card": "一卡一完整想法，不超过 dense 的 5-8 点"
  },

  // —— 一致性与可复现（源自 baoyu image-1 锚点链 + PoC-A/B 实测） ——
  "render": {
    "engine": "html-screenshot",         // HTML→Playwright 截图，非 AI 生图
    "seed": 42,                          // 插画/装饰随机源 mulberry32(seed)，同 seed 同像素
    "anchor": "cover-first",             // 先出封面定版，其余卡复用同套 token
    "motion_contract": ["__ready", "__recording", "__seek(t)"],  // M3 动效页契约
    "motion_outputs": ["gif", "mp4", "live_photo"]  // live_photo = 短循环 MP4 + 封面帧（小红书/抖音实况照片通道，见 make-live.mjs）
  },

  // —— 适配声明（源自 baoyu best-for + huashu 适配字段） ——
  "best_for": ["知识分享", "步骤教程", "清单盘点", "概念解释"],
  "layout_affinity": { "list": "✓✓", "dense": "✓✓", "comparison": "✓", "flow": "✓", "sparse": "✗" }
}
```

### 候选生成规则（M1 交互：一次 3 版）

简化自 huashu 三方向门（6 缩略图→3 候选）：同一内容 → 选 3 个**不同 temperature（bold/neutral/calm）× 不同 layout** 的模板各出一版；3 版做指纹比对（见下），过相似再交用户选。

## 2. 体检规则清单（M1 出图校验器）

### 2.1 红灯（必须修复，否则不出图）

| # | 规则 | 阈值/判定 | 来源 |
| --- | --- | --- | --- |
| R1 | 图片裂图 | img naturalWidth==0 / onerror | design_lint |
| R2 | 页面 JS 异常 | console error / pageerror | design_lint / verify.py |
| R3 | 正文字号 | <42px@1242 宽（≥16 字段落）；按画布宽线性换算 | xhs_render |
| R4 | 标签字号 | <32px@1242 宽，且 ≥3 处判红灯 | xhs_render + design_lint |
| R5 | 封面标题 | <100px 或超 2 行 | xiaohongshu.md |
| R6 | 文字出界 | 文字框越出画布 ±2px | xhs_render |
| R7 | 跨缝压字 | 文字行框越过切张缝（±4px） | xhs_render |
| R8 | 字压字 | 两文字框上下收 20%、左右收 2px 后相交（`data-overlap-ok` 豁免） | xhs_render |
| R9 | 对比度 | <4.5:1（大字 24px/18.66px 粗体按 3:1；半透明先混底色再算） | design_lint |
| R10 | 文字被盖 | 每行左/中/右三点 elementFromPoint 非自身 | xhs_render |

### 2.2 黄灯（模板装饰/风格警示，删或改）

| # | 规则 | 来源 |
| --- | --- | --- |
| Y1 | 全大写+字距≥0.06em+≤15px 小标签 ≥3 处 | design_lint |
| Y2 | 「A·B·C」中点连接 ≥2 / 「X — y」标签 / 尾巴「→」≥2 | design_lint |
| Y3 | 等宽小字 ≥4 处 | design_lint |
| Y4 | 标题只换色/斜体且字数 ≤40% | design_lint |
| Y5 | 非序列内容用 01/02 编号 ≥3 | design_lint |
| Y6 | 标题字体是 Inter/Roboto/Arial/system-ui | design_lint |
| Y7 | 文字碰无字纯色小色块（最长边<120px） | xhs_render |
| Y8 | 占位格：[data-thumb] 字<6 / 元素<6 / 底色>90% | polish.py thumbs |

### 2.3 一致性/多样性指纹（同批 3 版互比）

| # | 规则 | 阈值 | 来源 |
| --- | --- | --- | --- |
| F1 | 色板指纹 | 整页截图 mediancut 6 色，OKLab 对称最近邻距离 <0.06 判「撞」 | design_lint |
| F2 | 骨架指纹 | 整页缩 32×20 → FIND_EDGES → z 归一化，相关 >0.55 判「撞」 | design_lint |
| F3 | 背景分类 | OKLCH 6 类（L>0.9 浅 / H40-110 暖纸 / L<0.28 深）同类似也记撞 | design_lint |
| F4 | 账本比对 | 与该账号最近 8 次产出比指纹，全撞则要求换模板 | design_lint ledger |

### 2.4 动效/视频体检（M3，PoC-A 已验证可行性）

| # | 规则 | 阈值 | 来源 |
| --- | --- | --- | --- |
| M1 | 循环无缝 | t=0 与 t=duration 帧逐字节一致 | PoC-A 实测 |
| M2 | 渲染确定性 | 同 t 渲染两遍逐字节一致 | PoC-A 实测 |
| M3 | 文字停留 | 每段 ≥ max(0.7s, 0.3s/词) | anidoodle framecheck |
| M4 | 单帧文字块 | ≤7 块、不跨卡片边、9:16 安全区（上 14%/下 25%/右 14%） | anidoodle framecheck |
| M5 | 管线时效 | 端到端 ≤60s（6s×25fps 实测 32.5s；60fps 需并发分帧） | PoC-A 实测 |
| M6 | 实况照片档位 | 素材 1.5-3s；ping-pong 无缝循环；封面帧 = t0 帧 | 实况照片通道（小红书/抖音），PoC-A make-live 实测 |

## 3. 平台图文规格矩阵（2025-11 调研）

| 平台 / 形态 | 推荐比例与像素 | 张数上限 | 动图支持 | 备注 |
| --- | --- | --- | --- | --- |
| 小红书 · 图片笔记 | **3:4 首推 1242×1656**；兼容 1:1（1080×1080）、4:3 | 18 张（建议 6-9） | ✗ GIF 文件；✓ 实况照片 | 单篇需同一比例；单张≤32MB；PNG/JPG/WEBP；实况照片按图片张数计 |
| 公众号 · 封面图 | 头条 2.35:1（900×383）；次条 1:1（200×200，常用 500×500） | 1 张 | —（封面用静态） | 缩略图只显示中间约 383×383，主体必须居中 |
| 公众号 · 正文配图 | 宽 900px | 多张 | ✓ 支持，单张≤10MB；经验值 长×宽×帧数≤600 万、≤30 帧 | 超限 GIF 会被压成静态图 |
| 公众号 · 图片消息（小绿书） | 3:4 横滑 | 3-9 张（社区经验） | ✗ | 封面裁剪支持 1:1 / 16:9 / 2.35:1 |
| 抖音 · 图文 | 3:4 首推，兼容 4:3；不建议超 1:2 | 35 张（网页版）/ 30 张（API） | ✗ GIF 文件；✓ 实况照片 | 单张≤50MB（API 20MB） |
| 微博 · 普通微博 | 无强制；通行 1:1、3:4、16:9 | 9 张 | ✓ 支持，单张≤20MB、原始宽≤1080 | 信息流自动循环播放；超宽可能被转成静态图 |
| B 站 · 动态图 | 无强制；常用 1:1、3:4 | 9 张 | ✓ 支持 | 支持 jpg/png/gif |
| 视频号 · 图片动态 | 竖屏 1080×1260；横屏 1080×608 | 9 张 | ✗ GIF 按静态处理（社区经验） | 超出比例会被裁切 |

**分发结论**：

- **3:4 竖版是跨平台最大公约数**：一张 1242×1656 可复用于小红书 / 抖音 / 小绿书 / 微博 / B站；公众号封面是最大差异项（2.35:1 + 1:1），需单独出图；视频号竖屏 1080×1260 单独适配。
- **GIF 文件仅 3 个通道支持**：公众号正文、微博、B站动态；小红书与抖音图文不收 GIF 文件，但支持**实况照片（Live Photo）**——静态封面帧 + 约 1.5-3s 动态，按图片张数发布，是这两平台的正确动图通道。
- M3 动效管线（PoC-A）产物按此分发：**GIF → 微博 / B站 / 公众号正文；实况照片（短循环 MP4 + 封面帧）→ 小红书 / 抖音图文；MP4 → 视频位**。

### 画布内部规格（出图用，与上表平台限制独立）

- 小红书 3:4：**1242×1660**（精确 3:4 用 1080×1440，字号按 1242/1080 比例换算）；1:1=1242×1242；2:3=1242×1863。
- 安全区：底部 10%、右上角、右下角。
- 密度：sparse 留白 60-70%/1-2 点；balanced 40-50%/3-4 点；dense 20-30%/5-8 点。
- 张数：2-3（轻分享）/ 4-6（标准）/ 7-10（深度）；>18 张拒绝。
- 长卷切张：`xhs-strip` 总宽 = 1242×N，`round(宽/1242)` 切张，切后逐张体检。
