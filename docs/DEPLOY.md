# Spider_XHS / 运营台 本地部署说明

当前副本工作区：`D:\Projects\EchoQ-Ops`（从 `D:\Projects\Redbook` 复制后独立维护，**Redbook 原目录保持不动**）。
上游仓库：[cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS) `master` @ `23dab80`（2026-10-22）

---

## 一、当前状态

| 项目 | 状态 |
| --- | --- |
| 源码 | 已在 `D:\Projects\EchoQ-Ops`，不是 git 仓库 |
| Python | 便携 CPython **3.12.16**（`.runtime\python`，从 Redbook 复制），依赖装在重建的 `.venv` |
| Python 依赖 | `requirements.txt` + `requirements.extra.txt` 已安装；`curl_cffi` 必须为 **0.16.3**（0.15.0 不支持 Creator 发布用的 chrome150 指纹） |
| Node | 系统 `node v24.11.1` + `node_modules`（crypto-js） |
| 登录 | `.env` 复用了已登录 Cookie；运营台实测账号「应声面试」（RedID: 95338776248）巡检正常 |
| 运营台 | `python -m ops selfcheck` 46/46 通过；创作台、手机预览、队列、配图、扫码会话均已联调；文案模型已接入云端中转（`deepseek-chat`）；小红书、公众号、抖音三平台适配器均已就位 |
| 自检 | `run.cmd check` 全绿 |

已经实际验证过的：

- `b1` 本地签名运行时可用（Node 调用 `vendor/xhs_utils/xhs_core/js/b1.js` 生成成功）；
- `www.xiaohongshu.com` 与 DS 接口可访问；
- 全部项目模块（`vendor.apis.*`、`vendor.xhs_utils.*`、`ops.*`）导入正常；
- 真实采集链路（用户信息 / 频道 / 搜索 / 笔记详情 / 原图下载）可用；
- 运营台：创作台自由出稿、小红书手机预览实时同步、Cookie 接入与巡检、选题入池、草稿生成、三图配图、队列幂等、合规拦截、无账号等待、扫码二维码生成均实测通过；
- Creator 发布会话：`XHS_Creator_Apis.bootstrap()` 与 `get_user_info()` 实测成功（**未实际发布笔记**，避免污染账号）。

---

## 二、为什么要项目内自带 Python

这台机器自带的 `C:\Users\徐豪\AppData\Local\Programs\Python\Python312` 是坏的：目录里只有 `python.exe` / `python312.dll`，**`Lib` 标准库目录整个缺失**，任何调用都直接死在 `ModuleNotFoundError: No module named 'encodings'`。本机也没有 `py` 启动器、`winget`、conda 等其他 Python。

