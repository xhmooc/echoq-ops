# encoding: utf-8
"""账号与代理。"""

from __future__ import annotations

import asyncio

from aiohttp import web

from ops.web.common import (
    _ok,
    _body,
    _service,
)


routes = web.RouteTableDef()


@routes.get("/api/accounts")
async def list_accounts(request: web.Request) -> web.Response:
    service = _service(request)
    platform = request.query.get("platform", "")
    items = await asyncio.to_thread(service.accounts.list_accounts, platform)
    return _ok(items, total=len(items))


@routes.post("/api/accounts")
async def add_account(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    account = await asyncio.to_thread(
        service.add_account_cookie,
        str(payload.get("name") or ""),
        str(payload.get("cookie") or ""),
        str(payload.get("proxy") or ""),
        str(payload.get("platform") or ""),
    )
    return _ok(account)


@routes.post("/api/accounts/import-env")
async def import_env_account(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.import_env_account))


@routes.post("/api/accounts/qr")
async def start_qr(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.start_qr,
        str(payload.get("proxy") or ""),
        str(payload.get("platform") or ""),
    )
    return _ok(data)


@routes.get("/api/accounts/qr/{sid}")
async def poll_qr(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(service.poll_qr, request.match_info["sid"])
    data.pop("cookie", None)
    return _ok(data)


@routes.post("/api/accounts/qr/{sid}/save")
async def save_qr(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    account = await asyncio.to_thread(
        service.confirm_qr_account,
        request.match_info["sid"],
        str(payload.get("name") or ""),
    )
    return _ok(account)


@routes.post("/api/accounts/qr/{sid}/window")
async def open_qr_window(request: web.Request) -> web.Response:
    """用户点击「打开验证窗口」后才调用；默认扫码流程不会弹任何窗口。"""
    service = _service(request)
    data = await asyncio.to_thread(service.open_qr_window, request.match_info["sid"])
    return _ok(data)


@routes.patch("/api/accounts/{account_id}")
async def update_account(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    account = await asyncio.to_thread(
        service.accounts.update_account, int(request.match_info["account_id"]), payload
    )
    return _ok(account)


@routes.delete("/api/accounts/{account_id}")
async def delete_account(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.accounts.delete_account, int(request.match_info["account_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/accounts/{account_id}/check")
async def check_account(request: web.Request) -> web.Response:
    service = _service(request)
    result = await asyncio.to_thread(
        service.accounts.check_health, int(request.match_info["account_id"])
    )
    return _ok(result)


@routes.get("/api/accounts/groups")
async def account_groups(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.accounts.groups))


@routes.get("/api/accounts/{account_id}/diagnose")
async def diagnose_account(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(
        service.accounts.diagnose, int(request.match_info["account_id"])
    )
    return _ok(data)


@routes.post("/api/accounts/{account_id}/proxy-test")
async def test_account_proxy(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(
        service.accounts.proxy_test, int(request.match_info["account_id"])
    )
    return _ok(data)


@routes.post("/api/accounts/{account_id}/cooldown/clear")
async def clear_account_cooldown(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(
        service.accounts.clear_cooldown,
        int(request.match_info["account_id"]),
        True,
    )
    return _ok(data)


@routes.post("/api/accounts/batch")
async def batch_accounts(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    raw_ids = payload.get("ids") or payload.get("account_ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [item for item in raw_ids.split(",") if item.strip()]
    tags = payload.get("tags") or []
    if isinstance(tags, str):
        tags = [item.strip() for item in tags.replace("，", ",").split(",") if item.strip()]
    data = await asyncio.to_thread(
        service.accounts.batch,
        str(payload.get("action") or ""),
        [int(item) for item in raw_ids],
        group_name=str(payload.get("group_name") or ""),
        tags=[str(item) for item in tags],
    )
    return _ok(data)


@routes.get("/api/proxies")
async def list_proxies(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.proxies.list_proxies))


@routes.post("/api/proxies")
async def add_proxy(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(await asyncio.to_thread(service.proxies.add_proxy, payload))


@routes.patch("/api/proxies/{proxy_id}")
async def update_proxy(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(
            service.proxies.update_proxy, int(request.match_info["proxy_id"]), payload
        )
    )


@routes.delete("/api/proxies/{proxy_id}")
async def delete_proxy(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.proxies.delete_proxy, int(request.match_info["proxy_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/proxies/{proxy_id}/test")
async def test_proxy(request: web.Request) -> web.Response:
    service = _service(request)
    data = await asyncio.to_thread(
        service.proxies.test_proxy, int(request.match_info["proxy_id"])
    )
    return _ok(data)


@routes.post("/api/proxies/test")
async def test_proxy_url(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.proxies.test_proxy, None, str(payload.get("url") or "")
    )
    return _ok(data)
