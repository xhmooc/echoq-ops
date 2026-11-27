# M3 动效与图文转视频 · 详细设计

> 版本：v1.0 · 2026-11-25
> 状态：待评审（评审通过后开工，目标版本 0.3.0）
> 上位规划：docs/UPGRADE-PLAN.md 第 3 章 M3；验证方案：docs/M3-MOTION-VIDEO-TESTPLAN.md

---

## 1. 目标与范围

**目标**：把已就绪的「封面 6 秒循环动图」管线升级为完整的动效与图文转视频能力，全程本地生成（HTML/CSS/JS + Chromium 逐帧 + FFmpeg 合成），零 API 成本。

**本期范围**：

| # | 能力 | 说明 |
| --- | --- | --- |
| 3.1 | 动效范式库与参数化 | 5 种动效范式，时长/画幅/配色参数化，随配图风格自动匹配 |
| 3.2 | 渲染管线产品化 | captureFrames 泛化（可变时长/画幅/帧率），统一动效渲染入口 |
| 3.3 | 多画幅输出 | 3:4、1:1、16:9、2.35:1 同一动效按画幅重排，文字不裁切 |
| 3.4 | 实拍混合图 | 用户实拍图 + 模板贴纸/文字/边框 Canvas 合成出图 |
| 3.5 | 图组转视频 | 已生成图组 + 字幕 + 配乐 → 竖版 MP4 |
| 3.6 | 内置配乐 | 3~5 条免版权短 loop，ffmpeg 混音，可关闭 |

**非目标（边界，延续 UPGRADE-PLAN 风险约束）**：不做 AI 生视频、不做口播/TTS、不做剪辑时间线、不做转场特效库堆砌。

---

## 2. 现状基线（已核实，2026-11-25）

| 事实 | 位置 |
| --- | --- |
| `renderMotion(draft)` 已实现：按草稿配图风格匹配 sketch/v2/paper 三套动效 HTML | desktop/src/render/cards.ts:463 |
| 动效范式仅一种：元素错峰淡入 + 上移 26px + 底部进度条（t/6） | templates.ts:848、v2templates.ts:400、sketch.ts:512 |
| `__seek(t)` 确定性契约：画面是 t 的纯函数（`__ready/__recording/__seek`） | templates.ts:844 |
| 逐帧渲染：Electron 隐藏共享窗口一次加载，逐 t 执行 `__seek` → 双 rAF → capturePage | renderer.ts:276 captureFrames |
| 合成：ffmpeg 系统(PATH)调用——GIF `fps=15,scale=540:-2,lanczos,palettegen/paletteuse(bayer)`；MP4 `scale=810:1080,libx264,yuv420p,crf18,faststart` | cards.ts:533 encodeMotion |
| 画幅/时长/帧率硬编码：1080×1440 竖版、25fps × 6s = 151 帧 | cards.ts:112、676 |
| API：`POST /api/drafts/:id/motion`，无业务入参 | routes.ts:904 |
| 落盘：`%LOCALAPPDATA%\EchoQ-Ops\data\assets\draft-{id}\motion\{loop.gif,motion.mp4,01-cover-still.png}` | cards.ts:176 writeAsset |
| 失败回退：任一步失败 → 静态首帧 + `note` 原因；再失败沿用原配图第一张 | cards.ts:504 |
| 前端：`generateMotion()`（app.js:4121，按钮 #btn-motion），成功后 GIF 置配图首位 | app.js:4140 |
| 仓库另有 promo-video/ 宣传片管线（Playwright+ffmpeg，BGM -14 LUFS），未接入桌面端 | promo-video/ |
| ffmpeg 依赖系统 PATH，安装包未内置 | cards.ts:540 |

**结论**：管线骨架（确定性逐帧 + 隐藏窗口 + ffmpeg 合成 + 回退）已验证可用；M3 的工作是把「单一硬编码动效」扩展为「参数化范式库 + 多画幅 + 两类新产物（混合图、图组视频）」。