所以从 [python-build-standalone](https://github.com/astral-sh/python-build-standalone) 取了便携版 CPython 3.12.16 解压进 `.runtime\python`，再从中创建虚拟环境 `.venv`。这样：

- 不依赖系统 Python，不被系统环境改动影响；
- 不占用系统全局 site-packages；
- 唯一外部依赖是 **Node.js**（签名算法由 `node` 执行）。

---

## 三、目录结构

```text
D:\Projects\Redbook
├─ .runtime\python\        便携 Python 3.12.16（151MB，勿删）
├─ .venv\                  虚拟环境与项目依赖（229MB，勿删）
├─ node_modules\           crypto-js
├─ .env                    COOKIES 配置（已在 .gitignore 中，当前已写入登录 Cookie）
├─ requirements.extra.txt  上游漏列的两项依赖（cryptography / Pillow）
├─ run.cmd                 统一启动入口
├─ check_env.py            环境自检
├─ vendor\                 上游 Spider_XHS 代码（独立目录，改动需记录）
│  ├─ apis\  xhs_utils\    上游接口与签名实现
│  ├─ spider\spider.py     采集入口（改链接 / 关键词）
│  └─ upstream\            login.py / demo.py / main.py 等上游脚本
├─ ops\                    运营台（选题 / 批量发布 / 账号矩阵）
└─ datas\
   ├─ ops\                 运营台数据库、密钥、配图
   ├─ media_datas\         下载的图片 / 视频
   └─ excel_datas\         导出的 Excel
```

`.runtime/`、`.venv/`、`node_modules/`、`.env`、`datas/` 都已加入 `.gitignore`，`git pull` 不会冲突。

---

## 四、日常用法

统一用 `run.cmd`（内部固定调用 `.venv\Scripts\python.exe`，不受系统 Python 影响）：

```bat
run.cmd check          :: 环境自检
run.cmd login          :: 扫码登录，自动把 Cookie 写进 .env
run.cmd login cookie   :: 手动粘贴浏览器 Cookie
run.cmd spider         :: 跑 vendor/spider/spider.py 的采集示例
run.cmd demo           :: 跑 vendor/upstream/demo.py（发布 / 直播 / 私信）
run.cmd main           :: 跑 vendor/upstream/main.py（登录后的最小手动测试）
run.cmd ops            :: 启动运营台（http://127.0.0.1:8710）
run.cmd shell          :: 进一个已带好依赖的 Python 交互环境
```

等价的命令行写法（在仓库根目录）：

```bat
.venv\Scripts\python.exe -m vendor.spider.spider
```

> 注意：**不要**直接敲 `python`，系统那个 Python 是坏的。

---

## 五、登录（三选一）

| 方式 | 怎么做 |
| --- | --- |
| 扫码（推荐） | `run.cmd login`，会弹出/保存 `qrcode_login.png`，用小红书 App 扫码并在手机确认。成功后 Cookie 自动写入 `.env` |
| Cookie | `run.cmd login cookie`，粘贴浏览器里登录后的完整 Cookie（要含 `a1` 和 `web_session`） |
| 手机验证码 | 把 `vendor/spider/spider.py` 里的 `login_type` 改成 `'phone'`，运行时会提示输入手机号和验证码 |

登录脚本会把 Cookie 写回 `.env` 的 `COOKIES='...'`，并且当场调 `/api/sns/web/v2/user/me` 校验一次，确认不是访客态。

扫码过程中可能出现一条黄色 WARNING：`ssk 解密失败（web 服务器公钥可能不同于 App 9.43.1）: encrypted SSK must be canonical 80-char base64`。实测不影响登录，随后仍然 `验证成功` 并拿到正式会话；这条是 webSsk 协商的兼容性提示，可以忽略。

---

## 六、开始采集

1. 打开 `vendor/spider/spider.py`，确认顶部 `login_type = 'cookie'`（用了 `run.cmd login` 的话保持默认即可）；
2. 把底部的示例换成你要的：
   - 笔记链接 → `notes = [ ... ]`
   - 用户主页链接 → `user_url = '...'`
   - 关键词搜索 → `query`、`query_num`、排序/类型/时间筛选
3. 跑 `run.cmd spider`，结果落在 `datas\media_datas` 与 `datas\excel_datas`。

`save_choice` 可选：`all` / `media` / `media-image` / `media-video` / `excel`（用 `all` 或 `excel` 时必须给 `excel_name`）。

---

## 七、常见问题

**1. 自检说 Node.js 找不到**
签名算法依赖 `node` 在 PATH 里。当前 `C:\Program Files\nodejs\node.EXE` 已可用；如果换终端后失效，把该目录加回 PATH。

**2. `.venv` 坏了 / 想重装依赖**

```bat
rmdir /s /q .venv
.runtime\python\python.exe -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install -r requirements.extra.txt
```

> 上游 `requirements.txt` 漏了 `cryptography`（`vendor/xhs_utils/xhs_core/ssk.py` 的 webSsk 协商要用），
> 不装会在扫码登录第 4 步直接 `ModuleNotFoundError`；`Pillow` 只用于把二维码存成图片。

**3. 想换更快的 pip 源**

```bat
.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

**4. Cookie 失效**
重新 `run.cmd login`。采集接口对 `xsec_token` 有时效，示例里的笔记/用户链接过期后要换新链接。

**5. 想走代理**
代码里的采集方法基本都支持 `proxies` 参数（传给 `requests`），在 `spider/spider.py` 调用处传入即可，形如 `{'http': 'http://127.0.0.1:7890', 'https': 'http://127.0.0.1:7890'}`。登录脚本同理，可在 `login.py` 里给 `from_qrcode_login(proxies=...)` 加参数。

---

## 八、合规提醒

仓库作者声明：本项目仅供学习交流，禁止商业化使用。请自行控制请求频率，账号风控与使用后果由使用者承担。

---

## 九、运营台使用

### 启动与首次配置

```bat
run.cmd ops
```

浏览器打开 `http://127.0.0.1:8710`。主流程只有三步：**创作 → 预览 → 发布**。

1. **创作**：在左侧「AI 起草」写一段需求（例如“写一篇秋招面试复盘，讲三个真正有用的动作，不要鸡汤”），选语气，点「生成文案」。右侧手机会实时显示笔记效果。
2. **检查**：看右侧合规卡与配图；不通过会标红，点「生成配图」补 3 张 3:4 卡片。
3. **发布**：选账号（默认自动轮换）→「加入发布队列」。定时留空表示立即入队；一稿多号默认关闭，需要时再打开。

辅助页面：

- **内容库**：所有草稿、队列状态、失败重试。
- **选题**：关键词 / 竞品 / 热榜挖掘，点「带入创作」把题塞进创作台。
- **账号**：扫码或 Cookie 接入、巡检、限额配置（日常不必进入）。

文案与配图统一走 EchoQ-Cloud：右上角登录账号后由云端签发两把中转 Key（文案 / 配图），上游 Key 不下发到本机。云地址通过 `.env` 的 `OPS_CLOUD_BASE_URL` 配置，默认 `http://127.0.0.1:8787`。

### 数据与备份

| 内容 | 路径 |
| --- | --- |
| 数据库 | `%LOCALAPPDATA%\EchoQ-Ops\data\ops.db`（WAL，另有 `-wal` / `-shm`） |
| 加密密钥 | `%LOCALAPPDATA%\EchoQ-Ops\secret.key`（可用 `OPS_KEY_PATH` 覆盖，默认不在数据目录内） |
| 配图 | `%LOCALAPPDATA%\EchoQ-Ops\data\assets\draft-<id>\` |
| 运行日志 | `%LOCALAPPDATA%\EchoQ-Ops\data\logs\ops.log`（10MB 轮转，保留 5 份） |

备份时停掉运营台：数据目录与密钥文件（默认 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`）**分别备份**。只备份数据目录不会泄露密钥；但恢复时若缺少密钥，Cookie 无法解密，需要重新登录所有账号。旧版本源码目录下的 `datas\ops` 会在首次启动时自动合并到新数据目录（登录票据除外）。

### 默认限速（设置里可改）

- 每账号每天 3 篇
- 同账号最小间隔 45 分钟
- 额外 0–300 秒稳定抖动（按账号 + 日期取值）
- 失败退避：1 / 2 / 4 分钟；风控类至少 15 分钟
- 单账号可覆盖日限额与最小间隔，账号矩阵里直接改

### 常见问题

**1. 添加账号提示「访客态 / 会话校验失败」**
Cookie 缺少 `web_session` 或已过期。`web_session` 是 HttpOnly，`document.cookie` 取不到；请用「扫码登录」，或从浏览器开发者工具 → Network → 请求头 `Cookie` 里完整复制。

**2. 挖掘一直返回 0 条**
先确认账号巡检正常、网络可访问小红书；关键词过窄也会导致无结果。竞品主页链接需要是 `https://www.xiaohongshu.com/user/profile/<id>` 形式。

**3. 发布失败提示「图文笔记没有配图」**
点草稿上的「生成配图」。配图为本地渲染，优先用 Playwright 自带 Chromium（`python -m playwright install chromium`），缺失时退回本机 Edge/Chrome；中文字体依赖微软雅黑 / 楷体 / Noto Sans CJK。渲染不可用时接口会明确提示，不产生任何付费调用。

**4. 发布失败提示「文案命中合规红线」**
按提示改文案：去掉扣1、私信我、关注后发、加微信、二维码等诱导或站外引流表述，保存后重新入队。

**5. 端口 8710 被占用**

```bat
.venv\Scripts\python.exe -X utf8 -m ops serve --port 8711
```

**6. 想确认代码与数据没问题**

```bat
.venv\Scripts\python.exe -X utf8 -m ops selfcheck
```

不联网，覆盖评分、去重、合规、限速、队列幂等、配图、加密、批量删除级联、发布环状态、平台注册表与跨平台拦截、新平台规格与分类、密钥独立存放、事务嵌套、上传文件头、安全响应头、模型硬超时、离线兜底、任务看门狗、接口超时、三平台文案差异、宽幅封面、配图默认参数等 46 项检查。

