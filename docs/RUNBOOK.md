# 本地运行与配置

## 1. 环境要求

| 依赖 | 版本 | 用途 | 是否必需 |
| --- | --- | --- | --- |
| Windows 10 / 11 | — | 当前发布与渲染链路按 Windows 验证 | 必需 |
| Python | 3.10+ | 运营台与采集 / 发布 | 必需 |
| SQLite | Python 内置 | 本地数据 | 必需 |
| Playwright Chromium | `playwright install chromium` | 配图无头截图 | 生成配图时必需（缺省会退回本机 Edge/Chrome） |
| Node.js | 20+ | 仓库上游的签名脚本 | 采集 / 发布签名需要 |
| baoyu-xhs-images skill | — | 付费风格预设数据源 | 可选；缺失时自动回退内置清单 |

## 2. 从零安装

```powershell
cd d:\Projects\EchoQ-Ops

# 1) 创建虚拟环境
python -m venv .venv

# 2) 安装依赖
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# 需要扫码 / 付费出图等额外能力时再装：
.\.venv\Scripts\python.exe -m pip install -r requirements.extra.txt

# 3) 初始化配置
Copy-Item .env.example .env
# 编辑 .env，填入需要的 Key；没有 Key 也能用离线模板

# 4) 自检（不联网）
.\.venv\Scripts\python.exe -X utf8 -m ops selfcheck
```

`requirements.txt` 覆盖运营台与采集 / 发布主链路；`requirements.extra.txt` 是扫码、二维码渲染、付费出图等可选依赖。

## 3. 配置项

`.env` 不存在时会静默跳过，全部使用默认值。常用项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COOKIES` | 空 | 已有小红书登录 Cookie，可在「账号」页一键导入 |
| `OPS_HOST` | `127.0.0.1` | 监听地址；不要改成 `0.0.0.0` 暴露到公网 |
| `OPS_PORT` | `8710` | 端口 |
| `OPS_DATA_DIR` | `%LOCALAPPDATA%\EchoQ-Ops\data` | 数据目录；源码与安装版共用，自检会指向临时目录 |
| `OPS_KEY_PATH` | `%LOCALAPPDATA%\EchoQ-Ops\secret.key` | Cookie 加密密钥路径；默认在数据目录之外，Windows 下自动用 `icacls` 只授当前用户 |
| `OPS_SYNC_MAX_PAGES` | `20` | 单次同步最多翻页数；大账号可调大 |
| `OPS_PUBLISHED_QUERY_LIMIT` | `2000` | 已发布列表合并查询上限；超过会在 `meta.truncated` 明确提示 |
| `OPS_DRY_RUN` | 空 | `1` 时发布只写模拟记录，不真正发到平台 |
| `OPS_CLOUD_BASE_URL` | 打包版 `https://ops.echoq.cn`；源码 `http://127.0.0.1:8787` | EchoQ-Cloud 地址；登录、订阅、文案/配图中转都走它 |
| `OPS_LLM_MODEL` | `deepseek-chat` | 文案模型名（必须在云端白名单内） |
| `OPS_LLM_TIMEOUT_SEC` | `45` | 单次模型请求硬超时（含 DNS/慢速响应） |
| `OPS_LLM_TOTAL_BUDGET_SEC` | `60` | 一次生成（含压缩重写）的总预算 |
| `OPS_COPY_TIMEOUT_SEC` | `75` | 生成/洗稿接口兜底超时，超时返回 504 |
| `OPS_RENDER_TIMEOUT_SEC` | `240` | 配图渲染总超时；渲染锁排队也受此限制 |
| `OPS_BAOYU_XHS_SKILL` | `D:\Projects\baoyu-skills\skills\baoyu-xhs-images` | 配图预设目录；找不到时自动回退内置清单 |
| `OPS_BROWSER` | 自动探测 Edge / Chrome | Playwright 不可用时，兜底截图使用的浏览器可执行文件 |

可在线调整的参数在「设置」页或 `settings` 表：日限额、最小间隔、抖动、重试次数、后台线程开关、巡检间隔、默认配图风格等。

## 4. 启动

```powershell
# 推荐
run.cmd ops

# 或直接
.\.venv\Scripts\python.exe -X utf8 -m ops serve
```

打开 <http://127.0.0.1:8710>。默认只监听本机。

后台线程（发布队列、定时调度、已发布内容回收）由 `worker_auto_start=1` 自动启动；需要手动控制时在设置里关掉，再调用 `POST /api/worker/tick`。

## 5. 命令行

