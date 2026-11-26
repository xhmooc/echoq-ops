# 抖音 / 微信公众号接入说明

本文只讲这两个平台的接入细节、扫码登录用法和失败排查。平台抽象、接新平台
清单见 [PLATFORMS.md](PLATFORMS.md)。

## 1. 为什么走浏览器自动化

抖音创作者中心、微信公众平台都没有面向第三方的「扫码登录 + 发布」公开 API：

- 抖音开放平台的视频上传 API 需要应用审核和 access_token，不适合运营台直接
  绑定个人账号；创作者中心的发布链路是前端签名接口。
- 公众号服务端 API 需要 AppID/AppSecret，且「发布」能力在 2025 年后收紧；
  扫码登录拿到的是网页后台会话，只能操作网页后台的非公开接口。

因此两个平台都按「真实浏览器登录 + 保存会话 + 后台接口/页面操作」实现，和
成熟开源项目的路线一致。

## 2. 参考项目核实

下表是 2026-11-15 用 `gh api repos/<owner>/<repo>` 查到的真实数据，不是凭印象
填的；「实际读了什么」区分了「读了源码」和「只读了 README」，没有读源码的会
明确标注。

| 项目 | 仓库地址 | Star | 最近推送 | 实际读了什么 | 借鉴了哪一部分 |
| --- | --- | --- | --- | --- | --- |
| social-auto-upload | https://github.com/dreammis/social-auto-upload | 16560 | 2026-10-22 | README、`skills/douyin-upload/SKILL.md`、`uploader/douyin_uploader/main.py` | 抖音扫码二维码选择器（`div#animate_qrcode_container img`、`role=img[name=二维码]`）；登录后保存 `storage_state` 并校验 `sessionid`；上传页选择器 `input.upload-btn-input`、`input[placeholder*="填写作品标题"]`、`div.zone-container[contenteditable]`；`get_by_role("button", name="发布", exact=True)`、`get_by_text("发布图文", exact=True)`；短信验证码等待时机；发布后跳转 `content/manage` 判定 |
| md2wechat-skill | https://github.com/geekjourneyx/md2wechat-skill | 3802 | 2026-10-14 | README 与配置说明 | 只借鉴「草稿优先、正文排版后再保存」的产品边界。**它走 AppID/AppSecret 官方 API，没有扫码登录**，登录方案未采用 |
| wewrite | https://github.com/imraywang/wewrite | 3714 | 2026-11-09 | 只读 README | 同样走 AppID/AppSecret + 官方 API，不能扫码登录，未采用 |
| Wechatsync | https://github.com/wechatsync/Wechatsync | 6631 | 2026-11-15 | 只读 README | 浏览器扩展，复用用户已登录的浏览器；公众号在其中是「来源平台」而不是发布目标，不适用 |
| doocs/md | https://github.com/doocs/md | 13541 | 2026-11-14 | 只读 README/元数据 | 纯 Markdown 排版编辑器，不覆盖登录与发布，未采用 |
| wechat_articles_spider | https://github.com/wnma3mz/wechat_articles_spider | 3486 | 2024-04-18 | 只读 README | 「Cookie + token 获取已发表列表」的思路；已停更，未读源码，不作为登录方案 |
| wechat-official-studio-mcp | https://github.com/zero-times/wechat-official-studio-mcp | 1 | 2026-09-07 | README、`src/services/wechat-client.ts`、`src/services/parsers.ts`、`src/constants.ts`、`src/index.ts` | 公众号后台的登录态判定正则与文案；`base_resp.ret` 映射（`-6`/`-14`/`200003`/`200013`）；非 JSON/重定向写请求识别；`ticket/user_name/svr_time` 素材上传上下文；`buildDraftPayload` 的 `AppMsgId/req/idx_infos/copyright_type0` 字段；`/cgi-bin/appmsgpublish` 的 `publish_page → publish_list → appmsgex` 解析；`readNum/likeNum/shareNum/commentNum` 指标名。**Star 只有 1，不能称为成熟高星项目**，只作为「后台接口字段」的对照 |
| baoyu-skills | https://github.com/JimLiu/baoyu-skills | 27574 | 2026-11-06 | `skills/baoyu-post-to-wechat/SKILL.md`、`references/article-posting.md`、`references/config/first-time-setup.md`、`scripts/wechat-remote-publish.ts`、`wechat-socks-http.ts`、`wechat-extend-config.ts`、`wechat-api.ts` | ①官方 API 只做 `draft/add`，不做群发——据此删除了本项目错误的 `mass_send`；②SSH SOCKS5 远程发布（`ssh -N -T -D` + 类型化 `remote_publish_*`、仅密钥认证、不透传任意 ssh 参数）作为官方 API 通道的备选方案记录，未启用；③其 `browser` 方式依赖可见 Chrome + 剪贴板，与「不弹窗口」冲突，未采用 |
| wechat-publisher | https://github.com/jiji262/wechat-publisher | 297 | 2026-10-30 | 只看了搜索结果与仓库元数据，未读源码 | 无，只用于确认社区实现路线 |
| dsh-douyin-agent | https://github.com/Summer77177/dsh-douyin-agent | 0 | — | 只看了插件市场/搜索摘要 | 无。与 DSH 宿主窗口耦合，明确不选 |

