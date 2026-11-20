# 项目总览与架构

## 1. 这是什么

EchoQ-Ops 是本仓库里的「全平台内容运营台」：在原有小红书采集 / 发布能力之上，提供一条完整的内容生产链路——找选题、写草稿、生成配图、入队发布、定时执行、回收已发布内容。

产品定位是**全平台运营**，不是「小红书补丁」：

- 小红书是第一个完整适配器；
- 微信公众号、抖音已经落成接入位（规格、数据结构、页面占位、接口约定齐全），接第二个平台是「填实现」，不是改骨架。

运行形态：本机单进程 aiohttp 服务 + SQLite（WAL）+ 后台线程，默认只监听 `127.0.0.1:8710`，无云端依赖。

## 2. 数据流

```
选题池 topics
   │  mine（关键词 / 竞品 / 热榜 / 题库）
   ▼
草稿 drafts（platform + content_type）
   │  create_from_topic / create_manual
   ├──► 文案：LLM（OpenAI 兼容）→ 失败回落离线模板
   ├──► 合规：compliance_issues（标题/正文红线）
   └──► 配图：
          ├─ 免费模板 designs.py  → 数据目录 designs/
          │    画布按平台：公众号 1080×460（2.35:1 宽幅封面），其余 1080×1440
          │    出图前按实际画布做文字块碰撞/越界检查
          ├─ baoyu preset illustrator.py → 无头 Chromium 截图（Playwright 自带）
          └─ 付费出图 qwen-image（需密钥）→ 下载 PNG
   ▼
发布队列 jobs（draft_id + account_id 唯一）
   │  enqueue：校验平台就绪、账号同平台、草稿状态
   ▼
发布 worker（线程）
   │  pick_account：日限额 + 最小间隔 + 抖动 + 轮换
   │  adapter.publish()：平台实现
   ▼
发布记录 records（执行审计）
   │  成功写 remote_note_id
   ▼
已发布内容 published_notes（平台作品列表缓存）
   │  PublishedSyncThread 每 6 小时 / 手动同步
   └─► /api/published：账号、平台、时间筛选，分页
```

## 3. 模块边界

| 文件 / 目录 | 职责 | 不应该做的事 |
| --- | --- | --- |
| `ops/config.py` | 路径、默认参数、环境变量 | 不写业务逻辑 |
| `ops/db.py` | 表结构、迁移、线程内连接、事务 | 不放业务判断 |
| `ops/security.py` | Cookie Fernet 加密 | 不接触网络 |
| `ops/platforms/` | 平台适配器：内容规格、登录态、发布、回收 | 不直接操作 HTTP 路由 |
| `ops/accounts.py` | 账号 CRUD、巡检、限速、轮换、扫码会话 | 不生成内容 |
| `ops/topics.py` | 挖掘、评分、去重、入池 | 不发笔记 |
| `ops/llm.py` | OpenAI 兼容文案模型调用 | 不落库 |
| `ops/content.py` | 文案生成、合规、草稿 CRUD、平台规格归一 | 不发布 |
| `ops/designs.py` | 本地免费模板渲染 | 不调付费接口 |
| `ops/illustrator.py` | baoyu 预设、付费出图、无头截图 | 不管理草稿状态 |
| `ops/publisher.py` | 队列、重试、错误分类、发布记录 | 不决定选题 |
| `ops/published.py` | 已发布内容同步与查询 | 不写发布记录 |
| `ops/scheduler.py` | 定时任务、触发计算、运行记录、链路执行 | 不绕开队列直接发 |
| `ops/worker.py` | 三条后台线程的启停 | 不承载接口逻辑 |
| `ops/service.py` | Web / CLI 共用的业务门面 | 不直接返回 HTTP |
| `ops/web/app.py` | 组装应用：中间件、路由表、静态目录 | 不写业务规则 |
| `ops/web/routers/` | 按业务域拆分的路由与参数解析 | 不写业务规则 |
| `ops/web/common.py` | 统一响应体、错误中间件、素材校验 | 不放业务状态 |
| `ops/selfcheck.py` | 离线自检 | 不依赖真实账号 |

依赖方向：`web → service → (accounts / topics / content / publisher / scheduler / published) → platforms → vendor.apis`。反向依赖只允许通过参数注入（如 `PublishedService(accounts)`）。

## 4. 后台线程

| 线程 | 周期 | 负责 | 被什么阻塞 |
| --- | --- | --- | --- |
| `Worker` | 20 秒（可设置） | 发布队列、Cookie 巡检 | 不应被长任务阻塞 |
| `SchedulerThread` | 30 秒 | 定时任务（挖题 / 写稿 / 链路） | 可长时间运行 |
| `PublishedSyncThread` | 30 分钟检查一次，账号 6 小时到期 | 已发布内容同步，每次一个账号 | 平台网络慢，但独立线程 |

三线程拆开的目的：一条链路在挖题 / 配图时，发布队列、Cookie 巡检和内容回收仍然照常。

## 5. 平台适配器

```python
class PlatformAdapter:
    key / name / status / content_types / visibility_options
    default_daily_limit / default_min_interval_sec
    features / data_sources
    describe()            # /api/platforms 的唯一数据源
    validate(payload)     # 标题/正文/素材规格
    check_session(account)
    publish(account, payload) -> PublishOutcome
    fetch_published(account, cursor, limit) -> {ok, items, next_cursor}
    note_url(remote_note_id)
```

详细的「接新平台清单」与假设评估见 [PLATFORMS.md](PLATFORMS.md)。

## 6. 数据目录

```
%LOCALAPPDATA%\EchoQ-Ops\data\
├── ops.db               # SQLite（WAL）
├── assets/draft-<id>/   # 配图
├── designs/             # 免费模板产物
├── uploads/             # 用户上传素材
├── references/          # 免费模板参考图（不入成品）
├── logs/ops.log         # 10MB 轮转，保留 5 份
├── tmp/                 # 渲染中间文件
└── e2e/                 # 模拟端到端产物
```

源码与安装版读写同一个目录；旧的源码目录 `datas/ops` 会在首次启动时自动合并
过来（`cloud_state.json` 登录票据除外，避免把开发云端票据带进生产）。

Cookie 加密密钥**不在**数据目录：默认 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`，可用
`OPS_KEY_PATH` 覆盖。因此备份 / 同步数据目录不会连密钥一起泄露。

## 7. 错误边界

- 路由层 `_errors`：`TimeoutError → 504`，`ValueError → 400`，`KeyError → 404`；`RuntimeError` 返回具体原因 + 错误编号，其它 500 只返回错误编号，异常类名与路径只进日志。
- 发布层：内容错误直接失败；账号失效标记并换号；网络 / 风控指数退避；全失败或等待重试不会显示成功。
- 同步层：失败写入账号 `published_sync_error`，已缓存内容不受影响。
- 自检层：`python -m ops selfcheck` 覆盖 46 项离线检查，不联网。
