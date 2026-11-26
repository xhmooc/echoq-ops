# encoding: utf-8
"""Web 层共享助手：统一响应体、错误中间件、请求解析与素材校验。

各 router 只依赖这里，不直接依赖 app；``create_app`` 负责汇总注册。
"""

from __future__ import annotations

import asyncio
import re
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from ops import cloud, config, db
from ops.llm import LLMError
from ops.service import OpsService

# 内部异常对外只保留一句人话：带盘符/绝对路径或过长的原文只进日志。
_PATH_HINT = re.compile(r"[A-Za-z]:[\\/]|\\\\|/Users/|/home/|/mnt/")


def _public_reason(exc: Exception) -> str:
    text = " ".join(str(exc or "").split())
    if not text or len(text) > 160 or _PATH_HINT.search(text):
        return ""
    return text


def _ok(data: Any = None, status_code: int = 200, **extra) -> web.Response:
    payload = {"ok": True, "data": data}
    payload.update(extra)
    return web.json_response(payload, status=status_code)


async def _body(request: web.Request) -> dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise ValueError("请求体不是合法 JSON，请检查格式") from exc
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return payload


def _service(request: web.Request) -> OpsService:
    return request.app["service"]


async def _blocking(fn: Any, *args: Any, timeout: float = 0, **kwargs: Any) -> Any:
    """在线程池执行阻塞函数，可选硬超时；超时由中间件转成 504。"""
    call = asyncio.to_thread(fn, *args, **kwargs)
    if timeout and timeout > 0:
        return await asyncio.wait_for(call, timeout=timeout)
    return await call


@web.middleware
async def _errors(request: web.Request, handler):
    try:
        return await handler(request)
    except TimeoutError:
        # 线程可能仍在后台收尾，但请求一定结束，前端可以明确提示重试。
        return web.json_response(
            {"ok": False, "error": "处理超时，请稍后重试；已保留当前输入"},
            status=504,
        )
    except KeyError as exc:
        return web.json_response({"ok": False, "error": str(exc).strip("'")}, status=404)
    except cloud.CloudError as exc:
        status = exc.status if exc.status in {400, 401, 402, 403, 429} else 400
        return web.json_response(
            {"ok": False, "error": str(exc), "code": exc.code}, status=status
        )
    except LLMError as exc:
        # 登录/订阅/额度类原因已经是给人看的原话，状态码也按语义返回。
        text = str(exc)
        status = 401 if "登录" in text else 402 if ("订阅" in text or "额度" in text) else 400
        return web.json_response(
            {"ok": False, "error": text, "code": "llm_unavailable"}, status=status
        )
    except web.HTTPException:
        raise
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    except RuntimeError as exc:
        # 业务自检/渲染类异常本身就是人话，带原因返回，编号只作附加信息。
        error_id = uuid.uuid4().hex[:8]
        logger.exception(f"接口异常[{error_id}] {request.method} {request.path}")
        reason = _public_reason(exc)
        message = (
            f"{reason}（错误编号 {error_id}）"
            if reason
            else "服务器处理失败，请稍后重试；如果持续出现，把错误编号"
            f" {error_id} 发给维护者。"
        )
        return web.json_response(
            {"ok": False, "error": message, "error_id": error_id}, status=500
        )
    except Exception:  # noqa: BLE001
        # 对外只给一个可回查的错误编号，异常类名和内部路径只进日志。
        error_id = uuid.uuid4().hex[:8]
        logger.exception(f"接口异常[{error_id}] {request.method} {request.path}")
        return web.json_response(
            {
                "ok": False,
                "error": "服务器处理失败，请稍后重试；如果持续出现，把错误编号"
                f" {error_id} 发给维护者。",
                "error_id": error_id,
            },
            status=500,
        )


@web.middleware
async def _no_cache(request: web.Request, handler):
    response = await handler(request)
    if (
        request.path == "/"
        or request.path.startswith("/static/")
        or request.path.startswith("/assets/")
        or request.path.startswith("/designs/")
        or request.path.startswith("/uploads/")
    ):
        response.headers["Cache-Control"] = "no-store"
    # 统一安全响应头：禁止内容嗅探、禁止被第三方页面嵌套、限制 Referer。
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
    )
    # 页面资源来自本机；图片允许 data:/blob:/https:，不放开外部脚本与样式。
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self'; "
        "font-src 'self' data: https:; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    return response


# ---------------------------------------------------------------- 素材校验
# 只信文件头，不信扩展名；白名单常量同时供上传与静态读取复用。
EVIDENCE_SUFFIXES = {".png", ".jpg", ".jpeg", ".html", ".txt"}
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
