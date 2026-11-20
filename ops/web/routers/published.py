# encoding: utf-8
"""已发布内容。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops import db
from ops.web.common import (
    _ok,
    _body,
    _service,
)


routes = web.RouteTableDef()


@routes.get("/api/published")
async def list_published(request: web.Request) -> web.Response:
    service = _service(request)
    query = request.query
    account_id = int(query.get("account_id", "0") or 0)
    platform = query.get("platform", "")
    since = int(query.get("since", "0") or 0)
    until = int(query.get("until", "0") or 0)
    since_days = int(query.get("since_days", "0") or 0)
    if since_days > 0:
        since = db.now() - since_days * 86400
    include_local = str(query.get("include_local", "1")).lower() not in {"0", "false", "no"}
    if account_id:
        service.accounts.get_row(account_id)  # 不存在时由中间件返回 404
    result = await asyncio.to_thread(
        service.published.list_notes,
        account_id=account_id,
        platform=platform,
        since=since,
        until=until,
        keyword=query.get("keyword", ""),
        health=query.get("health", ""),
        limit=int(query.get("limit", "20") or 20),
        offset=int(query.get("offset", "0") or 0),
        include_local=include_local,
    )
    return _ok(
        result["items"],
        total=result["total"],
        limit=result["limit"],
        offset=result["offset"],
        filters=result["filters"],
        meta=result["meta"],
    )


@routes.post("/api/published/sync")
async def sync_published(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    raw_ids = payload.get("account_ids")
    if raw_ids is None and payload.get("account_id"):
        raw_ids = [payload.get("account_id")]
    account_ids = [int(item) for item in (raw_ids or []) if item]
    for account_id in account_ids:
        service.accounts.get_row(account_id)
    task = await asyncio.to_thread(
        service.sync_published_async,
        account_ids or None,
        int(payload.get("pages") or 2),
    )
    return _ok(task, status_code=202)


@routes.get("/api/published/accounts")
async def published_accounts(request: web.Request) -> web.Response:
    service = _service(request)
    platform = request.query.get("platform", "")
    return _ok(await asyncio.to_thread(service.published.accounts_status, platform))


@routes.post("/api/published/health-check")
async def published_health_check(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    account_id = int(payload.get("account_id") or 0)
    return _ok(await asyncio.to_thread(service.published.health_check, account_id))


@routes.get("/api/published/{note_id}/metrics")
async def published_metrics(request: web.Request) -> web.Response:
    service = _service(request)
    days = int(request.query.get("days", "30") or 30)
    data = await asyncio.to_thread(
        service.published.metrics, int(request.match_info["note_id"]), days
    )
    return _ok(data)


@routes.get("/api/published/{note_id}/comments")
async def published_comments(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(
        service.published.list_comments,
        int(request.match_info["note_id"]),
        int(request.query.get("limit", "20") or 20),
        int(request.query.get("offset", "0") or 0),
    )
    return _ok(data)


@routes.post("/api/published/{note_id}/comments/sync")
async def published_comments_sync(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.published.sync_comments,
        int(request.match_info["note_id"]),
        int(payload.get("pages") or 3),
    )
    return _ok(data)
