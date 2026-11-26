# M0 执行计划：学习沉淀 + 技术验证

> 版本：v1 · 2026-11-24
> 上游文档：[UPGRADE-PLAN.md](./UPGRADE-PLAN.md)（里程碑 M0）
> 性质：**只学习、只做实验（design-lab/），不改产品代码、不发版**

---

## 0. 目标与退出标准（DoD）

**目标**：为 M1（出图 2.0）和 M3（动效/视频）备齐三样东西——可移植机制清单、可运行的技术验证、可评审的设计输入。

**退出标准**（全部满足才算 M0 完成）：

- [ ] 4 份学习笔记入库 `docs/notes/`，每份含「直接移植 / 改造移植 / 不适用」三栏结论；
- [ ] PoC-A（动效管线）产出 6 秒循环样片：GIF < 5MB、MP4 1080p、循环点无跳帧、首尾帧一致；
- [ ] PoC-B（手绘移植）产出样图：同种子两次渲染像素一致（diff = 0）；
- [ ] 形成 M1 设计输入：模板 JSON Schema 草案 + 体检规则清单（写入 `docs/notes/M1-DESIGN-INPUT.md`）；
- [ ] 学习总结归档 `docs/notes/M0-RETRO.md`。

---

## 1. 环境准备

| 事项 | 说明 |
| --- | --- |
| 参考仓库目录 | `D:\Projects\reference\`（学习用，与产品仓库隔离，不进 vendor、不参与构建） |
| 克隆命令 | `git clone https://github.com/alchaincyf/huashu-design`<br>`git clone https://github.com/alexgreensh/anidoodle`<br>`git clone https://github.com/JimLiu/baoyu-skills`<br>`git clone https://github.com/ZJU-REAL/Easel` |
| 本地实验区 | `D:\Projects\EchoQ-Ops\design-lab\`（新增目录，仅放 PoC 脚本与样片，不打入包） |
| 依赖 | 现有环境即可：Playwright 自带 Chromium、FFmpeg（若无则 `winget install ffmpeg`）、Node（读参考项目脚本用） |
| 版权约定 | 参考项目代码**不拷贝**进产品；只学思想与数据结构；确需引用时单独评估许可并记录 |

---

## 2. 学习计划（4 张任务卡）

> 每张卡按「读什么 → 带着什么问题 → 产出什么」执行。目录名以仓库实际结构为准，先读各自 README/目录说明再下钻。

### 卡片 A：huashu-design（出图与动效方法论）—— 优先级最高

| 项 | 内容 |
| --- | --- |
| 精读范围 | 根 `SKILL.md`（总工作流）；`references/` 下与小红书图文、动画、信息图、设计评审相关的规范；`scripts/` 下的切图、体检、截图导出脚本；`assets/` 样张（看风格数据长什么样） |
| 关键问题 | ① 风格（style）与版式（layout）在他的体系里各由哪些字段描述？② 6 缩略图 → 3 候选 → 正稿的流程中，每步的输入输出是什么？③ 设计体检具体检查哪些项、如何判定、如何输出报告？④ 小红书 3:4 多图的切图与连贯性如何保证？⑤ 时间轴动画（HTML→MP4/GIF）的帧率、时长、BGM 合成参数？ |
| 产出 | `docs/notes/2026-11-huashu-design.md` |
| 验收 | 能据笔记直接起草我们的「模板 JSON Schema 草案」与「体检规则清单」初稿 |

### 卡片 B：anidoodle（代码化手绘引擎）—— 优先级最高

| 项 | 内容 |
| --- | --- |
| 精读范围 | `skills/anidoodle/`（使用规范与风格索引）；任选 2 个风格实现精读（建议 flat vector + pencil & watercolour，与我们实用信息流最搭）；`references/` 音乐/动效规范；examples 里的绘制脚本 |
| 关键问题 | ① 「一笔一函数」的原语层如何设计（笔触/填充/纹理/噪点）？② 种子与 PRNG 如何贯穿全图保证可复现？③ 绘制过程（timelapse）如何记录与回放——是记录笔序还是逐帧快照？④ 多画幅重构图是重新构图还是缩放裁切？⑤ 32 风格中哪几个的实现最值得借鉴到我们引擎？ |
| 产出 | `docs/notes/2026-11-anidoodle.md` |
| 验收 | 能据笔记在 PoC-B 里复刻出一种风格的简化版，且说明可复现机制 |

### 卡片 C：baoyu-skills（图卡矩阵与公众号排版）—— 优先级中

| 项 | 内容 |
| --- | --- |
| 精读范围 | `skills/baoyu-xhs-images/SKILL.md`（Style×Layout 矩阵与拆卡策略）；`skills/baoyu-post-to-wechat/SKILL.md` 与 `baoyu-markdown-to-html`（MD→公众号 HTML 的样式内联清单）；`baoyu-format-markdown`（结构化整理） |
| 关键问题 | ① 一篇文案如何拆成 1~10 张卡（按语义还是按段落）？② Style 与 Layout 两个维度的取值与组合规则？③ 调色板覆盖如何实现（CSS 变量？）？④ 公众号 HTML 需要内联哪些样式、图片如何处理、哪些标签要清洗？ |
| 产出 | `docs/notes/2026-11-baoyu-skills.md` |
| 验收 | 形成我们的「公众号排版补齐清单」与图卡拆分策略建议 |

### 卡片 D：Easel（运营智能，为 M4 备料）—— 优先级低，可后置

| 项 | 内容 |
| --- | --- |
| 精读范围 | `docs/` 架构与 SKILL-SPEC；账号画像（profiles）的数据结构与记忆更新机制；发现/归因相关技能；人工发布模式（manual）流程；平台适配器接口定义 |
| 关键问题 | ① 画像六维各存什么、如何随发布数据更新？② 归因数据从哪些平台接口来、如何聚合？③ 人工发布模式的导出物包含什么？ |
| 产出 | `docs/notes/2026-11-easel.md` |
| 验收 | 能据此起草我们的画像表结构与 M4 任务拆解初稿 |

---

## 3. PoC-A：动效渲染管线（M3 的技术地基）

**位置**：`design-lab/motion-poc/`
**目标**：验证「HTML/CSS/JS 动画 → Chromium 确定性逐帧渲染 → FFmpeg 合成 GIF+MP4」整条链路可行且质量达标。

### 步骤

1. **写动效页** `motion.html`：3:4 画幅（1080×1440），6 秒循环；内容 = 标题逐字浮现 + 底图 Ken Burns + 结尾进度条收口。要求：
   - 动画由 JS 驱动：页面暴露 `window.__seek(t)`（t ∈ [0,6) 秒），调用后立刻把画面设为该时刻状态——**保证逐帧截图确定性**，不依赖真实时钟；
   - 首尾状态一致（t=0 与 t→6 画面相同），确保循环无跳变；
   - 无外部资源（字体用系统栈或内嵌 base64），加载后 `document.fonts.ready` 再允许截图。
2. **逐帧渲染** `render.mjs`（Node + Playwright）：
   - 打开 `motion.html`，等 `fonts.ready` 与首帧绘制完成；
   - 循环 `t = 0, 1/25, 2/25, …, 6-1/25`（150 帧），每帧调用 `__seek(t)` → `page.screenshot` 存 `frames/f_%04d.png`；
   - 记录总耗时与单帧耗时。
3. **合成** `compose.ps1`（FFmpeg）：
   - MP4：`ffmpeg -framerate 25 -i frames/f_%04d.png -c:v libx264 -pix_fmt yuv420p -movflags +faststart out.mp4`；
   - GIF：先缩至 540 宽 + palettegen/paletteuse 两段式生成，控制体积 < 5MB。
4. **验证**：
   - 抽查 t=0 与 t=6-1/25 两帧 diff ≈ 0（循环点无跳变）；
   - 播放检查无跳帧、无文字裁切（首/中/尾三帧人工过目）；
   - 记录：150 帧渲染耗时、GIF/MP4 体积、CPU 峰值。
5. **结论产出**：`design-lab/motion-poc/README.md` 写清管线参数（帧率、分辨率、编码参数、耗时）与「接入产品时的改造点」（复用现有隐藏窗口渲染、任务队列化、失败重试）。

### 通过标准

- [ ] GIF < 5MB 且循环无跳帧；MP4 1080p 可播；
- [ ] 单条 6 秒动效端到端 ≤ 60 秒（本机）；
- [ ] 同一 HTML 两次渲染帧序列一致（确定性）。

---

## 4. PoC-B：手绘风格移植（M2 的技术地基）

**位置**：`design-lab/doodle-poc/`
**目标**：验证「风格 = 绘制原语 + 种子随机」的代码化手绘在我们技术栈里可落地、可复现。

### 步骤

1. **定义绘制原语** `primitives.js`：`line / rect / circle / path / fillHatch / roughen`（roughen = 给直线/边缘加种子化抖动，制造手绘感）；
2. **种子随机** `rng.js`：实现 mulberry32；所有随机量（抖动幅度、虚线间隔、色块偏移）都从种子派生；
3. **写风格** `style-flat-vector.js`：flat vector 规则——几何色块 + 粗描边 + 少量高光，参考 anidoodle 该风格规范自研实现（不拷代码）；
4. **测试图** `doodle.html`：Canvas 上画一张「标题 + 咖啡杯 + 三个要点」的 3:4 卡片；
5. **渲染与验证** `render.mjs`：Chromium 加载 → 等 fonts.ready → 截图；
   - **可复现验证**：同种子连续渲染 2 次，PNG 像素级 diff = 0；
   - **差异验证**：换种子渲染，构图一致但细节（抖动/排布微差）不同；
6. **过程动画可行性**（选做）：每完成 N 笔调用一次截图钩子，导出「绘制生长」帧序列，直接喂给 PoC-A 的合成脚本；
7. **结论产出**：`design-lab/doodle-poc/README.md`：原语清单、风格规则描述、接入我们出图服务的方式（作为「风格库」中的一个分类）。

### 通过标准

- [ ] 同种子像素级可复现；换种子有可见差异；
- [ ] 样图通过基础目检（无文字碰撞、风格统一）；
- [ ] 能明确回答：过程动画（绘制生长）是否可作为 M3 动效模板之一。

---

## 5. 执行顺序

```
1. 环境准备（clone 4 仓库、建 design-lab/）
2. 卡片 A：huashu-design 精读 ──┬──► 3. PoC-A 动效管线（依赖 A 的动画规范）
3. 卡片 B：anidoodle 精读 ──────┼──► 4. PoC-B 手绘移植（依赖 B 的风格机制）
4. 卡片 C：baoyu-skills 精读 ───┘
5. 汇总：M1-DESIGN-INPUT（模板 Schema + 体检规则）+ M0-RETRO
6. （可后置）卡片 D：Easel 精读 → M4 画像表初稿
```

卡片 A、B 是 PoC 的前置，先读后做；C 与 A/B 可穿插；D 完全可后置到 M4 启动前。

---

## 6. 产出物清单与归档

| 产出 | 位置 |
| --- | --- |
| 学习笔记 ×4 | `docs/notes/2026-11-{huashu-design,anidoodle,baoyu-skills,easel}.md` |
| M1 设计输入 | `docs/notes/M1-DESIGN-INPUT.md`（模板 JSON Schema 草案、体检规则清单、账本表结构） |
| M0 总结 | `docs/notes/M0-RETRO.md`（学到了什么、放弃什么、对 M1/M3 计划的修正建议） |
| PoC-A | `design-lab/motion-poc/`（motion.html、render.mjs、compose.ps1、frames/、out.gif、out.mp4、README.md） |
| PoC-B | `design-lab/doodle-poc/`（primitives.js、rng.js、style-flat-vector.js、doodle.html、render.mjs、样图、README.md） |

> `design-lab/` 加入 `.gitignore` 的 frames/ 等大文件目录；样片保留小体积最终版即可。

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 参考仓库结构与预期不符 | 每张卡第一步先读仓库 README 与目录树，按实际结构调整精读路径，不硬套本计划 |
| 逐帧截图不确定（字体/抗锯齿/异步图片） | 动画全部 JS 驱动 `__seek(t)`；等 `fonts.ready`；禁用网络资源；同帧渲染两次校验 |
| GIF 体积超标 | 降到 540 宽 / 15fps / palette 优化；仍超则 GIF 只出预览版，正式用 MP4 |
| 手绘风格「不像手绘」 | 先复刻 anidoodle 的抖动/纹理参数量级，再谈风格扩展；样图不过关不进 M2 |
| 学习过深、久拖不动 | 每张卡限时产出笔记初稿即可，细节留到对应里程碑现用现查；PoC 通过标准达成即停 |
