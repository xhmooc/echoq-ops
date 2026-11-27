# 应声运营 EchoQ Ops · 宣传视频交付包

方向一「流水线」（Apple 式亮色产品片），由 huashu-design v3.5.0 的 HyperFrames 管线制作。
时长 38s · 1920×1080 · 7 联画布（序 → 选题 → 成稿 → 配图 → 预览 → 发布 → 落版）。

## 成片与产物

全部位于 `film/renders/`：

| 文件 | 说明 |
| --- | --- |
| `echoq-ops-promo-60fps.mp4` | **交付成片**（60fps，h264+aac，BGM+31 条音效，已过 verify-video） |
| `echoq-ops-promo-30fps.mp4` | 预览版（30fps，体积更小，便于快速分享） |
| `echoq-ops-promo-preview.gif` | GIF 动图预览（960×540 @12fps） |
| `poster.png` | 海报帧（取自落版 t≈36.5s，1920×1080） |

## 文件地图

- `film/index.html` — 合成源文件（GSAP 时间轴 `window.__timelines["main"]`，`data-duration="38"`）
- `film/hyperframes.json`、`film/package.json` — HyperFrames 工程配置
- `film/assets/prototype/index.html` — 产品界面原型（用户提供），经 iframe 内嵌直渲；尾部引导脚本按 `#view=<name>` 切换视图、按 `#preview=1` 打开三端预览、关闭首启引导并冻结 CSS 动画
- `make_prototype.py` — 从用户上传的原件生成上述内嵌原型
- `render_frames.py` — 自研逐帧捕获器（Playwright seek + 截图，等待 5 个原型 iframe 就绪）
- `mix_audio.py` — BGM+音效混流器（loudnorm -14 LUFS）
- `sfx-cues.tsv` — 31 条音效 cue（时间 / 文件名 / dB）
- `导演稿.md` — 分镜与 As-built 时刻表；`brand-spec.md` — 品牌规范
- `spec.md`、`directions.md`、`direction-approved.md`、`polish-log.md` — 过程文档
- `design-demos/` — 三方向板（dir-1 为选定方向）

## 复渲染命令

```bash
# 1. 逐帧捕获（60fps 示例；产物约 2280 帧 PNG）
python render_frames.py --fps 60 --out-dir film/.frames-60

# 2. 编码（无音视频轨）
ffmpeg -framerate 60 -i film/.frames-60/f%06d.png \
  -c:v libx264 -preset medium -crf 17 -pix_fmt yuv420p \
  -movflags +faststart film/renders/out-silent.mp4

# 3. 混入 BGM + 31 条音效（loudnorm -14 LUFS）
python mix_audio.py film/renders/out-silent.mp4 sfx-cues.tsv \
  film/assets/bgm.mp3 film/renders/echoq-ops-promo-60fps.mp4 38

# 4. 验证
bash "<skill>/scripts/verify-video.sh" film/renders/echoq-ops-promo-60fps.mp4
```

合成源文件改动后先过审：在 `film/` 下执行 `npm run check`（Layout / Motion / Contrast / Craft / Audio 五门，0 error 方可渲染）。

## 备注

- 片中软件界面为**产品原型直接渲染**：五个站点分别内嵌原型页的 选题池 / 创作台 / 内容库 / 创作台(平台切换) / 发布队列 视图，1920×1080 视口按 0.4844 缩放入 930px 窗口框。
- 原型内注入了 `window.__protoCue(t)` 逐帧编排引擎（见 `make_prototype.py`）：选题卡弹入+热度环计数、文案逐字生成、封面墙浮现+新图高亮、真机三平台实切、队列状态逐条翻转——全部状态是时间 t 的纯函数，逐帧渲染完全确定。
- 本机 `hyperframes render` CLI 会挂起（lint 正常但无 chrome 进程），故渲染走 `render_frames.py` 替代管线，产出与 CLI 等价。
- 音效素材来自 `~/.trae-cn/skills/huashu-design/assets/sfx/`（按子目录分类，mix_audio.py 递归查找）。
