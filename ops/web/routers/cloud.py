# encoding: utf-8
"""EchoQ-Cloud 账号体系与客户端更新检查。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops import cloud
from ops.web.common import (
    _ok,
    _body,
)


routes = web.RouteTableDef()


@routes.get("/api/cloud/status")
async def cloud_status(request: web.Request) -> web.Response:
    return _ok(await asyncio.to_thread(cloud.status))


@routes.get("/api/cloud/doctor")
async def cloud_doctor(request: web.Request) -> web.Response:
    """云端体检：可达性、登录态、Key、模型白名单、订阅额度逐项返回。"""
    model = request.query.get("model", "")
    return _ok(await asyncio.to_thread(cloud.doctor, model))


@routes.get("/api/update")
async def update_status(request: web.Request) -> web.Response:
    """公开的版本检查：连不上云端时返回 checked=false，前端静默跳过。"""
    current = request.query.get("current", "")
    return _ok(await asyncio.to_thread(cloud.update_info, current))


@routes.post("/api/cloud/sms/send")
async def cloud_sms_send(request: web.Request) -> web.Response:
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(cloud.send_sms, str(payload.get("phone") or "").strip())
    )


@routes.post("/api/cloud/login")
async def cloud_login(request: web.Request) -> web.Response:
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(
            cloud.login,
            phone=str(payload.get("phone") or "").strip(),
            code=str(payload.get("code") or "").strip(),
            email=str(payload.get("email") or "").strip(),
            password=str(payload.get("password") or ""),
            display_name=str(payload.get("display_name") or "").strip(),
        )
    )


@routes.post("/api/cloud/logout")
async def cloud_logout(request: web.Request) -> web.Response:
    return _ok(await asyncio.to_thread(cloud.logout))


@routes.post("/api/cloud/refresh")
async def cloud_refresh(request: web.Request) -> web.Response:
    return _ok(await asyncio.to_thread(cloud.refresh))


@routes.post("/api/cloud/keys/reset")
async def cloud_reset_key(request: web.Request) -> web.Response:
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(cloud.reset_key, str(payload.get("kind") or "llm"))
    )