诚实说明：上表里真正「逐行读源码并据此改代码」的是 `social-auto-upload`（抖音
页面动作）、`wechat-official-studio-mcp`（公众号后台接口）和
`baoyu-skills`（确认官方 API 只写草稿、远程发布的安全边界）；其余高星项目只读
README 判断路线，没有搬代码。`baoyu-skills` 的官方 API / SSH 远程通道没有落地，
因为那需要每个账号提供 AppID/AppSecret，而本项目目前是扫码接入。

### 抖音选型复核

用 `gh search repos "douyin upload" --sort stars` 与「抖音 自动发布」复查后，
star 排序靠前的依次是：social-auto-upload（16560）、withwz/douyin_upload（163）、
WJZ-P/douyin-upload-mcp-skill（92）、xiaoliangliang/auto-publish（27），其余均
在 15 star 以下且多数已停更。**没有漏掉更高星或更活跃的方案**，因此抖音继续
以 social-auto-upload 的页面动作为准。

### 公众号选型复核

公众号方向 star 更高的是 doocs/md（13541）、Wechatsync（6631）、
md2wechat-skill（3802）、wewrite（3714）、wechat_articles_spider（3486），但：

- doocs/md 只做排版，不登录、不发布；
- md2wechat-skill / wewrite 走官方 AppID/AppSecret，**无法满足「扫码接入个人号」**；
- Wechatsync 是扩展，依赖用户自己已登录的浏览器，不能做成服务端账号；
- wechat_articles_spider 只读不写，且已停更。

所以「浏览器扫码 + 网页后台接口」仍是唯一能同时满足扫码接入和写草稿的路线；
高星项目只在「草稿优先」这一产品边界上作为对照。

公众号**只写草稿，不做群发**：

- **草稿**：只写入草稿箱，不推送给关注者，可反复修改；
- **群发/发表**：网页后台没有可稳定自动化的群发接口，官方 API 的群发/发布还需要
  额外权限；本适配器不再调用 `masssend`，请管理员到公众号后台确认后手动发表。

之前版本里的 `mass_send` / `visibility=0` 是错误假设，已删除；历史 payload 里带
`action=mass_send` 会被明确拒绝，而不是伪造成成功。

## 3. 扫码登录怎么用

### 窗口策略：默认真正无头，不创建任何窗口

扫码固定 `headless=True`，由 Chromium 自己保证不创建窗口，任务栏也不会出现
图标；**不提供「启动即有窗口」的开关，也彻底移除了「有头启动 + 把窗口挪到
屏幕外」的方案**（那种做法在 Windows 上任务栏仍会闪图标）。

无头模式下二维码的获取顺序：`img` 的 data URL → HTTP 原图 → 元素截图 →
按包围盒裁剪截图。公众号二维码原图只有约 122px 且没有静默区，代码会给它补
白边并整数放大到 300px 以上（实测放大后 cv2 与手机都能识别）。

只有平台强制要求人工交互时才可能出现窗口，且必须由用户点击：

1. 会话状态变为 `needs_action`，返回 `requires_window=true` 和 `notice`
   （如「检测到多个公众号，需要人工选择目标号。点击「打开验证窗口」后会弹出
   一个浏览器窗口」），**此时不会自动弹窗**；
2. 用户点击后，界面调用 `POST /api/accounts/qr/{id}/window`；服务端保存当前
   `storage_state`，关闭无头浏览器，用同一份登录态启动可见浏览器；
3. 120 秒内完成选择/验证，结束后窗口关闭，登录态照常加密落库。

登录态与窗口模式无关：扫完后 Cookie / `storage_state` / `token` 一律加密落库，
后续发布、回收、健康检查都在无头下复用，不需要再次扫码。

### 自证字段

`GET /api/accounts/qr/{id}` 的返回里带有：

