# 学习笔记：anidoodle（卡片 B）

> 仓库：https://github.com/alexgreensh/anidoodle （Apache-2.0）
> 本地：`D:\Projects\reference\anidoodle`
> 精读范围：skills/anidoodle/SKILL.md、references/{determinism-and-contract,formats,drawing-process}.md、references/styles/INDEX.md、engine/src/canvas-core/{core,flatVector}.ts
> 日期：2026-11-24

## 1. 体系总览

anidoodle 是「完全用代码作画」的技能库：32 种手绘/版画/向量风格，静止图、循环、影片、3D、讲解动画、教学。核心信条（七律）中最可移植的是：

1. **每个作品有一个重点**（一张图=一个想法一个焦点一个光源）。
2. **风格是「做笔触的方式」**：换媒介、换边缘、换落笔顺序，而不是换配色。
3. **先在一张静帧上证明观感，再端到端搭建**（先最难的一帧，书面自评，一次批准）。
4. **契约绝对**：`renderFrame(frame, env)` 纯函数；随机只来自 `rng(seed)`；禁 `Math.random`/`Date`/`ctx.filter`。
5. **音乐要有计划，不是形容词**（我们暂不涉及音频）。

架构：`engine/src/canvas-core`（无 DOM 的可移植画芯）→ 四后端适配（浏览器/CI/Remotion/离线）→ 工具链（scaffold/still/render/gate/emit/ship）。

## 2. 关键机制精读

### 2.1 「一笔一函数」原语层（core.ts）

- **契约**：`draw(ctx, frame, env)` 是 `(frame, env)` 的纯函数；帧间不携带状态、无模块级可变状态碰像素。`Env` 只提供 `W/H/scale/canvas()/cache`，画芯不知道 DOM。
- **PRNG**：`rng(seed)` 就是 mulberry32（`a += 0x6D2B79F5; t = imul(a^a>>>15, 1|a); t = t + imul(t^t>>>7, 61|t) ^ t; return (t^t>>>14)>>>0 / 2^32`）。同种子同像素。**多个独立流**：场景布局用 `rng(77)`，噪声表用 `seed*7919+13`，笔触 ribbon 用 `seed*31+7`——各子系统用不同的种子派生，避免同流扰动互相污染。
- **纹理=种子化噪声**：`fractal(seed,x,y,fx,fy,oct,tile)` 实现分形梯度噪声，支持周期化（tile）实现无缝平铺；噪点直接合成为几何/像素，不用 filter。
- **几何原语**：`jitter(pts, amt, seed)`（确定性抖动）、`sample`（Catmull-Rom 重采样）、`densify`（按步长加密顶点）、`ribbon`（中心线→变宽闭合轮廓，把「铅笔咬纸」的边缘粗糙烘焙进几何，而不是后处理滤镜）、`clamp/smooth` 等。
- **风格 plate = 数据+纯函数**：以 flatVector.ts 为例，plate 头部是「配方注释」：MEDIUM（物理媒介：笔工具+闭合路径+单色填充）、MARKS（anchor,anchor,anchor,close,fill）、ORDER（背景面→中景→船→长影→颗粒刷）、PALETTE（13 色一调）、LIGHT（左低光，右长影）、SUBJECT & REFERENCE、**NOT ITS NEIGHBOUR**（与相邻风格的分辨点：无撕纸纤维、无每片投影、边缘数学级锐利）。场景是 `Shape[]` 数据（polys/anchors/fill/stage/grain），stage 编号 S1-S4 支持按阶段重放（timelapse 用）。

### 2.2 种子与可复现如何贯穿全图

- 随机只出自 `rng(seed)`；缓存合法当且仅当「值是 key 的纯函数，且 key 命名了像素依赖的一切」（曾机器抓到两处缓存 key 漏了曲柄角/姿态）。
- 验证：`still.mjs` 把同一帧**画两遍比哈希**，一致才打印 `reproducible`；`gate.mjs` 查确定性、契约、dead air；多页并行渲染时正向/逆向哈希探针对拍；PSNR>45dB 为「视觉一致」标准（不追求跨环境逐位一致）。
- 纪律细节：进度插值函数在输入 ≥1 时必须精确返回 1（否则 0.999 的笔画让成图≠批准图）；`globalCompositeOperation="copy"` 会清空整画布；油墨叠加需按深度面垫纸色 knock-out。

### 2.3 绘制过程（timelapse）的记录与回放

- 成品静帧与「作画过程影片」**同一份源码**：影片最后几帧=静帧逐像素。
- **记录的不是笔序日志也不是逐帧快照，而是「把绘制顺序编码为带 stage 的绘制调用 + 时钟门控」**，两种做法：
  1. **Author the process**：把笔触列为按时间排序的操作序列，在只增不减的缓存上重放（colouredPencilKit `replay`、sumiEKit `runProcess`、brokenColourKit `staged`）；
  2. **给已有 plate 加时钟**：可选参数按 pass 门控每个绘制调用；不加时钟时 plate 与原版逐像素一致（改前后比 md5 验证）。
