# 多平台接入说明

运营台的产品定位是「全平台运营」：账号、草稿、发布队列、计划任务、发布记录都按平台区分；小红书、微信公众号、抖音三个适配器均已实现扫码登录、发布与已发布内容回收。抖音/公众号的登录、规格、失败分类与排查见 [docs/DOUYIN_WECHAT.md](docs/DOUYIN_WECHAT.md)。

## 1. 结构

```
ops/platforms/
├── base.py          # ContentSpec / VisibilityOption / PublishOutcome / PlatformAdapter
├── __init__.py      # 注册表：get_platform / list_platforms / normalize
├── browser.py       # Playwright 浏览器会话 / 跨线程扫码会话 / 二维码提取
├── errors.py        # 五类失败分类（auth/content/rate/network/platform）
├── xiaohongshu.py   # 完整实现：登录态、发布、已发布内容回收
├── wechat_mp.py     # 完整实现：扫码登录、草稿、已发表列表回收
└── douyin.py        # 完整实现：扫码登录、视频/图文发布、作品列表回收
```

业务骨架只依赖适配器接口，不直接 import 具体平台：

| 能力 | 共用骨架 | 平台差异来源 |
| --- | --- | --- |
| 账号 | `ops/accounts.py` | `check_session()`、`login_hint`、平台默认限额 |
| 草稿 | `ops/content.py` | `ContentSpec`（标题/正文字数、素材数量、视频/图文） |
| 队列与重试 | `ops/publisher.py` | `validate()`、`publish()`、`classify_error` |
| 计划任务 | `ops/scheduler.py` | `platform` 字段 + `ready` |
| 发布记录 | `ops/publisher.py` | `records.platform` |
| 各平台内容管理 | 里程碑 2 | `fetch_published()` |

## 2. 当前状态

| 平台 | key | 状态 | 内容类型 | 登录 | 发布 | 数据回收 |
| --- | --- | --- | --- | --- | --- | --- |
| 小红书 | `xiaohongshu` | 已接入 | 图文（1-18 图，标题 20，正文 1000）、视频 | Cookie / 扫码 | 已实现 | 创作平台作品列表 |
| 微信公众号 | `wechat_mp` | 已接入 | 长文（标题 64，正文 20000，封面 1 张） | 扫码（后台 Cookie + token） | 草稿（只写草稿，不群发） | 已发表列表 |
| 抖音 | `douyin` | 已接入 | 短视频（≤4GB / 15 分钟）、图文（2-35 图）；文案 ≤1000 字 | 扫码（storage_state） | 视频 / 图文 | 创作者中心作品列表 |

页面行为：

- 账号列表显示平台徽标；添加账号时按 `features.login_qr` 显示「扫码登录」，两个平台均不再接受粘贴 Cookie。
- 公众号/抖音扫码固定无头启动，不创建任何窗口，二维码只显示在运营台里；需要人工选择公众号/安全验证时只返回 `requires_window`，必须用户点击「打开验证窗口」（`POST /api/accounts/qr/{sid}/window`）才会启动可见浏览器。返回值带 `headless/mode/browser`（进程命令行与可见窗口数）用于自证。
- 创作页「发布到」可切换平台；切换后标题/正文字数、可见范围、素材数量提示随平台规格变化。
- 已有草稿切换到其它平台时，会走「复制为 X 平台草稿」，不改变原草稿；这样同一内容可以按不同平台规格分别维护。
- 内容库、发布队列、发布记录、计划任务都显示平台徽标，内容库支持按平台筛选。
- 公众号只写草稿，不占任何发布额度；群发/发表需要管理员在公众号后台人工完成。

## 3. 数据模型与迁移

新增/变更字段：

| 表 | 字段 | 默认值 |
| --- | --- | --- |
| `accounts` | `platform` | `xiaohongshu` |
| `drafts` | `platform` / `content_type` | `xiaohongshu` / `image_text` |
| `jobs` | `platform` | `xiaohongshu` |
| `records` | `platform` | `xiaohongshu` |
| `published_notes` | `platform` | `xiaohongshu`（按账号 + 远端笔记 ID 唯一） |
| `schedules` | `platform` | `xiaohongshu` |

迁移在 `ops/db.py::init_db` 的同一个事务里完成：

1. `_migrate_jobs_multi_account` 先升级旧版 jobs 唯一约束（一稿一号 → 一稿一账号），避免重建时丢列；
2. `_migrate_columns` 补 `platform` / `content_type`，并按 `media_type='video'` 回填视频草稿的 `content_type`；
3. 最后创建平台索引。

现有账号、草稿、任务、记录、计划全部自动归到小红书，无需人工处理；迁移失败整体回滚。

## 4. 接新平台清单

以「接入抖音」为例，按顺序做：

