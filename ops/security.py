# encoding: utf-8
"""本地敏感数据加密。

Cookie 等价于账号密码，落盘前用 Fernet 加密；密钥默认存放在用户配置目录
（见 ``config.KEY_PATH``），与数据目录分离，备份数据目录不会连密钥一起
泄露。接口只返回"已配置/未配置"，不回传明文。
"""

from __future__ import annotations

import base64
import hashlib
import os
import shutil
import subprocess

from cryptography.fernet import Fernet, InvalidToken
from loguru import logger

from ops import config, proc

_cached: Fernet | None = None


def _run_icacls(*args: str) -> subprocess.CompletedProcess:
    """icacls 输出跟随系统代码页，显式按 mbcs 解码，避免 UTF-8 模式下读流失败。"""
    return proc.run(
        ["icacls", *args],
        capture_output=True,
        text=True,
        encoding="mbcs",
        errors="replace",
        timeout=10,
    )


def _restrict_windows(path) -> tuple[bool, str]:
    """Windows 下去掉继承权限，只保留当前用户完全控制。

    ``chmod`` 在 Windows 上基本不生效，这里用 ``icacls``（参数列表调用，
    不经过 shell）。失败时不影响服务启动，只在状态里标记并在启动日志告警。
    """
    user = os.getenv("USERNAME") or ""
    if not user:
        return False, "未找到当前用户名，无法收紧密钥权限"
    try:
        proc = _run_icacls(str(path), "/inheritance:r", "/grant:r", f"{user}:F")
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"icacls 调用失败: {exc.__class__.__name__}"
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        return False, f"icacls 返回 {proc.returncode}: {detail[:120]}"
    return True, ""


def _restrict_posix(path) -> tuple[bool, str]:
    try:
        os.chmod(path, 0o600)
        return True, ""
    except OSError as exc:
        return False, f"chmod 失败: {exc.__class__.__name__}"


def _restrict(path) -> tuple[bool, str]:
    return _restrict_windows(path) if os.name == "nt" else _restrict_posix(path)


def _acl_restricted(path) -> bool:
    """检查密钥是否只剩当前用户可读。检查失败按"未收紧"处理。"""
    if os.name != "nt":
        try:
            return (path.stat().st_mode & 0o077) == 0
        except OSError:
            return False
    try:
        proc = _run_icacls(str(path))
    except (OSError, subprocess.SubprocessError):
        return False
    if proc.returncode != 0:
        return False
    # 仍带 (I) 说明继承权限还在；至少还要能看到当前用户。
    text = proc.stdout or ""
    user = os.getenv("USERNAME") or ""
    return "(I)" not in text and (not user or user in text)


def _migrate_legacy_key() -> None:
    """旧版本把密钥放在数据目录，升级时搬到独立路径。

    数据目录里的旧密钥能解开现有 Cookie，必须优先保留；如果独立路径上已经
    有一把不同的密钥（例如先跑过自检），先备份再让旧密钥生效。
    """
    legacy = config.LEGACY_KEY_PATH
    if config.KEY_PATH == legacy or not legacy.exists():
        return
    try:
        if config.KEY_PATH.exists():
            old = config.KEY_PATH.read_bytes().strip()
            if old == legacy.read_bytes().strip():
                legacy.unlink(missing_ok=True)
                return
            backup = config.KEY_PATH.with_name(config.KEY_PATH.name + ".bak")
            shutil.move(str(config.KEY_PATH), str(backup))
            logger.warning(
                f"独立密钥与数据目录旧密钥不一致，已把独立密钥备份到 {backup}，"
                "改为使用旧密钥以保持现有 Cookie 可解密。"
            )
        config.KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy), str(config.KEY_PATH))
        logger.warning(
            f"已把 secret.key 从数据目录迁移到独立路径 {config.KEY_PATH}，"
            "后续备份数据目录不再包含密钥。"
        )
    except OSError as exc:
        logger.error(f"迁移 secret.key 失败，将继续使用旧路径: {exc}")


def _load_key() -> bytes:
    _migrate_legacy_key()
    if config.KEY_PATH.exists():
        return config.KEY_PATH.read_bytes().strip()
    # 首次运行生成随机密钥；全新复制过来的项目会得到一把新密钥，
    # 旧数据库里的 Cookie 也就无法解密，需要重新登录（符合预期）。
    config.KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    config.KEY_PATH.write_bytes(key)
    restricted, reason = _restrict(config.KEY_PATH)
    if restricted:
        logger.info(f"已生成 Cookie 加密密钥：{config.KEY_PATH}（仅当前用户可读）")
    else:
        logger.warning(
            f"已生成 Cookie 加密密钥：{config.KEY_PATH}，但权限收紧失败：{reason}。"
            "请确认该文件只对当前用户可读。"
        )
    return key


def ensure_key() -> bytes:
    """确保密钥存在并在启动阶段检查位置与权限。"""
    return _load_key()


def key_status() -> dict:
    """启动检查 / 自检用的密钥状态，不含密钥内容。"""
    path = config.KEY_PATH
    exists = path.exists()
    try:
        inside_data = config.DATA_DIR.resolve() in path.resolve().parents
    except OSError:
        inside_data = False
    if path.resolve() == config.LEGACY_KEY_PATH.resolve():
        inside_data = True
    restricted = _acl_restricted(path) if exists else False
    warning = ""
    if inside_data:
        warning = (
            "密钥与数据在同一目录，备份或同步数据目录会同时泄露密钥和 Cookie；"
            "请设置 OPS_KEY_PATH 指向数据目录之外的位置。"
        )
    elif not exists:
        warning = "密钥尚未生成，首次保存账号时会自动创建。"
    elif not restricted:
        warning = (
            "密钥文件权限未收紧；Windows 下请用 icacls 只授予当前用户，"
            "或在非 Windows 系统执行 chmod 600。"
        )
    return {
        "path": str(path),
        "exists": exists,
        "outside_data_dir": not inside_data,
        "restricted": restricted,
        "warning": warning,
    }


def _fernet() -> Fernet:
    global _cached
    if _cached is None:
        _cached = Fernet(_load_key())
    return _cached


def encrypt(text: str) -> str:
    return _fernet().encrypt(text.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("Cookie 解密失败：密钥已更换，请重新登录该账号") from exc


def encrypt_bytes(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_bytes(data: bytes) -> bytes:
    try:
        return _fernet().decrypt(data)
    except InvalidToken as exc:
        raise ValueError("备份解密失败：密钥与备份时不一致") from exc


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def mask(value: str, keep: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}***{value[-keep:]}"


def b64_png(data: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")