---

## 3. 总体架构

```
前端（创作台）
  ├─ 动效面板：范式选择 / 时长 / 画幅 / 配乐开关
  ├─ 「生成 6 秒动图」→ POST /api/drafts/:id/motion   （扩参）
  └─ 「图组转视频」→ POST /api/drafts/:id/slideshow   （新增）
        │
服务层（desktop/src/render/motion.ts —— 新模块，承接 cards.ts 中动效职责）
  ├─ MotionTemplate 注册表：5 范式 × 参数校验
  ├─ buildMotionHTML(template, draft, options) → 完整 HTML（含 __seek）
  ├─ renderSlideshow(draft, options) → 图组视频 HTML（轮播 + 字幕时间轴）
  └─ encodeMotion / encodeSlideshow → ffmpeg 子进程
        │
渲染层（renderer.ts）
  └─ captureFrames(html, {w,h,fps,duration}) —— 泛化：窗口尺寸按画幅设置
        │
合成层（ffmpeg 子进程，串行队列）
  ├─ GIF：palettegen/paletteuse（现状保留）
  ├─ MP4：libx264 crf18 faststart（画幅可变）
  └─ 混音：-i video -i bgm -filter_complex amix + loudnorm
```

**职责调整**：动效相关代码从 cards.ts 拆到独立 `render/motion.ts`（cards.ts 保留薄转发，避免破坏既有引用）；ffmpeg 调用统一收口到 `render/ffmpeg.ts`（探测 PATH、缺失时给出明确 note 而非静默回退）。

---

## 4. 动效范式库（3.1）

### 4.1 MotionTemplate 接口

```ts
interface MotionTemplate {
  key: string;                    // "fade-seq" | "type-in" | "kenburns" | "sketch-grow" | "pop-sticker"
  name: string;                   // 中文名（前端展示）
  canvases: CanvasKey[];          // 支持的画幅，如 ["portrait","square","wide","landscape"]
  defaultDuration: 4 | 6 | 8;     // 秒
  build(ctx: MotionContext): string;  // 返回含 __seek 的完整 HTML
}
interface MotionContext {
  title: string; subtitle: string;
  palette: { bg: string; fg: string; accent: string };
  duration: number; fps: number;
  canvas: { w: number; h: number };
  seed: number;                   // 复用 mulberry32 确定性随机
  image?: string;                 // kenburns/混合图用的底图路径
}
```

### 4.2 首批 5 个范式

| key | 范式 | 效果 | 适用 |
| --- | --- | --- | --- |
| `fade-seq` | 错峰入场（现范式参数化） | 元素逐个淡入 + 上移 + 进度条收尾 | 全风格默认 |
| `type-in` | 文字逐字浮现 | 标题按字符 stagger 显现，末帧定格 | 大字公告/知识卡片 |
| `kenburns` | 图片缓推 | 底图缓慢缩放 + 平移（scale 1.0→1.08），文字面板淡入 | 实拍混合图/图注解读 |
| `sketch-grow` | 手绘生长 | 复用手绘引擎绘制顺序，笔画分批显现（按 sketch.ts 元素序） | 手绘插画 |
| `pop-sticker` | 贴纸弹跳 | 贴纸元素 spring 缩放入场 + 角标抖动 | 节日/剪纸/营销 |

### 4.3 参数化与默认值

- `POST /api/drafts/:id/motion` 扩参：`{ template?: string, duration?: 4|6|8, canvas?: "portrait"|"square"|"wide"|"landscape", bgm?: string|"none" }`，缺省行为与现状完全一致（fade-seq / 6s / portrait / 无配乐）——**老入口零破坏**；
- 参数校验白名单，非法值 400 带原因；
- 动效主题色跟随草稿当前配图调色板（V2 palette / 手绘纸色 / 自定义模板主色 extractTemplateColors）。

---

## 5. 多画幅适配（3.3）

