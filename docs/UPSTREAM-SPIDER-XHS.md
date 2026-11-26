<div align="center">

<p align="center">
  <a href="https://github.com/cv-cat/Spider_XHS" target="_blank">
    <picture>
      <img width="200" src="./author/logo.svg" alt="Spider_XHS logo">
    </picture>
  </a>
</p>

# Spider_XHS

> 本文件是上游 Spider_XHS 原始 README 的存档，仅用于追溯采集/发布能力的来源与用法。
> 文中图片与脚本相对路径以仓库根目录为基准；产品说明、目录结构与运行方式请回到 [README.md](../README.md)。

### The All-in-One Manager for XHS

[![Skills](https://img.shields.io/badge/skills-supported-success)](https://github.com/cv-cat/XhsSkills)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/nodejs-20%2B-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-orange)](LICENSE)

<a href="https://trendshift.io/repositories/13631" target="_blank"><img src="https://trendshift.io/api/badge/repositories/13631" alt="cv-cat%2FSpider_XHS | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

</div>

## ❤️Sponsor

<div align="center">

<a href="https://api.openai-next.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./author/sponsors/vectrust-dark.png">
    <img src="./author/sponsors/vectrust.png" alt="Vectrust" height="72">
  </picture>
</a>

**Sponsored by [Vectrust](https://api.openai-next.com) @ OpenDev Org & NextRouter Alliance**

<sub>[想出现在这里？](mailto:992822653@qq.com)</sub>

</div>

---

<div align="center">

[![FastAIToken](https://raw.githubusercontent.com/TheSmallHanCat/flow2api/main/static/sponsors/fastaitoken-banner.png)](https://www.fastaitoken.com/register?aff=48J4VXUABAAV)

</div>

**FastAIToken** 是面向开发者的 AI API 聚合平台，支持 OpenAI、Claude、Gemini 等主流大模型，兼容 OpenAI API 协议，可无缝接入 **Claude Code、Codex、Gemini CLI、Cherry Studio、Cline、Continue** 等各类 AI 开发工具。平台采用 **充值 1:1（1 元 = 1 美元 API 额度）**，帮助开发者以更低成本、更高效率地使用全球领先的大模型服务。

平台提供多个可选分组与公开状态页，开发者可根据成本、响应速度和稳定性自由选择不同渠道，并享受 **7×24 小时真人技术支持**（非机器人）。

**主要做 AI 开发接入？可以试试 [FastAIToken](https://www.fastaitoken.com/register?aff=48J4VXUABAAV)，兼容 Codex / Claude Code / Gemini CLI 等主流工具。**

## 为什么需要这个项目？

> **在 AI 大模型爆发的时代，内容运营的竞争本质是效率竞争。**
> 本项目封装了小红书平台完整的数据采集与内容发布能力，为开发者构建 AI 运营智能体提供可靠、稳定的底层 API 支撑。

**⚠️ 本项目仅供学习交流使用，禁止任何商业化行为，如有违反，后果自负**

```
采集竞品笔记 ──► [Spider_XHS] ──► 你的 AI Agent（改写 / 生成 / 分析）──► 自动上传发布
                     ▲                                                        │
                     └──────────── 获取数据 / 管理账号 ◄──────────────────────┘
```

小红书没有开放完整的内容运营接口。想要接入 AI 大模型实现内容批量采集、智能改写、一键发布，首先需要能**稳定读写平台数据**。Spider_XHS 解决的正是这个前置问题：

- 逆向还原了小红书 PC 端与创作者平台的签名算法（a1 / web_id / b1 / websectiga / sec_poison_id / gid / x-s / x-t / x-s-common / x-b3-traceid / x-xray-traceid / x-rap-param / search_id / request_id / sign / q-signature 等参数）
- 封装全部核心 HTTP 接口，签名参数已透明处理
- 同时覆盖 **数据采集**（PC端）、**内容发布**（创作者平台）、**KOL数据**（蒲公英）三大场景

**你负责接 AI 大脑，我们负责打通小红书的神经。**

---

## 成品

### repo地址： [XHS_ALL_IN_ONE](https://github.com/cv-cat/XHS_ALL_IN_ONE)

### 账号矩阵 — 多账号绑定与健康管理

支持绑定多个 PC / Creator 账号，扫码登录、手机验证码、Cookie 导入三种方式。Cookie 加密存储，2 小时自动健康巡检，过期自动通知。

<img src="https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/static/frontend_1.jpg" width="600" />

### 素材优化 — AI 图片润色

选择草稿中的任意图片，添加参考图，输入润色指令，AI 生成优化后的图片并原位替换。当前素材和优化结果并排对比，点击即可放大预览。

<img src="https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/static/frontend_5.jpg" width="600" />

### 发布中心 — 一键发布到小红书

预览草稿内容和图片素材，选择 Creator 账号，设置可见性和发布模式（立即/定时），发布校验通过后一键发布到小红书创作者平台。

<img src="https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/static/frontend_6.jpg" width="600" />

---

## 🧩 Skills 支持

当前项目已经支持基于 skills 的能力接入，既可以直接作为 `Spider_XHS` 的底层能力仓库使用，也可以通过标准化 skills 方式被上层 Agent 工具链引入。

如果你希望直接复用已经封装好的 skills，可以查看 [XhsSkills](https://github.com/cv-cat/XhsSkills)。该仓库专门用于存放基于 `Spider_XHS` 封装的 Agent Skills，目前可被 `Clawbot`、`Claude Code`、`Codex` 等支持 skills 的工具直接引入与集成。

---

## ⭐ 已实现功能

| 模块 | 功能 | 状态 |
|------|------|------|
| **小红书 PC 端** | 二维码登录 / 手机验证码登录 | ✅ |
| | 获取主页所有频道 & 推荐笔记 | ✅ |
| | 获取用户主页信息 / 自己的账号信息 | ✅ |
| | 获取用户发布 / 喜欢 / 收藏的所有笔记 | ✅ |
| | 获取笔记详细内容（无水印图片 & 视频） | ✅ |
| | 搜索笔记 & 搜索用户 | ✅ |
| | 获取笔记评论 | ✅ |
| | 获取未读消息 / 评论@提醒 / 点赞收藏 / 新增关注 | ✅ |
| **直播 / 私信** | 直播间连接与事件监听（弹幕 / 点赞 / 进场 / 礼物等） | ✅ |
| | 私信发送与接收（WebSocket + HTTP 兜底） | ✅ |
| **创作者平台** | 二维码登录 / 手机验证码登录 | ✅ |
| | 登录会话级自动重试（406 概率闸门） | ✅ |
| | 上传图集作品 | ✅ |
| | 上传视频作品（含转码轮询） | ✅ |
| | 查看已发布作品列表 | ✅ |
| | 发布接口 Creator RAP 本地纯算 | ✅ |
| **蒲公英平台** | 获取 KOL 博主列表 & 详细数据 | ✅ |
| | 获取博主粉丝画像 & 历史趋势 | ✅ |
| | 发起合作邀请 | ✅ |
| **千帆平台** | 获取分销商列表 & 详细数据 | ✅ |
| | 获取分销商合作品类 / 店铺 / 商品信息 | ✅ |

---

## 运营台（EchoQ-Ops）

在原有采集 / 发布能力之上补齐了一条完整的内容生产链路，入口是一个本地单页运营台。产品主干是 **内容生成 → 手机预览 → 发布**；账号是多账号发布时的辅助能力，不占据主界面。

| 模块 | 已实现 |
| --- | --- |
| **内容生成（主）** | 一段自由需求直接出稿（DeepSeek，失败自动回落离线模板）、9 种语气、话题生成、实时合规检查；也支持手动撰写 |
| **手机预览（主）** | 按小红书 App 笔记详情页还原：作者行、3:4 图片轮播、标题、正文话题高亮、日期、评论区、底部互动栏；编辑时实时同步 |
| **发布（主）** | 草稿入库、三图配图、队列、定时、失败分类与指数退避、发布记录与远端笔记 ID；一稿多号是可选项，默认关闭 |
| **选题（上游）** | 关键词搜索、竞品主页、站内热榜、历史题库四路挖掘；互动 / 新鲜度 / 赛道匹配 / 新颖度加权评分；同题相似度去重；可一键带入创作台 |
| **账号（辅助）** | 多账号 Cookie / 扫码接入、Cookie 加密落盘、定时健康巡检、日限额 + 最小间隔 + 随机抖动、按负载自动轮换 |

### 文案与配图

- 文案链路对齐 `wr/prompts.json` 的 WriteNow 方案（9 种语气 + `[分享主题: X，语气风格: tone]` 输入），并按对话记录里实际验收过的样本补齐排版：标题 14-20 字带 emoji、正文 250-350 字、emoji 分节、`✅ / 💡 / 1️⃣` 要点、结尾问句或内测 CTA、4-6 个话题标签。
- 模型固定 `deepseek-flash`，`max_tokens=3000`、`temperature=1.0`、超时 180 秒；生成后统一剥 Markdown 壳、删英文语气词泄漏、按句号/换行压长度，失败才回落离线模板。
- 配图风格取自 `baoyu-skills/skills/baoyu-xhs-images` 的 12 种预设：cute / fresh / warm / bold / minimal / retro / pop / notion / chalkboard / study-notes / screen-print / sketch-notes；版式 8 种：sparse / balanced / dense / list / comparison / flow / mindmap / quadrant；配色可额外覆盖为 macaron / warm / neon。
- 渲染方式为**纯本地 HTML/CSS + 内联 SVG + 本机 Edge/Chrome 无头截图**，输出 1080×1440 PNG，不调用任何付费图像生成接口。每个卡片同时保留 `NN-type.html` 源文件，便于复现和调样式。
- 创作页「配图」区顶部是两个并排 tab：**免费模板**（默认）与**付费出图**，各自独立的风格列表和生成入口。两栏产出的图片都会写回同一份草稿的 `images`，可继续点开放大、发布。
- 免费模板：8 套本地设计系统（便签纸 / 信息卡 / 杂志奶油 / 极简黑白 / 索引墨 / 标本志 / 日报 / 收藏卡），版式取自对小红书 24 篇高赞图文笔记的实拍拆解（参考图与 `manifest.json` 存档在 `datas/ops/references/`，不混入成品目录）。每套是独立版式结构，不含 baoyu preset、版式或配色选项。以「草稿 id + 风格 + 本次序号 + 页码」为随机种子，装饰位置（胶带、下划线、装饰点）可控变化；同一次生成可复现，下一次点击会换一版。输出到 `datas/ops/designs/`，接口为 `GET /api/design/styles` 与 `POST /api/drafts/{id}/design-cards`。
- 免费模板按正文结构自动分页：识别 `✨ / 🔍 / 📌` 等分节标题、`✅ / 💡 / 🔹` 条目和结尾问句，输出「封面 + 每节内容页 + 结尾页」，每页最多 4 条；条目自带 emoji 原样保留（系统彩色 emoji 字体回退），长句自动折行，条目少时自动撑开留白。标题与开篇引语不再截断。
- **公众号封面走原生 2.35:1 宽幅画布（1080×460）**：8 套模板各有一套横版封面版式，标题字号、行数、留白、装饰位置按横向重排，长标题自动降到 3 行内；不再把 3:4 竖图居中裁切。小红书与抖音图文仍为 1080×1440。出图前的碰撞/越界检查按实际画布尺寸执行，失败直接报错不落图。
- 付费出图：baoyu-xhs-images 路线全部归到这里，包含 12 个 preset、8 种版式与 3 套配色。只用非 pro 的 `qwen-image-3.0`（1k 约 0.18 元/张，3 张一组），面板展示型号、单张价格与预计费用（¥0.54），点击生成前二次确认；未配置 `OPS_IMAGE_API_KEY` / `DASHSCOPE_API_KEY` 时按钮置灰并说明原因。不会自动调用，只有确认后才请求 `POST /api/drafts/{id}/paid-cards`。
- 用户可直接上传图片素材（点击或拖拽），接口 `POST /api/uploads`，文件存到 `datas/ops/uploads/`，通过 `/uploads/` 访问。

### 启动

```bat
run.cmd ops
```

打开 <http://127.0.0.1:8710>。默认只监听本机，不对外暴露。

推荐顺序：**创作台写需求 → 生成文案 → 看手机预览与合规 → 生成配图 → 加入队列**。
选题池是上游：挖到合适的题，点「带入创作」即可；账号只在需要指定发布号或一稿多号时进入。

如果 `.env` 里已经有登录 Cookie，在「账号」页点「导入 .env 登录态」即可，不用重复粘贴。
文案与配图统一走 EchoQ-Cloud 中转：在页面右上角登录账号（手机验证码 / 邮箱密码）后，云端按账号签发文案与配图两把 Key，本机只保存密文，页面不显示完整 Key。

### 命令行

```bat
run.cmd ops account list
run.cmd ops account add-cookie --name 主号
run.cmd ops account add-qr
run.cmd ops account check

run.cmd ops topic mine --mode keyword --keywords "面试,秋招" --per-kw 20
run.cmd ops topic mine --mode competitor --user-urls "https://www.xiaohongshu.com/user/profile/..."
run.cmd ops topic mine --mode trending
run.cmd ops topic import --path xhs-promo/topics/library.json

run.cmd ops draft create --topic-ids 1,2 --variants 2 --cards
run.cmd ops publish enqueue --draft-ids 3,4 --at "2026-11-14 09:00"
run.cmd ops publish run --limit 2
run.cmd ops publish worker

run.cmd ops settings show
run.cmd ops selfcheck
```

`run.cmd ops` 后接任意子命令；不带参数时等价于 `python -m ops serve`。

### 数据与安全

- 数据目录：`datas/ops/`。SQLite（`ops.db`，WAL）+ 配图产物（`assets/draft-*/`）。
- Cookie 使用 Fernet 加密后入库，密钥独立存放在 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`（可用 `OPS_KEY_PATH` 覆盖，备份数据目录不会带走密钥）；接口不会回传 Cookie。
- 上游 AI Key 只保存在 EchoQ-Cloud；本机登录后拿到的是按账号签发的 `eqk_llm_...` / `eqk_img_...` 中转 Key，加密存放在 `datas/ops/cloud_state.json`，接口只回传掩码与额度。
- 默认限速：每账号每天 3 篇、最小间隔 45 分钟、附加稳定抖动；公众号/抖音等平台使用各自默认值，可在「设置」或单账号上覆盖。
- 发布前硬校验按平台执行：小红书标题 ≤ 20 字、正文 ≤ 1000 字、图文必须有配图；公众号标题 ≤ 64 字、正文 ≤ 2 万字；抖音视频/图文使用自己的规格。文案不得命中「扣1 / 私信我 / 关注后发 / 加微信 / 二维码」等红线。
- 失败处理：账号失效会标记并换号；内容错误直接失败不浪费重试；网络 / 边缘拒绝按 1、2、4 分钟指数退避，风控类至少 15 分钟。
- 队列幂等：同一「草稿 + 账号」唯一，领取使用条件更新，后台线程与手动触发并发也不会重复发布；一稿多号时每个账号各一条任务，草稿状态按全部任务汇总。
- 已发布内容：平台作品列表会缓存在 `published_notes`，每 6 小时自动同步一次，也可手动触发；平台没同步到的真实发布记录先以「待同步」占位，模拟发布不会混进已发布内容。

### 运营台目录

```text
ops/
├── cli.py          # 命令行入口（python -m ops）
├── config.py       # 路径、默认参数、模型配置
├── db.py           # SQLite 表结构与线程内连接
├── security.py     # Cookie 加密
├── platforms/      # 平台适配器（小红书、公众号、抖音均已实现扫码登录/发布/回收）
├── accounts.py     # 账号矩阵、巡检、限速、轮换、扫码会话
├── topics.py       # 选题挖掘、评分、去重、入池
├── llm.py          # OpenAI 兼容文案模型
├── content.py      # 文案生成、合规扫描、草稿管理
├── designs.py      # 本地设计模板
├── illustrator.py  # baoyu 预设、付费出图、无头截图
├── publisher.py    # 发布队列、错误分类、重试、记录
├── published.py    # 已发布内容同步与查询
├── scheduler.py    # 定时任务、触发计算、运行记录、容错恢复
├── worker.py       # 发布 + 巡检 + 定时调度 + 内容回收线程
├── service.py      # Web / CLI 共用业务门面
├── selfcheck.py    # 离线自检（46 项）
└── web/            # aiohttp 接口与单页界面
```

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | 概览统计 |
| GET/POST | `/api/accounts` | 账号列表 / Cookie 接入 |
| POST | `/api/accounts/qr` | 生成扫码登录二维码 |
| GET | `/api/accounts/qr/{sid}` | 轮询扫码状态 |
| POST | `/api/accounts/{id}/check` | 健康巡检 |
| GET/POST | `/api/topics` | 选题列表 / 手动添加 |
| POST | `/api/topics/mine` | 关键词 / 竞品 / 热榜挖掘 |
| POST | `/api/copy/generate` | 按自由需求生成文案（不落库，`platform` 缺省 `xiaohongshu`） |
| POST | `/api/copy/check` | 编辑时实时合规检查 |
| GET/POST | `/api/drafts` | 草稿列表 / 由选题生成 |
| POST | `/api/drafts/manual` | 保存创作页内容 |
| POST | `/api/uploads` | 上传图片素材（multipart `files`），返回本地绝对路径 |
| POST | `/api/drafts/{id}/cards` | 生成配图（可传 `style` / `layout` / `palette`，默认读设置） |
| GET | `/api/cards/styles` | 配图风格清单（baoyu-xhs-images 12 种） |
| GET | `/api/cards/options` | 风格 / 版式 / 配色 / 预设与本地渲染状态 |
| GET | `/api/design/styles` | 独立设计风格库（8 套，不含小红书 preset） |
| POST | `/api/drafts/{id}/design-cards` | 按 `style` / `limit` 生成设计卡片；画布按草稿平台决定（公众号 1080×460，其余 1080×1440），响应带 `canvas` 与 `template` |
| POST | `/api/drafts/{id}/paid-cards` | qwen-image-3.0 付费出图（需密钥，二次确认后调用） |
| GET/POST | `/api/jobs` | 队列列表 / 入队（可传 `account_ids` 一稿多号） |
| GET | `/api/records` | 发布记录（执行审计） |
| GET | `/api/platforms` | 平台清单、规格、可见范围、限额与数据来源 |
| GET | `/api/published` | 已发布内容（账号 / 平台 / 时间筛选、分页、来源说明） |
| POST | `/api/published/sync` | 手动同步已发布内容（202 + 后台任务） |
| GET | `/api/published/accounts` | 每个账号的同步时间、缓存条数与最近错误 |
| GET/POST | `/api/schedules` | 定时任务列表 / 新建（publish / mine / draft / chain） |
| POST | `/api/schedules/quick` | 引导式新建：只传 `what` + `when`，其余用安全默认值 |
| PATCH/DELETE | `/api/schedules/{id}` | 编辑、启停、删除定时任务 |
| POST | `/api/schedules/{id}/run` | 立即执行一次 |
| GET | `/api/schedule-runs` | 运行记录（可传 `schedule_id`、`limit`） |
| POST | `/api/schedule-runs/{id}/confirm` | 确认发布待确认记录里的草稿 |
| GET/PATCH | `/api/settings` | 参数读写 |

### 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [本地运行与配置](docs/RUNBOOK.md)
- [接口文档](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [多平台接入说明](docs/PLATFORMS.md)
- [代码与安全 Review](docs/REVIEW.md)
- [CHANGELOG](docs/CHANGELOG.md)

### 已知边界

- 扫码登录、手机验证码、平台二次验证仍需人工完成；本项目不绕过验证码。
- 平台接口与签名会随版本变化，采集/发布失败时先跑 `run.cmd check` 与 `run.cmd ops selfcheck`。
- 发布成功与否以平台返回为准；失败会保留完整错误与重试记录，不会静默丢弃。
- 请自行控制账号数量与发布频率，账号风控与使用后果由使用者承担。

---

## 🤖 接入 AI 智能体

Spider_XHS 天然适合作为 AI 运营 Agent 的数据底座，以下是几种典型用法：

### 场景一：竞品笔记采集 + AI 改写 + 自动发布

```python
from apis.xhs_pc_apis import XHS_Apis
from apis.xhs_creator_apis import XHS_Creator_Apis
from xhs_utils.xhs_pc import XHSPcAuth
from xhs_utils.xhs_creator import XHSCreatorAuth

pc_auth = XHSPcAuth.from_cookie(pc_cookie)
pc_api = XHS_Apis(pc_auth).bootstrap()
creator_auth = XHSCreatorAuth.from_cookie(creator_cookie)
creator_api = XHS_Creator_Apis(creator_auth).bootstrap()

# 1. 采集竞品笔记
success, msg, res = pc_api.get_note_info(note_url)
note = res['data']['items'][0]['note_card']

# 2. 交给 AI 改写（接入任意大模型）
rewritten = your_ai_agent(note['title'], note['desc'])   # GPT / Claude / Qwen / 本地模型

# 3. 自动上传到创作者平台
creator_api.post_note({
    "title": rewritten['title'],
    "desc": rewritten['desc'],
    "media_type": "image",
    "images": [...],
    ...
})
```

### 场景二：关键词监控 + AI 情报分析

```python
# 搜索指定关键词的最新笔记，交给 AI 分析趋势
success, msg, notes = pc_api.search_some_note(query, require_num, ...)
analysis = your_ai_agent(notes)
```

### 场景三：KOL 筛选 + 智能匹配

```python
from apis.xhs_pugongying_apis import PuGongYingAPI

pgy = PuGongYingAPI()
# 获取目标类目的 KOL 数据，交给 AI 评估匹配度
kol_list = pgy.get_some_user(num=50, cookies=cookies)
best_kols = your_ai_agent(kol_list, brand_profile)
```

---

## 🎨 爬虫效果图

### 处理后的所有用户
![image](https://github.com/cv-cat/Spider_XHS/assets/94289429/00902dbd-4da1-45bc-90bb-19f5856a04ad)

### 某个用户所有的笔记
![image](https://github.com/cv-cat/Spider_XHS/assets/94289429/880884e8-4a1d-4dc1-a4dc-e168dd0e9896)

### 某个笔记具体的内容
![image](https://github.com/cv-cat/Spider_XHS/assets/94289429/d17f3f4e-cd44-4d3a-b9f6-d880da626cc8)

### 保存的 Excel
![image](https://github.com/user-attachments/assets/707f20ed-be27-4482-89b3-a5863bc360e7)

---

## 🛠️ 快速开始

### ⛳ 环境要求

- Python 3.10+
- Node.js 20+

### 🎯 安装依赖

```bash
pip install -r requirements.txt
npm install
```

### 🎨 配置登录方式

项目运行不依赖浏览器。直接在 `spider/spider.py` 中设置：

```python
login_type = 'cookie'  # cookie / qrcode / phone
```

- `qrcode`：项目本地请求二维码，用小红书 App 扫码。
- `phone`：项目直接调用手机号验证码登录接口。
- `cookie`：用户登录后直接复制完整 Cookie，或复用本项目登录流程之前保存的完整 Cookie。

只有 `cookie` 模式需要复制 `.env.example` 为 `.env`：

```
COOKIES='your_cookie_here'
```

PC 端统一通过 `XHSPcAuth` 管理登录状态、b1、DS、MNS 环境材料和会话计数：

```python
from apis.xhs_pc_apis import XHS_Apis
from xhs_utils.xhs_pc import XHSPcAuth

# 无浏览器二维码登录
auth = XHSPcAuth.from_qrcode_login()

# 或复用已保存的登录 Cookie
# auth = XHSPcAuth.from_cookie(cookies_str)

# 三种 Auth 工厂都会返回已 bootstrap 的 PC 登录态
api = XHS_Apis(auth)
success, message, data = api.get_unread_message()
```

如果同时需要 PC 内容/直播/私信和 Creator 发布，推荐使用统一入口，只扫码（或输
入手机号）一次：

```python
from apis.xhs_creator_apis import XHS_Creator_Apis
from apis.xhs_live import XHSLiveAPI
from xhs_utils.xhs_auth import XHSUnifiedAuth
from apis.xhs_pc_apis import XHS_Apis

auth = XHSUnifiedAuth.from_qrcode_login()
try:
    pc_api = XHS_Apis(auth.pc)
    creator_api = XHS_Creator_Apis(auth.creator).bootstrap()
    live_api = XHSLiveAPI(auth.pc)
finally:
    auth.close()
```

主站和 Creator 复用同一组服务端登录 Cookie，`auth.creator` 在第一次使用时才懒
初始化；两边的 Storage、b1、MNS 和 X-s 按各自站点独立维护。仅单独使用 Creator
时也可通过兼容工厂创建：

```python
from apis.xhs_creator_apis import XHS_Creator_Apis
from xhs_utils.xhs_creator import XHSCreatorAuth

# 仅单独使用 Creator 时三选一（兼容入口）：
creator_auth = XHSCreatorAuth.from_qrcode_login()
# creator_auth = XHSCreatorAuth.from_phone_login()
# creator_auth = XHSCreatorAuth.from_cookie(完整_creator_cookie)

creator_api = XHS_Creator_Apis(creator_auth).bootstrap()
success, message, notes = creator_api.get_all_posted_notes()
```

几点说明：

- 签名与指纹（b1、MNS、X-s、X-S-Common、x-rap-param、profileData 等）全部本地纯算，算法唯一实现在 `xhs_utils/xhs_core/js/`；全程不启动、不连接浏览器。
- 二维码/手机号登录会自动完成设备初始化和 Storage 维护（webSsk 协商、直播/私信所需的 RWP token 等）；登录与发布中的概率性 406 / `code=-1` 拒绝已内置自动重试。
- `web_session` 是服务端签发的登录凭证，无法通过算法伪造；cookie 模式原样复用用户提供的完整 Cookie。
- 正常使用无需传 b1、DSL 或浏览器 Storage；这些覆盖参数仅供逆向调试和版本对齐，且只能通过 `from_cookie()` 传入。

### 🚀 运行项目

笔记链接、用户链接、搜索关键词、保存方式和搜索筛选参数直接在 `spider/spider.py` 的入口示例中修改。

```bash
python -m spider.spider
```

发布 / 直播监听 / 私信示例见根目录 `demo.py`，修改顶部参数后运行 `python demo.py`。

### 🐳 Docker 部署（可选）

```bash
docker build -t spider_xhs .
docker run -e COOKIES='your_cookie_here' spider_xhs
```

---

## 📁 项目结构

```
Spider_XHS/
├── spider/
│   ├── __init__.py
│   └── spider.py                    # 主入口：爬虫调用示例
├── demo.py                          # 扫码登录后的发布/直播/私信最小示例
├── main.py                          # PC / Creator 登录后的最小手动测试入口
├── apis/
│   ├── xhs_pc_apis.py               # 小红书PC端完整API（采集）
│   ├── xhs_creator_apis.py          # 创作者平台API（上传发布）
│   ├── xhs_pc_login_apis.py         # PC端登录（二维码/手机验证码）
│   ├── xhs_live.py                   # 直播间 HTTP/RWP/IM（抓包对齐）
│   ├── xhs_creator_login_apis.py    # 创作者平台登录
│   ├── xhs_pugongying_apis.py       # 蒲公英平台API（KOL数据）
│   └── xhs_qianfan_apis.py          # 千帆平台API（分销商数据）
├── xhs_utils/
│   ├── common_util.py               # 初始化工具（读取.env配置）
│   ├── cookie_util.py               # Cookie解析
│   ├── data_util.py                 # 数据处理（Excel保存、媒体下载）
│   ├── http_util.py                 # 公共 HTTP 超时配置
│   ├── xhs_pc/                      # PC 鉴权、状态与请求装配（js/ 为 PC 特有模板）
│   ├── xhs_creator/                 # Creator 鉴权、状态与请求装配（js/ 为 Creator 特有模板）
│   ├── xhs_core/                    # PC/Creator 共用签名算法唯一实现（js/）
│   ├── xhs_auth.py                  # PC/Creator 统一登录入口
│   ├── xhs_util.py                  # 旧导入路径兼容层
│   ├── xhs_creator_util.py          # Creator上传/发布业务数据辅助
│   ├── xhs_pugongying_util.py       # 蒲公英平台工具
│   └── xhs_qianfan_util.py          # 千帆平台工具
├── ops/                             # 运营台（选题 / 批量发布 / 账号矩阵）
│   ├── web/                         # aiohttp 接口 + 单页界面
│   └── selfcheck.py                 # 离线自检
├── xhs-promo/                       # 历史题库与一次性运营脚本
├── .env.example                     # 本地配置模板；复制为 .env 使用
├── requirements.txt
├── Dockerfile
└── package.json
```

---

## 🗝️ 注意事项

- `spider/spider.py` 是爬虫入口，可根据需求修改调用逻辑
- `apis/xhs_pc_apis.py` 包含所有 PC 端数据接口
- `apis/xhs_live.py` 提供直播间事件接收、弹幕发送与私信收发；发送端仅支持文本消息，不会发送礼物
- `apis/xhs_creator_apis.py` 包含创作者平台发布接口
- `xhs_utils/xhs_pc/` 是 PC 端鉴权、参数状态和签名算法的统一入口
- `xhs_utils/xhs_creator/` 是 Creator 端鉴权、参数状态和签名装配的统一入口
- Cookie 有时效性，失效后需重新获取
- 建议配合代理（proxies 参数）使用，降低封号风险

---

## 🍥 更新日志

| 日期 | 说明 |
|------|------|
| 23/08/09 | 首次提交 |
| 23/09/13 | API 更改 params 增加两个字段，修复图片无法下载，修复部分页面无法访问报错 |
| 23/09/16 | 修复较大视频编码问题，加入异常处理 |
| 23/09/18 | 代码重构，加入失败重试 |
| 23/09/19 | 新增下载搜索结果功能 |
| 23/10/05 | 新增跳过已下载功能，获取更详细的笔记和用户信息 |
| 23/10/08 | 上传至 PyPI，可通过 pip install 安装 |
| 23/10/17 | 搜索下载新增排序方式（综合 / 热门 / 最新） |
| 23/10/21 | 新增图形化界面，上传至 release v2.1.0 |
| 23/10/28 | Fix Bug：修复搜索功能隐藏问题 |
| 25/03/18 | 更新 API，修复部分问题 |
| 25/06/07 | 更新 search 接口，区分视频和图集下载，新增创作者平台 API |
| 25/07/15 | 更新 xs version56 & 小红书创作者接口 |
| 26/04/11 | 重构创作者平台 API（图集 / 视频上传），新增蒲公英 KOL 数据 API，新增千帆分销商 API，签名算法升级至最新版 |
| 26/04/28 | 更新 PC 端搜索与笔记详情风控参数，新增 `search_id` 当前算法与 `x-rap-param` 本地 JSVMP 生成，补充 `a1`、`web_id`、`websectiga` 等签名参数说明 |
| 26/07/25 | 更新全部算法：登录 406 自动重试、b1 会话级抖动、发布链路对齐浏览器实抓、XHR 去除 sec-ch-ua* |
| 26/09/07 | Chrome 152 复核：PC 升级 X-s 4.4.3 并加入 webSsk 协商；Creator 升级 webBuild=1.26.0；新增直播/私信接口与根目录 `demo.py` |

---

## 🧸 额外说明

1. 感谢 Star ⭐ 和 Follow，项目会持续更新
2. 作者联系方式在主页，有问题随时联系
3. 欢迎 PR 和 Issue，也欢迎关注作者其他项目
4. 如果此项目对您有帮助，欢迎请作者喝一杯奶茶 ~~（开心一整天 😊）

<div align="center">
  <img src="./author/wx_pay.png" width="380px" alt="微信赞赏码">
  <img src="./author/zfb_pay.jpg" width="380px" alt="支付宝收款码">
</div>

---

## 📈 Star 趋势

<a href="https://cvcat.site/star-history/svg?repos=cv-cat/Spider_XHS&type=Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cvcat.site/star-history/svg?repos=cv-cat/Spider_XHS&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://cvcat.site/star-history/svg?repos=cv-cat/Spider_XHS&type=Date" />
    <img alt="Star History Chart" src="https://cvcat.site/star-history/svg?repos=cv-cat/Spider_XHS&type=Date" />
  </picture>
</a>

---


## 🍔 交流群

如果你对爬虫和 AI Agent 感兴趣，可以加入群聊一起讨论~

ps: 请加群，人满或者过期 issue | wx 提醒 | qq提醒

| group-1 | group-2 | group-3 | group-4 (2000人qq群) |
|:--:|:--:|:--:|:--:|
| <img width="280" alt="group1" src="https://cvcat.site/assets/group1.jpg" /> | <img width="280" alt="group2" src="https://cvcat.site/assets/group2.jpg" /> | <img width="280" alt="group3" src="https://cvcat.site/assets/group3.jpg" /> | <img width="280" alt="group4" src="https://cvcat.site/assets/group4.jpg" /> |



