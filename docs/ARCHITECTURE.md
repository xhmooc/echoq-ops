# 项目总览与架构

## 1. 这是什么

EchoQ-Ops（应声运营）是一个跑在本机的 Windows 内容运营工作台：选题、写稿、配图、预览、发布、回收在同一个窗口里完成。

当前主线是 **Electron + TypeScript**（`desktop/`），旧版 Python 运营台已从仓库移除，仅保留其前端资源 `ops/web/static/` 作为桌面端界面。

运行形态：

- 单个 Electron 进程，主进程内起一个只监听 `127.0.0.1:8711` 的 HTTP 服务；
- 渲染进程通过 `http://127.0.0.1:8711/` 加载界面，不启用 Node 集成（`contextIsolation` + `sandbox`，仅暴露 preload 的最小 IPC）；
- 数据落本机 SQLite（better-sqlite3，WAL）；不与云端强依赖，账号、草稿、配图、发布记录均在本机。

## 2. 数据流

```
选题 topics
   │  mine（关键词 / 竞品 / 热榜）
   ▼
草稿 drafts（platform + content_type）
   │  手动创建 / 选题生成 / 定时任务生成
   ├──► 文案：本地离线模板（云端模型尚未接入 Node 主线）
   ├──► 合规：compliance
   └──► 配图（全部本机渲染，Electron 隐藏窗口截图）
          ├─ V2 模板：6 风格 × 4 版式 × 3 调色板 + 样张 + 多候选 + 外观账本
          ├─ 手绘：5 种媒材，种子可复现
          ├─ 自定义模板：模板编辑器落库 custom_templates
          ├─ 动效：5 种范式 / 多画幅 → loop.gif + motion.mp4
          ├─ 图组视频：配图轮播 + 字幕 + 配乐 → MP4
          └─ 实拍混合图：照片 + 模板 + 滤镜
   ▼
发布队列 jobs（pending → running → success / failed / pending_confirm）
   │  账号轮换、日限额、最小间隔、指数退避、风控冷却
   ▼
平台适配器
   ├─ 小红书：HTTP 签名直发（vendor/xhs_utils）
   ├─ 微信公众号：只写草稿箱
   └─ 抖音：Electron 隐藏窗口自动化
   ▼
发布记录 records → 已发布内容 published_notes（手动同步平台列表）
```

## 3. 模块边界

| 目录 | 职责 | 不应该做的事 |
| --- | --- | --- |
| `desktop/src/main/` | Electron 生命周期、窗口、单实例、协议拦截、IPC | 不写业务规则 |
| `desktop/src/core/` | 配置与路径、SQLite、账号、平台注册表、设置、加密、日志、ZIP | 不调平台接口 |
| `desktop/src/server/` | 本机 HTTP、路由、参数解析、静态资源 | 不放业务状态 |
| `desktop/src/services/` | 选题、草稿、文案、队列、定时、已发布、备份、通知 | 不直接操作 DOM |
| `desktop/src/render/` | 模板、手绘、自定义模板、动效、ffmpeg、配乐、截图与版式体检 | 不做业务判断 |
| `desktop/src/platforms/` | 小红书 / 公众号 / 抖音的登录、发布、回读 | 不碰数据库迁移 |
| `desktop/src/data/` | 公众号排版主题等静态数据 | 不含运行逻辑 |
| `desktop/public/` | 前端缺失时的最小兜底页 | 不作为正式界面 |

依赖方向：`main → server → services → (core / platforms / render) → data`。反向依赖只允许通过参数注入。

## 4. 后台任务

| 任务 | 入口 | 周期 | 说明 |
| --- | --- | --- | --- |
| 发布队列 | `services/worker.ts#startLoop` | 20 秒（`worker_poll_sec` 可调） | 条件更新领取任务，单轮最多 2 条；启动时回收遗留 `running` |
| 定时任务 | `services/schedulerEngine.ts#tickSchedules` | 主进程每 30 秒 | 找选题 / 写草稿 / 发布链路；连续失败 3 次自动暂停 |
| 已发布回读 | `POST /api/published/sync` | 手动触发 | 支持公众号与小红书；当前没有 6 小时自动同步 |

## 5. 平台适配器

| 平台 | key | 登录 | 发布 | 已发布回读 | 评论 |
| --- | --- | --- | --- | --- | --- |
| 小红书 | `xiaohongshu` | Cookie / 扫码 | HTTP + 签名 | 支持 | 支持 |
| 微信公众号 | `wechat_mp` | 扫码 | 只写草稿箱 | 已发表列表 | 精选留言（需探测） |
| 抖音 | `douyin` | 扫码 | 隐藏窗口自动化 | 支持 | 不支持 |

平台元数据（标题/正文上限、素材数量、可见范围、限流默认值）集中在 `core/platform.ts`，`GET /api/platforms` 是前端唯一数据源。接新平台的做法见 [PLATFORMS.md](PLATFORMS.md)。

## 6. 数据目录

```
%LOCALAPPDATA%\EchoQ-Ops\data\
├── ops.db               # SQLite（WAL）
├── assets/draft-<id>/   # 配图产物
├── designs/             # V2 模板 / 手绘 / 样张
├── uploads/             # 用户上传素材
├── evidence/            # 发布失败现场（截图 / DOM）
├── backups/             # 加密备份
├── logs/ops.log         # 按大小轮转
├── tmp/                 # 渲染中间文件
└── cloud_state.json     # 云端登录票据（未接入时为空）
```

`OPS_DATA_DIR` / `OPS_USER_DIR` 可覆盖。Cookie 加密密钥默认在数据目录之外（`%LOCALAPPDATA%\EchoQ-Ops\secret.key`，可用 `OPS_KEY_PATH` 覆盖），因此备份数据目录不会带出密钥。

**已知限制**：当前 `core/db.ts` 只做增量迁移，不会新建完整表结构；数据目录里必须已有一份 `ops.db`（旧版升级而来）。全新机器首次启动会在数据库层报「未找到现有数据库」。

## 7. 错误边界与安全

- 路由层统一捕获：`HttpError` → 对应状态码；业务异常带可读中文原因；未预期异常返回 8 位 `error_id` 并写日志，原始路径与外文只进日志。
- 进程级 `uncaughtException` / `unhandledRejection` 记录后主动退出，不带伤运行。
- 只接受本机请求：校验 `Host`（防 DNS rebinding）与 `Origin` / `Referer`（防 CSRF）。
- 写接口要求 `application/json`（上传走 `multipart/form-data`）；请求体上限 4MB，上传上限 128MB。
- 静态路由按目录白名单解析并做路径穿越校验；素材只信任数据目录内的文件。
- 所有窗口拦截非 `http(s)` 协议跳转，自定义协议在 session 层注册处理器，避免系统弹「获取应用」。
- 本机接口没有 Token 鉴权，安全边界仍依赖「只监听 127.0.0.1」。

## 8. 旧版说明

2026-11-26 的仓库清理移除了 Python 运营台（`ops/*.py`、`ops/web` 后端）、旧 Electron 壳（`electron/`）、旧打包脚本（`build/*.ps1`）与 `vendor/` 下除 `xhs_utils` 外的上游代码。历史设计与 Review 文档保留在 `docs/` 中，仅作参考。