| 画幅 key | 尺寸 | 对应场景 |
| --- | --- | --- |
| portrait | 1080×1440 | 小红书/抖音图文（现状） |
| square | 1080×1080 | 公众号方图 |
| wide | 1080×460 | 公众号头图 2.35:1 |
| landscape | 1920×1080 | 16:9 通用（新增，视频封面/横版场景） |

- 画幅档案并入 `render/kit.ts` platformCanvasList 同源维护（新增 landscape 常量），避免第三处硬编码；
- 构图重排规则：文字区按画幅安全边距比例定位（复用 V2 的比例化 + `max()` 锚定做法）；wide/landscape 下主标题居中单行、要点改横排两组；
- 体检扩展：动效**首帧与末帧**各跑一次 `checkBlocks`（探针已支持 `.cu-*` 等类名），errors 拦截出图、warnings 告警——与静态图同标准。

---

## 6. 渲染管线产品化（3.2）

- `captureFrames` 泛化签名：`captureFrames(html, { width, height, fps, duration, onFrame? })`，窗口按画幅 `setContentSize`；
- 帧序号为确定值：`frames = duration * fps + 1`，时间轴 `t = i / fps`；禁止读时钟（延续手绘引擎约束）；
- 渲染走现有全局串行队列（enqueueRender），动效与静态出图互不抢占；
- 临时帧目录 `data/tmp/motion-{pid}-{ts}/`，合成后即删（现状保留）；
- **ffmpeg 内置**：打包时随 extraResources 附带 win64 ffmpeg.exe（约 80MB 静态版），运行时优先取安装目录，回落 PATH；两处都没有 → 动图/视频入口给出明确提示文案（不再静默退化为静态图），静态图不受影响。

---

## 7. 实拍混合图（3.4）

- 输入：用户在创作台上传的实拍图（走现有上传校验：文件头白名单 PNG/JPEG/WEBP/GIF）；
- 合成：HTML Canvas 页面——底图按画幅 cover 裁切 + 可选滤镜（无/胶片/黑白）+ 模板贴纸层（角标、边框、日期章）+ 标题文字层（复用 clampTitle 压缩）；
- 产物归入配图列表（用途标记「混合图」），参与体检与发布；不逐帧渲染，单帧截图，成本与静态图相同；
- 参数：`POST /api/drafts/:id/composite { image: <上传返回的相对路径>, template: "border-sticker"|"date-card"|"clean-frame", canvas, filter }`；
- 落盘 `assets/draft-{id}/composite/`。

---

## 8. 图组转视频（3.5）

**输入**：草稿当前配图（≤10 张，按平台分组取一组）+ 字幕文本（缺省用标题+摘要分句）+ 可选配乐。

**实现**：复用同一条确定性管线——生成一个「轮播播放器」HTML：

- 每张图一个场景：淡入停留淡出（可配 crossfade/滑动两种转场，默认 crossfade）；
- 每图时长 2.5s，总时长 = 张数 × 2.5s（10 张 = 25s）；
- 字幕时间轴：分句均分到各场景，底部安全区条带呈现（抖音底部 520px 禁区规则沿用）；
- `__seek(t)` 驱动：场景索引与插值全部为 t 的纯函数；
- 逐帧 25fps 渲染 → ffmpeg 合成 MP4（1080×1920 竖版，画幅可随 canvas 参数切换）→ 可选混音。

**API**：`POST /api/drafts/:id/slideshow { transition?: "crossfade"|"slide", bgm?: string|"none", canvas?: "portrait" }` → `{ mp4, duration, frames, note }`。

**性能预算**：25s × 25fps = 626 帧。按现有 151 帧动效实测耗时线性外推，预计 3~6 分钟。两个降档开关：`fps=15`（376 帧）与 `duration=2s/张`（500 帧）；文档验收指标按实测校准（UPGRADE-PLAN 原「≤30s」指合成阶段，不指逐帧渲染，见 TESTPLAN 第 6 节说明）。

---

## 9. 内置配乐（3.6）

