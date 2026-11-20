# encoding: utf-8
"""设置、后台巡检、通知与备份。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops import config
from ops.web.common import (
    _ok,
    _body,
    _service,
    _blocking,
)


routes = web.RouteTableDef()


@routes.get("/api/settings")
async def get_settings(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.settings_public))


@routes.patch("/api/settings")
async def update_settings(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(await asyncio.to_thread(service.update_settings, payload))


@routes.get("/api/worker")
async def worker_status(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.worker_status))


@routes.post("/api/worker/tick")
async def worker_tick(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.tick_now))


@routes.get("/api/notifications")
async def list_notifications(request: web.Request) -> web.Response:
    service = _service(request)
    query = request.query
    data = await asyncio.to_thread(
        service.notify.list_events,
        int(query.get("limit", "20") or 20),
        int(query.get("offset", "0") or 0),
        query.get("unread") == "1",
    )
    return _ok(
        data["items"],
        total=data["total"],
        unread=data["unread"],
        limit=int(query.get("limit", "20") or 20),
        offset=int(query.get("offset", "0") or 0),
    )


@routes.post("/api/notifications/read")
async def read_notifications(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    raw_ids = payload.get("ids")
    if raw_ids is None:
        count = await asyncio.to_thread(service.notify.mark_read, None)
    else:
        if isinstance(raw_ids, str):
            raw_ids = [item for item in raw_ids.split(",") if item.strip()]
        count = await asyncio.to_thread(
            service.notify.mark_read, [int(item) for item in raw_ids]
        )
    return _ok({"updated": count, "unread": await asyncio.to_thread(service.notify.unread_count)})


@routes.get("/api/notifications/channels")
async def list_notification_channels(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.notify.list_channels))


@routes.post("/api/notifications/channels")
async def add_notification_channel(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(await asyncio.to_thread(service.notify.add_channel, payload))


@routes.patch("/api/notifications/channels/{channel_id}")
async def update_notification_channel(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(
            service.notify.update_channel,
            int(request.match_info["channel_id"]),
            payload,
        )
    )


@routes.delete("/api/notifications/channels/{channel_id}")
async def delete_notification_channel(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.notify.delete_channel, int(request.match_info["channel_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/notifications/channels/{channel_id}/test")
async def test_notification_channel(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(
        await asyncio.to_thread(
            service.notify.test_channel, int(request.match_info["channel_id"])
        )
    )


@routes.get("/api/backups")
async def list_backups(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.backups.list_backups))


@routes.post("/api/backups")
async def create_backup(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.backups.create,
        include_images=bool(payload.get("include_images")),
        include_key=bool(payload.get("include_key")),
    )
    return _ok(data)


@routes.get("/api/backups/download")
async def download_backup(request: web.Request) -> web.Response:
    name = request.query.get("name", "")
    if "/" in name or "\\" in name or not name.endswith(".eqbak"):
        raise ValueError("备份文件名不合法")
    path = config.BACKUP_DIR / name
    if not path.is_file():
        raise KeyError(f"备份不存在: {name}")
    return web.FileResponse(
        path,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@routes.post("/api/backups/restore")
async def restore_backup(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    name = str(payload.get("name") or "")
    if not name:
        raise ValueError("请选择要恢复的备份")
    data = await _blocking(service.backups.restore, name, timeout=300)
    return _ok(data)


@routes.delete("/api/backups/{name}")
async def delete_backup(request: web.Request) -> web.Response:
    name = request.match_info["name"]
    if "/" in name or "\\" in name or not name.endswith(".eqbak"):
        raise ValueError("备份文件名不合法")
    path = config.BACKUP_DIR / name
    if not path.is_file():
        raise KeyError(f"备份不存在: {name}")
    path.unlink()
    return _ok({"deleted": True})