```powershell
.\.venv\Scripts\python.exe -X utf8 -m ops account list
.\.venv\Scripts\python.exe -X utf8 -m ops account add-cookie --name 主号
.\.venv\Scripts\python.exe -X utf8 -m ops account check
.\.venv\Scripts\python.exe -X utf8 -m ops topic mine --mode keyword --keywords "面试,秋招"
.\.venv\Scripts\python.exe -X utf8 -m ops draft create --topic-ids 1,2 --variants 2 --cards
.\.venv\Scripts\python.exe -X utf8 -m ops publish enqueue --draft-ids 3,4 --at "2026-11-14 09:00"
.\.venv\Scripts\python.exe -X utf8 -m ops publish run --limit 2
.\.venv\Scripts\python.exe -X utf8 -m ops settings show
.\.venv\Scripts\python.exe -X utf8 -m ops selfcheck
```

## 6. 日志与自检

- 日志文件：`%LOCALAPPDATA%\EchoQ-Ops\data\logs\ops.log`，单文件 10MB 轮转，保留 5 份，UTF-8。
- 控制台同时输出；接口 500 会返回一个 8 位错误编号，业务类异常还会带上人话原因（如「版式自检失败（memo/01-cover）：…（错误编号 xxx）」），用编号在日志里搜索即可定位到完整堆栈。
- 自检：`.\.venv\Scripts\python.exe -X utf8 -m ops selfcheck`，当前 46 项，不联网、不碰真实账号。
- 自检会使用临时数据目录，不会修改正式数据目录。

## 7. 常见故障

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 启动报端口占用 | `Get-NetTCPConnection -LocalPort 8710` | 停掉旧进程，或改 `OPS_PORT` |
| `.venv` 不存在 | `run.cmd` 提示 | 按第 2 节创建虚拟环境 |
| 配图风格列表为空 | `GET /api/cards/styles` | 检查 `OPS_BAOYU_XHS_SKILL`；目录缺失时会回退内置 12 种，接口不应为空；仍为空请跑自检「配图风格清单」 |
| 生成配图报找不到浏览器 | 日志 `本地渲染` / `browser` | 先执行 `python -m playwright install chromium`；仍失败再装 Edge/Chrome 或设置 `OPS_BROWSER` |
| 文案生成总是离线模板 | 看 `GET /api/cloud/status` 与日志 | 未登录先登录；已登录检查 `OPS_CLOUD_BASE_URL`、云端上游 Key 与订阅额度 |
| 生成文案转圈或提示超时 | 看返回的 `llm_error` / 日志「模型文案生成失败」 | 模型请求硬超时 45 秒，失败会优先离线兜底；接口兜底 75 秒返回 504，保留输入可直接重试；反复超时检查网络/代理或调小 `OPS_LLM_TIMEOUT_SEC` |
| 一键成稿/批量生成一直处理中 | `GET /api/tasks/{id}` 看 `deadline_at` | 任务超过预算会被看门狗标记 `failed`（「处理超时，请重试」），不会无限 running；必要时调大 `OPS_RENDER_TIMEOUT_SEC` |
| Cookie 解密失败 | 日志「密钥已更换」 | 密钥被更换或数据目录被替换，需要重新登录账号；确认 `OPS_KEY_PATH` 指向原来的密钥文件 |
| 账号显示登录失效 | 账号页「检查」 | 重新扫码或粘贴新 Cookie |
| 发布一直等待 | 队列「最近错误」 | 账号全部达到日限额 / 间隔未到；等待或调整设置 |
| 已发布内容为空 | `GET /api/published/accounts` 的 `sync_error` | 手动 `POST /api/published/sync`；登录态或平台接口失败会在账号上显示原因 |
| 数据库 locked | 日志 `database is locked` | 确认没有多个服务进程共用同一 `OPS_DATA_DIR`；WAL 下正常不会长期锁 |
| 自检失败 | 看失败项详情 | 按提示修复；平台/风格数量、迁移、队列状态都有覆盖 |

## 8. 重置与迁移

- 重置全部数据：停止服务，备份后删除 `%LOCALAPPDATA%\EchoQ-Ops\data`，重新启动会自动建库。
- 只重置账号：在账号页删除；已发布内容缓存会一并清理，发布记录保留作审计。
- 换机器：复制 `%LOCALAPPDATA%\EchoQ-Ops\data` 和密钥文件（默认 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`，或 `OPS_KEY_PATH` 指向的文件）到新机器同一路径；只复制 `ops.db` 会导致 Cookie 无法解密。登录票据不会迁移，需要重新登录一次。
- 密钥位置检查：`GET /api/health` 的 `key.outside_data_dir` 应为 `true`、`key.warning` 为空；启动日志出现「密钥检查」告警时按提示处理。
- Docker 部署见 [DEPLOY.md](DEPLOY.md)。