1. **建适配器**：在 `ops/platforms/douyin.py` 填 `content_types`（标题/正文字数、图片数量、是否必须视频）、`visibility_options`、`default_daily_limit`、`default_min_interval_sec`、`topic_style`、`features`、`data_sources`。
2. **登记注册表**：`ops/platforms/__init__.py` 的 `_BUILTIN` 与 `_ORDER` 加入 key；`status` 改成 `ready`。
3. **登录**：在 `AccountManager` 增加该平台的接入方法（Cookie 或扫码），落库时写 `platform`；`add_cookie/add_pc_auth` 里 `_require_ready` 已经会拦截未就绪平台。
4. **登录态检查**：实现 `check_session(account)`，返回 `{ok, message, nickname, red_id/user_id/system_user_id}`；`AccountManager.check_health` 会自动路由。
5. **发布**：实现 `publish(account, payload) -> PublishOutcome`。payload 已包含 `title/desc/media_type/images/topics/type/platform/content_type`；需要的额外素材（抖音视频）在 `DraftService.payload` 增加字段。
6. **发布前校验**：复用 `validate()`；平台特有规则（如视频时长、封面尺寸）在子类里追加，返回中文问题列表。
7. **内容回收**：实现 `fetch_published(account, cursor, limit)`，返回 `{ok, message, items, next_cursor}`；item 统一字段见第 6 节。落库、同步频率与失败提示在里程碑 2 的账号内容页统一处理。
8. **页面**：一般不用改骨架。平台选择、账号徽标、内容库筛选、计划任务平台都由注册表驱动；只有需要专属图标/文案/编辑器时才改 `platformBadge` 或对应页面的局部。
9. **自检**：在 `ops/selfcheck.py` 增加该平台的规格、发布拦截、内容归一化用例；跑 `python -m ops selfcheck`。
10. **文档**：更新本文件第 2 节的接入状态与已知缺口。

**不需要改的地方**：`db.py` 的表结构（`platform` 字段已通用）、发布队列的入队/重试/限速、计划任务引擎、发布记录、导航与页面骨架。

## 5. 多平台后哪些旧假设不成立

| 旧假设 | 多平台后的问题 | 当前处理 |
| --- | --- | --- |
| 一稿只能投一个账号 | 同一内容需要多账号分发 | 已支持一稿多号（`UNIQUE(draft_id, account_id)`，`enqueue_targets`） |
| 一稿可以投任意账号 | 小红书草稿不能投抖音账号 | 入队时校验草稿平台与账号平台一致，不一致直接报中文错误 |
| 一稿可以直接重发到另一个平台 | 标题/正文/素材规格不同（抖音要视频、公众号要长文） | 草稿带 `platform + content_type`；切换平台时复制为新草稿，原稿不变 |
| 日限额固定 3 篇、间隔 45 分钟 | 公众号只写草稿、不占额度；抖音节奏不同 | 平台默认值写在适配器；账号级覆盖优先；小红书沿用全局设置 |
| 可见范围只有公开/仅自己可见 | 抖音还有好友可见等 | `visibility_options` 平台声明，页面动态渲染 |
| 话题一律 `#标签` | 公众号是「话题」而非 `#` | `topic_style` 声明（hashtag/topic/none） |
| 配图/模型计费与平台无关 | 视频生成、长文排版可能引入新成本 | 现有费用仍按生成次数计；新平台接入时在 `describe()` 增加 costs，页面在付费按钮旁展示 |
| 合规红线一套通用 | 公众号长文、抖音口播的合规边界不同 | 当前红线仍以小红书为主；接平台时在 `compliance_issues` 增加平台参数，按平台启用规则 |
| Cookie 是唯一登录态 | 公众号/抖音多为扫码 + 后台权限 | `features.login_cookie / login_qr` 声明；账号页按能力显示入口 |
| 素材只有图片上传 | 抖音视频需要视频文件 | `ContentSpec.media_type=video` 已声明；视频上传通道尚未实现（见缺口） |
| 阅读数 = 小眼睛 | 抖音是播放量、公众号是阅读数 | 统一字段 `views`，页面标注平台口径 |

## 6. 适配器接口约定

```python
class PlatformAdapter:
    key: str                     # 唯一 key，落在数据库 platform 字段
    name: str                    # 中文全名
    status: str                  # ready / planned
    content_types: tuple[ContentSpec, ...]
    visibility_options: tuple[VisibilityOption, ...]
    default_daily_limit: int
    default_min_interval_sec: int
    features: dict[str, bool]    # login_cookie / login_qr / publish / fetch_published / schedule
    data_sources: tuple[str, ...]

    def describe(self) -> dict                 # 页面与 /api/platforms 的唯一数据源
    def validate(self, payload, content_type="") -> list[str]
    def check_session(self, account) -> dict
    def publish(self, account, payload) -> PublishOutcome
    def fetch_published(self, account, *, cursor=0, limit=30) -> dict
```

`fetch_published` 的 item 统一字段：

```
remote_note_id, title, desc, cover, note_type(image|video),
visibility, views, likes, collects, comments, published_at, url, raw
```

## 7. 已知缺口（明确未完成）

- 抖音/公众号的 **真实扫码与发布** 需要人工各验收一次；自动化测试不替代平台侧验收，步骤见 [docs/DOUYIN_WECHAT.md](docs/DOUYIN_WECHAT.md) 第 8 节。
- 公众号正文目前是纯文本转段落 HTML，不包含复杂排版、内嵌多图、视频/音频素材；封面只支持单图。
- 公众号只调用网页后台的草稿接口；`/cgi-bin/masssend` 不再使用，群发需后台人工确认。
- 抖音发布依赖创作者中心页面结构；改版后会提示「找不到上传入口/发布按钮」，需要更新选择器。
- 抖音回收在接口探测失败时退回 DOM，此时播放/点赞/评论等指标为空是预期行为。
- 视频上传通道：后端草稿的 `images[0]` 作为视频路径，创作页仍需补视频选择与封面抽帧交互。
- 公众号长文编辑器：创作页仍是短图文编辑器，长文排版需要单独编辑区。
- 跨平台数据对比：同一内容在不同平台的阅读/互动对比尚未做。
- 平台级代理与额度：代理仍按账号配置，未做平台级策略。

以上缺口在页面上不再表现成「假装成功」：平台变更会返回 `platform` 分类，内容超规格会在入队前给出中文原因，登录失效会把账号标记为 `expired` 并要求重新扫码。