- `mode`：`headless` / `visible`；`headless`：本次会话是否以无头启动；
- `requires_window`：需要人工但窗口还没打开（界面据此显示按钮）；
- `window_open`：用户已经点了「打开验证窗口」；
- `browser.headless_flag`：浏览器主进程命令行里是否真有 `--headless`；
- `browser.visible_windows`：枚举该浏览器进程的可见顶层窗口数量，应为 0；
- `browser.browser_processes[]`：pid、命令行（截断 600 字）。

### 用户视角完整流程（点击「接入账号」→ 扫码完成）

1. 在账号页点「接入账号」并选择「抖音」或「微信公众号」；
2. 界面调用 `POST /api/accounts/qr`，把返回的 `qr` 直接渲染成二维码图片；
   **此时不会创建任何浏览器窗口，任务栏也不会出现图标**；
3. 用户用手机扫码并在手机上确认登录；
4. 界面每 2 秒轮询 `GET /api/accounts/qr/{id}`：
   - 常规情况：`waiting → scanned → confirmed`，全程无窗口；
   - 公众号登录了多个账号时：状态变为 `needs_action`，返回
     `requires_window=true` 与提示文案，界面显示「打开验证窗口」按钮；用户
     点击后才出现窗口，选完自动关闭；
   - 抖音触发安全验证/短信验证时同理；
5. 状态变为 `confirmed` 后，界面调用
   `POST /api/accounts/qr/{id}/save` 保存账号名，会话加密入库；
6. 之后发布、回收、`check_session` 都不再需要人工介入。

### 接口

```http
POST /api/accounts/qr
Content-Type: application/json

{"platform": "douyin"}          # 或 "wechat_mp"
```

返回：

```json
{"ok": true, "data": {"session_id": "qr...", "qr": "data:image/png;base64,...", "platform": "douyin"}}
```

前端把 `qr` 直接放进 `<img src>`，每 2 秒轮询：

```http
GET /api/accounts/qr/{session_id}
```

状态：`starting` → `waiting` → `scanned` → `confirmed` / `expired` / `error`；
需要人工在页面上操作时会有一次 `needs_action`（附带 `requires_window`、`notice`、
`window_open`）。确认后保存账号：

```http
POST /api/accounts/qr/{session_id}/save
Content-Type: application/json

{"name": "我的抖音号"}
```

公众号扫码后如果后台一次登录了多个公众号，会先返回 `needs_action` 和
`requires_window=true`，**不会自动弹窗**；用户点击「打开验证窗口」后调用：

```http
POST /api/accounts/qr/{session_id}/window
```

服务端才会用当前 `storage_state` 启动一个可见浏览器，120 秒内完成选择后窗口
自动关闭，会话变为 `confirmed`。不在 `needs_action` 状态时调用该接口会返回
「当前步骤不需要人工验证窗口」。

### 浏览器依赖

```powershell
.\.venv\Scripts\python.exe -m pip install playwright
```

Windows 默认复用系统 Edge（`channel=msedge`），不需要再下载 Chromium。可用
环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `OPS_BROWSER_CHANNEL` | `msedge` / `chrome` / 空（内置 Chromium） |
| `OPS_BROWSER_EXECUTABLE` | 指定浏览器可执行文件 |
| `OPS_BROWSER_HEADLESS` | 后台发布/回收默认 `1`（无头） |
| `OPS_BROWSER_PROXY` | 浏览器代理 |
| `OPS_BROWSER_TIMEOUT_MS` | 默认操作超时，默认 45000 |

扫码流程不使用任何「窗口模式」环境变量：启动时固定无头，只有用户点
「打开验证窗口」才会创建可见浏览器。

### 无头失败时的回退路径

无头不是「隐藏错误」：如果某个平台在无头下拿不到二维码，会如实返回失败环节，
不会退回窗口坐标把戏。

| 触发条件 | 处理 | 用户看到什么 |
| --- | --- | --- |
| 无头下登录页不出二维码 | 抛 `platform` 失败，`detail` 带页面 URL，提示「登录页没有出现二维码，平台可能要求安全验证或页面已改版」 | 明确错误，不会静默卡在 `waiting` |
| 平台检测自动化（UA/指纹） | 已知可选方案：改 UA/语言/时区（已设置 zh-CN、Asia/Shanghai）、或 CDP 附加到用户已开的浏览器；当前未默认启用 | 先按错误提示处理，必要时人工在本机登录后复用会话 |
| 需要人工选择/验证 | 只返回 `needs_action`，等用户点「打开验证窗口」；无头进程本身不会弹窗 | 先看到提示和按钮，点击后才出现窗口 |
| 服务器没有图形环境 | 扫码启动时就不会创建任何窗口；人工步骤只能由用户在本机完成后再复用会话 | 界面显示「需要人工操作」，不会卡住 |
| 平台强制要求人工且无法自动化 | 会话置为 `error`，分类 `platform`，不自动重试 | 提示人工完成后重新发起扫码 |

