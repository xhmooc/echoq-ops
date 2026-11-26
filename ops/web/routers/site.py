# encoding: utf-8
"""站点、健康检查、静态素材与总览。"""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path

from aiohttp import web

from ops import config
from ops.web.common import (
    _ok,
    _service,
    EVIDENCE_SUFFIXES,
    IMAGE_SUFFIXES,
    VIDEO_SUFFIXES,
    UPLOAD_MAX_BYTES,
    VIDEO_MAX_BYTES,
    _sniff_image,
    _image_matches_suffix,
    _sniff_video,
)


routes = web.RouteTableDef()


@routes.get("/")
async def index(request: web.Request) -> web.Response:
    return web.FileResponse(config.STATIC_DIR / "index.html")


@routes.get("/api/health")
async def health(request: web.Request) -> web.Response:
    from ops import __version__, security

    return _ok(
        {
            "status": "ok",
            "version": __version__,
            "data_dir": str(config.DATA_DIR),
            # 只暴露路径/是否独立/权限是否收紧，不返回密钥内容。
            "key": security.key_status(),
        }
    )


@routes.get("/assets/{draft_dir}/{filename}")
async def asset(request: web.Request) -> web.Response:
    draft_dir = request.match_info["draft_dir"]
    filename = request.match_info["filename"]
    if not draft_dir.startswith("draft-") or "/" in filename or "\\" in filename:
        raise web.HTTPNotFound()
    path = (config.ASSETS_DIR / draft_dir / filename).resolve()
    if config.ASSETS_DIR.resolve() not in path.parents or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


EVIDENCE_SUFFIXES = {".png", ".jpg", ".jpeg", ".html", ".txt"}


@routes.get("/evidence/{filename}")
async def evidence_file(request: web.Request) -> web.Response:
    """发布失败现场：只允许读取 evidence 目录下的白名单文件。"""
    filename = request.match_info["filename"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", filename):
        raise web.HTTPNotFound()
    suffix = Path(filename).suffix.lower()
    if suffix not in EVIDENCE_SUFFIXES:
        raise web.HTTPNotFound()
    path = (config.EVIDENCE_DIR / filename).resolve()
    if config.EVIDENCE_DIR.resolve() not in path.parents or not path.is_file():
        raise web.HTTPNotFound()
    headers = {}
    if suffix in {".html", ".txt"}:
        # DOM 快照只供下载查看，不在浏览器里当页面渲染。
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return web.FileResponse(path, headers=headers)


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".flv", ".wmv"}
UPLOAD_MAX_BYTES = 12 * 1024 * 1024
VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024


def _sniff_image(head: bytes) -> str:
    """按文件头判断真实图片类型，不信任扩展名。"""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:6] in {b"GIF87a", b"GIF89a"}:
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return ""


def _image_matches_suffix(kind: str, suffix: str) -> bool:
    expected = "jpeg" if suffix in {".jpg", ".jpeg"} else suffix.lstrip(".")
    return bool(kind) and kind == expected


def _sniff_video(head: bytes) -> bool:
    """按文件头判断视频容器，拒绝 HTML/SVG 等伪装文件。"""
    if len(head) < 12:
        return False
    if head[4:8] == b"ftyp":  # mp4 / mov / m4v
        return True
    if head[:4] == b"\x1a\x45\xdf\xa3":  # webm / mkv
        return True
    if head[:4] == b"RIFF" and head[8:12] == b"AVI ":
        return True
    if head[:3] == b"FLV":
        return True
    if head[:8] == b"\x30\x26\xb2\x75\x8e\x66\xcf\x11":  # wmv / asf
        return True
    return False


@routes.post("/api/uploads")
async def upload_images(request: web.Request) -> web.Response:
    """接收图片或视频，落到数据目录的 uploads，返回可由页面直接访问的绝对路径。"""
    if not request.content_type.startswith("multipart/"):
        raise ValueError("请用 multipart/form-data 上传素材")
    saved: list[str] = []
    reader = await request.multipart()
    async for part in reader:
        if part.name != "files":
            await part.release()
            continue
        suffix = Path(part.filename or "").suffix.lower()
        is_video = suffix in VIDEO_SUFFIXES
        if suffix not in IMAGE_SUFFIXES and not is_video:
            raise ValueError(f"不支持的素材格式：{part.filename or '未命名文件'}")
        limit = VIDEO_MAX_BYTES if is_video else UPLOAD_MAX_BYTES
        target = config.UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"
        size = 0
        try:
            with target.open("wb") as handle:
                while True:
                    chunk = await part.read_chunk(1024 * 1024 if is_video else 64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limit:
                        raise ValueError(
                            "单个视频不能超过 4GB" if is_video else "单张图片不能超过 12MB"
                        )
                    handle.write(chunk)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        with target.open("rb") as handle:
            head = handle.read(16)
        valid = _sniff_video(head) if is_video else _image_matches_suffix(_sniff_image(head), suffix)
        if not valid:
            target.unlink(missing_ok=True)
            raise ValueError(
                f"文件内容不是有效的{part.filename or '素材'}，"
                + ("请上传真实的 MP4 / MOV / WEBM 等视频" if is_video else "请上传真实的 PNG / JPG / WEBP / GIF 图片")
            )
        saved.append(str(target))
    if not saved:
        raise ValueError("没有收到素材")
    return _ok({"paths": saved})


@routes.get("/api/overview")
async def overview(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.overview))


@routes.get("/api/platforms")
async def list_platforms(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.platforms))


# ---------------------------------------------------------------- published
# 已发布内容：平台作品列表的本地缓存 + 本地发布记录兜底。接口契约见 docs/API.md。
