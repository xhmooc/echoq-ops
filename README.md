[简体中文](README.md) · [English](README.en.md)

<p align="center">
  <img src="build/icon.png" width="88" height="88" alt="EchoQ Ops" />
</p>

<h1 align="center">应声运营 · EchoQ Ops</h1>

<p align="center">选题、写稿、配图、预览、发布、回收，放在一条链路上。</p>

> 一个跑在本机的 Windows 内容运营工作台。在一个页面里完成从选题到发布，再回来查看已发布内容。程序单进程运行，默认只监听 `127.0.0.1:8710`，账号、文案与配图中转由 EchoQ 提供。仅用于内容创作与运营效率提升，使用前请确认符合各平台规则与当地法律法规。

![应声运营界面](docs/ui/ops.jpg)

## 功能一览

### 内容生成：一段需求直接出稿

写下主题、角度和语气，直接生成完整笔记；支持多种语气、话题生成和实时合规检查。模型不可用时自动回落到离线模板，不会卡在空白页。

### 手机预览：按平台还原详情页

右侧按平台样式还原笔记详情页，标题、正文、话题和配图随编辑实时同步，不用反复发布再删除。

### 配图：内置模板和 AI 出图

内置模板用本地 HTML / CSS 渲染后无头截图，适合固定版式；需要新图时走 AI 出图。落盘前会做尺寸、碰撞和越界检查，避免文字被裁掉。

### 发布：队列、账号轮换与限额

发布任务进入队列后幂等执行，支持多账号轮换、日限额与最小间隔、失败分类与退避重试、定时发布和一稿多号。

### 回收：已发布内容与定时同步

已发布内容本地缓存，可定时同步互动数据，计划任务的运行记录在页面里直接看。

### 账号：Cookie / 扫码接入

支持 Cookie 导入和扫码登录，凭据用 Fernet 加密保存在本机；定时巡检账号状态，遇到风控自动冷却。

## 适用场景

| 场景 | 用法 |
| --- | --- |
| 日常笔记选题与写稿 | 内容生成，一段需求直接出稿 |
| 发布前看排版 | 右侧手机预览，边改边看 |
| 需要配图 | 固定版式用内置模板，新图用 AI 出图 |
| 多账号运营 | 发布队列 + 账号轮换 + 日限额 |
| 定时发布 | 计划任务，按时间进队列 |
| 发布后看数据 | 已发布缓存与定时同步 |

## 快速开始

1. **准备环境**：Windows 10 / 11，Python 3.10+，然后安装依赖

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -U pip
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   .\.venv\Scripts\python.exe -m playwright install chromium
   ```

2. **配置云端地址**：复制 `.env.example` 为 `.env`，按需修改 `OPS_CLOUD_BASE_URL`。源码运行时默认指向本机 `http://127.0.0.1:8787`，打包版指向 `https://ops.echoq.cn`

3. **启动**：

   ```powershell
   .\.venv\Scripts\python.exe -X utf8 -m ops selfcheck
   run.cmd ops
   ```

   打开 <http://127.0.0.1:8710>，登录后即可使用。

## 更多功能

- **合规检查**：生成时实时提示敏感词与平台规则风险
- **失败可见**：发布失败按类型退避重试，原因保留在任务详情里
- **定时任务**：按时间自动进队列，运行记录可回看
- **本机存储**：账号凭据、草稿、配图和发布记录都保存在本机
- **自检命令**：`python -X utf8 -m ops selfcheck` 检查依赖、目录和配置

## 遇到问题

先跑一次自检，确认依赖和配置完整；启动失败时看控制台输出，发布失败时看任务详情里的原因。仍然解决不了，带上版本号、Windows 版本和报错原文[提 Issue](https://github.com/xhmooc/echoq-ops/issues/new)，截图里如果有账号信息记得打码。

也可以直接进反馈群：应声运营 1 群 **1136843749**。

## 打包

对外交付形态是 Electron 桌面版：

```powershell
powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1
```

产物输出到 `release\electron\`。

## 项目结构

```text
EchoQ-Ops/
├─ ops/                 运营台后端（aiohttp）与前端（web/static）
├─ vendor/              上游 Spider_XHS 代码：apis / xhs_utils / spider / upstream
├─ docs/                架构、接口、数据模型、运维、评审
├─ build/               打包脚本与 PyInstaller 配置
├─ electron/            桌面壳（窗口 + 托盘 + 启动本地后端）
├─ website/             官网静态页
└─ run.cmd              统一入口
```

更多文档：[架构与数据流](docs/ARCHITECTURE.md) · [本地运行与配置](docs/RUNBOOK.md) · [接口文档](docs/API.md) · [数据模型](docs/DATA_MODEL.md)

## 许可协议

[MIT](LICENSE)。产品名称、Logo 与 EchoQ 云端服务不在授权范围内。

`vendor/` 来自 [cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS)，遵循 MIT，来源说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
