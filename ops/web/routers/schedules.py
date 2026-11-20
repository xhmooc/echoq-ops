# encoding: utf-8
"""定时调度。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops import cloud
from ops.web.common import (
    _ok,
    _body,
    _service,
)


routes = web.RouteTableDef()


@routes.get("/api/schedules")
async def list_schedules(request: web.Request) -> web.Response:
    service = _service(request)
    limit = int(request.query.get("limit", "200"))
    offset = int(request.query.get("offset", "0"))
    items = await asyncio.to_thread(service.list_schedules, limit, offset)
    total = await asyncio.to_thread(service.count_schedules)
    return _ok(items, total=total, limit=limit, offset=offset)


@routes.post("/api/schedules")
async def create_schedule(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(await asyncio.to_thread(service.create_schedule, payload))


@routes.post("/api/schedules/quick")
async def quick_create_schedule(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(await asyncio.to_thread(service.quick_create_schedule, payload))


@routes.patch("/api/schedules/{schedule_id}")
async def update_schedule(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(
            service.update_schedule, int(request.match_info["schedule_id"]), payload
        )
    )


@routes.delete("/api/schedules/{schedule_id}")
async def delete_schedule(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.delete_schedule, int(request.match_info["schedule_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/schedules/{schedule_id}/run")
async def run_schedule(request: web.Request) -> web.Response:
    service = _service(request)
    result = await asyncio.to_thread(
        service.run_schedule, int(request.match_info["schedule_id"]), "manual"
    )
    return _ok(result)


@routes.get("/api/schedule-runs")
async def list_schedule_runs(request: web.Request) -> web.Response:
    service = _service(request)
    schedule_id = request.query.get("schedule_id", "")
    sid = int(schedule_id) if schedule_id else None
    limit = int(request.query.get("limit", "50"))
    offset = int(request.query.get("offset", "0"))
    items = await asyncio.to_thread(service.list_schedule_runs, sid, limit, offset)
    total = await asyncio.to_thread(service.count_schedule_runs, sid)
    return _ok(items, total=total, limit=limit, offset=offset)


@routes.post("/api/schedule-runs/{run_id}/rerun")
async def rerun_schedule_stage(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    result = await asyncio.to_thread(
        service.rerun_schedule_stage,
        int(request.match_info["run_id"]),
        str(payload.get("stage") or ""),
    )
    return _ok(result)


@routes.post("/api/schedule-runs/{run_id}/confirm")
async def confirm_schedule_run(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(
        await asyncio.to_thread(
            service.confirm_schedule_run, int(request.match_info["run_id"])
        )
    )


# ---------------------------------------------------------------- cloud account
# 账号、订阅、双 Key 都由 EchoQ-Cloud 管理；本地只保存票据与本机 Key 的密文，
# 接口只回传掩码与套餐状态，浏览器拿不到任何完整 Key。
