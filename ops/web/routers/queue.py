# encoding: utf-8
"""发布队列、任务与记录。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops.web.common import (
    _ok,
    _body,
    _service,
)


routes = web.RouteTableDef()


@routes.get("/api/jobs")
async def list_jobs(request: web.Request) -> web.Response:
    service = _service(request)
    limit = int(request.query.get("limit", "100"))
    offset = int(request.query.get("offset", "0"))
    status = request.query.get("status", "")
    reason = request.query.get("reason", "")
    items = await asyncio.to_thread(
        service.queue.list_jobs, limit, offset, status, reason
    )
    total = await asyncio.to_thread(service.queue.count_jobs, status, reason)
    return _ok(items, total=total, limit=limit, offset=offset)


@routes.get("/api/queue/reasons")
async def queue_reasons(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.queue.queue_reasons))


@routes.post("/api/jobs/{job_id}/confirm")
async def confirm_job(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    if "published" not in payload:
        raise ValueError("请明确选择已发布或未发布")
    data = await asyncio.to_thread(
        service.queue.confirm,
        int(request.match_info["job_id"]),
        bool(payload.get("published")),
    )
    return _ok(data)


@routes.post("/api/jobs")
async def enqueue(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    draft_ids = payload.get("draft_ids") or []
    if isinstance(draft_ids, str):
        draft_ids = [item for item in draft_ids.split(",") if item.strip()]
    account_id = payload.get("account_id")
    account_ids = payload.get("account_ids") or []
    if isinstance(account_ids, str):
        account_ids = [item for item in account_ids.split(",") if item.strip()]
    jobs = await asyncio.to_thread(
        service.enqueue,
        [int(item) for item in draft_ids],
        account_id=int(account_id) if account_id else None,
        account_ids=[int(item) for item in account_ids],
        scheduled_at=payload.get("scheduled_at") or 0,
    )
    return _ok(jobs)


@routes.post("/api/jobs/{job_id}/retry")
async def retry_job(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(
        service.queue.retry, int(request.match_info["job_id"])
    ))


@routes.post("/api/jobs/{job_id}/cancel")
async def cancel_job(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(
        service.queue.cancel, int(request.match_info["job_id"])
    ))


@routes.get("/api/records")
async def list_records(request: web.Request) -> web.Response:
    service = _service(request)
    limit = int(request.query.get("limit", "100"))
    offset = int(request.query.get("offset", "0"))
    items = await asyncio.to_thread(service.queue.list_records, limit, offset)
    summary = await asyncio.to_thread(service.queue.count_records_summary)
    return _ok(
        items,
        total=summary["total"],
        success_total=summary["success_total"],
        failed_total=summary["failed_total"],
        limit=limit,
        offset=offset,
    )
