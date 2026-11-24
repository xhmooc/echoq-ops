# M0 回顾（Retro）

> 日期：2026-11-24 ｜ 分支：feat/m0-design-lab ｜ 依据：docs/M0-PLAN.md

## 1. 完成情况对照 DoD

| DoD 项 | 状态 | 产出 |
| --- | --- | --- |
| 4 个参考仓库克隆到 D:\Projects\reference | ✅ | huashu-design、anidoodle、baoyu-skills、Easel（与产品隔离，不入库） |
| 3 张学习笔记（A/B/C） | ✅ | docs/notes/2026-11-huashu-design.md / -anidoodle.md / -baoyu-skills.md，均含「直接移植/改造移植/不适用」三栏结论 |
| PoC-A 动效管线 | ✅ | design-lab/motion-poc：__seek(t) 契约 + 151 帧 + MP4(810×1080, 239KB) + GIF(658KB)，确定性/无缝/≤60s 全过 |
| PoC-B 手绘可复现 | ✅ | design-lab/doodle-poc：mulberry32 多流 + flat-vector，同 seed diff=0，换 seed 不同 |
| M1 设计输入 | ✅ | docs/notes/M1-DESIGN-INPUT.md（模板 Schema v0.1 + 体检规则 R/Y/F/M 清单） |
| design-lab 不入库 | ✅ | .gitignore 已含 design-lab/，PoC 产物只留本地 |
| 卡片 D（Easel 精读） | ⏭ 后置 | 按计划移到 M4 前完成（账号画像/内容日历/归因复盘） |

## 2. 关键结论

1. **渲染路线定案**：M1 出图走 HTML→Playwright 截图，不采用 baoyu 的 AI 生图路线——文字必然清晰、可模板化、可体检、无版权风险。baoyu 的价值在内容组织（五幕拆卡、风格×版式矩阵、preset YAML、自动选型表）。
2. **动效管线定案**：M3 用「纯函数 f(t) + __seek(t) 逐帧渲染 + FFmpeg 合成」，不用 recordVideo 录屏——确定性、无脏帧、可复现。逐帧 25fps 6 秒端到端 32.5s，60fps 需多 page 并发（参考 huashu concurrency=4）。
3. **插画可复现定案**：mulberry32 + 多 rng 流派生（布局/抖动/颗粒分 stream），手绘感做进几何（顶点抖动）而非滤镜。同 seed diff=0 已实测。
4. **模板 Schema 骨架成形**：huashu 风格 8 字段 + baoyu preset YAML + anidoodle 配方头合并为 echoq/template/0.1（style/canvas/layout/palette/typography/content_model/render/best_for）。
5. **体检规则可直接落地**：红灯 10 条、黄灯 8 条、指纹 4 条、动效 5 条，全部有明确阈值，M1 按表实现校验器即可。

## 3. 踩坑记录

1. **循环接缝不是截图问题，是设计问题**：首版 t=0 时进度环（灰环+“6s”标签）可见，而 t=6.0 时舞台已淡出——两端状态不一致。修复：给环加入场淡入，保证 t=0 与 t=6 都是空景。教训：**无缝循环要检查「每个元素」的首尾状态，而不是只看主体内容**。
2. **确定性验证必须逐字节比**：肉眼/PSNR 不够，PNG 字节相等才是可复现的铁证（Playwright 同像素编码结果一致，可比）。
3. **playwright-core + 本机 ms-playwright 缓存**：项目无需安装完整 playwright，直接 `executablePath` 指向 `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1194` 即可，省下载。

## 4. 风险与对策（带入 M1）

| 风险 | 对策 |
| --- | --- |
| 逐帧渲染长视频耗时（60fps×30s=1800 帧） | 多 page 并发（4-8）+ headless shell；必要时降到 30fps |
| 体检误报（艺术字/装饰性小字） | 引入 `data-overlap-ok` 类豁免标注机制；黄灯只提示不阻断 |
| 模板 Schema 过度设计 | v0.1 只收录 3 个参考项目验证过的字段，M1 实现中按需增删 |
| 中文字体授权 | 模板字体字段只允许可授权/开源字体（思源系等），体检加 Y 规则拦截未授权字体 |
| Windows FFmpeg/GIF 体积 | 两阶段调色板参数已验证（658KB/6s），超大图按张分段合成 |

## 5. M1 入口建议

1. 先实现模板加载器 + 3 个种子模板（知识卡片/步骤清单/对比测评）＋ 体检器红灯部分。
2. 出图服务主链路：内容模型 → 模板渲染 → Playwright 截图 → 体检 → 产出 PNG（含收据：模板版本/seed/体检结果）。
3. 候选交互：一次 3 版（bold/neutral/calm 各一），指纹去重后交用户选。
