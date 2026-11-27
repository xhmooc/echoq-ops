# 发布与分发

本文件描述当前桌面端（`desktop/`）的发布流程与产物去向。旧的 Python / Docker 部署方式已随旧版移除。

## 1. 版本号

只改一处：`desktop/package.json` 的 `version`。安装包文件名、更新检查都跟随它。

| 类型 | 规则 | 示例 |
| --- | --- | --- |
| 功能更新 | 修订号 +1 | `0.3.0 → 0.3.1` |
| 大版本更新 | 次版本号 +1、修订号归零 | `0.3.x → 0.4.0` |

历史版本号记录在 [CHANGELOG.md](CHANGELOG.md)。旧版 `ops/__init__.py` 与 `electron/package.json` 已移除，不再需要同步。

## 2. 打包

```powershell
cd desktop
npm install
npm run dist
```

流程：

1. `scripts/ensure-ffmpeg.mjs` 校验并补齐 `vendor/ffmpeg/ffmpeg.exe`；
2. `scripts/gen-bgm.mjs` 生成 3 条内置配乐；
3. `tsc` 编译到 `desktop/dist`；
4. electron-builder 输出到 `release/desktop`。

产物：

| 文件 | 用途 |
| --- | --- |
| `EchoQ-Ops-Next-Setup-<version>.exe` | NSIS 安装版，可选安装目录，创建桌面快捷方式 |
| `EchoQ-Ops-Next-Portable-<version>.exe` | 免安装版 |
| `win-unpacked/` | 解包目录，排障时直接运行 |

打包会带上：

- `ops/web/static` → `resources/web`（界面）
- `vendor/xhs_utils` → `resources/vendor/xhs_utils`（小红书签名）
- `desktop/vendor/ffmpeg` → `resources/ffmpeg`
- `desktop/vendor/bgm` → `resources/bgm`
- `build/icon.ico` → `resources/icon.ico`

## 3. 发布前检查

1. `cd desktop && npm run build` 编译通过；
2. 启动一次，确认界面加载、账号列表、创作台预览正常；
3. 至少验证一条链路：选题 → 草稿 → 配图 → 预览；
4. 若本次改动涉及动效或视频，确认 ffmpeg 产物可生成；
5. 更新 `docs/CHANGELOG.md` 与 `README.md` 的功能/版本段落；
6. 打标签并上传安装包到 GitHub Releases，Release 说明写清具体修复与变更，不写「版本更新」这类空话。

## 4. 更新检查

客户端通过 `GET /api/update` 转发 EchoQ-Cloud 的 `/api/app/version`（`product=ops`）检查新版本。云端不可达时返回 `checked=false`，界面静默跳过，不阻塞使用。

## 5. 官网与演示

| 内容 | 位置 |
| --- | --- |
| 官网静态页 | `website/`（含 `index.html`、隐私、条款、`demo/` 在线原型） |
| 宣传视频与海报 | `website/assets/media/`、`website/assets/poster.png` |
| 宣传片工程 | `promo-video/`（HyperFrames 工程与渲染脚本） |

官网是纯静态页，可直接部署到任意静态托管；在线体验原型是 `website/demo/index.html`，不依赖后端。

## 6. 服务端边界

EchoQ-Cloud（账号、订阅、模型中转、版本接口）不在本仓库，也不随客户端发布。客户端只通过 `OPS_CLOUD_BASE_URL` 访问它；未配置时文案走本地离线模板，其余功能不受影响。