- 规则：Frame 0 = 裸纸面；按媒介自身顺序（水彩=铅笔稿→浅洗→深洗→细节→勾线；木刻=主版→浅色版→深色版）；**笔触是「长出来」的，不是淡入的**（stroke grows along its path）；长笔快、细部慢、pass 间可歇 ≤0.5s；结尾 `meta.holds` 声明定格；`meta.raster:"cpu"` 保证过程片确定性。

### 2.4 多画幅：重新构图，绝不裁切

- 尺寸 = `meta.W×meta.H` 逻辑单位；`--scale` 在渲染期整数倍放大（一源出缩略图/页面/印刷尺寸）。**位图永不放大**：特写在该视距下重新勾线（re-ink），缓存面只允许轻微缩小。
- `--shapes 16x9,1x1,4x5,9x16`：同一时间轴按各画幅**由布局层重新构图（re-composed by its layout, never cropped）**，输出 `<name>-<shape>.mp4`。
- 文字可读性由 `framecheck.mjs` 机检：每段文字停留 ≥ max(0.7s, 0.3s/词)（打字场景从最后一字起算阅读时间）；一帧文字块 ≤7、不过密、不跨卡片边、末秒行高 ≥28px@1080；9:16 有手机安全区（顶部 14%、底部 25%、右侧 14% 禁文字）。
- 交付链：`render --poster-frame N`（首帧近空白警告→换海报帧）、`--blur auto`（按实测画面速度取子帧做运动模糊，线性光加权，确定性）、`--hashes`（编码前逐帧 md5）、`verify-export`（帧数/时长/音画同步/真峰）、`ship.mjs` 对**将要交付的那个文件**跑全部检查。

### 2.5 32 风格目录（INDEX.md）

每风格一条：编号、名称(hero module)、媒介描述（一句话工艺）、hero 静帧模块、draw-film 过程片模块。风格示例：蜡笔、青图蓝晒、碎色油画、炭笔擦改、彩铅、釉彩、刺绣、**flat vector**、民俗故事书、剪纸拼贴、新闻纸半调、等距剖切、马克笔漫画、riso 孔版、低多边形、单线雕、中世纪水粉、粉笔板、油画、玩具剧场纸拼贴、像素画、圆珠笔、铅笔+水彩、橡皮管动画、档案剪贴簿、刮版、钢笔点彩、故事书铅水彩、水墨、乐高砖、浮世绘、墨线晕染。

风格分类的启发：不是「配色不同」，而是**媒介×笔触×顺序**不同（蜡笔的留白、半调的网角、riso 的套印偏移、像素的整格放大无平滑）。

## 3. 三栏结论

### 直接移植

1. **mulberry32 种子 PRNG + 多派生流**：直接作为我们手绘风格引擎的随机源（PoC-B 按此实现，同种子两次渲染 diff=0）。
2. **「渲染两遍比哈希」的可复现验证**：still.mjs 的 `reproducible` 收据机制，直接进我们的出图服务自检。
3. **「笔触长出来，不是淡入」**：手绘动效/教学演示的观感底线，直接进 M1/M3 设计规范。
4. **文字可读性机检规则**（停留时长、块数、安全区、末秒行高）：直接进 M1 体检清单。

### 改造移植

1. **纯函数 renderFrame(frame, env) 契约**：我们不必全盘照搬引擎，但 M3 动效页采用「单一时间源 t + 纯渲染函数」，天然兼容 seek 逐帧渲染（与 huashu-design 的 `__seek(t)` 契约同构）。
2. **风格=媒介×笔触×顺序（配方头注释）**：改造成我们模板 JSON 的 `style_recipe` 字段（medium/marks/order/palette/light/not-neighbour），让每个风格可被 LLM 稳定复述与执行。
3. **场景即数据（Shape[] + stage）**：改造成我们的「卡片内容模型→绘制指令」中间表示，stage 顺序支持过程动画与静帧同源。
4. **重新构图的多画幅策略**：M1 多尺寸（3:4 图文 / 16:9 封面 / 1:1）按布局重排而非缩放裁切。
5. **gate/ship 的「对交付文件本身跑全部检查」**：改造成我们出图管线的终检步骤（对最终 PNG/MP4 而不是源码做校验）。

### 不适用

1. **完整引擎工程**（四后端、bake、3D、音乐/配音工具链）：远超 M1 范围，不引入；需要时按场景逐步自建轻量版。
2. **「无资产」纪律**（字体都改笔触、纹理全靠噪声、禁图片）：适合开源作品集；我们的产品要支持用户品牌素材（logo/图片），走「素材按 hash 引用」即可，不必学它全代码化。
3. **七律中的叙事/音乐/批评家多代理流程**：讲解片才需要；我们的 M1 是信息图卡，M3 是短动效，不建多 agent 评审链。
4. **kind:"drawing" 过程片的放宽判定**：我们暂无「作画过程」产品形态，仅保留思想备 M4。