### 登录态存哪里

`accounts.cookie_enc` 加密保存 JSON：

- 抖音：`storage_state`（Cookie + localStorage）、`cookies`、昵称、抖音号、
  `sec_uid`；
- 公众号：`cookies`、`cookie_header`、后台 `token`、`fakeid`、昵称、预计过期时间。

每次发布/回收/健康检查后会把轮换后的 Cookie 回写，不需要用户反复登录。

## 4. 发布

### 抖音

| 内容类型 | 规格 | 说明 |
| --- | --- | --- |
| 视频 `video` | 1 个视频，≤4GB，≤15 分钟；文案（标题+正文）≤1000 字，标题 ≤55 字 | 视频格式 mp4/mov/webm/avi/mkv/flv/wmv/m4v |
| 图文 `image_text` | 2-35 张图片；文案（标题+正文）≤1000 字，标题 ≤55 字 | 单张图片 ≤20MB |

可见范围：`0` 公开、`1` 仅自己可见、`2` 好友可见。

流程：打开创作者中心上传页 → 写入视频/图片 → 填写文案 → 选择可见范围 →
点击「发布」→ 等待跳转内容管理页或成功提示，并从发布接口响应里取 `aweme_id`。

### 公众号

| 动作 | 触发方式 | 结果 |
| --- | --- | --- |
| 保存草稿 `draft` | 默认行为；显式传 `action=draft`，或 `visibility=1` | 只进草稿箱，不推送 |
| 群发 `mass_send` | 不再支持 | 返回「公众号只支持保存草稿；群发/发表请在公众号后台人工完成」 |

规格：标题 ≤64 字，正文 ≤20000 字，必须 1 张封面（jpg/jpeg/png，≤10MB）。

防重复：重试时会先按标题查找 10 分钟内创建的草稿并复用，避免每次重试都新建
一篇草稿；草稿不占任何发布额度，也不会刷新账号的「上次发布时间」。

## 5. 已发布内容回收

统一写入 `published_notes`，缺失字段保持 `NULL`，页面显示为空白，不写 0。

| 平台 | 标题 | 封面 | 时间 | 阅读/播放 | 点赞 | 评论 | 其它 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 抖音 | `desc` 首行/标题 | 视频封面或首图 | `create_time` | `play_count` → `views` | `digg_count` → `likes` | `comment_count` → `comments` | `collect_count` → `collects` |
| 公众号 | `title` | `cover` | `create_time` | `read_num` → `views` | `like_num` → `likes` | 列表通常不返回，留空 | `old_like_num`（在看）→ `collects` |

抖音优先在页面上下文请求创作者作品列表接口，路径随版本变化时按候选列表探测；
全部失败后退回页面 DOM，只保留标题、封面、链接等可见字段，指标留空。公众号
依次尝试「已发表列表」「草稿/发表列表」「freepublish 列表」三类后台接口，命中
第一个返回数据的接口。

## 6. 失败分类与重试

| 分类 | 典型原因 | 队列行为 |
| --- | --- | --- |
| `auth` 登录失效 | Cookie 过期、token 失效、被踢下线 | 标记账号 `expired`，换号重试；无可用账号时等待重新扫码 |
| `content` 内容不合规 | 标题/正文超长、图片数量不对、格式不支持、平台判定违规 | 直接失败，不重试 |
| `rate` 平台限流 | 操作频繁、群发次数用完、触发风控 | 至少退避 15 分钟再试，最多 4 次 |
| `network` 网络异常 | 超时、连接失败、上传中断 | 指数退避（1/2/4 分钟，带随机抖动） |
| `platform` 平台变更 | 找不到二维码/发布按钮/上传入口、接口返回非 JSON | 直接失败，提示人工更新适配器，不自动重试 |

适配器在失败时直接返回 `PublishOutcome.kind`，队列不再靠猜文案；只有适配器没
给分类时才用 `classify_error()` 兜底。

## 7. 排查手册

### 二维码出不来

1. 确认 `playwright` 已安装，且本机能手动打开
   `https://creator.douyin.com/` 或 `https://mp.weixin.qq.com/`；
2. 把 `OPS_QR_MODE` 临时改成 `visible` 后重试，观察是否弹出安全验证；
3. 抖音登录页 class 名是随机哈希，代码会按「120-400px 正方形 data:image」兜底，
   如果仍取不到，保存页面截图并更新 `_QR_IMG_SELECTORS`；
