# encoding: utf-8
"""运营台配置与路径。

所有运行期数据统一放在 ``%LOCALAPPDATA%\\EchoQ-Ops\\data``（可用环境变量
``OPS_DATA_DIR`` 覆盖，自检脚本用它指向临时目录）。源码与打包读同一份数据，
文档、密钥、产物都不写进源码目录。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

# PyInstaller 打包后：代码与静态资源在 _MEIPASS，exe 位于 sys.executable 同目录。
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    APP_DIR = Path(sys.executable).resolve().parent
    RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
else:
    APP_DIR = Path(__file__).resolve().parent.parent
    RESOURCE_DIR = APP_DIR

# 兼容旧引用：ROOT 指程序目录。
ROOT = APP_DIR


def _load_env_files() -> None:
    """依次加载程序目录与用户配置目录的 .env，先到先得。"""
    candidates = [APP_DIR / ".env"]
    base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA")
    if base:
        candidates.append(Path(base) / "EchoQ-Ops" / ".env")
    for path in candidates:
        if path.is_file():
            load_dotenv(path, override=False)


_load_env_files()

# 源码与打包统一使用用户目录：无论从哪启动，登录态、数据库、素材都是同一份。
# 需要隔离时用 OPS_DATA_DIR（自检会指向临时目录）。
_USER_DIR = Path(os.getenv("LOCALAPPDATA") or os.getenv("APPDATA") or Path.home()) / "EchoQ-Ops"
_default_data = _USER_DIR / "data"
_DATA_OVERRIDE = bool(os.getenv("OPS_DATA_DIR"))
DATA_DIR = Path(os.getenv("OPS_DATA_DIR") or _default_data).resolve()
DEFAULT_DATA_DIR = _default_data.resolve()
_LEGACY_DATA = (APP_DIR / "datas" / "ops").resolve()
ASSETS_DIR = DATA_DIR / "assets"
DESIGN_DIR = DATA_DIR / "designs"
UPLOAD_DIR = DATA_DIR / "uploads"
TMP_DIR = DATA_DIR / "tmp"
LOG_DIR = DATA_DIR / "logs"
PROFILE_DIR = DATA_DIR / "profiles"
BACKUP_DIR = DATA_DIR / "backups"
# 发布失败现场：截图 + 页面 DOM 快照，供诊断抽屉回看。
EVIDENCE_DIR = DATA_DIR / "evidence"
DB_PATH = DATA_DIR / "ops.db"

# 密钥默认放在用户配置目录，而不是数据目录：备份 / 同步盘 / 误打包
# ``datas/ops`` 时只会带走密文 Cookie，不会连密钥一起泄露。
# 可用 ``OPS_KEY_PATH`` 显式指定（多机共享数据目录等特殊场景）。
KEY_PATH_ENV = "OPS_KEY_PATH"
LEGACY_KEY_PATH = DATA_DIR / "secret.key"


def _resolve_key_path() -> Path:
    override = (os.getenv(KEY_PATH_ENV) or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA")
    if base:
        return (Path(base) / "EchoQ-Ops" / "secret.key").resolve()
    return (Path.home() / ".local" / "share" / "EchoQ-Ops" / "secret.key").resolve()


KEY_PATH = _resolve_key_path()

WEB_DIR = RESOURCE_DIR / "ops" / "web"
STATIC_DIR = WEB_DIR / "static"

DEFAULT_HOST = os.getenv("OPS_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("OPS_PORT", "8710"))

# 模拟发布：开启后发布环不调用小红书接口，只写一条「模拟发布」记录。
DRY_RUN = str(os.getenv("OPS_DRY_RUN", "")).strip().lower() in {"1", "true", "yes", "on"}

# EchoQ-Cloud 地址：账号登录、订阅校验、文案/配图中转都走这里。
# 打包后的客户端默认连正式域名；源码运行默认连本地 8787，便于联调。
_DEFAULT_CLOUD = "https://ops.echoq.cn" if FROZEN else "http://127.0.0.1:8787"
CLOUD_BASE_URL = (os.getenv("OPS_CLOUD_BASE_URL") or _DEFAULT_CLOUD).rstrip("/")

# 文案模型必须在中转白名单内；云端默认与白名单都是 deepseek-chat。
LLM_MODEL = os.getenv("OPS_LLM_MODEL") or "deepseek-chat"

# 更新检查：产品固定为 ops，通道与平台可用环境变量覆盖（beta 通道 / 其他架构）。
APP_CHANNEL = (os.getenv("OPS_CHANNEL") or "stable").strip().lower()
APP_PLATFORM = (os.getenv("OPS_PLATFORM") or "win-x64").strip()


def _merge_copy(src: Path, dst: Path) -> None:
    """把旧数据逐文件补到新目录；已存在的目标不覆盖。"""
    if src.is_dir():
        dst.mkdir(parents=True, exist_ok=True)
        for child in src.iterdir():
            _merge_copy(child, dst / child.name)
        return
    if dst.exists():
        return
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    except OSError:
        pass


_MIGRATED = False


def _migrate_legacy_data() -> None:
    """首次统一切到用户目录时，把源码目录下的旧数据搬过来。

    只搬业务数据；``cloud_state.json`` 里的票据可能指向开发云端，带过来会
    变成「已登录却连不上」，因此保留给用户重新登录。
    """
    global _MIGRATED
    if _MIGRATED:
        return
    _MIGRATED = True
    if _DATA_OVERRIDE or FROZEN or DATA_DIR == _LEGACY_DATA:
        return
    if not _LEGACY_DATA.is_dir() or (DATA_DIR / "ops.db").exists():
        return
    for item in _LEGACY_DATA.iterdir():
        if item.name in {"cloud_state.json", "secret.key", "logs", "tmp"}:
            continue
        _merge_copy(item, DATA_DIR / item.name)


def ensure_dirs() -> None:
    _migrate_legacy_data()
    for path in (
        DATA_DIR,
        ASSETS_DIR,
        DESIGN_DIR,
        UPLOAD_DIR,
        TMP_DIR,
        LOG_DIR,
        PROFILE_DIR,
        BACKUP_DIR,
        EVIDENCE_DIR,
    ):
        path.mkdir(parents=True, exist_ok=True)


_LOGGING_READY = False


def configure_logging() -> None:
    """控制台 + 文件双写；文件按 10MB 轮转，保留 5 份。"""
    global _LOGGING_READY
    if _LOGGING_READY:
        return
    from loguru import logger

    ensure_dirs()
    logger.add(
        LOG_DIR / "ops.log",
        level="INFO",
        rotation="10 MB",
        retention=5,
        encoding="utf-8",
        enqueue=True,
        backtrace=False,
        diagnose=False,
    )
    _LOGGING_READY = True


# 可在线调整的默认参数；``settings`` 表里的值优先。
DEFAULT_SETTINGS: dict[str, str] = {
    "publish_daily_limit": "3",
    "publish_min_interval_sec": "2700",
    "publish_jitter_sec": "300",
    "job_max_attempts": "4",
    "worker_auto_start": "1",
    "worker_poll_sec": "20",
    "health_check_hours": "6",
    # 同一账号任意两次写动作（发布 / 巡检 / 同步）之间的最小间隔。
    "write_gap_sec": "45",
    # 评论只读同步的定时间隔；手动同步不受此限制。
    "comment_sync_hours": "12",
    "focus_keywords": "面试,求职,秋招,简历,自我介绍,面试技巧,offer,应届生",
    "product_name": "应声面试 Pro",
    "product_pitch": "面试时贴在最上层，把问题实时转成文字并给出可直接说出口的回答；识别在本地跑。",
    "card_style": "warm",
    "card_layout": "balanced",
    "card_palette": "",
    "card_theme": "warm",
    "draft_style": "story",
    "llm_model": LLM_MODEL,
}

# 文案模型超时：单次请求硬上限 + 一次生成（含压缩重写）的总预算。
# requests 的 timeout 覆盖不到 DNS / 慢速滴流，代码里另用线程 join 兜底。
LLM_TIMEOUT_SEC = float(os.getenv("OPS_LLM_TIMEOUT_SEC", "45") or 45)
LLM_TOTAL_BUDGET_SEC = float(os.getenv("OPS_LLM_TOTAL_BUDGET_SEC", "60") or 60)
# 接口层兜底：超过这个时间一定给前端一个明确结果（成功或 504），不再无限转圈。
COPY_TIMEOUT_SEC = float(os.getenv("OPS_COPY_TIMEOUT_SEC", "75") or 75)
RENDER_TIMEOUT_SEC = float(os.getenv("OPS_RENDER_TIMEOUT_SEC", "240") or 240)


TONES: dict[str, str] = {
    "casual": "日常随意",
    "recommend": "好物种草",
    "professional": "专业测评",
    "cute": "可爱软萌",
    "emotional": "情感共鸣",
    "informative": "干货科普",
    "story": "经验分享",
    "warn": "避坑指南",
    "enthusiastic": "激情感召",
}

# 平台硬限制（发布前校验）。
TITLE_MAX = 20
DESC_MAX = 1000
