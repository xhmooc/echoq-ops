# encoding: utf-8
"""选题与文案。"""

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


@routes.get("/api/topics")
async def list_topics(request: web.Request) -> web.Response:
    service = _service(request)
    status = request.query.get("status", "")
    query = request.query.get("q", "")
    source = request.query.get("source", "")
    category = request.query.get("category", "")
    min_score = float(request.query.get("min_score", "0") or 0)
    limit = int(request.query.get("limit", "200"))
    offset = int(request.query.get("offset", "0"))
    items = await asyncio.to_thread(
        service.topics.list_topics,
        status,
        query,
        limit,
        source,
        category,
        min_score,
        request.query.get("sort", "score"),
        offset,
    )
    total = await asyncio.to_thread(
        service.topics.count_topics, status, query, source, category, min_score
    )
    return _ok(items, total=total, limit=limit, offset=offset)


@routes.get("/api/topics/dedupes")
async def list_topic_dedupes(request: web.Request) -> web.Response:
    service = _service(request)
    items = await asyncio.to_thread(
        service.topics.list_dedupes, int(request.query.get("limit", "50"))
    )
    return _ok(items)


@routes.post("/api/topics/mine")
async def mine_topics(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    mode = str(payload.get("mode") or "keyword")
    keywords = payload.get("keywords") or []
    if isinstance(keywords, str):
        keywords = [item for item in keywords.replace("，", ",").split(",") if item.strip()]
    user_urls = payload.get("user_urls") or []
    if isinstance(user_urls, str):
        user_urls = [item.strip() for item in user_urls.splitlines() if item.strip()]
    account_id = payload.get("account_id")
    data = await asyncio.to_thread(
        service.mine,
        mode,
        keywords=[str(item).strip() for item in keywords],
        user_urls=[str(item).strip() for item in user_urls],
        per_kw=int(payload.get("per_kw") or 20),
        limit=int(payload.get("limit") or 30),
        sort_type_choice=int(payload.get("sort_type_choice") or 0),
        detail_limit=int(payload.get("detail_limit") or 5),
        product=bool(payload.get("product")),
        account_id=int(account_id) if account_id else None,
    )
    return _ok(data)


@routes.post("/api/topics")
async def add_topic(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    topic = await asyncio.to_thread(
        service.topics.add_manual,
        str(payload.get("title") or ""),
        angle=str(payload.get("angle") or ""),
        keyword=str(payload.get("keyword") or ""),
        category=str(payload.get("category") or ""),
        tone=str(payload.get("tone") or ""),
        product=bool(payload.get("product")),
    )
    return _ok(topic)


@routes.post("/api/topics/import")
async def import_topics(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.topics.import_text, str(payload.get("text") or "")
    )
    return _ok(data)


@routes.post("/api/topics/import-library")
async def import_library(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await asyncio.to_thread(
        service.import_library,
        str(payload.get("path") or (config.ROOT / "xhs-promo" / "topics" / "library.json")),
    )
    return _ok(data)


@routes.patch("/api/topics/{topic_id}")
async def update_topic(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    topic = await asyncio.to_thread(
        service.topics.update_topic, int(request.match_info["topic_id"]), payload
    )
    return _ok(topic)


@routes.delete("/api/topics/{topic_id}")
async def delete_topic(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.topics.delete_topic, int(request.match_info["topic_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/topics/batch-delete")
async def batch_delete_topics(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    topic_ids = payload.get("topic_ids") or payload.get("ids") or []
    if isinstance(topic_ids, str):
        topic_ids = [item for item in topic_ids.split(",") if item.strip()]
    result = await asyncio.to_thread(
        service.delete_topics, [int(item) for item in topic_ids]
    )
    return _ok(result)


@routes.post("/api/copy/generate")
async def generate_copy(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    data = await _blocking(
        service.preview,
        str(payload.get("brief") or ""),
        topic=str(payload.get("topic") or ""),
        tone=str(payload.get("tone") or ""),
        tags=bool(payload.get("tags", True)),
        product=bool(payload.get("product")),
        use_llm=bool(payload.get("use_llm", True)),
        platform=str(payload.get("platform") or ""),
        timeout=config.COPY_TIMEOUT_SEC,
    )
    return _ok(data)


@routes.post("/api/copy/rewrite")
async def rewrite_copy_text(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    with_cards = bool(payload.get("with_cards"))
    data = await _blocking(
        service.rewrite_text,
        str(payload.get("text") or ""),
        title=str(payload.get("title") or ""),
        angle=str(payload.get("angle") or ""),
        tone=str(payload.get("tone") or ""),
        with_cards=with_cards,
        use_llm=bool(payload.get("use_llm", True)),
        platform=str(payload.get("platform") or ""),
        timeout=config.COPY_TIMEOUT_SEC + (config.RENDER_TIMEOUT_SEC if with_cards else 0),
    )
    return _ok(data)


@routes.post("/api/copy/check")
async def check_copy(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    return _ok(
        await asyncio.to_thread(
            service.check_copy,
            str(payload.get("title") or ""),
            str(payload.get("desc") or ""),
            payload.get("topics"),
            str(payload.get("platform") or ""),
        )
    )
