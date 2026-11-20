<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="EchoQ Ops" />
</p>

<h1 align="center">应声运营 · EchoQ-Ops</h1>

<p align="center">
  Windows 内容运营工作台：选题 → 写稿 → 配图 → 预览 → 发布 → 回收。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/license-MIT-ff2442" alt="License" />
  <img src="https://img.shields.io/badge/status-beta-ffb020" alt="Status" />
</p>

![应声运营界面](docs/ui/ops.jpg)

应声运营是一个跑在本机的内容运营台，把选题、成稿、配图、预览、多账号发布和数据回收放在一条链路里。程序在本机单进程运行，默认只监听 `127.0.0.1:8710`。

> 仅用于内容创作与运营效率提升，使用前请确认符合各平台规则与当地法律法规。

## 功能

| 模块 | 能力 |
| --- | --- |
| 内容生成 | 一段需求直接出稿、多种语气、话题生成、实时合规检查、失败回落离线模板 |
| 手机预览 | 按平台还原笔记详情页，编辑时实时同步 |
| 配图 | 内置模板（本地 HTML/CSS + 无头截图）与 AI 出图两条路径；落盘前做碰撞与越界检查 |
| 发布 | 队列幂等、账号轮换、日限额与最小间隔、失败分类与退避、定时任务、一稿多号 |
| 回收 | 已发布内容缓存、定时同步、计划任务运行记录 |
| 账号 | Cookie / 扫码接入、Fernet 加密、定时巡检、风控冷却 |

## 快速开始

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m playwright install chromium

Copy-Item .env.example .env
.\.venv\Scripts\python.exe -X utf8 -m ops selfcheck
run.cmd ops
```

打开 <http://127.0.0.1:8710>。

云端账号地址通过 `OPS_CLOUD_BASE_URL` 配置，本地开发默认 `http://127.0.0.1:8787`；登录后云端按账号签发文案与配图能力，本机加密保存，页面不显示明文。

## 项目结构

```text
EchoQ-Ops/
├─ ops/                 运营台后端（aiohttp）与前端（web/static）
├─ vendor/              上游 Spider_XHS 代码：apis / xhs_utils / spider / upstream
├─ docs/                架构、接口、数据模型、运维、评审
├─ build/               打包脚本与 PyInstaller 配置
├─ electron/            桌面壳（窗口 + 托盘 + 启动本地后端）
├─ website/             官网静态页
├─ xhs-promo/topics/    题库种子数据
└─ run.cmd              统一入口
```

## 打包

对外交付形态为 Electron 桌面版；`desktop.py` 与 `run.cmd ops` 用于开发调试。

```powershell
powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1
```

产物输出到 `release\electron\`。

## 文档

- [架构与数据流](docs/ARCHITECTURE.md)
- [本地运行与配置](docs/RUNBOOK.md)
- [接口文档](docs/API.md)
- [数据模型](docs/DATA_MODEL.md)
- [多平台接入说明](docs/PLATFORMS.md)
- [CHANGELOG](docs/CHANGELOG.md)

## 边界

- `vendor/` 来自 [cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS)，遵循 MIT，来源说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
- 本机接口没有鉴权，只应监听 `127.0.0.1`，不要直接暴露到公网。
- 发布频率、账号风控与使用后果由使用者承担。

## EchoQ 系列

- **应声面试（EchoQ Interview）**：[GitHub](https://github.com/xhmooc/echoq-interview) · [官网](https://job.echoq.cn/)
- **应声运营（EchoQ Ops）**：本仓库 · [官网](https://ops.echoq.cn/)

## 许可证

[MIT](LICENSE)。产品名称、Logo 与 EchoQ 云端服务不在授权范围内。