- 内置 3~5 条免版权短 loop（自研代码合成，参考 anidoodle 作曲思路；每条 ≤100KB），随安装包 `extraResources/bgm/` 分发；
- 混音：`ffmpeg -i video -i bgm -filter_complex "[1:a]volume=0.25[b];[0:a][b]amix=duration=first,loudnorm=I=-14:TP=-1.5"`（对齐 promo-video/mix_audio.py 已验证参数）；
- `bgm:"none"` 或缺省不混音；配乐清单 `GET /api/motion/bgm` 供前端下拉。

---

## 10. 数据与落盘

| 产物 | 路径 |
| --- | --- |
| 动图 | `assets/draft-{id}/motion/{loop.gif, motion.mp4, meta.json}` |
| 图组视频 | `assets/draft-{id}/slideshow/{slideshow.mp4, meta.json}` |
| 混合图 | `assets/draft-{id}/composite/{01-composite.png, meta.json}` |

`meta.json` 统一记录：`{ template, duration, fps, canvas, seed, bgm, created_at, generator: "m3" }`——重渲染可复现（同参数同 seed 同输出），也是后续排查的现场。

---

## 11. 前端改动点（ops/web/static）

- 创作台「生成 6 秒动图」按钮旁新增动效设置行（范式 / 时长 / 画幅 / 配乐，默认值即现状）；
- 新增「图组转视频」按钮（有 ≥2 张配图时可用），进度提示复用现有按钮 loading 态；
- 实拍混合图入口挂在「添加图片」旁（选本地图 → 选模板 → 合成）；
- 产物进媒体区沿用现有角标体系（动图/视频/混合图）。

---

## 12. 任务拆解与实施顺序

| 工单 | 内容 | 依赖 |
| --- | --- | --- |
| M3-a | motion.ts / ffmpeg.ts 拆分重构 + captureFrames 泛化 + API 扩参（行为不变） | 无 |
| M3-b | 范式库：type-in、kenburns、pop-sticker（fade-seq 参数化、sketch-grow 依赖手绘元素序） | M3-a |
| M3-c | 多画幅（kit.ts 画幅档案 + 构图重排 + 首末帧体检） | M3-a |
| M3-d | ffmpeg 内置打包 + 缺失明确提示 | M3-a |
| M3-e | 实拍混合图（上传 → Canvas 合成 → 配图列表） | M3-a |
| M3-f | 图组转视频（轮播 HTML + 字幕时间轴 + slideshow API） | M3-a、M3-c |
| M3-g | 配乐内置 + 混音 + bgm 清单 API | M3-f |
| M3-h | 前端面板与按钮 + 文档（CHANGELOG/README 截图）+ 打包 0.3.0 | M3-b~g |

**验收（对齐 UPGRADE-PLAN 第 3 章 M3）**：6 秒循环动效在 3:4 / 1:1 / 16:9（含 2.35:1 头图）均无文字裁切、循环点无跳变；GIF < 5MB、MP4 1080p；图组转视频 10 张内可完成（逐帧耗时按 TESTPLAN 实测校准）；同参数重渲染逐帧一致。

---

## 13. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 用户机器无 ffmpeg，动图静默变静态 | M3-d 内置 ffmpeg；两处皆无时入口给出明确提示 |
| 逐帧渲染耗时长（图组视频 600+ 帧） | 串行队列 + fps/时长降档开关 + 前端进度提示；不做并发多窗口（渲染窗口复用约束） |
| 动效文字越界/裁切 | 首末帧双探针体检，errors 拦截；wide/landscape 单行标题约束 |
| GIF 体积超标 | 保持 palette 两阶段 + 540 宽；超标自动降 12fps 重试一次 |
| 手绘生长范式依赖元素绘制顺序元数据 | sketch.ts 输出补充顺序信息（若实现成本高，sketch-grow 降级为 fade-seq，不阻塞 M3） |
| 范围蔓延（转场库/剪辑/AI 视频） | 严格锁定第 1 节非目标清单 |