4. 公众号二维码失效后需要重新发起扫码，不会自动刷新。

### 扫码时仍然弹出了窗口

扫码启动固定无头，正常扫码不会创建任何窗口。如果确实看到了窗口：

1. 先看 `GET /api/accounts/qr/{id}` 返回的 `mode`：`visible` 只会在用户点过
   「打开验证窗口」之后出现；如果没点却看到窗口，按第 2 步取证；
2. 如果 `mode=headless` 但仍有窗口，检查 `browser.headless_flag` 是否为 `true`、
   `browser.visible_windows` 是否为 `0`，并把 `browser.browser_processes[].command_line`
   贴出来核对；
3. 只有 `requires_window=true` 且用户点过「打开验证窗口」之后才允许出现窗口，
   若没有点也出现了，请按第 2 步的进程命令行定位是哪段代码启动了有头浏览器。

### 扫码后一直是 scanned

手机端通常还有「确认登录」步骤；公众号多账号时界面会出现「打开验证窗口」按钮，
点开后 120 秒内完成选择。完成后再轮询一次。超过 5 分钟会话自动过期。

### 抖音发布找不到上传入口/发布按钮

说明创作者中心改版。先人工打开上传页确认按钮文案和 DOM，再更新
`ops/platforms/douyin.py` 里的 `_file_input()` / `_submit()` 选择器。这类失败
会归类为 `platform`，不会反复重试浪费账号次数。

### 抖音上传成功但发布结果未确认

页面可能在二次审核。先到创作者中心「作品管理」确认；代码若已从接口响应拿到
`aweme_id` 会按成功处理，避免重复发布。没有拿到 ID 时会提示「发布结果未确认」。

### 公众号草稿保存失败 / 登录后拿不到 token

草稿失败时结果里可能已经带 `draft_id`，先到后台草稿箱确认是否已生成；重试时会
按标题复用 10 分钟内的草稿，不会重复创建。

扫码确认后如果一直停在「已登录，正在等待公众平台后台 token…」，代码会先让页面
自己完成跳转（最多 6 秒），再主动进后台，并从 URL、页面 HTML、JS 变量里继续找
token，最多等 30 秒；仍然拿不到才判失败，日志里会记录当时的 URL 和 Cookie 名。
常见原因：多公众号未选择、后台跳转被安全验证拦截、平台限制无头登录。先重试
一次，仍失败再按第 3 节的无头回退路径处理。

### 公众号提示非 JSON / 接口改版

网页后台接口未公开，微信改版后可能整体失效。用有头浏览器打开后台，抓
`/cgi-bin/appmsg`、`/cgi-bin/operate_appmsg` 的实际请求，同步更新路径和参数；
失败会被归为 `platform`，不会伪装成功。群发接口 `/cgi-bin/masssend` 已不再调用。

### 回收列表为空但后台有文章

1. 先确认账号 `check_session` 是否正常；
2. 公众号会依次探测三类列表接口，若都返回空，检查 `fakeid` 是否解析到；
3. 抖音接口失败会退回 DOM，DOM 只能拿到标题/封面/链接，指标为空是预期行为。

## 8. 人工验收清单

自动化测试覆盖规格、分类、会话存储和字段归一化；真实扫码和发布必须由人工
完成一次验收：

1. `POST /api/accounts/qr {"platform":"douyin"}`，用抖音 App 扫码，确认账号
   入库且 `check_session` 返回正常；
2. 用一条 10 秒测试视频走「发布 → 作品管理」，确认能拿到 `aweme_id`；
3. 用 2 张测试图片走图文发布；
4. 公众号扫码，保存草稿，到后台草稿箱确认标题/封面/正文；
5. 在公众号后台人工确认草稿后发表，确认手机端收到；校对完再执行一次回收；
6. 两个平台各执行一次内容回收，核对阅读/播放、点赞、评论是否与后台一致，
   平台没返回的字段应为空白；
7. 故意让账号退出登录，确认发布失败分类为 `auth` 且账号状态变为 `expired`。

## 9. 维护边界

- 平台页面/接口变更时只改 `ops/platforms/douyin.py`、`ops/platforms/wechat_mp.py`
  和本文件，不改发布队列、数据库和页面骨架；
- 新增选择器要保留旧选择器作为候选，避免一次改版就完全失效；
- 不要把「草稿保存成功」当成「已发表」，也不要在没有远端 ID 时伪造 ID；
- 平台未返回的指标保持空值，禁止补 0。
