# 本地运行与配置

## 1. 环境要求

| 依赖 | 版本 | 用途 | 是否必需 |
| --- | --- | --- | --- |
| Windows 10 / 11 x64 | — | 当前发布与渲染链路按 Windows 验证 | 必需 |
| Node.js | 20+ | 源码运行与打包 | 仅开发需要 |
| 已有数据目录 | `%LOCALAPPDATA%\EchoQ-Ops\data\ops.db` | 数据库与账号历史数据 | 必需（见第 2 节） |
| ffmpeg | 内置 | 动效 GIF / MP4、图组视频 | 安装包已随附；源码运行需 `desktop/vendor/ffmpeg/ffmpeg.exe` |

安装包用户不需要 Node，也不需要单独安装 ffmpeg。

## 2. 从源码运行

```powershell
cd d:\Projects\EchoQ-Ops\desktop
npm install
npm run dev
```

`npm run dev` 会先执行 `tsc` 编译到 `desktop/dist`，再启动 Electron。界面由本机服务 `http://127.0.0.1:8711/` 提供，前端文件来自仓库的 `ops/web/static/`。

**首次启动前提**：数据目录必须已有 `ops.db`。当前 `core/db.ts` 不会建完整表结构（只做增量迁移），全新机器直接启动会报「未找到现有数据库」。需要从旧版客户端升级，或把旧数据目录复制到 `%LOCALAPPDATA%\EchoQ-Ops\data`。

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 只做 TypeScript 编译 |
| `npm start` | 直接启动已编译产物 |
| `npm run dist` | 生成安装版与免安装版到 `../release/desktop` |

`npm run dist` 会先执行 `scripts/ensure-ffmpeg.mjs`（补齐 ffmpeg）与 `scripts/gen-bgm.mjs`（生成 3 条内置配乐），再调用 electron-builder。

## 3. 配置项

配置通过环境变量注入，没有 `.env` 自动加载逻辑。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPS_USER_DIR` | `%LOCALAPPDATA%\EchoQ-Ops` | 用户目录（数据与密钥的父目录） |
| `OPS_DATA_DIR` | `%LOCALAPPDATA%\EchoQ-Ops\data` | 数据目录；调试时可指向隔离目录 |
| `OPS_KEY_PATH` | `%LOCALAPPDATA%\EchoQ-Ops\secret.key` | Cookie 加密密钥路径 |
| `OPS_DESKTOP_PORT` | `8711` | 本机 HTTP 端口 |
| `OPS_CLOUD_BASE_URL` | `http://127.0.0.1:8787` | EchoQ-Cloud 地址；登录、版本检查走它 |
| `OPS_DRY_RUN` | 空 | `1` 时发布只写模拟记录，不真正发到平台 |
| `OPS_PUBLISHED_QUERY_LIMIT` | `2000` | 已发布列表查询上限 |
| `OPS_CHANNEL` / `OPS_APP_VERSION` / `OPS_VERSION` | 空 / `0.1.0` | 版本检查与渠道标识 |
| `OPS_DESKTOP_QUIET` | 空 | 静默启动相关开关 |

可在线调整的参数在「设置」页或 `settings` 表：日限额、最小间隔、重试次数、发布轮询间隔等。

## 4. 日志与错误定位

- 日志文件：`%LOCALAPPDATA%\EchoQ-Ops\data\logs\ops.log`，按大小轮转。
- 接口 500 返回 8 位错误编号，用编号在日志中搜索可定位完整堆栈；业务类异常会同时返回可读中文原因。
- 发布失败现场（抖音截图、DOM 快照）在 `data/evidence/`，通过 `/evidence/{filename}` 查看。

## 5. 常见故障

| 现象 | 排查 | 处理 |
| --- | --- | --- |
| 启动提示「未找到现有数据库」 | 检查 `data/ops.db` 是否存在 | 从旧版升级或复制旧数据目录；当前版本不会自动建库 |
| 端口 8711 被占用 | `Get-NetTCPConnection -LocalPort 8711` | 结束残留进程，或用 `OPS_DESKTOP_PORT` 另起 |
| 动图 / 图组视频提示缺少 ffmpeg | 日志中的 ffmpeg 路径 | 安装包应自带；源码运行执行 `node scripts/ensure-ffmpeg.mjs` |
| 文案始终是离线模板 | `GET /api/settings` 的 `llm.offline_only` | 当前 Node 主线尚未接入云端模型，属于预期行为 |
| 已发布内容为空 | `GET /api/published/accounts` 的 `sync_error` | 手动调用 `POST /api/published/sync`；当前没有自动同步 |
| 扫码后一直等待 | 账号页状态 / 日志 | 公众号或抖音需要人工验证时，点「打开验证窗口」 |
| Cookie 解密失败 | 日志中的密钥提示 | 密钥被更换或数据目录被替换，需要重新登录账号 |
| 发布一直等待 | 队列「最近错误」 | 账号达到日限额 / 间隔未到 / 冷却中；等待或调整设置 |
| 数据库 locked | 日志 `database is locked` | 确认没有多个进程共用同一 `OPS_DATA_DIR` |

## 6. 重置与迁移

- 只重置账号：在账号页删除；已发布内容缓存一并清理，发布记录保留。
- 换机器：复制 `%LOCALAPPDATA%\EchoQ-Ops\data` 与 `secret.key` 到新机器同一路径。只复制 `ops.db` 会导致 Cookie 无法解密。
- 密钥位置检查：`GET /api/health` 的 `key.outside_data_dir` 应为 `true`。
- 备份与恢复：界面「备份」页创建 `.eqbak`（默认不含图片与密钥），恢复前会自动生成 `prerestore-*.eqbak`。

## 7. 打包与产物

```powershell
cd desktop
npm run dist
```

产物在 `release/desktop/`：

- `EchoQ-Ops-Next-Setup-<version>.exe`（NSIS 安装版）
- `EchoQ-Ops-Next-Portable-<version>.exe`（免安装版）
- `win-unpacked/`（调试用解包目录）

`release/` 已在 `.gitignore` 中，不入库。旧版 `build/build-desktop.ps1`、`run.cmd`、Docker 部署方式已随 Python 版一起移除。
