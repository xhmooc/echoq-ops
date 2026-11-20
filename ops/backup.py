# encoding: utf-8
"""站内备份与恢复：数据库 + 可选图片 + 可选密钥，整体加密成一个文件。

- 备份文件放在数据目录的 ``backups`` 子目录，扩展名 ``.eqbak``；
- 文件内容是 Fernet 加密后的 zip，换机器后只要密钥一致就能恢复；
- 恢复先做一份「恢复前自动备份」，再覆盖数据库；图片按需覆盖。
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import sqlite3
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config, db, security

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+\.eqbak$")
MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024
# 图片备份体积上限：避免把 4GB 视频或海量素材一次性读进内存。
ASSET_BUDGET_BYTES = 1500 * 1024 * 1024
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _stamp() -> str:
    # 精确到毫秒，避免同一秒内「恢复前备份」覆盖用户选中的备份文件。
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]


def _snapshot_db(path: Path) -> None:
    """用 SQLite 在线备份接口拿一致性快照，避免直接拷贝 WAL 库。"""
    source = db.connect()
    target = sqlite3.connect(str(path))
    try:
        source.backup(target)
    finally:
        target.close()


def _add_tree(
    archive: zipfile.ZipFile, root: Path, arc_root: str, budget: list[int]
) -> int:
    """只备份图片；超过总预算的文件跳过，视频等大文件不进备份。"""
    if not root.exists():
        return 0
    count = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if budget[0] + size > ASSET_BUDGET_BYTES:
            continue
        budget[0] += size
        archive.write(path, f"{arc_root}/{path.relative_to(root).as_posix()}")
        count += 1
    return count


class BackupService:
    def list_backups(self) -> list[dict[str, Any]]:
        config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        items = []
        for path in sorted(
            config.BACKUP_DIR.glob("*.eqbak"), key=lambda item: item.stat().st_mtime, reverse=True
        ):
            stat = path.stat()
            items.append(
                {
                    "name": path.name,
                    "size": stat.st_size,
                    "created_at": int(stat.st_mtime),
                    "label": "恢复前自动备份" if "prerestore" in path.name else "手动备份",
                }
            )
        return items

    def create(
        self,
        *,
        include_images: bool = False,
        include_key: bool = False,
        prefix: str = "backup",
    ) -> dict[str, Any]:
        config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        config.TMP_DIR.mkdir(parents=True, exist_ok=True)
        work = config.TMP_DIR / f"backup-{_stamp()}-{os.getpid()}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            work_db = work / "ops.db"
            _snapshot_db(work_db)
            manifest = {
                "created_at": int(time.time()),
                "include_images": bool(include_images),
                "include_key": bool(include_key),
                "app": "EchoQ-Ops",
            }
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.write(work_db, "ops.db")
                if include_images:
                    budget = [0]
                    manifest["images"] = _add_tree(
                        archive, config.ASSETS_DIR, "assets", budget
                    )
                    manifest["uploads"] = _add_tree(
                        archive, config.UPLOAD_DIR, "uploads", budget
                    )
                    manifest["asset_bytes"] = budget[0]
                if include_key and config.KEY_PATH.exists():
                    archive.write(config.KEY_PATH, "secret.key")
                archive.writestr(
                    "manifest.json",
                    json.dumps(manifest, ensure_ascii=False, indent=2),
                )
            payload = security.encrypt_bytes(buffer.getvalue())
            name = (
                f"{prefix}-{_stamp()}"
                f"{'-with-images' if include_images else ''}"
                f"{'-with-key' if include_key else ''}.eqbak"
            )
            target = config.BACKUP_DIR / name
            target.write_bytes(payload)
            logger.info(
                f"已创建备份 {name}（{len(payload) // 1024} KB，"
                f"图片={'是' if include_images else '否'}，"
                f"密钥={'是' if include_key else '否'}）"
            )
            return {
                "name": name,
                "size": len(payload),
                "created_at": int(target.stat().st_mtime),
                "include_images": bool(include_images),
                "include_key": bool(include_key),
                "message": "备份已创建，建议下载后放到另一块磁盘",
            }
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def restore(self, name: str) -> dict[str, Any]:
        if not NAME_RE.match(name or ""):
            raise ValueError("备份文件名不合法")
        source = config.BACKUP_DIR / name
        if not source.is_file():
            raise KeyError(f"备份不存在: {name}")
        if source.stat().st_size > MAX_RESTORE_BYTES:
            raise ValueError("备份文件过大，无法在站内恢复")

        # 先给当前状态留一份自动备份，恢复错了还能回来。
        safety = self.create(
            include_images=False, include_key=False, prefix="prerestore"
        )

        work = config.TMP_DIR / f"restore-{_stamp()}-{os.getpid()}"
        work.mkdir(parents=True, exist_ok=True)
        try:
            raw = security.decrypt_bytes(source.read_bytes())
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                for member in archive.infolist():
                    target = (work / member.filename).resolve()
                    if work.resolve() not in target.parents and target != work.resolve():
                        raise ValueError("备份内容包含非法路径，已拒绝恢复")
                archive.extractall(work)
            restored_db = work / "ops.db"
            if not restored_db.is_file():
                raise ValueError("备份里没有数据库文件，可能已损坏")

            target_db = db.connect()
            src = sqlite3.connect(str(restored_db))
            try:
                src.backup(target_db)
            finally:
                src.close()
            db.init_db()

            replaced_images = 0
            assets = work / "assets"
            if assets.is_dir():
                config.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
                for path in assets.rglob("*"):
                    if path.is_file():
                        relative = path.relative_to(assets)
                        destination = config.ASSETS_DIR / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(path, destination)
                        replaced_images += 1
            uploads = work / "uploads"
            if uploads.is_dir():
                config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
                for path in uploads.rglob("*"):
                    if path.is_file():
                        relative = path.relative_to(uploads)
                        destination = config.UPLOAD_DIR / relative
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(path, destination)
                        replaced_images += 1

            key_written = False
            bundled_key = work / "secret.key"
            if bundled_key.is_file():
                if config.KEY_PATH.exists():
                    shutil.copy2(
                        config.KEY_PATH,
                        config.BACKUP_DIR / f"secret-{_stamp()}.key.bak",
                    )
                config.KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(bundled_key, config.KEY_PATH)
                key_written = True
            logger.warning(f"已从备份 {name} 恢复数据；恢复前备份 {safety['name']}")
            return {
                "name": name,
                "safety_backup": safety["name"],
                "files_restored": replaced_images,
                "key_restored": key_written,
                "message": "恢复完成；如正在发布，建议重启服务以清理旧连接",
            }
        finally:
            shutil.rmtree(work, ignore_errors=True)


__all__ = ["BackupService"]
