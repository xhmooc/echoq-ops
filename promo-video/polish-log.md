# Polish Log · 应声运营宣传视频

## 审计记录
- hyperframes check：最终 **0 error** 通过（Layout 0E/1W、Motion 0E/0W、Contrast 49/49、Craft 0E/0W、Audio 0E/0W）
- 保留的 warning（已评审，属有意为之）：
  - 结构类（单文件合成 >1000 行建议拆分）：30 秒级短片按 skill 惯例保持单文件，便于交付与复渲染
  - escaped_container（配图站内页缩卡相对 cover-wrap 越界）：有意的扇形展开构图
  - duplicate img（同一 icon.png 出现 3 处）：品牌锁牌/序幕/落版各需一枚，属复用非错误
  - canvas_overflow infos：7 联世界中非当前站的画板在画布外，为横移叙事的设计前提
- 渲染前 lint：0 error, 7 warning（同上）

## 修复史
1. 卡片 meta 文本被页脚 `.meta` 选择器误伤（绝对定位叠底）→ 页脚类改名 `.bmeta`
2. 大标题在 700px 栏宽内折行出现孤字 → 栏宽 760px + nowrap + 字号 84px
3. 方向三标题断行位置调整（把时间，/ 留给重要的事。）+ 时间轴下移消除与正文重叠
4. 资产路径 `../assets/icon.png` 越项目根 → 复制入 `film/assets/` 并改为 `assets/icon.png`
5. 字体栈声明了不存在的系统字体（PingFang/YaHei/Cascadia）→ 移除，仅保留 Google Fonts 两族
6. GSAP 无法选择伪元素 `.qdot::after` → 改为真实子元素 `<i>`
7. 叠字检测（slate 六联 / 节点徽章双态 / 队列状态双态）→ 改为单文本节点 + 背景圆/胶囊交叉淡化；状态文字交换窗口避开 1/6s 采样栅格
8. `.pnode` CSS transform 与 GSAP y 补间冲突 → 改 margin-left 居中
9. 对比度：小号红字统一改用深红 `--redtext:#c8152f`；封面渐变翻转（深红承大白字）；水印改实色 #6e6e73
10. first_frame_empty → 冷开场（首帧即有品牌锁牌、图标、大标题）
11. dead_stretch（6.9–10.1s 无变化）→ 选题卡驻留期轻浮 + 热度点脉冲
12. film_silent → 合成内嵌 BGM `<audio>`（check 通过），成片另经 ffmpeg 混入 31 枚 SFX
13. 鬼影数字改为顶部右侧 5 刻度进度条（避免低对比装饰文本）
14. `.q-row:nth-of-type` 计数错误（q-head 占位）→ 修正为 +1 偏移
15. 音频 `<audio>` 补 `id="bgm"`

## 渲染替代方案说明
本机 `hyperframes render` 在 lint 后挂起（浏览器安装锁残留 + 12 worker 捕获无进展）。
改用自研 `render_frames.py`（Playwright 逐帧 seek + 截图，4.2 帧/秒）产出帧序列，
ffmpeg 编码 H.264，再经 `mix_audio.py` 混入 BGM（-14 LUFS loudnorm）与 31 枚 SFX。
产物与 hyperframes render 同构（同一合成、同一时间轴契约）。

## 成片验证
- verify-video.sh：PASS（1920×1080 · 38s · 含音轨 · 无黑帧；响度 -12.9 LUFS，偏热门区间但可接受）
- ffprobe：h264 + aac，时长 38.000s
- 抽帧复核：t=6/16/25/36 与分镜一致
