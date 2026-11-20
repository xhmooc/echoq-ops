# encoding: utf-8
"""草稿、富文本与配图。"""

from __future__ import annotations

import asyncio
from typing import Any

from aiohttp import web

from ops import config
from ops.web.common import (
    _ok,
    _body,
    _service,
    _blocking,
)


routes = web.RouteTableDef()


@routes.get("/api/drafts")
async def list_drafts(request: web.Request) -> web.Response:
    service = _service(request)
    status = request.query.get("status", "")
    platform = request.query.get("platform", "")
    limit = int(request.query.get("limit", "200"))
    offset = int(request.query.get("offset", "0"))
    items = await asyncio.to_thread(service.list_drafts, status, limit, offset, platform)
    total = await asyncio.to_thread(service.count_drafts, status, platform)
    return _ok(items, total=total, limit=limit, offset=offset)


@routes.post("/api/drafts/manual")
async def save_manual_draft(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    account_ids = payload.get("account_ids") or []
    if isinstance(account_ids, str):
        account_ids = [item for item in account_ids.split(",") if item.strip()]
    account_id = payload.get("account_id")
    draft = await asyncio.to_thread(
        service.save_copy,
        title=str(payload.get("title") or ""),
        desc=str(payload.get("desc") or ""),
        topics=payload.get("topics"),
        images=payload.get("images") or [],
        visibility=int(payload.get("visibility") or 0),
        media_type=str(payload.get("media_type") or "image"),
        account_id=int(account_id) if account_id else None,
        topic_id=int(payload["topic_id"]) if payload.get("topic_id") else None,
        enqueue=bool(payload.get("enqueue")),
        account_ids=[int(item) for item in account_ids],
        scheduled_at=payload.get("scheduled_at") or 0,
        platform=str(payload.get("platform") or ""),
        content_type=str(payload.get("content_type") or ""),
        body_md=str(payload.get("body_md") or ""),
        body_html=str(payload.get("body_html") or ""),
        wx_theme=str(payload.get("wx_theme") or ""),
    )
    return _ok(draft)


@routes.post("/api/richtext/render")
async def render_richtext(request: web.Request) -> web.Response:
    """Markdown / HTML → 可插入预览的 HTML 与纯文本，公众号正文编辑器用。"""
    from ops import richtext

    payload = await _body(request)
    result = await asyncio.to_thread(
        richtext.render,
        str(payload.get("text") or ""),
        str(payload.get("format") or "markdown"),
        payload.get("images") or [],
    )
    return _ok(result)


@routes.get("/api/richtext/themes")
async def list_richtext_themes(request: web.Request) -> web.Response:
    """公众号排版的主题清单，前端按 group 分组展示。"""
    from ops import richtext

    return _ok(richtext.list_themes())


@routes.post("/api/richtext/style")
async def style_richtext(request: web.Request) -> web.Response:
    """一键排版：把公众号正文的内联样式整体换成指定主题。"""
    from ops import richtext

    payload = await _body(request)
    html = await asyncio.to_thread(
        richtext.apply_theme,
        str(payload.get("html") or ""),
        str(payload.get("theme") or "huasheng"),
    )
    return _ok({"html": html})


@routes.post("/api/drafts/{draft_id}/convert")
async def convert_draft(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    draft = await _blocking(
        service.convert_draft,
        int(request.match_info["draft_id"]),
        target_platform=str(payload.get("target_platform") or ""),
        tone=str(payload.get("tone") or ""),
        use_llm=bool(payload.get("use_llm", True)),
        timeout=config.COPY_TIMEOUT_SEC,
    )
    return _ok(draft)


@routes.post("/api/drafts/{draft_id}/switch-platform")
async def switch_platform(request: web.Request) -> web.Response:
    """在原草稿上切换平台：不新建草稿，图片全部保留。"""
    service = _service(request)
    payload = await _body(request)
    draft = await asyncio.to_thread(
        service.switch_draft_platform,
        int(request.match_info["draft_id"]),
        str(payload.get("platform") or ""),
        str(payload.get("content_type") or ""),
    )
    return _ok(draft)


@routes.post("/api/drafts")
async def create_drafts(request: web.Request) -> web.Response:
    """批量生成草稿：立即返回任务 id，页面轮询进度，避免请求线程被长任务占住。"""
    service = _service(request)
    payload = await _body(request)
    topic_ids = payload.get("topic_ids") or []
    if isinstance(topic_ids, str):
        topic_ids = [item for item in topic_ids.split(",") if item.strip()]
    account_id = payload.get("account_id")
    product = payload.get("product")
    task = await asyncio.to_thread(
        service.create_drafts_async,
        [int(item) for item in topic_ids],
        account_id=int(account_id) if account_id else None,
        tone=str(payload.get("tone") or ""),
        product=None if product is None else bool(product),
        variants=int(payload.get("variants") or 1),
        use_llm=bool(payload.get("use_llm", True)),
        with_cards=bool(payload.get("with_cards")),
        platform=str(payload.get("platform") or ""),
        content_type=str(payload.get("content_type") or ""),
    )
    return _ok(task, status_code=202)


@routes.get("/api/tasks/{task_id}")
async def get_task(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.task, request.match_info["task_id"]))


@routes.post("/api/drafts/{draft_id}/rewrite")
async def rewrite_draft(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    with_cards = bool(payload.get("with_cards"))
    draft = await _blocking(
        service.rewrite_draft,
        int(request.match_info["draft_id"]),
        angle=str(payload.get("angle") or ""),
        tone=str(payload.get("tone") or ""),
        with_cards=with_cards,
        use_llm=bool(payload.get("use_llm", True)),
        platform=str(payload.get("platform") or ""),
        timeout=config.COPY_TIMEOUT_SEC + (config.RENDER_TIMEOUT_SEC if with_cards else 0),
    )
    return _ok(draft)


@routes.get("/api/drafts/{draft_id}")
async def get_draft(request: web.Request) -> web.Response:
    service = _service(request)
    return _ok(await asyncio.to_thread(service.get_draft, int(request.match_info["draft_id"])))


@routes.patch("/api/drafts/{draft_id}")
async def update_draft(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    draft = await asyncio.to_thread(
        service.update_draft, int(request.match_info["draft_id"]), payload
    )
    return _ok(draft)


@routes.get("/api/cards/styles")
async def card_styles(request: web.Request) -> web.Response:
    from ops.illustrator import list_styles

    return _ok(await asyncio.to_thread(list_styles))


@routes.get("/api/cards/options")
async def card_options(request: web.Request) -> web.Response:
    def _options() -> dict[str, Any]:
        from ops.illustrator import (
            backend_status,
            list_layouts,
            list_palettes,
            list_presets,
            list_styles,
            paid_backend_status,
        )

        return {
            "styles": list_styles(),
            "layouts": list_layouts(),
            "palettes": list_palettes(),
            "presets": list_presets(),
            "backend": backend_status(),
            "paid": paid_backend_status(),
        }

    # 预设目录可能位于慢盘/网络盘，扫描放到线程池，避免卡住整个事件循环。
    return _ok(await asyncio.to_thread(_options))


@routes.post("/api/drafts/{draft_id}/cards")
async def make_cards(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    draft = await _blocking(
        service.generate_cards,
        int(request.match_info["draft_id"]),
        str(payload.get("style") or "") or None,
        str(payload.get("layout") or "") or None,
        str(payload.get("palette") or "") or None,
        timeout=config.RENDER_TIMEOUT_SEC,
    )
    return _ok(draft)


@routes.post("/api/drafts/{draft_id}/paid-cards")
async def make_paid_cards(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    from ops.illustrator import PAID_IMAGE_PRICE, paid_backend_status, render_paid_cards

    status = paid_backend_status()
    if not status["configured"]:
        raise ValueError(status["reason"])
    draft = await asyncio.to_thread(
        service.get_draft, int(request.match_info["draft_id"])
    )
    images = await _blocking(
        render_paid_cards,
        draft,
        str(payload.get("style") or ""),
        str(payload.get("layout") or ""),
        str(payload.get("palette") or ""),
        timeout=config.RENDER_TIMEOUT_SEC,
    )
    updated = await asyncio.to_thread(
        service.update_draft, int(draft["id"]), {"images": images}
    )
    return _ok(updated, cost=round(PAID_IMAGE_PRICE * len(images), 2))


@routes.get("/api/design/styles")
async def design_styles(request: web.Request) -> web.Response:
    from ops.artwork import list_art_styles
    from ops.designs import list_design_styles

    # 插画风格和排版模板共用同一个选择器；前端按 group 分组显示。
    return _ok(list_design_styles() + list_art_styles())


@routes.post("/api/design/plan")
async def design_plan(request: web.Request) -> web.Response:
    """返回这套内容会排成几页、平台允许多少张，供前端提前显示「共 N 页」。"""
    payload = await _body(request)
    from ops.artwork import is_art_style
    from ops.designs import count_design_pages, design_canvas
    from ops.platforms import get_platform, normalize

    platform = normalize(payload.get("platform") or "")
    content_type = str(payload.get("content_type") or "")
    style = str(payload.get("style") or "")
    spec = get_platform(platform).spec(content_type)
    draft = {
        "title": str(payload.get("title") or ""),
        "desc": str(payload.get("desc") or ""),
        "platform": platform,
    }
    if is_art_style(style):
        # 插画固定只出一张：封面就是那一张，正文插图另行插入。
        return _ok(
            {
                "platform": platform,
                "content_type": spec.key,
                "content_type_label": spec.label,
                "pages": 1,
                "max_images": min(int(spec.max_images or 1), 1),
                "canvas": design_canvas(platform),
                "art": True,
            }
        )
    pages = await asyncio.to_thread(count_design_pages, draft, platform, style)
    return _ok(
        {
            "platform": platform,
            "content_type": spec.key,
            "content_type_label": spec.label,
            "pages": pages,
            "max_images": int(spec.max_images or 0),
            "canvas": design_canvas(platform),
        }
    )


@routes.post("/api/drafts/{draft_id}/design-cards")
async def make_design_cards(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    style = str(payload.get("style") or "paper")
    raw_variant = payload.get("variant")
    variant = int(raw_variant) if raw_variant not in (None, "") else None
    raw_limit = payload.get("limit")
    limit = int(raw_limit) if raw_limit not in (None, "") else None
    draft = await asyncio.to_thread(
        service.get_draft, int(request.match_info["draft_id"])
    )
    from ops.artwork import art_style, is_art_style, render_artwork
    from ops.designs import design_canvas, design_style, render_design_cards
    from ops.platforms import normalize

    platform = normalize(payload.get("platform") or draft.get("platform") or "")
    canvas = design_canvas(platform)
    if is_art_style(style):
        # 插画走程序化手绘：同样在本机渲染，不出文字卡。
        images = await _blocking(
            render_artwork,
            draft,
            style,
            variant,
            platform,
            timeout=config.RENDER_TIMEOUT_SEC,
        )
        updated = await asyncio.to_thread(
            service.update_draft, int(draft["id"]), {"images": images}
        )
        template = art_style(style)
        return _ok(
            updated,
            style=style,
            template={"key": template["key"], "name": template["name"]},
            canvas={
                "key": "wide" if platform == "wechat_mp" else "portrait",
                "width": 1080,
                "height": 460 if platform == "wechat_mp" else 1440,
                "aspect": "2.35:1" if platform == "wechat_mp" else "3:4",
            },
            platform=str(updated.get("platform") or platform),
            artwork=True,
        )
    images = await _blocking(
        render_design_cards,
        draft,
        style,
        variant,
        limit,
        platform=platform,
        timeout=config.RENDER_TIMEOUT_SEC,
    )
    updated = await asyncio.to_thread(
        service.update_draft, int(draft["id"]), {"images": images}
    )
    template = design_style(style)
    return _ok(
        updated,
        style=style,
        template={"key": template["key"], "name": template["name"]},
        canvas=canvas,
        platform=str(updated.get("platform") or platform),
    )


@routes.post("/api/drafts/{draft_id}/motion")
async def make_motion(request: web.Request) -> web.Response:
    """给当前草稿生成 6 秒循环动图；不混进发布图列表。"""
    service = _service(request)
    draft = await asyncio.to_thread(
        service.get_draft, int(request.match_info["draft_id"])
    )
    from ops.cards_v2 import render_paper_motion

    motion = await _blocking(
        render_paper_motion, draft, timeout=config.RENDER_TIMEOUT_SEC
    )
    content = draft.get("content_json") if isinstance(draft.get("content_json"), dict) else {}
    content["motion"] = motion
    await asyncio.to_thread(
        service.update_draft, int(draft["id"]), {"content_json": content}
    )
    return _ok({"motion": motion}, draft_id=int(draft["id"]))


@routes.post("/api/drafts/{draft_id}/artwork-inline")
async def make_inline_artwork(request: web.Request) -> web.Response:
    """给公众号正文生成一张横向插画；不改草稿封面，直接返回可插入的图片路径。"""
    service = _service(request)
    payload = await _body(request)
    from ops.artwork import DEFAULT_STYLE, is_art_style, render_artwork
    from ops.platforms import normalize

    draft = await asyncio.to_thread(
        service.get_draft, int(request.match_info["draft_id"])
    )
    style = str(payload.get("style") or "")
    style = style if is_art_style(style) else DEFAULT_STYLE
    platform = normalize(payload.get("platform") or draft.get("platform") or "")
    paths = await _blocking(
        render_artwork,
        draft,
        style,
        None,
        platform,
        scope="inline",
        timeout=config.RENDER_TIMEOUT_SEC,
    )
    return _ok({"paths": paths, "style": style})


@routes.delete("/api/drafts/{draft_id}")
async def delete_draft(request: web.Request) -> web.Response:
    service = _service(request)
    await asyncio.to_thread(
        service.drafts.delete, int(request.match_info["draft_id"])
    )
    return _ok({"deleted": True})


@routes.post("/api/drafts/batch-delete")
async def batch_delete_drafts(request: web.Request) -> web.Response:
    service = _service(request)
    payload = await _body(request)
    draft_ids = payload.get("draft_ids") or payload.get("ids") or []
    if isinstance(draft_ids, str):
        draft_ids = [item for item in draft_ids.split(",") if item.strip()]
    result = await asyncio.to_thread(
        service.delete_drafts, [int(item) for item in draft_ids]
    )
    return _ok(result)
